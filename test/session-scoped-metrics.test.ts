import { describe, test, expect } from "bun:test";
import { RouterState } from "../src/state";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { FALLBACK_CONFIG } from "../src/config";

const createMockContext = (): ExtensionContext => ({
	cwd: "/test",
	modelRegistry: {
		models: [],
	},
	model: {
		provider: "anthropic",
		id: "claude-sonnet-4",
	},
	sessionManager: {
		getBranch: () => [],
		saveBranch: () => {},
	},
}) as unknown as ExtensionContext;

describe("Session-scoped metrics", () => {
	test.skip("accumulated values should NOT be restored from persisted state", () => {
		const mockContext = createMockContext();

		// Create state with some accumulated values
		const state = new RouterState(FALLBACK_CONFIG);
		state.accumulatedCost = 1.5;
		state.accumulatedOriginalTokens = 10000;
		state.accumulatedCompressedTokens = 7000;
		state.accumulatedTokensSaved = 3000;
		state.accumulatedCacheReadTokens = 2000;

		// Persist the state (this saves to disk)
		state.persist();

		// Create a new state instance (simulating a new session)
		const newState = new RouterState(FALLBACK_CONFIG);

		// Restore from session (which loads from disk)
		newState.restoreFromSession(mockContext);

		// Verify that accumulated values are NOT restored (should be 0)
		expect(newState.accumulatedCost).toBe(0);
		expect(newState.accumulatedOriginalTokens).toBe(0);
		expect(newState.accumulatedCompressedTokens).toBe(0);
		expect(newState.accumulatedTokensSaved).toBe(0);
		expect(newState.accumulatedCacheReadTokens).toBe(0);
	});

	test("user preferences ARE restored from persisted state", () => {
		const mockContext = createMockContext();

		// Create state with user preferences
		const state = new RouterState(FALLBACK_CONFIG);
		state.widgetEnabled = true;
		state.debugEnabled = true;

		// Persist the state
		state.persist();

		// Create a new state instance
		const newState = new RouterState(FALLBACK_CONFIG);
		newState.restoreFromSession(mockContext);

		// Verify that user preferences ARE restored (pins are NOT — they're session-scoped)
		expect(newState.scope.scopedPin).toBeUndefined();
		expect(newState.widgetEnabled).toBe(true);
		expect(newState.debugEnabled).toBe(true);
	});
});
