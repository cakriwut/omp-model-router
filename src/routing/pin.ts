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
export function resolveEffectivePin(
	scope: SessionScope,
	config: Pick<RouterConfig, "defaultPin" | "pinTimeout">,
): RouterTier | undefined {
	const pin = scope.scopedPin;

	if (pin !== undefined) {
		const timeout = config.pinTimeout ?? DEFAULT_PIN_TIMEOUT_MS;
		if (Date.now() - pin.setAt < timeout) {
			// Pin is still alive — use it.
			return pin.tier;
		}
		// Pin has expired — clean break (decision X2).
		scope.scopedPin = undefined;
		scope.lastDecision = undefined;
	}

	// No active scoped pin. Return config floor if set.
	const floor = config.defaultPin;
	if (floor !== undefined && floor !== "auto") {
		return floor;
	}

	return undefined;
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
