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
	test.skip("new session initializes lastTurnTimestamp to prevent immediate trigger", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;
		const ctx: any = mockExtensionContext();

		state.restoreFromSession(ctx);

		expect(state.lastTurnTimestamp).toBeDefined();
		expect(state.lastTurnTimestamp).toBeGreaterThan(Date.now() - 1000); // within 1s of now
		expect(state.compressionRequestCount).toBe(0);
		expect(state.currentCheckpoint).toBeUndefined();
	});

	test.skip("persisted compression state is restored on session reload", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;
		const ctx: any = mockExtensionContext();

		// Simulate first session: set compression state
		state.restoreFromSession(ctx);
		state.compressionRequestCount = 5;
		state.compressionTotalOriginalChars = 100_000;
		state.compressionTotalCompressedChars = 20_000;
		state.lastTurnTimestamp = Date.now() - 10_000; // 10s ago
		state.currentCheckpoint = {
			compressedPrefix: { role: "user", content: "toon compressed" },
			excludedTailMessages: [],
			metadata: {
				originalMessageCount: 10,
				estimatedOriginalTokens: 5000,
				estimatedCompressedTokens: 1000,
				triggerReason: "context_size",
				timestamp: Date.now() - 10_000,
			},
		};

		// Save state (persist() writes to file and session)
		state.persist();

		// Create new state instance (simulates session reload)
		const state2 = new RouterState(mockExtensionAPI);
		state2.currentConfig = mockConfig;
		state2.restoreFromSession(ctx);

		// Verify compression state restored
		expect(state2.compressionRequestCount).toBe(5);
		expect(state2.compressionTotalOriginalChars).toBe(100_000);
		expect(state2.compressionTotalCompressedChars).toBe(20_000);
		expect(state2.lastTurnTimestamp).toBe(state.lastTurnTimestamp);
		expect(state2.currentCheckpoint).toBeDefined();
		expect(state2.currentCheckpoint?.metadata.triggerReason).toBe("context_size");
	});

	test.skip("compression state reset when no saved state exists", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;
		const ctx: any = mockExtensionContext("/test-fresh");

		state.restoreFromSession(ctx);

		expect(state.compressionRequestCount).toBe(0);
		expect(state.compressionTotalOriginalChars).toBe(0);
		expect(state.compressionTotalCompressedChars).toBe(0);
		expect(state.currentCheckpoint).toBeUndefined();
		expect(state.lastTurnTimestamp).toBeDefined();
		expect(state.lastTurnTimestamp).toBeGreaterThan(Date.now() - 1000);
	});
});
