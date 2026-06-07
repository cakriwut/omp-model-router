import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncateToWidth, matchesKey } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager, Theme, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { RouterProfile, RouterTier } from "../types";
import { ModelPickerComponent } from "./model-picker";

const TIERS: readonly RouterTier[] = ["high", "medium", "low"] as const;
const THINKING_CYCLE: readonly ThinkingLevel[] = [
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
] as const;

// Dynamic rows: 'thinking' and model/fallback chain entries
export type RowKind = "thinking" | "chain";
export interface Row {
	tier: RouterTier;
	kind: RowKind;
	/** for chain rows, index in [model, ...fallbacks] */
	chainIndex?: number;
}

type EditorState = "editing" | "dirty_confirm";

/**
 * Profile editor component with three tier sections (HIGH / MEDIUM / LOW),
 * each with a `thinking` row and dynamic model chain rows.
 *
 * Each tier shows:
 * - thinking row → cycles through `low → medium → high → low` via SPACE
 * - chain rows (model + fallbacks) → numbered rows with CTRL+U/K (move), 
 *   CTRL+A (add), CTRL+D (delete), Enter/Space to replace
 *
 * Exit paths:
 * - `S` → `done(draft)`
 * - `Esc` (clean) → `done(undefined)`
 * - `Esc` (dirty) → enters `dirty_confirm`; then `S` saves, `y` discards (`done(undefined)`),
 *   `n` returns to `editing`.
 *
 * Sub-view (ModelPickerComponent) is rendered inline — ESC in a sub-view navigates back to the
 * editor (not out of the entire component).
 */
