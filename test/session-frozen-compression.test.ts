import { describe, test, expect } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RouterState } from "../src/state";
import { FALLBACK_CONFIG } from "../src/config";
import type { CompressionStats } from "../src/types";

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

function makeState(): RouterState {
	const state = new RouterState(mockPi);
	state.currentConfig = FALLBACK_CONFIG;
	return state;
}

const stubStats: CompressionStats = {
	compressedMessages: 5,
	originalChars: 1000,
	compressedChars: 200,
};

describe("frozenCompressionBlock is per-session", () => {
	test("isolated per session — setting on A is not visible from B", () => {
		const state = makeState();

		state.activateSession("session-A", undefined, "none");
		state.frozenCompressionBlock = { messages: [], stats: stubStats };

		state.activateSession("session-B", undefined, "none");
		expect(state.frozenCompressionBlock).toBeUndefined();

		state.activateSession("session-A");
		expect(state.frozenCompressionBlock).toBeDefined();
		expect(state.frozenCompressionBlock!.stats).toEqual(stubStats);
	});

	test("writing to one session does not affect another", () => {
		const state = makeState();

		const statsX: CompressionStats = { compressedMessages: 3, originalChars: 500, compressedChars: 100 };
		const statsY: CompressionStats = { compressedMessages: 7, originalChars: 2000, compressedChars: 400 };

		state.activateSession("session-A", undefined, "none");
		state.frozenCompressionBlock = { messages: [], stats: statsX };

		state.activateSession("session-B", undefined, "none");
		state.frozenCompressionBlock = { messages: [], stats: statsY };

		// Switch back — A should still have statsX
		state.activateSession("session-A");
		expect(state.frozenCompressionBlock!.stats).toEqual(statsX);

		// B should still have statsY
		state.activateSession("session-B");
		expect(state.frozenCompressionBlock!.stats).toEqual(statsY);
	});

	test("cleared independently per session", () => {
		const state = makeState();

		state.activateSession("session-A", undefined, "none");
		state.frozenCompressionBlock = { messages: [], stats: stubStats };

		// Clear A
		state.frozenCompressionBlock = undefined;

		// B was never set
		state.activateSession("session-B", undefined, "none");
		expect(state.frozenCompressionBlock).toBeUndefined();

		// A should remain cleared
		state.activateSession("session-A");
		expect(state.frozenCompressionBlock).toBeUndefined();
	});
});
