/**
 * Tests for the classifierPrompt.jsonl prompt-log feature (sync path).
 * Mocks runClassifier via mock.module and tests resolveRouting directly.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RouterTier } from "../src/types";
import type { PromptLogRecord } from "../src/calibration/trace";
import type { SessionCalibration } from "../src/calibration/types";
import type { SessionScope } from "../src/state";

// ─── Mock runClassifier ──────────────────────────────────────────────────────

let mockVerdict: { tier: RouterTier; reasoning: string } | undefined = {
	tier: "high",
	reasoning: "broad investigation",
};

mock.module("../src/routing/index.js", () => ({
	runClassifier: async () => mockVerdict,
}));

import { resolveRouting, type RoutingInput, type RoutingConfig } from "../src/routing/compose";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScope(overrides: Partial<SessionScope> = {}): SessionScope {
	return {
		sessionId: "test-session",
		accumulatedCost: 0,
		debugHistory: [],
		lastDecision: undefined,
		isStreaming: false,
		tierCounter: { high: 0, medium: 0, low: 0 },
		modelCosts: new Map(),
		lastClassifierKey: undefined,
		lastClassifierVerdict: undefined,
		classifierTurnsSinceRun: 0,
		userMessagesSeen: 1,
		lastUserEntryId: undefined,
		...overrides,
	};
}

function makeCalibration(): SessionCalibration {
	return {
		matrix: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
		totalComparisons: 0,
		llmCallsAttempted: 0,
		llmCallsFailed: 0,
		sessionStartTime: Date.now(),
		turnsProcessed: 3,
	};
}

const stubRegistry = {
	find: () => ({
		id: "model",
		provider: "anthropic",
		contextWindow: 200_000,
		cost: { input: 0.001, output: 0.003 },
		input: ["text"],
		output: ["text"],
	}),
	getApiKey: async () => "key",
	getProviders: () => [],
	registerProvider: () => {},
} as unknown as RoutingInput["modelRegistry"];

function makeInput(scope: SessionScope): RoutingInput {
	return {
		context: { messages: [{ role: "user", content: "test prompt for classification" }] },
		previousDecision: undefined,
		isBudgetExceeded: false,
		modelRegistry: stubRegistry,
		calibration: makeCalibration(),
		scope,
	};
}

function makeConfig(promptLogPath?: string): RoutingConfig {
	return {
		profileName: "auto",
		profile: {
			high: { model: "openai/gpt-4o" },
			medium: { model: "anthropic/claude-sonnet-4" },
			low: { model: "anthropic/claude-haiku-3" },
		},
		phaseBias: 0,
		classifierModel: "anthropic/claude-3-haiku-20240307",
		calibrationConfig: {
			enabled: true,
			mode: "telemetry",
			warmupTurns: 0,
			overrideThreshold: 0.65,
			traceEnabled: false,
			useGlobalPrior: false,
			globalPriorWeight: 0.1,
		},
		promptLogPath,
	};
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "classifier-prompt-log-"));
	mockVerdict = { tier: "high", reasoning: "broad investigation" };
});

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("classifierPrompt.jsonl", () => {
	test("no promptLogPath → no file created", async () => {
		const scope = makeScope();
		const input = makeInput(scope);
		const config = makeConfig(undefined);

		await resolveRouting(input, config);

		const logPath = join(tempDir, "classifierPrompt.jsonl");
		expect(existsSync(logPath)).toBe(false);
	});

	test("fresh call → file created with correct record fields", async () => {
		const logPath = join(tempDir, "classifierPrompt.jsonl");
		const scope = makeScope();
		const input = makeInput(scope);
		const config = makeConfig(logPath);

		await resolveRouting(input, config);

		expect(existsSync(logPath)).toBe(true);

		const content = readFileSync(logPath, "utf-8").trim();
		const record: PromptLogRecord = JSON.parse(content);

		expect(record.prompt).toStartWith("<task>");
		expect(record.verdict).not.toBeNull();
		expect(record.verdict!.tier).toBe("high");
		expect(["low", "medium", "high"]).toContain(record.heuristicTier);
		expect(record.latencyMs).toBeGreaterThanOrEqual(0);
		expect(typeof record.turnIndex).toBe("number");
		expect(typeof record.userMsgIndex).toBe("number");
		expect(typeof record.timestamp).toBe("string");
	});

	test("cache hit → no file written", async () => {
		const logPath = join(tempDir, "classifierPrompt.jsonl");
		const scope = makeScope();
		const input = makeInput(scope);
		const config = makeConfig(logPath);

		// Pre-seed cache: set lastClassifierKey to what resolveRouting will compute
		// sig = `${lastUserText}|${userMsgIndex}|${bucket}`
		// lastUserText = "test prompt for classification", userMsgIndex = 1, bucket = "fresh" (no tool calls → fresh)
		scope.lastClassifierKey = "test prompt for classification|1|fresh";
		scope.lastClassifierVerdict = { tier: "high", reasoning: "cached" };
		scope.classifierTurnsSinceRun = 0;

		await resolveRouting(input, config);

		expect(existsSync(logPath)).toBe(false);
	});

	test("failed verdict → file created with verdict: null and error", async () => {
		mockVerdict = undefined;
		const logPath = join(tempDir, "classifierPrompt.jsonl");
		const scope = makeScope();
		const input = makeInput(scope);
		const config = makeConfig(logPath);

		await resolveRouting(input, config);

		expect(existsSync(logPath)).toBe(true);

		const content = readFileSync(logPath, "utf-8").trim();
		const record: PromptLogRecord = JSON.parse(content);

		expect(record.verdict).toBeNull();
		expect(record.error).toBeDefined();
		expect(record.prompt.length).toBeGreaterThan(0);
	});
});
