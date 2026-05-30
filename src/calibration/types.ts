import type { RouterTier, RouterPhase } from "../types";

/**
 * Session-scoped calibration state
 * Lives in RouterState, ephemeral per session
 */
export interface SessionCalibration {
	/** 3×3 confusion matrix: matrix[heuristic][llm] = count
	 * Indices: 0=low, 1=medium, 2=high */
	matrix: number[][];

	/** Total successful heuristic vs LLM comparisons */
	totalComparisons: number;

	/** How many classifier invocations were attempted */
	llmCallsAttempted: number;

	/** How many classifier calls failed or timed out */
	llmCallsFailed: number;

	/** When this session started (epoch ms) */
	sessionStartTime: number;

	/** Count of user turns (not assistant) */
	turnsProcessed: number;

	/** Pending background classifier agent ID (if any) */
	pendingAgentId?: string;

	/** Heuristic tier for pending agent (to compare when result arrives) */
	pendingHeuristicTier?: RouterTier;

	/** Heuristic phase + reasoning captured at spawn time (for trace) */
	pendingHeuristicPhase?: RouterPhase;
	pendingHeuristicReasoning?: string;
	pendingRuleMatched?: boolean;

	/** Captured user prompt at spawn time (truncated 500 chars) */
	pendingPrompt?: string;
	pendingTurnIndex?: number;

	/** Spawn timestamp for latency measurement */
	pendingSpawnTime?: number;

	/** Path to trace JSONL file (if traceEnabled) */
	traceFilePath?: string;
}

/**
 * Global calibration snapshot
 * Persisted to ~/.omp/agent/model-router/calibration-global.json
 */
export interface GlobalCalibrationSnapshot {
	version: 1;

	/** Aggregated 3×3 confusion matrix across all sessions */
	matrix: number[][];

	metadata: {
		/** Total sessions that contributed to this snapshot */
		totalSessions: number;

		/** Total comparisons across all sessions */
		totalComparisons: number;

		/** When this snapshot was last updated (epoch ms) */
		lastUpdated: number;

		/** omp-model-router version */
		routerVersion: string;
	};
}

/**
 * Per-turn trace record (for lab harness)
 * Written to ~/.omp/agent/model-router/traces/<sessionId>-calibration.jsonl
 */
export interface TraceRecord {
	/** Turn index within session (0-indexed) */
	turnIndex: number;

	/** When this turn occurred (epoch ms) */
	timestamp: number;

	/** User prompt (truncated to 200 chars) */
	prompt: string;

	/** Prompt features extracted for heuristic */
	promptFeatures: {
		wordCount: number;
		toolResultCount: number;
		hasImages: boolean;
		matchedKeywords: string[];
	};

	/** Heuristic decision (before calibration) */
	heuristicDecision: {
		tier: RouterTier;
		phase: RouterPhase;
		reasoning: string;
		ruleName?: string;
	};

	/** LLM classifier decision (if available) */
	llmDecision?: {
		tier: RouterTier;
		reasoning: string;
		latencyMs: number;
	};

	/** Final decision used for routing */
	finalDecision: {
		tier: RouterTier;
		source: "heuristic" | "llm" | "calibrated" | "pinned" | "budget";
	};

	/** Whether heuristic and LLM agreed (null if no LLM) */
	agreement: boolean | null;
}

/**
 * Calibration configuration (part of RouterConfig)
 */
export interface CalibrationConfig {
	/** Master switch for calibration system */
	enabled: boolean;

	/** Calibration mode:
	 * - telemetry: collect data passively, no routing changes
	 * - adaptive: use calibration to influence routing decisions */
	mode: "telemetry" | "adaptive";

	/** Turns before calibration affects routing (default: 5) */
	warmupTurns: number;

	/** Model reference for async LLM classifier (e.g. anthropic/claude-3-haiku-20240307) */
	classifierModel?: string;

	/** Confidence threshold for confusion-matrix override (default: 0.65) */
	overrideThreshold: number;

	/** Write per-turn trace JSONL (for lab harness) */
	traceEnabled: boolean;

	/** Bootstrap session calibration from global snapshot (default: true) */
	useGlobalPrior: boolean;

	/** Weight of global prior when bootstrapping (0.0 - 1.0, default: 0.1) */
	globalPriorWeight: number;
}

/**
 * Helper type for tier indexing
 */
export type TierIndex = 0 | 1 | 2;

/**
 * Result of polling a background classifier agent
 */
export interface ClassifierPollResult {
	/** Whether the agent has finished */
	ready: boolean;

	/** LLM verdict (if ready) */
	verdict?: {
		tier: RouterTier;
		reasoning: string;
	};

	/** Latency in ms (if ready) */
	latencyMs?: number;

	/** Error message (if failed) */
	error?: string;
}
