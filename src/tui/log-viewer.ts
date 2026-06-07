import {
	type Component,
	type TUI,
	matchesKey,
	padding,
	replaceTabs,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { Theme, KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import type { PromptLogRecord } from "../calibration/trace";

// ─── Session entry (for picker) ───────────────────────────────────────────────

export interface SessionLogEntry {
	/** Absolute path to classifierPrompt.jsonl */
	path: string;
	/** Human-readable label derived from path */
	label: string;
	/** Number of records in the file */
	recordCount: number;
	/** ISO timestamp of the most recent record, or undefined */
	lastTimestamp: string | undefined;
}

// ─── Session Picker Component ─────────────────────────────────────────────────

/**
 * Simple list picker for available classifier log sessions.
 * Keys: ↑/↓ navigate · Enter select · ESC cancel
 */
export class SessionPickerComponent implements Component {
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #done: (result: SessionLogEntry | undefined) => void;
	readonly #sessions: SessionLogEntry[];
	#cursor: number;

	constructor(
		_tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: SessionLogEntry | undefined) => void,
		sessions: SessionLogEntry[],
		currentPath: string | undefined,
	) {
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#done = done;
		this.#sessions = sessions;
		// Pre-select current session
		const idx = currentPath ? sessions.findIndex(s => s.path === currentPath) : -1;
		this.#cursor = idx >= 0 ? idx : 0;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = this.#keybindings;

		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
			this.#done(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.#sessions.length > 0)
				this.#cursor = (this.#cursor - 1 + this.#sessions.length) % this.#sessions.length;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.#sessions.length > 0)
				this.#cursor = (this.#cursor + 1) % this.#sessions.length;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const session = this.#sessions[this.#cursor];
			if (session) this.#done(session);
			return;
		}
	}

	render(width: number): string[] {
		const t = this.#theme;
		const lines: string[] = [];

		const hint = t.fg("muted", "[↑↓ navigate · Enter select · ESC cancel]");
		lines.push(`🗂  Select Session  ${hint}`);
		lines.push("");

		if (this.#sessions.length === 0) {
			lines.push(t.fg("muted", "  (no classifier log sessions found)"));
			return lines;
		}

		const maxVisible = 20;
		const { start, end } = this.#visibleWindow(maxVisible);

		if (start > 0) lines.push(t.fg("muted", "  ▲ more"));

		for (let i = start; i < end; i++) {
			const s = this.#sessions[i];
			if (!s) continue;
			const selected = i === this.#cursor;
			const cursor = selected ? "❯ " : "  ";
			const ts = s.lastTimestamp ? formatShortTimestamp(s.lastTimestamp) : "—";
			const meta = t.fg("muted", `${s.recordCount} entries  ${ts}`);
			const label = ellipsize(s.label, Math.max(20, width - 32));
			const line = `${cursor}${label}  ${meta}`;
			lines.push(selected ? t.fg("accent", line) : line);
		}

		if (end < this.#sessions.length) lines.push(t.fg("muted", "  ▼ more"));

		lines.push("");
		lines.push(t.fg("muted", `  ${this.#sessions.length} session(s) found`));

		return lines;
	}

	#visibleWindow(maxVisible: number): { start: number; end: number } {
		const total = this.#sessions.length;
		if (total <= maxVisible) return { start: 0, end: total };
		const half = Math.floor(maxVisible / 2);
		let start = this.#cursor - half;
		if (start < 0) start = 0;
		let end = start + maxVisible;
		if (end > total) {
			end = total;
			start = Math.max(0, end - maxVisible);
		}
		return { start, end };
	}
}

/**
 * Split-panel log viewer:
 *  - Left panel: list of log entries (timestamp, tier arrow, latency)
 *  - Right panel: full detail of highlighted entry (prompt, verdict, reasoning)
 *
 * Keys:
 *  - ↑/↓: navigate entries in left panel
 *  - j/k or ctrl+d/ctrl+u: scroll right panel
 *  - s: open session picker (when sessions list is non-empty)
 *  - ESC/q: close
 */
