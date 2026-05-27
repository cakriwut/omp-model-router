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

							const delegatedStream = streamSimple(targetModel, effectiveContext, {
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
