import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { PromptLogRecord } from "../calibration/trace";
import { createLogViewerFactory } from "../tui/log-viewer";

/**
 * /router log [--last N] [--prompts] [--text]
 *
 * Opens an interactive split-panel TUI showing classifier prompt log entries.
 * Falls back to plain text when TUI is unavailable or --text is passed.
 */
export const handleLog = (
	state: RouterState,
) => async (args: string[], ctx: ExtensionContext) => {
	const last = parseLastArg(args);
	const showPrompts = args.includes("--prompts") || args.includes("-p");
	const forceText = args.includes("--text") || args.includes("-t");

	// Try current session's prompt log first
	const sessionMgr = ctx.sessionManager as { getArtifactsDir?: () => string };
	const artifactsDir = sessionMgr.getArtifactsDir?.();
	let logPath: string | undefined;

	if (artifactsDir && existsSync(join(artifactsDir, "classifierPrompt.jsonl"))) {
		logPath = join(artifactsDir, "classifierPrompt.jsonl");
	}

	// Fallback: scan the calibration state's promptLogPath if set
	if (!logPath && state.calibration?.promptLogPath && existsSync(state.calibration.promptLogPath)) {
		logPath = state.calibration.promptLogPath;
	}

	// Fallback: scan ~/.omp/agent for any prompt log files
	let records: PromptLogRecord[] = [];
	if (logPath) {
		records = parseJsonlFile(logPath);
	} else {
		const scanDir = join(homedir(), ".omp", "agent");
		const files = findPromptLogFiles(scanDir);
		for (const file of files) {
			records.push(...parseJsonlFile(file));
		}
		records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	}

	if (records.length === 0) {
		ctx.ui.notify(
			"No classifier prompt log entries found.\n" +
			"Ensure calibration.traceEnabled is true in your config.",
			"warning",
		);
		return;
	}

	// ── TUI mode: open interactive split-panel viewer ──
	if (ctx.hasUI && !forceText && !showPrompts) {
		const displayRecords = last > 0 ? records.slice(-last) : records;
		ctx.ui.custom(createLogViewerFactory(displayRecords, logPath));
		return;
	}

	// Apply --last filter
	const display = last > 0 ? records.slice(-last) : records.slice(-20);

	const lines: string[] = [];
	lines.push(`📋 Classifier Prompt Log (${display.length}/${records.length} entries)\n`);

	for (const rec of display) {
		const ts = rec.timestamp.replace("T", " ").replace(/\.\d+Z$/, "");
		const tierMarker = rec.verdict
			? (rec.heuristicTier === rec.verdict.tier ? "✓" : "✗")
			: "⚠";

		lines.push(
			`${ts}  turn:${rec.turnIndex}  bucket:${rec.bucket ?? "—"}  ` +
			`${rec.latencyMs}ms  ${tierMarker}`
		);

		if (rec.verdict) {
			lines.push(
				`  ${rec.heuristicTier} → ${rec.verdict.tier}  ` +
				`(${rec.model})` +
				(rec.verdict.reasoning ? `  "${rec.verdict.reasoning}"` : "")
			);
		} else if (rec.error) {
			lines.push(`  ${rec.heuristicTier} → error: ${rec.error}`);
		}

		if (showPrompts && rec.prompt) {
			const promptLines = rec.prompt.split("\n");
			const preview = promptLines.slice(0, 20).join("\n");
			lines.push(`  ┌─ prompt ─────────────────`);
			lines.push(`  │ ${preview.replace(/\n/g, "\n  │ ")}`);
			if (promptLines.length > 20) {
				lines.push(`  │ ... (${promptLines.length - 20} more lines)`);
			}
			lines.push(`  └──────────────────────────`);
		}

		lines.push("");
	}

	// Summary line
	const verdicts = records.filter(r => r.verdict);
	const errors = records.filter(r => r.error);
	const agreements = verdicts.filter(r => r.heuristicTier === r.verdict!.tier).length;
	const avgLatency = verdicts.length > 0
		? Math.round(verdicts.reduce((sum, r) => sum + r.latencyMs, 0) / verdicts.length)
		: 0;

	lines.push(
		`Total: ${records.length}  Verdicts: ${verdicts.length}  ` +
		`Errors: ${errors.length}  Agreement: ${agreements}/${verdicts.length} ` +
		`(${verdicts.length > 0 ? Math.round(agreements / verdicts.length * 100) : 0}%)  ` +
		`Avg: ${avgLatency}ms`
	);

	if (logPath) {
		lines.push(`\nSource: ${logPath}`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
};

function parseLastArg(args: string[]): number {
	const idx = args.indexOf("--last");
	if (idx >= 0 && args[idx + 1]) {
		return parseInt(args[idx + 1], 10) || 20;
	}
	return 0;
}

function findPromptLogFiles(dir: string): string[] {
	const results: string[] = [];
	if (!existsSync(dir)) return results;
	const st = statSync(dir);
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
		// permission errors
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
