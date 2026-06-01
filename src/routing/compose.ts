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
import type { SessionScope } from "../state";
import type { RouterState } from "../state";
import { getLastUserText, extractRecentToolCalls, getBucket } from "../utils/messages.js";
import { updateCalibrationMatrix, applyCalibratedTier } from "../calibration/session";
import { setScopedPin, incrementPinPressure, DEFAULT_PIN_PRESSURE_THRESHOLD } from "./pin";
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
	/**
	 * Active session scope — mutated by setScopedPin when a pin-creating event fires.
	 * Optional for backward compat; when absent, scoped pin creation is skipped.
	 */
	scope?: SessionScope;
	/**
	 * Router state — used for the classifier prompt cache (Phase 1).
	 * Optional for backward compat; when absent, cache is bypassed.
	 */
	state?: RouterState;
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
	/** Subset of RouterConfig needed for scoped-pin operations (timeout, floor, pressure threshold). */
	pinConfig?: { pinTimeout?: number; defaultPin?: RouterTier | "auto"; pinPressureThreshold?: number };
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
	// 1. Heuristic decision (honours active pin)
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

	// ── Determine active pin shape once ──────────────────────────────────────
	const activePin = input.pinnedTier ? input.scope?.scopedPin : undefined;
	const isUserPin  = activePin?.source === "user";
	const isSystemPin = !!input.pinnedTier && !!activePin && !isUserPin;

	// ── Pressure lapse: heuristic shadow (always computed for system pins) ───
	//    Computed here so we have it available as a fallback pressure signal
	//    when the classifier is unavailable or skipped by cache.
	let shadowTierForPressure: RouterTier | undefined;
	if (isSystemPin && input.scope && config.pinConfig) {
		const shadowDecision = decideRouting(
			input.context,
			config.profileName,
			config.profile,
			input.previousDecision,
			undefined, // no pin
			config.thinkingOverrides,
			config.phaseBias,
			config.rules,
			input.isBudgetExceeded,
		);
		shadowTierForPressure = shadowDecision.tier;
	}

	// 2. Context trigger — promote tier to the cheapest one whose model can
	//    actually fit the current context. Runs before classifier so the
	//    classifier sees the correct (promoted) phase.
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
					// Cache bust: routing context changed, force classifier re-eval on next eligible turn.
					if (input.state) {
						const s = input.state.scope;
						s.lastClassifierKey = undefined;
						s.lastClassifierVerdict = undefined;
						s.classifierTurnsSinceRun = 0;
					}
				}
			}
		} catch {
			// ignore — fall through with existing decision
		}
	}

	// 3. Classifier — runs unless:
	//    (a) no classifierModel configured,
	//    (b) context-triggered (already promoted by capacity),
	//    (c) rule-matched (hard rule takes precedence),
	//    (d) user pin is active (user explicitly chose — respect it).
	//
	//    System pins do NOT block the classifier. Instead the classifier
	//    verdict is used as the pressure signal: if the classifier disagrees
	//    with the pin for N consecutive turns the pin lapses and the
	//    classifier verdict becomes the routing decision. While the pin
	//    holds, the classifier verdict is recorded into the calibration
	//    matrix but does not change the decision.
	let syncClassifierRan = false;
	let verdict: { tier: RouterTier; reasoning: string } | undefined;
	if (
		config.classifierModel &&
		!isUserPin &&
		!decision.isContextTriggered &&
		!decision.isRuleMatched
	) {
		// ── Compute classifier cache signature ─────────────────────────────
		const lastUserText = getLastUserText(input.context) ?? "";
		const scope = input.state?.scope;
		const userMsgIndex = scope?.userMessagesSeen ?? 0;
		const { counts: toolCounts } = extractRecentToolCalls(input.context);
		const bucket = getBucket(toolCounts);
		const sig = `${lastUserText}|${userMsgIndex}|${bucket}`;

		// ── Cache gate ─────────────────────────────────────────────────────
		const ttlTurns = input.state?.currentConfig.classifierCache?.ttlTurns ?? 20;
		const cacheHit =
			scope !== undefined &&
			scope.lastClassifierKey === sig &&
			scope.lastClassifierVerdict !== undefined &&
			scope.classifierTurnsSinceRun < ttlTurns;

		if (cacheHit && scope) {
			verdict = scope.lastClassifierVerdict;
			scope.classifierTurnsSinceRun += 1;
			syncClassifierRan = true;
		} else {
			const { runClassifier } = await import("./index.js");
			verdict = await runClassifier(
				config.classifierModel,
				input.modelRegistry,
				input.context,
				decision.phase,
				config.debug,
				toolCounts,
			);
			syncClassifierRan = true;
			if (verdict && scope) {
				scope.lastClassifierKey = sig;
				scope.lastClassifierVerdict = verdict;
				scope.classifierTurnsSinceRun = 0;
			}
		}

		if (isSystemPin && input.scope && config.pinConfig) {
			// ── System pin active: classifier feeds pressure lapse ─────────
			// Use classifier verdict as the pressure signal (preferred over
			// heuristic shadow when classifier is available), falling back to
			// heuristic shadow when the classifier returned nothing.
			const pressureTier = verdict?.tier ?? shadowTierForPressure;
			let lapsed = false;
			if (pressureTier !== undefined) {
				const threshold =
					config.pinConfig.pinPressureThreshold ??
					DEFAULT_PIN_PRESSURE_THRESHOLD;
				lapsed = incrementPinPressure(
					input.scope,
					pressureTier,
					threshold,
					config.debug,
				);
			}

			if (lapsed) {
				// Pin lapsed — bust classifier cache and route freely.
				if (input.state) {
					input.state.lastClassifierKey = undefined;
					input.state.lastClassifierVerdict = undefined;
					input.state.classifierTurnsSinceRun = 0;
				}
				// Prefer classifier verdict as the free decision; fall back to
				// heuristic shadow if classifier was unavailable.
				if (verdict) {
					decision = buildRoutingDecision(
						config.profileName,
						config.profile,
						verdict.tier,
						phaseForTier(verdict.tier),
						`Pin lapsed (classifier pressure): ${verdict.reasoning}`,
						config.thinkingOverrides,
						true,
					);
				} else if (shadowTierForPressure !== undefined) {
					// No classifier — use heuristic shadow (pre-computed above)
					decision = decideRouting(
						input.context,
						config.profileName,
						config.profile,
						input.previousDecision,
						undefined,
						config.thinkingOverrides,
						config.phaseBias,
						config.rules,
						input.isBudgetExceeded,
					);
				}
				// Clear pinnedTier for all downstream steps.
				input = { ...input, pinnedTier: undefined };
			} else {
				// Pin still holds — record calibration matrix but keep pinned decision.
				if (verdict && input.calibration && config.calibrationConfig?.enabled) {
					updateCalibrationMatrix(input.calibration, decision.tier, verdict.tier);
				}
				// decision stays as the pinned heuristic output — do not override.
			}
		} else if (!input.pinnedTier) {
			// ── No pin: apply classifier verdict as routing override ────────
			if (verdict) {
				// Record verdict into calibration matrix
				if (input.calibration && config.calibrationConfig?.enabled) {
					updateCalibrationMatrix(input.calibration, decision.tier, verdict.tier);
				}

				decision = buildRoutingDecision(
					config.profileName,
					config.profile,
					verdict.tier,
					phaseForTier(verdict.tier),
					cacheHit
						? `Classifier (cached): ${verdict.reasoning}`
						: `Classifier: ${verdict.reasoning}`,
					config.thinkingOverrides,
					true,
				);
				if (input.isBudgetExceeded && decision.tier === "high") {
					decision.tier = "medium";
					decision.phase = "implementation";
					decision.reasoning = `Budget exceeded. Downgraded classifier decision to medium. (Original: ${decision.reasoning})`;
					decision.isBudgetForced = true;
				}
				// P2 pin for classifier override (only on fresh run, not cache hit)
				if (!cacheHit && input.scope && config.pinConfig) {
					setScopedPin(input.scope, decision.tier, "classifier", config.pinConfig);
				}
			} else {
				// Classifier failed (MISS path only) — try matrix calibration as fallback
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
				decision.reasoning = `Classifier unavailable, using heuristic: ${decision.reasoning}`;
			}
		}
		// isUserPin branch falls through here — classifier was not run (blocked above)
	} else if (isSystemPin && input.scope && config.pinConfig && shadowTierForPressure !== undefined) {
		// ── System pin active, no classifier configured: heuristic shadow ──
		// drives pressure lapse (original behaviour preserved as fallback).
		const threshold =
			config.pinConfig.pinPressureThreshold ??
			DEFAULT_PIN_PRESSURE_THRESHOLD;
		const lapsed = incrementPinPressure(
			input.scope,
			shadowTierForPressure,
			threshold,
			config.debug,
		);
		if (lapsed) {
			if (input.state) {
				input.state.lastClassifierKey = undefined;
				input.state.lastClassifierVerdict = undefined;
				input.state.classifierTurnsSinceRun = 0;
			}
			// Re-route freely using shadow (no classifier available)
			decision = decideRouting(
				input.context,
				config.profileName,
				config.profile,
				input.previousDecision,
				undefined,
				config.thinkingOverrides,
				config.phaseBias,
				config.rules,
				input.isBudgetExceeded,
			);
			input = { ...input, pinnedTier: undefined };
		}
	}

	// ── P2 pin for Rule J and rule-match (heuristic-created sticky decisions) ──
	if (input.scope && !input.pinnedTier && config.pinConfig) {
		const isRuleJ = decision.reasoning.includes("planning-phase bias");
		const isRuleMatch = decision.isRuleMatched === true;
		if (isRuleJ) {
			setScopedPin(input.scope, decision.tier, "heuristic", config.pinConfig);
		} else if (isRuleMatch) {
			setScopedPin(input.scope, decision.tier, "rule", config.pinConfig);
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
