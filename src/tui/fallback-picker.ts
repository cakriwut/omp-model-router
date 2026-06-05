import type { Component, TUI, Tab } from "@oh-my-pi/pi-tui";
import { Input, SelectList, TabBar, fuzzyFilter, replaceTabs, truncateToWidth, matchesKey } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager, Theme } from "@oh-my-pi/pi-coding-agent";
import { buildSelectListTheme } from "./shared.js";
import { shortenModelRef } from "../ui/theme.js";


export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

/**
 * FallbackPickerComponent — multi-select model picker with ordering.
 * 
 * Maintains selection order via Map<modelRef, order> (1-based).
 * Filters out the primary model for the current tier.
 * Returns sorted array of selected model refs on confirm, undefined on cancel.
 */
export class FallbackPickerComponent implements Component {
	#tui: TUI;
	#theme: Theme;
	#keybindings: KeybindingsManager;
	#done: (result: string[] | undefined) => void;
	
	// Input data
	#allModels: SelectItem[];
	#primaryRef: string;
	#currentFallbacks: string[];
	#currentTier: string;
	
	// UI state
	#tabBar: TabBar;
	#searchInput: Input;
	#selectList: SelectList | undefined;
	#scope: string = "all";
	#selectedIndex: number = 0;
	#filteredModels: SelectItem[] = [];
	
