import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RouterState } from "../src/state";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { RouterPersistedState } from "../src/types";

/**
 * Test: accumulated metrics (cost, tokens, cache) should always start at 0
 * for a new session, even if they had non-zero values before restoreFromSession.
 *
 * Context: Bug where "/router usage" showed misleading metrics on fresh sessions
 * because accumulated* fields were restored from previous session's persisted state.
 *
 * Fix: restoreFromSession() resets accumulated metrics to 0 and does NOT restore
 * them from persisted state.
 */

describe("Session metrics reset", () => {
	const TEST_DIR = join(process.cwd(), ".test-router-state");

	const mockPi = {
		appendEntry: () => {},
	};

	const mockCtx = {
		sessionManager: {
			getBranch: () => [],
		},
		model: { provider: "openai", id: "gpt-4o" },
		modelRegistry: {},
		cwd: TEST_DIR,
	};

	beforeEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	test("accumulated metrics should reset to 0 on new session", () => {
		// ─── Setup: RouterState with non-zero metrics ─────────────────
		const state = new RouterState(mockPi as any);
		state.currentConfig = {
			routerEnabled: true,
			defaultProfile: "auto",
			profiles: {},
		};

		// Simulate old session with accumulated metrics
		state.activateSession("old-session");
		state.accumulatedCost = 5.0;
		state.accumulatedOriginalTokens = 500000;
		state.accumulatedCompressedTokens = 250000;
		state.accumulatedTokensSaved = 222000;
		state.accumulatedCacheReadTokens = 7961800;

		// ─── Act: start a new session (different ID → fresh scope) ──
		state.activateSession("new-session");
		state.restoreFromSession(mockCtx as any);

		// ─── Assert: all accumulated metrics should be 0 (new scope) ─────
		expect(state.accumulatedCost).toBe(0);
		expect(state.accumulatedOriginalTokens).toBe(0);
		expect(state.accumulatedCompressedTokens).toBe(0);
		expect(state.accumulatedTokensSaved).toBe(0);
		expect(state.accumulatedCacheReadTokens).toBe(0);
	});

	test("accumulated metrics should remain 0 even with session entries", () => {
		// ─── Setup: mock session entries with non-zero metrics ────────
		const sessionState: RouterPersistedState = {
			enabled: true,
			selectedProfile: "auto",
			debugEnabled: true,
			widgetEnabled: false,
			debugHistory: [],
			accumulatedCost: 10.0,
			accumulatedOriginalTokens: 1000000,
			accumulatedCompressedTokens: 500000,
			accumulatedTokensSaved: 300000,
			accumulatedCacheReadTokens: 5000000,
			timestamp: Date.now(),
		};

		const mockCtxWithSession = {
			...mockCtx,
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "router-state",
						data: sessionState,
					},
				],
			},
		};

		// ─── Act: create new RouterState and restore ──────────────────
		const state = new RouterState(mockPi as any);
		state.currentConfig = {
			routerEnabled: true,
			defaultProfile: "auto",
			profiles: {},
		};
		state.restoreFromSession(mockCtxWithSession as any);

		// ─── Assert: accumulated metrics should still be 0 ────────────
		expect(state.accumulatedCost).toBe(0);
		expect(state.accumulatedOriginalTokens).toBe(0);
		expect(state.accumulatedCompressedTokens).toBe(0);
		expect(state.accumulatedTokensSaved).toBe(0);
		expect(state.accumulatedCacheReadTokens).toBe(0);

		// ─── Assert: other fields should be restored from session ─────
		expect(state.debugEnabled).toBe(true);
		expect(state.widgetEnabled).toBe(false);
	});
});
