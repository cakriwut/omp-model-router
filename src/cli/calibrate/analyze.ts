import { tierToIndex } from "../../calibration/session";
import type { AnalyzeStats, ParsedTrace } from "./types";

const TIER_LABELS = ["low", "medium", "high"];

export function analyzeTrace(trace: ParsedTrace): AnalyzeStats {
	const matrix: number[][] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	let completed = 0;
	let failed = 0;
	let agreements = 0;
	let disagreements = 0;
	let totalLatency = 0;
	let maxLatency = 0;
	const failureReasons = new Map<string, number>();
	let rulePresent = 0;
	let pinned = 0;
	const bySource = new Map<string, number>();

	for (const rec of trace.records) {
		bySource.set(
			rec.finalDecision.source,
			(bySource.get(rec.finalDecision.source) ?? 0) + 1,
		);
		if (rec.heuristicDecision.ruleName) rulePresent++;
		if (rec.finalDecision.source === "pinned") pinned++;

		if (rec.llmDecision) {
			completed++;
			const h = tierToIndex(rec.heuristicDecision.tier);
			const l = tierToIndex(rec.llmDecision.tier);
			matrix[h][l]++;
			if (rec.heuristicDecision.tier === rec.llmDecision.tier) {
				agreements++;
			} else {
				disagreements++;
			}
			const lat = rec.llmDecision.latencyMs ?? 0;
			totalLatency += lat;
			if (lat > maxLatency) maxLatency = lat;
		} else {
			failed++;
			const reason =
				(rec as { failureReason?: string }).failureReason ?? "unknown";
			const normalized = reason.replace(/\s*\(\d+ms\)\s*$/, "").trim();
			failureReasons.set(
				normalized,
				(failureReasons.get(normalized) ?? 0) + 1,
			);
		}
	}

	return {
		matrix,
		totalRecords: trace.records.length,
		completed,
		failed,
		agreements,
		disagreements,
		avgLatencyMs: completed > 0 ? Math.round(totalLatency / completed) : 0,
		maxLatencyMs: maxLatency,
		failureReasons,
		rulePresent,
		pinned,
		bySource,
	};
}

export function formatAnalysisTable(stats: AnalyzeStats): string {
	const lines: string[] = [];
	lines.push("Calibration Trace Analysis");
	lines.push("==========================");
	lines.push("");
	lines.push(
		`Records: ${stats.totalRecords} (${stats.completed} completed, ${stats.failed} failed/abandoned)`,
	);
	if (stats.completed > 0) {
		const agreementRate = (stats.agreements / stats.completed) * 100;
		lines.push(
			`Agreement: ${agreementRate.toFixed(1)}% (${stats.agreements}/${stats.completed})`,
		);
		lines.push(
			`Disagreement: ${(100 - agreementRate).toFixed(1)}% (${stats.disagreements}/${stats.completed})`,
		);
		lines.push(
			`LLM latency: avg ${stats.avgLatencyMs}ms, max ${stats.maxLatencyMs}ms`,
		);
	}
	lines.push("");

	if (stats.completed > 0) {
		lines.push("Confusion Matrix (heuristic rows × LLM cols):");
		lines.push("           low    medium  high");
		for (let h = 0; h < 3; h++) {
			const row = stats.matrix[h];
			lines.push(
				`  ${TIER_LABELS[h].padEnd(8)} ${pad(row[0])}  ${pad(row[1])}  ${pad(row[2])}`,
			);
		}
		lines.push("");
	}

	if (stats.bySource.size > 0) {
		lines.push("Decision source:");
		for (const [src, count] of [...stats.bySource.entries()].sort(
			(a, b) => b[1] - a[1],
		)) {
			lines.push(`  ${src.padEnd(12)} ${count}`);
		}
		lines.push("");
	}

	if (stats.failureReasons.size > 0) {
		lines.push("Failure reasons:");
		for (const [reason, count] of [...stats.failureReasons.entries()].sort(
			(a, b) => b[1] - a[1],
		)) {
			lines.push(`  ${count.toString().padStart(4)}× ${reason}`);
		}
		lines.push("");
	}

	if (stats.pinned > 0) {
		lines.push(
			`⚠ ${stats.pinned} record(s) had source=pinned. Heuristic was bypassed; treat that matrix row with care.`,
		);
	}

	return lines.join("\n");
}

function pad(n: number): string {
	return String(n).padStart(5);
}
