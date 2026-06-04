import { describe, it, expect } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS, matchesKey } from "@oh-my-pi/pi-tui";
import { FallbackPickerComponent, type SelectItem } from "../src/tui/fallback-picker";
import { makeTheme } from "./_helpers/theme";

describe("FallbackPickerComponent", () => {
	// Helper to create a component instance
	function createComponent(opts: {
		allModels: SelectItem[];
		primaryRef: string;
		currentFallbacks?: string[];
		currentTier?: string;
	}) {
		const { allModels, primaryRef, currentFallbacks = [], currentTier = "high" } = opts;
		const theme = makeTheme();
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
		const tui = null as unknown as TUI;

		let done: { result: string[] | undefined; called: boolean } = {
			result: undefined,
			called: false,
		};

		const component = new FallbackPickerComponent(
			tui,
			theme,
			keybindings,
			(result) => {
				done.result = result;
				done.called = true;
			},
			allModels,
			primaryRef,
			currentFallbacks,
			currentTier
		);

		return { component, theme, keybindings, done };
	}

	// Helper to render and get a single line containing text
	function getRenderedContent(lines: string[]): string {
		return lines.join("\n");
	}

	it("toggle adds model with order", () => {
		const allModels: SelectItem[] = [
			{ value: "anthropic/claude", label: "Claude", description: "Anthropic" },
			{ value: "openai/gpt4", label: "GPT-4", description: "OpenAI" },
			{ value: "google/palm", label: "PaLM", description: "Google" },
		];

		const { component } = createComponent({
			allModels,
			primaryRef: "anthropic/claude",
			currentFallbacks: [],
		});

		// Render initially
		let lines = component.render(80);
		let content = getRenderedContent(lines);

		// Should not have order markers initially
		expect(content).not.toContain("[1]");
		expect(content).not.toContain("[2]");

		// Move to first model (openai/gpt4) and toggle
		component.handleInput("\x1b[B"); // down arrow
		component.handleInput(" "); // space to toggle
		lines = component.render(80);
		content = getRenderedContent(lines);

		// Should show [1] next to the toggled model
		expect(content).toContain("[1]");
		expect(content).toContain("openai/gpt4");
	});

	it("ordering re-compacts on removal", () => {
		const allModels: SelectItem[] = [
			{ value: "anthropic/claude", label: "Claude", description: "Anthropic" },
			{ value: "openai/gpt4", label: "GPT-4", description: "OpenAI" },
			{ value: "google/palm", label: "PaLM", description: "Google" },
			{ value: "cohere/command", label: "Command", description: "Cohere" },
		];

		const { component } = createComponent({
			allModels,
			primaryRef: "anthropic/claude",
			currentFallbacks: [],
		});

		// Select items at indices 1, 2, 3 (skip primary at 0)
		// After filtering out primary, indices are: 0=openai/gpt4, 1=google/palm, 2=cohere/command

		// Move to index 0 and toggle
		component.handleInput(" ");
		component.handleInput("\x1b[B"); // move to index 1
		component.handleInput(" ");
		component.handleInput("\x1b[B"); // move to index 2
		component.handleInput(" ");

		let lines = component.render(80);
		let content = getRenderedContent(lines);

		// Should have [1], [2], [3]
		expect(content).toContain("[1]");
		expect(content).toContain("[2]");
		expect(content).toContain("[3]");

		// Now move back and deselect the middle one (index 1)
		component.handleInput("\x1b[A"); // up
		component.handleInput("\x1b[A"); // up
		component.handleInput(" "); // deselect [2]

		lines = component.render(80);
		content = getRenderedContent(lines);

		// Should still have [1] and [2] (recompacted from [1] and [3])
		expect(content).toContain("[1]");
		expect(content).toContain("[2]");
		expect(content).not.toContain("[3]");
	});

	it("primary model exclusion", () => {
		const allModels: SelectItem[] = [
			{ value: "anthropic/claude", label: "Claude", description: "Anthropic" },
			{ value: "openai/gpt4", label: "GPT-4", description: "OpenAI" },
			{ value: "google/palm", label: "PaLM", description: "Google" },
		];

		const { component } = createComponent({
			allModels,
			primaryRef: "anthropic/claude",
			currentFallbacks: [],
		});

		const lines = component.render(80);
		const content = getRenderedContent(lines);

		// Primary model should not appear in the list
		expect(content).not.toContain("anthropic/claude");
		// Other models should appear
		expect(content).toContain("openai/gpt4");
		expect(content).toContain("google/palm");
	});

	it("clear all with ctrl+a", () => {
		const allModels: SelectItem[] = [
			{ value: "anthropic/claude", label: "Claude", description: "Anthropic" },
			{ value: "openai/gpt4", label: "GPT-4", description: "OpenAI" },
			{ value: "google/palm", label: "PaLM", description: "Google" },
		];

		const { component } = createComponent({
			allModels,
			primaryRef: "anthropic/claude",
			currentFallbacks: [],
		});

		// Select 2 models
		component.handleInput(" "); // toggle first
		component.handleInput("\x1b[B"); // move down
		component.handleInput(" "); // toggle second

		let lines = component.render(80);
		let content = getRenderedContent(lines);

		// Should have selections
		expect(content).toContain("[1]");
		expect(content).toContain("[2]");

		// Press ctrl+a to clear all
		component.handleInput("\x03"); // This won't work, need to use matchesKey directly

		// Actually, ctrl+a is checked with matchesKey(data, "ctrl+a")
		// We need to send the actual key code for ctrl+a
		// ctrl+a is \x01
		component.handleInput("\x01");

		lines = component.render(80);
		content = getRenderedContent(lines);

		// Should have no selected markers
		expect(content).not.toContain("[1]");
		expect(content).not.toContain("[2]");
		expect(content).toContain("[ ]");
	});

	it("cancel returns undefined", () => {
		const allModels: SelectItem[] = [
			{ value: "anthropic/claude", label: "Claude", description: "Anthropic" },
			{ value: "openai/gpt4", label: "GPT-4", description: "OpenAI" },
		];

		const { component, done } = createComponent({
			allModels,
			primaryRef: "anthropic/claude",
			currentFallbacks: [],
		});

		// Press Escape to cancel
		component.handleInput("\x1b"); // Escape

		expect(done.called).toBe(true);
		expect(done.result).toBeUndefined();
	});

	it("confirm returns sorted array", () => {
		const allModels: SelectItem[] = [
			{ value: "anthropic/claude", label: "Claude", description: "Anthropic" },
			{ value: "openai/gpt4", label: "GPT-4", description: "OpenAI" },
			{ value: "google/palm", label: "PaLM", description: "Google" },
		];

		const { component, done } = createComponent({
			allModels,
			primaryRef: "anthropic/claude",
			currentFallbacks: [],
		});

		// Filtered list (excluding primary): index 0 = openai/gpt4, index 1 = google/palm
		// Cursor starts at 0; select openai/gpt4 first, then move down and select google/palm
		component.handleInput(" "); // toggle index 0 (openai/gpt4) → order 1
		component.handleInput("\x1b[B"); // move to index 1
		component.handleInput(" "); // toggle index 1 (google/palm) → order 2

		// Press Enter to confirm
		component.handleInput("\r");

		expect(done.called).toBe(true);
		// Result is sorted by selection order
		expect(done.result).toEqual(["openai/gpt4", "google/palm"]);
	});
});
