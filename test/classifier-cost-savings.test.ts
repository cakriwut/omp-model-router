/**
 * Tests for:
 * 1. Classifier cost capture — tier="classifier" entries appear in modelCosts and
 *    are excluded from the orphan block, appearing in a dedicated classifier block.
 * 2. Savings simulator — reprice logic and rendered output.
 */

import { describe, test, expect } from "bun:test";
import { renderUsageReport } from "../src/ui";
import type { RouterConfig } from "../src/types";
import type { TierCounter, ModelCostEntry } from "../src/state";
import { stripAnsi } from "./_helpers/ansi";
import { makeTheme } from "./_helpers/theme";

const baseProfile: RouterConfig["profiles"][string] = {
	high:   { model: "anthropic/claude-opus-4-7" },
	medium: { model: "anthropic/claude-sonnet-4-5" },
	low:    { model: "anthropic/claude-haiku-3-5" },
};

const tierCounter: TierCounter = { high: 2, medium: 3, low: 1 };

function makeCostEntry(
	model: string,
	tier: string,
	opts: { cost?: number; invocations?: number; inputTokens?: number; outputTokens?: number } = {},
): ModelCostEntry {
	return {
		model,
		tier,
		invocations: opts.invocations ?? 2,
		inputTokens: opts.inputTokens ?? 1000,
		outputTokens: opts.outputTokens ?? 200,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: opts.cost ?? 0.01,
	};
}

// Registry with known cost rates: input=$3/M, output=$15/M for all models (for simplicity)
const mockRegistry = {
	find: (_provider: string, _modelId: string) => ({
		cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
	}),
};

// Registry that reports no cost rates (models without pricing)
const noCostRegistry = {
	find: () => ({ cost: null }),
};

// ─── Classifier block ────────────────────────────────────────────────────────

describe("Usage report — classifier cost block", () => {
	test("classifier entry appears in dedicated classifier block, not orphan block", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high", { cost: 0.12 })],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium", { cost: 0.04 })],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low", { cost: 0.01 })],
			["anthropic/claude-3-haiku-20240307", makeCostEntry("anthropic/claude-3-haiku-20240307", "classifier", { cost: 0.0008, invocations: 5 })],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: mockRegistry,
			calibration: {
				mode: "adaptive",
				totalComparisons: 5,
				llmCallsAttempted: 5,
				llmCallsFailed: 0,
				matrix: [[2,0,0],[0,2,0],[0,0,1]],
				classifierInvocations: 5,
				classifierCacheHits: 0,
			},
		}));

		// classifier block appears
		expect(report).toContain("classifier:");
		expect(report).toContain("claude-3-haiku-20240307");
		expect(report).toContain("$0.0008");

		// NOT in orphan block
		expect(report).not.toContain("removed from profile:");
	});

	test("classifier block shows cache hit annotation when cache hits > 0", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high")],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium")],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low")],
			["anthropic/claude-3-haiku-20240307", makeCostEntry("anthropic/claude-3-haiku-20240307", "classifier", { invocations: 4 })],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: mockRegistry,
			calibration: {
				mode: "adaptive",
				totalComparisons: 10,
				llmCallsAttempted: 4,
				llmCallsFailed: 0,
				matrix: [[3,0,0],[0,4,0],[0,0,3]],
				classifierInvocations: 4,
				classifierCacheHits: 6,
			},
		}));

		// shows total calls and cached count
		expect(report).toContain("10 calls");
		expect(report).toContain("6 cached");
	});

	test("classifier block appears even without cost entry when calibration reports calls", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high")],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium")],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low")],
			// no classifier entry — model has no cost rates or hasn't fired yet
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: noCostRegistry,
			calibration: {
				mode: "adaptive",
				totalComparisons: 3,
				llmCallsAttempted: 3,
				llmCallsFailed: 0,
				matrix: [[1,0,0],[0,1,0],[0,0,1]],
				classifierInvocations: 3,
				classifierCacheHits: 0,
			},
		}));

		expect(report).toContain("classifier:");
		expect(report).toContain("3 calls");
	});

	test("classifier block absent when no calibration and no classifier entries", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high")],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium")],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low")],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: mockRegistry,
			// no calibration
		}));

		expect(report).not.toContain("classifier:");
	});
});

// ─── Savings simulator ────────────────────────────────────────────────────────

