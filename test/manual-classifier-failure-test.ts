#!/usr/bin/env bun
/**
 * Manual test: Verify classifier failure is surfaced in decision reasoning
 * 
 * Before fix: routing falls back to heuristic silently
 * After fix: decision reasoning shows "Classifier unavailable, using heuristic: ..."
 */

import { resolveRouting, type RoutingInput, type RoutingConfig } from "../src/routing";
import type { RouterProfile } from "../src/types";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const mockProfile: RouterProfile = {
	high: { model: "amazon-bedrock/global.anthropic.claude-opus-4-7", thinking: "high" },
	medium: { model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6", thinking: "medium" },
	low: { model: "amazon-bedrock/global.anthropic.claude-haiku-4-5", thinking: "low" },
};

// Mock registry that simulates classifier model failure
const failingModelRegistry = {
	find: (provider: string, modelId: string) => {
		if (modelId.includes("nova-micro")) {
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

const testPrompts = [
	"investigate why the router ignores LLM decisions in adaptive mode",
	"deploy the production release",
	"summarize the last 5 commits",
];

console.log("🧪 Testing classifier failure handling in adaptive mode\n");
console.log("═".repeat(80));

for (const prompt of testPrompts) {
	console.log(`\n📝 Prompt: "${prompt}"`);
	
	const context: Context = {
		messages: [
			{ role: "user", content: prompt, timestamp: Date.now() },
		],
	};

	const input: RoutingInput = {
		context,
		previousDecision: undefined,
		isBudgetExceeded: false,
		modelRegistry: failingModelRegistry,
	};

	const config: RoutingConfig = {
		profileName: "auto",
		profile: mockProfile,
		phaseBias: 0.5,
		classifierModel: "amazon-bedrock/us.amazon.nova-micro-v1:0", // This will fail
		debug: true, // Enable debug logging
	};

	const decision = await resolveRouting(input, config);

	console.log(`   🎯 Tier: ${decision.tier}`);
	console.log(`   💭 Reasoning: ${decision.reasoning}`);
	console.log(`   🤖 isClassifier: ${decision.isClassifier ?? false}`);
	
	const hasMarker = decision.reasoning.includes("Classifier unavailable, using heuristic:");
	console.log(`   ✅ Failure marker present: ${hasMarker ? "YES" : "NO"}`);
	
	if (!hasMarker) {
		console.log("   ❌ FAIL: Expected 'Classifier unavailable' marker in reasoning");
		process.exit(1);
	}
}

console.log("\n" + "═".repeat(80));
console.log("✅ All tests passed! Classifier failure is correctly surfaced.\n");
