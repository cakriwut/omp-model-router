import { describe, it, expect } from "bun:test";
import { incrementPinPressure, setScopedPin } from "../src/routing/pin";
import type { RouterTier, ScopedPin, RoutingDecision } from "../src/types";

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

interface MinimalScope {
	scopedPin?: ScopedPin;
	lastDecision?: RoutingDecision | undefined;
}

function makeScope(pin?: ScopedPin): MinimalScope {
	return { scopedPin: pin, lastDecision: undefined };
}

function makeSystemPin(tier: RouterTier, source: ScopedPin["source"] = "heuristic"): ScopedPin {
	return { tier, setAt: Date.now(), source, overridePressureCount: 0 };
}

function makeUserPin(tier: RouterTier): ScopedPin {
	return { tier, setAt: Date.now(), source: "user", overridePressureCount: 0 };
}

const DEFAULT_THRESHOLD = 3;

// ─── incrementPinPressure ────────────────────────────────────────────────────

describe("incrementPinPressure", () => {
	// 6.1 — pressure counter increments on consecutive heuristic disagreements
	it("increments overridePressureCount on disagreement", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		const result = incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);

		expect(result).toBe(false); // not yet lapsed (count=1, threshold=3)
		expect(scope.scopedPin?.overridePressureCount).toBe(1);
	});

	it("increments counter on consecutive disagreements without lapsing early", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD); // count=1
		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD); // count=2

		expect(scope.scopedPin).toBeDefined();
		expect(scope.scopedPin?.overridePressureCount).toBe(2);
	});

	// 6.2 — counter resets to 0 when heuristic agrees mid-streak
	it("resets overridePressureCount to 0 when shadow agrees with pin", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);  // count=1
		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);  // count=2
		const result = incrementPinPressure(scope as any, "high", DEFAULT_THRESHOLD); // agree → reset

		expect(result).toBe(false);
		expect(scope.scopedPin?.overridePressureCount).toBe(0);
		expect(scope.scopedPin).toBeDefined(); // pin still alive
	});

	it("does NOT lapse after agreement breaks the streak (isolated disagreements)", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);  // count=1
		incrementPinPressure(scope as any, "high", DEFAULT_THRESHOLD); // agree → count=0
		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);  // count=1
		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);  // count=2
		const result = incrementPinPressure(scope as any, "high", DEFAULT_THRESHOLD); // agree → count=0

		expect(result).toBe(false);
		expect(scope.scopedPin).toBeDefined();
		expect(scope.scopedPin?.overridePressureCount).toBe(0);
	});

	// 6.3 — pin lapses exactly at threshold (not before)
	it("does NOT lapse at threshold-1 consecutive disagreements", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		for (let i = 0; i < DEFAULT_THRESHOLD - 1; i++) {
			const result = incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);
			expect(result).toBe(false);
		}
		expect(scope.scopedPin).toBeDefined();
	});

	it("lapses exactly at threshold consecutive disagreements", () => {
		const pin = makeSystemPin("high");
		const fakeDecision = { tier: "high" } as RoutingDecision;
		const scope = makeScope(pin);
		scope.lastDecision = fakeDecision;

		for (let i = 0; i < DEFAULT_THRESHOLD - 1; i++) {
			incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);
		}
		// Final disagreement that reaches threshold
		const result = incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);

		expect(result).toBe(true);            // lapsed!
		expect(scope.scopedPin).toBeUndefined(); // pin cleared
		expect(scope.lastDecision).toBeUndefined(); // lastDecision cleared
	});

	it("does not lapse at threshold-1 but lapses at threshold (boundary check)", () => {
		const threshold = 5;
		const pin = makeSystemPin("medium");
		const scope = makeScope(pin);

		for (let i = 0; i < threshold - 1; i++) {
			expect(incrementPinPressure(scope as any, "low", threshold)).toBe(false);
		}
		expect(scope.scopedPin).toBeDefined();

		const result = incrementPinPressure(scope as any, "low", threshold);
		expect(result).toBe(true);
		expect(scope.scopedPin).toBeUndefined();
	});

	// 6.4 — user pin is immune — no lapse after N disagreements
	it("user pin is immune: returns false and never lapses", () => {
		const pin = makeUserPin("high");
		const scope = makeScope(pin);

		for (let i = 0; i < 10; i++) {
			const result = incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);
			expect(result).toBe(false);
		}
		expect(scope.scopedPin).toBeDefined();
		expect(scope.scopedPin?.tier).toBe("high");
	});

	it("user pin counter is not modified (immune)", () => {
		const pin = makeUserPin("high");
		const scope = makeScope(pin);

		incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);

		// overridePressureCount should remain 0 (or undefined), not incremented
		expect(scope.scopedPin?.overridePressureCount ?? 0).toBe(0);
	});

	// 6.5 — pinPressureThreshold: 0 disables pressure lapse entirely
	it("threshold=0 disables pressure lapse entirely", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		for (let i = 0; i < 20; i++) {
			const result = incrementPinPressure(scope as any, "low", 0);
			expect(result).toBe(false);
		}
		expect(scope.scopedPin).toBeDefined();
	});

	it("threshold=0 never increments counter", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		incrementPinPressure(scope as any, "low", 0);
		// disabled → counter should NOT be incremented
		expect(scope.scopedPin?.overridePressureCount ?? 0).toBe(0);
	});

	// 6.6 — classifier cache is busted on pressure lapse
	// (tested via the RouterState shape; pressure lapse clears scopedPin/lastDecision)
	it("on lapse, scopedPin is undefined (caller busts classifier cache)", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);

		for (let i = 0; i < DEFAULT_THRESHOLD - 1; i++) {
			incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);
		}
		const result = incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);

		expect(result).toBe(true);
		expect(scope.scopedPin).toBeUndefined();
	});

	it("on lapse, lastDecision is cleared", () => {
		const pin = makeSystemPin("high");
		const scope = makeScope(pin);
		scope.lastDecision = { tier: "high" } as RoutingDecision;

		for (let i = 0; i < DEFAULT_THRESHOLD; i++) {
			incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);
		}

		expect(scope.lastDecision).toBeUndefined();
	});

	// no-pin case
	it("returns false when no scopedPin exists", () => {
		const scope = makeScope(); // no pin
		const result = incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);
		expect(result).toBe(false);
	});

	// all system source types are subject to pressure
	it.each(["heuristic", "classifier", "rule", "auto-upgrade"] as ScopedPin["source"][])(
		"source '%s' is subject to pressure lapse",
		(source) => {
			const pin: ScopedPin = { tier: "high", setAt: Date.now(), source, overridePressureCount: 0 };
			const scope = makeScope(pin);

			for (let i = 0; i < DEFAULT_THRESHOLD; i++) {
				incrementPinPressure(scope as any, "low", DEFAULT_THRESHOLD);
			}

			expect(scope.scopedPin).toBeUndefined();
		},
	);
});

