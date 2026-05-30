/**
 * Calibration system lifecycle hooks
 * Wired into OMP extension events: session_start, turn_start, turn_end, session_end
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Context } from "@oh-my-pi/pi-ai";
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
import { getLastUserText } from "../routing";
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

	const global = config.calibration.useGlobalPrior
		? loadGlobalCalibration()
		: undefined;

	state.calibration = initSessionCalibration(global, config.calibration);

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
 * session_branch: Reset pending state, open new trace file
 */
export async function onSessionBranch(
	_event: unknown,
	_ctx: ExtensionContext,
	state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled || !state.calibration) {
		return;
	}

	clearPending(state.calibration);

	if (config.calibration.traceEnabled) {
		const sessionId = `branch-${Date.now().toString(36)}`;
		state.calibration.traceFilePath = openTraceFile(sessionId);
	}
}

/**
 * turn_start: Poll pending classifier; timeout stale agents
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

	if (cal.pendingAgentId && cal.pendingAgentAge !== undefined) {
		cal.pendingAgentAge++;

		if (cal.pendingAgentAge > 2) {
			const ageMs = cal.pendingSpawnTime ? Date.now() - cal.pendingSpawnTime : 0;
			abandonClassifier(cal.pendingAgentId);
			cal.llmCallsFailed++;
			writePendingAsFailed(cal, "abandoned-stale", ageMs);
			clearPending(cal);

			if (state.debugEnabled) {
				ctx.ui.notify(
					`[calibration] Abandoned stale classifier (age >2 turns, ${ageMs}ms)`,
					"warning",
				);
			}
		}
	}

	if (cal.pendingAgentId) {
		await tryPollClassifier(cal.pendingAgentId, ctx, state);
	}
}

/**
 * turn_end: Poll pending classifier (first chance)
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

	if (state.calibration.pendingAgentId) {
		await tryPollClassifier(state.calibration.pendingAgentId, ctx, state);
	}
}

/**
 * session_end (not a real event, called from extension cleanup)
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
	if (cal.totalComparisons > 0) {
		mergeSessionIntoGlobal(cal, getCurrentVersion(), true);
	}

	state.calibration = undefined;
}

/**
 * Spawn async classifier after routing decision.
 * Captures the actual user prompt + heuristic context at spawn time so the
 * deferred trace write (after verdict arrives) has real data.
 */
