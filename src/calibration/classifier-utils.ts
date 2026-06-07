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

/**
 * Context window budget for the classifier prompt.
 *
 * We use 10% of the model's context window, but cap the total at
 * MAX_CLASSIFIER_CHARS to prevent prompt bloat that degrades small models.
 * Classification accuracy peaks well below 2,500 tokens; beyond that small
 * models lose focus and return no-verdict or drift off-format.
 *
 * Proportions (of capped total):
 *   pitfalls  40% — grounded correction signal, most valuable
 *   history   30% — recent user/assistant turns (final replies only)
 *   prompt    20% — current user message (full intent)
 *   per-msg    5% — per-message cap inside history
 *
 * At the default 128K context window:
 *   10% × 128K × 4 = 51,200 chars → capped to 8,000 chars
 *   pitfalls  3,200 | history 2,400 | prompt 1,600 | per-msg 400
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const CHARS_PER_TOKEN = 4;
const CONTEXT_BUDGET_RATIO = 0.10;
/** Hard cap regardless of context window — protects small classifier models */
const MAX_CLASSIFIER_CHARS = 8_000;

/** Minimum chars saved before a block is worth eliding */
const SHAKE_MIN_SAVINGS = 80;

function computeBudgets(contextWindow: number): {
	maxPromptChars: number;
	maxHistoryChars: number;
	maxMsgChars: number;
	maxPitfallsChars: number;
} {
	const raw   = Math.floor(contextWindow * CONTEXT_BUDGET_RATIO * CHARS_PER_TOKEN);
	const total = Math.min(raw, MAX_CLASSIFIER_CHARS);
	return {
		maxPitfallsChars: Math.floor(total * 0.40),
		maxHistoryChars:  Math.floor(total * 0.30),
		maxPromptChars:   Math.floor(total * 0.20),
		maxMsgChars:      Math.floor(total * 0.05),
	};
}

// ─── Shake / strip: reduce structural noise before classifier sees input ──────

/**
 * Strip top-level XML wrapper tags from text, keeping their inner content.
 * Used on user messages: the harness injects XML-tagged blocks (e.g.
 * <system-directive>, <context>, <file>) whose inner text IS the actual user
 * intent. Eliding them entirely (as shakeForClassifier does) leaves the
 * classifier with nothing meaningful to route on.
 *
 * Fenced code blocks in user messages are also elided (replaced with a token
 * annotation), since they are paste-payload noise, not intent signals.
 * @param text   Raw user message text (already tool-call-stripped)
 * @param budget Hard char cap applied after stripping
 */
export function stripForUserMessage(text: string, budget: number): string {
	let out = text;

	// Elide fenced code blocks — paste payload, not intent
	out = out.replace(
		/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm,
		(match) => {
			if (match.length < SHAKE_MIN_SAVINGS) return match;
			return `[code ~${Math.round(match.length / 4)}t]`;
		},
	);

	// Strip XML wrapper tags but KEEP their inner content.
	// Handles harness-injected blocks like <system-directive>...</system-directive>,
	// <context>...</context>, <file path="...">...</file>, etc.
	out = out.replace(
		/<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>(([\s\S]*?))<\/\1>/g,
		(_match, _tag, inner: string) => inner.trim(),
	);

	return truncateAtWord(out, budget);
}

/**
 * Extract bare user-authored text from a message that may contain
 * harness-injected XML blocks (<workspace-tree>, <context>, <file>, etc.).
 *
 * Strategy: remove XML blocks entirely (not their content), then trim.
 * This gives only the prose the user actually typed, which is what the
 * classifier needs for history context. Inner content of injected blocks
 * is noise (file listings, trees, injected context) not user intent.
 */
export function extractUserBareText(text: string, budget: number): string {
	// Remove XML blocks entirely — drop wrapper AND inner content
	let out = text.replace(
		/<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g,
		"",
	);
	// Also elide code fences (pasted code is not user intent)
	out = out.replace(
		/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm,
		(match) => match.length < SHAKE_MIN_SAVINGS ? match : "",
	);
	out = out.trim();
	return truncateAtWord(out, budget);
}

/**
 * Replace fenced code blocks and top-level XML blocks in `text` with a
 * token-cheap size annotation.  Used for HISTORY messages (assistant and
 * prior user messages) where the structural blobs are noise, not signal.
 *
 * @param text    Raw message text (already tool-call-stripped)
 * @param budget  Hard char cap applied after elision
 */
