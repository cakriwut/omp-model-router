import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TraceRecord } from "../../calibration/types";
import type { ParsedTrace } from "./types";

const DEFAULT_TRACE_DIR = () =>
	join(homedir(), ".omp", "agent", "model-router", "traces");

export function resolveTraceFiles(pathArg?: string): string[] {
	const target = pathArg ?? DEFAULT_TRACE_DIR();
	if (!existsSync(target)) {
		throw new Error(`Trace path does not exist: ${target}`);
	}
	const stat = statSync(target);
	if (stat.isFile()) return [target];
	if (stat.isDirectory()) {
		return readdirSync(target)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(target, f))
			.sort();
	}
	throw new Error(`Trace path is neither file nor directory: ${target}`);
}

export function parseTraceFiles(files: string[]): ParsedTrace {
	const records: TraceRecord[] = [];
	const failureRecords: ParsedTrace["failureRecords"] = [];

	for (const file of files) {
		const content = readFileSync(file, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed: TraceRecord & { failureReason?: string };
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (!parsed.heuristicDecision) continue;
			records.push(parsed);
			if (!parsed.llmDecision) failureRecords.push(parsed);
		}
	}

	return { records, failureRecords };
}
