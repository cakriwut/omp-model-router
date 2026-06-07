import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type {
	RoutingDecision,
	RouterConfig,
} from "../types";
import type { TierCounter, ModelCostEntry } from "../state";

export interface ModelRegistryLookup {
	find(provider: string, modelId: string): { cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null } | undefined;
}

export interface CalibrationUsageInput {
	mode: "telemetry" | "adaptive";
	totalComparisons: number;
	llmCallsAttempted: number;
	llmCallsFailed: number;
	matrix: number[][];
	/** Fresh (non-cached) classifier LLM calls made in this session. */
	classifierInvocations: number;
	/** Classifier cache hits in this session. */
	classifierCacheHits: number;
}

export interface UsageReportInput {
	theme: Theme;
	selectedProfile: string;
	profile: RouterConfig["profiles"][string];
	tierCounter: TierCounter;
	modelCosts: Map<string, ModelCostEntry>;
	lastDecision: RoutingDecision | undefined;
	accumulatedCost?: number;
	/** Sum of accumulatedCost across all active session scopes (root + in-flight children). For report display only — budget enforcement is per-session. */
	treeCost?: number;
	maxSessionBudget?: number;
	modelRegistry: ModelRegistryLookup;
	calibration?: CalibrationUsageInput;
}

/**
 * Render the /router usage report — stacked tier distribution bar,
 * per-model usage counts and tracked costs. Co-located with other
 * format helpers so widget and usage display stay in sync.
 */
