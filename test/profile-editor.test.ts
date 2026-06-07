import { describe, test, expect } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { RouterProfile } from "../src/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { ProfileEditorComponent } from "../src/tui/profile-editor";
import { makeTheme } from "./_helpers/theme";

// Raw key sequences
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";
const CTRL_S = "\x13";

function makeProfile(overrides?: Partial<RouterProfile>): RouterProfile {
	const base: RouterProfile = {
		high: { model: "openai/gpt-4", thinking: ThinkingLevel.High, fallbacks: ["openai/gpt-3.5"] },
		medium: { model: "openai/gpt-3.5", thinking: ThinkingLevel.Medium, fallbacks: ["anthropic/claude-opus"] },
		low: { model: "anthropic/claude-haiku", thinking: ThinkingLevel.Low, fallbacks: ["google/gemini-2b"] },
	};
	if (overrides) {
		return { ...base, ...overrides };
	}
	return base;
}

function makeEditor(
	profile: RouterProfile,
	done: (result: RouterProfile | undefined) => void,
	profileName = "test-profile",
): ProfileEditorComponent {
	return new ProfileEditorComponent(
		null as unknown as TUI,
		makeTheme(),
		new KeybindingsManager(TUI_KEYBINDINGS),
		done,
		profileName,
		profile,
		{ getAvailable: () => [] } as unknown as ModelRegistry,
	);
}

describe("ProfileEditorComponent", () => {
	test("dirty tracking — no changes is not dirty", () => {
		let result: RouterProfile | undefined = "sentinel" as unknown as RouterProfile;
		const component = makeEditor(makeProfile(), (r) => { result = r; });

		// Press Escape immediately — not dirty, should call done(undefined)
		component.handleInput(ESC);
		expect(result).toBeUndefined();
	});

	test("dirty tracking — model change triggers dirty_confirm", () => {
		let doneCalled = false;
		const component = makeEditor(makeProfile(), () => { doneCalled = true; });

		// Cursor at row 0 (high.thinking). Cycle to mutate draft
		component.handleInput(SPACE); // cycle thinking

		// Now press Escape; should enter dirty_confirm state, NOT call done
		component.handleInput(ESC);

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Unsaved");
		expect(doneCalled).toBe(false);
	});

	test("dirty_confirm state transitions", () => {
		let doneCalled = false;
		let doneResult: RouterProfile | undefined;
		const component = makeEditor(makeProfile(), (r) => { doneCalled = true; doneResult = r; });

		// Cycle thinking to make draft dirty
		component.handleInput(SPACE);

		// Esc -> dirty_confirm
		component.handleInput(ESC);
		expect(component.render(80).join("\n")).toContain("Unsaved");

		// 'n' -> back to editing
		component.handleInput("n");
		expect(component.render(80).join("\n")).not.toContain("Unsaved");
		expect(doneCalled).toBe(false);

		// Esc again -> dirty_confirm again
		component.handleInput(ESC);
		expect(component.render(80).join("\n")).toContain("Unsaved");

		// 'y' -> discard changes, done(undefined)
		component.handleInput("y");
		expect(doneCalled).toBe(true);
		expect(doneResult).toBeUndefined();
	});

	test("missing-model warning", () => {
		const component = makeEditor(
			makeProfile({ high: { model: "", thinking: ThinkingLevel.High, fallbacks: [] } }),
			() => {},
		);

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("has no model");
	});

	test("ctrl+s saves draft", () => {
		const profile = makeProfile();
		let savedProfile: RouterProfile | undefined;
		const component = makeEditor(profile, (r) => { savedProfile = r; });

		component.handleInput(CTRL_S);

		expect(savedProfile).not.toBeUndefined();
		// Saved draft is a deep clone — same content but different reference
		expect(savedProfile!.high.model).toBe(profile.high.model);
		expect(savedProfile!.medium.model).toBe(profile.medium.model);
		expect(savedProfile!.low.model).toBe(profile.low.model);
	});

	test("thinking cycle", () => {
		const profile = makeProfile({
			high: { model: "openai/gpt-4", thinking: ThinkingLevel.Low, fallbacks: ["openai/gpt-3.5"] },
		});
		const component = makeEditor(profile, () => {});

		// Cursor starts at row 0 (high.thinking)
		// Initial: Low
		expect(component.render(80).join("\n")).toContain("low");

		// Cycle 1: Low -> Medium
		component.handleInput(SPACE);
		expect(component.render(80).join("\n")).toContain("medium");

		// Cycle 2: Medium -> High
		component.handleInput(SPACE);
		expect(component.render(80).join("\n")).toContain("high");

		// Cycle 3: High -> Low (wraps)
		component.handleInput(SPACE);
		expect(component.render(80).join("\n")).toContain("low");
	});

	test("cursor wraps around at boundaries", () => {
		const component = makeEditor(makeProfile(), () => {});

		// With 9 rows total, UP from cursor 0 wraps to last row (8)
		component.handleInput(UP);
		const upRender = component.render(80).join("\n");
		// Should show last row selected
		expect(upRender).toContain("(9/9)");

		// Down from last row wraps to first
		component.handleInput(DOWN);
		const downRender = component.render(80).join("\n");
		expect(downRender).toContain("(1/9)");
	});

	test("escape in dirty_confirm stays in dirty_confirm", () => {
		let doneCalled = false;
		const component = makeEditor(makeProfile(), () => { doneCalled = true; });

		// Make dirty by cycling thinking
		component.handleInput(SPACE); // cycle thinking on row 0

		// Enter dirty_confirm
		component.handleInput(ESC);
		expect(component.render(80).join("\n")).toContain("Unsaved");

		// Escape again should be ignored (stays in dirty_confirm)
		component.handleInput(ESC);
		expect(component.render(80).join("\n")).toContain("Unsaved");
		expect(doneCalled).toBe(false);
	});

	test("ctrl+s from dirty_confirm state saves", () => {
		let savedProfile: RouterProfile | undefined;
		const component = makeEditor(makeProfile(), (r) => { savedProfile = r; });

		// Make dirty
		component.handleInput(SPACE); // cycle thinking

		// Enter dirty_confirm
		component.handleInput(ESC);

		// ctrl+s saves
		component.handleInput(CTRL_S);
		expect(savedProfile).not.toBeUndefined();
	});

	test("undefined fallbacks treated as empty", () => {
		const profile: RouterProfile = {
			high: { model: "openai/gpt-4", thinking: ThinkingLevel.High, fallbacks: ["openai/gpt-3.5"] },
			medium: { model: "openai/gpt-3.5", thinking: ThinkingLevel.Medium, fallbacks: ["anthropic/claude-opus"] },
			low: { model: "anthropic/claude-haiku", thinking: ThinkingLevel.Low },
		};
		const component = makeEditor(profile, () => {});

		const rendered = component.render(80).join("\n");
		// low tier has no fallbacks, so chain only has 1 row
		expect(rendered).toContain("anthropic/claude-haiku");
	});

	test("render includes profile name and tier headers", () => {
		const component = makeEditor(makeProfile(), () => {}, "my-profile");

		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Editing: my-profile");
		expect(rendered).toContain("HIGH");
		expect(rendered).toContain("MEDIUM");
		expect(rendered).toContain("LOW");
	});

	test("draft mutation does not affect original profile object", () => {
		const profile = makeProfile();
		const originalThinking = profile.high.thinking;
		const component = makeEditor(profile, () => {});

		// Mutate draft by cycling thinking
		component.handleInput(SPACE);

		// Original profile is unchanged
		expect(profile.high.thinking).toBe(originalThinking);
	});
});
