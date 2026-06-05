/**
 * omp-router prompt-log — view classifier prompt logs.
 *
 * Usage:
 *   omp-router prompt-log [path]           # pretty-print classifierPrompt.jsonl
 *   omp-router prompt-log --last [N]       # show last N entries (default 10)
 *   omp-router prompt-log --json [path]    # raw JSON output
 *   omp-router prompt-log --prompts [path] # show full prompts (default: truncated)
 *
 * `path` can be a specific .jsonl file or a directory to scan recursively.
 * Defaults to ~/.omp/agent/ (scans all classifierPrompt.jsonl files).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { PromptLogRecord } from "../calibration/trace";

const DEFAULT_SCAN_DIR = () => join(homedir(), ".omp", "agent");

interface PromptLogOptions {
	path?: string;
	last?: number;
	json?: boolean;
	showPrompts?: boolean;
}

function parseArgs(args: string[]): PromptLogOptions {
	const opts: PromptLogOptions = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--last") {
			opts.last = parseInt(args[++i] ?? "10", 10) || 10;
		} else if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--prompts") {
			opts.showPrompts = true;
		} else if (!arg.startsWith("-")) {
			opts.path = arg;
		}
	}
	return opts;
}

function findPromptLogFiles(dir: string): string[] {
	const results: string[] = [];
	if (!existsSync(dir)) return results;

	const st = statSync(dir);
	if (st.isFile() && dir.endsWith(".jsonl")) {
		return [dir];
	}
	if (!st.isDirectory()) return results;

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isFile() && entry.name === "classifierPrompt.jsonl") {
				results.push(fullPath);
			} else if (entry.isDirectory()) {
				results.push(...findPromptLogFiles(fullPath));
			}
		}
	} catch {
		// permission errors, etc.
	}
	return results;
}

function isPromptLogRecord(rec: unknown): rec is PromptLogRecord {
	if (!rec || typeof rec !== "object") return false;
	const r = rec as Record<string, unknown>;
	return typeof r.timestamp === "string" && "turnIndex" in r && "prompt" in r;
}

function parseJsonlFile(path: string): PromptLogRecord[] {
	const records: PromptLogRecord[] = [];
	try {
		const content = readFileSync(path, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isPromptLogRecord(parsed)) {
					records.push(parsed);
				}
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// skip unreadable files
	}
	return records;
}

const TIER_COLORS: Record<string, string> = {
	high: "\x1b[31m",    // red
	medium: "\x1b[33m",  // yellow
	low: "\x1b[32m",     // green
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function formatRecord(rec: PromptLogRecord, showPrompts: boolean): string {
	const lines: string[] = [];
	const tierColor = TIER_COLORS[rec.verdict?.tier ?? ""] ?? "";
	const ts = rec.timestamp.replace("T", " ").replace(/\.\d+Z$/, "");

	lines.push(
		`${DIM}${ts}${RESET}  turn:${rec.turnIndex}  msg:${rec.userMsgIndex}  ` +
		`bucket:${BOLD}${rec.bucket ?? "—"}${RESET}  ` +
		`model:${rec.model}  ${rec.latencyMs}ms`
	);

	const hColor = TIER_COLORS[rec.heuristicTier] ?? "";
	if (rec.verdict) {
		const agree = rec.heuristicTier === rec.verdict.tier;
		const marker = agree ? "✓" : "✗";
		lines.push(
			`  heuristic: ${hColor}${rec.heuristicTier}${RESET}  →  ` +
			`classifier: ${tierColor}${rec.verdict.tier}${RESET}  ${marker}` +
			(rec.verdict.reasoning ? `  "${rec.verdict.reasoning}"` : "")
		);
	} else if (rec.error) {
		lines.push(`  heuristic: ${hColor}${rec.heuristicTier}${RESET}  →  ⚠ error: ${rec.error}`);
	} else {
		lines.push(`  heuristic: ${hColor}${rec.heuristicTier}${RESET}  →  (no verdict)`);
	}

	if (showPrompts && rec.prompt) {
		lines.push(`  ${DIM}prompt:${RESET}`);
		// Indent prompt lines
		for (const pl of rec.prompt.split("\n").slice(0, 40)) {
			lines.push(`    ${DIM}${pl}${RESET}`);
		}
		if (rec.prompt.split("\n").length > 40) {
			lines.push(`    ${DIM}... (${rec.prompt.split("\n").length - 40} more lines)${RESET}`);
		}
	}

	return lines.join("\n");
}

export async function runPromptLog(args: string[]): Promise<number> {
	const opts = parseArgs(args);
	const scanPath = opts.path ?? DEFAULT_SCAN_DIR();

	if (!existsSync(scanPath)) {
		console.error(`Path not found: ${scanPath}`);
		return 1;
	}

	const files = findPromptLogFiles(scanPath);
	if (files.length === 0) {
		console.error(`No classifierPrompt.jsonl files found in: ${scanPath}`);
		console.error("Ensure calibration.traceEnabled is true in your config.");
		return 1;
	}

	// Collect and sort all records by timestamp
	let allRecords: (PromptLogRecord & { _file: string })[] = [];
	for (const file of files) {
		const records = parseJsonlFile(file);
		for (const r of records) {
			allRecords.push({ ...r, _file: file });
		}
	}
	allRecords.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	// Apply --last filter
	if (opts.last) {
		allRecords = allRecords.slice(-opts.last);
	}

	if (allRecords.length === 0) {
		console.error("No records found in prompt log files.");
		return 1;
	}

	// Output
	if (opts.json) {
		for (const rec of allRecords) {
			const { _file, ...clean } = rec;
			console.log(JSON.stringify(clean));
		}
	} else {
		console.log(`${BOLD}Classifier Prompt Log${RESET}  (${allRecords.length} records from ${files.length} file(s))\n`);

		let lastFile = "";
		for (const rec of allRecords) {
			if (rec._file !== lastFile) {
				lastFile = rec._file;
				console.log(`${DIM}── ${basename(rec._file, ".jsonl")} ──${RESET}`);
			}
			console.log(formatRecord(rec, opts.showPrompts ?? false));
			console.log("");
		}

		// Summary
		const verdicts = allRecords.filter(r => r.verdict);
		const errors = allRecords.filter(r => r.error);
		const agreements = verdicts.filter(r => r.heuristicTier === r.verdict!.tier).length;
		const avgLatency = verdicts.length > 0
			? Math.round(verdicts.reduce((sum, r) => sum + r.latencyMs, 0) / verdicts.length)
			: 0;

		console.log(`${DIM}───────────────────${RESET}`);
		console.log(
			`Total: ${allRecords.length}  Verdicts: ${verdicts.length}  ` +
			`Errors: ${errors.length}  Agreement: ${agreements}/${verdicts.length} ` +
			`(${verdicts.length > 0 ? Math.round(agreements / verdicts.length * 100) : 0}%)  ` +
			`Avg latency: ${avgLatency}ms`
		);
	}

	return 0;
}
