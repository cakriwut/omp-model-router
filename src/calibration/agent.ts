import type { Context } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ClassifierPollResult } from "./types";
import type { RouterTier } from "../types";
import { parseCanonicalModelRef, isRouterTier } from "../config";
import { parseClassifierOutput } from "./classifier-utils";
let piSubagentsAvailable = false;
let Agent: any = undefined;
let get_subagent_result: any = undefined;

try {
	const piSubagents = require("pi-subagents");
	Agent = piSubagents.Agent;
	get_subagent_result = piSubagents.get_subagent_result;
	piSubagentsAvailable = true;
} catch {
	// pi-subagents not installed; will fall back to streamSimple
}

/**
 * In-flight classifier state for streamSimple fallback.
 * Entries are deleted from pendingClassifiers once the result is consumed.
 */
interface ClassifierPromise {
	promise: Promise<{ tier: RouterTier; reasoning: string } | undefined>;
	startTime: number;
	result?: { tier: RouterTier; reasoning: string } | undefined;
	error?: string;
}

const pendingClassifiers = new Map<string, ClassifierPromise>();

/**
 * Spawn an async classifier agent (background LLM call).
 * Accepts a pre-built prompt string — callers must NOT pass the full Context
 * object into this function to avoid holding large conversation trees in memory
 * across the async closure lifetime.
 *
 * @param classifierModelRef - Model reference for classifier
 * @param prompt - Pre-built classifier prompt string (primitives only, no Context ref)
 * @param modelRegistry - Model registry for resolution
 * @returns Agent ID or undefined on spawn failure
 */
export async function spawnClassifierAgent(
	classifierModelRef: string | string[],
	prompt: string,
	modelRegistry: ExtensionContext["modelRegistry"],
): Promise<string | undefined> {
	// Normalize to array for consistent handling
	const classifierRefs = Array.isArray(classifierModelRef)
		? classifierModelRef
		: [classifierModelRef];

	// If pi-subagents available, try using first model (no fallback support for subagents)
	if (piSubagentsAvailable && Agent) {
		return await spawnViaSubagent(
			classifierRefs[0],
			prompt,
		);
	}

	// streamSimple path supports full fallback chain
	return await spawnViaStreamSimple(
		classifierModelRef,
		prompt,
		modelRegistry,
	);
}

/**
 * Poll for classifier result (non-blocking)
 * Returns { ready: false } if still running
 * Returns { ready: true, verdict } if done
 * Returns { ready: true, error } if failed
 */
export async function pollClassifierResult(
	agentId: string,
	timeoutMs = 0,
): Promise<ClassifierPollResult> {
	// pi-subagents path
	if (piSubagentsAvailable && get_subagent_result) {
		try {
			const result = await Promise.race([
				get_subagent_result(agentId),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), timeoutMs || 1),
				),
			]);

			if (!result) {
				return { ready: false };
			}

			// Parse result from agent output
			const verdict = parseClassifierOutput(result.content?.[0]?.text);
			if (!verdict) {
				return { ready: true, error: "Failed to parse classifier output" };
			}

			return { ready: true, verdict, latencyMs: result.latencyMs };
		} catch (error) {
			if ((error as Error).message === "timeout") {
				return { ready: false };
			}
			return { ready: true, error: String(error) };
		}
	}

	// streamSimple fallback path
	const pending = pendingClassifiers.get(agentId);
	if (!pending) {
		return { ready: true, error: "Agent not found" };
	}

	// If result is already cached, return and clean up
	if (pending.result !== undefined) {
		pendingClassifiers.delete(agentId);
		return {
			ready: true,
			verdict: pending.result,
			latencyMs: Date.now() - pending.startTime,
		};
	}
	if (pending.error !== undefined) {
		pendingClassifiers.delete(agentId);
		return { ready: true, error: pending.error };
	}

	try {
		// Non-blocking check: race against immediate timeout
		const result = await Promise.race([
			pending.promise,
			new Promise<undefined>((resolve) =>
				setTimeout(() => resolve(undefined), timeoutMs || 1),
			),
		]);

		if (result === undefined) {
			return { ready: false };
		}

		if (!result) {
			pending.error = "Classifier returned undefined";
			pendingClassifiers.delete(agentId);
			return { ready: true, error: pending.error };
		}

		pendingClassifiers.delete(agentId);
		return {
			ready: true,
			verdict: result,
			latencyMs: Date.now() - pending.startTime,
		};
	} catch (error) {
		pendingClassifiers.delete(agentId);
		return { ready: true, error: String(error) };
	}
}