export class LogViewerComponent implements Component {
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #done: (result: undefined) => void;
	readonly #sessions: SessionLogEntry[];
	#records: PromptLogRecord[];
	#source: string | undefined;
	#cursor = 0;
	#detailScroll = 0;
	#subView: SessionPickerComponent | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: undefined) => void,
		records: PromptLogRecord[],
		source: string | undefined,
		sessions: SessionLogEntry[] = [],
	) {
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#done = done;
		this.#records = records;
		this.#source = source;
		this.#sessions = sessions;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		// Delegate to session picker sub-view when active
		if (this.#subView) {
			this.#subView.handleInput(data);
			return;
		}

		const kb = this.#keybindings;

		// Close
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
			this.#done(undefined);
			return;
		}

		// Open session picker
		if (matchesKey(data, "s") && this.#sessions.length > 0) {
			// SessionPickerComponent does not use TUI internally; pass a stub.
			const stubTui = { requestRender: () => {} } as unknown as TUI;
			this.#subView = new SessionPickerComponent(
				stubTui,
				this.#theme,
				this.#keybindings,
				(selected) => {
					this.#subView = undefined;
					if (selected) this.#loadSession(selected);
				},
				this.#sessions,
				this.#source,
			);
			return;
		}

		// Navigate left panel
		if (kb.matches(data, "tui.select.up")) {
			if (this.#records.length > 0) {
				this.#cursor = Math.max(0, this.#cursor - 1);
				this.#detailScroll = 0;
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.#records.length > 0) {
				this.#cursor = Math.min(this.#records.length - 1, this.#cursor + 1);
				this.#detailScroll = 0;
			}
			return;
		}

		// Scroll detail panel
		if (matchesKey(data, "j") || matchesKey(data, "ctrl+d")) {
			this.#detailScroll += matchesKey(data, "ctrl+d") ? 10 : 1;
			return;
		}
		if (matchesKey(data, "k") || matchesKey(data, "ctrl+u")) {
			this.#detailScroll = Math.max(0, this.#detailScroll - (matchesKey(data, "ctrl+u") ? 10 : 1));
			return;
		}
	}

	render(width: number): string[] {
		// Delegate to session picker when active
		if (this.#subView) {
			return this.#subView.render(width);
		}

		const t = this.#theme;
		const lines: string[] = [];

		// Title
		const title = `📋 Classifier Log (${this.#records.length} entries)`;
		const sessionHint = this.#sessions.length > 0 ? " · s switch session" : "";
		const hint = t.fg("muted", `[↑↓ navigate · j/k scroll detail${sessionHint} · ESC close]`);
		lines.push(`${title}  ${hint}`);
		lines.push("");

		if (this.#records.length === 0) {
			lines.push(t.fg("muted", "  (no log entries found)"));
			if (this.#source) lines.push(t.fg("muted", `  Source: ${this.#source}`));
			return lines;
		}

		// Layout: left panel ~35 chars, separator 3, rest is detail
		const leftWidth = Math.min(38, Math.floor(width * 0.35));
		const sepWidth = 3;
		const rightWidth = Math.max(20, width - leftWidth - sepWidth);

		// Compute visible window for left panel (max entries that fit)
		const maxVisibleEntries = 20;
		const { start: listStart, end: listEnd } = this.#visibleWindow(maxVisibleEntries);

		// Build left panel lines
		const leftLines: string[] = [];
		for (let i = listStart; i < listEnd; i++) {
			const rec = this.#records[i];
			if (!rec) continue;
			leftLines.push(this.#renderListEntry(rec, i === this.#cursor, leftWidth));
		}

		// Scroll indicators
		if (listStart > 0) {
			leftLines.unshift(t.fg("muted", truncateToWidth("  ▲ more", leftWidth)));
		}
		if (listEnd < this.#records.length) {
			leftLines.push(t.fg("muted", truncateToWidth("  ▼ more", leftWidth)));
		}

		// Build right panel (detail of selected entry)
		const selected = this.#records[this.#cursor];
		const detailLines = selected ? this.#renderDetail(selected, rightWidth) : [];

		// Clamp detail scroll
		const maxScroll = Math.max(0, detailLines.length - maxVisibleEntries);
		if (this.#detailScroll > maxScroll) this.#detailScroll = maxScroll;
		const visibleDetail = detailLines.slice(this.#detailScroll, this.#detailScroll + maxVisibleEntries);

		// Compose side-by-side
		const rowCount = Math.max(leftLines.length, visibleDetail.length);
		const sep = " │ ";

		for (let row = 0; row < rowCount; row++) {
			const left = leftLines[row] ?? "";
			const right = visibleDetail[row] ?? "";
			// Pad left to fixed width (account for ANSI)
			const leftPadded = left + padding(Math.max(0, leftWidth - stripAnsi(left).length));
			lines.push(truncateToWidth(replaceTabs(leftPadded + sep + right), width));
		}

		// Detail scroll indicator
		if (detailLines.length > maxVisibleEntries) {
			lines.push("");
			const pos = this.#detailScroll + 1;
			const total = detailLines.length;
			lines.push(t.fg("muted", `  Detail: line ${pos}-${Math.min(pos + maxVisibleEntries - 1, total)}/${total}`));
		}

		// Summary footer
		lines.push("");
		lines.push(this.#renderSummary());
		if (this.#source) {
			lines.push(t.fg("muted", `  Source: ${ellipsize(this.#source, width - 12)}`));
		}

		return lines;
	}

	// ─── Internals ─────────────────────────────────────────────────────────

	/** Load records from a picked session. Resets cursor and scroll. */
	#loadSession(session: SessionLogEntry): void {
		const recs = parseJsonlFile(session.path);
		// Show newest first, consistent with factory
		this.#records = recs.slice().reverse();
		this.#source = session.path;
		this.#cursor = 0;
		this.#detailScroll = 0;
	}

	#visibleWindow(maxVisible: number): { start: number; end: number } {
		const total = this.#records.length;
		if (total <= maxVisible) return { start: 0, end: total };
		// Keep cursor centered
		const half = Math.floor(maxVisible / 2);
		let start = this.#cursor - half;
		if (start < 0) start = 0;
		let end = start + maxVisible;
		if (end > total) {
			end = total;
			start = Math.max(0, end - maxVisible);
		}
		return { start, end };
	}

	#renderListEntry(rec: PromptLogRecord, selected: boolean, maxWidth: number): string {
		const t = this.#theme;
		const cursor = selected ? "❯ " : "  ";
		const ts = formatShortTimestamp(rec.timestamp);
		const tierArrow = rec.verdict
			? `${rec.heuristicTier[0]}→${rec.verdict.tier[0]}`
			: rec.error
				? `${rec.heuristicTier[0]}→✗`
				: `${rec.heuristicTier[0]}→?`;
		const marker = rec.verdict
			? (rec.heuristicTier === rec.verdict.tier ? "✓" : "✗")
			: "⚠";
		const label = `${ts} ${tierArrow} ${marker}`;
		const line = cursor + label;
		const truncated = ellipsize(line, maxWidth);
		return selected ? t.fg("accent", truncated) : truncated;
	}

	#renderDetail(rec: PromptLogRecord, maxWidth: number): string[] {
		const t = this.#theme;
		const lines: string[] = [];

		// Header
		lines.push(t.fg("accent", "─── Entry Detail ───────────────────────"));
		lines.push("");

		// Metadata
		lines.push(`${t.fg("muted", "Time:")}     ${rec.timestamp.replace("T", " ").replace(/\.\d+Z$/, "")}`);
		lines.push(`${t.fg("muted", "Turn:")}     ${rec.turnIndex}  msg:${rec.userMsgIndex}`);
		lines.push(`${t.fg("muted", "Bucket:")}   ${rec.bucket ?? "—"}`);
		lines.push(`${t.fg("muted", "Model:")}    ${rec.model}`);
		lines.push(`${t.fg("muted", "Latency:")}  ${rec.latencyMs}ms`);
		lines.push(`${t.fg("muted", "Heur:")}     ${rec.heuristicTier}`);
		lines.push("");

		// Verdict
		if (rec.verdict) {
			const agree = rec.heuristicTier === rec.verdict.tier;
			const marker = agree ? t.fg("accent", "✓ agree") : t.fg("warning", "✗ override");
			lines.push(`${t.fg("muted", "Verdict:")}  ${rec.verdict.tier}  ${marker}`);
			if (rec.verdict.reasoning) {
				lines.push(`${t.fg("muted", "Reason:")}   ${rec.verdict.reasoning}`);
			}
		} else if (rec.error) {
			lines.push(`${t.fg("warning", "Error:")}    ${rec.error}`);
		} else {
			lines.push(t.fg("muted", "  (no verdict)"));
		}

		lines.push("");

		// Full prompt
		lines.push(t.fg("accent", "─── Prompt ─────────────────────────────"));
		lines.push("");
		if (rec.prompt) {
			const promptLines = rec.prompt.split("\n");
			for (const pl of promptLines) {
				// Wrap long lines to maxWidth
				const wrapped = wrapLine(pl, maxWidth - 2);
				for (const wl of wrapped) {
					lines.push(`  ${wl}`);
				}
			}
		} else {
			lines.push(t.fg("muted", "  (no prompt recorded)"));
		}

		return lines;
	}

	#renderSummary(): string {
		const t = this.#theme;
		const verdicts = this.#records.filter(r => r.verdict);
		const errors = this.#records.filter(r => r.error);
		const agreements = verdicts.filter(r => r.heuristicTier === r.verdict!.tier).length;
		const avgLatency = verdicts.length > 0
			? Math.round(verdicts.reduce((sum, r) => sum + r.latencyMs, 0) / verdicts.length)
			: 0;
		const pct = verdicts.length > 0 ? Math.round(agreements / verdicts.length * 100) : 0;

		return t.fg("muted",
			`  Total:${this.#records.length}  Verdicts:${verdicts.length}  ` +
			`Errors:${errors.length}  Agree:${agreements}/${verdicts.length} (${pct}%)  ` +
			`Avg:${avgLatency}ms`,
		);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatShortTimestamp(ts: string): string {
	// "2026-06-05T12:34:56.789Z" → "05-06-2026 12:34"
	const m = ts.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
	if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}`;
	return ts.slice(0, 16);
}

function ellipsize(value: string, max: number): string {
	if (value.length <= max) return value;
	return value.slice(0, max - 1) + "…";
}

function wrapLine(line: string, maxWidth: number): string[] {
	if (line.length <= maxWidth) return [line];
	const result: string[] = [];
	let remaining = line;
	while (remaining.length > maxWidth) {
		result.push(remaining.slice(0, maxWidth));
		remaining = remaining.slice(maxWidth);
	}
	if (remaining) result.push(remaining);
	return result;
}

/** Strip ANSI escape sequences for width calculations */
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Shared JSONL parser ──────────────────────────────────────────────────────

/**
 * Parse a classifierPrompt.jsonl file into PromptLogRecord[].
 * Exported so log.ts can reuse without duplicating the parser.
 */
export function parseJsonlFile(path: string): PromptLogRecord[] {
	const { readFileSync } = require("node:fs") as typeof import("node:fs");
	const records: PromptLogRecord[] = [];
	try {
		const content = readFileSync(path, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isPromptLogRecord(parsed)) records.push(parsed);
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// skip unreadable files
	}
	return records;
}

function isPromptLogRecord(rec: unknown): rec is PromptLogRecord {
	if (!rec || typeof rec !== "object") return false;
	const r = rec as Record<string, unknown>;
	return typeof r.timestamp === "string" && "turnIndex" in r && "prompt" in r;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLogViewerFactory(
	records: PromptLogRecord[],
	source: string | undefined,
	sessions: SessionLogEntry[] = [],
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: undefined) => void,
) => LogViewerComponent {
	return (tui, theme, keybindings, done) =>
		new LogViewerComponent(tui, theme, keybindings, done, records.slice().reverse(), source, sessions);
}

/**
 * Factory for SessionPickerComponent matching the ctx.ui.custom signature.
 */
export function createSessionPickerFactory(
	sessions: SessionLogEntry[],
	currentPath: string | undefined,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: SessionLogEntry | undefined) => void,
) => SessionPickerComponent {
	return (tui, theme, keybindings, done) =>
		new SessionPickerComponent(tui, theme, keybindings, done, sessions, currentPath);
}
