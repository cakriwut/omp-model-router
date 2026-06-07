/**
 * Tier resolution heuristics.
 * Keyword matching, context triggers, and decision primitives.
 */

import type { Context } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseCanonicalModelRef } from "../config";
import type {
	RouterTier,
	RouterProfile,
	RouterPhase,
	RoutingDecision,
	RoutingRule,
	RouterThinkingByTier,
	TaskType,
} from "../types";
import {
	hasImageAttachment,
	getLastUserText,
	countToolResults,
	countWords,
	getRecentConversationText,
} from "./text";

// ─── Keyword matching ─────────────────────────────────────────────────────────

/**
 * Keyword lists at module scope — zero per-call allocation.
 *
 * CORRECTNESS NOTE: Single-word keywords use word-boundary (\b) regex matching
 * to avoid false positives. Examples of previously false-matched words:
 *   "information" matched keyword "format"
 *   "unchanged"   matched keyword "change"
 *   "encode"      matched keyword "code"
 *   "blacklist"   matched keyword "list"
 *
 * Multi-word keywords (containing spaces) use substring matching — they already
 * carry natural boundaries.
 *
 * Morphological variants that SHOULD trigger the same tier are added explicitly:
 *   "editing" (from "edit"), "fastest" (from "fast"), "continued" (from "continue").
 */

const EXPLICIT_HIGH_HINTS: readonly string[] = [
	"best",
	"deep",
	"deeply",
	"carefully",
	"thoroughly",
	"robust",
	"comprehensive",
	"step by step",
	"think hard",
	"highest quality",
];

const EXPLICIT_LOW_HINTS: readonly string[] = [
	"fast",
	"fastest",
	"cheap",
	"quick",
	"quickly",
	"brief",
	"briefly",
	"one sentence",
	"one line",
	"tiny",
	"small",
];

const STRONG_PLANNING_KEYWORDS: readonly string[] = [
	"architecture",
	"architect",
	"tradeoff",
	"trade-off",
	"root cause",
	"investigate",
	"migration",
	"analyze",
	"analysis",
];

const WEAK_PLANNING_KEYWORDS: readonly string[] = [
	"plan",
	"planning",
	"design",
	"research",
	"strategy",
	"compare",
	"options",
	"approach",
];

const SUMMARY_KEYWORDS: readonly string[] = [
	"summarize",
	"summary",
	"changelog",
	"reformat",
	"format",
	"rename",
	"explain briefly",
	"recap",
	"tl;dr",
];

const IMPLEMENTATION_KEYWORDS: readonly string[] = [
	"implement",
	"write code",
	"code this",
	"fix",
	"update",
	"edit",
	"editing",
	"write",
	"refactor",
	"rewrite",
	"add tests",
	"unit tests",
	"write tests",
	"patch",
	"change",
	"apply",
	"continue",
	"continued",
	"resume",
	"make the changes",
	"go ahead",
];

const LOOKUP_KEYWORDS: readonly string[] = [
	"where is",
	"which file",
	"show me",
	"list",
	"find",
	"grep",
];

const GIT_KEYWORDS: readonly string[] = [
	"commit",
	"push",
	"pull",
	"merge",
	"rebase",
	"cherry-pick",
	"stash",
	"checkout",
	"branch",
	"tag",
	"fetch",
	"clone",
	"reset",
	"revert",
	"amend",
	"git status",
	"git log",
	"git diff",
	"git add",
];

interface KeywordMatcher {
	singleWord: RegExp[];
	multiWord: readonly string[];
}

export const buildKeywordMatcher = (keywords: readonly string[]): KeywordMatcher => {
	const singleWord: RegExp[] = [];
	const multiWord: string[] = [];
	for (const kw of keywords) {
		if (kw.includes(" ")) {
			multiWord.push(kw);
		} else {
			// Pre-compile with word boundaries; flags: i for case-insensitivity
			singleWord.push(new RegExp(`\\b${kw}\\b`, "i"));
		}
	}
	return { singleWord, multiWord: multiWord as readonly string[] };
};

