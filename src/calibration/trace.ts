import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { TraceRecord } from "./types";
import type { RouterTier } from "../types";

const TRACES_DIR = () => join(getAgentDir(), "model-router", "traces");

/**
 * Open a trace file for a session
 * Returns the file path
 */
export function openTraceFile(sessionId: string): string {
	const dir = TRACES_DIR();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const filename = `${sessionId}-calibration.jsonl`;
	const path = join(dir, filename);

	// Create empty file if it doesn't exist
	if (!existsSync(path)) {
		try {
			writeFileSync(path, "", "utf-8");
		} catch (error) {
			console.error(
				`[model-router] Failed to create trace file: ${error}`,
			);
		}
	}

	return path;
}

/**
 * Append a trace record to the file
 */
export function appendTraceRecord(
	traceFilePath: string,
	record: TraceRecord,
): void {
	try {
		const line = JSON.stringify(record) + "\n";
		appendFileSync(traceFilePath, line, "utf-8");
	} catch (error) {
		console.error(
			`[model-router] Failed to append trace record: ${error}`,
		);
	}
}

/**
 * Truncate prompt for trace (200 char limit)
 */
export function truncatePrompt(prompt: string, maxLength = 200): string {
	if (prompt.length <= maxLength) return prompt;
	return prompt.slice(0, maxLength - 3) + "...";
}

export interface PromptLogRecord {
	timestamp: string;
	turnIndex: number;
	userMsgIndex: number;
	bucket: string | undefined;
	model: string;
	heuristicTier: RouterTier;
	verdict: { tier: RouterTier; reasoning: string } | null;
	error?: string;
	latencyMs: number;
	prompt: string;
}

/**
 * Append one classifier prompt+verdict record to classifierPrompt.jsonl.
 * Best-effort: silently swallows write errors.
 */
export function appendPromptRecord(path: string, record: PromptLogRecord): void {
	try {
		appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
	} catch {
		// best-effort
	}
}
