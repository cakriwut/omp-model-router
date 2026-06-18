import { join } from "node:path";
import {
	streamSimple,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { RoutingDecision } from "./types";
import { profileNames, parseCanonicalModelRef, ROUTER_TIERS, resolveProfileForTaskType } from "./config";
import { resolveEffectivePin, setScopedPin } from "./routing/pin";
import {
	resolveRouting,
	extractTextFromContent,
	hasImageAttachment,
	getLastUserText,
	detectTaskType,
} from "./routing";
import { sanitizeToolSchemas } from "./utils/schema-compat";
import type { RouterState } from "./state";
import { loadPitfalls } from "./calibration/pitfalls";
import {
	StatusAwareError,
	isRetryableStatus,
	parseRetryAfterMs,
	parseOriginalStatus,
	computeEmbargoDuration,
} from "./embargo";

/**
 * Stream idle timeout per provider, aligned with pi-ai's own watchdog values.
 * OpenAI uses 45s inter-event idle (DEFAULT_OPENAI_STREAM_IDLE_TIMEOUT_MS).
 * Anthropic uses 45s first-event only — we apply the same 45s for inter-event.
 * Codex uses 300s websocket idle.
 * All others default to 45s (the pi-ai standard for healthy streaming).
 */
const STREAM_IDLE_TIMEOUT_BY_PROVIDER: Record<string, number> = {
	"openai": 45_000,
	"anthropic": 45_000,
	"amazon-bedrock": 45_000,
	"google": 45_000,
	"github-copilot": 45_000,
};
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Resolve stream idle timeout: config override > provider-specific > default (45s). */
function resolveStreamIdleTimeout(configOverride: number | undefined, provider: string): number {
	if (configOverride !== undefined) return configOverride;
	return STREAM_IDLE_TIMEOUT_BY_PROVIDER[provider] ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/** Default absolute wall-clock limit for the entire delegated stream (5 min). */
const DEFAULT_MAX_STREAM_DURATION_MS = 300_000;

/** Probe timeout: how long to wait for the probe call to respond. */
const PROBE_TIMEOUT_MS = 15_000;

/** Max probe retries with exponential backoff before declaring provider dead. */
const PROBE_MAX_RETRIES = 2;

/**
 * Wraps an async iterable with an inter-event idle timeout.
 * If no event arrives within `timeoutMs` after the previous event (or stream start),
 * the iterator throws a StreamIdleTimeoutError so the fallback chain can trigger.
 */
export class StreamIdleTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Stream idle timeout: no event received for ${Math.ceil(timeoutMs / 1000)}s`);
		this.name = "StreamIdleTimeoutError";
	}
}

export async function* withIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	timeoutMs: number,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	try {
		while (true) {
			const { promise: timeoutPromise, resolve: resolveTimeout } =
				Promise.withResolvers<{ kind: "timeout" }>();
			const timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);

			const nextPromise = iterator.next().then(
				(result) => ({ kind: "next" as const, result }),
				(error) => ({ kind: "error" as const, error }),
			);

			try {
				const outcome = await Promise.race([nextPromise, timeoutPromise]);
				if (outcome.kind === "timeout") {
					// Try to clean up the underlying iterator
					void iterator.return?.()?.catch?.(() => {});
					throw new StreamIdleTimeoutError(timeoutMs);
				}
				if (outcome.kind === "error") {
					throw outcome.error;
				}
				if (outcome.result.done) {
					return;
				}
				yield outcome.result.value;
			} finally {
				clearTimeout(timer);
			}
		}
	} finally {
		void iterator.return?.()?.catch?.(() => {});
	}
}

/**
 * Thrown when a stream exceeds the absolute wall-clock duration limit.
 * Treated the same as StreamIdleTimeoutError — triggers the fallback chain.
 */
export class StreamMaxDurationError extends Error {
	constructor(timeoutMs: number) {
		super(`Stream max duration exceeded: stream ran for over ${Math.ceil(timeoutMs / 1000)}s`);
		this.name = "StreamMaxDurationError";
	}
}

/**
 * Wraps an async iterable with an absolute wall-clock duration limit.
 * Unlike withIdleTimeout (which resets on every event), this fires once after
 * `durationMs` from the moment iteration starts — regardless of how many events
 * have arrived. Protects against models that drip-feed tokens indefinitely
 * (e.g. Opus extended thinking resetting the idle timer every few seconds).
 */
export async function* withMaxDuration<T>(
	iterable: AsyncIterable<T>,
	durationMs: number,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	let timedOut = false;
	const { promise: deadlinePromise, resolve: resolveDeadline } =
		Promise.withResolvers<{ kind: "deadline" }>();
	const timer = setTimeout(() => {
		timedOut = true;
		resolveDeadline({ kind: "deadline" });
	}, durationMs);
	try {
		while (true) {
			const nextPromise = iterator.next().then(
				(result) => ({ kind: "next" as const, result }),
				(error) => ({ kind: "error" as const, error }),
			);
			const outcome = await Promise.race([nextPromise, deadlinePromise]);
			if (outcome.kind === "deadline") {
				void iterator.return?.()?.catch?.(() => {});
				throw new StreamMaxDurationError(durationMs);
			}
			if (outcome.kind === "error") {
				throw outcome.error;
			}
			if (outcome.result.done) {
				return;
			}
			yield outcome.result.value;
			if (timedOut) {
				// Deadline fired while we were processing — stop at next yield boundary
				void iterator.return?.()?.catch?.(() => {});
				throw new StreamMaxDurationError(durationMs);
			}
		}
	} finally {
		clearTimeout(timer);
		void iterator.return?.()?.catch?.(() => {});
	}
}

/**
 * Probe a provider to check if it's alive after a stream idle timeout.
 * Sends a minimal request ("hi", max 1 token) and checks if it responds.
 *
 * Strategy:
 * - If probe succeeds → provider is alive, the stall was request-specific
 *   (e.g. overloaded on that particular request, or thinking too long).
 *   The caller should retry the original request with backoff.
 * - If probe fails/times out → provider is truly down or rate-limited.
 *   The caller should trigger fallback to next model.
 *
 * @returns true if provider responded (alive), false if probe failed
 */
async function probeProvider(
	targetModel: Model<Api>,
	apiKey: string,
	debug: boolean,
): Promise<boolean> {
	const probeContext = {
		messages: [{ role: "user" as const, content: "hi" }],
	} as Context;
	try {
		const ac = new AbortController();
		const timeout = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
		const probeStream = streamSimple(targetModel, probeContext, {
			apiKey,
			headers: targetModel.headers,
			maxTokens: 1,
			signal: ac.signal,
		});
		// Wait for any event — if we get one, the provider is alive
		for await (const event of probeStream) {
			clearTimeout(timeout);
			if (event.type === "error") {
				if (debug) console.log(`[model-router] probe failed: ${(event as any).error?.errorMessage || "error event"}`);
				return false;
			}
			// Any non-error event means the provider is alive
			if (debug) console.log(`[model-router] probe success: provider alive (got ${event.type})`);
			return true;
		}
		// Stream ended without events — unusual but treat as alive
		clearTimeout(timeout);
		return true;
	} catch (err) {
		if (debug) {
			console.log(`[model-router] probe failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return false;
	}
}

