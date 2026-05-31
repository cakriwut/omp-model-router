import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager, Theme, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { RouterProfile, RouterTier } from "../types";
import { ModelPickerComponent } from "./model-picker";
import { FallbackPickerComponent } from "./fallback-picker";

const TIERS: readonly RouterTier[] = ["high", "medium", "low"] as const;
const THINKING_CYCLE: readonly ThinkingLevel[] = [
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
] as const;
type FieldKind = "model" | "thinking" | "fallbacks";
const FIELDS: readonly FieldKind[] = ["model", "thinking", "fallbacks"] as const;

interface Row {
	tier: RouterTier;
	field: FieldKind;
}

const ROWS: readonly Row[] = TIERS.flatMap((tier) =>
	FIELDS.map((field) => ({ tier, field }) satisfies Row),
);

type EditorState = "editing" | "dirty_confirm";

/**
 * Profile editor component with three tier sections (HIGH / MEDIUM / LOW),
 * each with `model`, `thinking`, and `fallbacks` rows.
 *
 * Submenus:
 * - `model` row → opens {@link ModelPickerComponent}, result updates `draft.{tier}.model`.
 * - `fallbacks` row → opens {@link FallbackPickerComponent}, result updates `draft.{tier}.fallbacks`.
 * - `thinking` row → cycles through `low → medium → high → low` via SPACE.
 *
 * Exit paths:
 * - `S` → `done(draft)`
 * - `Esc` (clean) → `done(undefined)`
 * - `Esc` (dirty) → enters `dirty_confirm`; then `S` saves, `y` discards (`done(undefined)`),
 *   `n` returns to `editing`.
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
	readonly #customUI: <T>(factory: (tui: unknown, theme: Theme, kb: KeybindingsManager, done: (v: T) => void) => Component) => Promise<T>;
	#draft: RouterProfile;
	#cursor = 0;
	#state: EditorState = "editing";

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: RouterProfile | undefined) => void,
		profileName: string,
		profile: RouterProfile,
		modelRegistry: ModelRegistry,
		customUI: <T>(factory: (tui: unknown, theme: Theme, kb: KeybindingsManager, done: (v: T) => void) => Component) => Promise<T>,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#done = done;
		this.#profileName = profileName;
		this.#original = profile;
		this.#originalJson = JSON.stringify(profile);
		this.#modelRegistry = modelRegistry;
		this.#customUI = customUI;
		this.#draft = structuredClone(profile);
	}

	invalidate(): void {
		// No cached state to invalidate; all rendering is derived from #draft.
	}

	// ─── Render ────────────────────────────────────────────────────────────

	render(width: number): string[] {
		const t = this.#theme;
		const lines: string[] = [];

		// Title bar
		const headerHint = t.fg("muted", "[S save · ESC cancel]");
		const title = `Editing: ${this.#profileName}`;
		lines.push(`${title}    ${headerHint}`);
		lines.push("");

		// Tier sections
		for (const tier of TIERS) {
			lines.push(this.#renderTierHeader(tier));
			for (const field of FIELDS) {
				lines.push(this.#renderRow(tier, field));
			}
			lines.push("");
		}

		// Counter
		const totalRows = ROWS.length;
		lines.push(`  (${this.#cursor + 1}/${totalRows})`);
		lines.push("");

		// Missing-fallbacks warnings
		for (const tier of TIERS) {
			const fb = this.#draft[tier].fallbacks;
			if (!fb || fb.length === 0) {
				lines.push(
					t.fg(
						"warning",
						`  ⚠ ${tier.toUpperCase()} has no fallbacks — requests fail without retries`,
					),
				);
			}
		}

		// Hint line
		lines.push("");
		lines.push(t.fg("muted", `  ${this.#hintLine()}`));

		return lines.map((line) => truncateToWidth(replaceTabs(line), width));
	}

	#renderTierHeader(tier: RouterTier): string {
		const label = tier.toUpperCase();
		const dashes = "─".repeat(Math.max(0, 60 - label.length));
		return this.#theme.fg("accent", `─── ${label} ${dashes}`);
	}

	#renderRow(tier: RouterTier, field: FieldKind): string {
		const t = this.#theme;
		const rowIndex = this.#rowIndex(tier, field);
		const isSelected = rowIndex === this.#cursor;
		const cursor = isSelected ? "❯ " : "  ";

		const tierCfg = this.#draft[tier];
		const origCfg = this.#original[tier];
		const changed = this.#fieldChanged(tier, field, tierCfg, origCfg);

		const label = field.padEnd(11);
		const value = this.#formatValue(tier, field);

		// Changed marker: replaces the leading 2 chars (`❯ ` / `  `) with `* ` on changed.
		const prefix = changed ? "* " : cursor;
		const valueText = changed ? `[${value}]` : value;

		const labelStyled = isSelected ? t.bold(label) : label;
		return `${prefix}${labelStyled}${valueText}`;
	}

	#formatValue(tier: RouterTier, field: FieldKind): string {
		const cfg = this.#draft[tier];
		if (field === "model") return cfg.model;
		if (field === "thinking") return cfg.thinking ?? "off";
		// fallbacks
		const fb = cfg.fallbacks;
		if (!fb || fb.length === 0) return "(none configured) ⚠";
		const shorts = fb.map((ref) => shortName(ref));
		return `${fb.length} models: ${shorts.join(", ")}`;
	}

	#fieldChanged(
		tier: RouterTier,
		field: FieldKind,
		draft: RouterProfile[RouterTier],
		original: RouterProfile[RouterTier],
	): boolean {
		if (field === "model") return draft.model !== original.model;
		if (field === "thinking") return (draft.thinking ?? null) !== (original.thinking ?? null);
		// fallbacks: compare by JSON to avoid order-insensitive diffs (fallback order matters)
		return JSON.stringify(draft.fallbacks ?? null) !== JSON.stringify(original.fallbacks ?? null);
	}

	#hintLine(): string {
		if (this.#state === "dirty_confirm") {
			return "Unsaved: S save · y discard · n continue";
		}
		return "ENTER/SPACE edit field · S save · ESC cancel";
	}

	// ─── Input ─────────────────────────────────────────────────────────────

	handleInput(data: string): void {

		if (this.#state === "dirty_confirm") {
			this.#handleDirtyConfirm(data);
			return;
		}

		const kb = this.#keybindings;

		// 1. Up/Down navigate (skip non-existent header/separator rows; ROWS already excludes them).
		if (kb.matches(data, "tui.select.up")) {
			this.#cursor = (this.#cursor - 1 + ROWS.length) % ROWS.length;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.#cursor = (this.#cursor + 1) % ROWS.length;
			return;
		}

		const row = ROWS[this.#cursor];
		if (!row) return;

		// 2. Enter/Space on model or fallbacks → open submenu.
		const isConfirm = kb.matches(data, "tui.select.confirm");
		const isSpace = data === " ";
		if (row.field === "model" && (isConfirm || isSpace)) {
			this.#openModelPicker(row.tier);
			return;
		}
		if (row.field === "fallbacks" && (isConfirm || isSpace)) {
			this.#openFallbackPicker(row.tier);
			return;
		}

		// 3. Space on thinking → cycle low → medium → high → low.
		if (row.field === "thinking" && (isConfirm || isSpace)) {
			this.#cycleThinking(row.tier);
			return;
		}

		// 4. S → save.
		if (data === "S") {
			this.#done(this.#draft);
			return;
		}

		// 5. Esc → cancel or enter dirty_confirm.
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.#isDirty()) {
				this.#state = "dirty_confirm";
			} else {
				this.#done(undefined);
			}
			return;
		}

		// All other input ignored — there is no inline editor at the editor level.
	}

	#handleDirtyConfirm(data: string): void {
		if (data === "S") {
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

	// ─── Submenu wiring ────────────────────────────────────────────────────

	#openModelPicker(tier: RouterTier): void {
		const tierCfg = this.#draft[tier];
		const fallbacks = tierCfg.fallbacks ?? [];
		
		this.#customUI<string | undefined>((tui, theme, keybindings, done) => {
			return new ModelPickerComponent(
				tui as TUI,
				theme,
				keybindings,
				done,
				{
					tier,
					modelRegistry: this.#modelRegistry,
					currentPrimary: tierCfg.model,
					currentFallbacks: fallbacks,
				},
			);
		}).then((result) => {
			if (typeof result === "string" && result.length > 0) {
				this.#draft[tier] = { ...this.#draft[tier], model: result };
			}
		});
	}

	#openFallbackPicker(tier: RouterTier): void {
		const tierCfg = this.#draft[tier];
		const available = this.#modelRegistry.getAvailable();
		const allModels = available
			.filter((m) => m.provider !== "router")
			.map((m) => ({
				value: `${m.provider}/${m.id}`,
				label: m.name,
				description: `${m.provider} · ${Math.floor(m.contextWindow / 1000)}k`,
			}));
		
		this.#customUI<string[] | undefined>((tui, theme, keybindings, done) => {
			return new FallbackPickerComponent(
				tui as TUI,
				theme,
				keybindings,
				done,
				allModels,
				tierCfg.model,
				tierCfg.fallbacks ?? [],
				tier,
			);
		}).then((result) => {
			if (Array.isArray(result)) {
				this.#draft[tier] = {
					...this.#draft[tier],
					fallbacks: result.length === 0 ? undefined : result,
				};
			}
		});
	}

	// ─── Helpers ───────────────────────────────────────────────────────────

	#isDirty(): boolean {
		return JSON.stringify(this.#draft) !== this.#originalJson;
	}

	#rowIndex(tier: RouterTier, field: FieldKind): number {
		return ROWS.findIndex((r) => r.tier === tier && r.field === field);
	}
}

/**
 * Strip provider prefix from a model ref for compact display:
 *   "amazon-bedrock/global.anthropic.claude-opus-4-7" → "claude-opus-4-7"
 *   "openai/gpt-4-turbo"                              → "gpt-4-turbo"
 */
function shortName(ref: string): string {
	const slash = ref.lastIndexOf("/");
	const tail = slash >= 0 ? ref.slice(slash + 1) : ref;
	const dot = tail.lastIndexOf(".");
	return dot >= 0 ? tail.slice(dot + 1) : tail;
}

/**
 * Factory matching the `ctx.ui.custom` signature. Builds a component bound to
 * the supplied `profile` / `modelRegistry`.
 */
export function createProfileEditorFactory(
	profileName: string,
	profile: RouterProfile,
	modelRegistry: ModelRegistry,
	customUI: <T>(factory: (tui: unknown, theme: Theme, kb: KeybindingsManager, done: (v: T) => void) => Component) => Promise<T>,
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
			customUI,
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
		createProfileEditorFactory(profileName, profile, modelRegistry, ctx.ui.custom.bind(ctx.ui)),
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
		createProfileEditorFactory(name, structuredClone(activeProfile), modelRegistry, ctx.ui.custom.bind(ctx.ui)),
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
