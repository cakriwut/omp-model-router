/**
 * History compression using TOON format.
 *
 * Compresses old message history into a single user message containing a TOON
 * block, followed by a synthetic assistant acknowledgment. Recent messages are
 * passed through unchanged as native JSON turns.
 *
 * The API still receives a valid messages array — we are not modifying the
 * system prompt. The model reads the compressed history from the TOON block
 * embedded in the prepended user message.
 *
 * Wire layout for a 100-message conversation with keepLastN=4:
 *
 *   messages[0]: user    ← TOON block containing messages 0..95
 *   messages[1]: assistant ← synthetic ack ("Understood.")
 *   messages[2..5]: original messages 96..99  ← kept as-is
 *
 * Improvements over naive approach:
 * - Sanitizes turn alternation (merges consecutive same-role messages)
 * - Splits messages into uniform (text-only) and non-uniform (tool) groups
 *   to maximize TOON tabular compression
 * - Ensures output always has valid alternation (no consecutive same-role)
 * - Smart keepLastN boundary: never splits in the middle of a tool call sequence
 */

import { encode as toonEncode } from "@toon-format/toon";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import type { HistoryCompressionConfig, CompressionStats, CompressionCheckpoint } from "./types";
import { extractText as extractMessageText } from "./utils/messages.js";

const COMPRESS_EXTRACT_OPTS = {
	includeThinking: false,
	includeToolCalls: true,
	toolCallFormat: "name-only",
	joiner: " ",
} as const;

function extractText(msg: Message): string {
	return extractMessageText(msg, COMPRESS_EXTRACT_OPTS);
}

// ─── Message classification ──────────────────────────────────────────────────

/**
 * Returns true if a message contains tool calls or is a tool result.
 * These messages have non-uniform structure that breaks TOON tabular encoding.
 */
function isToolRelated(msg: Message): boolean {
	if (msg.role === "toolResult") return true;
	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		return msg.content.some((b: any) => b.type === "toolCall");
	}
	return false;
}

// ─── Turn alternation sanitization ───────────────────────────────────────────

/**
 * Merge consecutive same-role messages in the given array.
 * Consecutive user messages are merged into one user message.
 * Consecutive assistant messages are merged into one assistant message.
 * This ensures valid turn alternation for LLM APIs.
 */
export function sanitizeTurnAlternation(messages: Message[]): Message[] {
	if (messages.length <= 1) return messages;

	const result: Message[] = [messages[0]];

	for (let i = 1; i < messages.length; i++) {
		const current = messages[i];
		const prev = result[result.length - 1];

		if (current.role === prev.role) {
			// Merge consecutive same-role messages
			result[result.length - 1] = mergeMessages(prev, current);
		} else if (current.role === "toolResult" && prev.role !== "assistant") {
			// Orphaned toolResult (no preceding assistant with tool call)
			// Convert to a user message to maintain alternation
			const asUser: Message = {
				role: "user",
				content: `[Previous tool result for "${(current as any).toolName}"]: ${extractText(current)}`,
				timestamp: current.timestamp,
			};
			if (prev.role === "user") {
				// Merge with previous user message
				result[result.length - 1] = mergeMessages(prev, asUser);
			} else {
				result.push(asUser);
			}
		} else {
			result.push(current);
		}
	}

	return result;
}

/**
 * Merge two messages of the same role into one.
 */
function mergeMessages(a: Message, b: Message): Message {
	if (a.role === "user") {
		const textA = typeof a.content === "string" ? a.content : extractText(a);
		const textB = typeof b.content === "string" ? b.content : extractText(b);
		return {
			role: "user",
			content: `${textA}\n${textB}`,
			timestamp: a.timestamp,
		};
	}

	if (a.role === "assistant") {
		// Merge content blocks — flatten into text to avoid type union issues
		const textA = Array.isArray(a.content)
			? (a.content as any[]).map((b: any) => b.type === "text" ? b.text : "").filter(Boolean).join(" ")
			: String(a.content);
		const textB = Array.isArray(b.content)
			? (b.content as any[]).map((b: any) => b.type === "text" ? b.text : "").filter(Boolean).join(" ")
			: String(b.content);
		return {
			...a,
			content: [{ type: "text" as const, text: `${textA}\n${textB}` }],
			timestamp: a.timestamp,
		};
	}

	// For toolResult or other roles, concatenate as text
	return {
		...a,
		content: [
			...(Array.isArray(a.content) ? a.content : []),
			...(Array.isArray(b.content) ? b.content : []),
		],
		timestamp: a.timestamp,
	} as Message;
}


