/**
 * Shared classifier prompt building and output parsing
 * Used by both sync (routing.ts) and async (agent.ts) classifiers
 */

import type { Context } from "@oh-my-pi/pi-ai";
import type { RouterTier, RouterPhase } from "../types";

/** Extract last user message from context */
export function getLastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		if (context.messages[i].role === "user") {
			const content = context.messages[i].content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.filter((c) => c.type === "text")
					.map((c) => (c as { text: string }).text)
					.join("\n");
			}
		}
	}
	return "";
}

/** Extract recent conversation text (last N user messages) */
export function getRecentUserText(context: Context, count: number): string {
	const userMsgs: string[] = [];
	for (let i = context.messages.length - 1; i >= 0 && userMsgs.length < count; i--) {
		if (context.messages[i].role === "user") {
			const content = context.messages[i].content;
			if (typeof content === "string") {
				userMsgs.unshift(content.slice(0, 300));
			} else if (Array.isArray(content)) {
				const text = content
					.filter((c) => c.type === "text")
					.map((c) => (c as { text: string }).text)
					.join("\n")
					.slice(0, 300);
				userMsgs.unshift(text);
			}
		}
	}
	return userMsgs.join("\n---\n");
}

/** Build classifier prompt (shared between sync and async paths) */
export function buildClassifierPrompt(
	context: Context,
	currentPhase?: RouterPhase,
): string {
	const promptText = getLastUserText(context);
	const historyText = getRecentUserText(context, 4);
	
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
