import { describe, test, expect, beforeEach } from "bun:test";
import { RouterState } from "../src/state";
import type { RouterConfig } from "../src/types";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

const mockConfig: RouterConfig = {
	routerEnabled: true,
	defaultProfile: "auto",
	profiles: {
		auto: {
			high: { model: "amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0" },
			medium: { model: "amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0" },
			low: { model: "amazon-bedrock/global.anthropic.claude-3-5-haiku-20250121-v1:0" },
		},
	},
	historyCompression: {
		enabled: true,
		keepLastN: 4,
		progressive: {
			enabled: true,
			contextThreshold: 0.8,
			timeThreshold: 300,
		},
	},
};

const mockExtensionContext = (cwd = "/test") => ({
	cwd,
	modelRegistry: {},
	model: { provider: "router", id: "auto" },
	sessionManager: {
		getBranch: () => [],
		saveBranch: () => {},
	},
});

const mockExtensionAPI: any = {
	appendEntry: () => {},
};

// Clean up state file before tests
beforeEach(() => {
	const stateFile = join(getAgentDir(), "model-router", "router-state.json");
	if (existsSync(stateFile)) {
		unlinkSync(stateFile);
	}
});

describe("Session restore compression state", () => {
	// Design: compression counters and checkpoint are session-scoped and always
	// start at zero — they are NOT persisted or restored across sessions.
	// lastTurnTimestamp is set only when a compression turn fires, not on restore.

	test("compression counters start at zero after restoreFromSession", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;
		const ctx: any = mockExtensionContext();

		state.restoreFromSession(ctx);

		expect(state.compressionRequestCount).toBe(0);
		expect(state.compressionTotalOriginalChars).toBe(0);
		expect(state.compressionTotalCompressedChars).toBe(0);
		expect(state.currentCheckpoint).toBeUndefined();
	});

	test("lastTurnTimestamp is undefined after restoreFromSession (set on first compression turn)", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;
		const ctx: any = mockExtensionContext();

		state.restoreFromSession(ctx);

		// lastTurnTimestamp is NOT initialised by restoreFromSession.
		// It is set by provider.ts after a compression turn completes.
		// Starting as undefined ensures progressive TOON skips the time-threshold
		// check on the very first turn (no stale timestamp to compare against).
		expect(state.lastTurnTimestamp).toBeUndefined();
	});

	test("compression counters are NOT restored from persisted state (always session-fresh)", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;
		const ctx: any = mockExtensionContext();

		state.restoreFromSession(ctx);

		// Simulate mid-session compression activity
		state.compressionRequestCount = 5;
		state.compressionTotalOriginalChars = 100_000;
		state.compressionTotalCompressedChars = 20_000;
		state.lastTurnTimestamp = Date.now() - 10_000;

		// Persist current state to disk
		state.persist();

		// New state instance restoring from same session — compression counters must NOT carry over
		const state2 = new RouterState(mockExtensionAPI);
		state2.currentConfig = mockConfig;
		state2.restoreFromSession(ctx);

		expect(state2.compressionRequestCount).toBe(0);
		expect(state2.compressionTotalOriginalChars).toBe(0);
		expect(state2.compressionTotalCompressedChars).toBe(0);
		expect(state2.lastTurnTimestamp).toBeUndefined();
		expect(state2.currentCheckpoint).toBeUndefined();
	});
});
