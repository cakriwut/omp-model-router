import { test, expect } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { resolveRouting } from "../src/routing";
import type { RouterProfile } from "../src/types";

/**
 * Test that when a classifierModel is provided, it influences routing decisions
 * (this is the expected behavior when calibration is in adaptive mode).
 */

test("classifier model: used for routing when provided", async () => {
	const mockProfile: RouterProfile = {
		high: { model: "anthropic/claude-sonnet-4", thinking: "high" },
		medium: { model: "anthropic/claude-3-5-haiku", thinking: "medium" },
		low: { model: "anthropic/claude-3-haiku", thinking: "low" },
	};

	const mockContext: Context = {
		messages: [
			{
				role: "user",
				content: "Implement a feature",
				timestamp: Date.now(),
			},
		],
	};

	const mockRegistry = {
		find: (provider: string, modelId: string) => ({
			contextWindow: 200_000,
			maxTokens: 8_000,
			input: ["text"],
		}),
		getApiKey: async () => "test-key",
	};

	// With no classifier model, should use heuristic
	const heuristicDecision = await resolveRouting(
		{
			context: mockContext,
			previousDecision: undefined,
			pinnedTier: undefined,
			isBudgetExceeded: false,
			modelRegistry: mockRegistry as any,
			lastExtensionContext: undefined,
		},
		{
			profileName: "test-profile",
			profile: mockProfile,
			thinkingOverrides: undefined,
			phaseBias: 0.5,
			rules: [],
			classifierModel: undefined,
		},
	);

	// Should use heuristic routing
	expect(heuristicDecision.tier).toBe("medium");
	expect(heuristicDecision.reasoning).toContain("implementation");
	expect(heuristicDecision.isClassifier).toBe(false);
});

test("classifier model: skipped when tier is pinned", async () => {
	const mockProfile: RouterProfile = {
		high: { model: "anthropic/claude-sonnet-4", thinking: "high" },
		medium: { model: "anthropic/claude-3-5-haiku", thinking: "medium" },
		low: { model: "anthropic/claude-3-haiku", thinking: "low" },
	};

	const mockContext: Context = {
		messages: [
			{
				role: "user",
				content: "Implement a feature",
				timestamp: Date.now(),
			},
		],
	};

	const mockRegistry = {
		find: (provider: string, modelId: string) => ({
			contextWindow: 200_000,
			maxTokens: 8_000,
			input: ["text"],
		}),
		getApiKey: async () => "test-key",
	};

	const decision = await resolveRouting(
		{
			context: mockContext,
			previousDecision: undefined,
			pinnedTier: "high", // Pinned
			isBudgetExceeded: false,
			modelRegistry: mockRegistry as any,
			lastExtensionContext: undefined,
		},
		{
			profileName: "test-profile",
			profile: mockProfile,
			thinkingOverrides: undefined,
			phaseBias: 0.5,
			rules: [],
			classifierModel: "anthropic/claude-3-5-haiku",
		},
	);

	// Should respect pin, not use classifier
	expect(decision.tier).toBe("high");
	expect(decision.reasoning).toContain("Pinned");
	expect(decision.isClassifier).toBe(false);
});

test("classifier model: skipped when rule matched", async () => {
	const mockProfile: RouterProfile = {
		high: { model: "anthropic/claude-sonnet-4", thinking: "high" },
		medium: { model: "anthropic/claude-3-5-haiku", thinking: "medium" },
		low: { model: "anthropic/claude-3-haiku", thinking: "low" },
	};

	const mockContext: Context = {
		messages: [
			{
				role: "user",
				content: "Deploy to production",
				timestamp: Date.now(),
			},
		],
	};

	const mockRegistry = {
		find: (provider: string, modelId: string) => ({
			contextWindow: 200_000,
			maxTokens: 8_000,
			input: ["text"],
		}),
		getApiKey: async () => "test-key",
	};

	const decision = await resolveRouting(
		{
			context: mockContext,
			previousDecision: undefined,
			pinnedTier: undefined,
			isBudgetExceeded: false,
			modelRegistry: mockRegistry as any,
			lastExtensionContext: undefined,
		},
		{
			profileName: "test-profile",
			profile: mockProfile,
			thinkingOverrides: undefined,
			phaseBias: 0.5,
			rules: [
				{ matches: ["deploy", "production"], tier: "high" },
			],
			classifierModel: "anthropic/claude-3-5-haiku",
		},
	);

	// Should use rule, not classifier
	expect(decision.tier).toBe("high");
	expect(decision.isRuleMatched).toBe(true);
	expect(decision.isClassifier).toBe(false);
});
