/**
 * Unit tests for resolveRouting — the composition layer that applies overrides
 * on top of the heuristic decideRouting result.
 *
 * Each test mocks a specific override path (context trigger, classifier,
 * image upgrade, budget downgrade) in isolation.
 */

import { describe, it, expect, mock } from "bun:test";
import { resolveRouting } from "../src/routing";
import type { RoutingInput, RoutingConfig } from "../src/routing";
import type { RouterProfile, RoutingDecision } from "../src/types";
import type { Context } from "@oh-my-pi/pi-ai";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeContext = (text: string): Context => ({
	messages: [{ role: "user", content: text, timestamp: Date.now() }],
	systemPrompt: [],
});

const TEXT_PROFILE: RouterProfile = {
	high: { model: "test/high-model", thinking: "high" },
	medium: { model: "test/medium-model", thinking: "medium" },
	low: { model: "test/low-model", thinking: "low" },
};

const IMAGE_PROFILE: RouterProfile = {
	high: { model: "test/image-model", thinking: "high" },
	medium: { model: "test/no-image-model", thinking: "medium" },
	low: { model: "test/no-image-model-low", thinking: "low" },
};

const makeModelRegistry = (
	caps: Record<string, { reasoning?: boolean; input?: string[] }> = {},
) => ({
	find: (provider: string, modelId: string) => {
		const key = `${provider}/${modelId}`;
		const entry = caps[key];
		if (!entry) return undefined;
		return { provider, id: modelId, ...entry };
	},
	getApiKey: async (_model: unknown) => "test-api-key",
});

const baseInput = (
	context: Context,
	overrides: Partial<RoutingInput> = {},
): RoutingInput => ({
	context,
	previousDecision: undefined,
	isBudgetExceeded: false,
	modelRegistry: makeModelRegistry() as unknown as RoutingInput["modelRegistry"],
	...overrides,
});

const baseConfig = (overrides: Partial<RoutingConfig> = {}): RoutingConfig => ({
	profileName: "auto",
	profile: TEXT_PROFILE,
	phaseBias: 0.5,
	...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolveRouting — heuristic decision alone", () => {
	it("returns medium tier for generic implementation request", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("fix this bug in the auth code")),
			baseConfig(),
		);
		expect(d.tier).toBe("medium");
		expect(d.targetModelId).toBe("medium-model");
	});

	it("returns high tier for planning keywords", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("design the architecture for this system")),
			baseConfig(),
		);
		expect(d.tier).toBe("high");
	});

	it("returns low tier for summary keywords", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("summarize the changes in this PR")),
			baseConfig(),
		);
		expect(d.tier).toBe("low");
	});

	it("respects pinned tier", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("design the full system architecture"), {
				pinnedTier: "low",
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("low");
		expect(d.reasoning).toContain("Pinned");
	});
});

