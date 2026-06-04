/**
 * Unit tests for async classifier deduplication
 *
 * Tests cover:
 * - Async dedup key is set to String(userMessagesSeen)
 * - Repeated calls with same key are skipped (pendingAgentId not set)
 * - New user message (different key) allows a new spawn
 * - Dedup applies in both telemetry and adaptive modes
 * - Session scope switch resets the dedup key
 *
 * Isolation strategy
 * ──────────────────
 * spawnClassifierAgent lives in src/calibration/index (re-exported from agent.ts).
 * hooks.ts imports it as a named ES-module binding — patching `global` has no
 * effect on that binding.  We use mock.module() to replace the entire
 * calibration/index barrel with a controllable stub BEFORE any test imports
 * hooks.ts.  That way spawnClassifierAgent never touches the network.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

// ── Hoist the module mock BEFORE importing the module under test ──────────────
// Bun evaluates mock.module() calls before the surrounding test file's imports,
// so this stub is in place when hooks.ts is first loaded.
let spawnCallCount = 0;
let spawnShouldReject = false;

mock.module("../src/calibration/index", () => {
	// Minimal stub — only the symbols hooks.ts actually uses
	return {
		initSessionCalibration: () => ({
			matrix: [[0,0,0],[0,0,0],[0,0,0]],
			totalComparisons: 0,
			llmCallsAttempted: 0,
			llmCallsFailed: 0,
			sessionStartTime: Date.now(),
			turnsProcessed: 0,
		}),
		loadGlobalCalibration: () => undefined,
		mergeSessionIntoGlobal: () => {},
		updateCalibrationMatrix: () => {},
		spawnClassifierAgent: async (_ref: unknown, _prompt: unknown, _reg: unknown) => {
			spawnCallCount++;
			if (spawnShouldReject) throw new Error("mock spawn error");
			return `mock-agent-id-${spawnCallCount}`;
		},
		// Return ready:true immediately so the polling loop in hooks.ts exits
		// on the very first poll — no waiting, no setTimeout accumulation.
		pollClassifierResult: async () => ({
			ready: true,
			verdict: { tier: "medium", reasoning: "mock verdict" },
			latencyMs: 1,
		}),
		abandonClassifier: () => {},
		openTraceFile: () => undefined,
		appendTraceRecord: () => {},
		truncatePrompt: (s: string, n: number) => s.slice(0, n),
		cancelPendingSave: () => {},
	};
});

// ── Now it's safe to import the module under test ─────────────────────────────
import { spawnClassifierForTurn } from "../src/calibration/hooks";
import type { RouterConfig } from "../src/types";
import type { Context } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RouterState } from "../src/state";

// ─── Test helpers ─────────────────────────────────────────────────────────────

const mockPi = {} as ExtensionContext;

const makeConfig = (
	mode: "telemetry" | "adaptive" = "telemetry",
): RouterConfig => ({
	defaultProfile: "auto",
	debug: false,
	maxSessionBudget: 5.0,
	defaultPin: "auto",
	pinTimeout: 600000,
	enableRtk: true,
	calibration: {
		enabled: true,
		mode,
		warmupTurns: 5,
		classifierModel: "amazon-bedrock/us.amazon.nova-micro-v1:0",
		overrideThreshold: 0.65,
		traceEnabled: false,
		useGlobalPrior: true,
		globalPriorWeight: 0.1,
	},
	profiles: {
		auto: {
			high:   { model: "anthropic/claude-opus" },
			medium: { model: "anthropic/claude-sonnet" },
			low:    { model: "anthropic/claude-haiku" },
		},
	},
});

const makeContext = (userText: string): Context => ({
	messages: [{ role: "user", content: userText }],
});

/** Minimal ExtensionContext stub — no real API calls */
const makeExtCtx = (): ExtensionContext => ({
	modelRegistry: {
		find: () => ({
			id: "test",
			provider: "test",
			contextWindow: 200_000,
			cost: { input: 0.001, output: 0.003 },
			input: ["text"],
			output: ["text"],
		}),
		getApiKey: async () => "mock-key",
		getProviders: () => [],
		registerProvider: () => {},
	} as unknown as ExtensionContext["modelRegistry"],
	ui: { notify: () => {} } as unknown as ExtensionContext["ui"],
} as ExtensionContext);

const makeBaseDecision = () => ({
	profile: "auto",
	tier: "medium" as const,
	phase: "implementation" as const,
	targetProvider: "aws",
	targetModelId: "claude",
	targetLabel: "mock",
	reasoning: "mock",
	thinking: "off" as const,
	timestamp: Date.now(),
	syncClassifierRan: false,
});