export const createErrorMessage = (
	model: Model<Api>,
	message: string,
): AssistantMessage => {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
};

/** Heuristic token estimator (conservative: 3 characters per token) */
const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

/** Valid tool name pattern per Bedrock/Anthropic API constraints */
export const VALID_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Sanitize a tool name to match API constraints ([a-zA-Z0-9_-]+).
 * Replaces invalid characters with underscores and truncates to 64 chars.
 */
export const sanitizeToolName = (name: string): string => {
	if (VALID_TOOL_NAME_RE.test(name)) return name;
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return sanitized || "unknown_tool";
};

/**
 * Sanitize context messages to ensure tool call names are valid.
 * Some models (e.g. with leaked special tokens) may produce malformed tool names
 * that fail API validation when replayed in conversation history.
 */
export const sanitizeContext = (context: Context): Context => {
	// Pre-scan: check if any message has an invalid tool call name before allocating.
	// The common path (no malformed names) returns the original context as-is.
	let needsSanitize = false;
	outer: for (const msg of context.messages) {
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content as any[]) {
			if (block.type === "toolCall" && block.name && !VALID_TOOL_NAME_RE.test(block.name)) {
				needsSanitize = true;
				break outer;
			}
		}
	}
	if (!needsSanitize) return context;

	// Slow path: at least one invalid name found — rebuild only the affected messages.
	const messages = context.messages.map((msg) => {
		if (!Array.isArray(msg.content)) return msg;
		let contentModified = false;
		const content = (msg.content as any[]).map((block: any) => {
			if (block.type === "toolCall" && block.name && !VALID_TOOL_NAME_RE.test(block.name)) {
				contentModified = true;
				return { ...block, name: sanitizeToolName(block.name) };
			}
			return block;
		});
		if (contentModified) return { ...msg, content };
		return msg;
	});
	return { ...context, messages };
};

/**
 * Returns true if the given model ref supports image input.
 */
const modelSupportsImage = (
	modelRef: string,
	registry: ExtensionContext["modelRegistry"],
): boolean => {
	try {
		const { provider, modelId } = parseCanonicalModelRef(modelRef);
		return registry.find(provider, modelId)?.input?.includes("image") ?? false;
	} catch {
		return false;
	}
};

/**
 * Truncate context to fit within a target token limit by removing oldest messages.
 * Always preserves the latest user message. O(n) — single pass to compute costs,
 * then slice from the front.
 */
