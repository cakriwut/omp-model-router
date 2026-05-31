import { describe, test, expect } from "bun:test";
import { renderUsageReport } from "../src/ui";
import type { RouterConfig } from "../src/types";
import type { UsageLedgerEntry } from "../src/state";

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

function makeLedgerEntry(tier: "high" | "medium" | "low", model: string, cost: number): UsageLedgerEntry {
	return {
		timestamp: Date.now(),
		profile: "default",
		tier,
		model,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost,
	};
}

describe("Usage report — tier label display", () => {
	test("shows only low 100% label when all decisions are low tier", () => {
		const usageLedger = Array.from({ length: 12 }, () =>
			makeLedgerEntry("low", "anthropic/claude-haiku-4-5", 0.001)
		);

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				usageLedger,
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
		const usageLedger = Array.from({ length: 8 }, () =>
			makeLedgerEntry("high", "anthropic/claude-sonnet-4-5", 0.05)
		);

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				usageLedger,
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
		const usageLedger = [
			...Array.from({ length: 2 }, () => makeLedgerEntry("high", "anthropic/claude-sonnet-4-5", 0.05)),
			...Array.from({ length: 3 }, () => makeLedgerEntry("medium", "anthropic/claude-sonnet-4-5", 0.02)),
			...Array.from({ length: 5 }, () => makeLedgerEntry("low", "anthropic/claude-haiku-4-5", 0.001)),
		];

		const report = stripAnsi(
			renderUsageReport({
				theme: makeTheme(),
				selectedProfile: "default",
				profile: baseProfile,
				usageLedger,
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
