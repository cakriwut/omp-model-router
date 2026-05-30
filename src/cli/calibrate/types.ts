import type { TraceRecord } from "../../calibration/types";

export interface ParsedTrace {
	records: TraceRecord[];
	failureRecords: (TraceRecord & { failureReason?: string })[];
}

export interface AnalyzeStats {
	matrix: number[][]; // [h][llm], 0=low, 1=medium, 2=high
	totalRecords: number;
	completed: number; // both heuristic + llm present
	failed: number; // llmDecision missing
	agreements: number;
	disagreements: number;
	avgLatencyMs: number;
	maxLatencyMs: number;
	failureReasons: Map<string, number>;
	rulePresent: number;
	pinned: number;
	bySource: Map<string, number>;
}

export interface SimulateStats {
	strategy: string;
	totalDecisions: number;
	correct: number; // matches LLM verdict (proxy ground truth)
	cost: number; // synthetic; classifier=$0.0003/call
	avgLatencyMs: number;
	flapping: number; // similar prompt → tier toggled
}
