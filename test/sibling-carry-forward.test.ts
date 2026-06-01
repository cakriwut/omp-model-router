/**
 * Tests for sibling session carry-forward.
 *
 * When OMP rotates session IDs within the same sub-agent (e.g. system-reminder
 * retries), the new session scope should inherit accumulated cost/counters from
 * the previous sibling scope — preventing budget bypass via ID rotation.
 */
import { describe, test, expect, spyOn } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RouterState } from "../src/state";
import type { SessionScope } from "../src/state";
import { FALLBACK_CONFIG } from "../src/config";

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

interface RouterStateInternal {
	sessionScopes: Map<string, SessionScope>;
}

function scopes(state: RouterState): Map<string, SessionScope> {
	return (state as unknown as RouterStateInternal).sessionScopes;
}

function createState(overrides?: Partial<typeof FALLBACK_CONFIG>): RouterState {
	const state = new RouterState(mockPi);
	state.currentConfig = { ...FALLBACK_CONFIG, ...overrides };
	return state;
}

describe("sibling carry-forward", () => {
	test("new sibling scope inherits accumulatedCost from previous scope with same parent", () => {
		const state = createState();

		// Parent session activates first
		state.activateSession("parent-1", undefined, "none");

		// Sub-agent session activates with parent
		state.activateSession("child-1", "parent-1", "header");
		state.accumulatedCost = 1.5;
		state.scope.accumulatedOriginalTokens = 10000;
		state.scope.accumulatedCacheReadTokens = 5000;
		state.scope.tierCounter = { high: 2, medium: 5, low: 3 };

		// OMP rotates sessionId (e.g. system-reminder) — same parent
		state.activateSession("child-2", "parent-1", "header");

		// Cost should be carried forward, not reset
		expect(state.accumulatedCost).toBe(1.5);
		expect(state.scope.accumulatedOriginalTokens).toBe(10000);
		expect(state.scope.accumulatedCacheReadTokens).toBe(5000);
		expect(state.scope.tierCounter).toEqual({ high: 2, medium: 5, low: 3 });
	});

	test("non-sibling scope starts fresh (different parent)", () => {
		const state = createState();

		state.activateSession("child-1", "parent-1", "header");
		state.accumulatedCost = 2.0;

		// Different parent — this is a genuinely new sub-agent, not a retry
		state.activateSession("child-2", "parent-2", "header");

		expect(state.accumulatedCost).toBe(0);
	});

	test("non-sibling scope starts fresh (no parent on new session)", () => {
		const state = createState();

		state.activateSession("child-1", "parent-1", "header");
		state.accumulatedCost = 2.0;

		// New session with no parent — root session, not a sibling
		state.activateSession("root-2", undefined, "none");

		expect(state.accumulatedCost).toBe(0);
	});

	test("non-sibling scope starts fresh (no parent on previous session)", () => {
		const state = createState();

		// Previous session has no parent (root session)
		state.activateSession("root-1", undefined, "none");
		state.accumulatedCost = 2.0;

		// New session with a parent — genuinely new sub-agent
		state.activateSession("child-1", "parent-1", "header");

		expect(state.accumulatedCost).toBe(0);
	});

	test("carry-forward includes compression counters", () => {
		const state = createState();

		state.activateSession("child-1", "parent-1", "header");
		state.scope.compressionRequestCount = 3;
		state.scope.compressionTotalOriginalChars = 50000;
		state.scope.compressionTotalCompressedChars = 25000;
		state.scope.accumulatedCompressedTokens = 8000;
		state.scope.accumulatedTokensSaved = 4000;

		state.activateSession("child-2", "parent-1", "header");

		expect(state.scope.compressionRequestCount).toBe(3);
		expect(state.scope.compressionTotalOriginalChars).toBe(50000);
		expect(state.scope.compressionTotalCompressedChars).toBe(25000);
		expect(state.scope.accumulatedCompressedTokens).toBe(8000);
		expect(state.scope.accumulatedTokensSaved).toBe(4000);
	});

	test("carry-forward includes modelCosts map", () => {
		const state = createState();

		state.activateSession("child-1", "parent-1", "header");
		state.scope.modelCosts.set("anthropic/claude-opus-4-7", {
			label: "anthropic/claude-opus-4-7",
			tier: "high",
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadTokens: 2000,
			cacheWriteTokens: 100,
			cost: 0.5,
			requests: 3,
		});

		state.activateSession("child-2", "parent-1", "header");

		expect(state.scope.modelCosts.size).toBe(1);
		const entry = state.scope.modelCosts.get("anthropic/claude-opus-4-7");
		expect(entry?.cost).toBe(0.5);
		expect(entry?.requests).toBe(3);
	});

	test("carry-forward copies modelCosts (does not share reference)", () => {
		const state = createState();

		state.activateSession("child-1", "parent-1", "header");
		state.scope.modelCosts.set("model-a", {
			label: "model-a",
			tier: "high",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0.1,
			requests: 1,
		});

		state.activateSession("child-2", "parent-1", "header");

		// Mutating child-2's map should not affect child-1's map
		state.scope.modelCosts.set("model-b", {
			label: "model-b",
			tier: "low",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0.01,
			requests: 1,
		});

		const child1Scope = scopes(state).get("child-1")!;
		expect(child1Scope.modelCosts.size).toBe(1); // not affected
		expect(state.scope.modelCosts.size).toBe(2); // child-2 has both
	});

	test("re-activating existing session does not reset (no carry-forward needed)", () => {
		const state = createState();

		state.activateSession("child-1", "parent-1", "header");
		state.accumulatedCost = 3.0;

		// Switch to parent
		state.activateSession("parent-1", undefined, "none");

		// Switch BACK to existing child — should preserve its cost
		state.activateSession("child-1", "parent-1", "header");
		expect(state.accumulatedCost).toBe(3.0);
	});

	test("debug log emitted on sibling carry-forward", () => {
		const state = createState({ debug: true });
		const spy = spyOn(console, "log");

		state.activateSession("child-1", "parent-1", "header");
		state.accumulatedCost = 1.23;

		state.activateSession("child-2", "parent-1", "header");

		const calls = spy.mock.calls.map((c) => c[0]);
		expect(calls.some((c: string) => c.includes("sibling carry-forward"))).toBe(true);
		expect(calls.some((c: string) => c.includes("child-1") && c.includes("child-2"))).toBe(true);

		spy.mockRestore();
	});

	test("budget enforcement works after carry-forward", () => {
		const state = createState({ maxSessionBudget: 2.0 });

		state.activateSession("child-1", "parent-1", "header");
		state.accumulatedCost = 2.5; // Over budget

		// Sibling activation — cost carries forward
		state.activateSession("child-2", "parent-1", "header");

		// Budget should still be exceeded
		const isBudgetExceeded =
			state.currentConfig.maxSessionBudget !== undefined &&
			state.accumulatedCost >= state.currentConfig.maxSessionBudget;
		expect(isBudgetExceeded).toBe(true);
	});
});
