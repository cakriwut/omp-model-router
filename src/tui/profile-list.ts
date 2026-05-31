import {
	type Component,
	Input,
	type KeybindingsManager,
	type TUI,
	matchesKey,
	padding,
	replaceTabs,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { ModelRegistry, Theme } from "@oh-my-pi/pi-coding-agent";
import type { RouterConfig, RouterProfile, RouterTier } from "../types";
import { ProfileEditorComponent } from "./profile-editor";

export type ProfileListResult =
	| { action: "activate"; profile: string }
	| { action: "edit"; profile: string }
	| { action: "create" }
	| { action: "rename"; profile: string }
	| { action: "delete"; profile: string };

interface ProfileEntry {
	name: string;
	profile: RouterProfile;
}

/** Options for enabling inline sub-view editing within the list. */
export interface ProfileListInlineOptions {
	config: RouterConfig;
	modelRegistry: ModelRegistry;
	onSave: (profileName: string, profile: RouterProfile) => void;
}

const NARROW_THRESHOLD = 80;

/**
 * Strip provider prefix and shorten a model id for display in tier badges.
 * `amazon-bedrock/global.anthropic.claude-opus-4-7` → `claude-opus-4-7`.
 */
function shortModel(model: string | undefined): string {
	if (!model) return "—";
	// Drop provider prefix at the first slash, then drop dotted namespace.
	const afterSlash = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
	const afterDot = afterSlash.includes(".") ? afterSlash.slice(afterSlash.lastIndexOf(".") + 1) : afterSlash;
	return afterDot;
}

/**
 * Truncate to `max` cells, appending `…` if shortened. Returns input unchanged when within budget.
 */
function ellipsize(value: string, max: number): string {
	if (max <= 0) return "";
	if (value.length <= max) return value;
	if (max === 1) return "…";
	return `${value.slice(0, max - 1)}…`;
}

/**
 * Case-insensitive substring fuzzy match — every char of `query` must appear in `target`
 * in order. Empty query matches everything.
 */
function fuzzyContains(target: string, query: string): boolean {
	if (!query) return true;
	const t = target.toLowerCase();
	const q = query.toLowerCase();
	let i = 0;
	for (let j = 0; j < t.length && i < q.length; j++) {
		if (t[j] === q[i]) i++;
	}
	return i === q.length;
}

function tierSummaryText(p: RouterProfile): string {
	const tiers: RouterTier[] = ["high", "medium", "low"];
	const parts: string[] = [];
	for (const t of tiers) parts.push(`${t}:${p[t]?.model ?? ""}`);
	return parts.join(" ");
}

function countTiers(p: RouterProfile): number {
	let n = 0;
	for (const t of ["high", "medium", "low"] as RouterTier[]) {
		if (p[t]?.model) n++;
	}
	return n;
}

function countFallbacks(p: RouterProfile): number {
	let n = 0;
	for (const t of ["high", "medium", "low"] as RouterTier[]) {
		const fb = p[t]?.fallbacks;
		if (Array.isArray(fb)) n += fb.length;
	}
	return n;
}

export class ProfileListComponent implements Component {
	#tui: unknown;
	#theme: Theme;
	#keybindings: KeybindingsManager;
	#done: (result: ProfileListResult | undefined) => void;
	#profiles: ProfileEntry[];
	#activeProfile: string | undefined;
	#search: Input;
	#filtered: ProfileEntry[];
	#cursor: number;

	// Inline sub-view support
	#inlineOptions: ProfileListInlineOptions | undefined;
	#subView: ProfileEditorComponent | undefined;

	constructor(
		tui: unknown,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: ProfileListResult | undefined) => void,
		profiles: ProfileEntry[],
		activeProfile: string | undefined,
		inlineOptions?: ProfileListInlineOptions,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#done = done;
		this.#profiles = profiles;
		this.#activeProfile = activeProfile;
		this.#inlineOptions = inlineOptions;
		this.#search = new Input();
		this.#filtered = profiles.slice();
		// Start cursor on active profile when present.
		const activeIdx = activeProfile ? this.#filtered.findIndex(e => e.name === activeProfile) : -1;
		this.#cursor = activeIdx >= 0 ? activeIdx : 0;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		// If a sub-view (ProfileEditor) is active, delegate input to it.
		if (this.#subView) {
			this.#subView.handleInput(data);
			return;
		}

		const kb = this.#keybindings;

		// 1. Cancel
		if (kb.matches(data, "tui.select.cancel")) {
			this.#done(undefined);
			return;
		}

		// 2. Action shortcuts
		if (matchesKey(data, "ctrl+e")) {
			const profile = this.#highlighted();
			if (profile) this.#handleEdit(profile);
			return;
		}
		if (matchesKey(data, "ctrl+n")) {
			this.#done({ action: "create" });
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			// Silently ignore when only one profile exists.
			if (this.#profiles.length <= 1) return;
			const profile = this.#highlighted();
			if (profile) this.#done({ action: "delete", profile });
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			const profile = this.#highlighted();
			if (profile) this.#done({ action: "rename", profile });
			return;
		}

		// 3. Cursor movement
		if (kb.matches(data, "tui.select.up")) {
			if (this.#filtered.length > 0) {
				this.#cursor = (this.#cursor - 1 + this.#filtered.length) % this.#filtered.length;
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.#filtered.length > 0) {
				this.#cursor = (this.#cursor + 1) % this.#filtered.length;
			}
			return;
		}

		// 4. Activate
		if (kb.matches(data, "tui.select.confirm")) {
			const profile = this.#highlighted();
			if (profile) this.#done({ action: "activate", profile });
			return;
		}

		// 5. Search input — everything else
		this.#search.handleInput(data);
		this.#applyFilter();
	}

	render(width: number): string[] {
		// If a sub-view (ProfileEditor) is active, delegate rendering to it.
		if (this.#subView) {
			return this.#subView.render(width);
		}

		const t = this.#theme;
		const narrow = width < NARROW_THRESHOLD;
		const lines: string[] = [];

		// Header
		const title = narrow ? "Profiles" : "Router Profiles";
		const tag = "[* = active]";
		const headerGap = Math.max(1, width - title.length - tag.length);
		lines.push(title + padding(headerGap) + t.fg("muted", tag));
		lines.push("");

		// Search input line
		const query = this.#search.getValue();
		lines.push(`${t.fg("accent", "> ")}${query}`);
		lines.push("");

		// Body: list, no-profiles, or no-matches
		if (this.#profiles.length === 0) {
			lines.push(`  ${t.fg("muted", "(no profiles configured)")}`);
			lines.push("");
			lines.push(`  ${t.fg("muted", "📖 Create your first profile with ctrl+n")}`);
		} else if (this.#filtered.length === 0) {
			lines.push(`  ${t.fg("muted", "(no matches)")}`);
			lines.push("");
			lines.push(`  ${t.fg("muted", "← backspace to clear filter")}`);
		} else {
			// Compute stable column widths over the filtered set so rows align.
			const nameWidth = this.#filtered.reduce((w, e) => Math.max(w, e.name.length), 0);
			const modelBudget = narrow ? 8 : 14;
			const hWidth = this.#filtered.reduce(
				(w, e) => Math.max(w, ellipsize(shortModel(e.profile.high?.model), modelBudget).length),
				0,
			);
			const mWidth = this.#filtered.reduce(
				(w, e) => Math.max(w, ellipsize(shortModel(e.profile.medium?.model), modelBudget).length),
				0,
			);
			const lWidth = this.#filtered.reduce(
				(w, e) => Math.max(w, ellipsize(shortModel(e.profile.low?.model), modelBudget).length),
				0,
			);

			for (let i = 0; i < this.#filtered.length; i++) {
				const entry = this.#filtered[i];
				if (!entry) continue;
				lines.push(this.#renderRow(entry, i === this.#cursor, narrow, nameWidth, hWidth, mWidth, lWidth, modelBudget));
			}

			// Page counter
			lines.push(`  ${t.fg("muted", `(${this.#cursor + 1}/${this.#filtered.length})`)}`);
		}

		lines.push("");

		// Footer detail
		lines.push(`  ${this.#renderFooterDetail()}`);
		lines.push("");

		// Hint line
		lines.push(`  ${this.#renderHints(narrow)}`);

		return lines.map(line => truncateToWidth(replaceTabs(line), width));
	}

	// ─── Inline edit handling ──────────────────────────────────────────────

	#handleEdit(profileName: string): void {
		// If inline options are available, open the editor as a sub-view.
		if (this.#inlineOptions) {
			const profile = this.#inlineOptions.config.profiles[profileName];
			if (!profile) return;

			const done = (result: RouterProfile | undefined): void => {
				this.#subView = undefined;
				if (result) {
					this.#inlineOptions!.onSave(profileName, result);
					// Update local profile data to reflect save
					const entry = this.#profiles.find(e => e.name === profileName);
					if (entry) entry.profile = result;
					this.#applyFilter();
				}
			};

			this.#subView = new ProfileEditorComponent(
				this.#tui as TUI,
				this.#theme,
				this.#keybindings,
				done,
				profileName,
				profile,
				this.#inlineOptions.modelRegistry,
			);
			return;
		}

		// Fallback: emit result for external handling (legacy path).
		this.#done({ action: "edit", profile: profileName });
	}

	// ─── Internals ─────────────────────────────────────────────────────────

	#highlighted(): string | undefined {
		const entry = this.#filtered[this.#cursor];
		return entry?.name;
	}

	#applyFilter(): void {
		const query = this.#search.getValue();
		if (!query) {
			this.#filtered = this.#profiles.slice();
		} else {
			this.#filtered = this.#profiles.filter(e => {
				return fuzzyContains(e.name, query) || fuzzyContains(tierSummaryText(e.profile), query);
			});
		}
		// Keep cursor in bounds; reset to 0 on filter change to avoid pointing past end.
		if (this.#cursor >= this.#filtered.length) this.#cursor = 0;
	}

	#renderRow(
		entry: ProfileEntry,
		isCursor: boolean,
		narrow: boolean,
		nameWidth: number,
		hWidth: number,
		mWidth: number,
		lWidth: number,
		modelBudget: number,
	): string {
		const t = this.#theme;
		const isActive = entry.name === this.#activeProfile;

		const cursorMark = isCursor ? t.fg("accent", "❯ ") : "  ";
		const star = isActive ? t.fg("accent", "* ") : "  ";
		const nameRaw = entry.name + padding(Math.max(0, nameWidth - entry.name.length));
		const name = isCursor ? t.fg("accent", nameRaw) : nameRaw;

		const h = ellipsize(shortModel(entry.profile.high?.model), modelBudget);
		const m = ellipsize(shortModel(entry.profile.medium?.model), modelBudget);
		const l = ellipsize(shortModel(entry.profile.low?.model), modelBudget);
		const hPad = padding(Math.max(0, hWidth - h.length));
		const mPad = padding(Math.max(0, mWidth - m.length));
		const lPad = padding(Math.max(0, lWidth - l.length));

		const badge = (tag: string, value: string, pad: string): string =>
			`[${t.fg("accent", tag)}: ${t.fg("muted", value)}]${pad}`;

		const sep = narrow ? " " : "   ";
		return (
			cursorMark +
			star +
			name +
			sep +
			badge("H", h, hPad) +
			sep +
			badge("M", m, mPad) +
			sep +
			badge("L", l, lPad)
		);
	}

	#renderFooterDetail(): string {
		const t = this.#theme;
		if (this.#profiles.length === 0) {
			return t.fg("muted", "no profiles configured");
		}
		if (this.#filtered.length === 0) {
			return t.fg("muted", "no matches");
		}
		const entry = this.#filtered[this.#cursor];
		if (!entry) return "";
		if (this.#profiles.length === 1) {
			return `${t.fg("accent", entry.name)}: ${t.fg("warning", "ONLY PROFILE — cannot delete")}`;
		}
		const tiers = countTiers(entry.profile);
		const fallbacks = countFallbacks(entry.profile);
		return `${t.fg("accent", entry.name)}: ${t.fg("muted", `${tiers} tiers, ${fallbacks} fallbacks`)}`;
	}

	#renderHints(narrow: boolean): string {
		const t = this.#theme;
		const sep = " · ";
		const parts: string[] = [];

		if (this.#profiles.length === 0) {
			parts.push("ctrl+n new", "ESC close");
			return t.fg("muted", parts.join(sep));
		}
		if (this.#filtered.length === 0) {
			parts.push("← backspace", "ENTER activate", "ctrl+e edit", "ctrl+n new", "ESC");
			return t.fg("muted", parts.join(sep));
		}

		if (narrow) {
			// Narrow: drop delete, rename, and browse.
			parts.push("ENTER", "ctrl+e edit", "ctrl+n new", "ESC");
		} else {
			// Full width.
			parts.push("ENTER activate", "ctrl+e edit", "ctrl+n new");
			if (this.#profiles.length > 1) parts.push("ctrl+d delete");
			parts.push("↑↓ browse", "ESC");
		}
		return t.fg("muted", parts.join(sep));
	}
}
