/**
 * Tier resolution and routing composition logic.
 * Orchestrates heuristic + context capacity + classifier + image upgrade.
 */

import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseCanonicalModelRef } from "../config";
import type {
	RouterTier,
	RouterProfile,
	RoutingDecision,
	RoutingRule,
	RouterThinkingByTier,
} from "../types";
import type { SessionCalibration, CalibrationConfig } from "../calibration/types";
import { updateCalibrationMatrix, applyCalibratedTier } from "../calibration/session";
import { hasImageAttachment } from "./text";
import { decideRouting, buildRoutingDecision, phaseForTier } from "./heuristic";

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
	calibration?: SessionCalibration;
}

export interface RoutingConfig {
	profileName: string;
	profile: RouterProfile;
	thinkingOverrides?: RouterThinkingByTier;
	phaseBias: number;
	rules?: RoutingRule[];
	classifierModel?: string | string[];
	debug?: boolean;
	calibrationConfig?: CalibrationConfig;
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
		} catch {
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
		const { runClassifier } = await import("./index.js");
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
	
	// Attach metadata for async spawn decision (use type assertion for internal metadata)
	(decision as RoutingDecision & { syncClassifierRan?: boolean }).syncClassifierRan = syncClassifierRan;

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
