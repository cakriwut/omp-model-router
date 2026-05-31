/**
 * Heuristic keyword-based routing logic.
 */

import type { Context } from "@oh-my-pi/pi-ai";
import { parseCanonicalModelRef } from "../config";
import type {
	RouterTier,
	RouterPhase,
	RouterProfile,
	RoutingDecision,
	RoutingRule,
	RouterThinkingByTier,
} from "../types";
import { getLastUserText, countToolResults, countWords, getRecentConversationText } from "./text";

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
	const baseThinking =
		routed.thinking ??
		(tier === "high" ? "high" : tier === "low" ? "low" : "medium");
	const effectiveThinking = thinkingOverrides?.[tier] ?? baseThinking;

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
): RoutingDecision => {
	const prompt = getLastUserText(context).toLowerCase();
	const recentConversation = getRecentConversationText(context);
	const toolResultCount = countToolResults(context);
	const wordCount = countWords(prompt);

	let phase: RouterPhase = previousDecision?.phase ?? "implementation";
	let tier: RouterTier = "medium";
	let reasoning = "Defaulted to medium tier for general coding work.";
	let isRuleMatched = false;

	if (pinnedTier) {
		phase = phaseForTier(pinnedTier);
		tier = pinnedTier;
		reasoning = `Pinned to ${pinnedTier} tier via /router pin.`;
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