// ─── Smart split boundary ─────────────────────────────────────────────────────

/**
 * Find the optimal split index that doesn't break a tool call sequence.
 * A tool call sequence is: assistant(toolCall) → toolResult → ...
 * We never split between an assistant tool call and its result.
 *
 * Returns the adjusted split index (may be earlier than the naive split).
 */
function findSafeSplitIndex(messages: Message[], naiveSplit: number): number {
	let splitAt = naiveSplit;

	// Walk backwards from the split point to find a safe boundary.
	// A safe boundary is where the message at splitAt is NOT:
	// - A toolResult (orphaned from its tool call)
	// - Preceded by an assistant with toolCall that expects a result after the split
	while (splitAt > 0) {
		const msgAtSplit = messages[splitAt];

		// If the first kept message is a toolResult, move split earlier
		if (msgAtSplit.role === "toolResult") {
			splitAt--;
			continue;
		}

		// If the message before split is an assistant with tool call,
		// include the following toolResult(s) in the kept portion
		if (splitAt > 0) {
			const beforeSplit = messages[splitAt - 1];
			if (beforeSplit.role === "assistant" && isToolRelated(beforeSplit)) {
				// The assistant made a tool call — keep it with its result
				splitAt--;
				continue;
			}
		}

		break;
	}

	// Don't compress everything — need at least 1 message to compress
	return Math.max(1, splitAt);
}

// ─── Message serialization ────────────────────────────────────────────────────

/**
 * Serialize a text-only message (user or assistant without tool calls) to a
 * uniform {role, content} object for optimal TOON tabular encoding.
 */
function serializeTextMessage(msg: Message): { role: string; content: string } {
	if (msg.role === "user") {
		return {
			role: "user",
			content:
				typeof msg.content === "string"
					? msg.content
					: (msg.content as any[])
							.map((b: any) => (b.type === "text" ? b.text : "[image]"))
							.join(" "),
		};
	}

	// assistant (text-only, no tool calls)
	return {
		role: "assistant",
		content: (msg.content as any[])
			.map((b: any) => {
				if (b.type === "text") return b.text;
				if (b.type === "thinking") return b.thinking ? `[thinking: ${b.thinking}]` : "";
				return "";
			})
			.filter(Boolean)
			.join(" "),
	};
}

/**
 * Serialize a tool-related message to a structured summary.
 * Tool sequences (assistant-with-toolCall + toolResult) are summarized together.
 */
function serializeToolSequence(msgs: Message[]): string {
	const parts: string[] = [];
	for (const msg of msgs) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const textParts: string[] = [];
			const toolParts: string[] = [];
			for (const b of msg.content as any[]) {
				if (b.type === "text" && b.text) textParts.push(b.text);
				if (b.type === "toolCall") toolParts.push(`${b.name}(${JSON.stringify(b.arguments)})`);
			}
			if (textParts.length) parts.push(`assistant: ${textParts.join(" ")}`);
			if (toolParts.length) parts.push(`tools: ${toolParts.join(", ")}`);
		} else if (msg.role === "toolResult") {
			const toolName = (msg as any).toolName || "unknown";
			const text = Array.isArray(msg.content)
				? (msg.content as any[]).map((b: any) => b.type === "text" ? b.text : "").filter(Boolean).join(" ")
				: String(msg.content);
			// Truncate long tool results in compressed history
			const truncated = text.length > 500 ? text.slice(0, 497) + "..." : text;
			parts.push(`result(${toolName}): ${truncated}`);
		}
	}
	return parts.join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the effective compression config for the current profile,
 * applying the global config as a base and profile config as override.
 */
