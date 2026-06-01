import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { Input, replaceTabs, truncateToWidth, matchesKey } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager, ModelRegistry, Theme } from "@oh-my-pi/pi-coding-agent";
import type { CalibrationConfig } from "../calibration/types";
import { ModelPickerComponent } from "./model-picker";

/** Fields in the classifier settings editor. */
type FieldKind =
	| "enabled"
	| "mode"
	| "warmupTurns"
	| "overrideThreshold"
	| "globalPriorWeight"
	| "traceEnabled"
	| "model"; // virtual rows for each model in the chain

interface FieldRow {
	kind: FieldKind;
	/** For "model" rows, the index in classifierModel array. */
	modelIndex?: number;
}

type ViewState = "editing" | "dirty_confirm" | "input";

const MODE_CYCLE: readonly CalibrationConfig["mode"][] = ["telemetry", "adaptive"] as const;

function defaultCalibration(): CalibrationConfig {
	return {
		enabled: false,
		mode: "telemetry",
		warmupTurns: 5,
		classifierModel: undefined,
		overrideThreshold: 0.65,
		traceEnabled: false,
		useGlobalPrior: true,
		globalPriorWeight: 0.1,
	};
}

/**
 * ClassifierSettingsComponent — edits the calibration config section.
 *
 * Inline sub-views:
 * - ModelPicker for adding classifier models
 * - Inline number input for numeric fields
 *
 * ESC → back to parent (ProfileList). ctrl+s → save.
 */
