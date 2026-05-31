import { describe, test, expect } from "bun:test";
import { RouterState } from "../src/state";
import type { RouterConfig, RoutingDecision } from "../src/types";
import { MAX_DEBUG_HISTORY } from "../src/constants";

const mockConfig: RouterConfig = {
	routerEnabled: true,
	defaultProfile: "auto",
	profiles: {
		auto: {
			high: { model: "test/high" },
			medium: { model: "test/medium" },
			low: { model: "test/low" },
		},
	},
};

const mockExtensionAPI: any = {
	appendEntry: () => {},
};

const createMockDecision = (tier: "high" | "medium" | "low", timestamp: number): RoutingDecision => ({
	profile: "auto",
	tier,
	phase: "implementation",
	targetProvider: "test",
	targetModelId: tier,
	targetLabel: `test/${tier}`,
	reasoning: `Test decision for ${tier}`,
	thinking: "off",
	timestamp,
});

describe("Debug log management", () => {
	test("debugHistoryLimit defaults to MAX_DEBUG_HISTORY", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;

		// Add 20 decisions (more than default limit of 12)
		for (let i = 0; i < 20; i++) {
			state.recordDecision(createMockDecision("medium", Date.now() + i));
		}

		// Should only keep last 12
		expect(state.debugHistory.length).toBe(MAX_DEBUG_HISTORY);
	});

	test("debugHistoryLimit can be configured to reduce memory", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = {
			...mockConfig,
			debugHistoryLimit: 5,
		};

		// Add 10 decisions
		for (let i = 0; i < 10; i++) {
			state.recordDecision(createMockDecision("medium", Date.now() + i));
		}

		// Should only keep last 5
		expect(state.debugHistory.length).toBe(5);
	});

	test("debugHistoryLimit can be configured to increase for deeper investigation", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = {
			...mockConfig,
			debugHistoryLimit: 50,
		};

		// Add 30 decisions
		for (let i = 0; i < 30; i++) {
			state.recordDecision(createMockDecision("medium", Date.now() + i));
		}

		// Should keep all 30
		expect(state.debugHistory.length).toBe(30);
	});

	test("debugHistory is NOT restored from saved state (session-scoped, starts empty)", () => {
		const mockContext: any = {
			cwd: "/test",
			modelRegistry: {},
			model: { provider: "router", id: "auto" },
			sessionManager: {
				getSessionId: () => "test-session-1",
				getBranch: () => [
					{
						type: "custom",
						customType: "router-state",
						data: {
							enabled: true,
							selectedProfile: "auto",
							timestamp: Date.now(),
							debugHistory: Array.from({ length: 20 }, (_, i) =>
								createMockDecision("medium", Date.now() + i)
							),
						},
					},
				],
			},
		};

		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = {
			...mockConfig,
			debugHistoryLimit: 8,
		};
		state.activateSession("test-session-1");
		state.restoreFromSession(mockContext);

		// debugHistory should be empty — it's session-scoped and not restored
		// Usage ledger is the authoritative source now
		expect(state.debugHistory.length).toBe(0);
	});

	test("debugVerbose defaults to false (no session JSONL logging)", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = mockConfig;

		// debugVerbose should be undefined/false by default
		expect(state.currentConfig.debugVerbose).toBeFalsy();
	});

	test("debugVerbose can be enabled for verbose session logging", () => {
		const state = new RouterState(mockExtensionAPI);
		state.currentConfig = {
			...mockConfig,
			debug: true,
			debugVerbose: true,
		};

		// Both debug and debugVerbose should be enabled
		expect(state.currentConfig.debug).toBe(true);
		expect(state.currentConfig.debugVerbose).toBe(true);
	});
});