// Pre-compile all matchers at module load — zero per-call allocation.
const HIGH_HINT_MATCHER = buildKeywordMatcher(EXPLICIT_HIGH_HINTS);
const LOW_HINT_MATCHER = buildKeywordMatcher(EXPLICIT_LOW_HINTS);
const STRONG_PLANNING_MATCHER = buildKeywordMatcher(STRONG_PLANNING_KEYWORDS);
const SUMMARY_MATCHER = buildKeywordMatcher(SUMMARY_KEYWORDS);
const WEAK_PLANNING_MATCHER = buildKeywordMatcher(WEAK_PLANNING_KEYWORDS);
const IMPLEMENTATION_MATCHER = buildKeywordMatcher(IMPLEMENTATION_KEYWORDS);
const LOOKUP_MATCHER = buildKeywordMatcher(LOOKUP_KEYWORDS);
const GIT_MATCHER = buildKeywordMatcher(GIT_KEYWORDS);

// ─── Task-type keyword matchers ───────────────────────────────────────────────

const CODING_KEYWORDS: readonly string[] = [
	"implement",
	"code",
	"function",
	"class",
	"algorithm",
	"script",
	"program",
	"debug",
	"compile",
	"unit test",
	"integration test",
	"refactor",
	"api",
	"endpoint",
	"library",
	"module",
	"package",
	"dependency",
	"bug",
	"exception",
	"python",
	"javascript",
	"typescript",
	"rust",
	"golang",
	"java",
	"html",
	"css",
	"sql",
	"regex",
	"crud",
	"frontend",
	"backend",
	"database",
	"server",
	"cli",
	"dockerfile",
	"terraform",
];

const RESEARCH_KEYWORDS: readonly string[] = [
	"explain",
	"how does",
	"what is",
	"why does",
	"compare",
	"difference between",
	"pros and cons",
	"trade-off",
	"literature",
	"paper",
	"study",
	"investigate",
	"analyze",
	"analysis",
];

const MATH_KEYWORDS: readonly string[] = [
	"calculate",
	"compute",
	"solve",
	"equation",
	"formula",
	"probability",
	"statistics",
	"integral",
	"derivative",
	"matrix",
	"vector",
	"optimize",
	"proof",
	"theorem",
	"linear regression",
	"gradient",
];

const WRITING_KEYWORDS: readonly string[] = [
	"draft",
	"essay",
	"blog",
	"article",
	"email",
	"letter",
	"story",
	"creative writing",
	"prose",
	"narrative",
	"copywrite",
];

const SUMMARIZATION_KEYWORDS: readonly string[] = [
	"summarize",
	"summary",
	"tl;dr",
	"tldr",
	"recap",
	"condense",
	"brief overview",
	"key points",
	"main points",
	"highlights",
];

const CODING_TASK_MATCHER = buildKeywordMatcher(CODING_KEYWORDS);
const RESEARCH_TASK_MATCHER = buildKeywordMatcher(RESEARCH_KEYWORDS);
const MATH_TASK_MATCHER = buildKeywordMatcher(MATH_KEYWORDS);
const WRITING_TASK_MATCHER = buildKeywordMatcher(WRITING_KEYWORDS);
const SUMMARIZATION_TASK_MATCHER = buildKeywordMatcher(SUMMARIZATION_KEYWORDS);

/**
 * Returns true if any keyword in the matcher appears in text, using
 * word-boundary matching for single-word keywords and substring matching
 * for multi-word phrases.
 */
export const matchesKeywords = (
	text: string,
	matcher: KeywordMatcher,
): boolean => {
	for (const re of matcher.singleWord) {
		if (re.test(text)) return true;
	}
	for (const phrase of matcher.multiWord) {
		if (text.includes(phrase)) return true;
	}
	return false;
};

/** Count how many keywords from a matcher appear in the text. */
const countKeywordMatches = (text: string, matcher: KeywordMatcher): number => {
	let count = 0;
	for (const re of matcher.singleWord) {
		if (re.test(text)) count++;
	}
	for (const phrase of matcher.multiWord) {
		if (text.includes(phrase)) count++;
	}
	return count;
};

/**
 * @deprecated Use matchesKeywords with a pre-built matcher instead.
 * Kept for external callers that may depend on it.
 */