export const renderUsageReport = (opts: UsageReportInput): string => {
	const {
		theme,
		selectedProfile,
		profile,
		tierCounter,
		modelCosts,
		lastDecision,
		accumulatedCost,
		maxSessionBudget,
		modelRegistry,
	} = opts;
	const BAR_WIDTH = 48;

	const tierColor = (tier: string, text: string): string => {
		if (tier === "high") return theme.fg("success", text);
		if (tier === "medium") return theme.fg("warning", text);
		return theme.fg("dim", text);
	};

	// Tier distribution from counter (independent of cost)
	const tierCounts = { ...tierCounter };
	const totalDecisions = tierCounts.high + tierCounts.medium + tierCounts.low;

	// Model cost breakdown from modelCosts map
	// Model cost breakdown from modelCosts map
	const modelUsage: Record<string, { count: number; tier: string; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> = {};
	for (const [key, entry] of modelCosts) {
		modelUsage[key] = {
			count: entry.invocations,
			tier: entry.tier,
			cost: entry.cost,
			inputTokens: entry.inputTokens,
			outputTokens: entry.outputTokens,
			cacheReadTokens: entry.cacheReadTokens,
			cacheWriteTokens: entry.cacheWriteTokens,
		};
	}

	// Header line: profile + cost
	// Use authoritative accumulatedCost if provided (avoids undercount from
	// debug-history cap). Debug-history per-model breakdown is still shown.
	const sessionCost = Object.values(modelUsage).reduce((s, m) => s + m.cost, 0);
	const headerCost = accumulatedCost ?? sessionCost;
	const costStr = maxSessionBudget
		? `$${headerCost.toFixed(4)} / $${maxSessionBudget.toFixed(2)}`
		: `$${headerCost.toFixed(4)}`;
	const headerLeft = `Router: ${selectedProfile}`;
	const headerPad = Math.max(1, BAR_WIDTH + 2 - headerLeft.length - costStr.length);
	const headerLine = `${headerLeft}${" ".repeat(headerPad)}${costStr}`;

	// Tree-cost line: only shown when there are active child sessions contributing
	const treeCost = opts.treeCost;
	const hasTreeCost = treeCost !== undefined && treeCost > headerCost + 0.000001;
	const treeCostLine = hasTreeCost
		? theme.fg("dim", `Tree: $${treeCost.toFixed(4)} total (session + ${(treeCost - headerCost).toFixed(4)} children)`)
		: undefined;

	// Stacked distribution bar + label line
	let barLine: string;
	let labelLine: string;
	if (totalDecisions > 0) {
		const highWidth = Math.round((tierCounts.high / totalDecisions) * BAR_WIDTH);
		const mediumWidth = Math.round((tierCounts.medium / totalDecisions) * BAR_WIDTH);
		const lowWidth = Math.max(0, BAR_WIDTH - highWidth - mediumWidth);
		barLine =
			tierColor("high", "█".repeat(highWidth)) +
			tierColor("medium", "█".repeat(mediumWidth)) +
			tierColor("low", "█".repeat(lowWidth)) +
			` ${totalDecisions} routing decisions`;
		const highPct = Math.round((tierCounts.high / totalDecisions) * 100);
		const medPct = Math.round((tierCounts.medium / totalDecisions) * 100);
		const lowPct = Math.round((tierCounts.low / totalDecisions) * 100);
		
		// Build label line segment-by-segment, skipping zero-width tiers
		let labelParts: string[] = [];
		if (highWidth > 0) {
			const highLabel = `high ${highPct}%`;
			const hlPad = Math.max(0, Math.floor((highWidth - highLabel.length) / 2));
			const hlEnd = Math.max(0, highWidth - hlPad - highLabel.length);
			labelParts.push(" ".repeat(hlPad) + tierColor("high", highLabel) + " ".repeat(hlEnd));
		}
		if (mediumWidth > 0) {
			const medLabel = `medium ${medPct}%`;
			const mlPad = Math.max(0, Math.floor((mediumWidth - medLabel.length) / 2));
			const mlEnd = Math.max(0, mediumWidth - mlPad - medLabel.length);
			labelParts.push(" ".repeat(mlPad) + tierColor("medium", medLabel) + " ".repeat(mlEnd));
		}
		if (lowWidth > 0) {
			const lowLabel = `low ${lowPct}%`;
			const llPad = Math.max(0, Math.floor((lowWidth - lowLabel.length) / 2));
			labelParts.push(" ".repeat(llPad) + tierColor("low", lowLabel));
		}
		labelLine = labelParts.join("");
	} else {
		barLine = theme.fg("dim", "░".repeat(BAR_WIDTH)) + " 0 routing decisions";
		labelLine = theme.fg("dim", "no routing history");
	}

	// Per-tier model lines
	// Source of truth: modelCosts (all models seen this session from JSONL scan).
	// Profile config is annotation-only — supplies tier label and fallback hierarchy.
	// Models removed mid-session still appear in modelCosts; they render in an orphan block.
	const TIERS = ["high", "medium", "low"] as const;
	const modelLines: string[] = [];

	// Track which model keys have been rendered (to identify orphans afterwards)
	const renderedKeys = new Set<string>();

	for (const tier of TIERS) {
		const tierConfig = profile[tier];
		try {
			const slashIdx = tierConfig.model.indexOf("/");
			const modelId = slashIdx >= 0 ? tierConfig.model.slice(slashIdx + 1) : tierConfig.model;
			const provider = slashIdx >= 0 ? tierConfig.model.slice(0, slashIdx) : "";
			const usageCount = modelUsage[tierConfig.model]?.count ?? 0;
			const trackedCost = modelUsage[tierConfig.model]?.cost ?? 0;
			const registeredModel = provider ? modelRegistry.find(provider, modelId) : undefined;
			const tierCostStr = registeredModel?.cost ? `$${trackedCost.toFixed(4)}` : "";
			// Skip primary row if this model was already rendered as a fallback of a higher tier.
			// Still mark it rendered and render its own fallbacks below.
			if (!renderedKeys.has(tierConfig.model)) {
				modelLines.push(
					`  ${tierColor(tier, tier.toUpperCase().padEnd(8))}${modelId.padEnd(38)}${`${usageCount}x`.padStart(4)}   ${tierCostStr}`,
				);
				renderedKeys.add(tierConfig.model);
			}
			if (tierConfig.fallbacks?.length) {
				for (const fb of tierConfig.fallbacks) {
					const fbSlash = fb.indexOf("/");
					const fbId = fbSlash >= 0 ? fb.slice(fbSlash + 1) : fb;
					const fbUsage = modelUsage[fb]?.count ?? 0;
					// Skip fallback row if already rendered (e.g. this model is primary in another tier)
					if (!renderedKeys.has(fb)) {
						modelLines.push(`  ${" ".repeat(8)}└ ${fbId.padEnd(36)}${`${fbUsage}x`.padStart(4)}`);
						renderedKeys.add(fb);
					}
				}
			}
		} catch { /* ignore bad model ref */ }
	}

	// Orphan block: models used this session but no longer in the profile.
	// Entries with tier="classifier" are excluded here — they go in the classifier block below.
	const orphans = Object.entries(modelUsage).filter(
		([key, u]) => !renderedKeys.has(key) && u.tier !== "classifier",
	);
	if (orphans.length > 0) {
		modelLines.push("", theme.fg("dim", "  removed from profile:"));
		for (const [key, usage] of orphans) {
			const slashIdx = key.indexOf("/");
			const modelId = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
			const provider = slashIdx >= 0 ? key.slice(0, slashIdx) : "";
			const registeredModel = provider ? modelRegistry.find(provider, modelId) : undefined;
			const costStr = registeredModel?.cost ? `$${usage.cost.toFixed(4)}` : "";
			modelLines.push(
				`  ${theme.fg("dim", "?".padEnd(8))}${modelId.padEnd(38)}${`${usage.count}x`.padStart(4)}   ${costStr}`,
			);
		}
	}

	// Classifier block: entries with tier="classifier" (recorded by recordClassifierCost)
	const classifierEntries = Object.entries(modelUsage).filter(([, u]) => u.tier === "classifier");
	if (classifierEntries.length > 0 || (opts.calibration && (opts.calibration.classifierInvocations + opts.calibration.classifierCacheHits) > 0)) {
		const totalCalls = opts.calibration ? opts.calibration.classifierInvocations + opts.calibration.classifierCacheHits : 0;
		const cachedCalls = opts.calibration ? opts.calibration.classifierCacheHits : 0;
		modelLines.push("", theme.fg("dim", "  classifier:"));
		if (classifierEntries.length > 0) {
			for (const [key, usage] of classifierEntries) {
				const slashIdx = key.indexOf("/");
				const modelId = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
				const provider = slashIdx >= 0 ? key.slice(0, slashIdx) : "";
				const registeredModel = provider ? modelRegistry.find(provider, modelId) : undefined;
				const costStr = registeredModel?.cost ? `$${usage.cost.toFixed(4)}` : "";
				const cacheNote = cachedCalls > 0 ? `  (${totalCalls} calls, ${cachedCalls} cached)` : `  (${totalCalls} calls)`;
				modelLines.push(
					`  ${theme.fg("dim", "·".padEnd(8))}${modelId.padEnd(38)}${`${usage.count}x`.padStart(4)}   ${costStr}${theme.fg("dim", cacheNote)}`,
				);
			}
		} else {
			// calibration enabled but no cost data yet (model has no rates or hasn't run)
			const cacheNote = cachedCalls > 0 ? `${totalCalls} calls, ${cachedCalls} cached` : `${totalCalls} calls`;
			modelLines.push(`  ${theme.fg("dim", "·".padEnd(8))}${"(classifier)".padEnd(38)}${" ".repeat(4)}   ${theme.fg("dim", cacheNote)}`);
		}
	}

	const lines = [headerLine, ...(treeCostLine ? [treeCostLine] : []), barLine, labelLine, "", ...modelLines];
	if (lastDecision) {
		lines.push(
			"",
			`Last: ${tierColor(lastDecision.tier, lastDecision.tier)} → ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})`,
		);
	}

	// ── Savings simulator ──────────────────────────────────────────────
	// Reprojects actual token counts through each tier's model prices.
	// Input tokens are identical regardless of model; output tokens may differ in
	// practice but are treated as fixed here — this is an approximation, not an invoice.
	const hasCostRates = (modelRef: string): boolean => {
		const slash = modelRef.indexOf("/");
		if (slash < 0) return false;
		return !!modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1))?.cost;
	};
	const repriceTokens = (
		inputTokens: number,
		outputTokens: number,
		cacheReadTokens: number,
		cacheWriteTokens: number,
		modelRef: string,
	): number | undefined => {
		const slash = modelRef.indexOf("/");
		if (slash < 0) return undefined;
		const reg = modelRegistry.find(modelRef.slice(0, slash), modelRef.slice(slash + 1));
		const c = reg?.cost;
		if (!c) return undefined;
		return (
			inputTokens      * (c.input      / 1_000_000) +
			outputTokens     * (c.output     / 1_000_000) +
			cacheReadTokens  * (c.cacheRead  / 1_000_000) +
			cacheWriteTokens * (c.cacheWrite / 1_000_000)
		);
	};

	// Aggregate all non-classifier invocations' tokens (profile models + orphans)
	// Classifier cost is excluded — it is an overhead, not a routable turn cost.
	const routableCosts = Object.values(modelUsage).filter(u => u.tier !== "classifier");
	const hasTokenData = routableCosts.some(u => u.inputTokens > 0 || u.outputTokens > 0);

	// Relax savings gate: if a tier's primary model has no cost rates, walk its fallbacks
	// to find a priced substitute. This handles profiles where the high-tier primary is
	// not yet in the OMP registry (e.g. newly launched models).
	const resolveRepricingModel = (tierKey: "high" | "medium" | "low"): string | undefined => {
		const tc = profile[tierKey];
		if (hasCostRates(tc.model)) return tc.model;
		return tc.fallbacks?.find(hasCostRates);
	};
	const highRef   = resolveRepricingModel("high");
	const mediumRef = resolveRepricingModel("medium");
	const lowRef    = resolveRepricingModel("low");

	if (hasTokenData && highRef && mediumRef && lowRef) {
		let allHighCost = 0;
		let allMediumCost = 0;
		let allLowCost = 0;
		for (const u of routableCosts) {
			const h = repriceTokens(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, highRef);
			const m = repriceTokens(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, mediumRef);
			const l = repriceTokens(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, lowRef);
			if (h !== undefined) allHighCost += h;
			if (m !== undefined) allMediumCost += m;
			if (l !== undefined) allLowCost += l;
		}
		// Router cost = actual JSONL sum (headerCost), excluding classifier overhead
		const classifierCost = classifierEntries.reduce((s, [, u]) => s + u.cost, 0);
		const routerCost = headerCost - classifierCost;

		const savingPct = (cost: number): string =>
			allHighCost > 0 ? `−${Math.round((1 - cost / allHighCost) * 100)}%` : "n/a";

		lines.push(
			"",
			`  ${theme.fg("accent", `Savings vs all-high ($${allHighCost.toFixed(4)} baseline):`)}`,
			`  ${"all-high".padEnd(12)}$${allHighCost.toFixed(4)}   ${theme.fg("dim", "─")}`,
			`  ${"all-medium".padEnd(12)}$${allMediumCost.toFixed(4)}   ${theme.fg("dim", savingPct(allMediumCost))}`,
			`  ${"all-low".padEnd(12)}$${allLowCost.toFixed(4)}   ${theme.fg("dim", savingPct(allLowCost))}`,
			`  ${theme.fg("accent", "router".padEnd(12))}$${routerCost.toFixed(4)}   ${theme.fg("accent", savingPct(routerCost))}  ←`,
		);
	}

	// ── Calibration stats ──────────────────────────────────────────────
	if (opts.calibration) {
		const cal = opts.calibration;
		if (cal.totalComparisons > 0) {
			const mismatchRate = cal.llmCallsAttempted > 0
				? (cal.totalComparisons - (cal.matrix[0][0] + cal.matrix[1][1] + cal.matrix[2][2])) / cal.totalComparisons
				: 0;
			const agreementRate = 1 - mismatchRate;
			const agreementPct = Math.round(agreementRate * 100);
			const failureRate = cal.llmCallsAttempted > 0
				? cal.llmCallsFailed / cal.llmCallsAttempted
				: 0;

			lines.push("");
			lines.push(
				`  ${theme.fg("accent", "Calibration")} ${cal.totalComparisons} comparisons | ${theme.fg(agreementPct >= 75 ? "success" : "warning", `${agreementPct}% agreement`)} | ${cal.llmCallsAttempted} LLM calls (${cal.llmCallsFailed} failed)`,
			);

			if (failureRate > 0.5) {
				lines.push(
					`               ${theme.fg("warning", `⚠ High failure rate (${Math.round(failureRate * 100)}%) — check classifierModel config`)}`,
				);
			}
		} else {
			lines.push("");
			lines.push(`  ${theme.fg("accent", "Calibration")} enabled (mode: ${cal.mode}) — no comparisons yet`);
		}
	}

	return lines.join("\n");
};
