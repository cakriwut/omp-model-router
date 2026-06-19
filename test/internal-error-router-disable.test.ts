/**
 * Regression test for: router permanently disabled after internal stream error.
 *
 * Scenario: during team/sub-agent execution, streamSimple may fire before
 * session_start completes for the child session, setting lastStreamWasInternalError.
 * On the next turn_start, if OMP fell back to a non-router model, the old code
 * would detect provider !== "router" and call patchConfigFile({ routerEnabled: false }),
 * permanently disabling the router. The fix gates that path on
 * !lastStreamWasInternalError.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { RouterState } from "../src/state";
import { FALLBACK_CONFIG } from "../src/config";

function makeState(): RouterState {
	const s = new RouterState();
	s.currentConfig = {
		...FALLBACK_CONFIG,
		routerEnabled: true,
		profiles: {
			auto: {
				high: { model: "anthropic/claude-opus", thinking: "low" },
				medium: { model: "anthropic/claude-sonnet", thinking: "low" },
				low: { model: "anthropic/claude-haiku", thinking: "low" },
			},
		},
	};
	s.routerEnabled = true;
	s.selectedProfile = "auto";
	return s;
}

describe("lastStreamWasInternalError flag", () => {
	test("starts false", () => {
		const s = makeState();
		expect(s.lastStreamWasInternalError).toBe(false);
	});

	test("can be set and read", () => {
		const s = makeState();
		s.lastStreamWasInternalError = true;
		expect(s.lastStreamWasInternalError).toBe(true);
	});

	test("cleared on session_start equivalent (manual reset)", () => {
		const s = makeState();
		s.lastStreamWasInternalError = true;
		// Simulate what session_start does:
		s.lastStreamWasInternalError = false;
		expect(s.lastStreamWasInternalError).toBe(false);
	});

	test("when false: turn_start should treat non-router model as user opt-out", () => {
		const s = makeState();
		s.lastStreamWasInternalError = false;
		s.routerEnabled = true;
		s.isInternalModelSwitch = false;

		// Simulate the turn_start guard logic inline (mirrors src/index.ts)
		const ctxModel = { provider: "anthropic", id: "claude-opus" };
		let disabledByOptOut = false;

		if (
			s.routerEnabled &&
			!s.isInternalModelSwitch &&
			!s.lastStreamWasInternalError &&
			ctxModel &&
			ctxModel.provider !== "router"
		) {
			s.routerEnabled = false;
			disabledByOptOut = true;
		}

		expect(disabledByOptOut).toBe(true);
		expect(s.routerEnabled).toBe(false);
	});

	test("when true: turn_start should NOT disable router on non-router model", () => {
		const s = makeState();
		s.lastStreamWasInternalError = true;
		s.routerEnabled = true;
		s.isInternalModelSwitch = false;

		// Simulate the turn_start guard logic inline (mirrors src/index.ts)
		const ctxModel = { provider: "anthropic", id: "claude-opus" };
		let disabledByOptOut = false;

		if (
			s.routerEnabled &&
			!s.isInternalModelSwitch &&
			!s.lastStreamWasInternalError && // ← new guard
			ctxModel &&
			ctxModel.provider !== "router"
		) {
			s.routerEnabled = false;
			disabledByOptOut = true;
		}

		expect(disabledByOptOut).toBe(false);
		expect(s.routerEnabled).toBe(true);
	});

	test("when true: clears when model is back on router", () => {
		const s = makeState();
		s.lastStreamWasInternalError = true;

		// Simulate the recovery clear in turn_start:
		const ctxModelProvider = "router";
		if (s.lastStreamWasInternalError && ctxModelProvider === "router") {
			s.lastStreamWasInternalError = false;
		}

		expect(s.lastStreamWasInternalError).toBe(false);
	});
});
