import type { TraceRecord } from "../../calibration/types";
import type { ParsedTrace, SimulateStats } from "./types";
import type { RouterTier } from "../../types";
import {
	applyCalibratedTier,
	initSessionCalibration,
	updateCalibrationMatrix,
} from "../../calibration/session";

// Per-call cost approximations ($) — used for relative comparison only.
// Heuristic = free (in-process keyword match).
// LLM = Nova Micro classifier roughly $0.0003/call as of writing.
const COST_PER_LLM_CALL = 0.0003;

/** Synthetic added latency per strategy. Heuristic ~0ms; LLM uses recorded. */
function avgLatencyFor(records: TraceRecord[], strategy: string): number {
	if (strategy === "heuristic") return 0;
	let total = 0;
	let count = 0;
	for (const r of records) {
		if (r.llmDecision) {
			total += r.llmDecision.latencyMs ?? 0;
			count++;
		}
	}
	if (count === 0) return 0;
	return Math.round(total / count);
}

/**
 * Run strategy comparison. Uses LLM verdict as the proxy ground truth.
 * If a record has no LLM verdict it's skipped (no signal to score against).
 */
export function simulateStrategies(
	trace: ParsedTrace,
	opts: { warmup: number },
): SimulateStats[] {
	const scored = trace.records.filter((r) => r.llmDecision);

	const heuristic: SimulateStats = {
		strategy: "heuristic",
		totalDecisions: 0,
		correct: 0,
		cost: 0,
		avgLatencyMs: 0,
		flapping: 0,
	};
	const llm: SimulateStats = {
		strategy: "llm",
		totalDecisions: 0,
		correct: 0,
		cost: 0,
		avgLatencyMs: avgLatencyFor(scored, "llm"),
		flapping: 0,
	};
	const calibrated: SimulateStats = {
		strategy: "calibrated",
		totalDecisions: 0,
		correct: 0,
		cost: 0,
		avgLatencyMs: avgLatencyFor(scored, "llm"),
		flapping: 0,
	};

	const cal = initSessionCalibration(undefined, {
		enabled: true,
		mode: "adaptive",
		warmupTurns: opts.warmup,
		overrideThreshold: 0.65,
		traceEnabled: false,
		useGlobalPrior: false,
		globalPriorWeight: 0,
	});
	const calConfig = {
		enabled: true,
		mode: "adaptive" as const,
		warmupTurns: opts.warmup,
		overrideThreshold: 0.65,
		traceEnabled: false,
		useGlobalPrior: false,
		globalPriorWeight: 0,
	};

	let prevHeuristic: { prompt: string; tier: RouterTier } | undefined;
	let prevLlm: { prompt: string; tier: RouterTier } | undefined;
	let prevCal: { prompt: string; tier: RouterTier } | undefined;

	for (const rec of scored) {
		const truth = rec.llmDecision!.tier;
		const hTier = rec.heuristicDecision.tier;
		const llmTier = rec.llmDecision!.tier;
		const calTier = applyCalibratedTier(hTier, cal, calConfig);

		// Score
		heuristic.totalDecisions++;
		llm.totalDecisions++;
		calibrated.totalDecisions++;
		if (hTier === truth) heuristic.correct++;
		if (llmTier === truth) llm.correct++;
		if (calTier === truth) calibrated.correct++;

		// Cost: heuristic free; llm/calibrated pay per call
		llm.cost += COST_PER_LLM_CALL;
		calibrated.cost += COST_PER_LLM_CALL;

		// Flapping = same/very-similar prompt → tier changed
		const prompt = rec.prompt ?? "";
		if (prevHeuristic && similar(prevHeuristic.prompt, prompt) && prevHeuristic.tier !== hTier) heuristic.flapping++;
		if (prevLlm && similar(prevLlm.prompt, prompt) && prevLlm.tier !== llmTier) llm.flapping++;
		if (prevCal && similar(prevCal.prompt, prompt) && prevCal.tier !== calTier) calibrated.flapping++;
		prevHeuristic = { prompt, tier: hTier };
		prevLlm = { prompt, tier: llmTier };
		prevCal = { prompt, tier: calTier };

		// Update calibration matrix from this turn's pair
		updateCalibrationMatrix(cal, hTier, llmTier);
	}

	return [heuristic, llm, calibrated];
}

function similar(a: string, b: string): boolean {
	if (a === b) return true;
	const wa = a.split(/\s+/);
	const wb = b.split(/\s+/);
	if (Math.abs(wa.length - wb.length) > 2) return false;
	const sa = new Set(wa.map((w) => w.toLowerCase()));
	let overlap = 0;
	for (const w of wb) if (sa.has(w.toLowerCase())) overlap++;
	return overlap / Math.max(wa.length, wb.length) >= 0.7;
}

export function formatSimulationTable(rows: SimulateStats[]): string {
	const lines: string[] = [];
	lines.push("Strategy Simulation");
	lines.push("===================");
	lines.push("");
	lines.push(
		"Strategy   | Decisions | Accuracy | Cost     | Latency  | Flapping",
	);
	lines.push(
		"-----------|-----------|----------|----------|----------|---------",
	);
	for (const r of rows) {
		const acc =
			r.totalDecisions > 0 ? ((r.correct / r.totalDecisions) * 100).toFixed(1) : "0.0";
		lines.push(
			`${r.strategy.padEnd(10)} | ${String(r.totalDecisions).padStart(9)} | ${(acc + "%").padStart(8)} | $${r.cost.toFixed(4).padStart(7)} | ${(r.avgLatencyMs + "ms").padStart(8)} | ${String(r.flapping).padStart(8)}`,
		);
	}
	lines.push("");
	lines.push(
		"Note: \"Accuracy\" treats LLM verdict as ground truth (proxy). Pass criteria require external judge for real validation.",
	);
	return lines.join("\n");
}
