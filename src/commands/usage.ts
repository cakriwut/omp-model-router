import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState, ModelCostEntry } from "../state";
import { parseCanonicalModelRef, ROUTER_TIERS } from "../config";
import { renderUsageReport } from "../ui";

export const handleUsage = (
	state: RouterState,
) => async (_args: string[], ctx: ExtensionContext) => {
	const profile = state.currentConfig.profiles[state.selectedProfile];
	if (!profile) {
		ctx.ui.notify("No active router profile.", "error");
		return;
	}

	// ── Data source: prefer in-memory scope (includes sub-agent rollup) ──────
	// In-memory wins when populated by any routing in this process run.
	// JSONL rescan fires only for resumed sessions (fresh process, no turns yet).
	// Requires: Thread C (parent attribution) + Thread B (complete field rollup).
	const useInMemory = state.modelCosts.size > 0 || state.accumulatedCost > 0;

	let reportModelCosts: Map<string, ModelCostEntry>;
	let reportTierCounter: { high: number; medium: number; low: number };
	let reportTotalCost: number;

	if (useInMemory) {
		reportModelCosts  = state.modelCosts;
		reportTierCounter = state.tierCounter;
		reportTotalCost   = state.accumulatedCost;
	} else {
	// Fallback: JSONL rescan for resumed sessions where scope is empty
	const sessionModelCosts = new Map<string, ModelCostEntry>();
	let sessionTotalCost = 0;
	try {
		const branch = ctx.sessionManager.getBranch() as unknown[];
		for (const entry of branch) {
			if (
				typeof entry !== "object" ||
				!entry ||
				!("type" in entry) ||
				entry.type !== "message"
			)
				continue;
			const msg =
				"message" in entry && typeof entry.message === "object"
					? entry.message
					: entry;
			if (
				!msg ||
				typeof msg !== "object" ||
				!("role" in msg) ||
				msg.role !== "assistant"
			)
				continue;
			if (!("usage" in msg) || !msg.usage) continue;
			const u =
				typeof msg.usage === "object" && msg.usage
					? msg.usage
					: undefined;
			if (!u) continue;

			const costObj =
				typeof u === "object" &&
				"cost" in u &&
				typeof (u as { cost?: { total?: number } }).cost ===
					"object" &&
				(u as { cost?: { total?: number } }).cost
					? (u as { cost?: { total?: number } }).cost
					: undefined;
			const cost = costObj && typeof costObj.total === "number" ? costObj.total : 0;

			const model =
				typeof msg === "object" &&
				"provider" in msg &&
				"model" in msg &&
				typeof msg.provider === "string" &&
				typeof msg.model === "string"
					? `${msg.provider}/${msg.model}`
					: typeof msg === "object" &&
						  "model" in msg &&
						  typeof msg.model === "string"
						? msg.model
						: "unknown";
			sessionTotalCost += cost;

			const usageTyped =
				typeof u === "object"
					? (u as {
							input?: number;
							output?: number;
							cacheRead?: number;
							cacheWrite?: number;
						})
					: undefined;

			const existing = sessionModelCosts.get(model);
			if (existing) {
				existing.invocations++;
				existing.inputTokens += usageTyped?.input ?? 0;
				existing.outputTokens += usageTyped?.output ?? 0;
				existing.cacheReadTokens += usageTyped?.cacheRead ?? 0;
				existing.cacheWriteTokens += usageTyped?.cacheWrite ?? 0;
				existing.cost += cost;
			} else {
				sessionModelCosts.set(model, {
					model,
					tier: "", // resolved below
					invocations: 1,
					inputTokens: usageTyped?.input ?? 0,
					outputTokens: usageTyped?.output ?? 0,
					cacheReadTokens: usageTyped?.cacheRead ?? 0,
					cacheWriteTokens: usageTyped?.cacheWrite ?? 0,
					cost,
				});
			}
		}

		// Resolve tier for each model by matching against profile config
		for (const [modelRef, entry] of sessionModelCosts) {
			for (const tier of ROUTER_TIERS) {
				const tierConfig = profile[tier];
				if (tierConfig.model === modelRef || tierConfig.fallbacks?.includes(modelRef)) {
					entry.tier = tier;
					break;
				}
			}
		}
	} catch {
		// If JSONL read fails, reportModelCosts remains empty
	}

	// Derive tier counts from scanned model costs
	const sessionTierCounter = { high: 0, medium: 0, low: 0 };
	for (const entry of sessionModelCosts.values()) {
		if (entry.tier === "high" || entry.tier === "medium" || entry.tier === "low") {
			sessionTierCounter[entry.tier] += entry.invocations;
		}
	}

	reportModelCosts  = sessionModelCosts;
	reportTierCounter = sessionTierCounter;
	reportTotalCost   = sessionTotalCost;
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
				}
			: undefined,
	});
	ctx.ui.notify(report, "info");
};
