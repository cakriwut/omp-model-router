/**
 * Calibration system lifecycle hooks
 * Wired into OMP extension events: session_start, turn_start, turn_end, session_end
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { RouterConfig, RouterTier } from "../types";
import {
	initSessionCalibration,
	loadGlobalCalibration,
	mergeSessionIntoGlobal,
	updateCalibrationMatrix,
	spawnClassifierAgent,
	pollClassifierResult,
	abandonClassifier,
	openTraceFile,
	appendTraceRecord,
	truncatePrompt,
} from "./index";
import type { TraceRecord } from "./types";
import { getCurrentVersion } from "../version-check";

/**
 * session_start: Initialize calibration state
 */
export async function onSessionStart(
	_event: unknown,
	ctx: ExtensionContext,
	state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled) {
		state.calibration = undefined;
		return;
	}

	// Load global prior if enabled
	const global = config.calibration.useGlobalPrior
		? loadGlobalCalibration()
		: undefined;

	// Initialize session calibration
	state.calibration = initSessionCalibration(global, config.calibration);

	// Open trace file if enabled — use a timestamp-based ID since
	// ExtensionContext doesn't directly expose session ID
	if (config.calibration.traceEnabled) {
		const sessionId = `session-${Date.now().toString(36)}`;
		state.calibration.traceFilePath = openTraceFile(sessionId);
	}

	if (state.debugEnabled) {
		ctx.ui.notify(
			`[calibration] Initialized (mode: ${config.calibration.mode}, warmup: ${config.calibration.warmupTurns})`,
			"info",
		);
	}
}

/**
 * session_branch: Clone calibration state from parent, reset pending agent
 */
export async function onSessionBranch(
	_event: unknown,
	ctx: ExtensionContext,
	state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled || !state.calibration) {
		return;
	}

	// Reset pending classifier (branch is a new conversation)
	state.calibration.pendingAgentId = undefined;
	state.calibration.pendingHeuristicTier = undefined;
	state.calibration.pendingAgentAge = undefined;

	// Open new trace file for branch
	if (config.calibration.traceEnabled) {
		const sessionId = `branch-${Date.now().toString(36)}`;
		state.calibration.traceFilePath = openTraceFile(sessionId);
	}
}

/**
 * turn_start: Poll pending classifier, increment turn counter, timeout stale agents
 */
export async function onTurnStart(
	_event: unknown,
	ctx: ExtensionContext,
	state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled || !state.calibration) {
		return;
	}

	const cal = state.calibration;
	cal.turnsProcessed++;

	// Timeout stale agents (age >2 turns)
	if (cal.pendingAgentId && cal.pendingAgentAge !== undefined) {
		cal.pendingAgentAge++;

		if (cal.pendingAgentAge > 2) {
			abandonClassifier(cal.pendingAgentId);
			cal.llmCallsFailed++;
			cal.pendingAgentId = undefined;
			cal.pendingHeuristicTier = undefined;
			cal.pendingAgentAge = undefined;

			if (state.debugEnabled) {
				ctx.ui.notify(
					"[calibration] Abandoned stale classifier (age >2 turns)",
					"warning",
				);
			}
		}
	}

	// Poll pending classifier (retry from turn_end)
	if (cal.pendingAgentId) {
		await tryPollClassifier(cal.pendingAgentId, ctx, state);
	}
}

/**
 * turn_end: Poll pending classifier (first chance), append trace
 */
export async function onTurnEnd(
	_event: unknown,
	ctx: ExtensionContext,
	state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled || !state.calibration) {
		return;
	}

	const cal = state.calibration;

	// Poll pending classifier (non-blocking)
	if (cal.pendingAgentId) {
		await tryPollClassifier(cal.pendingAgentId, ctx, state);
	}

	// Append trace record if enabled
	if (cal.traceFilePath && state.lastDecision) {
		writeTraceRecord(state, cal.traceFilePath);
	}
}

/**
 * session_end: Merge session calibration into global
 */
export async function onSessionEnd(
	_event: unknown,
	_ctx: ExtensionContext,
	state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled || !state.calibration) {
		return;
	}

	const cal = state.calibration;

	// Only merge if we have comparisons
	if (cal.totalComparisons > 0) {
		const version = getCurrentVersion();
		mergeSessionIntoGlobal(cal, version, true); // immediate=true on session end
	}

	state.calibration = undefined;
}

/**
 * Spawn async classifier after routing decision
 * Called from the provider after resolveRouting completes
 */
