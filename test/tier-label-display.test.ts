import { describe, test, expect } from "bun:test";
import { renderUsageReport } from "../src/ui";
import type { RouterConfig } from "../src/types";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const makeTheme = (): any => ({
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	dim: (text: string) => text,
});

const baseProfile: RouterConfig["profiles"][string] = {
	high: { model: "anthropic/claude-sonnet-4-5" },
	medium: { model: "anthropic/claude-sonnet-4-5" },
	low: { model: "anthropic/claude-haiku-4-5" },
};

describe("Usage report — tier label display", () => {
	test("shows only low 100% label when all decisions are low tier", () => {
		const debugHistory = Array.from({ length: 12 }, (_, i) => ({
			tier: "low" as const,
			profile: "default",
			targetProvider: "anthropic",
			targetModelId: "claude-haiku-4-5",
			targetLabel: "anthropic/claude-haiku-4-5",
			thinking: "fast" as const,
			reasoning: "test",
			usage: { cost: 0.001 },
		}));

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				debugHistory,
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
		const debugHistory = Array.from({ length: 8 }, (_, i) => ({
			tier: "high" as const,
			profile: "default",
			targetProvider: "anthropic",
			targetModelId: "claude-sonnet-4-5",
			targetLabel: "anthropic/claude-sonnet-4-5",
			thinking: "extended" as const,
			reasoning: "test",
			usage: { cost: 0.05 },
		}));

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				debugHistory,
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
		const debugHistory = [
			...Array.from({ length: 2 }, () => ({
				tier: "high" as const,
				profile: "default",
				targetProvider: "anthropic",
				targetModelId: "claude-sonnet-4-5",
				targetLabel: "anthropic/claude-sonnet-4-5",
				thinking: "extended" as const,
				reasoning: "test",
				usage: { cost: 0.05 },
			})),
			...Array.from({ length: 3 }, () => ({
				tier: "medium" as const,
				profile: "default",
				targetProvider: "anthropic",
				targetModelId: "claude-sonnet-4-5",
				targetLabel: "anthropic/claude-sonnet-4-5",
				thinking: "normal" as const,
				reasoning: "test",
				usage: { cost: 0.02 },
			})),
			...Array.from({ length: 5 }, () => ({
				tier: "low" as const,
				profile: "default",
				targetProvider: "anthropic",
				targetModelId: "claude-haiku-4-5",
				targetLabel: "anthropic/claude-haiku-4-5",
				thinking: "fast" as const,
				reasoning: "test",
				usage: { cost: 0.001 },
			})),
		];

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				debugHistory,
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
