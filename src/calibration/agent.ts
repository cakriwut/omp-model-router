import type { Context } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ClassifierPollResult } from "./types";
import type { RouterPhase, RouterTier } from "../types";
import { parseCanonicalModelRef, isRouterTier } from "../config";
import { getLastUserText, buildClassifierPrompt, parseClassifierOutput } from "./classifier-utils";
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
 * Spawn an async classifier agent (background LLM call)
 * Returns agent ID (pi-subagents) or synthetic ID (streamSimple fallback)
 *
 * @param classifierModelRef - Model reference for classifier (e.g. anthropic/claude-3-haiku-20240307)
 * @param context - Current conversation context
 * @param currentPhase - Current router phase (for prompt biasing)
 * @param modelRegistry - Model registry for resolution
 * @returns Agent ID or undefined on spawn failure
 */
export async function spawnClassifierAgent(
	classifierModelRef: string,
	context: Context,
	currentPhase: RouterPhase | undefined,
	modelRegistry: ExtensionContext["modelRegistry"],
): Promise<string | undefined> {
	if (piSubagentsAvailable && Agent) {
		return await spawnViaSubagent(
			classifierModelRef,
			context,
			currentPhase,
		);
	}

	return await spawnViaStreamSimple(
		classifierModelRef,
		context,
		currentPhase,
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
	context: Context,
	currentPhase: RouterPhase | undefined,
): Promise<string | undefined> {
	try {
		const shortName = classifierModelRef.split('/').pop()?.split('.').pop()?.replace(/-v\d+:\d+$/, '') || classifierModelRef;
		console.log(`⚡ classifier → ${shortName} (async·telemetry)`);
		
 		const prompt = buildClassifierPrompt(context, currentPhase);

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
	classifierModelRef: string,
	context: Context,
	currentPhase: RouterPhase | undefined,
	modelRegistry: ExtensionContext["modelRegistry"],
): Promise<string | undefined> {
	try {
		const { provider, modelId } = parseCanonicalModelRef(classifierModelRef);
		const model = modelRegistry.find(provider, modelId);
		if (!model) {
			throw new Error(`model ${classifierModelRef} not in registry`);
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new Error(`no API key for ${provider}`);
		}

		const prompt = buildClassifierPrompt(context, currentPhase);
		const classifierContext: Context = {
			...context,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		};

		const agentId = `classifier-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const shortName = classifierModelRef.split('/').pop()?.split('.').pop()?.replace(/-v\d+:\d+$/, '') || classifierModelRef;
		console.log(`⚡ classifier → ${shortName} (async·telemetry)`);
 		const promise = runClassifierStream(model, classifierContext, apiKey, model.headers);

		pendingClassifiers.set(agentId, {
			promise,
			startTime: Date.now(),
		});

		return agentId;
	} catch (error) {
		console.warn(
			`[model-router] Failed to spawn streamSimple classifier: ${error}`,
		);
		throw error;
	}
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
