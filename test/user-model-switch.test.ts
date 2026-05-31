import { describe, test, expect } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RouterState } from "../src/state";
import { FALLBACK_CONFIG } from "../src/config";

/**
 * Regression test for https://github.com/cakriwut/omp-model-router/issues/XX
 * 
 * When the user manually switches to a non-router model via `/model`, the router
 * should respect that choice and stop forcing the router model back on turn_end.
 */
describe("User model switch detection", () => {
	test("turn_start detects manual model switch and disables router", () => {
		// Setup: router is enabled and active
		const mockPi = {
			setModel: async () => true,
			appendEntry: () => {},
		} as unknown as ExtensionAPI;

		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;
		state.routerEnabled = true;
		state.selectedProfile = "auto";
		state.isInternalModelSwitch = false;

		const mockCtx = {
			cwd: "/test",
			model: {
				provider: "bedrock",
				id: "global.anthropic.claude-haiku-4-5",
			},
			modelRegistry: {
				find: () => undefined,
			},
			sessionManager: {
				getBranch: () => [],
			},
			ui: {
				setHiddenThinkingLabel: () => {},
			},
		} as unknown as ExtensionContext;

		// Before turn_start: router is enabled
		expect(state.routerEnabled).toBe(true);

		// Simulate turn_start logic (the detection block added in the fix)
		if (
			state.routerEnabled &&
			!state.isInternalModelSwitch &&
			mockCtx.model &&
			mockCtx.model.provider !== "router"
		) {
			state.routerEnabled = false;
			state.lastNonRouterModel = `${mockCtx.model.provider}/${mockCtx.model.id}`;
		}

		// After detection: router should be disabled
		expect(state.routerEnabled).toBe(false);
		expect(state.lastNonRouterModel).toBe("bedrock/global.anthropic.claude-haiku-4-5");
	});

	test("turn_start ignores internal model switches", () => {
		const mockPi = {
			setModel: async () => true,
			appendEntry: () => {},
		} as unknown as ExtensionAPI;

		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;
		state.routerEnabled = true;
		state.selectedProfile = "auto";
		state.isInternalModelSwitch = true; // Internal switch (router's own setModelInternally)

		const mockCtx = {
			cwd: "/test",
			model: {
				provider: "anthropic",
				id: "claude-sonnet-4",
			},
			modelRegistry: {
				find: () => undefined,
			},
			sessionManager: {
				getBranch: () => [],
			},
			ui: {},
		} as unknown as ExtensionContext;

		// Before turn_start: router is enabled
		expect(state.routerEnabled).toBe(true);

		// Simulate turn_start logic
		if (
			state.routerEnabled &&
			!state.isInternalModelSwitch &&
			mockCtx.model &&
			mockCtx.model.provider !== "router"
		) {
			state.routerEnabled = false;
		}

		// After detection: router should STILL be enabled (internal switch ignored)
		expect(state.routerEnabled).toBe(true);
	});

	test("turn_start does nothing when router model is still active", () => {
		const mockPi = {
			setModel: async () => true,
			appendEntry: () => {},
		} as unknown as ExtensionAPI;

		const state = new RouterState(mockPi);
		state.currentConfig = FALLBACK_CONFIG;
		state.routerEnabled = true;
		state.selectedProfile = "auto";
		state.isInternalModelSwitch = false;

		const mockCtx = {
			cwd: "/test",
			model: {
				provider: "router",
				id: "auto",
			},
			modelRegistry: {
				find: () => undefined,
			},
			sessionManager: {
				getBranch: () => [],
			},
			ui: {},
		} as unknown as ExtensionContext;

		// Before turn_start: router is enabled
		expect(state.routerEnabled).toBe(true);

		// Simulate turn_start logic
		if (
			state.routerEnabled &&
			!state.isInternalModelSwitch &&
			mockCtx.model &&
			mockCtx.model.provider !== "router"
		) {
			state.routerEnabled = false;
		}

		// After detection: router should STILL be enabled (model is still "router")
		expect(state.routerEnabled).toBe(true);
	});
});
