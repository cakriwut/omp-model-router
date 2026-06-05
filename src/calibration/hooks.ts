/**
 * Calibration system lifecycle hooks
 * Wired into OMP extension events: session_start, turn_start, turn_end, session_end
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { RouterConfig } from "../types";
import {
	initSessionCalibration,
	loadGlobalCalibration,
	mergeSessionIntoGlobal,
	openTraceFile,
	cancelPendingSave,
} from "./index";
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
 * turn_end: No-op
 */
export async function onTurnEnd(
	_event: unknown,
	_ctx: ExtensionContext,
	_state: RouterState,
	_config: RouterConfig,
): Promise<void> {
	// no-op
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
