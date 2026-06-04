import { describe, it, expect } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { ModelPickerComponent, type ModelItem, type ModelPickerOptions } from "../src/tui/model-picker";
import { makeTheme } from "./_helpers/theme";
import type { TUI } from "@oh-my-pi/pi-coding-agent";

describe("ModelPickerComponent", () => {
	const makeKeybindings = () => new KeybindingsManager(TUI_KEYBINDINGS);

	it("fuzzy filter — filters models by typed chars", () => {
		const models: ModelItem[] = [
			{
				provider: "anthropic",
				id: "claude-opus",
				name: "Claude Opus",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "anthropic",
				id: "claude-sonnet",
				name: "Claude Sonnet",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "openai",
				id: "gpt-4",
				name: "GPT-4",
				contextWindow: 128000,
				costInput: 0.03,
				costOutput: 0.06,
			},
		];

		let pickedRef: string | undefined;
		const done = (ref: string | undefined) => {
			pickedRef = ref;
		};

		const options: ModelPickerOptions = {
			tier: "high",
			models,
		};

		const picker = new ModelPickerComponent(null as unknown as TUI, makeTheme(), makeKeybindings(), done, options);

		// Type 'c' to filter for claude models
		picker.handleInput("c");
		let rendered = picker.render(100).join("\n");

		expect(rendered).toContain("claude-opus");
		expect(rendered).toContain("claude-sonnet");
		expect(rendered).not.toContain("gpt-4");

		// Type another 'l' for second char of 'claude'
		picker.handleInput("l");
		rendered = picker.render(100).join("\n");

		expect(rendered).toContain("claude");
		expect(rendered).not.toContain("gpt-4");
	});

	it("scope selection — TAB cycles through provider scopes", () => {
		const models: ModelItem[] = [
			{
				provider: "anthropic",
				id: "claude-opus",
				name: "Claude Opus",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "openai",
				id: "gpt-4",
				name: "GPT-4",
				contextWindow: 128000,
				costInput: 0.03,
				costOutput: 0.06,
			},
			{
				provider: "google",
				id: "gemini-pro",
				name: "Gemini Pro",
				contextWindow: 128000,
				costInput: 0.5,
				costOutput: 1.5,
			},
		];

		let pickedRef: string | undefined;
		const done = (ref: string | undefined) => {
			pickedRef = ref;
		};

		const options: ModelPickerOptions = {
			tier: "medium",
			models,
		};

		const kb = makeKeybindings();
		const picker = new ModelPickerComponent(null as unknown as TUI, makeTheme(), kb, done, options);

		// Start with ALL scope visible
		let rendered = picker.render(100).join("\n");
		expect(rendered).toContain("claude-opus");
		expect(rendered).toContain("gpt-4");
		expect(rendered).toContain("gemini-pro");

		// Tab to cycle scopes
		picker.handleInput("\t");
		rendered = picker.render(100).join("\n");

		// Should now be in first provider scope (one of the providers)
		// The exact provider depends on alphabetical order, but we should see only models from one provider
		const hasAnthropicOnly = rendered.includes("claude-opus") && !rendered.includes("gpt-4");
		const hasOpenAIOnly = rendered.includes("gpt-4") && !rendered.includes("claude-opus");
		const hasGoogleOnly = rendered.includes("gemini-pro") && !rendered.includes("gpt-4");

		expect(hasAnthropicOnly || hasOpenAIOnly || hasGoogleOnly).toBe(true);
	});

	it("badge placement — shows [primary] badge for currentPrimary model", () => {
		const models: ModelItem[] = [
			{
				provider: "anthropic",
				id: "claude-opus",
				name: "Claude Opus",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "anthropic",
				id: "claude-sonnet",
				name: "Claude Sonnet",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
		];

		const done = () => {};

		const options: ModelPickerOptions = {
			tier: "high",
			currentPrimary: "anthropic/claude-opus",
			models,
		};

		const picker = new ModelPickerComponent(null as unknown as TUI, makeTheme(), makeKeybindings(), done, options);
		const rendered = picker.render(100).join("\n");

		expect(rendered).toContain("[primary]");
		// Verify it's associated with the right model by checking context
		const lines = rendered.split("\n");
		let foundPrimaryBadge = false;
		for (const line of lines) {
			if (line.includes("claude-opus") && line.includes("[primary]")) {
				foundPrimaryBadge = true;
				break;
			}
		}
		expect(foundPrimaryBadge).toBe(true);
	});

	it("badge placement — shows [fallback N] badges for currentFallbacks models", () => {
		const models: ModelItem[] = [
			{
				provider: "anthropic",
				id: "claude-opus",
				name: "Claude Opus",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "anthropic",
				id: "claude-sonnet",
				name: "Claude Sonnet",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "openai",
				id: "gpt-4",
				name: "GPT-4",
				contextWindow: 128000,
				costInput: 0.03,
				costOutput: 0.06,
			},
		];

		const done = () => {};

		const options: ModelPickerOptions = {
			tier: "high",
			currentFallbacks: ["anthropic/claude-sonnet", "openai/gpt-4"],
			models,
		};

		const picker = new ModelPickerComponent(null as unknown as TUI, makeTheme(), makeKeybindings(), done, options);
		const rendered = picker.render(100).join("\n");

		expect(rendered).toContain("[fallback 1]");
		expect(rendered).toContain("[fallback 2]");

		// Verify association
		const lines = rendered.split("\n");
		let foundFallback1 = false;
		let foundFallback2 = false;
		for (const line of lines) {
			if (line.includes("claude-sonnet") && line.includes("[fallback 1]")) {
				foundFallback1 = true;
			}
			if (line.includes("gpt-4") && line.includes("[fallback 2]")) {
				foundFallback2 = true;
			}
		}
		expect(foundFallback1).toBe(true);
		expect(foundFallback2).toBe(true);
	});

	it("cost formatting — shows per-million cost or 'cost unknown'", () => {
		const models: ModelItem[] = [
			{
				provider: "anthropic",
				id: "claude-opus",
				name: "Claude Opus",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "openai",
				id: "gpt-4",
				name: "GPT-4",
				contextWindow: 128000,
				// costInput and costOutput intentionally undefined
			},
		];

		const done = () => {};

		const options: ModelPickerOptions = {
			tier: "high",
			models,
		};

		const picker = new ModelPickerComponent(null as unknown as TUI, makeTheme(), makeKeybindings(), done, options);
		const rendered = picker.render(100).join("\n");

		// Claude should show cost as $3/$15 format
		expect(rendered).toContain("$3/$15");

		// GPT-4 should show cost unknown
		expect(rendered).toContain("cost unknown");

		// Verify they're on the right model lines
		const lines = rendered.split("\n");
		let foundClaudeCost = false;
		let foundGPTUnknown = false;
		for (const line of lines) {
			if (line.includes("claude-opus") && line.includes("$3/$15")) {
				foundClaudeCost = true;
			}
			if (line.includes("gpt-4") && line.includes("cost unknown")) {
				foundGPTUnknown = true;
			}
		}
		expect(foundClaudeCost).toBe(true);
		expect(foundGPTUnknown).toBe(true);
	});

	it("cancel calls done(undefined) — pressing Escape", () => {
		const models: ModelItem[] = [
			{
				provider: "anthropic",
				id: "claude-opus",
				name: "Claude Opus",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
		];

		let pickedRef: string | undefined = "not-called";
		const done = (ref: string | undefined) => {
			pickedRef = ref;
		};

		const options: ModelPickerOptions = {
			tier: "high",
			models,
		};

		const kb = makeKeybindings();
		const picker = new ModelPickerComponent(null as unknown as TUI, makeTheme(), kb, done, options);

		// Press Escape
		picker.handleInput("\x1b");

		expect(pickedRef).toBe(undefined);
	});

	it("confirm calls done(modelRef) — navigate and press Enter", () => {
		const models: ModelItem[] = [
			{
				provider: "anthropic",
				id: "claude-opus",
				name: "Claude Opus",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
			{
				provider: "anthropic",
				id: "claude-sonnet",
				name: "Claude Sonnet",
				contextWindow: 200000,
				costInput: 3.0,
				costOutput: 15.0,
			},
		];

		let pickedRef: string | undefined = "not-called";
		const done = (ref: string | undefined) => {
			pickedRef = ref;
		};

		const options: ModelPickerOptions = {
			tier: "high",
			models,
		};

		const kb = makeKeybindings();
		const picker = new ModelPickerComponent(null as unknown as TUI, makeTheme(), kb, done, options);

		// Navigate down to second model
		picker.handleInput("\x1b[B");

		// Press Enter to confirm
		picker.handleInput("\r");

		expect(pickedRef).toBe("anthropic/claude-sonnet");
	});
});