/**
 * Abandon a pending classifier (cleanup)
 */
export function abandonClassifier(agentId: string): void {
	pendingClassifiers.delete(agentId);
	// pi-subagents agents continue in background; no explicit cancellation needed
}

// ─── Internal implementation ──────────────────────────────────────────────────

async function spawnViaSubagent(
	classifierModelRef: string,
	prompt: string,
): Promise<string | undefined> {
	try {
		const shortName = classifierModelRef.split('/').pop()?.split('.').pop()?.replace(/-v\d+:\d+$/, '') || classifierModelRef;
		console.log(`⚡ classifier → ${shortName} (async·telemetry)`);

		const result = await Agent({
			subagent_type: "quick_task",
			prompt,
			description: "Routing classification",
			run_in_background: true,
			model: classifierModelRef,
			thinking: "low",
			isolated: true,
		});

		return result.details?.agentId;
	} catch (error) {
		console.warn(`[model-router] Failed to spawn pi-subagent: ${error}`);
		return undefined;
	}
}

async function spawnViaStreamSimple(
	classifierModelRefsInput: string | string[],
	prompt: string,
	modelRegistry: ExtensionContext["modelRegistry"],
	debug = false,
): Promise<string | undefined> {
	// Normalize to array (backward compat: single string → array)
	const classifierModelRefs = Array.isArray(classifierModelRefsInput)
		? classifierModelRefsInput
		: [classifierModelRefsInput];

	if (debug) {
		console.log(
			`[model-router] Classifier fallback chain: ${classifierModelRefs.length} model(s)`,
		);
	}

	let lastError: Error | undefined;

	for (let i = 0; i < classifierModelRefs.length; i++) {
		const classifierModelRef = classifierModelRefs[i];

		if (debug) {
			console.log(
				`[model-router] Classifier attempt ${i + 1}/${classifierModelRefs.length}: ${classifierModelRef}`,
			);
		}

		try {
			const { provider, modelId } = parseCanonicalModelRef(classifierModelRef);
			const model = modelRegistry.find(provider, modelId);
			if (!model) {
				if (debug) {
					console.log(`  ✗ Skipped: model not in registry`);
				}
				lastError = new Error(`model ${classifierModelRef} not in registry`);
				continue;
			}

			const apiKey = await modelRegistry.getApiKey(model);
			if (!apiKey) {
				if (debug) {
					console.log(`  ✗ Skipped: no API key for ${provider}`);
				}
				lastError = new Error(`no API key for ${provider}`);
				continue;
			}

			const classifierContext: Context = {
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			};

			const agentId = `classifier-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
			const shortName =
				classifierModelRef.split("/").pop()?.split(".").pop()?.replace(/-v\d+:\d+$/, "") ||
				classifierModelRef;

			if (debug) {
				console.log(`  ✓ Success: spawning ${shortName} (async·telemetry)`);
			} else {
				console.log(`⚡ classifier → ${shortName} (async·telemetry)`);
			}

			const promise = runClassifierStream(model, classifierContext, apiKey, model.headers);

			pendingClassifiers.set(agentId, {
				promise,
				startTime: Date.now(),
			});

			return agentId;
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			if (debug) {
				console.log(`  ✗ Failed: ${errMsg}`);
			}
			lastError = error instanceof Error ? error : new Error(errMsg);
		}
	}

	// All classifiers failed
	if (debug) {
		console.log(
			`[model-router] ❌ All ${classifierModelRefs.length} classifier models failed. Last error: ${lastError?.message}`,
		);
	}
	console.warn(
		`[model-router] Failed to spawn streamSimple classifier after ${classifierModelRefs.length} attempts. Last error: ${lastError}`,
	);
	throw lastError || new Error("Failed to spawn any classifier from fallback chain");
}

async function runClassifierStream(
	model: any,
	context: Context,
	apiKey: string,
	headers?: Record<string, string>,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> {
	const INNER_TIMEOUT_MS = 30_000;
	const ac = new AbortController();
	const timeout = setTimeout(() => ac.abort(), INNER_TIMEOUT_MS);

	try {
		const stream = streamSimple(model, context, { apiKey, headers, signal: ac.signal });
		let fullText = "";

		for await (const event of stream) {
			if (
				event.type === "text_delta" &&
				typeof (event as { delta?: unknown }).delta === "string"
			) {
				fullText += (event as { delta: string }).delta;
			}
		}

		return parseClassifierOutput(fullText);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}
