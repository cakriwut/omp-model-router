import {
	streamSimple,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { RoutingDecision } from "./types";
import { profileNames, parseCanonicalModelRef, ROUTER_TIERS } from "./config";
import {
	resolveRouting,
	extractTextFromContent,
	hasImageAttachment,
} from "./routing";
import type { RouterState } from "./state";
import { resolveCompressionConfig, compressHistory, isModelExcludedFromCompression } from "./context-compression";

/**
 * Estimate tokens consumed by a context (rough heuristic: ~1 token per 4 characters).
 * This is a conservative approximation used for tracking compression savings.
 */
function estimateContextTokens(context: Context): number {
	const jsonStr = JSON.stringify(context.messages);
	// Rough heuristic: ~1 token per 4 characters (varies by model/encoding)
	return Math.ceil(jsonStr.length / 4);
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
	let modified = false;
	const messages = context.messages.map((msg) => {
		if (!Array.isArray(msg.content)) return msg;
		let contentModified = false;
		const content = msg.content.map((block: any) => {
			if (block.type === "toolCall" && block.name && !VALID_TOOL_NAME_RE.test(block.name)) {
				contentModified = true;
				return { ...block, name: sanitizeToolName(block.name) };
			}
			return block;
		});
		if (contentModified) {
			modified = true;
			return { ...msg, content };
		}
		return msg;
	});
	return modified ? { ...context, messages } : context;
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

/**
 * Determine if progressive TOON compression should trigger.
 * Returns trigger reason or null if no trigger.
 *
 * Triggers:
 * 1. Context size >= contextThreshold * contextWindow
 * 2. Time since last turn >= timeThreshold (cache expiry)
 */
const shouldTriggerCompression = (
	context: Context,
	contextWindow: number,
	contextThreshold: number,
	lastTurnTimestamp: number | undefined,
	timeThreshold: number,
): "context_size" | "cache_expiry" | null => {
	const now = Date.now();

	// Trigger 1: Context size approaching window limit
	const contextTokens = estimateContextTokens(context);
	if (contextTokens >= contextThreshold * contextWindow) {
		return "context_size";
	}

	// Trigger 2: Cache expiry (time gap detection)
	if (lastTurnTimestamp !== undefined) {
		const timeSinceLastTurn = (now - lastTurnTimestamp) / 1000; // seconds
		if (timeSinceLastTurn >= timeThreshold) {
			return "cache_expiry";
		}
	}

	return null;
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
				try {
					if (!state.currentModelRegistry) {
						throw new Error(
							"Router provider not initialized yet. Wait for session_start and retry.",
						);
					}
					const profile = state.currentConfig.profiles[model.id];
					if (!profile) {
						throw new Error(`Unknown router profile: ${model.id}`);
					}

					state.selectedProfile = model.id;
					state.routerEnabled = true;

					const isBudgetExceeded =
						state.currentConfig.maxSessionBudget !== undefined &&
						state.accumulatedCost >= state.currentConfig.maxSessionBudget;

					// ── Resolve routing decision (heuristic + overrides) ──────────────
					const decision = await resolveRouting(
						{
							context,
							previousDecision: state.lastDecision,
							pinnedTier: state.pinnedTierByProfile[model.id],
							isBudgetExceeded,
							modelRegistry: state.currentModelRegistry,
							lastExtensionContext: state.lastExtensionContext,
						},
						{
							profileName: model.id,
							profile,
							thinkingOverrides: state.thinkingByProfile[model.id],
							phaseBias: state.currentConfig.phaseBias ?? 0.5,
							rules: state.currentConfig.rules,
							largeContextThreshold:
								state.currentConfig.largeContextThreshold,
							classifierModel: state.currentConfig.classifierModel,
						},
					);
					// ── Auto-upgrade override (one-shot) ──────────────────────────────
					if (state.autoUpgradeTier) {
						const upgradeTier = state.autoUpgradeTier;
						state.autoUpgradeTier = undefined;
						const tierConfig = profile[upgradeTier];
						const { provider: upProvider, modelId: upModelId } =
							parseCanonicalModelRef(tierConfig.model);
						decision.tier = upgradeTier;
						decision.targetProvider = upProvider;
						decision.targetModelId = upModelId;
						decision.targetLabel = tierConfig.model;
						decision.thinking = tierConfig.thinking ?? decision.thinking;
						decision.reasoning = `auto-upgrade: consecutive tool failures → ${upgradeTier}`;
					}


					state.lastDecision = decision;
					actions.recordDebugDecision(decision);

					if (state.lastExtensionContext) {
						actions.updateStatus(state.lastExtensionContext);
					}

					// ── Build fallback model chain ────────────────────────────────────
					const imageAttached = hasImageAttachment(context);
					let modelsToTry = [
						decision.targetLabel,
						...(profile[decision.tier].fallbacks ?? []),
					];
					if (imageAttached) {
						const filtered = modelsToTry.filter((ref) =>
							modelSupportsImage(ref, state.currentModelRegistry!),
						);
						modelsToTry = filtered.length > 0 ? filtered : [decision.targetLabel];
					}

					// ── Delegate to target model ──────────────────────────────────────
					let lastError: unknown;
					let success = false;

					for (let i = 0; i < modelsToTry.length; i++) {
						const modelRef = modelsToTry[i];
						const { provider: targetProvider, modelId: targetModelId } =
							parseCanonicalModelRef(modelRef);

						if (targetProvider === "router") continue;

						const targetModel = state.currentModelRegistry.find(
							targetProvider,
							targetModelId,
						);
						if (!targetModel) {
							lastError = new Error(
								`Routed model not found: ${targetProvider}/${targetModelId}`,
							);
							continue;
						}

						const apiKey = await state.currentModelRegistry.getApiKey(
							targetModel,
						);
						if (!apiKey) {
							lastError = new Error(
								`No API key for routed model: ${targetProvider}/${targetModelId}`,
							);
							continue;
						}

						try {
							// Auto-truncation if picked model has smaller context window
							const targetLimit = targetModel.contextWindow || 128_000;
							const effectiveContext =
								targetLimit < (model.contextWindow ?? Infinity)
									? truncateContext(context, targetLimit)
									: context;

						// ── History compression (TOON) ───────────────────────────────
						const compressionCfg = resolveCompressionConfig(
							state.currentConfig.historyCompression,
							state.currentConfig.profiles[model.id]?.historyCompression,
						);
						let finalContext = effectiveContext;
						const turnNumber = effectiveContext.messages.length;
						const now = Date.now();
						
						if (compressionCfg?.enabled && !isModelExcludedFromCompression(compressionCfg, targetProvider, targetModelId)) {
							// Progressive TOON mode: compress on triggers only
							if (compressionCfg.progressive?.enabled) {
								const contextThreshold = compressionCfg.progressive.contextThreshold ?? 0.8;
								const timeThresholdSeconds = compressionCfg.progressive.timeThreshold ?? 300;
								
								const triggerReason = shouldTriggerCompression(
									effectiveContext,
									targetLimit,
									contextThreshold,
									state.lastTurnTimestamp,
									timeThresholdSeconds,
								);
								
								if (triggerReason) {
									// Trigger fired: create new checkpoint
									const originalTokens = estimateContextTokens(effectiveContext);
									const result = compressHistory(effectiveContext, compressionCfg, turnNumber);
									finalContext = result.context;
									
									if (result.stats) {
										const compressedTokens = estimateContextTokens(finalContext);
										const tokensSaved = Math.max(0, originalTokens - compressedTokens);
										
										result.stats.estimatedOriginalTokens = originalTokens;
										result.stats.estimatedCompressedTokens = compressedTokens;
										result.stats.estimatedTokensSaved = tokensSaved;
										
										decision.compression = result.stats;
										decision.compressionTriggerReason = triggerReason;
										
										state.compressionTotalOriginalChars += result.stats.originalChars;
										state.compressionTotalCompressedChars += result.stats.compressedChars;
										state.compressionRequestCount++;
										
										state.accumulatedOriginalTokens += originalTokens;
										state.accumulatedCompressedTokens += compressedTokens;
										state.accumulatedTokensSaved += tokensSaved;
										
										// Create checkpoint for reuse
									const toonBlockContent = result.context.messages
										.find((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("TOON"))
										?.content as string | undefined;
										
										if (toonBlockContent) {
											state.currentCheckpoint = {
												frozenBlock: toonBlockContent,
												metadata: {
													turn: turnNumber,
													range: [0, toonBlockContent.length],
													stats: result.stats,
													triggerReason,
													timestamp: now,
												},
											};
										}
									}
								} else {
									// No trigger: reuse frozen checkpoint if available
									if (state.currentCheckpoint) {
										const keepLastN = compressionCfg.keepLastN ?? 4;
										const recentMessages = effectiveContext.messages.slice(-keepLastN);
										finalContext = {
											...effectiveContext,
									messages: [
										{
											role: "user",
											content: state.currentCheckpoint.frozenBlock,
											timestamp: state.currentCheckpoint.metadata.timestamp,
										},
										...recentMessages,
									],
								};
										decision.compressionCacheHit = true;
									}
								}
							} else {
								// Static/dynamic TOON mode (backward compatible)
								const shouldFreeze = compressionCfg.freezeAfter !== undefined && turnNumber === compressionCfg.freezeAfter;
								const shouldReuseFrozen = compressionCfg.freezeAfter !== undefined && turnNumber > compressionCfg.freezeAfter && state.frozenCompressionBlock;
								
								if (shouldReuseFrozen && state.frozenCompressionBlock) {
									// Prepend cached frozen TOON block
									finalContext = {
										...effectiveContext,
										messages: [...state.frozenCompressionBlock.messages, ...effectiveContext.messages.slice(-(compressionCfg.keepLastN ?? 4) * 2)]
									};
								} else if (!shouldReuseFrozen) {
									// Estimate tokens before compression
									const originalTokens = estimateContextTokens(effectiveContext);
									
									// Apply compression with current turn number
									const result = compressHistory(effectiveContext, compressionCfg, turnNumber);
									finalContext = result.context;
									
									if (result.stats) {
										// Estimate tokens after compression
										const compressedTokens = estimateContextTokens(finalContext);
										const tokensSaved = Math.max(0, originalTokens - compressedTokens);
										
										// Populate compression stats with token data
										result.stats.estimatedOriginalTokens = originalTokens;
										result.stats.estimatedCompressedTokens = compressedTokens;
										result.stats.estimatedTokensSaved = tokensSaved;
										
										decision.compression = result.stats;
										state.compressionTotalOriginalChars += result.stats.originalChars;
										state.compressionTotalCompressedChars += result.stats.compressedChars;
										state.compressionRequestCount++;
										
										// Accumulate token metrics
										state.accumulatedOriginalTokens += originalTokens;
										state.accumulatedCompressedTokens += compressedTokens;
										state.accumulatedTokensSaved += tokensSaved;
										
										// If at freeze point, cache the compressed block for reuse
										if (shouldFreeze) {
											state.frozenCompressionBlock = {
												messages: result.context.messages.slice(0, -( compressionCfg.keepLastN ?? 4)),
												stats: result.stats
											};
										}
									}
								}
							}
						}
						
						// Update last turn timestamp for cache expiry detection
						state.lastTurnTimestamp = now;

							const thinkingOverride = actions.getThinkingOverride(
								model.id,
								decision.tier,
							);
							const delegatedReasoning =
								targetModel.reasoning &&
								(thinkingOverride ?? decision.thinking) !== "off"
									? (thinkingOverride ?? decision.thinking)
									: undefined;

							if (state.lastExtensionContext) {
								if (delegatedReasoning) {
									state.lastExtensionContext.ui.setHiddenThinkingLabel?.(
										`Thinking (${targetProvider}/${targetModelId})...`,
									);
								} else {
									state.lastExtensionContext.ui.setHiddenThinkingLabel?.();
								}
							}

							const delegatedStream = streamSimple(targetModel, sanitizeContext(finalContext), {
								...options,
								apiKey,
								headers: targetModel.headers,
								...(delegatedReasoning ? { reasoning: delegatedReasoning } : {}),
							});

							for await (const event of delegatedStream) {
								if (event.type === "done") {
									const u = event.message.usage;
									const cost = u?.cost?.total ?? 0;
									state.accumulatedCost += cost;
									state.accumulatedCacheReadTokens += u?.cacheRead ?? 0;
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
								}
								if (event.type === "error") {
									throw new Error(
										(event as { error?: { errorMessage?: string } }).error
											?.errorMessage || "Model failed.",
									);
								}
								stream.push(event);
							}
							success = true;
							if (i > 0) decision.isFallback = true;
							break;
						} catch (err) {
							lastError = err;
						}
					}

					if (!success) {
						throw lastError || new Error("Failed to delegate to any model in the chain.");
					}

					stream.end();
				} catch (error) {
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
					if (state.lastExtensionContext) {
						actions.updateStatus(state.lastExtensionContext);
					}
					actions.persistState();
				}
			})();

			return stream;
		},
	});

	state.lastRegisteredModels = modelsKey;
};