const makeState = (mode: "telemetry" | "adaptive" = "telemetry") => {
	const state = new RouterState(mockPi);
	state.activateSession("test-session");
	state.currentConfig = makeConfig(mode);
	state.calibration = {
		matrix: [[0,0,0],[0,0,0],[0,0,0]],
		totalComparisons: 0,
		llmCallsAttempted: 0,
		llmCallsFailed: 0,
		sessionStartTime: Date.now(),
		turnsProcessed: 0,
	};
	state.lastExtensionContext = makeExtCtx();
	state.lastDecision = makeBaseDecision();
	return state;
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Async classifier deduplication", () => {
	beforeEach(() => {
		spawnCallCount = 0;
		spawnShouldReject = false;
	});

	test("T8.1: First spawn of user message sets lastAsyncClassifierKey", async () => {
		const state = makeState();
		state.userMessagesSeen = 0;

		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("I want to start 2 weeks production observation"));

		// Give the micro-task queue one turn so the async spawn promise can settle
		await Promise.resolve();

		// Dedup key must be set synchronously before the promise chain runs
		expect(state.lastAsyncClassifierKey).toBe("0");
		// pendingAgentId is set synchronously in hooks.ts before the promise
		expect(state.calibration?.pendingAgentId).toBeDefined();
	});

	test("T8.2: Second call with same userMessagesSeen skips spawn (cache hit)", async () => {
		const state = makeState();
		state.userMessagesSeen = 1;

		// First call
		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("prompt"));
		await Promise.resolve();
		expect(spawnCallCount).toBe(1);
		expect(state.lastAsyncClassifierKey).toBe("1");

		// Simulate async completion — clear pendingAgentId
		state.calibration!.pendingAgentId = undefined;

		// Second call with same userMessagesSeen — dedup must block it
		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("prompt"));
		await Promise.resolve();
		expect(spawnCallCount).toBe(1); // unchanged
	});

	test("T8.3: New user message (different userMessagesSeen) allows new spawn", async () => {
		const state = makeState();
		state.userMessagesSeen = 1;

		// First user message
		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("first prompt"));
		await Promise.resolve();
		expect(spawnCallCount).toBe(1);
		expect(state.lastAsyncClassifierKey).toBe("1");

		// Simulate completion
		state.calibration!.pendingAgentId = undefined;

		// Second user message — userMessagesSeen incremented
		state.userMessagesSeen = 2;
		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("second prompt"));
		await Promise.resolve();
		expect(spawnCallCount).toBe(2);
		expect(state.lastAsyncClassifierKey).toBe("2");
	});

	test("T8.4: Dedup applies in adaptive mode (syncClassifierRan=false)", async () => {
		const state = makeState("adaptive");
		// syncClassifierRan = false so the fast-path guard does NOT fire;
		// only the dedup key guard should block the second call.
		state.lastDecision = { ...makeBaseDecision(), syncClassifierRan: false };
		state.userMessagesSeen = 3;

		// First call
		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("adaptive test"));
		await Promise.resolve();
		expect(spawnCallCount).toBe(1);

		// Simulate completion
		state.calibration!.pendingAgentId = undefined;

		// Second call — same userMessagesSeen → dedup must block it
		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("adaptive test"));
		await Promise.resolve();
		expect(spawnCallCount).toBe(1);
	});

	test("T8.4b: adaptive fast-path: syncClassifierRan=true blocks spawn even without dedup key", async () => {
		const state = makeState("adaptive");
		state.lastDecision = { ...makeBaseDecision(), syncClassifierRan: true };
		state.userMessagesSeen = 5;
		// No dedup key set yet — but syncClassifierRan should be enough to skip

		spawnClassifierForTurn(state, state.currentConfig, "medium", makeContext("adaptive test"));
		await Promise.resolve();
		expect(spawnCallCount).toBe(0);
		// Key should NOT be set since we returned early before setting it
		expect(state.lastAsyncClassifierKey).toBeUndefined();
	});

	test("T8.5: New session scope gets fresh dedup key", () => {
		const state = new RouterState(mockPi);

		// First session
		state.activateSession("session-1");
		state.userMessagesSeen = 5;
		state.lastAsyncClassifierKey = "5";

		expect(state.lastAsyncClassifierKey).toBe("5");

		// Switch to new session
		state.activateSession("session-2");

		// Both dedup key and userMessagesSeen reset for new (non-sibling) scope
		expect(state.lastAsyncClassifierKey).toBeUndefined();
		expect(state.userMessagesSeen).toBe(0);
	});
});
