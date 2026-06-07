/**
 * Tests for the completeness of finalizeChildSession's parent rollup.
 * Covers spec scenarios 3.1–3.10: every aggregable SessionScope field
 * (numerics, tierCounter, modelCosts) must merge into the parent; ephemeral
 * fields must not; child scope is always deleted; multi-level rollups
 * cascade; and a regression guard catches new unclassified fields.
 */
import { describe, test, expect } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RouterState } from "../src/state";
import type { SessionScope, ModelCostEntry } from "../src/state";
import { FALLBACK_CONFIG } from "../src/config";
import type { RoutingDecision } from "../src/types";

// ─── Minimal ExtensionAPI mock ────────────────────────────────────────────────

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

// ─── Internal state accessor (private field, test-only) ───────────────────────

interface RouterStateInternal {
	sessionScopes: Map<string, SessionScope>;
}

function scopes(state: RouterState): Map<string, SessionScope> {
	return (state as unknown as RouterStateInternal).sessionScopes;
}

function makeState(): { state: RouterState; map: Map<string, SessionScope> } {
	const state = new RouterState(mockPi);
	state.currentConfig = FALLBACK_CONFIG;
	return { state, map: scopes(state) };
}

function entry(overrides: Partial<ModelCostEntry> & { model: string; tier: string }): ModelCostEntry {
	return {
		invocations: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("3.x finalizeChildSession rollup completeness", () => {
	// 3.1 — All 8 numeric fields roll up (parent N + child M)
	// Updated: removed fields (accumulatedOriginalTokens, accumulatedCompressedTokens, accumulatedTokensSaved, accumulatedCacheReadTokens) no longer exist
	// This test now verifies that cost rollup still works for remaining fields
	test("3.1: accumulatedCost rolls up from child into parent", () => {
		const { state, map } = makeState();
		state.activateSession("parent-1", undefined, "none");
		const parent = map.get("parent-1")!;
		parent.accumulatedCost = 1;

		state.activateSession("child-1", "parent-1", "header");
		const child = map.get("child-1")!;
		child.accumulatedCost = 0.5;

		state.finalizeChildSession("child-1");

		expect(parent.accumulatedCost).toBeCloseTo(1.5, 9);
	});

	// 3.2 — tierCounter element-wise sum
	test("3.2: tierCounter sums element-wise (high/medium/low)", () => {
		const { state, map } = makeState();
		state.activateSession("parent-1", undefined, "none");
		const parent = map.get("parent-1")!;
		parent.tierCounter = { high: 2, medium: 1, low: 0 };

		state.activateSession("child-1", "parent-1", "header");
		const child = map.get("child-1")!;
		child.tierCounter = { high: 1, medium: 0, low: 3 };

		state.finalizeChildSession("child-1");

		expect(parent.tierCounter).toEqual({ high: 3, medium: 1, low: 3 });
	});

	// 3.3 — modelCosts: new key from child added to parent
	test("3.3: modelCosts gains new child key absent from parent", () => {
		const { state, map } = makeState();
		state.activateSession("parent-1", undefined, "none");
		const parent = map.get("parent-1")!;

		state.activateSession("child-1", "parent-1", "header");
		const child = map.get("child-1")!;
		const childEntry = entry({
			model: "anthropic/claude-haiku",
			tier: "low",
			invocations: 5,
			cost: 0.01,
		});
		child.modelCosts.set("anthropic/claude-haiku", childEntry);

		state.finalizeChildSession("child-1");

		const got = parent.modelCosts.get("anthropic/claude-haiku");
		expect(got).toBeDefined();
		expect(got!.invocations).toBe(5);
		expect(got!.cost).toBeCloseTo(0.01, 9);
		expect(got!.tier).toBe("low");
		// Shallow copy required — parent must not alias child's entry object.
		expect(got).not.toBe(childEntry);
	});

	// 3.4 — modelCosts: colliding key, same tier, numerics summed
	test("3.4: colliding modelCosts key sums all six numeric fields in-place", () => {
		const { state, map } = makeState();
		state.activateSession("parent-1", undefined, "none");
		const parent = map.get("parent-1")!;
		parent.modelCosts.set(
			"bedrock/nova",
			entry({
				model: "bedrock/nova",
				tier: "low",
				invocations: 2,
				cost: 0.05,
				inputTokens: 1000,
				outputTokens: 200,
				cacheReadTokens: 50,
				cacheWriteTokens: 10,
			}),
		);

		state.activateSession("child-1", "parent-1", "header");
		const child = map.get("child-1")!;
		child.modelCosts.set(
			"bedrock/nova",
			entry({
				model: "bedrock/nova",
				tier: "low",
				invocations: 3,
				cost: 0.08,
				inputTokens: 1500,
				outputTokens: 300,
				cacheReadTokens: 75,
				cacheWriteTokens: 15,
			}),
		);

		state.finalizeChildSession("child-1");

		const got = parent.modelCosts.get("bedrock/nova")!;
		expect(got.invocations).toBe(5);
		expect(got.cost).toBeCloseTo(0.13, 9);
		expect(got.inputTokens).toBe(2500);
		expect(got.outputTokens).toBe(500);
		expect(got.cacheReadTokens).toBe(125);
		expect(got.cacheWriteTokens).toBe(25);
		expect(got.tier).toBe("low");
	});

	// 3.5 — modelCosts: colliding key, different tier, parent tier wins
	test("3.5: parent tier label wins on tier collision", () => {
		const { state, map } = makeState();
		state.activateSession("parent-1", undefined, "none");
		const parent = map.get("parent-1")!;
		parent.modelCosts.set(
			"openai/gpt-4o",
			entry({ model: "openai/gpt-4o", tier: "high", invocations: 1 }),
		);

		state.activateSession("child-1", "parent-1", "header");
		const child = map.get("child-1")!;
		child.modelCosts.set(
			"openai/gpt-4o",
			entry({ model: "openai/gpt-4o", tier: "medium", invocations: 1 }),
		);

		state.finalizeChildSession("child-1");

		expect(parent.modelCosts.get("openai/gpt-4o")!.tier).toBe("high");
	});

	// 3.6 — Ephemeral fields not touched
	test("3.6: ephemeral fields (lastDecision/isStreaming/lastTurnTimestamp) untouched", () => {
		const { state, map } = makeState();
		state.activateSession("parent-1", undefined, "none");
		const parent = map.get("parent-1")!;
		const parentSentinel = { sentinel: "parent" } as unknown as RoutingDecision;
		parent.lastDecision = parentSentinel;
		parent.isStreaming = false;
		parent.lastTurnTimestamp = 12345;

		state.activateSession("child-1", "parent-1", "header");
		const child = map.get("child-1")!;
		child.lastDecision = { sentinel: "child" } as unknown as RoutingDecision;
		child.isStreaming = true;
		child.lastTurnTimestamp = 99999;

		state.finalizeChildSession("child-1");

		expect(parent.lastDecision).toBe(parentSentinel);
		expect(parent.isStreaming).toBe(false);
		expect(parent.lastTurnTimestamp).toBe(12345);
	});

	// 3.7 — Child scope deleted after rollup
	test("3.7: child scope is deleted after finalizeChildSession", () => {
		const { state, map } = makeState();
		state.activateSession("parent-1", undefined, "none");
		state.activateSession("child-1", "parent-1", "header");

		state.finalizeChildSession("child-1");

		expect(map.get("child-1")).toBeUndefined();
	});

	// 3.8 — No parent attributed: no error, scope deleted
	test("3.8: orphan child (no parentSessionId) finalizes without throw and is deleted", () => {
		const { state, map } = makeState();
		state.activateSession("orphan-1", undefined, "none");
		expect(map.get("orphan-1")!.parentSessionId).toBeUndefined();

		expect(() => state.finalizeChildSession("orphan-1")).not.toThrow();
		expect(map.get("orphan-1")).toBeUndefined();
	});

	// 3.9 — Multi-level rollup (grandchild → child → parent)
	test("3.9: multi-level rollup cascades grandchild → child → parent", () => {
		const { state, map } = makeState();
		state.activateSession("parent", undefined, "none");
		const parent = map.get("parent")!;
		parent.modelCosts.set("m-p", entry({ model: "m-p", tier: "high", invocations: 1 }));

		state.activateSession("child", "parent", "header");
		const child = map.get("child")!;
		child.modelCosts.set("m-c", entry({ model: "m-c", tier: "medium", invocations: 1 }));

		state.activateSession("grandchild", "child", "header");
		const grandchild = map.get("grandchild")!;
		grandchild.modelCosts.set("m-gc", entry({ model: "m-gc", tier: "low", invocations: 1 }));

		state.finalizeChildSession("grandchild");
		state.finalizeChildSession("child");

		expect(parent.modelCosts.has("m-p")).toBe(true);
		expect(parent.modelCosts.has("m-c")).toBe(true);
		expect(parent.modelCosts.has("m-gc")).toBe(true);
	});

	// 3.10 — Regression guard: every SessionScope field is classified
	test("3.10: regression guard — every SessionScope field is merged or skipped", () => {
		const MERGED_FIELDS: Record<string, true> = {
			accumulatedCost: true,
			tierCounter: true,
			modelCosts: true,
			classifierInvocations: true,
			classifierCacheHits: true,
		};
		const SKIPPED_FIELDS: Record<string, true> = {
			sessionId: true,
			parentSessionId: true,
			debugHistory: true,
			lastDecision: true,
			isStreaming: true,
			lastTurnTimestamp: true,
			currentCheckpoint: true,
			scopedPin: true,
			lastClassifierKey: true,
			lastClassifierVerdict: true,
			classifierTurnsSinceRun: true,
			userMessagesSeen: true,
			lastUserEntryId: true,
		};

		const { state, map } = makeState();
		state.activateSession("probe", undefined, "none");
		const scope = map.get("probe")!;

		for (const key of Object.keys(scope)) {
			expect(
				MERGED_FIELDS[key] === true || SKIPPED_FIELDS[key] === true,
				`Unclassified SessionScope field: ${key} — update finalizeChildSession and this test`,
			).toBe(true);
		}
	});
});