// 6.7 — new ScopedPin created by setScopedPin has overridePressureCount === 0
describe("setScopedPin initialises overridePressureCount", () => {
	const timeout10m = { pinTimeout: 600_000 };

	it("newly created user pin has overridePressureCount === 0", () => {
		const scope: MinimalScope = { scopedPin: undefined, lastDecision: undefined };
		setScopedPin(scope as any, "high", "user", timeout10m);
		expect(scope.scopedPin?.overridePressureCount).toBe(0);
	});

	it("newly created heuristic pin has overridePressureCount === 0", () => {
		const scope: MinimalScope = { scopedPin: undefined, lastDecision: undefined };
		setScopedPin(scope as any, "medium", "heuristic", timeout10m);
		expect(scope.scopedPin?.overridePressureCount).toBe(0);
	});

	it("newly created classifier pin has overridePressureCount === 0", () => {
		const scope: MinimalScope = { scopedPin: undefined, lastDecision: undefined };
		setScopedPin(scope as any, "low", "classifier", timeout10m);
		expect(scope.scopedPin?.overridePressureCount).toBe(0);
	});

	it("user re-pin resets overridePressureCount to 0", () => {
		// Start with a system pin that has accumulated pressure
		const existing: ScopedPin = { tier: "high", setAt: Date.now(), source: "heuristic", overridePressureCount: 2 };
		const scope: MinimalScope = { scopedPin: existing, lastDecision: undefined };

		// User overrides — new pin created with fresh counter
		setScopedPin(scope as any, "high", "user", timeout10m);
		expect(scope.scopedPin?.overridePressureCount).toBe(0);
	});
});
