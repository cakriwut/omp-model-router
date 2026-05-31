import { describe, test, expect, beforeEach } from "bun:test";
import { resolveRouting, type RoutingInput, type RoutingConfig } from "../src/routing";
import type { RouterProfile } from "../src/types";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

describe("Adaptive mode classifier integration", () => {
	const mockProfile: RouterProfile = {
		high: { model: "anthropic/claude-opus-4-7", thinking: "high" },
		medium: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" },
		low: { model: "anthropic/claude-haiku-4-5", thinking: "low" },
	};

	// Simulate classifier model registry that fails intermittently
	const createFailingModelRegistry = (failureRate = 1.0) => {
		let callCount = 0;
		return {
			find: (provider: string, modelId: string) => {
				callCount++;
				if (Math.random() < failureRate) {
					return undefined; // Simulate model not found
				}
				return {
					id: modelId,
					provider,
					contextWindow: 200000,
					cost: { input: 0.001, output: 0.003 },
					input: ["text"],
					output: ["text"],
				};
			},
			getApiKey: async () => "mock-key",
			getProviders: () => [],
			registerProvider: () => {},
		} as unknown as ExtensionContext["modelRegistry"];
	};

	test("adaptive mode: classifier failure should be visible in reasoning", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "investigate model router adaptive mode issue", timestamp: Date.now() },
			],
		};

		const input: RoutingInput = {
			context,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: createFailingModelRegistry(1.0), // Always fail
		};

		const config: RoutingConfig = {
			profileName: "auto",
			profile: mockProfile,
			phaseBias: 0.5,
			classifierModel: "amazon-bedrock/us.amazon.nova-micro-v1:0",
			debug: true,
		};

		const decision = await resolveRouting(input, config);

		// Should use heuristic decision
		expect(decision.tier).toBe("high");
		
		// Reasoning MUST indicate classifier was attempted but failed
		expect(decision.reasoning).toMatch(/Classifier unavailable, using heuristic:/);
		expect(decision.reasoning).toMatch(/planning|investigat/i);
		
		// isClassifier flag should be false
		expect(decision.isClassifier).toBeFalsy();
	});

	test("adaptive mode: when classifier is skipped (pinned), reasoning should NOT mention classifier", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "investigate model router adaptive mode issue", timestamp: Date.now() },
			],
		};

		const input: RoutingInput = {
			context,
			previousDecision: undefined,
			pinnedTier: "medium",
			isBudgetExceeded: false,
			modelRegistry: createFailingModelRegistry(1.0),
		};

		const config: RoutingConfig = {
			profileName: "auto",
			profile: mockProfile,
			phaseBias: 0.5,
			classifierModel: "amazon-bedrock/us.amazon.nova-micro-v1:0",
			debug: true,
		};

		const decision = await resolveRouting(input, config);

		expect(decision.tier).toBe("medium");
		expect(decision.reasoning).toMatch(/Pinned to medium tier/);
		expect(decision.reasoning).not.toMatch(/Classifier unavailable/);
	});

	test("adaptive mode: rule-matched decisions should NOT attempt classifier", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "deploy the migration to production", timestamp: Date.now() },
			],
		};

		const input: RoutingInput = {
			context,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: createFailingModelRegistry(1.0),
		};

		const config: RoutingConfig = {
			profileName: "auto",
			profile: mockProfile,
			phaseBias: 0.5,
			rules: [
				{
					matches: ["deploy", "production", "migration"],
					tier: "high",
					reason: "Safety-critical operations require deep reasoning",
				},
			],
			classifierModel: "amazon-bedrock/us.amazon.nova-micro-v1:0",
			debug: true,
		};

		const decision = await resolveRouting(input, config);

		expect(decision.tier).toBe("high");
		expect(decision.isRuleMatched).toBe(true);
		expect(decision.reasoning).toMatch(/Safety-critical operations/);
		expect(decision.reasoning).not.toMatch(/Classifier unavailable/);
	});

	test("heuristic keywords should be respected when classifier fails", async () => {
		const testCases = [
			{
				prompt: "why does the router ignore LLM decisions?",
				expectedTier: "high",
				expectedReason: /planning|investigat/i,
			},
			{
				prompt: "summarize the changes in the last commit",
				expectedTier: "low",
				expectedReason: /summary|lightweight/i,
			},
			{
				prompt: "implement the user authentication flow",
				expectedTier: "medium",
				expectedReason: /implementation/i,
			},
		];

		for (const testCase of testCases) {
			const context: Context = {
				messages: [
					{ role: "user", content: testCase.prompt, timestamp: Date.now() },
				],
			};

			const input: RoutingInput = {
				context,
				previousDecision: undefined,
				isBudgetExceeded: false,
				modelRegistry: createFailingModelRegistry(1.0),
			};

			const config: RoutingConfig = {
				profileName: "auto",
				profile: mockProfile,
				phaseBias: 0.5,
				classifierModel: "amazon-bedrock/us.amazon.nova-micro-v1:0",
				debug: false,
			};

			const decision = await resolveRouting(input, config);

			expect(decision.tier).toBe(testCase.expectedTier);
			expect(decision.reasoning).toMatch(/Classifier unavailable, using heuristic:/);
			expect(decision.reasoning).toMatch(testCase.expectedReason);
		}
	});
});
