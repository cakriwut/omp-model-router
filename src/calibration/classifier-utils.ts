/**
 * Shared classifier prompt building and output parsing
 * Used by both sync (routing.ts) and async (agent.ts) classifiers
 *
 * DESIGN: The classifier receives ONLY user messages and brief assistant
 * text summaries. Tool calls, tool results, thinking blocks, and other
 * non-text content are excluded to:
 * - Keep classifier input small (fast, cheap)
 * - Avoid leaking large payloads into the classifier context
 * - Focus the LLM on conversation intent, not execution artifacts
 */

import type { Context, Message } from "@oh-my-pi/pi-ai";
import type { RouterTier, RouterPhase } from "../types";
import {
	extractText,
	getLastUserText,
	getRecentUserText,
} from "../utils/messages.js";

export { getLastUserText, getRecentUserText };

const TEXT_ONLY: { includeThinking: false; includeToolCalls: false } = {
	includeThinking: false,
	includeToolCalls: false,
};

function extractTextOnly(msg: Message): string {
	return extractText(msg, TEXT_ONLY);
}

/** Max chars per message in the classifier context */
const MAX_MSG_CHARS = 300;
/** Max total chars for the history section */
const MAX_HISTORY_CHARS = 1500;


/**
 * Build a lean conversation summary for the classifier.
 * Includes only user messages and brief assistant text (no tools).
 * Provides context about the conversation direction without bloat.
 */
export function getConversationSummary(context: Context, maxTurns = 6): string {
	const entries: string[] = [];
	let totalChars = 0;

	// Walk backwards through messages, collect user + assistant text only
	// Skip: toolResult, messages that are purely tool calls
	for (let i = context.messages.length - 1; i >= 0 && entries.length < maxTurns; i--) {
		const msg = context.messages[i];

		// Skip tool results entirely
		if (msg.role === "toolResult") continue;

		// For assistant messages, only include if they have text content
		// (skip pure tool-call-only assistant messages)
		if (msg.role === "assistant") {
			const text = extractTextOnly(msg).trim();
			if (!text) continue; // skip assistant messages that are only tool calls
			const truncated = text.slice(0, MAX_MSG_CHARS);
			if (totalChars + truncated.length > MAX_HISTORY_CHARS) break;
			entries.unshift(`[assistant]: ${truncated}`);
			totalChars += truncated.length;
			continue;
		}

		// User messages
		if (msg.role === "user") {
			const text = extractTextOnly(msg).trim();
			if (!text) continue;
			const truncated = text.slice(0, MAX_MSG_CHARS);
			if (totalChars + truncated.length > MAX_HISTORY_CHARS) break;
			entries.unshift(`[user]: ${truncated}`);
			totalChars += truncated.length;
		}
	}

	return entries.join("\n");
}


/** Build classifier prompt (shared between sync and async paths) */
export function buildClassifierPrompt(
	context: Context,
	currentPhase?: RouterPhase,
): string {
	const promptText = getLastUserText(context);
	const historyText = getConversationSummary(context, 6);
	
	return `You are a model router classifier. Categorize the user's latest request into one tier: "high", "medium", or "low".

Tiers:
- high: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.
- medium: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.
- low: Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.

${currentPhase ? `Current phase: ${currentPhase}\n` : ""}Conversation (user messages and assistant replies only, no tool output):
${historyText}

Latest user message:
${promptText}

Return exactly two lines:
Tier: [high|medium|low]
Reasoning: [one short sentence]${currentPhase === "planning" ? "\n\nBias toward \"high\" unless clearly a simple implementation or summary." : ""}${currentPhase === "implementation" ? "\n\nBias toward \"medium\" unless clearly planning or a simple summary." : ""}`;
}

/** Parse classifier output (shared between sync and async paths) */
export function parseClassifierOutput(
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

function isRouterTier(value: string): value is RouterTier {
	return value === "low" || value === "medium" || value === "high";
}
