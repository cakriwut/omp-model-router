import { streamSimple, type Context } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseCanonicalModelRef } from "./config";
import { buildClassifierPrompt, parseClassifierOutput } from "./calibration/classifier-utils";
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

/**
 * Get recent user prompts only (for classifier context)
 * Excludes assistant responses and tool results to reduce noise
 */
export const getRecentUserText = (
	context: Context,
	limit = 4,
): string => {
	return context.messages
		.filter((message) => message.role === "user")
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

// ─── LLM classifier ───────────────────────────────────────────────────────────

/** Timeout for the synchronous classifier LLM call (prevents indefinite blocking) */
const SYNC_CLASSIFIER_TIMEOUT_MS = 10_000;

export const runClassifier = async (
	classifierModelRef: string,
	modelRegistry: ExtensionContext["modelRegistry"],
	context: Context,
	currentPhase?: RouterPhase,
	debug = false,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
	const classifierContext: Context = {
		messages: [
			{ role: "user", content: buildClassifierPrompt(context, currentPhase), timestamp: Date.now() },
		],
	};

	try {
		const { provider, modelId } = parseCanonicalModelRef(classifierModelRef);
		const model = modelRegistry.find(provider, modelId);
		if (!model) {
			if (debug) {
				console.warn(`[model-router] Classifier model not found: ${provider}/${modelId}`);
			}
			return undefined;
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			if (debug) {
				console.warn(`[model-router] Classifier model API key missing: ${provider}/${modelId}`);
			}
			return undefined;
		}
		const headers = model.headers;
		// Badge-style log: ⚡ classifier → nova-micro (sync·adaptive)
		const shortName = modelId.split('.').pop()?.replace(/-v\d+:\d+$/, '') || modelId;
		if (debug) {
			console.log(`⚡ classifier → ${shortName} (sync·adaptive)`);
		}

		// Race classifier stream against a hard timeout to prevent blocking
		const ac = new AbortController();
		const timeout = setTimeout(() => ac.abort(), SYNC_CLASSIFIER_TIMEOUT_MS);

		try {
			const stream = streamSimple(model, classifierContext, {
				apiKey,
				headers,
				signal: ac.signal,
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

			const result = parseClassifierOutput(fullText);

			// Log decision: ⚡ classifier → nova-micro (sync·adaptive) → high
			if (debug && result) {
				console.log(`⚡ classifier → ${shortName} (sync·adaptive) → ${result.tier}`);
			}

			return result;
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		if (debug) {
			console.warn(
				`[model-router] Classifier failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return undefined;
	}
};
// ─── Model-capacity-aware tier promotion ─────────────────────────────────────

const TIER_ORDER: readonly RouterTier[] = ["low", "medium", "high"];
const RESPONSE_HEADROOM_TOKENS = 8192;

interface PromotedTier {
	tier: RouterTier;
	fromCapacity: number;
	toCapacity: number;
	fits: boolean;
}

/**
 * Resolve a tier's model and return its usable input capacity (contextWindow
 * minus response headroom). Returns undefined if the model can't be resolved.
 */
const tierUsableCapacity = (
	tier: RouterTier,
	profile: RouterProfile,
	registry: ExtensionContext["modelRegistry"],
): number | undefined => {
	const ref = profile[tier]?.model;
	if (!ref) return undefined;
	const slash = ref.indexOf("/");
	if (slash === -1) return undefined;
	const provider = ref.slice(0, slash);
	const modelId = ref.slice(slash + 1);
	const model = registry.find(provider, modelId);
	if (!model || !model.contextWindow) return undefined;
	const headroom = Math.max(model.maxTokens ?? 0, RESPONSE_HEADROOM_TOKENS);
	return Math.max(0, model.contextWindow - headroom);
};

/**
 * Find the cheapest tier (low → medium → high) whose model can fit `tokens`
 * with response headroom. Returns the promoted tier or undefined if the
 * current tier already fits or no tier fits.
 */
const promoteForContextCapacity = (
	currentTier: RouterTier,
	tokens: number,
	profile: RouterProfile,
	registry: ExtensionContext["modelRegistry"],
): PromotedTier | undefined => {
	const currentCapacity = tierUsableCapacity(currentTier, profile, registry);
	if (currentCapacity === undefined) return undefined; // unresolvable; leave alone
	if (tokens <= currentCapacity) return undefined; // current tier fits

	const startIdx = TIER_ORDER.indexOf(currentTier) + 1;
	for (let i = startIdx; i < TIER_ORDER.length; i++) {
		const candidate = TIER_ORDER[i];
		const cap = tierUsableCapacity(candidate, profile, registry);
		if (cap !== undefined && tokens <= cap) {
			return { tier: candidate, fromCapacity: currentCapacity, toCapacity: cap, fits: true };
		}
	}
	// No tier fits; promote to highest tier with biggest capacity (best-effort).
	let best: PromotedTier | undefined;
	for (let i = startIdx; i < TIER_ORDER.length; i++) {
		const cap = tierUsableCapacity(TIER_ORDER[i], profile, registry);
		if (cap === undefined) continue;
		if (!best || cap > best.toCapacity) {
			best = { tier: TIER_ORDER[i], fromCapacity: currentCapacity, toCapacity: cap, fits: false };
		}
	}
	return best;
};

// ─── resolveRouting — composites heuristic + all overrides ───────────────────
export interface RoutingInput {
	context: Context;
	previousDecision: RoutingDecision | undefined;
	pinnedTier?: RouterTier;
	isBudgetExceeded: boolean;
	modelRegistry: ExtensionContext["modelRegistry"];
	lastExtensionContext?: ExtensionContext;
	calibration?: import("./calibration/types").SessionCalibration;
}

export interface RoutingConfig {
	profileName: string;
	profile: RouterProfile;
	thinkingOverrides?: RouterThinkingByTier;
	phaseBias: number;
	rules?: RoutingRule[];
	classifierModel?: string;
	debug?: boolean;
	calibrationConfig?: import("./calibration/types").CalibrationConfig;
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

	// 2. Context trigger — promote tier to the cheapest one whose model can
	//    actually fit the current context. Static thresholds are wrong because
	//    each tier's model has its own contextWindow (e.g. Haiku 200k vs
	//    Sonnet 200k vs Nova Micro 128k). We require headroom = max(maxTokens, 8k)
	//    so the response has room to generate.
	if (decision.tier !== "high" && input.lastExtensionContext) {
		try {
			const usage = await input.lastExtensionContext.getContextUsage();
			const tokens = usage?.tokens ?? 0;
			if (tokens > 0) {
				const promoted = promoteForContextCapacity(
					decision.tier,
					tokens,
					config.profile,
					input.modelRegistry,
				);
				if (promoted && promoted.tier !== decision.tier) {
					decision = buildRoutingDecision(
						config.profileName,
						config.profile,
						promoted.tier,
						decision.phase,
						promoted.fits
							? `Context (${tokens} tok) exceeds ${decision.tier} capacity (${promoted.fromCapacity} tok). Promoted ${decision.tier}→${promoted.tier} (cap ${promoted.toCapacity}).`
							: `Context (${tokens} tok) overflows every tier; ${promoted.tier} has biggest capacity (${promoted.toCapacity} tok) — compression required.`,
						config.thinkingOverrides,
						false,
					);
					decision.isContextTriggered = true;
				}
			}
		} catch (_e) {
			// ignore — fall through with existing decision
		}
	}
	// 3. Classifier override — only when not pinned, context-triggered, or rule-matched
	let syncClassifierRan = false;
	let syncClassifierVerdict: { tier: RouterTier; reasoning: string } | undefined;
	
	if (
		config.classifierModel &&
		!input.pinnedTier &&
		!decision.isContextTriggered &&
		!decision.isRuleMatched
	) {
		syncClassifierVerdict = await runClassifier(
			config.classifierModel,
			input.modelRegistry,
			input.context,
			decision.phase, // Use current heuristic decision's phase, not previous
			config.debug,
		);
		syncClassifierRan = true;
		
		if (syncClassifierVerdict) {
			// Record sync classifier verdict into matrix
			if (input.calibration && config.calibrationConfig?.enabled) {
				const { updateCalibrationMatrix } = await import("./calibration/session");
				updateCalibrationMatrix(input.calibration, decision.tier, syncClassifierVerdict.tier);
			}
			
			decision = buildRoutingDecision(
				config.profileName,
				config.profile,
				syncClassifierVerdict.tier,
				phaseForTier(syncClassifierVerdict.tier),
				`Classifier: ${syncClassifierVerdict.reasoning}`,
				config.thinkingOverrides,
				true,
			);
			if (input.isBudgetExceeded && decision.tier === "high") {
				decision.tier = "medium";
				decision.phase = "implementation";
				decision.reasoning = `Budget exceeded. Downgraded classifier decision to medium. (Original: ${decision.reasoning})`;
				decision.isBudgetForced = true;
			}
		} else {
			// Classifier failed — try matrix calibration as fallback
			if (input.calibration && config.calibrationConfig?.enabled) {
				const { applyCalibratedTier } = await import("./calibration/session");
				const calibratedTier = applyCalibratedTier(
					decision.tier,
					input.calibration,
					config.calibrationConfig,
				);
				if (calibratedTier !== decision.tier) {
					decision = buildRoutingDecision(
						config.profileName,
						config.profile,
						calibratedTier,
						phaseForTier(calibratedTier),
						`Calibrated: heuristic ${decision.tier} → ${calibratedTier} (matrix-based override)`,
						config.thinkingOverrides,
						false,
					);
				}
			}
			
			// Mark decision to indicate classifier fallback
			decision.reasoning = `Classifier unavailable, using heuristic: ${decision.reasoning}`;
		}
	}
	
	// Attach metadata for async spawn decision
	(decision as any).syncClassifierRan = syncClassifierRan;

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
			// Determine tiers to try; skip high if budget is exceeded
			const tiersToTry: RouterTier[] =
				decision.tier === "low"
					? (input.isBudgetExceeded ? ["medium"] : ["medium", "high"])
					: decision.tier === "medium"
						? (input.isBudgetExceeded ? [] : ["high"])
						: [];

			for (const t of tiersToTry) {
				if (checkTierSupportsImage(t)) {
					const prevBudgetForced = decision.isBudgetForced;
					decision = buildRoutingDecision(
						config.profileName,
						config.profile,
						t,
						phaseForTier(t),
						`Forced ${t} tier because the originally routed ${decision.tier} tier does not support image attachments.`,
						config.thinkingOverrides,
						false,
					);
					// Preserve budget enforcement flag from prior decision
					if (prevBudgetForced) decision.isBudgetForced = true;
					break;
				}
			}

			// If no tier with image support found and budget exceeded, stay at current tier
			// (routing proceeds without image capability rather than exceeding budget)
		}
	}

	return decision;
};