export const containsAny = (text: string, keywords: string[]): boolean => {
	return keywords.some((keyword) => {
		if (keyword.includes(" ")) return text.includes(keyword);
		return new RegExp(`\\b${keyword}\\b`, "i").test(text);
	});
};

/**
 * Detect the most likely task type from user prompt text.
 * Scores each type by keyword match count and returns the winner,
 * or undefined if no keywords match (avoids false positives on short prompts).
 *
 * Used to auto-select a task-type-specialized profile when one is configured.
 */
export const detectTaskType = (text: string): TaskType | undefined => {
	const t = text.toLowerCase();
	let best: TaskType | undefined;
	let bestScore = 0;

	const candidates: [TaskType, KeywordMatcher][] = [
		["coding", CODING_TASK_MATCHER],
		["research", RESEARCH_TASK_MATCHER],
		["math", MATH_TASK_MATCHER],
		["writing", WRITING_TASK_MATCHER],
		["summarization", SUMMARIZATION_TASK_MATCHER],
	];
	for (const [type, matcher] of candidates) {
		const score = countKeywordMatches(t, matcher);
		if (score > bestScore) {
			bestScore = score;
			best = type;
		}
	}
	// Require at least 1 match — avoids routing generic short prompts
	return bestScore >= 1 ? best : undefined;
};

// ─── Routing primitives ───────────────────────────────────────────────────────

export const phaseForTier = (tier: RouterTier): RouterPhase => {
	if (tier === "high") return "planning";
	if (tier === "medium") return "implementation";
	return "lightweight";
};

export const buildRoutingDecision = (
	profileName: string,
	profile: RouterProfile,
	tier: RouterTier,
	phase: RouterPhase,
	reasoning: string,
	thinkingOverrides?: RouterThinkingByTier,
	isClassifier?: boolean,
): RoutingDecision => {
	const routed = profile[tier];
	const { provider, modelId } = parseCanonicalModelRef(routed.model);
	const baseThinking: ThinkingLevel =
		routed.thinking ??
		(tier === "high"
			? ThinkingLevel.High
			: tier === "low"
				? ThinkingLevel.Low
				: ThinkingLevel.Medium);
	const effectiveThinking: ThinkingLevel =
		thinkingOverrides?.[tier] ?? baseThinking;

	return {
		profile: profileName,
		tier,
		phase,
		targetProvider: provider,
		targetModelId: modelId,
		targetLabel: routed.model,
		reasoning,
		thinking: effectiveThinking,
		timestamp: Date.now(),
		isClassifier,
	};
};

