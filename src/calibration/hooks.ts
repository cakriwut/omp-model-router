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
 * turn_start: Increment turn counter (no polling — results self-record)
 */
export async function onTurnStart(
	_event: unknown,
	_ctx: ExtensionContext,
	state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled || !state.calibration) {
		return;
	}

	state.calibration.turnsProcessed++;
}

/**
 * turn_end: No-op (classifier results handled via promise)
 */
export async function onTurnEnd(
	_event: unknown,
	_ctx: ExtensionContext,
	_state: RouterState,
	config: RouterConfig,
): Promise<void> {
	if (!config.calibration?.enabled) {
		return;
	}
	// No polling — classifier promises record results autonomously
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
 * Captures the actual user prompt + heuristic context at spawn time.
 * Result records itself via promise when LLM verdict arrives.
 */
export function spawnClassifierForTurn(
	state: RouterState,
	config: RouterConfig,
	heuristicTier: RouterTier,
	context: Context,
): void {
	if (!config.calibration?.enabled || !state.calibration) return;

	const cal = state.calibration;
	if (cal.pendingAgentId) return; // skip if already pending
	if (!config.calibration.classifierModel) return;
	
	// Skip async spawn in adaptive mode when sync classifier already ran
	if (config.calibration.mode === "adaptive" && state.lastDecision && (state.lastDecision as any).syncClassifierRan) {
		return;
	}
	const ctx = state.lastExtensionContext;
	if (!ctx) return;

	// Capture the user prompt + heuristic snapshot NOW
	const userPrompt = getLastUserText(context);
	const decision = state.lastDecision;

	cal.llmCallsAttempted++;
	cal.pendingHeuristicTier = heuristicTier;
	cal.pendingHeuristicPhase = decision?.phase ?? "implementation";
	cal.pendingHeuristicReasoning = decision?.reasoning ?? "";
	cal.pendingRuleMatched = decision?.isRuleMatched ?? false;
	cal.pendingPrompt = truncatePrompt(userPrompt, 500);
	cal.pendingTurnIndex = cal.turnsProcessed;
	cal.pendingSpawnTime = Date.now();

	// Synthetic tracking ID
	const trackingId = `classifier-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	cal.pendingAgentId = trackingId;

	if (state.debugEnabled) {
		ctx.ui.notify(
			`[calibration] Spawning classifier for: "${truncatePrompt(userPrompt, 60)}"`,
			"info",
		);
	}

	// Spawn the classifier — the returned promise resolves when the LLM finishes
	const classifierPromise = spawnClassifierAgent(
		config.calibration.classifierModel,
		context,
		decision?.phase,
		ctx.modelRegistry,
	);

	// Attach promise handler for when result arrives
	classifierPromise
		.then(async (agentId) => {
			// If calibration was disabled or state reset since spawn, bail
			if (!state.calibration || state.calibration.pendingAgentId !== trackingId) {
				return;
			}

			if (!agentId) {
				// Spawn returned no ID
				state.calibration.llmCallsFailed++;
				writePendingAsFailed(state.calibration, "spawn-no-id", 0);
				clearPending(state.calibration);
				if (state.debugEnabled) {
					ctx.ui.notify(
						"[calibration] Spawn returned no agentId",
						"warning",
					);
				}
				return;
			}

			// Wait for result with 60s timeout using Promise.race
			const maxWaitTime = 60000; // 60s
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("timeout")), maxWaitTime)
			);

			const handleResult = async () => {
				try {
					// Poll with a reasonable interval until ready
					let result: Awaited<ReturnType<typeof pollClassifierResult>>;
					do {
						result = await pollClassifierResult(agentId, 1000);
					} while (!result.ready && state.calibration?.pendingAgentId === trackingId);

					if (!state.calibration || state.calibration.pendingAgentId !== trackingId) {
						return; // Calibration reset or cleared
					}

					// Result ready
					abandonClassifier(agentId);
					const ageMs = state.calibration.pendingSpawnTime
						? Date.now() - state.calibration.pendingSpawnTime
						: 0;

					if (result.error) {
						state.calibration.llmCallsFailed++;
						writePendingAsFailed(
							state.calibration,
							`error:${result.error.slice(0, 60)}`,
							ageMs,
						);
						clearPending(state.calibration);
						if (state.debugEnabled) {
							ctx.ui.notify(
								`[calibration] Classifier failed: ${result.error}`,
								"warning",
							);
						}
						return;
					}

					if (!result.verdict || !state.calibration.pendingHeuristicTier) {
						state.calibration.llmCallsFailed++;
						writePendingAsFailed(state.calibration, "no-verdict-or-tier", ageMs);
						clearPending(state.calibration);
						return;
					}

					const heuristicTier = state.calibration.pendingHeuristicTier;
					const verdict = result.verdict;

					updateCalibrationMatrix(state.calibration, heuristicTier, verdict.tier);

					if (state.calibration.traceFilePath) {
						writeCompletedTrace(state.calibration, verdict, ageMs);
					}

					if (state.debugEnabled) {
						const agreed = heuristicTier === verdict.tier;
						ctx.ui.notify(
							`[calibration] h=${heuristicTier}, llm=${verdict.tier} ${agreed ? "✓" : "✗"} (${state.calibration.totalComparisons} comparisons, ${ageMs}ms)`,
							"info",
						);
					}

					clearPending(state.calibration);

					updateCalibrationMatrix(state.calibration, heuristicTier, verdict.tier);

					if (state.calibration.traceFilePath) {
						writeCompletedTrace(state.calibration, verdict, ageMs);
					}
					
					// Badge-style log with decision
					const shortName = config.calibration?.classifierModel
						?.split('/').pop()?.split('.').pop()?.replace(/-v\d+:\d+$/, '') || 'classifier';
					if (state.debugEnabled) {
						const agreed = heuristicTier === verdict.tier;
						const modeLabel = config.calibration?.mode === 'adaptive' ? 'adaptive' : 'telemetry';
						console.log(`⚡ classifier → ${shortName} (async·${modeLabel}) → ${verdict.tier} ${agreed ? '✓' : '✗'}`);
						ctx.ui.notify(
							`[calibration] h=${heuristicTier}, llm=${verdict.tier} ${agreed ? '✓' : '✗'} (${state.calibration.totalComparisons} comparisons, ${ageMs}ms)`,
							"info",
						);
					}
				} catch (err: unknown) {
					// Timeout or other error
					if (!state.calibration || state.calibration.pendingAgentId !== trackingId) {
						return;
					}
					
					const ageMs = state.calibration.pendingSpawnTime
						? Date.now() - state.calibration.pendingSpawnTime
						: 0;
					abandonClassifier(agentId);
					state.calibration.llmCallsFailed++;
					
					const reason = err instanceof Error && err.message === "timeout" 
						? "timeout" 
						: `error:${String(err).slice(0, 40)}`;
					writePendingAsFailed(state.calibration, reason, ageMs);
					clearPending(state.calibration);
					
					if (state.debugEnabled) {
						ctx.ui.notify(
							reason === "timeout"
								? `[calibration] Classifier timed out after ${ageMs}ms`
								: `[calibration] Classifier error: ${String(err).slice(0, 60)}`,
							"warning",
						);
					}
				}
			};

			// Start the race
			Promise.race([handleResult(), timeoutPromise]).catch(() => {
				// Timeout already handled in handleResult catch block
			});
		})
		.catch((err) => {
			if (!state.calibration || state.calibration.pendingAgentId !== trackingId) {
				return;
			}

			state.calibration.llmCallsFailed++;
			writePendingAsFailed(
				state.calibration,
				`spawn-threw:${String(err).slice(0, 40)}`,
				0,
			);
			clearPending(state.calibration);

			if (state.debugEnabled) {
				ctx.ui.notify(
					`[calibration] Spawn threw: ${String(err).slice(0, 100)}`,
					"warning",
				);
			}
		});
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

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
	cal.pendingSpawnTime = undefined;
}
