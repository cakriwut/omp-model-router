import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname, sep } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { PromptLogRecord } from "../calibration/trace";
import { createLogViewerFactory, createSessionPickerFactory, parseJsonlFile, type SessionLogEntry } from "../tui/log-viewer";

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
	const all = args.includes("--all") || args.includes("-a");

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

	// Load records: current session only by default.
	// --all scans the full ~/.omp/agent tree (legacy behaviour for text mode).
	let records: PromptLogRecord[] = [];
	if (logPath) {
		records = parseJsonlFile(logPath);
	} else if (all) {
		const scanDir = join(homedir(), ".omp", "agent");
		const files = findPromptLogFiles(scanDir);
		for (const file of files) {
			records.push(...parseJsonlFile(file));
		}
		records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	}

	if (records.length === 0) {
		const tip = logPath
			? "Ensure calibration.traceEnabled is true in your config."
			: "No log for current session. Use --all to search all sessions.";
		ctx.ui.notify(`No classifier prompt log entries found.\n${tip}`, "warning");
		return;
	}

	// ── TUI mode: open interactive split-panel viewer ──
	if (ctx.hasUI && !forceText && !showPrompts) {
		// When --all is set, show session picker first, then load selected session
		if (all) {
			const scanDir = join(homedir(), ".omp", "agent");
			const sessions = discoverSessions(scanDir, logPath);

			if (sessions.length === 0) {
				ctx.ui.notify(
					"No classifier log sessions found.\n" +
					"Ensure calibration.traceEnabled is true in your config.",
					"warning",
				);
				return;
			}

			// Open session picker in TUI
			const selectedSession = await ctx.ui.custom(createSessionPickerFactory(sessions, logPath));

			if (!selectedSession) return;

			// Load the selected session's classifier log
			const selectedRecords = parseJsonlFile(selectedSession.path);
			const displayRecords = last > 0 ? selectedRecords.slice(-last) : selectedRecords;

			// Open log viewer with selected session
			ctx.ui.custom(createLogViewerFactory(displayRecords, selectedSession.path, sessions));
			return;
		}

		// Normal path: show current session's log with session picker in viewer
		const displayRecords = last > 0 ? records.slice(-last) : records;
		// Discover all available sessions so the viewer can offer a session picker
		const sessions = discoverSessions(join(homedir(), ".omp", "agent"), logPath);
		ctx.ui.custom(createLogViewerFactory(displayRecords, logPath, sessions));
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

/**
 * Discover all classifierPrompt.jsonl files under `scanDir` and build
 * SessionLogEntry descriptors for the TUI session picker.
 *
 * Reads the session's JSONL header (in the same directory as classifierPrompt.jsonl)
 * to extract friendly title, id, and timestamps. Falls back to path-based labels.
 *
 * Sorted newest-last-timestamp first. Current session (matching `currentPath`)
 * is pinned to top.
 */
function discoverSessions(
	scanDir: string,
	currentPath: string | undefined,
): SessionLogEntry[] {
	const paths = findPromptLogFiles(scanDir);
	const entries: SessionLogEntry[] = [];

	for (const classifierPath of paths) {
		const recs = parseJsonlFile(classifierPath);
		const recordCount = recs.length;
		const lastTimestamp = recordCount > 0 ? recs[recordCount - 1].timestamp : undefined;

		// Try to read the session JSONL header for friendly metadata
		let sessionId = "";
		let sessionTitle = "";
		let sessionTimestamp = "";

		try {
			// classifierPrompt.jsonl lives at <project>/<sessionId>/classifierPrompt.jsonl
			// Session header JSONL lives at <project>/<sessionId>.jsonl (sibling of sessionDir)
			const sessionDir = dirname(classifierPath);
			const sessionJsonlPath = sessionDir + ".jsonl";
			const content = readFileSync(sessionJsonlPath, "utf-8");
			const firstLine = content.split("\n")[0];

			if (firstLine) {
				const header: unknown = JSON.parse(firstLine);
				if (typeof header === "object" && header !== null) {
					const h = header as Record<string, unknown>;
					if (h.type === "session") {
						sessionId = String(h.id ?? "");
						sessionTitle = String(h.title ?? "");
						sessionTimestamp = String(h.timestamp ?? "");
					}
				}
			}
		} catch {
			// Fall back to path-based label if session metadata unavailable
		}

		// Fallback: use path components as label if no title available
		if (!sessionTitle) {
			const parts = classifierPath.split(sep);
			sessionTitle = parts.slice(-2).join(" / "); // e.g., "sessionId / artifacts"
		}

		entries.push({
			path: classifierPath,
			label: sessionTitle || sessionId || basename(dirname(classifierPath)),
			recordCount,
			lastTimestamp: sessionTimestamp || lastTimestamp,
		});
	}

	// Sort: most recently active first
	entries.sort((a, b) => {
		if (!a.lastTimestamp && !b.lastTimestamp) return 0;
		if (!a.lastTimestamp) return 1;
		if (!b.lastTimestamp) return -1;
		return b.lastTimestamp.localeCompare(a.lastTimestamp);
	});

	// Move current session to top when present
	if (currentPath) {
		const idx = entries.findIndex(e => e.path === currentPath);
		if (idx > 0) {
			const [cur] = entries.splice(idx, 1);
			entries.unshift(cur);
		}
	}

	return entries;
}