const truncateContext = (context: Context, limit: number): Context => {
	const messages = context.messages;
	if (messages.length <= 1) return context;

	const systemTokens = context.systemPrompt
		? estimateTokens(context.systemPrompt.join("\n"))
		: 0;

	let totalTokens = systemTokens;
	const msgCosts = new Array<number>(messages.length);
	for (let i = 0; i < messages.length; i++) {
		const cost = estimateTokens(extractTextFromContent(messages[i].content));
		msgCosts[i] = cost;
		totalTokens += cost;
	}
	if (totalTokens <= limit) return context;

	// Remove from front; always preserve the last message.
	let cutIndex = 0;
	let removed = 0;
	const target = totalTokens - limit;
	while (cutIndex < messages.length - 1 && removed < target) {
		removed += msgCosts[cutIndex];
		cutIndex++;
	}

	return { ...context, messages: messages.slice(cutIndex) };
};

const supportsReasoning = (
	profile: RouterState["currentConfig"]["profiles"][string],
	modelRegistry: ExtensionContext["modelRegistry"] | undefined,
): boolean => {
	if (!modelRegistry) return false;

	for (const tier of ROUTER_TIERS) {
		try {
			const { provider, modelId } = parseCanonicalModelRef(profile[tier].model);
			if (modelRegistry.find(provider, modelId)?.reasoning) {
				return true;
			}
		} catch (_error) {
			// ignore invalid model refs
		}
	}

	return false;
};