export function resolveCompressionConfig(
	globalConfig?: HistoryCompressionConfig,
	profileConfig?: HistoryCompressionConfig,
): HistoryCompressionConfig | undefined {
	if (!globalConfig?.enabled && !profileConfig?.enabled) return undefined;
	const base: HistoryCompressionConfig = globalConfig ?? { enabled: false };
	const override: Partial<HistoryCompressionConfig> = profileConfig ?? {};
	return {
		enabled: override.enabled ?? base.enabled,
		keepLastN: override.keepLastN ?? base.keepLastN ?? 4,
		excludeModels: override.excludeModels ?? base.excludeModels,
		progressive: override.progressive ?? base.progressive,
	};
}

/**
 * Returns true if the given target model should be excluded from compression.
 * Matches model patterns as substrings against the full "provider/modelId" string.
 */
export function isModelExcludedFromCompression(
	config: HistoryCompressionConfig,
	targetProvider: string,
	targetModelId: string,
): boolean {
	const excludeList = config.excludeModels;
	if (!excludeList || excludeList.length === 0) return false;
	const fullRef = `${targetProvider}/${targetModelId}`.toLowerCase();
	return excludeList.some((pattern) => fullRef.includes(pattern.toLowerCase()));
}

/**
 * Returns true if compression is enabled AND the target model is not excluded.
 * Used as the gate for both progressive and static/dynamic compression modes.
 */
export function canCompressForModel(
	config: HistoryCompressionConfig,
	targetProvider: string,
	targetModelId: string,
): boolean {
	if (!config.enabled) return false;
	return !isModelExcludedFromCompression(config, targetProvider, targetModelId);
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Default 80% context-window threshold for context_size trigger. */
export const DEFAULT_CONTEXT_THRESHOLD = 0.8;
/** Default 5-minute idle threshold (seconds) for cache_expiry trigger. */
export const DEFAULT_TIME_THRESHOLD_SECONDS = 300;

/**
 * Detect if the first user message in context is a TOON-compressed history block.
 * Returns the index of the first message *after* the TOON history, or 0 if none.
 */
function detectTOONHistoryEnd(context: Context): number {
	if (context.messages.length === 0) return 0;
	const firstMsg = context.messages[0];
	if (firstMsg.role !== "user") return 0;
	const content =
		typeof firstMsg.content === "string"
			? firstMsg.content
			: Array.isArray(firstMsg.content)
				? (firstMsg.content.find((b: any) => b.type === "text") as any)?.text ?? ""
				: "";
	if (!content.startsWith("[HISTORY:")) return 0;
	// TOON history block is always followed by an assistant acknowledgment.
	return Math.min(2, context.messages.length);
}

/**
 * Estimate tokens for a single message without usage stats.
 */
function estimateMessageTokens(msg: Message): number {
	let textContent = "";
	if (typeof msg.content === "string") {
		textContent = msg.content;
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content as any[]) {
			if (block.type === "text") {
				textContent += block.text ?? "";
			} else if (block.type === "tool_result") {
				const resultContent =
					typeof block.content === "string"
						? block.content
						: Array.isArray(block.content)
							? block.content
									.map((c: any) => (typeof c === "string" ? c : c.text ?? ""))
									.join("")
							: "";
				textContent += resultContent;
			} else if (block.type === "tool_use") {
				textContent += JSON.stringify(block.input ?? {});
			}
		}
	}
	// ~4 chars per token (conservative for Claude models).
	return Math.ceil(textContent.length / 4);
}

/**
 * Estimate total tokens in a context using actual usage stats when available,
 * falling back to a content-based heuristic for messages without usage data.
 * Excludes TOON-compressed history blocks (already compressed).
 */
