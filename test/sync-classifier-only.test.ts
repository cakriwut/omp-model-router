/**
 * Tests for sync-only classifier behavior via resolveRouting.
 * Mocks runClassifier to return controlled verdicts.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RouterTier } from "../src/types";
import type { SessionCalibration } from "../src/calibration/types";
import type { PromptLogRecord } from "../src/calibration/trace";
import type { SessionScope } from "../src/state";

// ─── Mock runClassifier ──────────────────────────────────────────────────────

let mockVerdict: { tier: RouterTier; reasoning: string } | undefined = {
	tier: "high",
	reasoning: "complex multi-file refactor",
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
		turnsProcessed: 5,
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

function makeInput(overrides: Partial<RoutingInput> = {}): RoutingInput {
	return {
		context: { messages: [{ role: "user", content: "refactor the auth module" }] },
		previousDecision: undefined,
		isBudgetExceeded: false,
		modelRegistry: stubRegistry,
		calibration: makeCalibration(),
		scope: makeScope(),
		...overrides,
	};
}

function makeConfig(mode: "adaptive" | "telemetry", promptLogPath?: string): RoutingConfig {
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
			mode,
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
	tempDir = mkdtempSync(join(tmpdir(), "sync-classifier-"));
	mockVerdict = { tier: "high", reasoning: "complex multi-file refactor" };
});

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Sync classifier only", () => {
	test("telemetry mode: matrix updated but heuristic decision stands", async () => {
		// Mock → high. The calibration matrix should record heuristic vs classifier,
		// but the routing decision must remain the heuristic tier (medium for a short message).
		const cal = makeCalibration();
		const input = makeInput({ calibration: cal });
		const config = makeConfig("telemetry");

		const decision = await resolveRouting(input, config);

		// Matrix records [heuristicIndex][classifierIndex] regardless of mode
		// Heuristic for a short message = "medium" (index 1), classifier = "high" (index 2).
		expect(cal.matrix[1][2]).toBeGreaterThanOrEqual(1);
		// Heuristic tier must NOT be overridden in telemetry mode
		expect(decision.tier).toBe("medium");
		expect(decision.isTelemetry).toBe(true);
	});

	test("adaptive mode: classifier verdict used for routing", async () => {
		const cal = makeCalibration();
		const input = makeInput({ calibration: cal });
		const config = makeConfig("adaptive");

		const decision = await resolveRouting(input, config);

		// Classifier verdict (high) overrides heuristic
		expect(decision.tier).toBe("high");
		expect(decision.isClassifier).toBe(true);
	});

	test("prompt log on fresh call: file created with correct data", async () => {
		const logPath = join(tempDir, "classifierPrompt.jsonl");
		const input = makeInput();
		const config = makeConfig("adaptive", logPath);

		await resolveRouting(input, config);

		expect(existsSync(logPath)).toBe(true);

		const content = readFileSync(logPath, "utf-8").trim();
		const record: PromptLogRecord = JSON.parse(content);

		expect(record.verdict?.tier).toBe("high");
		expect(record.prompt.length).toBeGreaterThan(0);
		expect(record.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test("no prompt log on cache hit", async () => {
		const logPath = join(tempDir, "classifierPrompt.jsonl");
		// Pre-seed scope with matching cache key
		// sig = `${lastUserText}|${userMsgIndex}|${bucket}`
		const scope = makeScope({
			lastClassifierKey: "refactor the auth module|1|fresh",
			lastClassifierVerdict: { tier: "high", reasoning: "cached" },
			classifierTurnsSinceRun: 0,
		});
		const input = makeInput({ scope });
		const config = makeConfig("adaptive", logPath);

		await resolveRouting(input, config);

		// Cache hit → no file written
		expect(existsSync(logPath)).toBe(false);
	});

	test("syncClassifierRan field absent from RoutingDecision", async () => {
		const input = makeInput();
		const config = makeConfig("adaptive");

		const decision = await resolveRouting(input, config);

		// The field should not be set (deleted from interface or at least not present)
		expect("syncClassifierRan" in decision).toBe(false);
	});
});