export const decideRouting = (
	context: Context,
	profileName: string,
	profile: RouterProfile,
	previousDecision: RoutingDecision | undefined,
	pinnedTier?: RouterTier,
	thinkingOverrides?: RouterThinkingByTier,
	phaseBias = 0.5,
	rules?: RoutingRule[],
	isBudgetExceeded = false,
	floor?: RouterTier,
): RoutingDecision => {
	const prompt = getLastUserText(context).toLowerCase();
	const recentConversation = getRecentConversationText(context);
	const toolResultCount = countToolResults(context);
	const wordCount = countWords(prompt);

	let phase: RouterPhase = previousDecision?.phase ?? "implementation";
	// Use floor as the default starting tier when provided (replaces hardcoded 'medium').
	// This is the 'last resort' value — heuristic rules and classifier can freely override it.
	let tier: RouterTier = floor ?? "medium";
	let reasoning = floor
		? `Defaulted to ${floor} tier (config defaultPin).`
		: "Defaulted to medium tier for general coding work.";
	let isRuleMatched = false;

	if (pinnedTier) {
		phase = phaseForTier(pinnedTier);
		tier = pinnedTier;
		reasoning = `Pinned to ${pinnedTier} tier (scoped pin active).`;
	} else {
		// Check custom rules first (use matchesKeywords for word-boundary accuracy)
		if (rules) {
			for (const rule of rules) {
				const matches = Array.isArray(rule.matches)
					? rule.matches
					: [rule.matches];
				const ruleMatcher = buildKeywordMatcher(matches);
				if (matchesKeywords(prompt, ruleMatcher)) {
					tier = rule.tier;
					phase = phaseForTier(tier);
					reasoning =
						rule.reason ??
						`Matched custom routing rule for: ${matches.join(", ")}`;
					isRuleMatched = true;
					break;
				}
			}
		}

		if (!isRuleMatched) {
			// Sticky phase adjustments
			const highThreshold = Math.max(
				40,
				120 - (previousDecision?.phase === "planning" ? phaseBias * 80 : 0),
			);
			const lowThreshold = Math.max(
				4,
				12 -
					(previousDecision?.phase === "implementation" ||
					previousDecision?.phase === "planning"
						? phaseBias * 8
						: 0),
			);

			if (matchesKeywords(prompt, HIGH_HINT_MATCHER)) {
				phase = "planning";
				tier = "high";
				reasoning =
					"Detected an explicit request for deeper or higher-quality reasoning.";
			} else if (matchesKeywords(prompt, LOW_HINT_MATCHER)) {
				phase = "lightweight";
				tier = "low";
				reasoning =
					"Detected an explicit request for a faster or lighter response.";
			} else if (matchesKeywords(prompt, SUMMARY_MATCHER)) {
				phase = "lightweight";
				tier = "low";
				reasoning = "Detected summary or lightweight transformation keywords.";
			} else if (matchesKeywords(prompt, GIT_MATCHER)) {
				phase = "lightweight";
				tier = "low";
				reasoning = "Detected a git operation — low model sufficient.";
			} else if (matchesKeywords(prompt, STRONG_PLANNING_MATCHER)) {
				phase = "planning";
				tier = "high";
				reasoning = "Detected strong planning keyword indicating architectural or investigative work.";
			} else if (
				matchesKeywords(prompt, WEAK_PLANNING_MATCHER) &&
				(wordCount >= 12 ||
					prompt.startsWith("why ") ||
					previousDecision?.phase === "planning" ||
					countKeywordMatches(prompt, WEAK_PLANNING_MATCHER) >= 2)
			) {
				phase = "planning";
				tier = "high";
				reasoning = "Detected planning keyword corroborated by prompt length, context, or multiple signals.";
			} else if (prompt.startsWith("why ") || wordCount >= highThreshold) {
				phase = "planning";
				tier = "high";
				reasoning =
					previousDecision?.phase === "planning"
						? "Continued planning phase based on complexity or keywords."
						: "Detected planning, broad analysis, or a high-complexity request.";
			} else if (matchesKeywords(prompt, IMPLEMENTATION_MATCHER)) {
				phase = "implementation";
				tier = "medium";
				reasoning =
					"Detected implementation-oriented work with bounded execution scope.";
			} else if (
				matchesKeywords(prompt, LOOKUP_MATCHER) &&
				wordCount <= 24 &&
				toolResultCount === 0
			) {
				phase = "lightweight";
				tier = "low";
				reasoning = "Detected a short read-only lookup request.";
			} else if (
				previousDecision?.phase === "planning" &&
				toolResultCount === 0 &&
				!matchesKeywords(prompt, LOOKUP_MATCHER)
			) {
				phase = "planning";
				tier = "high";
				reasoning =
					"Kept the planning-phase bias because the conversation still looks exploratory.";
			} else if (
				toolResultCount > 0 ||
				previousDecision?.phase === "implementation" ||
				recentConversation.includes("plan:")
			) {
				phase = "implementation";
				tier = "medium";
				reasoning =
					"Detected active implementation work from prior tools or recent plan execution context.";
			} else if (wordCount <= lowThreshold) {
				phase = "lightweight";
				tier = "low";
				reasoning = "Detected a short bounded request.";
			}
		}
	}

	let isBudgetForced = false;
	if (isBudgetExceeded && tier === "high") {
		tier = "medium";
		phase = "implementation";
		reasoning = `Budget exceeded. Downgraded from high to medium tier. (Original: ${reasoning})`;
		isBudgetForced = true;
	}

	const decision = buildRoutingDecision(
		profileName,
		profile,
		tier,
		phase,
		reasoning,
		thinkingOverrides,
		false,
	);
	decision.isRuleMatched = isRuleMatched;
	decision.isBudgetForced = isBudgetForced;
	return decision;
};
