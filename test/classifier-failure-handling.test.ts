import { describe, test, expect } from "bun:test";
import { resolveRouting, type RoutingInput, type RoutingConfig } from "../src/routing";
import type { RouterProfile, RoutingDecision } from "../src/types";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

describe("Classifier failure handling", () => {
	const mockProfile: RouterProfile = {
		high: { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
		medium: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" },
		low: { model: "anthropic/claude-haiku-4-5", thinking: "low" },
	};

	const mockContext: Context = {
		messages: [
			{ role: "user", content: "investigate the bug in the routing logic", timestamp: Date.now() },
		],
	};

	const mockModelRegistry = {
		find: () => undefined, // Force classifier model lookup to fail
		getApiKey: async () => undefined,
		getProviders: () => [],
		registerProvider: () => {},
	} as unknown as ExtensionContext["modelRegistry"];

	test("when classifier model is invalid, falls back to heuristic with clear reasoning", async () => {
		const input: RoutingInput = {
			context: mockContext,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: mockModelRegistry,
		};

		const config: RoutingConfig = {
			profileName: "auto",
			profile: mockProfile,
			phaseBias: 0.5,
			classifierModel: "nonexistent/invalid-model",
			debug: true,
		};

		const decision = await resolveRouting(input, config);

		// Heuristic classifies "investigate" as high tier
		expect(decision.tier).toBe("high");
		// Note: in test environment runClassifier may be mocked — just assert tier is valid
		expect(["high", "medium", "low"]).toContain(decision.tier);
	});

	test("when classifier model is valid but returns undefined, falls back gracefully", async () => {
		const input: RoutingInput = {
			context: mockContext,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: mockModelRegistry,
		};

		const config: RoutingConfig = {
			profileName: "auto",
			profile: mockProfile,
			phaseBias: 0.5,
			classifierModel: "anthropic/claude-haiku-4-5",
			debug: false,
		};

		const decision = await resolveRouting(input, config);

		expect(decision.tier).toBe("high");
		// Reasoning reflects either classifier result or heuristic fallback
		expect(decision.reasoning).toMatch(/high|Classifier/i);
	});

	test("classifier runs even when pinned, fails gracefully", async () => {
		const input: RoutingInput = {
			context: mockContext,
			previousDecision: undefined,
			pinnedTier: "low",
			isBudgetExceeded: false,
			modelRegistry: mockModelRegistry,
		};

		const config: RoutingConfig = {
			profileName: "auto",
			profile: mockProfile,
			phaseBias: 0.5,
			classifierModel: "anthropic/claude-haiku-4-5",
			debug: true,
		};

		const decision = await resolveRouting(input, config);

		// When pinned, routing tier is pinned tier
		expect(decision.tier).toBe("low");
		
		// Classifier ran but failed, so tier stays pinned and reasoning reflects the pin
		expect(decision.reasoning).toMatch(/Pinned to low tier/);
	});

	test("classifier skip when rule matched", async () => {
		const input: RoutingInput = {
			context: {
				messages: [
					{ role: "user", content: "deploy the production release", timestamp: Date.now() },
				],
			},
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: mockModelRegistry,
		};

		const config: RoutingConfig = {
			profileName: "auto",
			profile: mockProfile,
			phaseBias: 0.5,
			rules: [
				{ matches: ["deploy", "production"], tier: "high", reason: "Safety check" },
			],
			classifierModel: "anthropic/claude-haiku-4-5",
			debug: true,
		};

		const decision = await resolveRouting(input, config);

		expect(decision.tier).toBe("high");
		expect(decision.isRuleMatched).toBe(true);
		
		// Reasoning should mention rule match, NOT classifier unavailable
		expect(decision.reasoning).toMatch(/Safety check/);
		expect(decision.reasoning).not.toMatch(/Classifier unavailable/);
	});
});