describe("Usage report — savings simulator", () => {
	// Costs for a session where each model was actually used.
	// high: $3/M input, $15/M output. Per invocation: 1000 input + 200 output.
	// Actual cost per entry: 1000*(3/1M) + 200*(15/1M) = $0.003 + $0.003 = $0.006
	// 2 invocations × $0.006 = $0.012 per entry
	// 3 entries × $0.012 = $0.036 total
	// all-high = all-medium = all-low = $0.036 (same rates in mockRegistry)
	// router actual ≈ $0.036 → saving = 0%

	test("savings block appears when token data and cost rates available", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high", { inputTokens: 1000, outputTokens: 200 })],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium", { inputTokens: 1000, outputTokens: 200 })],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low", { inputTokens: 1000, outputTokens: 200 })],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: mockRegistry,
		}));

		expect(report).toContain("Savings vs all-high");
		expect(report).toContain("all-high");
		expect(report).toContain("all-medium");
		expect(report).toContain("all-low");
		expect(report).toContain("router");
		expect(report).toContain("←");
	});

	test("savings block absent when no token data", () => {
		// All zero tokens
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high", { inputTokens: 0, outputTokens: 0 })],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium", { inputTokens: 0, outputTokens: 0 })],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low", { inputTokens: 0, outputTokens: 0 })],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: mockRegistry,
		}));

		expect(report).not.toContain("Savings vs all-high");
	});

	test("savings block absent when registry has no cost rates", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high")],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium")],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low")],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: noCostRegistry,
		}));

		expect(report).not.toContain("Savings vs all-high");
	});

	test("classifier cost is excluded from router cost in savings line", () => {
		// Classifier adds $0.005 overhead. Router = actual - classifier.
		const classifierCost = 0.005;
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high", { cost: 0.03, inputTokens: 1000, outputTokens: 200 })],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium", { cost: 0.01, inputTokens: 1000, outputTokens: 200 })],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low", { cost: 0.005, inputTokens: 1000, outputTokens: 200 })],
			["anthropic/claude-3-haiku-20240307", makeCostEntry("anthropic/claude-3-haiku-20240307", "classifier", { cost: classifierCost, inputTokens: 0, outputTokens: 0 })],
		]);

		// accumulatedCost = sum of all entries including classifier
		const totalActual = 0.03 + 0.01 + 0.005 + classifierCost; // 0.05

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			accumulatedCost: totalActual,
			modelRegistry: mockRegistry,
			calibration: {
				mode: "adaptive",
				totalComparisons: 2,
				llmCallsAttempted: 2,
				llmCallsFailed: 0,
				matrix: [[1,0,0],[0,1,0],[0,0,0]],
				classifierInvocations: 2,
				classifierCacheHits: 0,
			},
		}));

		// router line should show totalActual - classifierCost = 0.045
		const routerLine = report.split("\n").find(l => l.includes("router") && l.includes("←"));
		expect(routerLine).toBeDefined();
		// 0.0450 formatted
		expect(routerLine).toContain("$0.0450");
	});

	test("savings percentage is relative to all-high baseline", () => {
		// Use different rates per tier to get meaningful percentages
		const differentRatesRegistry = {
			find: (_provider: string, modelId: string) => {
				if (modelId.includes("opus"))   return { cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 } };
				if (modelId.includes("sonnet")) return { cost: { input: 3.0,  output: 15.0,  cacheRead: 0.3, cacheWrite: 3.75  } };
				if (modelId.includes("haiku"))  return { cost: { input: 0.25, output: 1.25,  cacheRead: 0.025, cacheWrite: 0.3125 } };
				return { cost: null };
			},
		};

		// 1 invocation each: 10000 input + 500 output
		const inputT = 10_000, outputT = 500;
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   { model: "anthropic/claude-opus-4-7",   tier: "high",   invocations: 1, inputTokens: inputT, outputTokens: outputT, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.1875 }],
			["anthropic/claude-sonnet-4-5", { model: "anthropic/claude-sonnet-4-5", tier: "medium", invocations: 1, inputTokens: inputT, outputTokens: outputT, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.0375 }],
			["anthropic/claude-haiku-3-5",  { model: "anthropic/claude-haiku-3-5",  tier: "low",    invocations: 1, inputTokens: inputT, outputTokens: outputT, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.003125 }],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: differentRatesRegistry,
		}));

		// all-high = 3 * (10000*15/1M + 500*75/1M) = 3*(0.15+0.0375) = 3*0.1875 = $0.5625
		// all-medium = 3 * (10000*3/1M + 500*15/1M) = 3*(0.03+0.0075) = 3*0.0375 = $0.1125
		// savings medium vs high = 1 - 0.1125/0.5625 = 80%
		const lines = report.split("\n");
		const mediumLine = lines.find(l => l.includes("all-medium"));
		expect(mediumLine).toBeDefined();
		expect(mediumLine).toContain("−80%");

		// all-low = 3 * (10000*0.25/1M + 500*1.25/1M) = 3*(0.0025+0.000625) = 3*0.003125 = $0.009375
		// savings low vs high ≈ 98%
		const lowLine = lines.find(l => l.includes("all-low"));
		expect(lowLine).toBeDefined();
		expect(lowLine).toContain("−98%");
	});

	test("savings block renders savings section ordering: all-high, all-medium, all-low, router", () => {
		const modelCosts = new Map<string, ModelCostEntry>([
			["anthropic/claude-opus-4-7",   makeCostEntry("anthropic/claude-opus-4-7", "high")],
			["anthropic/claude-sonnet-4-5", makeCostEntry("anthropic/claude-sonnet-4-5", "medium")],
			["anthropic/claude-haiku-3-5",  makeCostEntry("anthropic/claude-haiku-3-5", "low")],
		]);

		const report = stripAnsi(renderUsageReport({
			theme: makeTheme(),
			selectedProfile: "default",
			profile: baseProfile,
			tierCounter,
			modelCosts,
			lastDecision: undefined,
			modelRegistry: mockRegistry,
		}));

		const lines = report.split("\n");
		const iHigh   = lines.findIndex(l => l.includes("all-high"));
		const iMedium = lines.findIndex(l => l.includes("all-medium"));
		const iLow    = lines.findIndex(l => l.includes("all-low"));
		const iRouter = lines.findIndex(l => l.includes("router") && l.includes("←"));

		expect(iHigh).toBeGreaterThan(-1);
		expect(iMedium).toBeGreaterThan(iHigh);
		expect(iLow).toBeGreaterThan(iMedium);
		expect(iRouter).toBeGreaterThan(iLow);
	});
});