export function shakeForClassifier(text: string, budget: number): string {
	let out = text;

	// 1. Fenced code blocks: ``` ... ``` and ~~~ ... ~~~
	out = out.replace(
		/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm,
		(match) => {
			if (match.length < SHAKE_MIN_SAVINGS) return match;
			const approxTokens = Math.round(match.length / 4);
			return `[code block ~${approxTokens} tokens elided]`;
		},
	);

	// 2. Top-level XML-ish blocks: <tag ...>...</tag>
	out = out.replace(
		/<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g,
		(match) => {
			if (match.length < SHAKE_MIN_SAVINGS) return match;
			const approxTokens = Math.round(match.length / 4);
			return `[xml block ~${approxTokens} tokens elided]`;
		},
	);

	return truncateAtWord(out, budget);
}

/**
 * Neutralize role-injection tokens that appear inside message content.
 *
 * The history section of the classifier prompt uses `[user]:` and `[assistant]:`
 * as structural delimiters. If those strings appear verbatim inside a message,
 * the classifier can be tricked into treating injected content as a new turn
 * (prompt poisoning).
 *
 * Strategy: replace `[user]` / `[assistant]` bracket tokens (case-insensitive,
 * whole-token — not mid-word) with parenthesized equivalents so the classifier
 * never sees the structural delimiter pattern inside content.
 *
 * Covers: [user], [assistant], [User], [ASSISTANT], [User]: ..., etc.
 * Also neutralizes bare `user:` / `assistant:` at line-start (common injection
 * form when the attacker omits the brackets).
 */
export function sanitizeRoleMarkers(text: string): string {
	return text
		// Neutralize any line-start "A:" or "B:" injection that could fake a
		// history turn (defense-in-depth for the <request> block).
		// Also covers legacy [user]/[assistant] forms in case they appear in the
		// live prompt — they are semantically inert against A:/B: delimiters but
		// best stripped anyway to avoid confusing the model.
		.replace(/\[(?:user|assistant)\]/gi, (m) => `(${m.slice(1, -1).toLowerCase()})`)
		.replace(/^(user|assistant)\s*:/gim, (_, role) => `(${role.toLowerCase()}):`)
		.replace(/^A\s*:/gm, "(A):")
		.replace(/^B\s*:/gm, "(B):");
}

/**
 * Truncate `text` to at most `budget` chars, breaking at the last word
 * boundary (space or newline) within the budget. Appends "…" when cut.
 */
function truncateAtWord(text: string, budget: number): string {
	if (text.length <= budget) return text;
	// Find last whitespace at or before budget
	let cut = budget;
	while (cut > 0 && text[cut] !== " " && text[cut] !== "\n") cut--;
	// If no whitespace found within budget, hard-cut
	if (cut === 0) cut = budget;
	return text.slice(0, cut).trimEnd() + "…";
}


/**
 * Build an interleaved conversation summary for the classifier.
 * Alternates A: (user) and B: (assistant) turns — no tool output, no tool results.
 * User messages: bare prose (XML harness injections stripped entirely).
 * Assistant messages: code/XML elided, prose kept.
 * The current user turn is excluded (shown separately in the <request> block).
 */
export function getConversationSummary(
	context: Context,
	maxTurns: number,
	maxMsgChars: number,
	maxHistoryChars: number,
): string {
	const entries: string[] = [];
	let totalChars = 0;
	let skippedLatestUser = false;

	for (let i = context.messages.length - 1; i >= 0 && entries.length < maxTurns; i--) {
		const msg = context.messages[i];
		if (msg.role === "toolResult") continue;

		if (msg.role === "assistant") {
			// Skip mid-loop messages that issued tool calls — they are execution narration,
			// not conversation turns. Only include pure-text replies (no toolCall parts).
			const content = msg.content;
			if (Array.isArray(content) && content.some((p) => (p as { type: string }).type === "toolCall")) {
				continue;
			}
			const text = extractTextOnly(msg).trim();
			if (!text) continue;
			const plain = stripMarkdown(text);
			// Skip clarification/meta replies — short and/or contain request-for-input phrases
			if (plain.length < 20) continue;
			const firstLine = plain.split("\n")[0].toLowerCase();
			if (/^(please |proceed |let me know|could you |can you provide|i need more|alternatively)/.test(firstLine)) continue;
			const truncated = shakeForClassifier(sanitizeRoleMarkers(plain), maxMsgChars);
			if (!truncated) continue;
			if (totalChars + truncated.length > maxHistoryChars) break;
			entries.unshift(`B: ${truncated}`);
			totalChars += truncated.length;
			continue;
		}

		if (msg.role === "user") {
			const rawText = extractTextOnly(msg).trim();
			if (!rawText) continue;
			const bare = extractUserBareText(rawText, maxMsgChars);
			if (!bare) continue;
			if (!skippedLatestUser) {
				skippedLatestUser = true;
				continue;
			}
			if (totalChars + bare.length > maxHistoryChars) break;
			entries.unshift(`A: ${sanitizeRoleMarkers(bare)}`);
			totalChars += bare.length;
		}
	}

	return entries.join("\n");
}


