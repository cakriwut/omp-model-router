import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeTrace, formatAnalysisTable } from "../../src/cli/calibrate/analyze";
import { parseTraceFiles, resolveTraceFiles } from "../../src/cli/calibrate/parse";
import {
	formatSimulationTable,
	simulateStrategies,
} from "../../src/cli/calibrate/simulate";

function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cal-cli-"));
	const file = join(dir, "session-x-calibration.jsonl");
	const lines = [
		// 4 completed (3 agree, 1 disagree), 1 failed
		{
			turnIndex: 1,
			timestamp: 1,
			prompt: "summarize",
			promptFeatures: { wordCount: 1, toolResultCount: 0, hasImages: false, matchedKeywords: [] },
			heuristicDecision: { tier: "low", phase: "lightweight", reasoning: "" },
			llmDecision: { tier: "low", reasoning: "", latencyMs: 1000 },
			finalDecision: { tier: "low", source: "heuristic" },
			agreement: true,
		},
		{
			turnIndex: 2,
			timestamp: 2,
			prompt: "design rate limiter",
			promptFeatures: { wordCount: 3, toolResultCount: 0, hasImages: false, matchedKeywords: [] },
			heuristicDecision: { tier: "low", phase: "lightweight", reasoning: "" },
			llmDecision: { tier: "high", reasoning: "", latencyMs: 2000 },
			finalDecision: { tier: "low", source: "heuristic" },
			agreement: false,
		},
		{
			turnIndex: 3,
			timestamp: 3,
			prompt: "what is 2+2",
			promptFeatures: { wordCount: 3, toolResultCount: 0, hasImages: false, matchedKeywords: [] },
			heuristicDecision: { tier: "low", phase: "lightweight", reasoning: "" },
			llmDecision: { tier: "low", reasoning: "", latencyMs: 500 },
			finalDecision: { tier: "low", source: "heuristic" },
			agreement: true,
		},
		{
			turnIndex: 4,
			timestamp: 4,
			prompt: "explain closures",
			promptFeatures: { wordCount: 2, toolResultCount: 0, hasImages: false, matchedKeywords: [] },
			heuristicDecision: { tier: "medium", phase: "implementation", reasoning: "" },
			llmDecision: { tier: "medium", reasoning: "", latencyMs: 800 },
			finalDecision: { tier: "medium", source: "heuristic" },
			agreement: true,
		},
		{
			turnIndex: 5,
			timestamp: 5,
			prompt: "broken",
			promptFeatures: { wordCount: 1, toolResultCount: 0, hasImages: false, matchedKeywords: [] },
			heuristicDecision: { tier: "medium", phase: "implementation", reasoning: "" },
			finalDecision: { tier: "medium", source: "heuristic" },
			agreement: null,
			failureReason: "spawn-threw:no key (0ms)",
		},
		// malformed line — should be skipped silently
	];
	const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\nNOT JSON\n";
	writeFileSync(file, content);
	return dir;
}

describe("cli/calibrate", () => {
	test("resolveTraceFiles + parse skips malformed lines", () => {
		const dir = fixtureDir();
		const files = resolveTraceFiles(dir);
		expect(files.length).toBe(1);
		const trace = parseTraceFiles(files);
		expect(trace.records.length).toBe(5); // 4 completed + 1 failed
		expect(trace.failureRecords.length).toBe(1);
	});

	test("analyzeTrace produces correct matrix and counts", () => {
		const trace = parseTraceFiles(resolveTraceFiles(fixtureDir()));
		const stats = analyzeTrace(trace);
		expect(stats.completed).toBe(4);
		expect(stats.failed).toBe(1);
		expect(stats.agreements).toBe(3);
		expect(stats.disagreements).toBe(1);
		// matrix[low][high] should be 1 from "design rate limiter"
		expect(stats.matrix[0][2]).toBe(1);
		expect(stats.matrix[1][1]).toBe(1);
		expect(stats.matrix[0][0]).toBe(2);
	});

	test("formatAnalysisTable includes confusion matrix and failure reasons", () => {
		const trace = parseTraceFiles(resolveTraceFiles(fixtureDir()));
		const out = formatAnalysisTable(analyzeTrace(trace));
		expect(out).toContain("Confusion Matrix");
		expect(out).toContain("low");
		expect(out).toContain("Failure reasons:");
		expect(out).toContain("spawn-threw:no key");
	});

	test("simulateStrategies scores heuristic vs llm vs calibrated", () => {
		const trace = parseTraceFiles(resolveTraceFiles(fixtureDir()));
		const rows = simulateStrategies(trace, { warmup: 0 });
		expect(rows.length).toBe(3);
		const map = new Map(rows.map((r) => [r.strategy, r]));
		expect(map.get("llm")!.correct).toBe(4); // llm always matches itself
		expect(map.get("heuristic")!.correct).toBe(3); // 3 agreements out of 4
	});

	test("formatSimulationTable renders all strategies", () => {
		const trace = parseTraceFiles(resolveTraceFiles(fixtureDir()));
		const out = formatSimulationTable(simulateStrategies(trace, { warmup: 5 }));
		expect(out).toContain("heuristic");
		expect(out).toContain("llm");
		expect(out).toContain("calibrated");
	});
});
