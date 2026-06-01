/**
 * Tests for parent session attribution via RouterState.activateSession.
 * Covers spec scenarios 5.1–5.9: header wins, fallback, late-binding,
 * no-overwrite, integration rollup, and error-resilience.
 */
import { describe, test, expect, spyOn } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RouterState } from "../src/state";
import type { SessionScope } from "../src/state";
import { FALLBACK_CONFIG } from "../src/config";

// ─── Minimal ExtensionAPI mock ────────────────────────────────────────────────

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

// ─── Internal state accessor (private field, test-only) ───────────────────────

interface RouterStateInternal {
	sessionScopes: Map<string, SessionScope>;
}

function scopes(state: RouterState): Map<string, SessionScope> {
	return (state as unknown as RouterStateInternal).sessionScopes;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("5.x Parent session attribution", () => {
	// 5.1 — Header provides parent at scope creation
	test("5.1: header-sourced parentSessionId is stored on scope creation", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		state.activateSession("child-1", "parent-1", "header");

		expect(scopes(state).get("child-1")?.parentSessionId).toBe("parent-1");
	});

	// 5.2 — Root session, no parent
	test("5.2: root session with no parent stores undefined parentSessionId", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		state.activateSession("root-1", undefined, "none");

		expect(scopes(state).get("root-1")?.parentSessionId).toBeUndefined();
	});

	// 5.3 — Fallback: header absent, previous session active
	test("5.3: fallback-sourced parent is stored when header absent", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		state.activateSession("parent-1");
		state.activateSession("child-1", "parent-1", "fallback");

		expect(scopes(state).get("child-1")?.parentSessionId).toBe("parent-1");
	});

	// 5.4 — Debug log emitted on header-sourced attribution
	test("5.4: debug log emitted when source=header and debug is enabled", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = { ...FALLBACK_CONFIG, debug: true };

		const spy = spyOn(console, "log");

		state.activateSession("child-1", "header-parent", "header");

		expect(scopes(state).get("child-1")?.parentSessionId).toBe("header-parent");

		const logged = spy.mock.calls.some(
			(args) =>
				typeof args[0] === "string" &&
				args[0].includes("parent attribution: child=child-1 source=header"),
		);
		expect(logged).toBe(true);

		spy.mockRestore();
	});

	// 5.5 — Repeated activation does NOT overwrite existing non-undefined parent
	test("5.5: second activateSession with a different parent does not overwrite the first", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		state.activateSession("child-1", "P1", "header");
		// Second call: scope already exists, P1 must survive
		state.activateSession("child-1", "P2", "header");

		expect(scopes(state).get("child-1")?.parentSessionId).toBe("P1");
	});

	// 5.6 — Late binding: first activation with undefined, then defined
	test("5.6: undefined parent is late-bound to a defined value on subsequent activation", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		state.activateSession("child-1", undefined, "none");
		expect(scopes(state).get("child-1")?.parentSessionId).toBeUndefined();

		// Second call provides the parent; late-binding should apply
		state.activateSession("child-1", "P", "header");

		expect(scopes(state).get("child-1")?.parentSessionId).toBe("P");
	});

	// 5.7 — Integration: finalizeChildSession rolls cost into parent
	test("5.7: finalizeChildSession rolls up child cost to parent and deletes child scope", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		// Set up parent scope
		state.activateSession("parent-1", undefined, "none");
		const parentInitialCost = state.accumulatedCost; // 0

		// Set up child scope under parent
		state.activateSession("child-1", "parent-1", "header");
		state.accumulatedCost = 0.42; // write into child scope (activeSessionId = child-1)

		// Finalize child
		state.finalizeChildSession("child-1");

		// Reactivate parent (scope already exists, just sets activeSessionId)
		state.activateSession("parent-1");

		expect(state.accumulatedCost).toBeCloseTo(parentInitialCost + 0.42, 9);
		expect(scopes(state).get("child-1")).toBeUndefined();
	});

	// 5.8 — getHeader throws: activation completes without exception
	test("5.8: activateSession completes normally when parentSessionId is undefined (error path)", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		// Simulate the try/catch in resolveParentFromHeader returning undefined
		expect(() =>
			state.activateSession("child-1", undefined, "none"),
		).not.toThrow();

		expect(scopes(state).get("child-1")).toBeDefined();
		expect(scopes(state).get("child-1")?.parentSessionId).toBeUndefined();
	});

	// 5.9 — resolveParentFromHeader returns undefined when getHeader returns null
	// (Observed via the session_start integration path: same assertion as 5.2)
	test("5.9: getHeader()=null path produces undefined parentSessionId (alias of 5.2)", () => {
		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;

		// resolveParentFromHeader returns undefined when getHeader() returns null;
		// the caller then passes undefined to activateSession with source "none".
		state.activateSession("root-2", undefined, "none");

		expect(scopes(state).get("root-2")?.parentSessionId).toBeUndefined();
	});
});