/** Strip markdown formatting to plain text for classifier history entries */
function stripMarkdown(text: string): string {
	return text
		// Headers: ## Foo → Foo
		.replace(/^#{1,6}\s+/gm, "")
		// Bold/italic: **foo**, *foo*, __foo__, _foo_
		.replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
		// Inline code: `foo`
		.replace(/`([^`]+)`/g, "$1")
		// Links: [text](url) → text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		// Horizontal rules
		.replace(/^[-*_]{3,}\s*$/gm, "")
		// Bullet/numbered list markers
		.replace(/^[\s]*[-*+]\s+/gm, "")
		.replace(/^[\s]*\d+\.\s+/gm, "")
		// Collapse multiple blank lines to one
		.replace(/\n{3,}/g, "\n\n")
		// Remove entire lines that start with prompt delimiter keywords — these appear
		// in assistant reply prose and would confuse the classifier output parser
		.replace(/^(User|Tier|Reasoning|History|Pitfalls|A|B)\s*:.*$/gim, "")
		// Remove XML-like placeholder tokens e.g. <current message>, <file>, etc.
		.replace(/<[^>]{1,40}>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
// ─── Signal detection ─────────────────────────────────────────────────────────

/**
 * Detect routing signals from recent conversation context.
 * Returns an array of signal strings that indicate tier escalation or other routing hints.
 *
 * Signals:
 *  - "repeated_instruction" — user has said the same thing (or very similar) 2+ times recently
 *  - "escalation_request" — user is expressing dissatisfaction and asking for better output
 *  - "refine_previous" — user is asking to improve/fix the previous assistant output
 */
export function detectSignals(context: Context): string[] {
	const signals: string[] = [];
	const userMessages: string[] = [];

	// Collect recent user messages (last 6, excluding toolResult)
	for (let i = context.messages.length - 1; i >= 0 && userMessages.length < 6; i--) {
		const msg = context.messages[i];
		if (msg.role === "user") {
			const text = extractTextOnly(msg).trim().toLowerCase();
			// Strip XML blocks for comparison
			const bare = text.replace(/<[A-Za-z][A-Za-z0-9_-]*(?:\s[^>]*)?>[\s\S]*?<\/[A-Za-z][A-Za-z0-9_-]*>/g, "").trim();
			if (bare) userMessages.push(bare);
		}
	}

	if (userMessages.length < 2) return signals;

	const current = userMessages[0];

	// Repeated instruction: check if current message shares significant word overlap with recent history
	const currentWords = new Set(current.split(/\s+/).filter(w => w.length > 3));
	if (currentWords.size >= 2) {
		for (let i = 1; i < userMessages.length; i++) {
			const prevWords = new Set(userMessages[i].split(/\s+/).filter(w => w.length > 3));
			let overlap = 0;
			for (const w of currentWords) {
				if (prevWords.has(w)) overlap++;
			}
			const ratio = overlap / Math.max(currentWords.size, 1);
			if (ratio >= 0.6) {
				signals.push("repeated_instruction");
				break;
			}
		}
	}

	// Escalation request patterns
	const escalationPatterns = /\b(try again|do it (properly|correctly|right)|that('s| is) (not right|wrong|broken)|not what i (asked|wanted)|fix (this|that|it)|still (broken|wrong|not working))\b/i;
	if (escalationPatterns.test(current)) {
		signals.push("escalation_request");
	}

	// Refine previous output
	const refinePatterns = /\b(improve|enhance|update|refine|make it better|redo|revise|not good enough|can you do better)\b/i;
	if (refinePatterns.test(current)) {
		signals.push("refine_previous");
	}

	return signals;
}

/** Build classifier prompt (shared between sync and async paths) */
export function buildClassifierPrompt(
	context: Context,
	currentPhase?: RouterPhase,
	toolCounts?: Record<string, number>,
	pitfalls?: string,
	contextWindow = DEFAULT_CONTEXT_WINDOW,
): string {
	const b = computeBudgets(contextWindow);

	const promptText     = sanitizeRoleMarkers(stripForUserMessage(getLastUserText(context), b.maxPromptChars));
	const historyText    = getConversationSummary(context, 12, b.maxMsgChars, b.maxHistoryChars);
	const pitfallsSection = pitfalls ? truncateAtWord(pitfalls, b.maxPitfallsChars) : undefined;
	const signals        = detectSignals(context);

	// Activity line
	let activityText = "";
	if (toolCounts && Object.keys(toolCounts).length > 0) {
		const sorted = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
		activityText = sorted.map(([n, c]) => `${n}×${c}`).join(" ");
	}

	// Signal hints
	const hints: string[] = [];
	if (signals.includes("repeated_instruction")) {
		hints.push("User has repeated this request — previous tier was insufficient, escalate one level.");
	}
	if (signals.includes("escalation_request")) {
		hints.push("User is dissatisfied with previous output — escalate tier.");
	}
	if (signals.includes("refine_previous")) {
		hints.push("User is asking to improve/refine — consider higher tier for quality.");
	}

	// XML section blocks — only included when non-empty
	const pitfallsBlock  = pitfallsSection ? `\n<pitfalls>\n${pitfallsSection}\n</pitfalls>\n` : "";
	const historyBlock   = historyText     ? `\n<history>\n${historyText}\n</history>\n`        : "";
	const activityBlock  = activityText    ? `\n<activity>${activityText}</activity>\n`          : "";
	const signalsBlock   = hints.length    ? `\n<signals>${hints.join(" ")}</signals>\n`         : "";

	return `You are a routing classifier. Classify the user request below as "high", "medium", or "low" effort. Reply ONLY with the two lines shown in the format — no preamble, no explanation, no other text.

<tiers>
high   — Architecture, design decisions, tradeoff analysis, broad codebase research, large refactors, debugging unfamiliar systems.
medium — Implementing a known plan, multi-file edits, focused debugging, writing tests, normal coding.
low    — Summaries, lookups, quick explanations, status checks, observations, one-liner fixes, short acknowledgements, changelogs.
</tiers>
${pitfallsBlock}${historyBlock}${activityBlock}${signalsBlock}
<request>
${promptText}
</request>

Respond with exactly these two lines and nothing else:
Tier: high|medium|low
Reasoning: one sentence`;
}

/** Parse classifier output (shared between sync and async paths) */
export function parseClassifierOutput(
	text: string,
): { tier: RouterTier; reasoning: string } | undefined {
	const lines = text.trim().split("\n");

	// Primary: strict line-prefix match (expected format)
	const tierLine = lines.find((l) => l.toLowerCase().startsWith("tier:"));
	const reasoningLine = lines.find((l) => l.toLowerCase().startsWith("reasoning:"));

	if (tierLine) {
		const tierValue = tierLine.split(":")[1].trim().toLowerCase();
		if (isRouterTier(tierValue)) {
			const rawReasoning = reasoningLine ? reasoningLine.split(":")[1].trim() : "";
			// Reject template placeholders: "[one sentence]", "[high|medium|low]", "one sentence"
			const isPlaceholder = !rawReasoning
				|| rawReasoning.includes("|")
				|| rawReasoning.startsWith("[")
				|| rawReasoning.toLowerCase() === "one sentence";
			const reasoning = isPlaceholder ? "Classifier decision." : rawReasoning;
			return { tier: tierValue, reasoning };
		}
	}

	// Fallback: tier word must be the first meaningful token on a short line.
	// Catches Nova Micro variations like "low", "Low.", "medium - it's simple"
	// but NOT prose lines where tier words appear mid-sentence.
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length > 60) continue;
		const lower = trimmed.toLowerCase();
		// Tier word must appear at the very start (optionally preceded by quotes/dashes)
		const m = lower.match(/^["'\-*]*\s*(high|medium|low)\b/);
		if (m && isRouterTier(m[1])) {
			const afterTier = trimmed.slice(lower.indexOf(m[1]) + m[1].length).replace(/^[^a-z]*/i, "").trim();
			const reasoning = afterTier || (reasoningLine ? reasoningLine.split(":")[1].trim() : "Classifier decision.");
			return { tier: m[1], reasoning };
		}
	}

	return undefined;
}
