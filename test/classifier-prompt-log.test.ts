/**
 * Tests for the classifierPrompt.jsonl prompt-log feature.
 *
 * Verifies that `spawnClassifierForTurn` writes PromptLogRecord entries
 * into `<artifactsDir>/classifierPrompt.jsonl` when traceEnabled is true,
 * skips when disabled, and handles failures gracefully.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Context } from "@oh-my-pi/pi-ai";
import type { RouterConfig, RouterTier } from "../src/types";
import type { PromptLogRecord } from "../src/calibration/trace";

// ─── Mock classifier agent (same pattern as mock-check.test.ts) ───────────────

let mockSpawnResult: string | undefined = "mock-agent-id";
let mockPollVerdict: { tier: RouterTier; reasoning: string } | undefined = {
	tier: "high",
	reasoning: "broad investigation",
};

mock.module("../src/calibration/index", () => ({
	spawnClassifierAgent: async () => mockSpawnResult,
	pollClassifierResult: async () => ({
		ready: true,
		verdict: mockPollVerdict,
	}),
	abandonClassifier: () => {},
	openTraceFile: () => undefined,
	appendTraceRecord: () => {},
	truncatePrompt: (s: string, n: number) => s.slice(0, n),
	cancelPendingSave: () => {},
	initSessionCalibration: () => ({
		matrix: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
		totalComparisons: 0,
		llmCallsAttempted: 0,
		llmCallsFailed: 0,
		sessionStartTime: Date.now(),
		turnsProcessed: 0,
	}),
	loadGlobalCalibration: () => undefined,
	mergeSessionIntoGlobal: () => {},
	updateCalibrationMatrix: () => {},
}));

import { spawnClassifierForTurn } from "../src/calibration/hooks";
import { RouterState } from "../src/state";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

function makeMinimalConfig(traceEnabled: boolean): RouterConfig {
	return {
		defaultProfile: "auto",
		debug: false,
		maxSessionBudget: 5,
		defaultPin: "auto",
		pinTimeout: 600000,
		enableRtk: false,
		calibration: {
			enabled: true,
			mode: "telemetry",
			classifierModel: "anthropic/claude-3-haiku-20240307",
			traceEnabled,
			warmupTurns: 0,
			overrideThreshold: 0.65,
			useGlobalPrior: false,
			globalPriorWeight: 0.1,
		},
		profiles: {
			auto: {
				high: { model: "openai/gpt-4o" },
				medium: { model: "anthropic/claude-sonnet-4" },
				low: { model: "anthropic/claude-haiku-3" },
			},
		},
	};
}

function makeMinimalContext(messages: Context["messages"] = []): Context {
	return { messages };
}

function makeState(artifactsDir: string | null): RouterState {
	const state = new RouterState(mockPi);
	const config = makeMinimalConfig(true);
	state.currentConfig = config;
	state.selectedProfile = "auto";
	state.activateSession("test-session");

	// Initialize calibration
	state.calibration = {
		matrix: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
		totalComparisons: 0,
		llmCallsAttempted: 0,
		llmCallsFailed: 0,
		sessionStartTime: Date.now(),
		turnsProcessed: 0,
	};

	// Wire session context with getArtifactsDir
	const fakeCtx = {
		modelRegistry: {
			find: () => ({
				id: "t",
				provider: "t",
				contextWindow: 200000,
				cost: { input: 0.001, output: 0.003 },
				input: ["text"],
				output: ["text"],
			}),
			getApiKey: async () => "key",
			getProviders: () => [],
			registerProvider: () => {},
		},
		ui: { notify: () => {} },
		sessionManager: {
			getArtifactsDir: () => artifactsDir,
		},
	} as unknown as ExtensionContext;
	state.setSessionContext("test-session", fakeCtx);

	// Set last decision for routing context
	const scope = state.scope;
	scope.lastDecision = {
		profile: "auto",
		tier: "medium",
		phase: "implementation",
		targetProvider: "p",
		targetModelId: "m",
		targetLabel: "l",
		reasoning: "r",
		thinking: "off",
		timestamp: Date.now(),
		syncClassifierRan: false,
	};
	scope.userMessagesSeen = 0;

	return state;
}

function settle(ms = 200): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "classifier-prompt-log-"));
	mockSpawnResult = "mock-agent-id";
	mockPollVerdict = { tier: "high", reasoning: "broad investigation" };
});

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("classifierPrompt.jsonl", () => {
	test("traceEnabled: false → no file created", async () => {
		const state = makeState(tempDir);
		const config = makeMinimalConfig(false);
		const context = makeMinimalContext([{ role: "user", content: "test prompt" }]);

		spawnClassifierForTurn(state, config, "medium", context, state.scope, "exploration");
		await settle();

		const logPath = join(tempDir, "classifierPrompt.jsonl");
		expect(existsSync(logPath)).toBe(false);
	});

	test("traceEnabled: true, getArtifactsDir() returns null → no file, no error", async () => {
		const state = makeState(null);
		const config = makeMinimalConfig(true);
		const context = makeMinimalContext([{ role: "user", content: "test prompt" }]);

		// Should not throw
		spawnClassifierForTurn(state, config, "medium", context, state.scope, "exploration");
		await settle();

		// No file anywhere (null dir means no write)
		expect(true).toBe(true); // no throw is the assertion
	});

	test("successful verdict → file created with correct record", async () => {
		mockPollVerdict = { tier: "high", reasoning: "broad investigation" };
		const state = makeState(tempDir);
		const config = makeMinimalConfig(true);
		const context = makeMinimalContext([{ role: "user", content: "test prompt for classification" }]);

		spawnClassifierForTurn(state, config, "medium", context, state.scope, "exploration");
		await settle(500);

		const logPath = join(tempDir, "classifierPrompt.jsonl");
		expect(existsSync(logPath)).toBe(true);

		const content = readFileSync(logPath, "utf-8").trim();
		const record: PromptLogRecord = JSON.parse(content);

		expect(record.prompt).toStartWith("You are a model router classifier");
		expect(record.verdict).not.toBeNull();
		expect(record.verdict!.tier).toBe("high");
		expect(record.heuristicTier).toBe("medium");
		expect(record.bucket).toBe("exploration");
		expect(record.latencyMs).toBeGreaterThanOrEqual(0);
		expect(typeof record.turnIndex).toBe("number");
		expect(typeof record.userMsgIndex).toBe("number");
	});

	test("failed call → file created with verdict: null and error field", async () => {
		mockSpawnResult = undefined; // spawn-no-id
		const state = makeState(tempDir);
		const config = makeMinimalConfig(true);
		const context = makeMinimalContext([{ role: "user", content: "test prompt" }]);

		spawnClassifierForTurn(state, config, "medium", context, state.scope, "exploration");
		await settle(500);

		const logPath = join(tempDir, "classifierPrompt.jsonl");
		expect(existsSync(logPath)).toBe(true);

		const content = readFileSync(logPath, "utf-8").trim();
		const record: PromptLogRecord = JSON.parse(content);

		expect(record.verdict).toBeNull();
		expect(record.error).toBeDefined();
		expect(record.error!.length).toBeGreaterThan(0);
		expect(record.prompt).toBeDefined();
		expect(record.prompt.length).toBeGreaterThan(0);
	});

	test("two sequential calls → two records appended", async () => {
		const state = makeState(tempDir);
		const config = makeMinimalConfig(true);
		const context = makeMinimalContext([{ role: "user", content: "first prompt" }]);

		spawnClassifierForTurn(state, config, "medium", context, state.scope, "exploration");
		await settle(500);

		// Bump userMessagesSeen so dedup doesn't skip the second call
		state.scope.userMessagesSeen = 1;
		// Clear pendingAgentId so next spawn is allowed
		if (state.calibration) {
			state.calibration.pendingAgentId = undefined;
		}

		const context2 = makeMinimalContext([{ role: "user", content: "second prompt" }]);
		spawnClassifierForTurn(state, config, "low", context2, state.scope, "implementation");
		await settle(500);

		const logPath = join(tempDir, "classifierPrompt.jsonl");
		expect(existsSync(logPath)).toBe(true);

		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines.length).toBe(2);

		const r1: PromptLogRecord = JSON.parse(lines[0]);
		const r2: PromptLogRecord = JSON.parse(lines[1]);
		expect(r1.heuristicTier).toBe("medium");
		expect(r2.heuristicTier).toBe("low");
	});

	test("bucket field flows through", async () => {
		const state = makeState(tempDir);
		const config = makeMinimalConfig(true);
		const context = makeMinimalContext([{ role: "user", content: "test prompt" }]);

		spawnClassifierForTurn(state, config, "medium", context, state.scope, "implementation");
		await settle(500);

		const logPath = join(tempDir, "classifierPrompt.jsonl");
		expect(existsSync(logPath)).toBe(true);

		const content = readFileSync(logPath, "utf-8").trim();
		const record: PromptLogRecord = JSON.parse(content);
		expect(record.bucket).toBe("implementation");
	});
});