export function spawnClassifierForTurn(
	state: RouterState,
	config: RouterConfig,
	heuristicTier: RouterTier,
	context: Context,
): void {
	if (!config.calibration?.enabled || !state.calibration) return;

	const cal = state.calibration;
	if (cal.pendingAgentId) return;
	if (!config.calibration.classifierModel) return;

	const ctx = state.lastExtensionContext;
	if (!ctx) return;

	// Capture the user prompt + heuristic snapshot NOW. We need this later
	// when the LLM verdict arrives, because state.lastDecision will have
	// moved on by then.
	const userPrompt = getLastUserText(context);
	const decision = state.lastDecision;

	cal.llmCallsAttempted++;
	cal.pendingHeuristicTier = heuristicTier;
	cal.pendingHeuristicPhase = decision?.phase ?? "implementation";
	cal.pendingHeuristicReasoning = decision?.reasoning ?? "";
	cal.pendingRuleMatched = decision?.isRuleMatched ?? false;
	cal.pendingPrompt = truncatePrompt(userPrompt, 500);
	cal.pendingTurnIndex = cal.turnsProcessed;
	cal.pendingAgentAge = 0;
	cal.pendingSpawnTime = Date.now();

	if (state.debugEnabled) {
		ctx.ui.notify(
			`[calibration] Spawning classifier for: "${truncatePrompt(userPrompt, 60)}"`,
			"info",
		);
	}

	spawnClassifierAgent(
		config.calibration.classifierModel,
		context,
		decision?.phase,
		ctx.modelRegistry,
	)
		.then((agentId) => {
			if (agentId && state.calibration) {
				state.calibration.pendingAgentId = agentId;
				if (state.debugEnabled) {
					ctx.ui.notify(`[calibration] Spawned (agent: ${agentId})`, "info");
				}
			} else if (state.calibration) {
				state.calibration.llmCallsFailed++;
				writePendingAsFailed(state.calibration, "spawn-no-id", 0);
				clearPending(state.calibration);
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
				writePendingAsFailed(state.calibration, `spawn-threw:${String(err).slice(0, 40)}`, 0);
				clearPending(state.calibration);
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

	const result = await pollClassifierResult(agentId, 0);
	if (!result.ready) return;

	abandonClassifier(agentId); // free pi-subagents cache regardless of outcome
	const ageMs = cal.pendingSpawnTime ? Date.now() - cal.pendingSpawnTime : 0;

	if (result.error) {
		cal.llmCallsFailed++;
		writePendingAsFailed(cal, `error:${result.error.slice(0, 60)}`, ageMs);
		clearPending(cal);
		if (state.debugEnabled) {
			ctx.ui.notify(
				`[calibration] Classifier failed: ${result.error}`,
				"warning",
			);
		}
		return;
	}

	if (!result.verdict || !cal.pendingHeuristicTier) {
		cal.llmCallsFailed++;
		writePendingAsFailed(cal, "no-verdict-or-tier", ageMs);
		clearPending(cal);
		return;
	}

	const heuristicTier = cal.pendingHeuristicTier;
	const verdict = result.verdict;

	updateCalibrationMatrix(cal, heuristicTier, verdict.tier);

	if (cal.traceFilePath) {
		writeCompletedTrace(cal, verdict, ageMs);
	}

	if (state.debugEnabled) {
		const agreed = heuristicTier === verdict.tier;
		ctx.ui.notify(
			`[calibration] h=${heuristicTier}, llm=${verdict.tier} ${agreed ? "✓" : "✗"} (${cal.totalComparisons} comparisons, ${ageMs}ms)`,
			"info",
		);
	}

	clearPending(cal);

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

/**
 * Write a complete trace record (heuristic + LLM verdict).
 * Called when a classifier result arrives.
 */
function writeCompletedTrace(
	cal: import("./types").SessionCalibration,
	verdict: { tier: RouterTier; reasoning: string },
	latencyMs: number,
): void {
	if (!cal.traceFilePath || !cal.pendingHeuristicTier) return;

	const heuristicTier = cal.pendingHeuristicTier;
	const record: TraceRecord = {
		turnIndex: cal.pendingTurnIndex ?? cal.turnsProcessed,
		timestamp: Date.now(),
		prompt: cal.pendingPrompt ?? "",
		promptFeatures: {
			wordCount: (cal.pendingPrompt ?? "").split(/\s+/).filter(Boolean).length,
			toolResultCount: 0,
			hasImages: false,
			matchedKeywords: [],
		},
		heuristicDecision: {
			tier: heuristicTier,
			phase: cal.pendingHeuristicPhase ?? "implementation",
			reasoning: cal.pendingHeuristicReasoning ?? "",
			ruleName: cal.pendingRuleMatched ? "rule" : undefined,
		},
		llmDecision: {
			tier: verdict.tier,
			reasoning: verdict.reasoning,
			latencyMs,
		},
		finalDecision: {
			tier: heuristicTier,
			source: cal.pendingRuleMatched ? "pinned" : "heuristic",
		},
		agreement: heuristicTier === verdict.tier,
	};

	appendTraceRecord(cal.traceFilePath, record);
}

/**
 * Write a trace record for a failed/abandoned classifier.
 * Captures what we know — prompt + heuristic — without LLM verdict.
 */
function writePendingAsFailed(
	cal: import("./types").SessionCalibration,
	reason: string,
	latencyMs: number,
): void {
	if (!cal.traceFilePath || !cal.pendingHeuristicTier) return;

	const heuristicTier = cal.pendingHeuristicTier;
	const record: TraceRecord = {
		turnIndex: cal.pendingTurnIndex ?? cal.turnsProcessed,
		timestamp: Date.now(),
		prompt: cal.pendingPrompt ?? "",
		promptFeatures: {
			wordCount: (cal.pendingPrompt ?? "").split(/\s+/).filter(Boolean).length,
			toolResultCount: 0,
			hasImages: false,
			matchedKeywords: [],
		},
		heuristicDecision: {
			tier: heuristicTier,
			phase: cal.pendingHeuristicPhase ?? "implementation",
			reasoning: cal.pendingHeuristicReasoning ?? "",
			ruleName: cal.pendingRuleMatched ? "rule" : undefined,
		},
		llmDecision: undefined,
		finalDecision: {
			tier: heuristicTier,
			source: cal.pendingRuleMatched ? "pinned" : "heuristic",
		},
		agreement: null,
		// Stash failure reason in reasoning for diagnostic, since TraceRecord
		// has no dedicated field. Lab harness can read it.
		// @ts-expect-error — informal extension
		failureReason: `${reason} (${latencyMs}ms)`,
	};

	appendTraceRecord(cal.traceFilePath, record);
}

function clearPending(cal: import("./types").SessionCalibration): void {
	cal.pendingAgentId = undefined;
	cal.pendingHeuristicTier = undefined;
	cal.pendingHeuristicPhase = undefined;
	cal.pendingHeuristicReasoning = undefined;
	cal.pendingRuleMatched = undefined;
	cal.pendingPrompt = undefined;
	cal.pendingTurnIndex = undefined;
	cal.pendingAgentAge = undefined;
	cal.pendingSpawnTime = undefined;
}
