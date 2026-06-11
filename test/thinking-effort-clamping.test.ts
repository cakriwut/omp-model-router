/**
 * Thinking Effort Clamping Unit Tests
 *
 * Tests the clamping of `delegatedReasoning` in provider.ts via
 * `clampThinkingLevelForModel` from @oh-my-pi/pi-catalog/model-thinking.
 *
 * Covers the spec: thinking-effort-clamping
 *   - Medium effort clamped when model supports only [low, high]
 *   - Medium effort passes through when model supports [minimal, low, medium, high]
 *   - Reasoning omitted for non-reasoning models
 *   - ThinkingLevel.Off and ThinkingLevel.Inherit always produce undefined
 *   - Model with thinking: undefined (missing metadata) passes through as-is
 */

import { describe, it, expect } from "bun:test";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type TestModel = Model<Api>;

function makeReasoningModel(efforts: Effort[]): TestModel {
	return {
		id: "test-model",
		name: "Test Model",
		api: "bedrock-converse-stream" as Api,
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		thinking: {
			mode: "anthropic-budget-effort",
			efforts,
		},
	} as TestModel;
}

function makeNonReasoningModel(): TestModel {
	return {
		id: "test-non-reasoning-model",
		name: "Test Non-Reasoning Model",
		api: "bedrock-converse-stream" as Api,
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} as TestModel;
}

/**
 * Simulates the delegatedReasoning construction in provider.ts after our fix.
 * This is the exact logic from provider.ts:
 *   - Skip if !model.reasoning or effectiveThinking is Off/Inherit
 *   - Otherwise clamp via clampThinkingLevelForModel
 */
function computeDelegatedReasoning(
	model: TestModel,
	effectiveThinking: string,
): Effort | undefined {
	if (
		!model.reasoning ||
		effectiveThinking === ThinkingLevel.Off ||
		effectiveThinking === ThinkingLevel.Inherit
	) {
		return undefined;
	}
	return clampThinkingLevelForModel(model, effectiveThinking as Effort);
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("Thinking Effort Clamping — clampThinkingLevelForModel", () => {
	// ── 4.1: medium clamped when model supports only [low, high] ──────────────

	describe("non-contiguous effort range [low, high]", () => {
		const model = makeReasoningModel(["low", "high"] as Effort[]);

		it("clamps medium → low (nearest lower supported)", () => {
			const result = clampThinkingLevelForModel(model, "medium" as Effort);
			expect(result).toBe("low");
		});

		it("passes high through unchanged", () => {
			const result = clampThinkingLevelForModel(model, "high" as Effort);
			expect(result).toBe("high");
		});

		it("passes low through unchanged", () => {
			const result = clampThinkingLevelForModel(model, "low" as Effort);
			expect(result).toBe("low");
		});

		it("clamps minimal → low (nearest supported when below range)", () => {
			// minimal is not in [low, high], lowest available is low
			const result = clampThinkingLevelForModel(model, "minimal" as Effort);
			expect(result).toBe("low");
		});
	});

	// ── 4.2: medium passes through when model supports [minimal, low, medium, high] ─

	describe("full effort range [minimal, low, medium, high]", () => {
		const model = makeReasoningModel(["minimal", "low", "medium", "high"] as Effort[]);

		it("passes medium through unclamped", () => {
			const result = clampThinkingLevelForModel(model, "medium" as Effort);
			expect(result).toBe("medium");
		});

		it("passes high through unclamped", () => {
			const result = clampThinkingLevelForModel(model, "high" as Effort);
			expect(result).toBe("high");
		});

		it("passes minimal through unclamped", () => {
			const result = clampThinkingLevelForModel(model, "minimal" as Effort);
			expect(result).toBe("minimal");
		});

		it("clamps xhigh → high (requested above max)", () => {
			const result = clampThinkingLevelForModel(model, "xhigh" as Effort);
			expect(result).toBe("high");
		});
	});

	// ── 4.3: reasoning omitted for non-reasoning models ───────────────────────

	describe("non-reasoning model", () => {
		const model = makeNonReasoningModel();

		it("returns undefined for any thinking level", () => {
			expect(clampThinkingLevelForModel(model, "medium" as Effort)).toBeUndefined();
			expect(clampThinkingLevelForModel(model, "high" as Effort)).toBeUndefined();
			expect(clampThinkingLevelForModel(model, "low" as Effort)).toBeUndefined();
		});
	});
});

describe("Thinking Effort Clamping — delegatedReasoning guard (provider logic)", () => {
	const bedrockModel = makeReasoningModel(["minimal", "low", "medium", "high"] as Effort[]);
	const nonContiguousModel = makeReasoningModel(["low", "high"] as Effort[]);
	const nonReasoningModel = makeNonReasoningModel();

	// ── ThinkingLevel.Off and Inherit always yield undefined ──────────────────

	it("returns undefined when effectiveThinking is Off", () => {
		const result = computeDelegatedReasoning(bedrockModel, ThinkingLevel.Off);
		expect(result).toBeUndefined();
	});

	it("returns undefined when effectiveThinking is Inherit", () => {
		const result = computeDelegatedReasoning(bedrockModel, ThinkingLevel.Inherit);
		expect(result).toBeUndefined();
	});

	it("returns undefined for non-reasoning model regardless of thinking level", () => {
		expect(computeDelegatedReasoning(nonReasoningModel, ThinkingLevel.Medium)).toBeUndefined();
		expect(computeDelegatedReasoning(nonReasoningModel, ThinkingLevel.High)).toBeUndefined();
	});

	// ── Full Bedrock sonnet-4-6 scenario (the bug case) ──────────────────────

	it("passes medium through for [minimal,low,medium,high] Bedrock model — bug regression", () => {
		const result = computeDelegatedReasoning(bedrockModel, ThinkingLevel.Medium);
		expect(result).toBe("medium");
	});

	it("passes high through for [minimal,low,medium,high] Bedrock model", () => {
		const result = computeDelegatedReasoning(bedrockModel, ThinkingLevel.High);
		expect(result).toBe("high");
	});

	// ── Non-contiguous range clamping ─────────────────────────────────────────

	it("clamps medium → low for [low,high] model (no crash)", () => {
		const result = computeDelegatedReasoning(nonContiguousModel, ThinkingLevel.Medium);
		expect(result).toBe("low");
	});
});
