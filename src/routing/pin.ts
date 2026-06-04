/**
 * Scoped pin resolution and mutation helpers.
 *
 * Priority model:
 *   P1 — user   : always overrides, resets timer
 *   P2 — system : heuristic | classifier | rule | auto-upgrade
 *                 only sets a pin when no active (non-expired) pin exists
 *
 * Decay semantics (design decision X2):
 *   On expiry both `scopedPin` AND `scope.lastDecision` are cleared so that
 *   heuristic Rule J cannot immediately re-trigger (preventing oscillation).
 */

import type { RouterConfig, RouterTier, ScopedPin, ScopedPinSource } from "../types";
import type { SessionScope } from "../state";

/** Default pin timeout in milliseconds (10 minutes). */
export const DEFAULT_PIN_TIMEOUT_MS = 600_000;
/** Default consecutive-disagreement threshold before a system pin pressure-lapses. */
export const DEFAULT_PIN_PRESSURE_THRESHOLD = 3;

/**
 * Resolve the effective pin tier for the current routing decision.
 *
 * Side effects on expiry (design decision X2):
 *   - `scope.scopedPin` is deleted
 *   - `scope.lastDecision` is set to `undefined`
 *
 * Return value semantics:
 *   - A `RouterTier` string → use this tier, skip heuristic.
 *   - `undefined`           → no active pin; heuristic decides freely.
 *
 * When `config.defaultPin` is a tier value (not `"auto"`), it acts as a
 * permanent non-decaying floor returned after any scoped pin expires.
 *
 * @param scope  The active session scope (mutated on expiry).
 * @param config The current router config.
 * @returns      The effective pinned tier, or `undefined` if unpinned.
 */
export interface ResolvedPin {
	/** The active scoped pin tier (from user or system). undefined = no active scoped pin. */
	scopedPin: RouterTier | undefined;
	/** The config floor tier (from defaultPin). undefined = no floor configured. */
	floor: RouterTier | undefined;
}

export function resolveEffectivePin(
	scope: SessionScope,
	config: Pick<RouterConfig, "defaultPin" | "pinTimeout">,
): ResolvedPin {
	let scopedPin: RouterTier | undefined;

	const pin = scope.scopedPin;
	if (pin !== undefined) {
		const timeout = config.pinTimeout ?? DEFAULT_PIN_TIMEOUT_MS;
		if (Date.now() - pin.setAt < timeout) {
			// Pin is still alive — use it.
			scopedPin = pin.tier;
		} else {
			// Pin has expired — clean break (decision X2).
			scope.scopedPin = undefined;
			scope.lastDecision = undefined;
		}
	}

	// Config floor — applied as a post-routing minimum clamp, NOT as an override.
	const defaultPin = config.defaultPin;
	const floor = (defaultPin !== undefined && defaultPin !== "auto")
		? defaultPin
		: undefined;

	return { scopedPin, floor };
}

/**
 * Set or replace the scoped pin on a session scope.
 *
 * Priority rules:
 *   - `source === "user"` (P1): always overrides any existing pin and resets
 *     the decay timer. This is the path for `/router pin <tier>` commands.
 *   - All other sources (P2): only sets the pin when no active (non-expired)
 *     pin currently exists. An existing pin — regardless of its own source —
 *     is left untouched.
 *
 * The expiry check for system sources uses `config.pinTimeout` (same value
 * used by `resolveEffectivePin`), ensuring consistent expiry semantics.
 *
 * @param scope   The active session scope (mutated in place).
 * @param tier    The tier to pin to.
 * @param source  Who is requesting the pin.
 * @param config  The current router config (provides `pinTimeout`).
 */
export function setScopedPin(
	scope: SessionScope,
	tier: RouterTier,
	source: ScopedPinSource,
	config: Pick<RouterConfig, "pinTimeout">,
): void {
	const isUser = source === "user";

	if (!isUser) {
		// P2 sources: only set when no active pin exists.
		const existing = scope.scopedPin;
		if (existing !== undefined) {
			const timeout = config.pinTimeout ?? DEFAULT_PIN_TIMEOUT_MS;
			if (Date.now() - existing.setAt < timeout) {
				// Active pin exists — system decision is blocked.
				return;
			}
			// Expired — fall through and overwrite (decay already handled here).
			scope.scopedPin = undefined;
			scope.lastDecision = undefined;
		}
	}

	scope.scopedPin = {
		tier,
		setAt: Date.now(),
		source,
		overridePressureCount: 0,
	};
}

/**
 * Immediately clear the scoped pin and wipe `lastDecision`.
 *
 * This is the manual-decay path triggered by `/router pin auto`.
 * After this call the next routing decision runs the heuristic with a
 * completely fresh slate — no phase bias, no stale planning state.
 *
 * @param scope  The active session scope (mutated in place).
 */
export function clearScopedPin(scope: SessionScope): void {
	scope.scopedPin = undefined;
	scope.lastDecision = undefined;
}

/**
 * Increment (or reset) the override-pressure counter on a system pin.
 *
 * Called each turn a system pin is active, with the tier the heuristic
 * *would have chosen* had no pin been set (the "shadow tier").
 *
 * Behaviour:
 *   - If `shadowTier === pin.tier`: the heuristic agrees → counter resets to 0.
 *   - If `shadowTier !== pin.tier`: the heuristic disagrees → counter increments.
 *   - When counter reaches `threshold` (and threshold > 0): the pin lapses.
 *     `scope.scopedPin` and `scope.lastDecision` are cleared, and `true` is
 *     returned so the caller can re-route freely and bust the classifier cache.
 *   - User pins (`source === "user"`) are **immune** — this function is a no-op
 *     for them and always returns `false`.
 *
 * @param scope       Active session scope (pin mutated in place on disagreement).
 * @param shadowTier  What the heuristic would have chosen without the pin.
 * @param threshold   Consecutive disagreements needed to lapse (0 = disabled).
 * @param debug       When true, logs lapse events to console.
 * @returns           `true` if the pin just lapsed (caller should re-route); `false` otherwise.
 */
export function incrementPinPressure(
	scope: SessionScope,
	shadowTier: RouterTier,
	threshold: number,
	debug = false,
): boolean {
	const pin = scope.scopedPin;
	// No pin, or user pin → immune.
	if (!pin || pin.source === "user") return false;
	// Pressure lapse disabled.
	if (threshold <= 0) return false;

	if (shadowTier === pin.tier) {
		// Heuristic agrees — reset streak.
		pin.overridePressureCount = 0;
		return false;
	}

	// Heuristic disagrees — increment streak.
	pin.overridePressureCount = (pin.overridePressureCount ?? 0) + 1;

	if (pin.overridePressureCount >= threshold) {
		if (debug) {
			console.log(
				`[model-router] pin pressure lapse: tier=${pin.tier} source=${pin.source} ` +
				`pressure=${pin.overridePressureCount}/${threshold} shadow=${shadowTier} → routing freely`,
			);
		}
		scope.scopedPin = undefined;
		scope.lastDecision = undefined;
		return true;
	}

	return false;
}