describe("resolveRouting — context trigger upgrade", () => {
	// Registry where each tier has a known contextWindow + maxTokens.
	// Usable capacity = contextWindow - max(maxTokens, 8192).
	// low:    50k - 8k  = 42k
	// medium: 100k - 8k = 92k
	// high:   500k - 8k = 492k
	const capacityRegistry = makeModelRegistry({
		"test/low-model": { contextWindow: 50_000, maxTokens: 4096 },
		"test/medium-model": { contextWindow: 100_000, maxTokens: 4096 },
		"test/high-model": { contextWindow: 500_000, maxTokens: 4096 },
	}) as unknown as RoutingInput["modelRegistry"];

	it("promotes low→medium when context exceeds low model capacity but fits medium", async () => {
		const mockCtx = { getContextUsage: async () => ({ tokens: 80_000 }) };
		const d = await resolveRouting(
			baseInput(makeContext("summarize the changes in this PR"), {
				lastExtensionContext: mockCtx as any,
				modelRegistry: capacityRegistry,
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("medium");
		expect(d.isContextTriggered).toBe(true);
		expect(d.reasoning).toContain("Promoted low→medium");
	});

	it("promotes medium→high when context exceeds medium model capacity", async () => {
		const mockCtx = { getContextUsage: async () => ({ tokens: 200_000 }) };
		const d = await resolveRouting(
			baseInput(makeContext("fix this bug"), {
				lastExtensionContext: mockCtx as any,
				modelRegistry: capacityRegistry,
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("high");
		expect(d.isContextTriggered).toBe(true);
	});

	it("does not promote when current tier model has capacity", async () => {
		const mockCtx = { getContextUsage: async () => ({ tokens: 30_000 }) };
		const d = await resolveRouting(
			baseInput(makeContext("fix this bug"), {
				lastExtensionContext: mockCtx as any,
				modelRegistry: capacityRegistry,
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("medium");
		expect(d.isContextTriggered).toBeUndefined();
	});

	it("skips capacity check when already on high tier", async () => {
		const mockCtx = { getContextUsage: async () => ({ tokens: 999_999 }) };
		const d = await resolveRouting(
			baseInput(makeContext("design the complete architecture for the whole system now"), {
				lastExtensionContext: mockCtx as any,
				modelRegistry: capacityRegistry,
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("high");
		expect(d.isContextTriggered).toBeUndefined();
	});

	it("leaves decision alone when model not in registry (graceful fallback)", async () => {
		const mockCtx = { getContextUsage: async () => ({ tokens: 999_999 }) };
		const d = await resolveRouting(
			baseInput(makeContext("fix this bug"), {
				lastExtensionContext: mockCtx as any,
				// default registry returns undefined for everything
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("medium");
		expect(d.isContextTriggered).toBeUndefined();
	});
});

describe("resolveRouting — classifier override", () => {
	it("falls back to heuristic when classifier is unavailable", async () => {
		// Use a nonexistent model — classifier will fail and we fall back to heuristic
		const d = await resolveRouting(
			baseInput(makeContext("implement the new auth middleware in express")),
			baseConfig({ classifierModel: "unknown/nonexistent" }),
		);
		// Falls back to heuristic when classifier fails — "implement" → medium
		expect(d.tier).toBe("medium");
		expect(d.isClassifier).not.toBe(true);
	});

	it("skips classifier when tier is pinned", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("fix this small bug"), { pinnedTier: "high" }),
			baseConfig({ classifierModel: "unknown/nonexistent" }),
		);
		expect(d.tier).toBe("high");
		expect(d.reasoning).toContain("Pinned");
	});

	it("skips classifier when context-triggered", async () => {
		const mockCtx = { getContextUsage: async () => ({ tokens: 200_000 }) };
		const capacityRegistry = makeModelRegistry({
			"test/low-model": { contextWindow: 50_000, maxTokens: 4096 },
			"test/medium-model": { contextWindow: 100_000, maxTokens: 4096 },
			"test/high-model": { contextWindow: 500_000, maxTokens: 4096 },
		}) as unknown as RoutingInput["modelRegistry"];
		const d = await resolveRouting(
			baseInput(makeContext("quick fix"), {
				lastExtensionContext: mockCtx as any,
				modelRegistry: capacityRegistry,
			}),
			baseConfig({
				classifierModel: "unknown/nonexistent",
			}),
		);
		expect(d.tier).toBe("high");
		expect(d.isContextTriggered).toBe(true);
	});
});

describe("resolveRouting — budget exceeded downgrade", () => {
	it("downgrades from high to medium when budget exceeded", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("design the full system architecture"), {
				isBudgetExceeded: true,
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("medium");
		expect(d.isBudgetForced).toBe(true);
		expect(d.reasoning).toContain("Budget exceeded");
	});

	it("does not downgrade medium or low tier when budget exceeded", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("summarize the last few changes"), {
				isBudgetExceeded: true,
			}),
			baseConfig(),
		);
		expect(d.tier).toBe("low");
		expect(d.isBudgetForced).not.toBe(true);
	});
});

describe("resolveRouting — image attachment upgrade", () => {
	const makeImageContext = (): Context => ({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "what is in this image?" },
					{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } },
				],
				timestamp: Date.now(),
			},
		],
		systemPrompt: [],
	});

	it("upgrades low tier to image-supporting tier", async () => {
		// Image profile: high supports images, medium/low do not
		const registry = makeModelRegistry({
			"test/image-model": { input: ["text", "image"] },
			"test/no-image-model": { input: ["text"] },
			"test/no-image-model-low": { input: ["text"] },
		});

		const d = await resolveRouting(
			baseInput(makeImageContext(), {
				// Force low tier via pinning
				pinnedTier: "low",
				modelRegistry: registry as unknown as RoutingInput["modelRegistry"],
			}),
			baseConfig({ profile: IMAGE_PROFILE }),
		);
		expect(d.tier).toBe("high");
		expect(d.reasoning).toContain("image");
	});

	it("does not upgrade when pinned tier already supports images", async () => {
		const registry = makeModelRegistry({
			"test/high-model": { input: ["text", "image"] },
			"test/medium-model": { input: ["text", "image"] },
			"test/low-model": { input: ["text"] },
		});

		const d = await resolveRouting(
			baseInput(makeImageContext(), {
				pinnedTier: "medium",
				modelRegistry: registry as unknown as RoutingInput["modelRegistry"],
			}),
			baseConfig(),
		);
		// medium is pinned and supports images — no upgrade needed
		expect(d.tier).toBe("medium");
		expect(d.reasoning).not.toContain("image attachment");
	});
});

describe("resolveRouting — word-boundary keyword correctness", () => {
	it("does NOT route 'reformat' to low via 'format' substring", async () => {
		// "reformat" contains "format" but \bformat\b should NOT match
		// Use a longer prompt so word-count alone doesn't route to low
		const d = await resolveRouting(
			baseInput(makeContext("investigate the reformatting and code transformation pipeline architecture in depth")),
			baseConfig(),
		);
		// Should match "investigate" (planning) or "architecture" (planning), not "format"
		expect(d.tier).toBe("high");
	});

	it("does NOT route 'unchanged' to medium via 'change' false positive", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("the unchanged values remain the same")),
			baseConfig(),
		);
		// "unchanged" contains "change" as substring but NOT as a word
		// Without prior context, should be low (short prompt) or medium
		expect(d.tier).not.toBe("medium");
	});

	it("DOES route 'format this code' to low via 'format' keyword", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("format this code")),
			baseConfig(),
		);
		expect(d.tier).toBe("low");
	});

	it("DOES route 'planning' to high via 'planning' keyword", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("planning the migration strategy")),
			baseConfig(),
		);
		expect(d.tier).toBe("high");
	});

	it("DOES route 'quickly fix' to low via 'quickly' keyword", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("quickly fix this typo")),
			baseConfig(),
		);
		expect(d.tier).toBe("low");
	});

	it("DOES route 'editing the file' to medium via 'editing' derived keyword", async () => {
		const d = await resolveRouting(
			baseInput(makeContext("editing the file to update the config")),
			baseConfig(),
		);
		expect(d.tier).toBe("medium");
	});
});
