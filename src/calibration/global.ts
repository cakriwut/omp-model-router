import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type {
	GlobalCalibrationSnapshot,
	SessionCalibration,
} from "./types";

const CALIBRATION_DIR = () => join(getAgentDir(), "model-router");
const GLOBAL_FILE = () => join(CALIBRATION_DIR(), "calibration-global.json");

// Debouncing state
let lastSaveTime = 0;
let pendingSave: NodeJS.Timeout | undefined;
const MIN_SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const COMPARISON_THRESHOLD = 50; // Save every 50 new comparisons

/**
 * Load global calibration snapshot from disk
 * Returns undefined if file doesn't exist or is invalid
 */
export function loadGlobalCalibration():
	| GlobalCalibrationSnapshot
	| undefined {
	const path = GLOBAL_FILE();
	if (!existsSync(path)) return undefined;

	try {
		const content = readFileSync(path, "utf-8");
		const data = JSON.parse(content);

		if (!isValidGlobalSnapshot(data)) {
			console.warn(
				"[model-router] Global calibration file corrupt; ignoring",
			);
			return undefined;
		}

		return data;
	} catch (error) {
		console.warn(
			`[model-router] Failed to load global calibration: ${error}`,
		);
		return undefined;
	}
}

/**
 * Merge a session calibration into global snapshot
 * Call on session_end or periodically during long sessions
 *
 * @param immediate - Skip debouncing and save immediately
 */
export function mergeSessionIntoGlobal(
	session: SessionCalibration,
	routerVersion: string,
	immediate = false,
): void {
	const global = loadGlobalCalibration() ?? createEmptySnapshot(routerVersion);

	// Merge matrix counts
	for (let h = 0; h < 3; h++) {
		for (let l = 0; l < 3; l++) {
			global.matrix[h][l] += session.matrix[h][l];
		}
	}

	global.metadata.totalSessions++;
	global.metadata.totalComparisons += session.totalComparisons;
	global.metadata.lastUpdated = Date.now();
	global.metadata.routerVersion = routerVersion;

	if (immediate) {
		saveGlobalSnapshot(global);
	} else {
		debouncedSave(global, session.totalComparisons);
	}
}

/**
 * Save global snapshot to disk immediately
 */
export function saveGlobalSnapshot(snapshot: GlobalCalibrationSnapshot): void {
	const dir = CALIBRATION_DIR();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const path = GLOBAL_FILE();
	try {
		const content = JSON.stringify(snapshot, null, 2);
		writeFileSync(path, content, "utf-8");
		lastSaveTime = Date.now();
	} catch (error) {
		console.error(
			`[model-router] Failed to save global calibration: ${error}`,
		);
	}
}

/**
 * Delete global calibration file (for reset command)
 */
export function resetGlobalCalibration(): void {
	const path = GLOBAL_FILE();
	if (existsSync(path)) {
		try {
			const fs = require("node:fs");
			fs.unlinkSync(path);
		} catch (error) {
			console.error(
				`[model-router] Failed to delete global calibration: ${error}`,
			);
		}
	}
}

/**
 * Cancel any pending debounced save timer. Call on session end to prevent
 * stale snapshot closures from staying live after calibration state is cleared.
 */
export function cancelPendingSave(): void {
	if (pendingSave) {
		clearTimeout(pendingSave);
		pendingSave = undefined;
	}
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function createEmptySnapshot(version: string): GlobalCalibrationSnapshot {
	return {
		version: 1,
		matrix: [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		],
		metadata: {
			totalSessions: 0,
			totalComparisons: 0,
			lastUpdated: Date.now(),
			routerVersion: version,
		},
	};
}

function isValidGlobalSnapshot(data: unknown): data is GlobalCalibrationSnapshot {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;

	return (
		obj.version === 1 &&
		Array.isArray(obj.matrix) &&
		obj.matrix.length === 3 &&
		obj.matrix.every(
			(row) => Array.isArray(row) && row.length === 3 && row.every((n) => typeof n === "number"),
		) &&
		typeof obj.metadata === "object" &&
		obj.metadata !== null
	);
}

/**
 * Debounced save: only persist if enough time has passed or enough comparisons accumulated
 */
function debouncedSave(
	snapshot: GlobalCalibrationSnapshot,
	newComparisons: number,
): void {
	const now = Date.now();
	const timeSinceLastSave = now - lastSaveTime;
	const shouldSaveByTime = timeSinceLastSave >= MIN_SAVE_INTERVAL_MS;
	const shouldSaveByVolume = newComparisons >= COMPARISON_THRESHOLD;

	if (shouldSaveByTime || shouldSaveByVolume) {
		if (pendingSave) {
			clearTimeout(pendingSave);
		}
		saveGlobalSnapshot(snapshot);
		return;
	}

	// Queue a deferred save
	if (!pendingSave) {
		const delay = MIN_SAVE_INTERVAL_MS - timeSinceLastSave;
		pendingSave = setTimeout(() => {
			saveGlobalSnapshot(snapshot);
			pendingSave = undefined;
		}, Math.max(0, delay));
	}
}