export const registerRouterProvider = (
	pi: ExtensionAPI,
	state: RouterState,
	actions: {
		persistState: () => void;
		recordDebugDecision: (decision: RoutingDecision) => void;
		getThinkingOverride: (
			profileName: string,
			tier: RoutingDecision["tier"],
		) => RoutingDecision["thinking"] | undefined;
		updateStatus: (ctx: ExtensionContext) => void;
	},
) => {
	const profileList = profileNames(state.currentConfig);

	const modelDefinitions = profileList.map((name) => {
		const profile = state.currentConfig.profiles[name];
		let contextWindow = 1_000_000;
		let maxTokens = 64_000;

		if (state.currentModelRegistry) {
			for (const tier of ROUTER_TIERS) {
				try {
					const { provider, modelId } = parseCanonicalModelRef(
						profile[tier].model,
					);
					const tierModel = state.currentModelRegistry.find(provider, modelId);
					if (tierModel && tier === "high") {
						contextWindow = tierModel.contextWindow ?? contextWindow;
						maxTokens = tierModel.maxTokens ?? maxTokens;
					}
				} catch (_error) {
					// ignore
				}
			}
		}

		return {
			id: name,
			name: `Router ${name}`,
			reasoning: supportsReasoning(profile, state.currentModelRegistry),
			input: ["text", "image"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
		};
	});

	const modelsKey = modelDefinitions
		.map((m) => `${m.id}:${m.contextWindow}:${m.maxTokens}:${m.reasoning}`)
		.join(",");
	if (state.lastRegisteredModels === modelsKey) return;

	pi.registerProvider("router", {
		baseUrl: "router://local",
		apiKey: "omp-model-router",
		api: "router-local-api" as Api,
		models: modelDefinitions,
		streamSimple(
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream {
			const stream = new AssistantMessageEventStream();

			(async () => {
				// ── Snapshot session-local values synchronously before any await ───────────────
				// These are hoisted above the try so the finally block can reference them.
				const _snapSessionId = state.activeSessionId;
				const sessionScope = _snapSessionId ? state.getSessionScope(_snapSessionId) : state.scope;
				const sessionCtx = _snapSessionId ? state.getSessionContext(_snapSessionId) : undefined;
				try {
					// ── Recover currentModelRegistry if not yet set ──────────────────
					// During team/sub-agent execution, streamSimple may fire before
					// session_start completes for the child session. Recover from the
					// session-level ctx stored by turn_start rather than hard-failing.
					if (!state.currentModelRegistry) {
						const recoveredRegistry = sessionCtx?.modelRegistry;
						if (recoveredRegistry) {
							state.currentModelRegistry = recoveredRegistry;
							if (state.currentConfig.debug) {
								console.log(
									`[model-router] Recovered modelRegistry from session context (session=${_snapSessionId})`,
								);
							}
						} else {
							state.lastStreamWasInternalError = true;
							throw new Error(
								"Router provider not initialized yet. Wait for session_start and retry.",
							);
						}
					}
					const profile = state.currentConfig.profiles[model.id];
					if (!profile) {
						throw new Error(`Unknown router profile: ${model.id}`);
					}

					// Clear internal error flag — we successfully initialized.
					state.lastStreamWasInternalError = false;

				// ── Task-type profile selection ───────────────────────────────────────
				// If the active profile is generic (no taskType declared), detect the
				// task type from the prompt and redirect to a task-type profile if one
				// exists. When the user is already on a task-specific profile, skip.
				let effectiveProfileName = model.id;
				let effectiveProfile = profile;
				if (!profile.taskType) {
					const lastText = getLastUserText(context);
					if (lastText) {
						const detectedType = detectTaskType(lastText);
						if (detectedType) {
							const taskProfileName = resolveProfileForTaskType(state.currentConfig, detectedType);
							const taskProfile = taskProfileName
								? state.currentConfig.profiles[taskProfileName]
								: undefined;
							if (taskProfileName && taskProfile) {
								effectiveProfileName = taskProfileName;
								effectiveProfile = taskProfile;
								if (state.currentConfig.debug) {
									console.log(
										`[model-router] task-type: detected="${detectedType}" profile="${model.id}"→"${taskProfileName}"`,
									);
								}
							}
						}
					}
				}
				state.selectedProfile = effectiveProfileName;
				state.routerEnabled = true;

					const isBudgetExceeded =
						state.currentConfig.maxSessionBudget !== undefined &&
						state.accumulatedCost >= state.currentConfig.maxSessionBudget;

					// ── Resolve routing decision (heuristic + overrides) ──────────────
					// When calibration is in adaptive mode, use calibration.classifierModel for routing.
					// Classifier is only active when: calibration.enabled && mode=adaptive (or
					// top-level classifierModel is set for legacy direct use).
					const effectiveClassifierModel =
						state.currentConfig.calibration?.enabled &&
						state.currentConfig.calibration?.mode === "adaptive" &&
						state.currentConfig.calibration?.classifierModel
							? state.currentConfig.calibration.classifierModel
							: state.currentConfig.classifierModel;

					// Load pitfalls once per routing decision; cached in-process after first read.
					const pitfalls = effectiveClassifierModel
						? loadPitfalls(state.currentCwd, state.currentConfig.pitfallsPath)
						: undefined;

				const { scopedPin, floor } = resolveEffectivePin(sessionScope, state.currentConfig);
				const traceEnabled = !!state.currentConfig.calibration?.traceEnabled;
				// Derive path from session file directly — getArtifactsDir() returns null
				// before the harness creates the directory (i.e. before first tool call).
				// sessionFile.slice(0, -6) is the same formula the harness uses internally.
				const sessionFile = traceEnabled && sessionCtx
					? (sessionCtx.sessionManager as any).getSessionFile?.() as string | undefined
					: undefined;
				const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
				const promptLogPath: string | undefined = typeof artifactsDir === "string" && artifactsDir
					? join(artifactsDir, "classifierPrompt.jsonl")
					: undefined;
				const decision = await resolveRouting(
					{
						context,
						previousDecision: sessionScope.lastDecision,
						pinnedTier: scopedPin,
						floor,
						isBudgetExceeded,
						modelRegistry: state.currentModelRegistry,
						lastExtensionContext: sessionCtx,
						calibration: state.calibration,
						scope: sessionScope,
						state: state,
					},
					{
					profileName: effectiveProfileName,
					profile: effectiveProfile,
					thinkingOverrides: state.thinkingByProfile[effectiveProfileName],
						phaseBias: state.currentConfig.phaseBias ?? 0.5,
						rules: state.currentConfig.rules,
						classifierModel: effectiveClassifierModel,
						debug: state.currentConfig.debug,
						calibrationConfig: state.currentConfig.calibration,
						pinConfig: { pinTimeout: state.currentConfig.pinTimeout, defaultPin: state.currentConfig.defaultPin, pinPressureThreshold: state.currentConfig.pinPressureThreshold },
						pitfalls: pitfalls || undefined,
						promptLogPath,
						recordClassifierCost: (modelRef, usage) =>
							state.recordModelCost(modelRef, "classifier", usage),
					},
				);

					// (auto-upgrade is now handled via setScopedPin in index.ts tool_execution_end)

					sessionScope.lastDecision = decision;
					actions.recordDebugDecision(decision);

					// Track routing decision (tier counter)
					sessionScope.tierCounter[decision.tier]++;

					// Classifier now runs synchronously in resolveRouting (sync-classifier-only)

					if (sessionCtx) {
						actions.updateStatus(sessionCtx);
					}

					// ── Build fallback model chain ────────────────────────────────────
					const imageAttached = hasImageAttachment(context);
					let modelsToTry = [
						decision.targetLabel,
						...(effectiveProfile[decision.tier].fallbacks ?? []),
					];
					if (imageAttached) {
						const filtered = modelsToTry.filter((ref) =>
							modelSupportsImage(ref, state.currentModelRegistry!),
						);
						modelsToTry = filtered.length > 0 ? filtered : [decision.targetLabel];
					}

					// ── Embargo-aware filtering ────────────────────────────────────────
					const embargoEnabled = state.currentConfig.embargo?.enabled !== false;
					if (embargoEnabled) {
						const nonEmbargoed = modelsToTry.filter((ref) => !state.isEmbargoed(ref));
						if (nonEmbargoed.length > 0) {
							const skipped = modelsToTry.filter((ref) => state.isEmbargoed(ref));
							if (state.currentConfig.debug && skipped.length > 0) {
								for (const ref of skipped) {
									const remaining = Math.ceil(state.getEmbargoTimeRemaining(ref) / 1000);
									console.log(`[model-router] ⏭ Skipped (embargoed): ${ref} — ${remaining}s remaining`);
								}
							}
							if (modelsToTry[0] !== nonEmbargoed[0]) {
								decision.isEmbargoed = true;
								decision.embargoTimeRemaining = state.getEmbargoTimeRemaining(modelsToTry[0]);
							}
							modelsToTry = nonEmbargoed;
						} else {
							// All embargoed — use soonest expiry to prevent deadlock
							const soonest = state.getSoonestExpiry(modelsToTry);
							if (soonest) {
								modelsToTry = [soonest];
								if (state.currentConfig.debug) {
									console.log(`[model-router] ⚠ All models embargoed — trying soonest-expiry: ${soonest}`);
								}
							}
						}
					}

					// ── Delegate to target model ──────────────────────────────────────
					let lastError: unknown;
					let success = false;

				for (let i = 0; i < modelsToTry.length; i++) {
					const modelRef = modelsToTry[i];
					const { provider: targetProvider, modelId: targetModelId } =
						parseCanonicalModelRef(modelRef);

					if (state.currentConfig.debug) {
						console.log(
							`[model-router] Attempt ${i + 1}/${modelsToTry.length}: ${modelRef}`,
						);
					}

					if (targetProvider === "router") {
						if (state.currentConfig.debug) {
							console.log(`  ✗ Skipped: router provider`);
						}
						continue;
					}

					const targetModel = state.currentModelRegistry.find(
						targetProvider,
						targetModelId,
					);
					if (!targetModel) {
						if (state.currentConfig.debug) {
							console.log(`  ✗ Skipped: model not in registry`);
						}
						lastError = new Error(
							`Routed model not found: ${targetProvider}/${targetModelId}`,
						);
						continue;
					}

					const apiKey = await state.currentModelRegistry.getApiKey(
						targetModel,
					);
					if (!apiKey) {
						if (state.currentConfig.debug) {
							console.log(`  ✗ Skipped: no API key`);
						}
						lastError = new Error(
							`No API key for routed model: ${targetProvider}/${targetModelId}`,
						);
						continue;
					}
						// Hoisted so the catch block (probe-retry path) can access it
						let effectiveContext: typeof context = context;
						try {
							// Auto-truncation if picked model has smaller context window
							const targetLimit = targetModel.contextWindow || 128_000;
							effectiveContext =
								targetLimit < (model.contextWindow ?? Infinity)
									? truncateContext(context, targetLimit)
									: context;


						const thinkingOverride = actions.getThinkingOverride(
							effectiveProfileName,
							decision.tier,
						);
						const effectiveThinking = thinkingOverride ?? decision.thinking;
						const delegatedReasoning: Effort | undefined =
							targetModel.reasoning &&
							effectiveThinking !== ThinkingLevel.Off &&
							effectiveThinking !== ThinkingLevel.Inherit
								? clampThinkingLevelForModel(
										targetModel,
										effectiveThinking as Effort,
								  )
								: undefined;

						// TODO: Hidden thinking label - API not available yet
						// if (state.lastExtensionContext) {
						// 	if (delegatedReasoning) {
						// 		state.lastExtensionContext.ui.setHiddenThinkingLabel?.(
						// 			`Thinking (${targetProvider}/${targetModelId})...`,
						// 		);
						// 	} else {
						// 		state.lastExtensionContext.ui.setHiddenThinkingLabel?.();
						// 	}
						// }

						const delegatedStream = streamSimple(targetModel, sanitizeToolSchemas(sanitizeContext(effectiveContext)), {
							...options,
							apiKey,
							headers: targetModel.headers,
							...(delegatedReasoning ? { reasoning: delegatedReasoning } : {}),
						});

						// Wrap stream with idle timeout to detect stalled providers,
						// then wrap with absolute wall-clock duration limit to catch
						// models that drip-feed tokens indefinitely (e.g. extended thinking).
						const idleTimeoutMs = resolveStreamIdleTimeout(
							state.currentConfig.streamIdleTimeoutMs,
							targetProvider,
						);
						const maxDurationMs = state.currentConfig.maxStreamDurationMs !== undefined
							? state.currentConfig.maxStreamDurationMs
							: DEFAULT_MAX_STREAM_DURATION_MS;
						let eventSource: AsyncIterable<import("@oh-my-pi/pi-ai").AssistantMessageEvent> = idleTimeoutMs > 0
							? withIdleTimeout(delegatedStream, idleTimeoutMs)
							: delegatedStream;
						if (maxDurationMs > 0) {
							eventSource = withMaxDuration(eventSource, maxDurationMs);
						}

						for await (const event of eventSource) {
							if (event.type === "done") {
								const u = event.message.usage;
								const cost = u?.cost?.total ?? 0;
								state.accumulatedCost += cost;
								decision.usage = {
									inputTokens:
										(decision.usage?.inputTokens ?? 0) + (u?.input ?? 0),
									outputTokens:
										(decision.usage?.outputTokens ?? 0) + (u?.output ?? 0),
									cacheReadTokens:
										(decision.usage?.cacheReadTokens ?? 0) +
										(u?.cacheRead ?? 0),
									cacheWriteTokens:
										(decision.usage?.cacheWriteTokens ?? 0) +
										(u?.cacheWrite ?? 0),
									cost: (decision.usage?.cost ?? 0) + cost,
								};
								// Track model cost
								state.recordModelCost(decision.targetLabel, decision.tier, {
									inputTokens: u?.input ?? 0,
									outputTokens: u?.output ?? 0,
									cacheReadTokens: u?.cacheRead ?? 0,
									cacheWriteTokens: u?.cacheWrite ?? 0,
									cost,
								});
							}
							if (event.type === "error") {
								const errEvent = event as { error?: { errorMessage?: string; errorStatus?: number } };
								const errMsg = errEvent.error?.errorMessage || "Model failed.";
								const errStatus = errEvent.error?.errorStatus;
								const retryAfter = parseRetryAfterMs(errMsg);
								throw new StatusAwareError(errMsg, errStatus, retryAfter);
							}
							stream.push(event);
						}
						if (state.currentConfig.debug) {
							console.log(`  ✓ Success with ${modelRef}`);
						}
						// Lift embargo on success (model recovered)
						if (embargoEnabled && state.isEmbargoed(modelRef)) {
							state.liftEmbargo(modelRef);
							if (state.currentConfig.debug) {
								console.log(`[model-router] ✓ Embargo lifted: ${modelRef}`);
							}
						}
						success = true;
						if (i > 0) decision.isFallback = true;
						break;
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						if (state.currentConfig.debug) {
							console.log(`  ✗ Failed: ${errMsg}`);
						}

						// ── Stream idle timeout: probe provider before giving up ──────
						if ((err instanceof StreamIdleTimeoutError || err instanceof StreamMaxDurationError) && apiKey) {
							let probeRetry = 0;
							while (probeRetry < PROBE_MAX_RETRIES) {
								probeRetry++;
								const backoffMs = 5_000 * 2 ** (probeRetry - 1); // 5s, 10s
								if (state.currentConfig.debug) {
									console.log(
										`[model-router] stream stalled on ${modelRef} — probing provider (attempt ${probeRetry}/${PROBE_MAX_RETRIES}, backoff ${backoffMs / 1000}s)`,
									);
								}
								await new Promise((r) => setTimeout(r, backoffMs));
								const alive = await probeProvider(targetModel, apiKey, state.currentConfig.debug ?? false);
								if (!alive) {
									if (state.currentConfig.debug) {
										console.log(`[model-router] probe failed — provider ${modelRef} is down, triggering fallback`);
									}
									break; // Provider is dead → fall through to embargo + next model
								}
								// Provider alive — retry the original stream
								if (state.currentConfig.debug) {
									console.log(`[model-router] probe succeeded — retrying ${modelRef}`);
								}
								// Retry using hoisted effectiveContext (set before the try block)
								const retryIdleMs = resolveStreamIdleTimeout(
									state.currentConfig.streamIdleTimeoutMs,
									targetProvider,
								);
								const retryContext = sanitizeToolSchemas(sanitizeContext(effectiveContext));
								try {
									const retryStream = streamSimple(targetModel, retryContext, {
										...options,
										apiKey,
										headers: targetModel.headers,
									});
									const retryMaxDurationMs = state.currentConfig.maxStreamDurationMs !== undefined
										? state.currentConfig.maxStreamDurationMs
										: DEFAULT_MAX_STREAM_DURATION_MS;
									let retrySource: AsyncIterable<import("@oh-my-pi/pi-ai").AssistantMessageEvent> = retryIdleMs > 0
										? withIdleTimeout(retryStream, retryIdleMs)
										: retryStream;
									if (retryMaxDurationMs > 0) {
										retrySource = withMaxDuration(retrySource, retryMaxDurationMs);
									}
									for await (const event of retrySource) {
										if (event.type === "done") {
											const u = event.message.usage;
											const cost = u?.cost?.total ?? 0;
											state.accumulatedCost += cost;
											decision.usage = {
												inputTokens: (decision.usage?.inputTokens ?? 0) + (u?.input ?? 0),
												outputTokens: (decision.usage?.outputTokens ?? 0) + (u?.output ?? 0),
												cacheReadTokens: (decision.usage?.cacheReadTokens ?? 0) + (u?.cacheRead ?? 0),
												cacheWriteTokens: (decision.usage?.cacheWriteTokens ?? 0) + (u?.cacheWrite ?? 0),
												cost: (decision.usage?.cost ?? 0) + cost,
											};
											state.recordModelCost(decision.targetLabel, decision.tier, {
												inputTokens: u?.input ?? 0,
												outputTokens: u?.output ?? 0,
												cacheReadTokens: u?.cacheRead ?? 0,
												cacheWriteTokens: u?.cacheWrite ?? 0,
												cost,
											});
										}
										if (event.type === "error") {
											const errEvent = event as { error?: { errorMessage?: string; errorStatus?: number } };
											const retryErrMsg = errEvent.error?.errorMessage || "Model failed.";
											throw new StatusAwareError(
												retryErrMsg,
												errEvent.error?.errorStatus,
												parseRetryAfterMs(retryErrMsg),
											);
										}
										stream.push(event);
									}
									if (state.currentConfig.debug) {
										console.log(`  ✓ Success with ${modelRef} (after probe-retry)`);
									}
									success = true;
									break;
								} catch (retryErr) {
									if (retryErr instanceof StreamIdleTimeoutError || retryErr instanceof StreamMaxDurationError) {
										// Same stall on retry — continue probing
										if (state.currentConfig.debug) {
											console.log(`[model-router] retry also stalled — will probe again`);
										}
										continue;
									}
									// Different error — treat as model failure, fall through
									if (state.currentConfig.debug) {
										console.log(`[model-router] retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
									}
									break;
								}
							}
							if (success) break; // Exit the model loop entirely
						}

						// Embargo model on retryable errors
						if (embargoEnabled) {
							// pi-ai wraps retry-exhausted errors as plain Error — recover original status/retryAfter
							const wrappedStatus = parseOriginalStatus(errMsg);
							const wrappedRetryAfter = parseRetryAfterMs(errMsg);
							const errStatus = err instanceof StatusAwareError ? err.status : wrappedStatus;
							const errRetryAfter = err instanceof StatusAwareError ? err.retryAfterMs : wrappedRetryAfter;
							if (isRetryableStatus(errStatus, errMsg)) {
								const embargoCfg = state.currentConfig.embargo ?? { enabled: true };
								const duration = computeEmbargoDuration(errRetryAfter, embargoCfg);
								const reason = errStatus ? `HTTP ${errStatus}: ${errMsg.slice(0, 100)}` : errMsg.slice(0, 100);
								state.embargoModel(modelRef, errStatus, reason, duration, errRetryAfter);
								if (state.currentConfig.debug) {
									console.log(`[model-router] ⏸ Embargoed: ${modelRef} for ${Math.ceil(duration / 1000)}s (HTTP ${errStatus ?? 'unknown'})`);
								}
							}
						}
						lastError = err;
					}
				}

				// ── Cross-tier fallback on retryable errors ────────────────────────
				// When the entire primary chain (tier + explicit fallbacks) fails with
				// retryable errors (429 account rate limit, 503, etc.), try models from
				// other tiers in the same profile before giving up. This handles the
				// common case of account-level rate limits exhausting all same-provider
				// models in one tier.
				if (!success && lastError) {
					const lastErrMsg = lastError instanceof Error ? lastError.message : String(lastError);
					const lastErrStatus = lastError instanceof StatusAwareError
						? lastError.status
						: parseOriginalStatus(lastErrMsg);
					const isLastRetryable = isRetryableStatus(lastErrStatus, lastErrMsg);

					if (isLastRetryable) {
						const triedModels = new Set(modelsToTry);
						// Collect models from other tiers: lower first (cheaper), then higher
						const tierOrder: Array<"high" | "medium" | "low"> = [];
						const currentTierIdx = ROUTER_TIERS.indexOf(decision.tier);
						// Lower tiers first (medium → low after high; low after medium)
						for (let t = currentTierIdx + 1; t < ROUTER_TIERS.length; t++) {
							tierOrder.push(ROUTER_TIERS[t]);
						}
						// Then higher tiers
						for (let t = currentTierIdx - 1; t >= 0; t--) {
							tierOrder.push(ROUTER_TIERS[t]);
						}

						const crossTierModels: string[] = [];
						for (const tier of tierOrder) {
							const tierConfig = effectiveProfile[tier];
							if (tierConfig.model && !triedModels.has(tierConfig.model)) {
								crossTierModels.push(tierConfig.model);
								triedModels.add(tierConfig.model);
							}
							for (const fb of tierConfig.fallbacks ?? []) {
								if (!triedModels.has(fb)) {
									crossTierModels.push(fb);
									triedModels.add(fb);
								}
							}
						}

						// Filter embargoed models
						const viableCrossTier = embargoEnabled
							? crossTierModels.filter((ref) => !state.isEmbargoed(ref))
							: crossTierModels;

						if (viableCrossTier.length > 0) {
							if (state.currentConfig.debug) {
								console.log(
									`[model-router] ⚡ Cross-tier fallback: trying ${viableCrossTier.length} models from other tiers`,
								);
							}

							for (let i = 0; i < viableCrossTier.length; i++) {
								const modelRef = viableCrossTier[i];
								const { provider: targetProvider, modelId: targetModelId } =
									parseCanonicalModelRef(modelRef);

								if (state.currentConfig.debug) {
									console.log(
										`[model-router] Cross-tier attempt ${i + 1}/${viableCrossTier.length}: ${modelRef}`,
									);
								}

								if (targetProvider === "router") continue;

								const targetModel = state.currentModelRegistry!.find(
									targetProvider,
									targetModelId,
								);
								if (!targetModel) {
									if (state.currentConfig.debug) {
										console.log(`  ✗ Skipped: model not in registry`);
									}
									continue;
								}

								const apiKey = await state.currentModelRegistry!.getApiKey(targetModel);
								if (!apiKey) {
									if (state.currentConfig.debug) {
										console.log(`  ✗ Skipped: no API key`);
									}
									continue;
								}

								try {
									const targetLimit = targetModel.contextWindow || 128_000;
									const crossTierContext =
										targetLimit < (model.contextWindow ?? Infinity)
											? truncateContext(context, targetLimit)
											: context;

									const thinkingOverride = actions.getThinkingOverride(
										effectiveProfileName,
										decision.tier,
									);
									const effectiveThinking = thinkingOverride ?? decision.thinking;
									const delegatedReasoning: Effort | undefined =
										targetModel.reasoning &&
										effectiveThinking !== ThinkingLevel.Off &&
										effectiveThinking !== ThinkingLevel.Inherit
											? clampThinkingLevelForModel(
													targetModel,
													effectiveThinking as Effort,
											  )
											: undefined;

									const delegatedStream = streamSimple(targetModel, sanitizeToolSchemas(sanitizeContext(crossTierContext)), {
										...options,
										apiKey,
										headers: targetModel.headers,
										...(delegatedReasoning ? { reasoning: delegatedReasoning } : {}),
									});

									const idleTimeoutMs = resolveStreamIdleTimeout(
										state.currentConfig.streamIdleTimeoutMs,
										targetProvider,
									);
									const maxDurationMs = state.currentConfig.maxStreamDurationMs !== undefined
										? state.currentConfig.maxStreamDurationMs
										: DEFAULT_MAX_STREAM_DURATION_MS;
									let eventSource: AsyncIterable<import("@oh-my-pi/pi-ai").AssistantMessageEvent> = idleTimeoutMs > 0
										? withIdleTimeout(delegatedStream, idleTimeoutMs)
										: delegatedStream;
									if (maxDurationMs > 0) {
										eventSource = withMaxDuration(eventSource, maxDurationMs);
									}

									for await (const event of eventSource) {
										if (event.type === "done") {
											const u = event.message.usage;
											const cost = u?.cost?.total ?? 0;
											state.accumulatedCost += cost;
											decision.usage = {
												inputTokens: (decision.usage?.inputTokens ?? 0) + (u?.input ?? 0),
												outputTokens: (decision.usage?.outputTokens ?? 0) + (u?.output ?? 0),
												cacheReadTokens: (decision.usage?.cacheReadTokens ?? 0) + (u?.cacheRead ?? 0),
												cacheWriteTokens: (decision.usage?.cacheWriteTokens ?? 0) + (u?.cacheWrite ?? 0),
												cost: (decision.usage?.cost ?? 0) + cost,
											};
											state.recordModelCost(modelRef, decision.tier, {
												inputTokens: u?.input ?? 0,
												outputTokens: u?.output ?? 0,
												cacheReadTokens: u?.cacheRead ?? 0,
												cacheWriteTokens: u?.cacheWrite ?? 0,
												cost,
											});
										}
										if (event.type === "error") {
											const errEvent = event as { error?: { errorMessage?: string; errorStatus?: number } };
											const errMsg = errEvent.error?.errorMessage || "Model failed.";
											const errStatus = errEvent.error?.errorStatus;
											throw new StatusAwareError(errMsg, errStatus, parseRetryAfterMs(errMsg));
										}
										stream.push(event);
									}
									if (state.currentConfig.debug) {
										console.log(`  ✓ Success with ${modelRef} (cross-tier fallback)`);
									}
									if (embargoEnabled && state.isEmbargoed(modelRef)) {
										state.liftEmbargo(modelRef);
									}
									decision.isFallback = true;
									decision.targetLabel = modelRef;
									success = true;
									break;
								} catch (err) {
									const errMsg = err instanceof Error ? err.message : String(err);
									if (state.currentConfig.debug) {
										console.log(`  ✗ Cross-tier failed: ${errMsg}`);
									}
									if (embargoEnabled) {
										const errStatus = err instanceof StatusAwareError ? err.status : undefined;
										const errRetryAfter = err instanceof StatusAwareError ? err.retryAfterMs : undefined;
										if (isRetryableStatus(errStatus, errMsg)) {
											const embargoCfg = state.currentConfig.embargo ?? { enabled: true };
											const duration = computeEmbargoDuration(errRetryAfter, embargoCfg);
											const reason = errStatus ? `HTTP ${errStatus}: ${errMsg.slice(0, 100)}` : errMsg.slice(0, 100);
											state.embargoModel(modelRef, errStatus, reason, duration, errRetryAfter);
										}
									}
									lastError = err;
								}
							}
						}
					}
				}

				if (!success) {
					if (state.currentConfig.debug) {
						console.log(
							`[model-router] ❌ All models failed (${modelsToTry.length} primary + cross-tier). Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
						);
					}
					throw lastError || new Error("Failed to delegate to any model in the chain.");
				}


					stream.end();
				} catch (error) {
					state.lastStreamWasInternalError = true;
					stream.push({
						type: "error",
						reason: "error",
						error: createErrorMessage(
							model,
							error instanceof Error ? error.message : String(error),
						),
					});
					stream.end();
				} finally {
					if (sessionCtx) {
						actions.updateStatus(sessionCtx);
					}
					actions.persistState();
				}
			})();

			return stream;
		},
	});

	state.lastRegisteredModels = modelsKey;
};
