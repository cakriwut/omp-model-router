import type { Theme } from "@oh-my-pi/pi-coding-agent";
import type {
	RoutingDecision,
	RouterConfig,
} from "../types";
import type { TierCounter, ModelCostEntry } from "../state";

export interface CompressionDiagnostic {
	mode: "progressive" | "static" | "default";
	/** Progressive mode: context tokens estimate vs threshold. */
	contextTokens?: number;
	contextThresholdTokens?: number;
	/** Progressive mode: seconds since last turn vs timeout. */
	secondsSinceLastTurn?: number;
	timeThresholdSeconds?: number;
	/** Static mode: current turn vs freezeAfter. */
	currentTurn?: number;
	freezeAfter?: number;
	/** Default mode: messages in history vs keepLastN. */
	messageCount?: number;
	keepLastN?: number;
}

export interface CompressionUsageInput {
	enabled: boolean;
	requestCount: number;
	totalOriginalChars: number;
	totalCompressedChars: number;
	/** Live diagnostic info shown when no compression has happened yet. */
	diagnostic?: CompressionDiagnostic;
}

export interface ModelRegistryLookup {
	find(provider: string, modelId: string): { cost?: unknown } | undefined;
}

export interface CalibrationUsageInput {
	mode: "telemetry" | "adaptive";
	totalComparisons: number;
	llmCallsAttempted: number;
	llmCallsFailed: number;
	matrix: number[][];
}

export interface UsageReportInput {
	theme: Theme;
	selectedProfile: string;
	profile: RouterConfig["profiles"][string];
	tierCounter: TierCounter;
	modelCosts: Map<string, ModelCostEntry>;
	lastDecision: RoutingDecision | undefined;
	accumulatedCost?: number;
	accumulatedOriginalTokens?: number;
	accumulatedCompressedTokens?: number;
	accumulatedTokensSaved?: number;
	accumulatedCacheReadTokens?: number;
	maxSessionBudget?: number;
	modelRegistry: ModelRegistryLookup;
	compression?: CompressionUsageInput;
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
	const modelUsage: Record<string, { count: number; tier: string; cost: number; inputTokens: number; outputTokens: number }> = {};
	for (const [key, entry] of modelCosts) {
		modelUsage[key] = {
			count: entry.invocations,
			tier: entry.tier,
			cost: entry.cost,
			inputTokens: entry.inputTokens,
			outputTokens: entry.outputTokens,
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
			` ${totalDecisions} decisions`;
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
		barLine = theme.fg("dim", "░".repeat(BAR_WIDTH)) + " 0 decisions";
		labelLine = theme.fg("dim", "no routing history");
	}

	// Per-tier model lines
	const TIERS = ["high", "medium", "low"] as const;
	const modelLines: string[] = [];
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
			modelLines.push(
				`  ${tierColor(tier, tier.toUpperCase().padEnd(8))}${modelId.padEnd(38)}${`${usageCount}x`.padStart(4)}   ${tierCostStr}`,
			);
			if (tierConfig.fallbacks?.length) {
				for (const fb of tierConfig.fallbacks) {
					const fbSlash = fb.indexOf("/");
					const fbId = fbSlash >= 0 ? fb.slice(fbSlash + 1) : fb;
					const fbUsage = modelUsage[fb]?.count ?? 0;
					modelLines.push(`  ${" ".repeat(8)}└ ${fbId.padEnd(36)}${`${fbUsage}x`.padStart(4)}`);
				}
			}
		} catch { /* ignore bad model ref */ }
	}

	const lines = [headerLine, barLine, labelLine, "", ...modelLines];
	if (lastDecision) {
		const triggerSuffix = lastDecision.compressionTriggerReason 
			? ` [${lastDecision.compressionTriggerReason === 'context_size' ? '⟨size⟩' : '⟨expiry⟩'}]`
			: (lastDecision.compressionCacheHit ? ' [cached]' : '');
		lines.push(
			"",
			`Last: ${tierColor(lastDecision.tier, lastDecision.tier)} → ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})${triggerSuffix}`,
		);
	}

	// ── Compression stats ──────────────────────────────────────────────
	const comp = opts.compression;
	if (comp?.enabled) {
		lines.push("");
		if (comp.requestCount > 0) {
			const savingsPct = comp.totalOriginalChars > 0
				? Math.round((1 - comp.totalCompressedChars / comp.totalOriginalChars) * 100)
				: 0;
			// Estimate token savings (conservative: 4 chars/token)
			const savedTokens = Math.round((comp.totalOriginalChars - comp.totalCompressedChars) / 4);
			const savedK = (savedTokens / 1000).toFixed(1);
			lines.push(
				`  ${theme.fg("accent", "TOON")}    ${comp.requestCount} requests compressed | ${theme.fg("success", `↓${savingsPct}%`)} smaller | est. ~${savedK}k tokens saved`,
			);
		} else {
			const d = comp.diagnostic;
			const tag = `  ${theme.fg("accent", "TOON")}    `;
			if (!d) {
				lines.push(`${tag}enabled (no compressions yet)`);
			} else if (d.mode === "progressive") {
				const ctxNow = d.contextTokens ?? 0;
				const ctxMax = d.contextThresholdTokens ?? 0;
				const ctxKNow = (ctxNow / 1000).toFixed(1);
				const ctxKMax = (ctxMax / 1000).toFixed(1);
				const elapsed = d.secondsSinceLastTurn ?? 0;
				const maxElapsed = d.timeThresholdSeconds ?? 0;
				lines.push(
					`${tag}enabled — progressive mode (no triggers yet)`,
					`         context ${ctxKNow}k / ${ctxKMax}k tokens · cache ${elapsed}s / ${maxElapsed}s timeout`,
				);
			} else if (d.mode === "static") {
				const turn = d.currentTurn ?? 0;
				const freeze = d.freezeAfter ?? 0;
				lines.push(
					`${tag}enabled — static mode (freezes at turn ${freeze})`,
					`         current turn ${turn} / ${freeze} — compression freezes when reached`,
				);
			} else {
				const msgs = d.messageCount ?? 0;
				const keep = d.keepLastN ?? 4;
				lines.push(
					`${tag}enabled — default mode (compresses when history > keepLastN)`,
					`         ${msgs} messages in history · keepLastN=${keep} (need at least ${keep + 1})`,
				);
			}
		}
	}

	// ── Accumulated token metrics ──────────────────────────────────────
	if (opts.accumulatedOriginalTokens || opts.accumulatedTokensSaved || opts.accumulatedCacheReadTokens) {
		lines.push("");
		const tokenSavings = opts.accumulatedTokensSaved || 0;
		const cacheTokens = opts.accumulatedCacheReadTokens || 0;
		if (tokenSavings > 0) {
			const savingsK = (tokenSavings / 1000).toFixed(1);
			lines.push(`  ${theme.fg("accent", "Savings")} ~${savingsK}k tokens from TOON compression`);
		}
		if (cacheTokens > 0) {
			const cacheK = (cacheTokens / 1000).toFixed(1);
			lines.push(`  ${theme.fg("accent", "Cache")} 📦${cacheK}k tokens read from cache`);
		}
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