export class ProfileEditorComponent implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #done: (result: RouterProfile | undefined) => void;
	readonly #profileName: string;
	readonly #original: RouterProfile;
	readonly #originalJson: string;
	readonly #modelRegistry: ModelRegistry;
	#draft: RouterProfile;
	#cursor = 0;
	#state: EditorState = "editing";
	#subView: ModelPickerComponent | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: RouterProfile | undefined) => void,
		profileName: string,
		profile: RouterProfile,
		modelRegistry: ModelRegistry,
		_customUI?: unknown,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#done = done;
		this.#profileName = profileName;
		this.#original = profile;
		this.#originalJson = JSON.stringify(profile);
		this.#modelRegistry = modelRegistry;
		this.#draft = structuredClone(profile);
	}

	invalidate(): void {
		// No cached state to invalidate; all rendering is derived from #draft.
	}

	// ─── Rows ──────────────────────────────────────────────────────────────

	#buildRows(): Row[] {
		const rows: Row[] = [];
		for (const tier of TIERS) {
			// Add thinking row for this tier
			rows.push({ tier, kind: "thinking" });
			
			// Add chain rows for [model, ...fallbacks]
			const cfg = this.#draft[tier];
			const fallbacks = cfg.fallbacks ?? [];
			// Model is always present; chain = [model, ...fallbacks]
			for (let i = 0; i <= fallbacks.length; i++) {
				rows.push({ tier, kind: "chain", chainIndex: i });
			}
		}
		return rows;
	}

	#getChainForTier(tier: RouterTier): string[] {
		const cfg = this.#draft[tier];
		const fallbacks = cfg.fallbacks ?? [];
		return [cfg.model, ...fallbacks];
	}

	#setChainForTier(tier: RouterTier, chain: string[]): void {
		if (chain.length === 0) return;
		this.#draft[tier] = {
			...this.#draft[tier],
			model: chain[0],
			fallbacks: chain.length > 1 ? chain.slice(1) : undefined,
		};
	}

	// ─── Render ────────────────────────────────────────────────────────────

	render(width: number): string[] {
		// If a sub-view is active, delegate rendering entirely to it.
		if (this.#subView) {
			return this.#subView.render(width);
		}

		const t = this.#theme;
		const lines: string[] = [];

		// Title bar
		const headerHint = t.fg("muted", "[ctrl+s save · ESC cancel]");
		const title = `Editing: ${this.#profileName}`;
		lines.push(`${title}    ${headerHint}`);
		lines.push("");

		const rows = this.#buildRows();
		let lastTier: RouterTier | undefined;

		// Render each row, with tier headers where tier changes
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (row.tier !== lastTier) {
				lines.push(this.#renderTierHeader(row.tier));
				lastTier = row.tier;
			}

			if (row.kind === "thinking") {
				lines.push(this.#renderThinkingRow(rows, i, row.tier));
			} else {
				lines.push(this.#renderChainRow(rows, i, row.tier, row.chainIndex!));
			}
		}

		lines.push("");

		// Counter
		lines.push(`  (${this.#cursor + 1}/${rows.length})`);
		lines.push("");

		// Missing-model warnings
		for (const tier of TIERS) {
			const chain = this.#getChainForTier(tier);
			const primaryModel = chain[0];
			if (!primaryModel || primaryModel.trim().length === 0) {
				lines.push(
					t.fg(
						"warning",
						`  ⚠ ${tier.toUpperCase()} has no model configured`,
					),
				);
			}
		}

		// Hint line
		lines.push("");
		lines.push(t.fg("muted", `  ${this.#hintLine(rows)}`));

		return lines.map((line) => truncateToWidth(replaceTabs(line), width));
	}

	#renderTierHeader(tier: RouterTier): string {
		const label = tier.toUpperCase();
		const dashes = "─".repeat(Math.max(0, 60 - label.length));
		return this.#theme.fg("accent", `─── ${label} ${dashes}`);
	}

	#renderThinkingRow(rows: Row[], rowIdx: number, tier: RouterTier): string {
		const t = this.#theme;
		const isSelected = rowIdx === this.#cursor;
		const cursor = isSelected ? "❯ " : "  ";

		const tierCfg = this.#draft[tier];
		const origCfg = this.#original[tier];
		const changed = (tierCfg.thinking ?? null) !== (origCfg.thinking ?? null);

		const label = "thinking".padEnd(11);
		const value = tierCfg.thinking ?? "off";

		const prefix = changed ? "* " : cursor;
		const valueText = changed ? `[${value}]` : value;

		const labelStyled = isSelected ? t.bold(label) : label;
		return `${prefix}${labelStyled}${valueText}`;
	}

	#renderChainRow(rows: Row[], rowIdx: number, tier: RouterTier, chainIndex: number): string {
		const t = this.#theme;
		const isSelected = rowIdx === this.#cursor;
		const cursor = isSelected ? "❯ " : "  ";

		const chain = this.#getChainForTier(tier);
		const modelRef = chain[chainIndex];

		// Detect if this model is different from original
		const origChain = this.#getOriginalChainForTier(tier);
		const changed = chainIndex >= origChain.length || origChain[chainIndex] !== modelRef;

		const prefix = changed ? "* " : cursor;
		const number = `${chainIndex + 1}. `;
		const role = chainIndex === 0
			? t.fg("accent", "[primary]")
			: t.fg("muted", `[fallback ${chainIndex}]`);

		const modelText = isSelected ? t.fg("accent", modelRef) : modelRef;
		return `${prefix}${number}${modelText} ${role}`;
	}

	#getOriginalChainForTier(tier: RouterTier): string[] {
		const cfg = this.#original[tier];
		const fallbacks = cfg.fallbacks ?? [];
		return [cfg.model, ...fallbacks];
	}

	#hintLine(rows: Row[]): string {
		if (this.#state === "dirty_confirm") {
			return "Unsaved: ctrl+s save · y discard · n continue";
		}
		const row = rows[this.#cursor];
		if (row?.kind === "thinking") {
			return "SPACE cycle · ctrl+s save · ESC cancel";
		}
		if (row?.kind === "chain") {
			const chain = this.#getChainForTier(row.tier);
			const i = row.chainIndex!;
			const canUp = i > 0;
			const canDown = i < chain.length - 1;
			const moveHints = [
				canUp ? "ctrl+u ▲" : "",
				canDown ? "ctrl+k ▼" : "",
			].filter(Boolean).join(" · ");
			const base = "ENTER replace · ctrl+a add · ctrl+d remove";
			return moveHints ? `${base} · ${moveHints} · ctrl+s save · ESC cancel` : `${base} · ctrl+s save · ESC cancel`;
		}
		return "ctrl+s save · ESC cancel";
	}

	// ─── Input ─────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		// If a sub-view is active, delegate input to it.
		if (this.#subView) {
			this.#subView.handleInput(data);
			return;
		}

		if (this.#state === "dirty_confirm") {
			this.#handleDirtyConfirm(data);
			return;
		}

		const kb = this.#keybindings;
		const rows = this.#buildRows();

		// 1. Up/Down navigate
		if (kb.matches(data, "tui.select.up")) {
			this.#cursor = (this.#cursor - 1 + rows.length) % rows.length;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.#cursor = (this.#cursor + 1) % rows.length;
			return;
		}

		const row = rows[this.#cursor];
		if (!row) return;

		// 2. Enter/Space on thinking → cycle
		const isConfirm = kb.matches(data, "tui.select.confirm");
		const isSpace = data === " ";
		if (row.kind === "thinking" && (isConfirm || isSpace)) {
			this.#cycleThinking(row.tier);
			return;
		}

		// 3. Enter/Space on chain → replace
		if (row.kind === "chain" && (isConfirm || isSpace)) {
			this.#openModelPickerReplace(row.tier, row.chainIndex!);
			return;
		}

		// 4. ctrl+a → add model to current tier
		if (matchesKey(data, "ctrl+a")) {
			if (row.kind === "chain") {
				this.#openModelPickerAdd(row.tier);
			}
			return;
		}

		// 5. ctrl+d → delete model from current tier chain
		if (matchesKey(data, "ctrl+d")) {
			if (row.kind === "chain") {
				const chain = this.#getChainForTier(row.tier);
				if (chain.length > 1) {
					// Don't allow deleting the primary model
					if (row.chainIndex! > 0) {
						chain.splice(row.chainIndex!, 1);
						this.#setChainForTier(row.tier, chain);
						// Adjust cursor if needed
						const newRows = this.#buildRows();
						if (this.#cursor >= newRows.length) {
							this.#cursor = Math.max(0, newRows.length - 1);
						}
					}
				}
			}
			return;
		}

		// 6. ctrl+u → move up in chain
		if (matchesKey(data, "ctrl+u")) {
			if (row.kind === "chain" && row.chainIndex! > 0) {
				const chain = this.#getChainForTier(row.tier);
				const i = row.chainIndex!;
				[chain[i - 1], chain[i]] = [chain[i], chain[i - 1]];
				this.#setChainForTier(row.tier, chain);
				// Keep cursor on moved item
				this.#cursor -= 1;
			}
			return;
		}

		// 7. ctrl+k → move down in chain
		if (matchesKey(data, "ctrl+k")) {
			if (row.kind === "chain" && row.chainIndex !== undefined) {
				const chain = this.#getChainForTier(row.tier);
				const i = row.chainIndex;
				if (i < chain.length - 1) {
					[chain[i], chain[i + 1]] = [chain[i + 1], chain[i]];
					this.#setChainForTier(row.tier, chain);
					// Keep cursor on moved item
					this.#cursor += 1;
				}
			}
			return;
		}

		// 8. ctrl+s → save
		if (matchesKey(data, "ctrl+s")) {
			this.#done(this.#draft);
			return;
		}

		// 9. Esc → cancel or enter dirty_confirm
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.#isDirty()) {
				this.#state = "dirty_confirm";
			} else {
				this.#done(undefined);
			}
			return;
		}

		// All other input ignored
	}

	#handleDirtyConfirm(data: string): void {
		if (matchesKey(data, "ctrl+s")) {
			this.#done(this.#draft);
			return;
		}
		if (data === "y" || data === "Y") {
			this.#done(undefined);
			return;
		}
		if (data === "n" || data === "N") {
			this.#state = "editing";
			return;
		}
		// Esc in dirty_confirm: stay in dirty_confirm (ignore — user must pick S/y/n).
		// All other input ignored.
	}

	#cycleThinking(tier: RouterTier): void {
		const current = this.#draft[tier].thinking;
		const idx = THINKING_CYCLE.findIndex((v) => v === current);
		const next = THINKING_CYCLE[(idx + 1 + THINKING_CYCLE.length) % THINKING_CYCLE.length];
		this.#draft[tier] = { ...this.#draft[tier], thinking: next };
	}

	// ─── Submenu wiring (model picker) ─────────────────────────────────────

	#openModelPickerReplace(tier: RouterTier, chainIndex: number): void {
		const chain = this.#getChainForTier(tier);
		const current = chain[chainIndex];

		const done = (result: string | undefined): void => {
			this.#subView = undefined;
			if (typeof result === "string" && result.length > 0) {
				const c = this.#getChainForTier(tier);
				c[chainIndex] = result;
				this.#setChainForTier(tier, c);
			}
		};

		this.#subView = new ModelPickerComponent(
			this.#tui,
			this.#theme,
			this.#keybindings,
			done,
			{
				tier,
				modelRegistry: this.#modelRegistry,
				currentPrimary: current,
				currentFallbacks: chain.filter((_, i) => i !== chainIndex),
			},
		);
	}

	#openModelPickerAdd(tier: RouterTier): void {
		const chain = this.#getChainForTier(tier);

		const done = (result: string | undefined): void => {
			this.#subView = undefined;
			if (typeof result === "string" && result.length > 0) {
				const c = this.#getChainForTier(tier);
				// Don't add duplicates
				if (!c.includes(result)) {
					c.push(result);
					this.#setChainForTier(tier, c);
				}
				// Move cursor to the new chain row
				const rows = this.#buildRows();
				const newIdx = rows.findIndex(
					(r) => r.tier === tier && r.kind === "chain" && r.chainIndex === c.length - 1
				);
				if (newIdx >= 0) this.#cursor = newIdx;
			}
		};

		this.#subView = new ModelPickerComponent(
			this.#tui,
			this.#theme,
			this.#keybindings,
			done,
			{
				tier,
				modelRegistry: this.#modelRegistry,
				currentPrimary: chain[0],
				currentFallbacks: chain.slice(1),
			},
		);
	}

	// ─── Helpers ───────────────────────────────────────────────────────────

	#isDirty(): boolean {
		return JSON.stringify(this.#draft) !== this.#originalJson;
	}
}


