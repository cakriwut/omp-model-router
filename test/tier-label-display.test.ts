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

describe("Usage report — orphan models (removed from profile)", () => {
	const profile: RouterConfig["profiles"][string] = {
		high: { model: "anthropic/claude-opus-4-7" },
		medium: { model: "anthropic/claude-sonnet-4-5" },
		low: { model: "anthropic/claude-haiku-3-5" },
	};

	function makeCostEntry(model: string, tier: string, cost: number, invocations = 2): ModelCostEntry {
		return { model, tier, invocations, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, cost };
	}

	test("orphan model appears under 'removed from profile' separator", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",     makeCostEntry("anthropic/claude-opus-4-7", "high", 0.12)],
			["anthropic/claude-sonnet-4-5",   makeCostEntry("anthropic/claude-sonnet-4-5", "medium", 0.04)],
			["anthropic/claude-haiku-3-5",    makeCostEntry("anthropic/claude-haiku-3-5", "low", 0.01)],
			["anthropic/claude-3-5-sonnet-20241022", makeCostEntry("anthropic/claude-3-5-sonnet-20241022", "", 0.019, 2)],
		]);

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile,
				tierCounter: { high: 1, medium: 2, low: 1 },
				modelCosts,
				lastDecision: undefined,
				modelRegistry: { find: () => ({ contextWindow: 200_000, cost: { input: 3.0, output: 15.0 } }) },
			}),
		);

		expect(report).toContain("removed from profile");
		expect(report).toContain("claude-3-5-sonnet-20241022");
		expect(report).toContain("$0.0190");
		expect(report).toContain("2x");
	});

	test("orphan block absent when all models are in the profile", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high", 0.1)],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium", 0.05)],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low", 0.01)],
		]);

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile,
				tierCounter: { high: 1, medium: 1, low: 1 },
				modelCosts,
				lastDecision: undefined,
				modelRegistry: { find: () => ({ contextWindow: 200_000, cost: { input: 3.0, output: 15.0 } }) },
			}),
		);

		expect(report).not.toContain("removed from profile");
	});

	test("multiple orphan models all appear in the orphan block", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",     makeCostEntry("anthropic/claude-opus-4-7", "high", 0.1)],
			["anthropic/claude-sonnet-4-5",   makeCostEntry("anthropic/claude-sonnet-4-5", "medium", 0.05)],
			["anthropic/claude-haiku-3-5",    makeCostEntry("anthropic/claude-haiku-3-5", "low", 0.01)],
			["anthropic/claude-3-5-sonnet-20241022", makeCostEntry("anthropic/claude-3-5-sonnet-20241022", "", 0.019, 3)],
			["openai/gpt-4o",                 makeCostEntry("openai/gpt-4o", "", 0.008, 1)],
		]);

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile,
				tierCounter: { high: 2, medium: 2, low: 1 },
				modelCosts,
				lastDecision: undefined,
				modelRegistry: { find: () => ({ contextWindow: 200_000, cost: { input: 3.0, output: 15.0 } }) },
			}),
		);

		expect(report).toContain("removed from profile");
		expect(report).toContain("claude-3-5-sonnet-20241022");
		expect(report).toContain("gpt-4o");
		// Configured models must NOT appear in the orphan block (they appear in their tier rows above)
		const orphanSection = report.split("removed from profile")[1] ?? "";
		expect(orphanSection).not.toContain("claude-opus-4-7");
		expect(orphanSection).not.toContain("claude-sonnet-4-5");
		expect(orphanSection).not.toContain("claude-haiku-3-5");
	});

	test("header cost total includes orphan model cost", () => {
		// $0.12 + $0.04 + $0.01 + $0.019 = $0.189
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",     makeCostEntry("anthropic/claude-opus-4-7", "high", 0.12)],
			["anthropic/claude-sonnet-4-5",   makeCostEntry("anthropic/claude-sonnet-4-5", "medium", 0.04)],
			["anthropic/claude-haiku-3-5",    makeCostEntry("anthropic/claude-haiku-3-5", "low", 0.01)],
			["anthropic/claude-3-5-sonnet-20241022", makeCostEntry("anthropic/claude-3-5-sonnet-20241022", "", 0.019, 2)],
		]);

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile,
				tierCounter: { high: 1, medium: 2, low: 1 },
				modelCosts,
				lastDecision: undefined,
				accumulatedCost: 0.189,
				modelRegistry: { find: () => ({ contextWindow: 200_000, cost: { input: 3.0, output: 15.0 } }) },
			}),
		);

		const headerLine = report.split("\n")[0];
		expect(headerLine).toContain("$0.1890");
	});
});
