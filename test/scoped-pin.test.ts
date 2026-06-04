import { describe, it, expect, beforeEach } from "bun:test";
import {
	resolveEffectivePin,
	setScopedPin,
	clearScopedPin,
	DEFAULT_PIN_TIMEOUT_MS,
} from "../src/routing/pin";
import type { RouterTier, ScopedPin } from "../src/types";
import type { RoutingDecision } from "../src/types";

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

interface MinimalScope {
	scopedPin?: ScopedPin;
	lastDecision?: RoutingDecision | undefined;
}

function makeScope(overrides: Partial<MinimalScope> = {}): MinimalScope {
	return {
		scopedPin: undefined,
		lastDecision: undefined,
		...overrides,
	};
}

function makePin(tier: RouterTier, offsetMs = 0, source: ScopedPin["source"] = "user"): ScopedPin {
	return { tier, setAt: Date.now() - offsetMs, source };
}

const cfgAuto = { defaultPin: "auto" as const };
const cfgUndefined = {} as { defaultPin?: undefined; pinTimeout?: undefined };
const cfgHigh = { defaultPin: "high" as RouterTier };
const cfgMedium = { defaultPin: "medium" as RouterTier };
const timeout10m = { pinTimeout: 600_000 };

// ─── resolveEffectivePin ──────────────────────────────────────────────────────

describe("resolveEffectivePin", () => {
	it("returns undefined scopedPin and floor when no scopedPin and defaultPin is 'auto'", () => {
		const scope = makeScope();
		const r = resolveEffectivePin(scope as any, cfgAuto);
		expect(r.scopedPin).toBeUndefined();
		expect(r.floor).toBeUndefined();
	});

	it("returns undefined scopedPin and floor when no scopedPin and defaultPin is undefined", () => {
		const scope = makeScope();
		const r = resolveEffectivePin(scope as any, cfgUndefined);
		expect(r.scopedPin).toBeUndefined();
		expect(r.floor).toBeUndefined();
	});

	it("returns floor='high' when no scopedPin and defaultPin is 'high'", () => {
		const scope = makeScope();
		const r = resolveEffectivePin(scope as any, cfgHigh);
		expect(r.scopedPin).toBeUndefined();
		expect(r.floor).toBe("high");
	});

	it("returns scopedPin.tier when pin is active (setAt = now-5min, timeout=10min)", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("medium", FIVE_MIN, "heuristic") });
		const r = resolveEffectivePin(scope as any, timeout10m);
		expect(r.scopedPin).toBe("medium");
	});

	it("does NOT clear scopedPin when active", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const pin = makePin("low", FIVE_MIN, "classifier");
		const scope = makeScope({ scopedPin: pin });
		resolveEffectivePin(scope as any, timeout10m);
		expect(scope.scopedPin).toBe(pin);
	});

	it("clears scopedPin when expired (setAt = now-11min, timeout=10min)", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("high", ELEVEN_MIN, "rule") });
		resolveEffectivePin(scope as any, timeout10m);
		expect(scope.scopedPin).toBeUndefined();
	});

	it("clears scope.lastDecision when pin expires", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const fakeDecision = { tier: "high" } as RoutingDecision;
		const scope = makeScope({
			scopedPin: makePin("high", ELEVEN_MIN),
			lastDecision: fakeDecision,
		});
		resolveEffectivePin(scope as any, timeout10m);
		expect(scope.lastDecision).toBeUndefined();
	});

	it("returns floor='medium' after expiry when defaultPin='medium'", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("high", ELEVEN_MIN) });
		const r = resolveEffectivePin(scope as any, { ...timeout10m, ...cfgMedium });
		expect(r.scopedPin).toBeUndefined();
		expect(r.floor).toBe("medium");
	});

	it("returns undefined floor after expiry when defaultPin='auto'", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("high", ELEVEN_MIN) });
		const r = resolveEffectivePin(scope as any, { ...timeout10m, ...cfgAuto });
		expect(r.scopedPin).toBeUndefined();
		expect(r.floor).toBeUndefined();
	});

	it("uses DEFAULT_PIN_TIMEOUT_MS (600000) when pinTimeout is undefined", () => {
		// Pin set just before timeout — should still be alive
		const justUnder = DEFAULT_PIN_TIMEOUT_MS - 1000;
		const scope = makeScope({ scopedPin: makePin("low", justUnder) });
		expect(resolveEffectivePin(scope as any, {}).scopedPin).toBe("low");

		// Pin set just over timeout — should be expired
		const justOver = DEFAULT_PIN_TIMEOUT_MS + 1000;
		const expiredScope = makeScope({ scopedPin: makePin("low", justOver) });
		expect(resolveEffectivePin(expiredScope as any, {}).scopedPin).toBeUndefined();
		expect(expiredScope.scopedPin).toBeUndefined();
	});
});

