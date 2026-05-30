import type { Context } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ClassifierPollResult } from "./types";
import type { RouterPhase, RouterTier } from "../types";
import { parseCanonicalModelRef, isRouterTier } from "../config";
import { getLastUserText, getRecentConversationText } from "../routing";

// Try to import pi-subagents, but don't crash if unavailable
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
 * In-flight classifier state for streamSimple fallback
 */
interface ClassifierPromise {
	promise: Promise<{ tier: RouterTier; reasoning: string } | undefined>;
	startTime: number;
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
			pendingClassifiers.delete(agentId);
			return { ready: true, error: "Classifier returned undefined" };
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

		// Detached promise: don't await, store for polling
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
	try {
		const stream = streamSimple(model, context, { apiKey, headers });
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
	}
}

function buildClassifierPrompt(
	context: Context,
	currentPhase?: RouterPhase,
): string {
	const promptText = getLastUserText(context);
	const historyText = getRecentConversationText(context, 4);

	return `You are a model router classifier. Your job is to categorize the user's latest request into one of three tiers: "high", "medium", or "low".

Tiers:
- high: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.
- medium: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.
- low: Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.

${currentPhase ? `Current conversation phase: ${currentPhase}\n` : ""}Recent history:
${historyText}

Latest user message:
${promptText}

Return your decision in exactly two lines:
Tier: [high|medium|low]
Reasoning: [one short sentence]

${currentPhase === "planning" ? "Consider that the conversation is currently in a planning phase. Bias toward \"high\" unless the request is clearly a simple implementation or summary." : ""}
${currentPhase === "implementation" ? "Consider that the conversation is currently in an implementation phase. Bias toward \"medium\" unless the request is clearly planning or a simple summary." : ""}`;
}

function parseClassifierOutput(
	text: string,
): { tier: RouterTier; reasoning: string } | undefined {
	const lines = text.trim().split("\n");
	const tierLine = lines.find((l) => l.toLowerCase().startsWith("tier:"));
	const reasoningLine = lines.find((l) =>
		l.toLowerCase().startsWith("reasoning:"),
	);

	if (!tierLine) return undefined;

	const tierValue = tierLine.split(":")[1].trim().toLowerCase();
	if (!isRouterTier(tierValue)) return undefined;

	return {
		tier: tierValue,
		reasoning: reasoningLine
			? reasoningLine.split(":")[1].trim()
			: "Classifier decision.",
	};
}
