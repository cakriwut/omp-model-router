import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	loadGlobalCalibration,
	resetGlobalCalibration,
	saveGlobalSnapshot,
} from "../../calibration/global";
import type { GlobalCalibrationSnapshot } from "../../calibration/types";

const GLOBAL_FILE = () =>
	join(homedir(), ".omp", "agent", "model-router", "calibration-global.json");

export function exportGlobal(toPath: string): { path: string; bytes: number } {
	const global = loadGlobalCalibration();
	if (!global) {
		throw new Error("No global calibration to export.");
	}
	const json = JSON.stringify(global, null, 2);
	writeFileSync(toPath, json, "utf-8");
	return { path: toPath, bytes: json.length };
}

export function importGlobal(fromPath: string): {
	totalSessions: number;
	totalComparisons: number;
} {
	if (!existsSync(fromPath)) {
		throw new Error(`Import file not found: ${fromPath}`);
	}
	const data = JSON.parse(readFileSync(fromPath, "utf-8")) as
		| GlobalCalibrationSnapshot
		| undefined;
	if (
		!data ||
		typeof data !== "object" ||
		data.version !== 1 ||
		!Array.isArray(data.matrix) ||
		data.matrix.length !== 3
	) {
		throw new Error("Invalid global calibration snapshot.");
	}
	saveGlobalSnapshot(data);
	return {
		totalSessions: data.metadata.totalSessions,
		totalComparisons: data.metadata.totalComparisons,
	};
}

export function resetGlobal(): { existed: boolean; path: string } {
	const path = GLOBAL_FILE();
	const existed = existsSync(path);
	resetGlobalCalibration();
	return { existed, path };
}