// ─── setScopedPin ─────────────────────────────────────────────────────────────

describe("setScopedPin", () => {
	it("source 'user' sets pin when no existing pin", () => {
		const scope = makeScope();
		setScopedPin(scope as any, "high", "user", timeout10m);
		expect(scope.scopedPin?.tier).toBe("high");
		expect(scope.scopedPin?.source).toBe("user");
	});

	it("source 'user' overrides active heuristic pin", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("low", FIVE_MIN, "heuristic") });
		setScopedPin(scope as any, "high", "user", timeout10m);
		expect(scope.scopedPin?.tier).toBe("high");
		expect(scope.scopedPin?.source).toBe("user");
	});

	it("source 'user' overrides active user pin (resets timer)", () => {
		// Set a user pin that was created 5 min ago
		const FIVE_MIN = 5 * 60 * 1000;
		const oldSetAt = Date.now() - FIVE_MIN;
		const scope = makeScope({ scopedPin: { tier: "low", setAt: oldSetAt, source: "user" } });
		setScopedPin(scope as any, "medium", "user", timeout10m);
		expect(scope.scopedPin?.tier).toBe("medium");
		// Timer should be reset — setAt should be close to now
		expect(scope.scopedPin!.setAt).toBeGreaterThan(oldSetAt);
	});

	it("source 'heuristic' sets pin when no active pin exists", () => {
		const scope = makeScope();
		setScopedPin(scope as any, "medium", "heuristic", timeout10m);
		expect(scope.scopedPin?.tier).toBe("medium");
		expect(scope.scopedPin?.source).toBe("heuristic");
	});

	it("source 'heuristic' does NOT override active user pin", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("high", FIVE_MIN, "user") });
		setScopedPin(scope as any, "low", "heuristic", timeout10m);
		expect(scope.scopedPin?.tier).toBe("high");
		expect(scope.scopedPin?.source).toBe("user");
	});

	it("source 'heuristic' does NOT override active heuristic pin", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("high", FIVE_MIN, "heuristic") });
		setScopedPin(scope as any, "low", "heuristic", timeout10m);
		expect(scope.scopedPin?.tier).toBe("high");
	});

	it("source 'classifier' is blocked by active pin", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("medium", FIVE_MIN, "heuristic") });
		setScopedPin(scope as any, "high", "classifier", timeout10m);
		expect(scope.scopedPin?.tier).toBe("medium");
		expect(scope.scopedPin?.source).toBe("heuristic");
	});

	it("source 'auto-upgrade' is blocked by active pin", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("low", FIVE_MIN, "user") });
		setScopedPin(scope as any, "high", "auto-upgrade", timeout10m);
		expect(scope.scopedPin?.tier).toBe("low");
		expect(scope.scopedPin?.source).toBe("user");
	});

	it("source 'heuristic' CAN set pin when existing pin is expired", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const fakeDecision = { tier: "high" } as RoutingDecision;
		const scope = makeScope({
			scopedPin: makePin("high", ELEVEN_MIN, "user"),
			lastDecision: fakeDecision,
		});
		setScopedPin(scope as any, "low", "heuristic", timeout10m);
		expect(scope.scopedPin?.tier).toBe("low");
		expect(scope.scopedPin?.source).toBe("heuristic");
		// Expired decay also clears lastDecision
		expect(scope.lastDecision).toBeUndefined();
	});
});

// ─── clearScopedPin ───────────────────────────────────────────────────────────

describe("clearScopedPin", () => {
	it("clears scopedPin to undefined", () => {
		const scope = makeScope({ scopedPin: makePin("high", 0) });
		clearScopedPin(scope as any);
		expect(scope.scopedPin).toBeUndefined();
	});

	it("clears lastDecision to undefined", () => {
		const fakeDecision = { tier: "medium" } as RoutingDecision;
		const scope = makeScope({ lastDecision: fakeDecision });
		clearScopedPin(scope as any);
		expect(scope.lastDecision).toBeUndefined();
	});

	it("is a no-op when scopedPin and lastDecision are already undefined (no throw)", () => {
		const scope = makeScope();
		expect(() => clearScopedPin(scope as any)).not.toThrow();
		expect(scope.scopedPin).toBeUndefined();
		expect(scope.lastDecision).toBeUndefined();
	});
});

// ─── Integration: 7.4 sticky loop bounded ────────────────────────────────────

