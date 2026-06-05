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
import { isRouterTier } from "../config";
import {
	extractText,
	getLastUserText,
} from "../utils/messages.js";

export { getLastUserText };

const TEXT_ONLY: { includeThinking: false; includeToolCalls: false } = {
	includeThinking: false,
	includeToolCalls: false,
};

function extractTextOnly(msg: Message): string {
	return extractText(msg, TEXT_ONLY);
}

/** Max chars per message in the classifier context (hard cap, applied after shake) */
const MAX_MSG_CHARS = 300;
/** Max total chars for the history section */
const MAX_HISTORY_CHARS = 1500;
/** Minimum chars saved before a block is worth eliding */
const SHAKE_MIN_SAVINGS = 80;
/** Max chars of the last user message fed to the classifier */
const MAX_PROMPT_CHARS = 600;

// ─── Shake: strip heavy structural blobs before classifier sees them ──────────

/**
 * Replace fenced code blocks and top-level XML blocks in `text` with a
 * token-cheap size annotation.  Preserves surrounding prose — the intent
 * signal the classifier actually needs — and only elides structural blobs.
 *
 * Mirrors the region-detection logic in OMP's shake.ts without the
 * persistence machinery: pure string mutation, no I/O, no allocation beyond
 * the output string.
 *
 * @param text    Raw message text (already tool-call-stripped)
 * @param budget  Hard char cap applied after elision (default: MAX_MSG_CHARS)
 */
export function shakeForClassifier(text: string, budget = MAX_MSG_CHARS): string {
	let out = text;

	// 1. Fenced code blocks: ``` ... ``` and ~~~ ... ~~~
	//    Only closed (terminated) fences — open fences are likely still streaming.
	out = out.replace(
		/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm,
		(match) => {
			const saved = match.length;
			if (saved - SHAKE_MIN_SAVINGS < 0) return match;
			const approxTokens = Math.round(saved / 4);
			return `[code block ~${approxTokens} tokens elided]`;
		},
	);

	// 2. Top-level XML-ish blocks: <tag ...>...</tag>  (single-line open/close ignored)
	out = out.replace(
		/<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g,
		(match) => {
			const saved = match.length;
			if (saved - SHAKE_MIN_SAVINGS < 0) return match;
			const approxTokens = Math.round(saved / 4);
			return `[xml block ~${approxTokens} tokens elided]`;
		},
	);

	return out.length > budget ? out.slice(0, budget) : out;
}


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
			const truncated = shakeForClassifier(text, MAX_MSG_CHARS);
			if (totalChars + truncated.length > MAX_HISTORY_CHARS) break;
			entries.unshift(`[assistant]: ${truncated}`);
			totalChars += truncated.length;
			continue;
		}

		// User messages
		if (msg.role === "user") {
			const text = extractTextOnly(msg).trim();
			if (!text) continue;
			const truncated = shakeForClassifier(text, MAX_MSG_CHARS);
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
	toolCounts?: Record<string, number>,
	pitfalls?: string,
): string {
	const promptText = shakeForClassifier(getLastUserText(context), MAX_PROMPT_CHARS);
	const historyText = getConversationSummary(context, 6);

	// Phase 2: tool-activity summary line (≤20 tokens, sorted by count desc)
	let activityLine = "";
	if (toolCounts && Object.keys(toolCounts).length > 0) {
		const entries = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
		activityLine = `Recent agent activity (last 12 tool calls): ${entries.map(([n, c]) => `${n}×${c}`).join(" ")}\n\n`;
	}
	return `You are a model router classifier. Categorize the user's latest request into one tier: "high", "medium", or "low".

Tiers:
- high: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.
- medium: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.
- low: Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.

${pitfalls ? `\nKnown classification pitfalls to consider:\n${pitfalls}\n\n` : ""}${currentPhase ? `Current phase: ${currentPhase}\n` : ""}Conversation (user messages and assistant replies only, no tool output):
${historyText}

${activityLine}Latest user message:
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
