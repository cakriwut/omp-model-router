import { describe, test, expect } from "bun:test";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

		// Add 20 decisions (more than default limit of 5)
		for (let i = 0; i < 20; i++) {
			state.recordDecision(createMockDecision("medium", Date.now() + i));
		}

		// Should only keep last 5 (MAX_DEBUG_HISTORY)
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

	test("debugVerbose defaults to false — session JSONL entry is never written", () => {
		const written: unknown[] = [];
		const api: any = { appendEntry: (_type: string, data: unknown) => written.push(data) };
		const state = new RouterState(api);
		state.currentConfig = { ...mockConfig, debugVerbose: false };
		// persist() writes to disk only; no appendEntry call expected
		state.persist();
		// Allow debounce to flush (persistNow skips appendEntry when debugVerbose=false)
		expect(written.length).toBe(0);
	});

	test("debugVerbose=true emits lean entry: debugHistoryCount present, debugHistory absent", () => {
		const written: any[] = [];
		const api: any = { appendEntry: (_type: string, data: unknown) => written.push(data) };
		const state = new RouterState(api);
		state.currentConfig = { ...mockConfig, debugVerbose: true };
		state.routerEnabled = true;

		for (let i = 0; i < 3; i++) {
			state.recordDecision(createMockDecision("medium", Date.now() + i));
		}
		// Force immediate persist (bypass debounce)
		state.persist();

		expect(written.length).toBe(1);
		expect(written[0]).toHaveProperty("debugHistoryCount", 3);
		expect(written[0]).not.toHaveProperty("debugHistory");
	});

	test("appendDebugEntry writes one line per decision to paired .debug.jsonl", () => {
		// Set up a temp session file path so debugFilePath returns something real.
		const sessionFile = join(tmpdir(), `router-test-${Date.now()}.jsonl`);
		const debugFile = sessionFile.replace(/\.jsonl$/, ".debug.jsonl");

		const api: any = { appendEntry: () => {} };
		const state = new RouterState(api);
		state.currentConfig = mockConfig;

		// Inject a mock ctx with a real sessionFile path.
		state.lastExtensionContext = {
			sessionManager: { sessionFile },
		} as any;

		const decisions = [
			createMockDecision("high", 1000),
			createMockDecision("low", 2000),
			createMockDecision("medium", 3000),
		];
		for (const d of decisions) state.recordDecision(d);

		expect(existsSync(debugFile)).toBe(true);
		const lines = readFileSync(debugFile, "utf-8").trim().split("\n");
		expect(lines.length).toBe(3);

		const parsed = lines.map((l) => JSON.parse(l));
		expect(parsed[0].tier).toBe("high");
		expect(parsed[1].tier).toBe("low");
		expect(parsed[2].tier).toBe("medium");
		// turn field is userMessagesSeen (0 when no messages seen yet)
		expect(typeof parsed[0].turn).toBe("number");

		// Cleanup
		unlinkSync(debugFile);
	});
});