describe("Integration: sticky loop bounded by timeout", () => {
	it("pin set by Rule J (heuristic) expires after timeout and heuristic runs fresh", () => {
		const scope = makeScope();
		const cfg = { pinTimeout: 300_000, defaultPin: "auto" as const };

		// Rule J fires: heuristic sets a system pin to "high"
		setScopedPin(scope as any, "high", "heuristic", cfg);
		expect(scope.scopedPin?.tier).toBe("high");
		expect(scope.scopedPin?.source).toBe("heuristic");

		// Set lastDecision to simulate phase state that Rule J would re-use
		scope.lastDecision = { tier: "high", phase: "planning" } as RoutingDecision;

		// Pin still active within timeout → resolves to scoped pin
		const { scopedPin: activePin } = resolveEffectivePin(scope as any, cfg);
		expect(activePin).toBe("high");
		expect(scope.scopedPin).toBeDefined();   // not cleared yet
		expect(scope.lastDecision).toBeDefined(); // not cleared yet

		// Simulate timeout: advance setAt back past pinTimeout
		scope.scopedPin!.setAt = Date.now() - cfg.pinTimeout - 1;

		// After expiry → resolveEffectivePin clears both scopedPin and lastDecision
		const { scopedPin: expiredPin, floor } = resolveEffectivePin(scope as any, cfg);
		expect(expiredPin).toBeUndefined();  // no active scoped pin
		expect(floor).toBeUndefined();       // defaultPin=auto → no floor
		expect(scope.scopedPin).toBeUndefined();    // cleared
		expect(scope.lastDecision).toBeUndefined(); // cleared → heuristic runs fresh

		// A new P2 pin CAN now be set (slot is free after expiry)
		setScopedPin(scope as any, "medium", "heuristic", cfg);
		expect(scope.scopedPin?.tier).toBe("medium");
	});

	it("pressure lapse: incrementPinPressure clears system pin after N disagreements", () => {
		const { incrementPinPressure } = require("../src/routing/pin");
		const scope = makeScope();
		const cfg = { pinTimeout: 300_000 };

		// Classifier pins "high"
		setScopedPin(scope as any, "high", "classifier", cfg);
		expect(scope.scopedPin?.tier).toBe("high");

		// Shadow heuristic disagrees (says "medium") — turns 1 and 2: no lapse yet
		expect(incrementPinPressure(scope as any, "medium", 3)).toBe(false);
		expect(scope.scopedPin?.overridePressureCount).toBe(1);
		expect(incrementPinPressure(scope as any, "medium", 3)).toBe(false);
		expect(scope.scopedPin?.overridePressureCount).toBe(2);

		// Turn 3: threshold reached → pin lapses
		expect(incrementPinPressure(scope as any, "medium", 3)).toBe(true);
		expect(scope.scopedPin).toBeUndefined();
		expect(scope.lastDecision).toBeUndefined();
	});

	it("pressure counter resets when heuristic agrees", () => {
		const { incrementPinPressure } = require("../src/routing/pin");
		const scope = makeScope();
		const cfg = { pinTimeout: 300_000 };

		setScopedPin(scope as any, "high", "heuristic", cfg);

		// Two disagreements
		incrementPinPressure(scope as any, "medium", 3);
		incrementPinPressure(scope as any, "medium", 3);
		expect(scope.scopedPin?.overridePressureCount).toBe(2);

		// Heuristic agrees → counter resets
		expect(incrementPinPressure(scope as any, "high", 3)).toBe(false);
		expect(scope.scopedPin?.overridePressureCount).toBe(0);
		expect(scope.scopedPin).toBeDefined(); // pin still alive

		// One more disagreement — streak restarts from 0, not 2
		incrementPinPressure(scope as any, "medium", 3);
		expect(scope.scopedPin?.overridePressureCount).toBe(1);
	});

	it("user pin is immune to pressure lapse", () => {
		const { incrementPinPressure } = require("../src/routing/pin");
		const scope = makeScope();
		const cfg = { pinTimeout: 300_000 };

		// User sets pin to "high"
		setScopedPin(scope as any, "high", "user", cfg);

		// 10 consecutive disagreements — should never lapse
		for (let i = 0; i < 10; i++) {
			expect(incrementPinPressure(scope as any, "low", 3)).toBe(false);
		}
		expect(scope.scopedPin).toBeDefined();
		expect(scope.scopedPin?.tier).toBe("high");
	});
});

// ─── Integration: 7.5 user pin overrides system pin ──────────────────────────

