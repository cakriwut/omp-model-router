import { describe, test, expect } from "bun:test";
import { renderUsageReport } from "../src/ui";
import type { RouterConfig } from "../src/types";
import type { TierCounter, ModelCostEntry } from "../src/state";
import { stripAnsi } from "./_helpers/ansi";
import { makeTheme } from "./_helpers/theme";

const baseProfile: RouterConfig["profiles"][string] = {
	high: { model: "anthropic/claude-sonnet-4-5" },
	medium: { model: "anthropic/claude-sonnet-4-5" },
	low: { model: "anthropic/claude-haiku-4-5" },
};

describe("Usage report — tier label display", () => {
	test("shows only low 100% label when all decisions are low tier", () => {
		const tierCounter: TierCounter = { high: 0, medium: 0, low: 12 };
		const modelCosts = new Map<string, ModelCostEntry>();

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				tierCounter,
				modelCosts,
				lastDecision: undefined,
				modelRegistry: { find: () => ({ contextWindow: 200_000, cost: { input: 0.25, output: 1.25 } }) },
			}),
		);

		const lines = report.split("\n");
		const labelLine = lines.find((l) => l.includes("low 100%"));
		
		expect(labelLine).toBeDefined();
		expect(labelLine).toContain("low 100%");
		expect(labelLine).not.toContain("high 0%");
		expect(labelLine).not.toContain("medium 0%");
	});

	test("shows only high 100% label when all decisions are high tier", () => {
		const tierCounter: TierCounter = { high: 8, medium: 0, low: 0 };
		const modelCosts = new Map<string, ModelCostEntry>();

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				tierCounter,
				modelCosts,
				lastDecision: undefined,
				modelRegistry: { find: () => ({ contextWindow: 200_000, cost: { input: 3.0, output: 15.0 } }) },
			}),
		);

		const lines = report.split("\n");
		const labelLine = lines.find((l) => l.includes("high 100%"));
		
		expect(labelLine).toBeDefined();
		expect(labelLine).toContain("high 100%");
		expect(labelLine).not.toContain("medium 0%");
		expect(labelLine).not.toContain("low 0%");
	});

	test("shows all three labels when distribution is mixed", () => {
		const tierCounter: TierCounter = { high: 2, medium: 3, low: 5 };
		const modelCosts = new Map<string, ModelCostEntry>();

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				tierCounter,
				modelCosts,
				lastDecision: undefined,
				modelRegistry: { find: () => ({ contextWindow: 200_000, cost: { input: 3.0, output: 15.0 } }) },
			}),
		);

		const lines = report.split("\n");
		const labelLine = lines.find((l) => l.includes("high") && l.includes("medium") && l.includes("low"));
		
		expect(labelLine).toBeDefined();
		expect(labelLine).toContain("high 20%");
		expect(labelLine).toContain("medium 30%");
		expect(labelLine).toContain("low 50%");
	});
});