export function estimateContextTokens(context: Context): number {
	let totalTokens = 0;
	const startIdx = detectTOONHistoryEnd(context);
	for (let i = startIdx; i < context.messages.length; i++) {
		const msg = context.messages[i] as any;
		if (msg.usage) {
			totalTokens += (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
		} else {
			totalTokens += estimateMessageTokens(msg);
		}
	}
	const sys = (context as any).system;
	if (sys) {
		const systemStr = Array.isArray(sys)
			? sys.map((s: any) => (typeof s === "string" ? s : s.text ?? "")).join("")
			: sys;
		totalTokens += Math.ceil(systemStr.length / 4);
	}
	return totalTokens;
}

// ─── Compression trigger ──────────────────────────────────────────────────────

export type CompressionTriggerReason = "context_size" | "cache_expiry";

export interface CompressionTriggerInput {
	context: Context;
	config: HistoryCompressionConfig;
	contextWindow: number;
	targetProvider: string;
	targetModelId: string;
	lastTurnTimestamp: number | undefined;
	/** Override clock for tests. */
	now?: number;
}

/**
 * Decide whether progressive TOON compression should fire on this turn.
 *
 * Returns the trigger reason, or `null` if no compression is warranted.
 * Triggers (in order):
 *   1. `context_size` — context tokens >= contextThreshold * contextWindow (default 80%).
 *   2. `cache_expiry` — time since last turn >= timeThreshold (default 5 min).
 *
 * Returns `null` (no trigger) when:
 *   - compression is disabled,
 *   - the target model is on the exclude list,
 *   - progressive mode is disabled.
 */
export function shouldCompress(
	input: CompressionTriggerInput,
): CompressionTriggerReason | null {
	const {
		context,
		config,
		contextWindow,
		targetProvider,
		targetModelId,
		lastTurnTimestamp,
	} = input;

	if (!config.enabled) return null;
	if (isModelExcludedFromCompression(config, targetProvider, targetModelId)) {
		return null;
	}
	if (!config.progressive?.enabled) return null;

	const contextThreshold =
		config.progressive.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD;
	const timeThresholdSeconds =
		config.progressive.timeThreshold ?? DEFAULT_TIME_THRESHOLD_SECONDS;

	const contextTokens = estimateContextTokens(context);
	if (contextTokens >= contextThreshold * contextWindow) {
		return "context_size";
	}

	if (lastTurnTimestamp !== undefined) {
		const now = input.now ?? Date.now();
		const secondsSinceLastTurn = (now - lastTurnTimestamp) / 1000;
		if (secondsSinceLastTurn >= timeThresholdSeconds) {
			return "cache_expiry";
		}
	}

	return null;
}

/**
 * Convenience wrapper: compress when {@link shouldCompress} fires, otherwise
 * return the context unchanged. The richer flow in `provider.ts` calls
 * `shouldCompress` + `compressHistory` directly so it can also manage
 * checkpoint reuse and stats accumulation.
 */
export function compressIfNeeded(
	input: CompressionTriggerInput,
	turnNumber?: number,
): { context: Context; stats: CompressionStats | undefined; reason: CompressionTriggerReason | null } {
	const reason = shouldCompress(input);
	if (!reason) {
		return { context: input.context, stats: undefined, reason: null };
	}
	const result = compressHistory(input.context, input.config, turnNumber);
	return { context: result.context, stats: result.stats, reason };
}


/**
 * Apply compression to context with checkpoint management and stats tracking.
 * Handles progressive mode (trigger-based + checkpoint reuse) and static/dynamic modes.
 * 
 * @returns Updated context, stats, trigger reason, and checkpoint operations.
 */
export interface CompressionResult {
	/** Compressed or checkpoint-reused context. */
	context: Context;
	/** Compression stats (undefined if checkpoint was reused without compression). */
	stats: CompressionStats | undefined;
	/** Trigger reason when compression fired. */
	triggerReason: CompressionTriggerReason | null;
	/** New checkpoint to store (progressive mode only). */
	newCheckpoint?: CompressionCheckpoint;
	/** Whether checkpoint was reused without fresh compression. */
	checkpointReused: boolean;
	/** Whether checkpoint was expired and cleared. */
	checkpointExpired: boolean;
}

export interface ApplyCompressionInput {
	/** Current context to potentially compress. */
	context: Context;
	/** Resolved compression config for this profile. */
	config: HistoryCompressionConfig;
	/** Target model's context window size. */
	contextWindow: number;
	/** Target provider string. */
	targetProvider: string;
	/** Target model ID string. */
	targetModelId: string;
	/** Timestamp of last turn (for cache expiry). */
	lastTurnTimestamp: number | undefined;
	/** Current checkpoint (progressive mode). */
	currentCheckpoint: CompressionCheckpoint | undefined;
	/** Frozen block (static/dynamic mode). */
	frozenBlock?: { messages: Message[]; stats: CompressionStats };
	/** Override clock for tests. */
	now?: number;
}

/**
 * Apply compression with full checkpoint management.
 * Extracted from provider.ts to eliminate duplication and centralize compression logic.
 */
export function applyCompression(input: ApplyCompressionInput): CompressionResult {
	const {
		context,
		config,
		contextWindow,
		targetProvider,
		targetModelId,
		lastTurnTimestamp,
		currentCheckpoint,
		frozenBlock,
	} = input;
	const now = input.now ?? Date.now();
	const turnNumber = context.messages.length;

	// ── Guard: check if compression is applicable ───────────────────────
	if (!canCompressForModel(config, targetProvider, targetModelId)) {
		return {
			context,
			stats: undefined,
			triggerReason: null,
			checkpointReused: false,
			checkpointExpired: false,
		};
	}

	// ── Progressive TOON mode ────────────────────────────────────────────
	if (config.progressive?.enabled) {
		const triggerReason = shouldCompress({
			context,
			config,
			contextWindow,
			targetProvider,
			targetModelId,
			lastTurnTimestamp,
			now,
		});

		if (triggerReason) {
			// Trigger fired: create new checkpoint
			const originalTokens = estimateContextTokens(context);
			const result = compressHistory(context, config, turnNumber);
			const compressedTokens = estimateContextTokens(result.context);
			const tokensSaved = Math.max(0, originalTokens - compressedTokens);

			if (result.stats) {
				result.stats.estimatedOriginalTokens = originalTokens;
				result.stats.estimatedCompressedTokens = compressedTokens;
				result.stats.estimatedTokensSaved = tokensSaved;
			}

			// Extract TOON block for checkpoint
			const toonBlockContent = result.context.messages
				.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("TOON"))
				?.content as string | undefined;

			const newCheckpoint = toonBlockContent
				? {
						frozenBlock: toonBlockContent,
						metadata: {
							turn: turnNumber,
							range: [0, toonBlockContent.length] as [number, number],
							stats: result.stats!,
							triggerReason,
							timestamp: now,
						},
				  }
				: undefined;

			return {
				context: result.context,
				stats: result.stats,
				triggerReason,
				newCheckpoint,
				checkpointReused: false,
				checkpointExpired: false,
			};
		}

		// No trigger: check checkpoint reuse or expiry
		if (currentCheckpoint) {
			const checkpointAge = turnNumber - currentCheckpoint.metadata.turn;
			const currentContextTokens = estimateContextTokens(context);
			const checkpointAgeLimit = config.progressive.maxCheckpointAge ?? 50;
			const checkpointSizeLimit = config.progressive.maxCheckpointSize ?? 200_000;

			const isStale = checkpointAge > checkpointAgeLimit;
			const isOversized = currentContextTokens > checkpointSizeLimit;

			if (isStale || isOversized) {
				// Checkpoint expired: force fresh compression
				const originalTokens = estimateContextTokens(context);
				const result = compressHistory(context, config, turnNumber);
				const compressedTokens = estimateContextTokens(result.context);
				const tokensSaved = Math.max(0, originalTokens - compressedTokens);

				if (result.stats) {
					result.stats.estimatedOriginalTokens = originalTokens;
					result.stats.estimatedCompressedTokens = compressedTokens;
					result.stats.estimatedTokensSaved = tokensSaved;
				}

				const toonBlockContent = result.context.messages
					.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("TOON"))
					?.content as string | undefined;

				const newCheckpoint = toonBlockContent
					? {
							frozenBlock: toonBlockContent,
							metadata: {
								turn: turnNumber,
								range: [0, toonBlockContent.length] as [number, number],
								stats: result.stats!,
								triggerReason: (isStale ? "cache_expiry" : "context_size") as CompressionTriggerReason,
								timestamp: now,
							},
					  }
					: undefined;

				return {
					context: result.context,
					stats: result.stats,
					triggerReason: isStale ? "cache_expiry" : "context_size",
					newCheckpoint,
					checkpointReused: false,
					checkpointExpired: true,
				};
			}

			// Checkpoint still valid: reuse it
			const keepLastN = config.keepLastN ?? 4;
			const recentMessages = context.messages.slice(-keepLastN);
			return {
				context: {
					...context,
					messages: [
						{
							role: "user",
							content: currentCheckpoint.frozenBlock,
							timestamp: currentCheckpoint.metadata.timestamp,
						},
						...recentMessages,
					],
				},
				stats: undefined,
				triggerReason: null,
				checkpointReused: true,
				checkpointExpired: false,
			};
		}

		// No trigger, no checkpoint: pass through
		return {
			context,
			stats: undefined,
			triggerReason: null,
			checkpointReused: false,
			checkpointExpired: false,
		};
	}

	// ── Static/dynamic TOON mode (backward compatible) ──────────────────
	const shouldFreeze = config.freezeAfter !== undefined && turnNumber === config.freezeAfter;
	const shouldReuseFrozen =
		config.freezeAfter !== undefined && turnNumber > config.freezeAfter && frozenBlock;

	if (shouldReuseFrozen && frozenBlock) {
		// Prepend cached frozen TOON block
		return {
			context: {
				...context,
				messages: [
					...frozenBlock.messages,
					...context.messages.slice(-(config.keepLastN ?? 4) * 2),
				],
			},
			stats: undefined,
			triggerReason: null,
			checkpointReused: true,
			checkpointExpired: false,
		};
	}

	if (!shouldReuseFrozen) {
		// Apply compression with current turn number
		const originalTokens = estimateContextTokens(context);
		const result = compressHistory(context, config, turnNumber);
		const compressedTokens = estimateContextTokens(result.context);
		const tokensSaved = Math.max(0, originalTokens - compressedTokens);

		if (result.stats) {
			result.stats.estimatedOriginalTokens = originalTokens;
			result.stats.estimatedCompressedTokens = compressedTokens;
			result.stats.estimatedTokensSaved = tokensSaved;
		}

		return {
			context: result.context,
			stats: result.stats,
			triggerReason: null,
			checkpointReused: false,
			checkpointExpired: false,
		};
	}

	// No compression applied
	return {
		context,
		stats: undefined,
		triggerReason: null,
		checkpointReused: false,
		checkpointExpired: false,
	};
}
/**
 * Compress old conversation history into a TOON block prepended as a user
 * message. Returns the context unchanged if compression is not warranted.
 *
 * Invariants:
 * - systemPrompt is never touched.
 * - tools are passed through unchanged.
 * - The last keepLastN messages are always kept as native turns.
 * - If messages.length <= keepLastN there is nothing to compress; returns as-is.
 * - The returned messages array always has valid turn alternation.
 * - Tool call sequences are never split across the compress/keep boundary.
 */
