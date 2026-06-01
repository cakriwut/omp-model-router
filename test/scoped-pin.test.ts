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
	it("returns undefined when no scopedPin and defaultPin is 'auto'", () => {
		const scope = makeScope();
		expect(resolveEffectivePin(scope as any, cfgAuto)).toBeUndefined();
	});

	it("returns undefined when no scopedPin and defaultPin is undefined", () => {
		const scope = makeScope();
		expect(resolveEffectivePin(scope as any, cfgUndefined)).toBeUndefined();
	});

	it("returns 'high' when no scopedPin and defaultPin is 'high'", () => {
		const scope = makeScope();
		expect(resolveEffectivePin(scope as any, cfgHigh)).toBe("high");
	});

	it("returns scopedPin.tier when pin is active (setAt = now-5min, timeout=10min)", () => {
		const FIVE_MIN = 5 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("medium", FIVE_MIN, "heuristic") });
		expect(resolveEffectivePin(scope as any, timeout10m)).toBe("medium");
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

	it("returns defaultPin floor after expiry when defaultPin='medium'", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("high", ELEVEN_MIN) });
		const result = resolveEffectivePin(scope as any, { ...timeout10m, ...cfgMedium });
		expect(result).toBe("medium");
	});

	it("returns undefined after expiry when defaultPin='auto'", () => {
		const ELEVEN_MIN = 11 * 60 * 1000;
		const scope = makeScope({ scopedPin: makePin("high", ELEVEN_MIN) });
		const result = resolveEffectivePin(scope as any, { ...timeout10m, ...cfgAuto });
		expect(result).toBeUndefined();
	});

	it("uses DEFAULT_PIN_TIMEOUT_MS (600000) when pinTimeout is undefined", () => {
		// Pin set just before timeout — should still be alive
		const justUnder = DEFAULT_PIN_TIMEOUT_MS - 1000;
		const scope = makeScope({ scopedPin: makePin("low", justUnder) });
		expect(resolveEffectivePin(scope as any, {})).toBe("low");

		// Pin set just over timeout — should be expired
		const justOver = DEFAULT_PIN_TIMEOUT_MS + 1000;
		const expiredScope = makeScope({ scopedPin: makePin("low", justOver) });
		expect(resolveEffectivePin(expiredScope as any, {})).toBeUndefined();
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
