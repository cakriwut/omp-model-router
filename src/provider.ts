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
import {
	resolveCompressionConfig,
	compressHistory,
	estimateContextTokens,
	canCompressForModel,
	shouldCompress,
	DEFAULT_CONTEXT_THRESHOLD,
	DEFAULT_TIME_THRESHOLD_SECONDS,
} from "./context-compression";
import { spawnClassifierForTurn } from "./calibration/hooks";


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
					// When calibration is in adaptive mode, use calibration.classifierModel for routing
					const effectiveClassifierModel =
						state.currentConfig.calibration?.enabled &&
						state.currentConfig.calibration?.mode === "adaptive" &&
						state.currentConfig.calibration?.classifierModel
							? state.currentConfig.calibration.classifierModel
							: state.currentConfig.classifierModel;

					const decision = await resolveRouting(
						{
							context,
							previousDecision: state.lastDecision,
							pinnedTier: state.pinnedTierByProfile[model.id],
							isBudgetExceeded,
							modelRegistry: state.currentModelRegistry,
							lastExtensionContext: state.lastExtensionContext,
							calibration: state.calibration,
						},
						{
							profileName: model.id,
							profile,
							thinkingOverrides: state.thinkingByProfile[model.id],
							phaseBias: state.currentConfig.phaseBias ?? 0.5,
							rules: state.currentConfig.rules,
							classifierModel: effectiveClassifierModel,
							debug: state.currentConfig.debug,
							calibrationConfig: state.currentConfig.calibration,
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

					// Track routing decision (tier counter)
					state.recordRoutingDecision(decision.tier);

					// Spawn async classifier for calibration telemetry (fire-and-forget)
					spawnClassifierForTurn(state, state.currentConfig, decision.tier, context);

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
						
						if (compressionCfg && canCompressForModel(compressionCfg, targetProvider, targetModelId)) {
							// Progressive TOON mode: compress on triggers only
							if (compressionCfg.progressive?.enabled) {
								const contextThreshold =
									compressionCfg.progressive.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD;
								const timeThresholdSeconds =
									compressionCfg.progressive.timeThreshold ?? DEFAULT_TIME_THRESHOLD_SECONDS;

								const contextTokens = estimateContextTokens(effectiveContext);
								const triggerReason = shouldCompress({
									context: effectiveContext,
									config: compressionCfg,
									contextWindow: targetLimit,
									targetProvider,
									targetModelId,
									lastTurnTimestamp: state.lastTurnTimestamp,
									now,
								});
								
								
								if (state.currentConfig.debug && triggerReason) {
									const compressionDebugData = {
										reason: triggerReason,
										contextTokens,
										threshold: Math.floor(contextThreshold * targetLimit),
										timeSinceLastTurn: state.lastTurnTimestamp
											? Math.floor((now - state.lastTurnTimestamp) / 1000)
											: 'N/A',
										timeThreshold: timeThresholdSeconds,
										turnNumber,
										messageCount: effectiveContext.messages.length,
									};
									
									// Always log to console for real-time visibility
									console.log('[ROUTER] Compression triggered:', compressionDebugData);
									
									// Only persist to session JSONL if debugVerbose is enabled
									if (state.currentConfig.debugVerbose) {
										ctx.sessionManager.appendCustomEntry('router:compression-trigger', compressionDebugData);
									}
								}
								
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
								// No trigger: reuse frozen checkpoint if available, but check expiry
								if (state.currentCheckpoint) {
									const checkpointAge = turnNumber - state.currentCheckpoint.metadata.turn;
									const currentContextTokens = estimateContextTokens(effectiveContext);
									const checkpointAgeLimit = compressionCfg.progressive.maxCheckpointAge ?? 50;
									const checkpointSizeLimit = compressionCfg.progressive.maxCheckpointSize ?? 200_000;
									
									// Force refresh if checkpoint is stale or context is too large
									const isStale = checkpointAge > checkpointAgeLimit;
									const isOversized = currentContextTokens > checkpointSizeLimit;
									
									if (isStale || isOversized) {
										// Invalidate checkpoint and force fresh compression
										if (state.currentConfig.debug) {
											console.log('[ROUTER] Checkpoint expired:', {
												reason: isStale ? 'age' : 'size',
												age: checkpointAge,
												ageLimit: checkpointAgeLimit,
												contextTokens: currentContextTokens,
												sizeLimit: checkpointSizeLimit,
											});
										}
										
										state.currentCheckpoint = undefined;
										
										// Force compression with "checkpoint_expired" reason
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
											decision.compressionTriggerReason = isStale ? "cache_expiry" : "context_size";
											
											state.compressionTotalOriginalChars += result.stats.originalChars;
											state.compressionTotalCompressedChars += result.stats.compressedChars;
											state.compressionRequestCount++;
											
											state.accumulatedOriginalTokens += originalTokens;
											state.accumulatedCompressedTokens += compressedTokens;
											state.accumulatedTokensSaved += tokensSaved;
											
											// Create new checkpoint
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
														triggerReason: isStale ? "cache_expiry" : "context_size",
														timestamp: now,
													},
												};
											}
										}
									} else {
										// Checkpoint still valid, reuse it
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
									throw new Error(
										(event as { error?: { errorMessage?: string } }).error
											?.errorMessage || "Model failed.",
									);
								}
							stream.push(event);
						}
						if (state.currentConfig.debug) {
							console.log(`  ✓ Success with ${modelRef}`);
						}
						success = true;
						if (i > 0) decision.isFallback = true;
						break;
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						if (state.currentConfig.debug) {
							console.log(`  ✗ Failed: ${errMsg}`);
						}
						lastError = err;
					}
				}

				if (!success) {
					if (state.currentConfig.debug) {
						console.log(
							`[model-router] ❌ All ${modelsToTry.length} models failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
						);
					}
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