/**
 * Factory matching the `ctx.ui.custom` signature. Builds a component bound to
 * the supplied `profile` / `modelRegistry`.
 */
export function createProfileEditorFactory(
	profileName: string,
	profile: RouterProfile,
	modelRegistry: ModelRegistry,
	_customUI?: unknown,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: RouterProfile | undefined) => void,
) => ProfileEditorComponent {
	return (tui, theme, keybindings, done) =>
		new ProfileEditorComponent(
			tui,
			theme,
			keybindings,
			done,
			profileName,
			profile,
			modelRegistry,
		);
}

// ─── CRUD Helper Functions ────────────────────────────────────────────────────

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterConfig } from "../types";
import { patchConfigFile, profileNames } from "../config";

/**
 * Open the profile editor for a specific profile.
 */
export async function openProfileEditor(
	profileName: string,
	config: RouterConfig,
	modelRegistry: ModelRegistry,
	ctx: ExtensionContext,
	onSave: () => Promise<void>,
): Promise<void> {
	const profile = config.profiles[profileName];
	if (!profile) {
		ctx.ui.notify(`Profile "${profileName}" not found.`, "error");
		return;
	}

	const result = await ctx.ui.custom<RouterProfile | undefined>(
		createProfileEditorFactory(profileName, profile, modelRegistry),
		{ overlay: false },
	);

	if (result) {
		await patchConfigFile({ profiles: { ...config.profiles, [profileName]: result } });
		await onSave();
	}
}