	// Selection tracking (Map<modelRef, order> for stable ordering)
	#selected: Map<string, number> = new Map();

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: string[] | undefined) => void,
		allModels: SelectItem[],
		primaryRef: string,
		currentFallbacks: string[],
		currentTier: string
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#keybindings = keybindings;
		this.#done = done;
		this.#allModels = allModels;
		this.#primaryRef = primaryRef;
		this.#currentFallbacks = currentFallbacks || [];
		this.#currentTier = currentTier;
		
		// Initialize selection from currentFallbacks
		this.#currentFallbacks.forEach((modelRef, index) => {
			this.#selected.set(modelRef, index + 1);
		});
		
		// Initialize TabBar with provider scopes derived from available models
		const selectListTheme = buildSelectListTheme(this.#theme);
		const providers = [...new Set(allModels.map((m) => m.value.split("/")[0]))].sort();
		const tabs: Tab[] = [{ id: "all", label: "ALL" }];
		for (const p of providers) {
			tabs.push({ id: p, label: p.toUpperCase() });
		}
		this.#tabBar = new TabBar(
			"Provider scope",
			tabs,
			{
				label: (text) => text,
				activeTab: (text) => this.#theme.fg("accent", text),
				inactiveTab: (text) => this.#theme.fg("muted", text),
				hint: (text) => this.#theme.fg("muted", text),
			},
			0
		);
		
		// Initialize search input
		this.#searchInput = new Input();
		
		// SelectList will be initialized lazily in render()
		this.#selectList = undefined;
		
		// Apply initial filter
		this.#applyFilters();
	}

	render(width: number): string[] {
		// Lazy init SelectList on first render (when theme is available)
		if (!this.#selectList) {
			this.#selectList = new SelectList(this.#filteredModels, 8, buildSelectListTheme(this.#theme));
		}

		const lines: string[] = [];
		const primaryShortName = shortenModelRef(this.#primaryRef);
		const tierLabel = `Pick fallbacks for ${this.#currentTier.toUpperCase()}`;
		const primaryInfo = `(primary: ${primaryShortName})`;
		const padding = Math.max(1, width - tierLabel.length - primaryInfo.length);
		const header = tierLabel + " ".repeat(padding) + primaryInfo;
		lines.push(truncateToWidth(replaceTabs(header), width));
		
		// Blank line
		lines.push("");
		
		// TabBar
		const tabBarLines = this.#tabBar.render(width);
		lines.push(...tabBarLines);
		
		// Blank line
		lines.push("");
		
		// Search input line with prompt
		const searchPrompt = "> ";
		const searchInputLines = this.#searchInput.render(Math.max(10, width - searchPrompt.length));
		const searchInputText = searchInputLines[0] || "";
		const searchLine = searchPrompt + searchInputText;
		lines.push(truncateToWidth(replaceTabs(searchLine), width));
		
		// Blank line
		lines.push("");
		
		// SelectList with checkbox rendering
		if (this.#filteredModels.length === 0) {
			lines.push(truncateToWidth("  (no results)", width));
		} else {
			// Update SelectList items with checkbox formatting
			const items = this.#filteredModels.map((model) => ({
				value: model.value,
				label: this.#formatModelLine(model),
				description: model.description,
			}));
			
			this.#selectList = new SelectList(items, 8, buildSelectListTheme(this.#theme));
			
			// Set cursor position
			if (this.#selectedIndex < items.length) {
				this.#selectList.setSelectedIndex(this.#selectedIndex);
			}
			
			const selectListLines = this.#selectList.render(width);
			lines.push(...selectListLines);
		}
		
		// Blank line
		lines.push("");
		
		// Footer with selection summary
		const footerLeft = this.#formatFooter();
		lines.push(truncateToWidth(replaceTabs(footerLeft), width));
		
		// Blank line
		lines.push("");
		
		// Hint line
		const hint = "type filter · TAB scope · SPACE toggle · ↑↓ navigate · ENTER save · ESC cancel";
		lines.push(truncateToWidth(replaceTabs(hint), width));
		
		return lines;
	}

	handleInput(data: string): void {
		// 1. TabBar handles Tab key
		if (this.#tabBar.handleInput(data)) {
			const selectedTab = this.#tabBar.getActiveIndex();
			const scopes = ["all", "amazon-bedrock", "anthropic", "openai", "google"];
			if (selectedTab >= 0 && selectedTab < scopes.length) {
				this.#scope = scopes[selectedTab];
				this.#applyFilters();
			}
			return;
		}
		
		// 2. Cancel
		if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#done(undefined);
			return;
		}
		
		// 3. Navigation
		if (this.#keybindings.matches(data, "tui.select.up")) {
			this.#moveUp();
			return;
		}
		if (this.#keybindings.matches(data, "tui.select.down")) {
			this.#moveDown();
			return;
		}
		
		// 4. Confirm
		if (this.#keybindings.matches(data, "tui.select.confirm")) {
			this.#done(this.#getResult());
			return;
		}
		
		// 5. Clear all selections
		if (matchesKey(data, "ctrl+a")) {
			this.#selected.clear();
			return;
		}
		
		// 6. Toggle current selection
		if (data === " ") {
			if (this.#filteredModels.length > 0 && this.#selectedIndex >= 0) {
				const highlighted = this.#filteredModels[this.#selectedIndex];
				this.#toggle(highlighted.value);
			}
			return;
		}
		
		// 7. Search input
		this.#searchInput.handleInput(data);
		this.#applyFilters();
	}

	#formatModelLine(model: SelectItem): string {
		const order = this.#selected.get(model.value);
		const checkbox = order
			? this.#theme.fg("accent", `[${order}]`)
			: this.#theme.fg("muted", "[ ]");
		
		return `${checkbox} ${model.value} · ${model.description || ""}`;
	}

	#formatFooter(): string {
		if (this.#selected.size === 0) {
			return "Selected: (none)";
		}
		
		const sorted = Array.from(this.#selected.entries())
			.sort((a, b) => a[1] - b[1])
			.map(([ref]) => shortenModelRef(ref));
		
		return `Selected: ${this.#selected.size} fallback${this.#selected.size === 1 ? "" : "s"} · ${sorted.join(", ")}`;
	}


	#applyFilters(): void {
		// Filter out primary model
		const availableModels = this.#allModels.filter(
			(m) => m.value !== this.#primaryRef
		);
		
		// Apply scope filter by extracting provider from value (e.g., "anthropic/id" → "anthropic")
		const scopedModels = this.#scope === "all"
			? availableModels
			: availableModels.filter((m) => {
				const provider = m.value.split("/")[0];
				return provider === this.#scope;
			});
		
		// Apply search filter
		const query = this.#searchInput.getValue();
		this.#filteredModels = query
			? fuzzyFilter(scopedModels, query, (m) => `${m.value} ${m.description || ""}`)
			: scopedModels;
		
		// Clamp cursor
		this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredModels.length - 1));
	}

	#moveUp(): void {
		if (this.#filteredModels.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex - 1 + this.#filteredModels.length) % this.#filteredModels.length;
	}

	#moveDown(): void {
		if (this.#filteredModels.length === 0) return;
		this.#selectedIndex = (this.#selectedIndex + 1) % this.#filteredModels.length;
	}

	#toggle(modelRef: string): void {
		if (this.#selected.has(modelRef)) {
			this.#selected.delete(modelRef);
			this.#recompact();
		} else {
			const nextOrder = this.#selected.size + 1;
			this.#selected.set(modelRef, nextOrder);
		}
	}

	#recompact(): void {
		const entries = Array.from(this.#selected.entries()).sort((a, b) => a[1] - b[1]);
		this.#selected.clear();
		entries.forEach(([ref], i) => this.#selected.set(ref, i + 1));
	}

	#getResult(): string[] {
		return Array.from(this.#selected.entries())
			.sort((a, b) => a[1] - b[1])
			.map(([ref]) => ref);
	}

	invalidate(): void {
		// No cached rendering — render() is idempotent
	}
}
