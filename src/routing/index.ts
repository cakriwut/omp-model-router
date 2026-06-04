/**
 * Routing orchestration — classifier logic + barrel re-exports.
 */

import { type Context, streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseCanonicalModelRef } from "../config";
import { buildClassifierPrompt, parseClassifierOutput } from "../calibration/classifier-utils";
import type { RouterTier, RouterPhase } from "../types";

// ─── LLM classifier ───────────────────────────────────────────────────────────

/** Timeout for the synchronous classifier LLM call (prevents indefinite blocking) */
const SYNC_CLASSIFIER_TIMEOUT_MS = 10_000;
/** Max chars to buffer from classifier stream — classifier output is always < 200 chars */
const SYNC_CLASSIFIER_MAX_BUFFER = 512;

export const runClassifier = async (
	classifierModelRefsInput: string | string[],
	modelRegistry: ExtensionContext["modelRegistry"],
	context: Context,
	currentPhase?: RouterPhase,
	debug = false,
	toolCounts?: Record<string, number>,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
	// Normalize to array (backward compat: single string → array)
	const classifierModelRefs = Array.isArray(classifierModelRefsInput)
		? classifierModelRefsInput
		: [classifierModelRefsInput];

	if (debug && classifierModelRefs.length > 1) {
		console.log(
			`[model-router] Sync classifier fallback chain: ${classifierModelRefs.length} model(s)`,
		);
	}

	const classifierContext: Context = {
		messages: [
			{ role: "user", content: buildClassifierPrompt(context, currentPhase, toolCounts), timestamp: Date.now() },
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
			const shortName = modelId.split('.').pop()?.replace(/-v\d+:\d+$/, '') || modelId;
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
				for await (const event of stream) {
					if (
						event.type === "text_delta" &&
						typeof (event as { delta?: unknown }).delta === "string"
					) {
						const remaining = SYNC_CLASSIFIER_MAX_BUFFER - fullText.length;
						if (remaining <= 0) { ac.abort(); break; }
						// Slice delta to never exceed MAX_BUFFER regardless of chunk size
						fullText += (event as { delta: string }).delta.slice(0, remaining);
						if (fullText.length >= SYNC_CLASSIFIER_MAX_BUFFER) {
							ac.abort();
							break;
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
					return result;
				}
				// Parsing failed, try next model
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
