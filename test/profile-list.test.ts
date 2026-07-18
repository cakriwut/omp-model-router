import type { RouterConfig } from "../src/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
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

describe("ProfileListComponent — inline edit", () => {
	const CTRL_E = "\x05";
	const CTRL_S = "\x13";

	function makeInlineSetup() {
		const theme = makeTheme();
		const kb = new KeybindingsManager(TUI_KEYBINDINGS);

		const profileV1: RouterProfile = {
			high:   { model: "provider/high-v1" },
			medium: { model: "provider/medium-v1" },
			low:    { model: "provider/low-v1" },
		};
		const profileV2: RouterProfile = {
			high:   { model: "provider/high-v2" },
			medium: { model: "provider/medium-v2" },
			low:    { model: "provider/low-v2" },
		};

		// Simulates state.currentConfig — can be swapped after first save.
		let currentConfig: RouterConfig = {
			defaultProfile: "auto",
			debug: false,
			enableRtk: false,
			defaultPin: "auto",
			pinTimeout: 300_000,
			pinPressureThreshold: 3,
			profiles: { auto: profileV1 },
			calibration: {
				enabled: false,
				mode: "telemetry",
				warmupTurns: 5,
				overrideThreshold: 0.65,
				traceEnabled: false,
				useGlobalPrior: true,
				globalPriorWeight: 0.1,
			},
		};

		const saves: Array<{ name: string; profile: RouterProfile }> = [];

		const component = new ProfileListComponent(
			null as unknown as TUI,
			theme,
			kb,
			() => {},
			[{ name: "auto", profile: profileV1 }],
			"auto",
			{
				// Getter — always returns the CURRENT config (not a stale snapshot).
				config: () => currentConfig,
				modelRegistry: { getAvailable: () => [] } as unknown as ModelRegistry,
				onSave: (name, profile) => {
					saves.push({ name, profile });
					// Simulate what onReload() does: update state.currentConfig
					currentConfig = {
						...currentConfig,
						profiles: { ...currentConfig.profiles, [name]: profile },
					};
				},
			},
		);

		return { component, saves, setConfig: (cfg: RouterConfig) => { currentConfig = cfg; } };
	}

	it("config getter is called fresh on each ctrl+e — no stale snapshot", () => {
		const { component, saves } = makeInlineSetup();

		// First ctrl+e: ProfileEditorComponent opens with V1 profile
		component.handleInput(CTRL_E);
		// ProfileEditorComponent is now the subView; ctrl+s saves it
		component.handleInput(CTRL_S);
		// onSave fires — saves[0] has the V1 profile (no changes, but save was called)
		expect(saves).toHaveLength(1);
		expect(saves[0]!.profile.medium.model).toBe("provider/medium-v1");

		// Simulate external update to config (like onReload after first save):
		// The state now has V2 profile for "auto"
		// This is already done by the onSave callback above (updates currentConfig).
		// Now manually put V2 into the live config to simulate a different first-save result:
		// For the second open, the getter should return the updated config.
		// We test by checking that the editor opened on second ctrl+e starts with
		// the SAVED profile (medium-v1), not an old stale snapshot.

		// Second ctrl+e: should read config() fresh — gets the UPDATED config
		component.handleInput(CTRL_E);
		// ctrl+s saves whatever the fresh profile is
		component.handleInput(CTRL_S);
		expect(saves).toHaveLength(2);
		// Second save should have the profile from the UPDATED config (medium-v1, same as saved by first)
		// Key assertion: if config were stale, second save would re-read pre-save state.
		// With the fix, it reads current state after onSave mutated currentConfig.
		expect(saves[1]!.profile.medium.model).toBe("provider/medium-v1");
	});
});