/**
 * Create a new profile by prompting for a name, then opening the editor pre-filled with active profile.
 */
export async function openCreateProfile(
	config: RouterConfig,
	modelRegistry: ModelRegistry,
	ctx: ExtensionContext,
	onSave: () => Promise<void>,
): Promise<void> {
	const name = await ctx.ui.input("Enter new profile name:");
	if (!name) return;

	const existing = profileNames(config);
	if (existing.includes(name)) {
		ctx.ui.notify(`Profile "${name}" already exists.`, "error");
		return;
	}

	// Pre-fill with copy of current active profile (or first available)
	const activeProfileName = config.defaultProfile ?? existing[0] ?? "auto";
	const activeProfile = config.profiles[activeProfileName];
	if (!activeProfile) {
		ctx.ui.notify("No profile available to copy from.", "error");
		return;
	}

	const result = await ctx.ui.custom<RouterProfile | undefined>(
		createProfileEditorFactory(name, structuredClone(activeProfile), modelRegistry),
		{ overlay: false },
	);

	if (result) {
		await patchConfigFile({ profiles: { ...config.profiles, [name]: result } });
		await onSave();
	}
}

/**
 * Rename a profile by prompting for the source profile and new name.
 */
export async function openRenameProfile(
	config: RouterConfig,
	_modelRegistry: ModelRegistry,
	ctx: ExtensionContext,
	onSave: () => Promise<void>,
): Promise<void> {
	const profiles = profileNames(config);
	const source = await ctx.ui.select("Select profile to rename:", profiles);
	if (!source) return;

	const newName = await ctx.ui.input("Enter new name:", source);
	if (!newName || newName === source) return;

	if (profiles.includes(newName)) {
		ctx.ui.notify(`Profile "${newName}" already exists.`, "error");
		return;
	}

	// Rename by removing old key and adding new key
	const updatedProfiles = { ...config.profiles };
	updatedProfiles[newName] = updatedProfiles[source];
	delete updatedProfiles[source];

	await patchConfigFile({ profiles: updatedProfiles });
	await onSave();
	ctx.ui.notify(`Renamed "${source}" to "${newName}".`, "info");
}

/**
 * Delete a profile by prompting for selection and confirmation.
 */
export async function openDeleteProfile(
	config: RouterConfig,
	ctx: ExtensionContext,
	onSave: () => Promise<void>,
): Promise<void> {
	const profiles = profileNames(config);
	if (profiles.length <= 1) {
		ctx.ui.notify("Cannot delete the last profile.", "error");
		return;
	}

	const target = await ctx.ui.select("Select profile to delete:", profiles);
	if (!target) return;

	const confirmed = await ctx.ui.confirm(`Delete profile "${target}"?`, "This action cannot be undone.");
	if (!confirmed) return;

	const updatedProfiles = { ...config.profiles };
	delete updatedProfiles[target];

	await patchConfigFile({ profiles: updatedProfiles });
	await onSave();
	ctx.ui.notify(`Deleted profile "${target}".`, "info");
}
