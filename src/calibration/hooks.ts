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
	cancelPendingSave,
} from "./index";
import type { TraceRecord } from "./types";
import { getLastUserText, buildClassifierPrompt } from "./classifier-utils";
import { loadPitfalls } from "./pitfalls";
import { countWords } from "../routing/text.js";
import { shortenModelRef } from "../ui/theme.js";
import { appendPromptRecord } from "./trace.js";
import { join } from "node:path";
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

	cancelPendingSave();

	const cal = state.calibration;
	if (cal.totalComparisons > 0) {
		mergeSessionIntoGlobal(cal, getCurrentVersion(), true);
	}

	state.calibration = undefined;
}

/**
 * Spawn async classifier after routing decision.
 * Extracts all needed primitives from context/ctx BEFORE the async closure
 * so the closure holds only strings/numbers — never Context, ExtensionContext,
 * or sessionManager references (which keep the full conversation tree in RAM).
 */
export function spawnClassifierForTurn(
	state: RouterState,
	config: RouterConfig,
	heuristicTier: RouterTier,
	context: Context,
	sessionScope?: import("../state").SessionScope,
	bucket?: string,
): void {
	if (!config.calibration?.enabled || !state.calibration) return;

	// Resolve session scope: use the explicitly passed one (parallel-safe) or
	// fall back to state.scope (backward compat for tests / non-parallel callers).
	const scope = sessionScope ?? state.scope;

	const cal = state.calibration;
	if (cal.pendingAgentId) return; // skip if already pending
	if (!config.calibration.classifierModel) return;

	// Dedup: skip if we already spawned an async classifier for this user message.
	// Key = String(userMessagesSeen) — coarse, once-per-user-message granularity.
	// Uses the SESSION-SCOPED counter so parallel sub-agents each have their own
	// dedup gate and cannot clobber each other's state.
	const asyncKey = String(scope.userMessagesSeen);
	if (scope.lastAsyncClassifierKey === asyncKey) return;

	// Skip async spawn in adaptive mode when sync classifier already ran this turn.
	if (config.calibration.mode === "adaptive" && scope.lastDecision?.syncClassifierRan) {
		return;
	}
	const ctx = state.getSessionContext(scope.sessionId);
	if (!ctx) return;

	// ── Extract all needed primitives NOW, before entering the async closure ──
	// Nothing from context, ctx, or state should be captured by the closure.
	// Each of these holds (directly or transitively) the full session tree.
	const userPrompt = getLastUserText(context);
	const decision = scope.lastDecision; // use session-scoped decision, not state.lastDecision
	const pitfalls = loadPitfalls(state.currentCwd, config.pitfallsPath);
	const classifierPrompt = buildClassifierPrompt(
		context,
		decision?.phase,
		// toolCounts not available here; that's fine, the bucket already updated the cache key
		undefined,
		pitfalls || undefined,
	);
	const modelRegistry = ctx.modelRegistry; // registry ref is safe — small, no session data
	const notifyFn = ctx.ui.notify.bind(ctx.ui);  // bound fn, not ctx itself
	const debugEnabled = state.debugEnabled;
	const classifierModelRef = config.calibration.classifierModel;
	const calibrationMode = config.calibration.mode ?? "telemetry";
	const traceEnabled = !!config.calibration.traceEnabled;

	cal.llmCallsAttempted++;
	cal.pendingHeuristicTier = heuristicTier;
	cal.pendingHeuristicPhase = decision?.phase ?? "implementation";
	cal.pendingHeuristicReasoning = decision?.reasoning ?? "";
	cal.pendingRuleMatched = decision?.isRuleMatched ?? false;
	cal.pendingPrompt = truncatePrompt(userPrompt, 500);
	cal.pendingClassifierPrompt = classifierPrompt;
	cal.pendingBucket = bucket;
	cal.pendingUserMsgIndex = scope.userMessagesSeen;
	cal.pendingToolResultCount = context.messages.filter((m) => m.role === "toolResult").length;
	cal.pendingTurnIndex = cal.turnsProcessed;
	cal.pendingSpawnTime = Date.now();

	// Snapshot the trace file path (string — safe to capture)
	const traceFilePath = traceEnabled ? cal.traceFilePath : undefined;
	const artifactsDir = traceEnabled
		? (ctx as any)?.sessionManager?.getArtifactsDir?.() ?? null
		: null;
	const promptLogPath: string | undefined = (typeof artifactsDir === "string" && artifactsDir)
		? join(artifactsDir, "classifierPrompt.jsonl")
		: undefined;
	cal.promptLogPath = promptLogPath;

	// Synthetic tracking ID
	const trackingId = `classifier-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	cal.pendingAgentId = trackingId;
	// Mark this user message as having an async classifier spawned.
	// Set synchronously (before the promise) so re-entrant calls are blocked immediately.
	// Write to scope (not state) so parallel sub-agents each have their own gate.
	scope.lastAsyncClassifierKey = asyncKey;

	if (debugEnabled) {
		notifyFn(
			`[calibration] Spawning classifier for: "${truncatePrompt(userPrompt, 60)}"`,
			"info",
		);
	}

	// Spawn the classifier — pass the pre-built prompt string, NOT the full context
	const classifierPromise = spawnClassifierAgent(
		classifierModelRef,
		classifierPrompt,
		modelRegistry,
	);

	// Attach promise handler for when result arrives.
	// Closure captures ONLY: state (RouterState — needed for calibration matrix),
	// trackingId (string), notifyFn (bound UI fn), debugEnabled (bool),
	// classifierModelRef (string|string[]), calibrationMode (string),
	// traceFilePath (string|undefined).
	// Does NOT capture: context, ctx, or any object with sessionManager.
	classifierPromise
		.then(async (agentId) => {
			const writePromptLog = (
				verdict: { tier: RouterTier; reasoning: string } | null,
				error: string | undefined,
				latencyMs: number,
			): void => {
				const pl = state.calibration?.promptLogPath;
				const pr = state.calibration?.pendingClassifierPrompt;
				if (!pl || !pr) return;
				const refForModel = Array.isArray(classifierModelRef)
					? classifierModelRef[0]
					: classifierModelRef;
				appendPromptRecord(pl, {
					timestamp:    new Date().toISOString(),
					turnIndex:    state.calibration?.pendingTurnIndex ?? 0,
					userMsgIndex: state.calibration?.pendingUserMsgIndex ?? 0,
					bucket:       state.calibration?.pendingBucket,
					model:        refForModel ?? "unknown",
					heuristicTier: (state.calibration?.pendingHeuristicTier ?? "medium") as RouterTier,
					verdict,
					error,
					latencyMs,
					prompt: pr,
				});
			};

			// If calibration was disabled or state reset since spawn, bail
			if (!state.calibration || state.calibration.pendingAgentId !== trackingId) {
				return;
			}

			if (!agentId) {
				// Spawn returned no ID
				state.calibration.llmCallsFailed++;
				writePendingAsFailed(state.calibration, "spawn-no-id", 0);
				writePromptLog(null, "spawn-no-id", 0);
				clearPending(state.calibration);
				if (debugEnabled) {
					notifyFn(
						"[calibration] Spawn returned no agentId",
						"warning",
					);
				}
				return;
			}

			// Poll for result with hard timeout.
			// Use a cancellation flag so the loop exits immediately when
			// the timeout fires — prevents orphaned infinite polling.
			const MAX_WAIT_MS = 30_000; // 30s (was 60s — reduced to limit leak window)
			const POLL_INTERVAL_MS = 1000;
			let cancelled = false;

			const timeoutHandle = setTimeout(() => {
				cancelled = true;
				// Eagerly clean up on timeout so next turn can spawn a new classifier
				if (state.calibration?.pendingAgentId === trackingId) {
					const ageMs = state.calibration.pendingSpawnTime
						? Date.now() - state.calibration.pendingSpawnTime
						: 0;
					abandonClassifier(agentId);
					state.calibration.llmCallsFailed++;
					writePendingAsFailed(state.calibration, "timeout", ageMs);
					writePromptLog(null, "timeout", ageMs);
					clearPending(state.calibration);
					if (debugEnabled) {
						notifyFn(
							`[calibration] Classifier timed out after ${ageMs}ms`,
							"warning",
						);
					}
				}
			}, MAX_WAIT_MS);

			// Polling loop — exits on: result ready, cancelled, or state cleared
			try {
				let result: Awaited<ReturnType<typeof pollClassifierResult>>;
				do {
					result = await pollClassifierResult(agentId, POLL_INTERVAL_MS);
				} while (
					!result.ready &&
					!cancelled &&
					state.calibration?.pendingAgentId === trackingId
				);

				clearTimeout(timeoutHandle);

				// If cancelled or state cleared, bail silently (timeout handler already cleaned up)
				if (cancelled || !state.calibration || state.calibration.pendingAgentId !== trackingId) {
					return;
				}

				// Result ready — process it
				abandonClassifier(agentId);
				const ageMs = state.calibration.pendingSpawnTime
					? Date.now() - state.calibration.pendingSpawnTime
					: 0;

				if (result.error) {
					state.calibration.llmCallsFailed++;
					writePromptLog(null, `error:${result.error.slice(0, 60)}`, ageMs);
					writePendingAsFailed(
						state.calibration,
						`error:${result.error.slice(0, 60)}`,
						ageMs,
					);
					clearPending(state.calibration);
					if (debugEnabled) {
						notifyFn(
							`[calibration] Classifier failed: ${result.error}`,
							"warning",
						);
					}
					return;
				}

				if (!result.verdict || !state.calibration.pendingHeuristicTier) {
					state.calibration.llmCallsFailed++;
					writePendingAsFailed(state.calibration, "no-verdict-or-tier", ageMs);
					writePromptLog(null, "no-verdict-or-tier", ageMs);
					clearPending(state.calibration);
					return;
				}

				const heuristicTierFinal = state.calibration.pendingHeuristicTier;
				const verdict = result.verdict;

				updateCalibrationMatrix(state.calibration, heuristicTierFinal, verdict.tier);
				writePromptLog(verdict, undefined, ageMs);

				if (traceFilePath) {
					writeCompletedTrace(state.calibration, verdict, ageMs);
				}

				// Badge-style log with decision (always shown)
				const refForLabel = Array.isArray(classifierModelRef) ? classifierModelRef[0] : classifierModelRef;
				const shortName = refForLabel ? shortenModelRef(refForLabel) : 'classifier';
				const agreed = heuristicTierFinal === verdict.tier;
				console.log(`⚡ classifier → ${shortName} (async·${calibrationMode}) → ${verdict.tier} ${agreed ? '✓' : '✗'}`);

				if (debugEnabled) {
					notifyFn(
						`[calibration] h=${heuristicTierFinal}, llm=${verdict.tier} ${agreed ? '✓' : '✗'} (${state.calibration.totalComparisons} comparisons, ${ageMs}ms)`,
						"info",
					);
				}

				clearPending(state.calibration);
			} catch (err: unknown) {
				clearTimeout(timeoutHandle);
				if (cancelled || !state.calibration || state.calibration.pendingAgentId !== trackingId) {
					return;
				}

				const ageMs = state.calibration.pendingSpawnTime
					? Date.now() - state.calibration.pendingSpawnTime
					: 0;
				abandonClassifier(agentId);
				state.calibration.llmCallsFailed++;

				const reason = `error:${String(err).slice(0, 40)}`;
				writePromptLog(null, reason, ageMs);
				writePendingAsFailed(state.calibration, reason, ageMs);
				clearPending(state.calibration);

				if (debugEnabled) {
					notifyFn(
						`[calibration] Classifier error: ${String(err).slice(0, 60)}`,
						"warning",
					);
				}
			}
		})
		.catch((err) => {
			if (!state.calibration || state.calibration.pendingAgentId !== trackingId) {
				return;
			}

			state.calibration.llmCallsFailed++;
			const _pl = state.calibration?.promptLogPath;
			const _pr = state.calibration?.pendingClassifierPrompt;
			if (_pl && _pr) {
				const _ref = Array.isArray(classifierModelRef) ? classifierModelRef[0] : classifierModelRef;
				appendPromptRecord(_pl, {
					timestamp: new Date().toISOString(),
					turnIndex: state.calibration?.pendingTurnIndex ?? 0,
					userMsgIndex: state.calibration?.pendingUserMsgIndex ?? 0,
					bucket: state.calibration?.pendingBucket,
					model: _ref ?? "unknown",
					heuristicTier: (state.calibration?.pendingHeuristicTier ?? "medium") as RouterTier,
					verdict: null,
					error: `spawn-threw:${String(err).slice(0, 40)}`,
					latencyMs: 0,
					prompt: _pr,
				});
			}
			writePendingAsFailed(
				state.calibration,
				`spawn-threw:${String(err).slice(0, 40)}`,
				0,
			);
			clearPending(state.calibration);

			if (debugEnabled) {
				notifyFn(
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
			wordCount: countWords(cal.pendingPrompt ?? ""),
			toolResultCount: cal.pendingToolResultCount ?? 0,
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
			wordCount: countWords(cal.pendingPrompt ?? ""),
			toolResultCount: cal.pendingToolResultCount ?? 0,
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
	cal.pendingToolResultCount = undefined;
	cal.pendingTurnIndex = undefined;
	cal.pendingSpawnTime = undefined;
	cal.pendingClassifierPrompt = undefined;
	cal.pendingBucket = undefined;
	cal.pendingUserMsgIndex = undefined;
	cal.promptLogPath = undefined;
}
