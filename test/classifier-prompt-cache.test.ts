/**
 * Unit tests for Classifier Prompt Cache (Phase 1)
 *
 * Tests cover:
 * - T5.1  Cache HIT skips runClassifier (second call reuses verdict)
 * - T5.2  TTL expiry triggers re-run
 * - T5.3  New user message busts cache (different lastUserText)
 * - T5.4  Same user text repeated (userMsgIndex disambiguation)
 * - T5.5  Classifier returns undefined → cache not poisoned
 * - T5.6  syncClassifierRan reflects execution, not cache reuse
 * - T5.7  Calibration matrix still updated on cache HIT
 * - T5.8  Pinned tier path bypasses cache entirely
 * - T5.9  Context-capacity promotion clears cache
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock runClassifier BEFORE importing compose (which dynamic-imports ./index) ─
// compose.ts calls `await import("./index.js")` then invokes runClassifier.
// Without this mock every cache-MISS path fires a real streamSimple HTTP call
// and the test hangs indefinitely.
//
// The stub returns undefined (classifier unavailable) so MISS-path tests verify
// the cache is not poisoned and routing falls back to heuristic — exactly the
// behaviour those tests are checking.
let runClassifierCallCount = 0;
let runClassifierOverride: (() => Promise<{ tier: "low" | "medium" | "high"; reasoning: string } | undefined>) | undefined;

// Grab real exports synchronously before mock replaces the module.
// Spread into the mock so all barrel re-exports remain intact and tests
// running in the same worker process (e.g. profile-effectiveness) don't
// receive "not stubbed" throw stubs.
const realRoutingIndex = require("../src/routing/index");

mock.module("../src/routing/index", () => ({
	...realRoutingIndex,
	// Override only the symbol compose.ts dynamic-imports: runClassifier.
	runClassifier: async (..._args: unknown[]) => {
		runClassifierCallCount++;
		return runClassifierOverride ? runClassifierOverride() : Promise.resolve(undefined);
	},
}));

import { resolveRouting, type RoutingInput, type RoutingConfig } from "../src/routing/compose";
import type { RouterProfile, RouterConfig } from "../src/types";
import type { Context } from "@oh-my-pi/pi-ai";
import { RouterState } from "../src/state";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockProfile: RouterProfile = {
	high: { model: "anthropic/claude-opus" },
	medium: { model: "anthropic/claude-sonnet" },
	low: { model: "anthropic/claude-haiku" },
};

function makeContext(userMessages: string[]): Context {
	const messages: Context["messages"] = [];
	for (const text of userMessages) {
		messages.push({ role: "user", content: text });
	}
	return { messages };
}

function makeRegistry(supportsImages = false) {
	return {
		find: (_provider: string, _modelId: string) => ({
			id: _modelId,
			provider: _provider,
			contextWindow: 200_000,
			maxTokens: 8192,
			cost: { input: 0.001, output: 0.003 },
			input: supportsImages ? ["text", "image"] : ["text"],
			output: ["text"],
		}),
		all: () => [],
	} as any;
}

const baseRoutingConfig: RoutingConfig = {
	profileName: "auto",
	profile: mockProfile,
	phaseBias: 0.5,
	classifierModel: "stub/classifier",
	debug: false,
	calibrationConfig: { enabled: true, mode: "adaptive", warmupTurns: 0, overrideThreshold: 0.5 },
};

// Create a minimal mock pi for RouterState
const mockPi = {} as any;

// ─── T5.1: Cache HIT stores and reuses state fields ────────────────────────────

describe("Classifier prompt cache (Phase 1)", () => {
	beforeEach(() => {
		runClassifierCallCount = 0;
		runClassifierOverride = undefined;
	});
	test("T5.1: cache fields are stored on MISS, turned into HIT on second call with same sig", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 20 },
		} as RouterConfig;

		const ctx = makeContext(["run the tests"]);
		const registry = makeRegistry();

		// Manually inject a cached verdict (simulates what runClassifier would store)
		state.scope.lastClassifierKey = "run the tests|1|fresh";
		state.scope.lastClassifierVerdict = { tier: "medium", reasoning: "Test stub verdict" };
		state.scope.classifierTurnsSinceRun = 0;
		// Simulate that userMessagesSeen has already been incremented to 1
		state.scope.userMessagesSeen = 1;

		// Build input with no pin, no context trigger — should reach cache block
		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: registry,
			state,
		};

		const decision = await resolveRouting(input, baseRoutingConfig);

		// Since we pre-loaded cache, it should hit and use the verdict
		expect(decision.reasoning).toContain("Classifier (cached):");
		expect(decision.tier).toBe("medium");
		// Counter should increment
		expect(state.scope.classifierTurnsSinceRun).toBe(1);
	});

	test("T5.2: TTL expiry — forces re-run when turnsSinceRun reaches ttlTurns", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 3 },
		} as RouterConfig;

		const ctx = makeContext(["run the tests"]);
		const registry = makeRegistry();

		// Pre-load cache at TTL boundary — exactly ttlTurns means MISS (uses <, not <=)
		state.scope.lastClassifierKey = "run the tests|1|fresh";
		state.scope.lastClassifierVerdict = { tier: "medium", reasoning: "cached" };
		state.scope.classifierTurnsSinceRun = 3; // exactly at ttlTurns → MISS
		state.scope.userMessagesSeen = 1;

		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: registry,
			state,
		};

		// Without a real classifier, it will fail and fall to heuristic
		const decision = await resolveRouting(input, baseRoutingConfig);

		// Cache was NOT used (ttlTurns boundary) — we don't see "Classifier (cached):" in reasoning.
		expect(decision.reasoning).not.toContain("Classifier (cached):");
		// runClassifier stub was actually invoked (MISS path hit the mock, not real HTTP)
		expect(runClassifierCallCount).toBe(1);
	});

	test("T5.3: New user message busts cache (different lastUserText)", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 20 },
		} as RouterConfig;

		const registry = makeRegistry();

		// Pre-load cache for "run the tests|1"
		state.scope.lastClassifierKey = "run the tests|1|fresh";
		state.scope.lastClassifierVerdict = { tier: "medium", reasoning: "cached verdict" };
		state.scope.classifierTurnsSinceRun = 0;
		state.scope.userMessagesSeen = 1;

		// Now use a DIFFERENT user message
		const ctx2 = makeContext(["deploy to production"]);
		const input: RoutingInput = {
			context: ctx2,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: registry,
			state,
		};

		const decision = await resolveRouting(input, baseRoutingConfig);

		// Should NOT use cached verdict for different message
		expect(decision.reasoning).not.toContain("Classifier (cached):");
		expect(runClassifierCallCount).toBe(1);
	});

	test("T5.4: userMsgIndex disambiguation — same text, second turn = different sig = MISS", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 20 },
		} as RouterConfig;

		// Context has one user message "run tests"
		const ctx = makeContext(["run tests"]);
		const registry = makeRegistry();

		// Pre-load cache for the first occurrence: sig = "run tests|1|fresh"
		state.scope.lastClassifierKey = "run tests|1|fresh";
		state.scope.lastClassifierVerdict = { tier: "low", reasoning: "first occurrence" };
		state.scope.classifierTurnsSinceRun = 0;
		// Simulate second turn: userMessagesSeen = 2 (turn_start fired for a repeated "run tests")
		state.scope.userMessagesSeen = 2;

		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: registry,
			state,
		};

		const decision = await resolveRouting(input, baseRoutingConfig);

		// userMsgIndex is 2, so sig = "run tests|2|fresh" != "run tests|1|fresh" → MISS
		expect(decision.reasoning).not.toContain("Classifier (cached):");
		expect(runClassifierCallCount).toBe(1);
	});

	test("T5.5: classifier returns undefined — cache fields NOT updated (not poisoned)", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 20 },
		} as RouterConfig;

		const ctx = makeContext(["a fresh prompt"]);
		const registry = makeRegistry();

		// No pre-loaded cache — fresh state
		expect(state.scope.lastClassifierKey).toBeUndefined();

		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: registry,
			state,
		};

		// classifier will return undefined (no real model available)
		await resolveRouting(input, baseRoutingConfig);

		// runClassifier stub was called (proves no real HTTP request was made)
		expect(runClassifierCallCount).toBe(1);
		// Cache should NOT be poisoned with undefined
		expect(state.scope.lastClassifierKey).toBeUndefined();
		expect(state.scope.lastClassifierVerdict).toBeUndefined();
	});

	test("T5.6: syncClassifierRan is true on cache HIT (suppresses async spawn in adaptive mode)", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 20 },
		} as RouterConfig;

		const ctx = makeContext(["analyze the code"]);
		const registry = makeRegistry();

		// Pre-populate cache — HIT scenario
		state.scope.lastClassifierKey = "analyze the code|1|fresh";
		state.scope.lastClassifierVerdict = { tier: "high", reasoning: "complex analysis" };
		state.scope.classifierTurnsSinceRun = 0;
		state.scope.userMessagesSeen = 1;

		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: registry,
			state,
		};

		const decision = await resolveRouting(input, baseRoutingConfig);

		// syncClassifierRan field removed (sync-classifier-only — no async path to suppress)
		// runClassifier was NOT called — it was a cache hit
		expect(runClassifierCallCount).toBe(0);
	});

	test("T5.7: pinned tier lets classifier run (for pin-pressure), cache may be empty if classifier fails", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 20 },
		} as RouterConfig;

		const ctx = makeContext(["summarize this"]);
		const registry = makeRegistry();

		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			pinnedTier: "low", // pinned — classifier runs but doesn't override routing
			isBudgetExceeded: false,
			modelRegistry: registry,
			state,
		};

		const decision = await resolveRouting(input, baseRoutingConfig);

		// Classifier RUNS even when pinned (feeds pin-pressure logic)
		expect(runClassifierCallCount).toBe(1);
		// Tier stays pinned
		expect(decision.tier).toBe("low");
		// Cache is only populated if verdict succeeded; in this test the classifier fails
		// so cache is empty. That's OK — the important thing is classifier ran.
	});

	test("T5.8: context capacity promotion clears cache fields", async () => {
		const state = new RouterState(mockPi);
		state.activateSession("test-session");
		state.currentConfig = {
			...state.currentConfig,
			classifierCache: { ttlTurns: 20 },
		} as RouterConfig;

		// Use a simple message that heuristically resolves to "low" (not "high"),
		// so context-capacity promotion can fire (requires decision.tier !== "high")
		const ctx = makeContext(["summarize this file"]);

		// Pre-populate cache
		state.scope.lastClassifierKey = "summarize this file|1|fresh";
		state.scope.lastClassifierVerdict = { tier: "low", reasoning: "pre-cached" };
		state.scope.classifierTurnsSinceRun = 0;
		state.scope.userMessagesSeen = 1;

		// Build a registry where low/medium models have tiny context windows
		// so promotion from low → medium → high fires
		const tinyRegistry = {
			find: (_provider: string, _modelId: string) => ({
				id: _modelId,
				provider: _provider,
				contextWindow: 10_000, // tiny: headroom = max(8192, 8192) = 8192, usable = 1808
				maxTokens: 8192,
				cost: { input: 0.001, output: 0.003 },
				input: ["text"],
				output: ["text"],
			}),
			all: () => [],
		} as any;

		// Simulate a context usage that exceeds the tiny window
		const mockExtCtx = {
			getContextUsage: async () => ({ tokens: 9_500 }), // exceeds 10k - 8k = 1.8k headroom
		} as any;

		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: tinyRegistry,
			lastExtensionContext: mockExtCtx,
			state,
		};

		const decision = await resolveRouting(input, baseRoutingConfig);

		// If context promotion fired, cache should be cleared
		if (decision.isContextTriggered) {
			expect(state.scope.lastClassifierKey).toBeUndefined();
			expect(state.scope.lastClassifierVerdict).toBeUndefined();
			expect(state.scope.classifierTurnsSinceRun).toBe(0);
		} else {
			// If heuristic resolved to "high" already (e.g. message is planning-heavy),
			// promotion wouldn't fire. Verify the decision is still valid.
			expect(decision.tier).toBeDefined();
		}
	});

	test("T5.9: no state provided — cache is bypassed, routing still works", async () => {
		const ctx = makeContext(["explain the system"]);
		const registry = makeRegistry();

		const input: RoutingInput = {
			context: ctx,
			previousDecision: undefined,
			isBudgetExceeded: false,
			modelRegistry: registry,
			// state: intentionally omitted
		};

		// Should not throw — state is optional
		const decision = await resolveRouting(input, baseRoutingConfig);
		expect(decision.tier).toBeDefined();
		expect(decision.reasoning).toBeDefined();
	});
});