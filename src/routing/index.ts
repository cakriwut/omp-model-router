/**
 * Routing orchestration — classifier logic + barrel re-exports.
 */

import { type Context, type AssistantMessageEvent, streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseCanonicalModelRef } from "../config";
import { shortenModelRef } from "../ui/theme.js";
import { buildClassifierPrompt, parseClassifierOutput } from "../calibration/classifier-utils";
import type { RouterTier, RouterPhase } from "../types";

// ─── LLM classifier ───────────────────────────────────────────────────────────

/** Timeout for the synchronous classifier LLM call (prevents indefinite blocking) */
const SYNC_CLASSIFIER_TIMEOUT_MS = 10_000;
/** Max chars to buffer from classifier stream — classifier output is always < 200 chars */
const SYNC_CLASSIFIER_MAX_BUFFER = 512;

/**
 * Resolve the context window of the first classifier model in the chain
 * that exists in the registry. Used to compute prompt budgets before
 * the API-key-gated fallback loop runs.
 * Falls back to 128_000 if none are found.
 */
export function resolveClassifierContextWindow(
	classifierModelRefsInput: string | string[],
	modelRegistry: ExtensionContext["modelRegistry"],
): number {
	const refs = Array.isArray(classifierModelRefsInput)
		? classifierModelRefsInput
		: [classifierModelRefsInput];
	for (const ref of refs) {
		try {
			const { provider, modelId } = parseCanonicalModelRef(ref);
			const model = modelRegistry.find(provider, modelId);
			if (model?.contextWindow) return model.contextWindow;
		} catch {
			// skip
		}
	}
	return 128_000;
}

export const runClassifier = async (
	classifierModelRefsInput: string | string[],
	modelRegistry: ExtensionContext["modelRegistry"],
	context: Context,
	currentPhase?: RouterPhase,
	debug = false,
	toolCounts?: Record<string, number>,
	pitfalls?: string,
	contextWindow?: number,
): Promise<{ tier: RouterTier; reasoning: string; classifierModelRef: string; classifierUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number } } | undefined> => {
	const classifierModelRefs = Array.isArray(classifierModelRefsInput)
		? classifierModelRefsInput
		: [classifierModelRefsInput];

	if (debug && classifierModelRefs.length > 1) {
		console.log(
			`[model-router] Sync classifier fallback chain: ${classifierModelRefs.length} model(s)`,
		);
	}

	const resolvedContextWindow = contextWindow
		?? resolveClassifierContextWindow(classifierModelRefs, modelRegistry);

	const classifierContext: Context = {
		messages: [
			{
				role: "user",
				content: buildClassifierPrompt(context, currentPhase, toolCounts, pitfalls, resolvedContextWindow),
				timestamp: Date.now(),
			},
		],
	};

	let lastError: Error | undefined;

	// Try each classifier in sequence until one succeeds
	for (let i = 0; i < classifierModelRefs.length; i++) {
		const classifierModelRef = classifierModelRefs[i];

		if (debug && classifierModelRefs.length > 1) {
			console.log(
				`[model-router] Sync classifier attempt ${i + 1}/${classifierModelRefs.length}: ${classifierModelRef}`,
			);
		}

		try {
			const { provider, modelId } = parseCanonicalModelRef(classifierModelRef);
			const model = modelRegistry.find(provider, modelId);
			if (!model) {
				if (debug) {
					console.warn(`[model-router] Classifier model not found: ${provider}/${modelId}`);
				}
				lastError = new Error(`Classifier model not found: ${provider}/${modelId}`);
				continue; // Try next model
			}

			const apiKey = await modelRegistry.getApiKey(model);
			if (!apiKey) {
				if (debug) {
					console.warn(`[model-router] Classifier model API key missing: ${provider}/${modelId}`);
				}
				lastError = new Error(`Classifier API key missing: ${provider}/${modelId}`);
				continue; // Try next model
			}
			const headers = model.headers;
			// Badge-style log: ⚡ classifier → nova-micro (sync·adaptive)
			const shortName = shortenModelRef(classifierModelRef);
			if (debug) {
				console.log(`⚡ classifier → ${shortName} (sync·adaptive)`);
			}

			// Race classifier stream against a hard timeout to prevent blocking
			const ac = new AbortController();
			const timeout = setTimeout(() => ac.abort(), SYNC_CLASSIFIER_TIMEOUT_MS);

			try {
				const stream = streamSimple(model, classifierContext, {
					apiKey,
					headers,
					signal: ac.signal,
					maxTokens: 200,
				});
				let fullText = "";
				let classifierUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
				for await (const rawEvent of stream) {
					const event = rawEvent as AssistantMessageEvent;
					if (event.type === "text_delta") {
						const remaining = SYNC_CLASSIFIER_MAX_BUFFER - fullText.length;
						if (remaining <= 0) { ac.abort(); break; }
						// Slice delta to never exceed MAX_BUFFER regardless of chunk size
						fullText += event.delta.slice(0, remaining);
						if (fullText.length >= SYNC_CLASSIFIER_MAX_BUFFER) {
							ac.abort();
							break;
						}
					} else if (event.type === "done") {
						const u = event.message.usage;
						if (u) {
							classifierUsage = {
								inputTokens: u.input ?? 0,
								outputTokens: u.output ?? 0,
								cacheReadTokens: u.cacheRead ?? 0,
								cacheWriteTokens: u.cacheWrite ?? 0,
								cost: u.cost?.total ?? 0,
							};
						}
					}
				}

				const result = parseClassifierOutput(fullText);

				// Log decision: ⚡ classifier → nova-micro (sync·adaptive) → high
				if (debug && result) {
					console.log(`⚡ classifier → ${shortName} (sync·adaptive) → ${result.tier}`);
				}

				if (result) {
					// Success! Return immediately
					return { ...result, classifierModelRef, classifierUsage };
				}
				// Parsing failed — log raw output for diagnostics, then try next model
				if (debug) {
					console.warn(`[model-router] Classifier parse failed for ${classifierModelRef}. Raw output: ${JSON.stringify(fullText.slice(0, 300))}`);
				}
				lastError = new Error(`Classifier output parsing failed for ${classifierModelRef}`);
				continue;
			} finally {
				clearTimeout(timeout);
			}
		} catch (error) {
			if (debug) {
				console.warn(
					`[model-router] Classifier failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			lastError = error instanceof Error ? error : new Error(String(error));
			// Continue to next classifier
		}
	}

	// All classifiers failed
	if (debug) {
		console.warn(
			`[model-router] ❌ All ${classifierModelRefs.length} sync classifier models failed. Falling back to heuristic.`,
		);
	}
	return undefined; // Fall back to heuristic
};

// ─── Re-exports ───────────────────────────────────────────────────────────────

export * from "./text";
export * from "./heuristic";
export * from "./compose";
