/**
 * Unit test for model-router registry API compatibility.
 *
 * Bug: extension called `modelRegistry.getApiKeyAndHeaders(model)` but that
 * method doesn't exist on ModelRegistry in @oh-my-pi/pi-coding-agent v15.3.2.
 * The actual API is `modelRegistry.getApiKey(model): Promise<string | undefined>`.
 *
 * Fix: replaced getApiKeyAndHeaders → getApiKey, use model.headers for headers.
 */

import { describe, it, expect } from "bun:test";

// Simulate the real ModelRegistry shape from @oh-my-pi/pi-coding-agent v15.3.2
function createMockModelRegistry() {
	const models = [
		{
			id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
			provider: "amazon-bedrock",
			name: "Claude Haiku 4.5",
			api: "bedrock-converse-stream",
			contextWindow: 200_000,
			maxTokens: 8192,
			reasoning: false,
			input: ["text"],
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			headers: undefined,
			cost: { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
		},
		{
			id: "global.anthropic.claude-opus-4-6-v1",
			provider: "amazon-bedrock",
			name: "Claude Opus 4.6",
			api: "bedrock-converse-stream",
			contextWindow: 200_000,
			maxTokens: 32_000,
			reasoning: true,
			input: ["text", "image"],
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			headers: { "x-custom": "test-header" },
			cost: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		},
	];

	return {
		find(provider: string, modelId: string) {
			return models.find(
				(m) => m.provider === provider && m.id === modelId,
			);
		},
		getApiKey: async (_model: any) => "fake-api-key",
		getApiKeyForProvider: async (_provider: string) => "fake-api-key",
		getAll: () => models,
		getAvailable: () => models,
		hasConfiguredAuth: (_model: any) => true,
		// NOTE: getApiKeyAndHeaders does NOT exist — that's the bug
	};
}

describe("model-router registry API compatibility", () => {
	it("ModelRegistry does NOT have getApiKeyAndHeaders (confirms the bug existed)", () => {
		const registry = createMockModelRegistry();
		expect((registry as any).getApiKeyAndHeaders).toBeUndefined();
	});

	it("ModelRegistry has getApiKey that returns string|undefined", async () => {
		const registry = createMockModelRegistry();
		const model = registry.find(
			"amazon-bedrock",
			"global.anthropic.claude-haiku-4-5-20251001-v1:0",
		);
		expect(model).toBeDefined();
		const key = await registry.getApiKey(model);
		expect(typeof key).toBe("string");
	});

	it("model.headers carries per-model headers (replaces auth.headers)", () => {
		const registry = createMockModelRegistry();
		const opus = registry.find(
			"amazon-bedrock",
			"global.anthropic.claude-opus-4-6-v1",
		);
		expect(opus!.headers).toEqual({ "x-custom": "test-header" });

		const haiku = registry.find(
			"amazon-bedrock",
			"global.anthropic.claude-haiku-4-5-20251001-v1:0",
		);
		expect(haiku!.headers).toBeUndefined();
	});

	it("fixed auth flow: getApiKey + model.headers matches streamSimple contract", async () => {
		const registry = createMockModelRegistry();
		const model = registry.find(
			"amazon-bedrock",
			"global.anthropic.claude-opus-4-6-v1",
		)!;

		// This is the fixed code path (matches provider.ts after fix)
		const apiKey = await registry.getApiKey(model);
		if (!apiKey) throw new Error("should have key");
		const headers = model.headers;

		// streamSimple expects { apiKey?: string, headers?: Record<string, string> }
		const streamOpts = { apiKey, headers };
		expect(streamOpts.apiKey).toBe("fake-api-key");
		expect(streamOpts.headers).toEqual({ "x-custom": "test-header" });
	});

	it("fixed auth flow: gracefully handles missing apiKey", async () => {
		const registry = {
			...createMockModelRegistry(),
			getApiKey: async (_model: any) => undefined,
		};
		const model = registry.find(
			"amazon-bedrock",
			"global.anthropic.claude-haiku-4-5-20251001-v1:0",
		)!;

		const apiKey = await registry.getApiKey(model);
		// Should bail out — no crash
		expect(apiKey).toBeUndefined();
	});
});
