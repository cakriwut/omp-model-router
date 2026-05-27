import { streamSimple, type Context, type Message } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	RouterTier,
	RouterPhase,
	RouterProfile,
	RoutingDecision,
	RoutingRule,
	RouterThinkingByTier,
} from "./types";
import { parseCanonicalModelRef, isRouterTier } from "./config";

// ─── Text extraction utilities ────────────────────────────────────────────────

export const extractTextFromContent = (
	content: string | Message["content"],
): string => {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return part.thinking;
			if (part.type === "toolCall")
				return `${part.name} ${JSON.stringify(part.arguments)}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
};

export const getLastUserText = (context: Context): string => {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role === "user") {
			return extractTextFromContent(message.content).trim();
		}
	}
	return "";
};

export const getRecentConversationText = (
	context: Context,
	limit = 6,
): string => {
	return context.messages
		.slice(-limit)
		.map((message) => extractTextFromContent(message.content).trim())
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
};

export const countToolResults = (context: Context): number => {
	return context.messages.filter((message) => message.role === "toolResult")
		.length;
};

export const countWords = (text: string): number => {
	return text.split(/\s+/).filter(Boolean).length;
};

export const hasImageAttachment = (context: Context): boolean => {
	return context.messages.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((part) => part.type === "image"),
	);
};

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

const PLANNING_KEYWORDS: readonly string[] = [
	"plan",
	"planning",
	"architecture",
	"architect",
	"design",
	"tradeoff",
	"trade-off",
	"research",
	"investigate",
	"root cause",
	"analyze",
	"analysis",
	"migration",
	"strategy",
	"compare",
	"options",
	"approach",
];

const SUMMARY_KEYWORDS: readonly string[] = [
	"summarize",
	"summary",
	"changelog",
	"rewrite",
	"reformat",
	"format",
	"rename",
	"explain briefly",
	"recap",
	"tl;dr",
];

const IMPLEMENTATION_KEYWORDS: readonly string[] = [
	"implement",
	"code",
	"fix",
	"update",
	"edit",
	"editing",
	"write",
	"refactor",
	"add tests",
	"unit tests",
	"write tests",
	"tests",
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

interface KeywordMatcher {
	singleWord: RegExp[];
	multiWord: readonly string[];
}

const buildKeywordMatcher = (keywords: readonly string[]): KeywordMatcher => {
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
const PLANNING_MATCHER = buildKeywordMatcher(PLANNING_KEYWORDS);
const SUMMARY_MATCHER = buildKeywordMatcher(SUMMARY_KEYWORDS);
const IMPLEMENTATION_MATCHER = buildKeywordMatcher(IMPLEMENTATION_KEYWORDS);
const LOOKUP_MATCHER = buildKeywordMatcher(LOOKUP_KEYWORDS);

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

/**
 * @deprecated Use matchesKeywords with a pre-built matcher instead.
 * Kept for external callers that may depend on it.
 */
export const containsAny = (text: string, keywords: string[]): boolean => {
	return keywords.some((keyword) => text.includes(keyword));
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
	const multiLinePrompt = prompt.split("\n").length >= 4;

	let phase: RouterPhase = previousDecision?.phase ?? "implementation";
	let tier: RouterTier = "medium";
	let reasoning = "Defaulted to medium tier for general coding work.";
	let isRuleMatched = false;

	if (pinnedTier) {
		phase = phaseForTier(pinnedTier);
		tier = pinnedTier;
		reasoning = `Pinned to ${pinnedTier} tier via /router pin.`;
	} else {
		// Check custom rules first
		if (rules) {
			for (const rule of rules) {
				const matches = Array.isArray(rule.matches)
					? rule.matches
					: [rule.matches];
				if (containsAny(prompt, matches)) {
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
			} else if (
				matchesKeywords(prompt, PLANNING_MATCHER) ||
				prompt.startsWith("why ") ||
				wordCount >= highThreshold ||
				multiLinePrompt
			) {
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

// ─── LLM classifier ───────────────────────────────────────────────────────────

export const runClassifier = async (
	classifierModelRef: string,
	modelRegistry: ExtensionContext["modelRegistry"],
	context: Context,
	currentPhase?: RouterPhase,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
	try {
		const { provider, modelId } = parseCanonicalModelRef(classifierModelRef);
		const model = modelRegistry.find(provider, modelId);
		if (!model) return undefined;

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) return undefined;
		const headers = model.headers;

		const promptText = getLastUserText(context);
		const historyText = getRecentConversationText(context, 4);

		const classifierPrompt = `You are a model router classifier. Your job is to categorize the user's latest request into one of three tiers: "high", "medium", or "low".

Tiers:
- high: Architecture, design, planning, tradeoff analysis, broad debugging, large refactors, codebase research.
- medium: Implementation of a known plan, multi-file edits, normal coding work, focused debugging, tests/fixes.
- low: Summaries, changelogs, formatting, quick explanations, small bounded transforms, simple read-only lookup.

${currentPhase ? `Current conversation phase: ${currentPhase}\n` : ""}
Recent history:
${historyText}

Latest user message:
${promptText}

Return your decision in exactly two lines:
Tier: [high|medium|low]
Reasoning: [one short sentence]

${currentPhase === "planning" ? "Consider that the conversation is currently in a planning phase. Bias toward \"high\" unless the request is clearly a simple implementation or summary." : ""}
${currentPhase === "implementation" ? "Consider that the conversation is currently in an implementation phase. Bias toward \"medium\" unless the request is clearly planning or a simple summary." : ""}`;

		const classifierContext: Context = {
			...context,
			messages: [
				{ role: "user", content: classifierPrompt, timestamp: Date.now() },
			],
		};

		const stream = streamSimple(model, classifierContext, {
			apiKey,
			headers,
		});
		let fullText = "";
		for await (const event of stream) {
			if (
				event.type === "text_delta" &&
				typeof (event as { delta?: unknown }).delta === "string"
			) {
				fullText += (event as { delta: string }).delta;
			}
		}

		const lines = fullText.trim().split("\n");
		const tierLine = lines.find((l) => l.toLowerCase().startsWith("tier:"));
		const reasoningLine = lines.find((l) =>
			l.toLowerCase().startsWith("reasoning:"),
		);

		if (tierLine) {
			const tierValue = tierLine.split(":")[1].trim().toLowerCase();
			if (isRouterTier(tierValue)) {
				return {
					tier: tierValue,
					reasoning: reasoningLine
						? reasoningLine.split(":")[1].trim()
						: "Classifier decision.",
				};
			}
		}
	} catch (_error) {
		// Ignore classifier errors and fall back to heuristics
	}
	return undefined;
};

// ─── resolveRouting — composites heuristic + all overrides ───────────────────

export interface RoutingInput {
	context: Context;
	previousDecision: RoutingDecision | undefined;
	pinnedTier?: RouterTier;
	isBudgetExceeded: boolean;
	modelRegistry: ExtensionContext["modelRegistry"];
	lastExtensionContext?: ExtensionContext;
}

export interface RoutingConfig {
	profileName: string;
	profile: RouterProfile;
	thinkingOverrides?: RouterThinkingByTier;
	phaseBias: number;
	rules?: RoutingRule[];
	largeContextThreshold?: number;
	classifierModel?: string;
}

/**
 * Resolve the full routing decision for a request, composing:
 *   1. Heuristic decision (decideRouting)
 *   2. Context trigger upgrade (large context window forces high tier)
 *   3. Classifier override (LLM classifier overrides heuristic)
 *   4. Image attachment upgrade (forces tier that supports images)
 */
export const resolveRouting = async (
	input: RoutingInput,
	config: RoutingConfig,
): Promise<RoutingDecision> => {
	// 1. Heuristic decision
	let decision = decideRouting(
		input.context,
		config.profileName,
		config.profile,
		input.previousDecision,
		input.pinnedTier,
		config.thinkingOverrides,
		config.phaseBias,
		config.rules,
		input.isBudgetExceeded,
	);

	// 2. Context trigger upgrade — forces high tier when context window is large
	if (
		config.largeContextThreshold &&
		decision.tier !== "high" &&
		input.lastExtensionContext
	) {
		try {
			const usage = await input.lastExtensionContext.getContextUsage();
			if (usage?.tokens && usage.tokens > config.largeContextThreshold) {
				decision = buildRoutingDecision(
					config.profileName,
					config.profile,
					"high",
					"planning",
					`Context usage (${usage.tokens}) exceeds threshold (${config.largeContextThreshold}). Forced high tier.`,
					config.thinkingOverrides,
					false,
				);
				decision.isContextTriggered = true;
			}
		} catch (_e) {
			// ignore — fall through with existing decision
		}
	}

	// 3. Classifier override — only when not pinned, context-triggered, or rule-matched
	if (
		config.classifierModel &&
		!input.pinnedTier &&
		!decision.isContextTriggered &&
		!decision.isRuleMatched
	) {
		const classifierResult = await runClassifier(
			config.classifierModel,
			input.modelRegistry,
			input.context,
			input.previousDecision?.phase,
		);
		if (classifierResult) {
			decision = buildRoutingDecision(
				config.profileName,
				config.profile,
				classifierResult.tier,
				phaseForTier(classifierResult.tier),
				`Classifier: ${classifierResult.reasoning}`,
				config.thinkingOverrides,
				true,
			);
			if (input.isBudgetExceeded && decision.tier === "high") {
				decision.tier = "medium";
				decision.phase = "implementation";
				decision.reasoning = `Budget exceeded. Downgraded classifier decision to medium. (Original: ${decision.reasoning})`;
				decision.isBudgetForced = true;
			}
		}
	}

	// 4. Image attachment upgrade — find lowest tier that supports images
	if (hasImageAttachment(input.context)) {
		const checkTierSupportsImage = (tier: RouterTier): boolean => {
			const models = [
				config.profile[tier].model,
				...(config.profile[tier].fallbacks ?? []),
			];
			return models.some((ref) => {
				try {
					const { provider, modelId } = parseCanonicalModelRef(ref);
					return (
						input.modelRegistry.find(provider, modelId)?.input?.includes(
							"image",
						) ?? false
					);
				} catch {
					return false;
				}
			});
		};

		if (!checkTierSupportsImage(decision.tier)) {
			const tiersToTry: RouterTier[] =
				decision.tier === "low"
					? ["medium", "high"]
					: decision.tier === "medium"
						? ["high"]
						: [];

			for (const t of tiersToTry) {
				if (checkTierSupportsImage(t)) {
					decision = buildRoutingDecision(
						config.profileName,
						config.profile,
						t,
						phaseForTier(t),
						`Forced ${t} tier because the originally routed ${decision.tier} tier does not support image attachments.`,
						config.thinkingOverrides,
						false,
					);
					break;
				}
			}
		}
	}

	return decision;
};