export interface CompressResult {
	context: Context;
	stats: CompressionStats | undefined;
}

export function compressHistory(
	context: Context,
	config: HistoryCompressionConfig,
	turnNumber?: number,
): CompressResult {
	const keepLastN = Math.max(1, config.keepLastN ?? 4);
	const { messages } = context;

	// If freeze is configured and we're past the freeze point, reuse previous compression
	// (compression is skipped at runtime; the frozen block is provided via context prepend)
	if (config.freezeAfter !== undefined && turnNumber !== undefined && turnNumber > config.freezeAfter) {
		// Return context unchanged when frozen — compression was already applied at freeze point
		// and stored in state for reuse
		return { context, stats: undefined };
	}

	// Not enough history to be worth compressing.
	if (messages.length <= keepLastN) return { context, stats: undefined };
	
	// ── Step 1: Find safe split boundary ──────────────────────────────────────
	const naiveSplit = messages.length - keepLastN;
	const safeSplit = findSafeSplitIndex(messages, naiveSplit);
	
	// If safe split leaves nothing meaningful to compress, skip.
	if (safeSplit <= 0 || messages.length - safeSplit <= 0) {
		return { context, stats: undefined };
	}

	const toCompress = messages.slice(0, safeSplit);
	let toKeep = messages.slice(safeSplit);

	// ── Step 2: Sanitize kept messages for turn alternation ───────────────────
	toKeep = sanitizeTurnAlternation(toKeep);

	// ── Step 3: Separate text-only and tool-related messages for compression ──
	// Text-only messages get TOON tabular encoding (uniform {role, content}).
	// Tool sequences get a structured text summary (non-uniform, no tabular benefit).
	const textMessages: { role: string; content: string }[] = [];
	const toolSummaries: string[] = [];
	let toolBatch: Message[] = [];

	const flushToolBatch = () => {
		if (toolBatch.length > 0) {
			toolSummaries.push(serializeToolSequence(toolBatch));
			toolBatch = [];
		}
	};

	for (const msg of toCompress) {
		if (isToolRelated(msg)) {
			toolBatch.push(msg);
		} else {
			flushToolBatch();
			textMessages.push(serializeTextMessage(msg));
		}
	}
	flushToolBatch();

	// ── Step 4: Build the TOON block ──────────────────────────────────────────
	// Text messages use tabular TOON (uniform {role, content} → great savings).
	// Tool summaries are appended as plain text (non-uniform, no TOON benefit).
	let compressedContent = "";

	if (textMessages.length > 0) {
		const toonBlock = toonEncode({ messages: textMessages });
		compressedContent += `\`\`\`toon\n${toonBlock}\n\`\`\``;
	}

	if (toolSummaries.length > 0) {
		if (compressedContent) compressedContent += "\n\n";
		compressedContent += `[Tool interactions summary]\n${toolSummaries.join("\n---\n")}`;
	}

	const compressionNote =
		`[HISTORY: ${toCompress.length} messages compressed below. ` +
		`Reconstruct context from this history before responding.]\n` +
		compressedContent;

	const historyUserMsg: Message = {
		role: "user",
		content: compressionNote,
		timestamp: toCompress[0]?.timestamp ?? Date.now(),
	};

	// ── Step 5: Build output with valid alternation ───────────────────────────
	const outputMessages: Message[] = [historyUserMsg];

	// Determine if we need the synthetic ack based on what follows.
	const firstKeptRole = toKeep[0]?.role;

	if (firstKeptRole === "assistant" || firstKeptRole === "toolResult") {
		// First kept message is assistant or toolResult — no ack needed
		// (user(toon) → assistant/toolResult is valid alternation)
		// For toolResult, the LLM APIs treat it as a user-side message,
		// but Bedrock wraps it inside a user message, so it's effectively user→user.
		// We need the ack to separate them.
		if (firstKeptRole === "toolResult") {
			outputMessages.push(makeSyntheticAck(historyUserMsg.timestamp + 1));
		}
		// For assistant: user(toon) → assistant is valid, no ack needed
	} else {
		// First kept is user — need ack to avoid user(toon) → user(kept)
		outputMessages.push(makeSyntheticAck(historyUserMsg.timestamp + 1));
	}

	outputMessages.push(...toKeep);

	// ── Step 6: Final alternation validation ──────────────────────────────────
	const finalMessages = sanitizeTurnAlternation(outputMessages);

	// Estimate original JSON size of the compressed portion.
	const originalChars = JSON.stringify(toCompress).length;

	return {
		context: {
			systemPrompt: context.systemPrompt,
			messages: finalMessages,
			tools: context.tools,
		},
		stats: {
			compressedMessages: toCompress.length,
			originalChars,
			compressedChars: compressionNote.length,
		},
	};
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSyntheticAck(timestamp: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Understood. I have the conversation history." }],
		api: "router-local-api" as any,
		provider: "router",
		model: "history-compressor",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}
