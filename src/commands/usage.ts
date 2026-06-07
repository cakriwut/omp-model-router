import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState, ModelCostEntry } from "../state";
import type { RouterConfig } from "../types";
import { ROUTER_TIERS } from "../config";
import { renderUsageReport } from "../ui";

function scanFile(path: string, totals: Map<string, ModelCostEntry>): void {
	try {
		const lines = readFileSync(path, "utf8").split("\n");
		for (const line of lines) {
			if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			const msg = obj?.message;
			if (msg?.role !== "assistant" || !msg?.usage) continue;
			if (msg.provider === "router") continue;
			const key = `${msg.provider ?? "?"}/${msg.model ?? "?"}`;
			const u = msg.usage;
			const cost = u.cost?.total ?? 0;
			const existing = totals.get(key);
			if (existing) {
				existing.invocations++;
				existing.inputTokens += u.input ?? 0;
				existing.outputTokens += u.output ?? 0;
				existing.cacheReadTokens += u.cacheRead ?? 0;
				existing.cacheWriteTokens += u.cacheWrite ?? 0;
				existing.cost += cost;
			} else {
				totals.set(key, {
					model: key,
					tier: "",
					invocations: 1,
					inputTokens: u.input ?? 0,
					outputTokens: u.output ?? 0,
					cacheReadTokens: u.cacheRead ?? 0,
					cacheWriteTokens: u.cacheWrite ?? 0,
					cost,
				});
			}
		}
	} catch {
		// silently swallow errors
	}
}

/**
 * Scan classifierPrompt.jsonl for classifier model costs.
 * Each line has { model, verdict: { classifierUsage: { inputTokens, outputTokens, ... , cost } } }.
 * Returns entries with tier="classifier" pre-set.
 */
function scanClassifierLog(path: string, totals: Map<string, ModelCostEntry>): void {
	try {
		const lines = readFileSync(path, "utf8").split("\n");
		for (const line of lines) {
			if (!line.includes('"classifierUsage"')) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const model = obj.model;
			if (typeof model !== "string") continue;
			const verdict = obj.verdict as Record<string, unknown> | null | undefined;
			const u = verdict?.classifierUsage as Record<string, number> | null | undefined;
			if (!u) continue;
			const cost = u.cost ?? 0;
			const existing = totals.get(model);
			if (existing) {
				existing.invocations++;
				existing.inputTokens  += u.inputTokens ?? 0;
				existing.outputTokens += u.outputTokens ?? 0;
				existing.cacheReadTokens  += u.cacheReadTokens ?? 0;
				existing.cacheWriteTokens += u.cacheWriteTokens ?? 0;
				existing.cost += cost;
			} else {
				totals.set(model, {
					model,
					tier: "classifier",
					invocations: 1,
					inputTokens: u.inputTokens ?? 0,
					outputTokens: u.outputTokens ?? 0,
					cacheReadTokens: u.cacheReadTokens ?? 0,
					cacheWriteTokens: u.cacheWriteTokens ?? 0,
					cost,
				});
			}
		}
	} catch {
		// silently swallow errors
	}
}

export function scanSessionTree(sessionFile: string): Map<string, ModelCostEntry> {
	const totals = new Map<string, ModelCostEntry>();
	scanFile(sessionFile, totals);
	const childDir = sessionFile.endsWith(".jsonl")
		? sessionFile.slice(0, -".jsonl".length)
		: sessionFile;
	if (existsSync(childDir)) {
		for (const f of readdirSync(childDir)) {
			if (!f.endsWith(".jsonl")) continue;
			const fullPath = join(childDir, f);
			if (f === "classifierPrompt.jsonl") {
				scanClassifierLog(fullPath, totals);
			} else {
				scanFile(fullPath, totals);
			}
		}
	}
	return totals;
}

function resolveModelTier(
	modelKey: string,
	profile: RouterConfig["profiles"][string],
): string {
	for (const tier of ROUTER_TIERS) {
		const tc = profile[tier];
		if (tc.model === modelKey || tc.fallbacks?.includes(modelKey)) return tier;
	}
	return "";
}

export const handleUsage = (
	state: RouterState,
) => async (_args: string[], ctx: ExtensionContext) => {
	const profile = state.currentConfig.profiles[state.selectedProfile];
	if (!profile) {
		ctx.ui.notify("No active router profile.", "error");
		return;
	}

	// ── Counter A: routing decisions (in-memory, includes child rollup) ──────────
	const reportTierCounter = state.tierCounter;

	// ── Counter B: true per-model cost from session JSONL tree ───────────────────
	// Scans parent .jsonl + all child .jsonl files in the sibling artifact dir.
	// Authoritative: includes all turns regardless of whether the router proxied them.
	// Falls back to in-memory scope when no session file exists (tests, in-memory mode).
	let reportModelCosts: Map<string, ModelCostEntry>;
	let reportTotalCost: number;

	const sessionFile = (ctx.sessionManager as any).getSessionFile?.();
	if (sessionFile && existsSync(sessionFile)) {
		reportModelCosts = scanSessionTree(sessionFile);
		// Build a set of classifier model refs from config for O(1) lookup
		const rawClassifierModel = state.currentConfig.calibration?.classifierModel;
		const classifierRefs = new Set<string>(
			rawClassifierModel
				? (Array.isArray(rawClassifierModel) ? rawClassifierModel : [rawClassifierModel])
				: [],
		);
		for (const entry of reportModelCosts.values()) {
			if (classifierRefs.has(entry.model)) {
				entry.tier = "classifier";
			} else {
				entry.tier = resolveModelTier(entry.model, profile);
			}
		}
		// Classifier costs are now sourced from classifierPrompt.jsonl (scanned by
		// scanSessionTree → scanClassifierLog). In-memory merge is no longer needed.
		reportTotalCost = [...reportModelCosts.values()].reduce((s, e) => s + e.cost, 0);
	} else {
		// Fallback: no session file (in-memory mode, tests)
		reportModelCosts = state.modelCosts;
		reportTotalCost = state.accumulatedCost;
	}

	const report = renderUsageReport({
		theme: ctx.ui.theme,
		selectedProfile: state.selectedProfile,
		profile,
		tierCounter: reportTierCounter,
		modelCosts: reportModelCosts,
		lastDecision: state.lastDecision,
		accumulatedCost: reportTotalCost,
		treeCost: state.totalCost,
		maxSessionBudget: state.currentConfig.maxSessionBudget,
		modelRegistry: ctx.modelRegistry,
		calibration: state.calibration
			? {
					mode: state.currentConfig.calibration?.mode ?? "telemetry",
					totalComparisons: state.calibration.totalComparisons,
					llmCallsAttempted: state.calibration.llmCallsAttempted,
					llmCallsFailed: state.calibration.llmCallsFailed,
					matrix: state.calibration.matrix,
					classifierInvocations: state.classifierInvocations,
					classifierCacheHits: state.classifierCacheHits,
				}
			: undefined,
	});
	ctx.ui.notify(report, "info");
};