describe("Integration: user pin overrides system pin and decays independently", () => {
	it("user /router pin overrides active heuristic pin and resets timer", () => {
		const scope = makeScope();
		const cfg = { pinTimeout: 300_000 };

		// Heuristic sets system pin to "high"
		setScopedPin(scope as any, "high", "heuristic", cfg);
		const systemSetAt = scope.scopedPin!.setAt;
		expect(scope.scopedPin?.source).toBe("heuristic");

		// Small delay to ensure setAt differs
		const before = Date.now();

		// User runs /router pin medium — P1 always overrides
		setScopedPin(scope as any, "medium", "user", cfg);
		expect(scope.scopedPin?.tier).toBe("medium");
		expect(scope.scopedPin?.source).toBe("user");
		expect(scope.scopedPin!.setAt).toBeGreaterThanOrEqual(systemSetAt); // timer reset
	});

	it("user pin blocks all subsequent system pin attempts", () => {
		const scope = makeScope();
		const cfg = { pinTimeout: 300_000 };

		// User pins to "medium"
		setScopedPin(scope as any, "medium", "user", cfg);

		// All P2 system sources are blocked
		setScopedPin(scope as any, "high", "heuristic", cfg);
		expect(scope.scopedPin?.tier).toBe("medium");  // unchanged

		setScopedPin(scope as any, "high", "classifier", cfg);
		expect(scope.scopedPin?.tier).toBe("medium");  // unchanged

		setScopedPin(scope as any, "high", "rule", cfg);
		expect(scope.scopedPin?.tier).toBe("medium");  // unchanged

		setScopedPin(scope as any, "high", "auto-upgrade", cfg);
		expect(scope.scopedPin?.tier).toBe("medium");  // unchanged
	});

	it("/router pin auto clears pin and lastDecision immediately", () => {
		const scope = makeScope({
			scopedPin: makePin("high", 0, "user"),
			lastDecision: { tier: "high", phase: "planning" } as RoutingDecision,
		});

		clearScopedPin(scope as any);

		expect(scope.scopedPin).toBeUndefined();
		expect(scope.lastDecision).toBeUndefined();
	});

	it("user pin decays after timeout and returns to config floor", () => {
		const scope = makeScope();
		const cfg = { pinTimeout: 300_000, defaultPin: "medium" as RouterTier };

		// User pins to "high"
		setScopedPin(scope as any, "high", "user", cfg);
		expect(resolveEffectivePin(scope as any, cfg).scopedPin).toBe("high");

		// Simulate expiry
		scope.scopedPin!.setAt = Date.now() - cfg.pinTimeout - 1;

		// After decay → no scoped pin, floor = medium
		const { scopedPin, floor } = resolveEffectivePin(scope as any, cfg);
		expect(scopedPin).toBeUndefined();
		expect(floor).toBe("medium");
		expect(scope.scopedPin).toBeUndefined();
		expect(scope.lastDecision).toBeUndefined();
	});
});

// ─── Integration: 7.6 sub-agent independent pin lifecycle ────────────────────

describe("Integration: sub-agent session has independent pin lifecycle", () => {
	it("sub-agent scope is independent of parent scope", () => {
		const parentScope = makeScope();
		const childScope = makeScope();  // separate SessionScope instance
		const cfg = { pinTimeout: 300_000 };

		// Parent gets a classifier pin
		setScopedPin(parentScope as any, "high", "classifier", cfg);
		expect(parentScope.scopedPin?.tier).toBe("high");

		// Child scope is unaffected
		expect(childScope.scopedPin).toBeUndefined();

		// Child sets its own pin to "low"
		setScopedPin(childScope as any, "low", "heuristic", cfg);
		expect(childScope.scopedPin?.tier).toBe("low");

		// Parent scope unchanged
		expect(parentScope.scopedPin?.tier).toBe("high");
	});

	it("child pin expiry does not affect parent", () => {
		const parentScope = makeScope();
		const childScope = makeScope();
		const cfg = { pinTimeout: 300_000 };

		setScopedPin(parentScope as any, "high", "user", cfg);
		setScopedPin(childScope as any, "medium", "classifier", cfg);

		// Expire child pin
		childScope.scopedPin!.setAt = Date.now() - cfg.pinTimeout - 1;
		resolveEffectivePin(childScope as any, cfg); // triggers expiry/clear

		expect(childScope.scopedPin).toBeUndefined();
		expect(parentScope.scopedPin?.tier).toBe("high"); // parent untouched
	});

	it("fresh session (new scope) starts with no pin regardless of defaultPin", () => {
		// Spec: A new session always starts with no scoped pin
		const freshScope = makeScope(); // models SessionScope construction
		expect(freshScope.scopedPin).toBeUndefined();

		// Config floor provides effective pin for routing, but scopedPin itself is empty
		const cfg = { pinTimeout: 300_000, defaultPin: "medium" as RouterTier };
		const { scopedPin, floor } = resolveEffectivePin(freshScope as any, cfg);
		expect(scopedPin).toBeUndefined();  // no scoped pin
		expect(floor).toBe("medium");       // floor from config
	});

	it("parent pin unaffected by child setScopedPin", () => {
		const parentScope = makeScope();
		const childScope = makeScope();
		const cfg = { pinTimeout: 300_000 };

		setScopedPin(parentScope as any, "medium", "user", cfg);

		// Child sets a high pin — parent's pin is a different object
		setScopedPin(childScope as any, "high", "classifier", cfg);

		expect(parentScope.scopedPin?.tier).toBe("medium");
		expect(childScope.scopedPin?.tier).toBe("high");
	});
});
