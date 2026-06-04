import { describe, it, expect } from "bun:test";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@oh-my-pi/pi-tui";
import { makeTheme } from "./_helpers/theme";
import { ProfileListComponent, type ProfileListResult } from "../src/tui/profile-list";
import type { RouterProfile } from "../src/types";

// Models use letters without 'd'/'e' pairs to avoid spurious fuzzy matches on "de".
function makeProfile(tier: "a" | "b" | "c"): RouterProfile {
	return {
		high: { model: `${tier}${tier}${tier}-hi` },
		medium: { model: `${tier}${tier}${tier}-m` },
		low: { model: `${tier}${tier}${tier}-lo` },
	};
}

function setup(opts?: {
	profiles?: { name: string; profile: RouterProfile }[];
	activeProfile?: string;
}) {
	const theme = makeTheme();
	const kb = new KeybindingsManager(TUI_KEYBINDINGS);
	const profiles = opts?.profiles ?? [
		{ name: "auto", profile: makeProfile("a") },
		{ name: "deep", profile: makeProfile("b") },
		{ name: "cheap", profile: makeProfile("c") },
	];
	let result: ProfileListResult | undefined | "NOT_CALLED" = "NOT_CALLED";
	const done = (r: ProfileListResult | undefined) => {
		result = r;
	};
	const component = new ProfileListComponent(
		null as unknown as TUI, // component never uses tui directly in these tests
		theme,
		kb,
		done,
		profiles,
		opts?.activeProfile,
	);
	return { component, getResult: () => result, kb };
}

function rendered(component: { render(w: number): string[] }, width = 120): string {
	return component.render(width).join("\n");
}

describe("ProfileListComponent", () => {
	it("fuzzy filter", () => {
		const { component } = setup();
		const before = rendered(component);
		expect(before).toContain("auto");
		expect(before).toContain("deep");
		expect(before).toContain("cheap");

		// Type "de" — should match "deep" only
		component.handleInput("d");
		component.handleInput("e");
		const after = rendered(component);
		expect(after).toContain("deep");
		expect(after).not.toContain("auto");
		expect(after).not.toContain("cheap");
	});

	it("action dispatch — activate on Enter", () => {
		const { component, getResult } = setup();
		// Enter activates the highlighted (first) profile
		component.handleInput("\r");
		expect(getResult()).toEqual({ action: "activate", profile: "auto" });
	});

	it("action dispatch — edit on ctrl+e", () => {
		const { component, getResult } = setup();
		// ctrl+e without inlineOptions emits edit result
		component.handleInput("\x05"); // ctrl+e
		expect(getResult()).toEqual({ action: "edit", profile: "auto" });
	});

	it("edge state — no profiles", () => {
		const { component } = setup({ profiles: [] });
		const output = rendered(component);
		expect(output.toLowerCase()).toContain("no profiles configured");
	});

	it("edge state — single profile, ctrl+d silently ignored", () => {
		const { component, getResult } = setup({
			profiles: [{ name: "solo", profile: makeProfile("a") }],
		});
		component.handleInput("\x04"); // ctrl+d
		expect(getResult()).toBe("NOT_CALLED");
	});

	it("narrow-mode truncation", () => {
		const { component } = setup();
		const width = 60;
		const lines = component.render(width);
		for (const line of lines) {
			// Identity theme means no invisible ANSI sequences; raw length is visible width
			expect(line.length).toBeLessThanOrEqual(width);
		}
	});

	it("cancel on Escape", () => {
		const { component, getResult } = setup();
		component.handleInput("\x1b");
		expect(getResult()).toBeUndefined();
	});
});