export function spawnClassifierForTurn(
	state: RouterState,
	config: RouterConfig,
	heuristicTier: RouterTier,
	context: import("@oh-my-pi/pi-ai").Context,
): void {
	if (!config.calibration?.enabled || !state.calibration) {
		return;
	}

	const cal = state.calibration;

	if (cal.pendingAgentId) {
		return;
	}

	if (!config.calibration.classifierModel) {
		return;
	}

	const ctx = state.lastExtensionContext;
	if (!ctx) {
		return;
	}

	cal.llmCallsAttempted++;
	cal.pendingHeuristicTier = heuristicTier;
	cal.pendingAgentAge = 0;

	if (state.debugEnabled) {
		ctx.ui.notify(
			`[calibration] Spawning classifier (model: ${config.calibration.classifierModel})`,
			"info",
		);
	}

	// Fire-and-forget: spawn classifier asynchronously
	spawnClassifierAgent(
		config.calibration.classifierModel,
		context,
		state.lastDecision?.phase,
		ctx.modelRegistry,
	)
		.then((agentId) => {
			if (agentId && state.calibration) {
				state.calibration.pendingAgentId = agentId;
				if (state.debugEnabled) {
					ctx.ui.notify(
						`[calibration] Spawned (agent: ${agentId})`,
						"info",
					);
				}
			} else if (state.calibration) {
				state.calibration.llmCallsFailed++;
				state.calibration.pendingHeuristicTier = undefined;
				state.calibration.pendingAgentAge = undefined;
				if (state.debugEnabled) {
					ctx.ui.notify(
						"[calibration] Spawn returned no agentId",
						"warning",
					);
				}
			}
		})
		.catch((err) => {
			if (state.calibration) {
				state.calibration.llmCallsFailed++;
				state.calibration.pendingHeuristicTier = undefined;
				state.calibration.pendingAgentAge = undefined;
			}
			if (state.debugEnabled) {
				ctx.ui.notify(
					`[calibration] Spawn threw: ${String(err).slice(0, 100)}`,
					"warning",
				);
			}
		});
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function tryPollClassifier(
	agentId: string,
	ctx: ExtensionContext,
	state: RouterState,
): Promise<void> {
	const cal = state.calibration;
	if (!cal) return;

	const result = await pollClassifierResult(agentId, 0); // non-blocking

	if (!result.ready) {
		return; // Still running
	}

	// Clear pending state and cleanup cached result
	cal.pendingAgentId = undefined;
	const heuristicTier = cal.pendingHeuristicTier;
	cal.pendingHeuristicTier = undefined;
	cal.pendingAgentAge = undefined;
	abandonClassifier(agentId); // Clean up cached result to prevent memory leak

	if (result.error) {
		cal.llmCallsFailed++;
		if (state.debugEnabled) {
			ctx.ui.notify(
				`[calibration] Classifier failed: ${result.error}`,
				"warning",
			);
		}
		return;
	}

	if (!result.verdict || !heuristicTier) {
		cal.llmCallsFailed++;
		return;
	}

	// Update confusion matrix
	updateCalibrationMatrix(cal, heuristicTier, result.verdict.tier);

	if (state.debugEnabled) {
		const agreed = heuristicTier === result.verdict.tier;
		ctx.ui.notify(
			`[calibration] h=${heuristicTier}, llm=${result.verdict.tier} ${agreed ? "✓" : "✗"} (${cal.totalComparisons} comparisons)`,
			"info",
		);
	}

	// Log high failure rate warning
	if (cal.llmCallsAttempted >= 10) {
		const failureRate = cal.llmCallsFailed / cal.llmCallsAttempted;
		if (failureRate > 0.8 && cal.llmCallsAttempted % 10 === 0) {
			ctx.ui.notify(
				`[calibration] High failure rate (${Math.round(failureRate * 100)}%). Check classifierModel config.`,
				"warning",
			);
		}
	}
}

function writeTraceRecord(
	state: RouterState,
	traceFilePath: string,
): void {
	if (!state.lastDecision) return;

	const cal = state.calibration;
	const decision = state.lastDecision;

	const source: TraceRecord["finalDecision"]["source"] = decision.isClassifier
		? "llm"
		: decision.isRuleMatched
			? "pinned"
			: decision.isBudgetForced
				? "budget"
				: "heuristic";

	const record: TraceRecord = {
		turnIndex: cal?.turnsProcessed ?? 0,
		timestamp: Date.now(),
		prompt: truncatePrompt(decision.reasoning, 200),
		promptFeatures: {
			wordCount: 0,
			toolResultCount: 0,
			hasImages: false,
			matchedKeywords: [],
		},
		heuristicDecision: {
			tier: decision.tier,
			phase: decision.phase,
			reasoning: decision.reasoning,
			ruleName: decision.isRuleMatched ? "rule" : undefined,
		},
		llmDecision: undefined,
		finalDecision: {
			tier: decision.tier,
			source,
		},
		agreement: null,
	};

	appendTraceRecord(traceFilePath, record);
}