export class ClassifierSettingsComponent implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #done: (result: CalibrationConfig | undefined) => void;
	readonly #modelRegistry: ModelRegistry;
	readonly #original: CalibrationConfig;
	readonly #originalJson: string;

	#draft: CalibrationConfig;
	#cursor = 0;
	#state: ViewState = "editing";
	#subView: ModelPickerComponent | undefined;
	#inlineInput: Input | undefined;
	#inlineField: FieldKind | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: CalibrationConfig | undefined) => void,
		calibration: CalibrationConfig | undefined,
		modelRegistry: ModelRegistry,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#done = done;
		this.#modelRegistry = modelRegistry;
		this.#original = calibration ? structuredClone(calibration) : defaultCalibration();
		this.#originalJson = JSON.stringify(this.#original);
		this.#draft = structuredClone(this.#original);
	}

	invalidate(): void {}

	// ─── Rows ──────────────────────────────────────────────────────────────

	#buildRows(): FieldRow[] {
		const rows: FieldRow[] = [
			{ kind: "enabled" },
			{ kind: "mode" },
		];
		// Model chain rows
		const models = this.#getModels();
		for (let i = 0; i < models.length; i++) {
			rows.push({ kind: "model", modelIndex: i });
		}
		rows.push(
			{ kind: "warmupTurns" },
			{ kind: "overrideThreshold" },
			{ kind: "globalPriorWeight" },
			{ kind: "traceEnabled" },
		);
		return rows;
	}

	#getModels(): string[] {
		const cm = this.#draft.classifierModel;
		if (!cm) return [];
		if (typeof cm === "string") return [cm];
		return cm;
	}

	#setModels(models: string[]): void {
		if (models.length === 0) {
			this.#draft.classifierModel = undefined;
		} else if (models.length === 1) {
			this.#draft.classifierModel = models[0];
		} else {
			this.#draft.classifierModel = models;
		}
	}

	// ─── Render ────────────────────────────────────────────────────────────

	render(width: number): string[] {
		if (this.#subView) {
			return this.#subView.render(width);
		}

		const t = this.#theme;
		const rows = this.#buildRows();
		const lines: string[] = [];

		// Header
		const headerHint = t.fg("muted", "[ctrl+s save · ESC back]");
		lines.push(`Classifier Settings    ${headerHint}`);
		lines.push("");

		// Status section
		lines.push(t.fg("accent", "─── STATUS ──────────────────────────────────────────────────────"));
		lines.push(this.#renderField(rows, "enabled"));
		lines.push(this.#renderField(rows, "mode"));
		lines.push("");

		// Models section
		lines.push(t.fg("accent", "─── CLASSIFIER MODELS (fallback chain) ──────────────────────────"));
		const models = this.#getModels();
		if (models.length === 0) {
			lines.push(`  ${t.fg("muted", "(none configured — ctrl+a to add)")}`);
		} else {
			for (let i = 0; i < models.length; i++) {
				lines.push(this.#renderModelRow(rows, i, models[i]));
			}
		}
		lines.push("");

		// Parameters section
		lines.push(t.fg("accent", "─── PARAMETERS ──────────────────────────────────────────────────"));
		lines.push(this.#renderField(rows, "warmupTurns"));
		lines.push(this.#renderField(rows, "overrideThreshold"));
		lines.push(this.#renderField(rows, "globalPriorWeight"));
		lines.push(this.#renderField(rows, "traceEnabled"));
		lines.push("");

		// Counter
		lines.push(`  (${this.#cursor + 1}/${rows.length})`);
		lines.push("");

		// Hint line
		lines.push(t.fg("muted", `  ${this.#hintLine(rows)}`));

		return lines.map((line) => truncateToWidth(replaceTabs(line), width));
	}

	#renderField(rows: FieldRow[], kind: FieldKind): string {
		const t = this.#theme;
		const rowIdx = rows.findIndex((r) => r.kind === kind && r.modelIndex === undefined);
		const isSelected = rowIdx === this.#cursor;
		const cursor = isSelected ? "❯ " : "  ";
		const label = this.#labelFor(kind).padEnd(20);
		const value = this.#valueFor(kind);
		const changed = this.#fieldChanged(kind);

		// Inline input rendering
		if (this.#state === "input" && this.#inlineField === kind && this.#inlineInput) {
			const inputLines = this.#inlineInput.render(20);
			const inputText = inputLines[0] ?? "";
			const labelStyled = isSelected ? t.bold(label) : label;
			return `${cursor}${labelStyled}${t.fg("accent", inputText)}█`;
		}

		const prefix = changed ? "* " : cursor;
		const valueText = changed ? `[${value}]` : value;
		const labelStyled = isSelected ? t.bold(label) : label;
		return `${prefix}${labelStyled}${valueText}`;
	}

	#renderModelRow(rows: FieldRow[], index: number, modelRef: string): string {
		const t = this.#theme;
		const rowIdx = rows.findIndex((r) => r.kind === "model" && r.modelIndex === index);
		const isSelected = rowIdx === this.#cursor;
		const cursor = isSelected ? "❯ " : "  ";

		const origModels = this.#getOriginalModels();
		const changed = index >= origModels.length || origModels[index] !== modelRef;

		const prefix = changed ? "* " : cursor;
		const number = `${index + 1}. `;
		const role = index === 0
			? t.fg("accent", "[primary]")
			: t.fg("muted", `[fallback ${index}]`);

		const modelText = isSelected ? t.fg("accent", modelRef) : modelRef;
		return `${prefix}${number}${modelText} ${role}`;
	}

	#labelFor(kind: FieldKind): string {
		switch (kind) {
			case "enabled": return "enabled";
			case "mode": return "mode";
			case "warmupTurns": return "warmupTurns";
			case "overrideThreshold": return "overrideThreshold";
			case "globalPriorWeight": return "globalPriorWeight";
			case "traceEnabled": return "traceEnabled";
			default: return kind;
		}
	}

	#valueFor(kind: FieldKind): string {
		switch (kind) {
			case "enabled": return String(this.#draft.enabled);
			case "mode": return this.#draft.mode;
			case "warmupTurns": return String(this.#draft.warmupTurns);
			case "overrideThreshold": return String(this.#draft.overrideThreshold);
			case "globalPriorWeight": return String(this.#draft.globalPriorWeight);
			case "traceEnabled": return String(this.#draft.traceEnabled);
			default: return "";
		}
	}

	#fieldChanged(kind: FieldKind): boolean {
		switch (kind) {
			case "enabled": return this.#draft.enabled !== this.#original.enabled;
			case "mode": return this.#draft.mode !== this.#original.mode;
			case "warmupTurns": return this.#draft.warmupTurns !== this.#original.warmupTurns;
			case "overrideThreshold": return this.#draft.overrideThreshold !== this.#original.overrideThreshold;
			case "globalPriorWeight": return this.#draft.globalPriorWeight !== this.#original.globalPriorWeight;
			case "traceEnabled": return this.#draft.traceEnabled !== this.#original.traceEnabled;
			default: return false;
		}
	}

	#getOriginalModels(): string[] {
		const cm = this.#original.classifierModel;
		if (!cm) return [];
		if (typeof cm === "string") return [cm];
		return cm;
	}

	#hintLine(rows: FieldRow[]): string {
		if (this.#state === "dirty_confirm") {
			return "Unsaved: ctrl+s save · y discard · n continue";
		}
		if (this.#state === "input") {
			return "type value · ENTER confirm · ESC cancel";
		}
		const row = rows[this.#cursor];
		if (row?.kind === "model") {
			return "ENTER replace · ctrl+a add · ctrl+d remove · ctrl+s save · ESC back";
		}
		return "SPACE toggle/cycle · ENTER edit · ctrl+a add model · ctrl+s save · ESC back";
	}

	// ─── Input ─────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.#subView) {
			this.#subView.handleInput(data);
			return;
		}

		if (this.#state === "input") {
			this.#handleInlineInput(data);
			return;
		}

		if (this.#state === "dirty_confirm") {
			this.#handleDirtyConfirm(data);
			return;
		}

		const kb = this.#keybindings;
		const rows = this.#buildRows();

		// Navigation
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

		// Toggle/cycle/edit
		const isConfirm = kb.matches(data, "tui.select.confirm");
		const isSpace = data === " ";

		if ((isConfirm || isSpace) && row.kind === "enabled") {
			this.#draft.enabled = !this.#draft.enabled;
			return;
		}
		if ((isConfirm || isSpace) && row.kind === "traceEnabled") {
			this.#draft.traceEnabled = !this.#draft.traceEnabled;
			return;
		}
		if ((isConfirm || isSpace) && row.kind === "mode") {
			const idx = MODE_CYCLE.indexOf(this.#draft.mode);
			this.#draft.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
			return;
		}
		if ((isConfirm || isSpace) && row.kind === "warmupTurns") {
			this.#startInlineInput("warmupTurns", String(this.#draft.warmupTurns));
			return;
		}
		if ((isConfirm || isSpace) && row.kind === "overrideThreshold") {
			this.#startInlineInput("overrideThreshold", String(this.#draft.overrideThreshold));
			return;
		}
		if ((isConfirm || isSpace) && row.kind === "globalPriorWeight") {
			this.#startInlineInput("globalPriorWeight", String(this.#draft.globalPriorWeight));
			return;
		}
		if ((isConfirm || isSpace) && row.kind === "model") {
			this.#openModelPicker(row.modelIndex!);
			return;
		}

		// Add model
		if (matchesKey(data, "ctrl+a")) {
			this.#openModelPickerAdd();
			return;
		}

		// Remove model
		if (matchesKey(data, "ctrl+d")) {
			if (row.kind === "model" && row.modelIndex !== undefined) {
				const models = this.#getModels();
				models.splice(row.modelIndex, 1);
				this.#setModels(models);
				// Adjust cursor
				const newRows = this.#buildRows();
				if (this.#cursor >= newRows.length) {
					this.#cursor = Math.max(0, newRows.length - 1);
				}
			}
			return;
		}

		// Save
		if (matchesKey(data, "ctrl+s")) {
			this.#done(this.#draft);
			return;
		}

		// Cancel / back
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.#isDirty()) {
				this.#state = "dirty_confirm";
			} else {
				this.#done(undefined);
			}
			return;
		}
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
	}

	#handleInlineInput(data: string): void {
		const kb = this.#keybindings;

		// Cancel inline edit
		if (kb.matches(data, "tui.select.cancel")) {
			this.#state = "editing";
			this.#inlineInput = undefined;
			this.#inlineField = undefined;
			return;
		}

		// Confirm inline edit
		if (kb.matches(data, "tui.select.confirm")) {
			const value = this.#inlineInput!.getValue().trim();
			this.#applyInlineValue(value);
			this.#state = "editing";
			this.#inlineInput = undefined;
			this.#inlineField = undefined;
			return;
		}

		// Pass to input
		this.#inlineInput!.handleInput(data);
	}

	#startInlineInput(field: FieldKind, initial: string): void {
		this.#state = "input";
		this.#inlineField = field;
		this.#inlineInput = new Input();
		this.#inlineInput.setText(initial);
	}

	#applyInlineValue(value: string): void {
		const num = Number(value);
		if (isNaN(num)) return;

		switch (this.#inlineField) {
			case "warmupTurns":
				this.#draft.warmupTurns = Math.max(0, Math.round(num));
				break;
			case "overrideThreshold":
				this.#draft.overrideThreshold = Math.max(0, Math.min(1, num));
				break;
			case "globalPriorWeight":
				this.#draft.globalPriorWeight = Math.max(0, Math.min(1, num));
				break;
		}
	}

	// ─── Sub-view: Model Picker ────────────────────────────────────────────

	#openModelPicker(replaceIndex: number): void {
		const models = this.#getModels();
		const current = models[replaceIndex];

		const done = (result: string | undefined): void => {
			this.#subView = undefined;
			if (typeof result === "string" && result.length > 0) {
				const m = this.#getModels();
				m[replaceIndex] = result;
				this.#setModels(m);
			}
		};

		this.#subView = new ModelPickerComponent(
			this.#tui,
			this.#theme,
			this.#keybindings,
			done,
			{
				tier: "low", // Classifier models are typically cheap/fast
				modelRegistry: this.#modelRegistry,
				currentPrimary: current,
				currentFallbacks: models.filter((_, i) => i !== replaceIndex),
			},
		);
	}

	#openModelPickerAdd(): void {
		const models = this.#getModels();

		const done = (result: string | undefined): void => {
			this.#subView = undefined;
			if (typeof result === "string" && result.length > 0) {
				const m = this.#getModels();
				// Don't add duplicates
				if (!m.includes(result)) {
					m.push(result);
					this.#setModels(m);
				}
				// Move cursor to the new model row
				const rows = this.#buildRows();
				const newIdx = rows.findIndex((r) => r.kind === "model" && r.modelIndex === m.length - 1);
				if (newIdx >= 0) this.#cursor = newIdx;
			}
		};

		this.#subView = new ModelPickerComponent(
			this.#tui,
			this.#theme,
			this.#keybindings,
			done,
			{
				tier: "low",
				modelRegistry: this.#modelRegistry,
				currentPrimary: models[0],
				currentFallbacks: models.slice(1),
			},
		);
	}

	// ─── Helpers ───────────────────────────────────────────────────────────

	#isDirty(): boolean {
		return JSON.stringify(this.#draft) !== this.#originalJson;
	}
}
