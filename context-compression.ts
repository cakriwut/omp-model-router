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
import type { HistoryCompressionConfig, CompressionStats } from "./types";

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

/**
 * Extract plain text from a message's content.
 */
function extractText(msg: Message): string {
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.map((b: any) => {
			if (b.type === "text") return b.text;
			if (b.type === "toolCall") return `[tool:${b.name}]`;
			return "";
		})
		.filter(Boolean)
		.join(" ");
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
): CompressResult {
	const keepLastN = Math.max(1, config.keepLastN ?? 4);
	const { messages } = context;

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
