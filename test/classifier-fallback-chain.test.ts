/**
 * Unit tests for classifier fallback chain.
 *
 * Tests the config parser + runClassifier path for classifierModel arrays.
 * Bypasses loadRouterConfig (which reads from ~/.omp) and exercises
 * parseConfigFile + normalizeConfig directly with synthetic input.
 */

import { describe, it, expect } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigFile, normalizeConfig } from "../src/config";
import { runClassifier } from "../src/routing";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Context } from "@oh-my-pi/pi-ai";
import type { RouterConfig } from "../src/types";

// ─── Config parsing tests ────────────────────────────────────────────────────

const writeAndParse = (content: object): { config: RouterConfig; warnings: string[] } => {
	const dir = mkdtempSync(join(tmpdir(), "classifier-fallback-"));
	const path = join(dir, "model-router.json");
	writeFileSync(path, JSON.stringify(content, null, 2));
	try {
		const parsed = parseConfigFile(path);
		const normalized = normalizeConfig(parsed.config as RouterConfig);
		return {
			config: normalized.config,
			warnings: [...parsed.warnings, ...normalized.warnings],
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("Classifier fallback — config parsing", () => {
	it("preserves single-string classifierModel (backward compat)", () => {
		const { config } = writeAndParse({
			defaultProfile: "auto",
			calibration: {
				enabled: true,
				mode: "adaptive",
				classifierModel: "anthropic/claude-3-haiku-20240307",
			},
		});
		expect(config.calibration?.classifierModel).toBe(
			"anthropic/claude-3-haiku-20240307",
		);
	});

	it("preserves array classifierModel as a fallback chain", () => {
		const { config } = writeAndParse({
			defaultProfile: "auto",
			calibration: {
				enabled: true,
				mode: "adaptive",
				classifierModel: [
					"anthropic/claude-3-haiku-20240307",
					"openai/gpt-4.1-nano",
					"amazon-bedrock/amazon.nova-micro-v1:0",
				],
			},
		});
		expect(Array.isArray(config.calibration?.classifierModel)).toBe(true);
		expect(config.calibration?.classifierModel).toEqual([
			"anthropic/claude-3-haiku-20240307",
			"openai/gpt-4.1-nano",
			"amazon-bedrock/amazon.nova-micro-v1:0",
		]);
	});

	it("filters out invalid entries from array, warns about each", () => {
		const { config, warnings } = writeAndParse({
			defaultProfile: "auto",
			calibration: {
				enabled: true,
				mode: "adaptive",
				classifierModel: [
					"anthropic/claude-3-haiku-20240307",
					"this-is-not-a-canonical-ref",
					"openai/gpt-4.1-nano",
				],
			},
		});
		expect(config.calibration?.classifierModel).toEqual([
			"anthropic/claude-3-haiku-20240307",
			"openai/gpt-4.1-nano",
		]);
		expect(warnings.some((w) => w.includes("this-is-not-a-canonical-ref"))).toBe(
			true,
		);
	});

	it("drops classifierModel entirely when array is empty after filtering", () => {
		const { config } = writeAndParse({
			defaultProfile: "auto",
			calibration: {
				enabled: true,
				mode: "adaptive",
				classifierModel: ["bad-ref-1", "bad-ref-2"],
			},
		});
		expect(config.calibration?.classifierModel).toBeUndefined();
	});
});

// ─── runClassifier fallback tests ────────────────────────────────────────────

const fakeContext = (): Context => ({
	messages: [
		{
			role: "user",
			content: "Implement Redis caching for the API layer",
			timestamp: Date.now(),
		},
	],
});

const makeRegistry = (
	available: Record<string, { hasKey: boolean }>,
): ExtensionContext["modelRegistry"] => {
	const reg = {
		find: (provider: string, modelId: string) => {
			const key = `${provider}/${modelId}`;
			if (!(key in available)) return null;
			return {
				provider,
				id: modelId,
				name: key,
				input: ["text"],
				contextWindow: 200_000,
				maxTokens: 8_000,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				headers: {},
			};
		},
		getApiKey: async (model: { provider: string; id: string }) => {
			const key = `${model.provider}/${model.id}`;
			return available[key]?.hasKey ? "mock-api-key" : undefined;
		},
		getAll: () => [],
		getAvailable: () => [],
		hasConfiguredAuth: () => true,
	};
	return reg as unknown as ExtensionContext["modelRegistry"];
};

describe("runClassifier — fallback chain", () => {
	it("accepts a single string (backward compat) — no models in registry returns undefined", async () => {
		const registry = makeRegistry({});
		const result = await runClassifier(
			"anthropic/claude-3-haiku-20240307",
			registry,
			fakeContext(),
		);
		expect(result).toBeUndefined();
	});

	it("accepts an array — all missing returns undefined (heuristic fallback)", async () => {
		const registry = makeRegistry({});
		const result = await runClassifier(
			[
				"anthropic/claude-3-haiku-20240307",
				"openai/gpt-4.1-nano",
				"amazon-bedrock/amazon.nova-micro-v1:0",
			],
			registry,
			fakeContext(),
		);
		expect(result).toBeUndefined();
	});

	it("loops through chain when models lack registry entry or API key", async () => {
		// Only the third model is in the registry, but it has no API key
		const registry = makeRegistry({
			"openai/gpt-4.1-nano": { hasKey: false },
		});
		const result = await runClassifier(
			[
				"anthropic/claude-3-haiku-20240307", // not in registry
				"amazon-bedrock/amazon.nova-micro-v1:0", // not in registry
				"openai/gpt-4.1-nano", // in registry but no API key
			],
			registry,
			fakeContext(),
		);
		expect(result).toBeUndefined();
	});

	it("empty array returns undefined (heuristic fallback)", async () => {
		const registry = makeRegistry({});
		const result = await runClassifier([], registry, fakeContext());
		expect(result).toBeUndefined();
	});
});
