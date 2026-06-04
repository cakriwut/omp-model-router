## Why

The current pin system (`pinnedTierByProfile`) is global, persists to disk, and has no expiry. Once a tier is pinned — whether by user command, the `/router fix` command, or indirectly through the sticky heuristic (Rule J) — it stays forever until manually cleared. This causes a feedback loop where routing decisions get trapped at `high` tier indefinitely, ignoring all heuristic/classifier logic. Users observe "auto-pin to high" behavior that they cannot escape without explicit intervention, even after running `/router pin auto`.

The root cause is twofold: (1) the pin persists across sessions and has no timeout, and (2) the heuristic's "sticky planning" rule (Rule J) re-triggers on every turn because `previousDecision.phase` remains `"planning"`, creating an infinite loop that mimics a hard pin.

## What Changes

- **Replace global `pinnedTierByProfile` with session-scoped `scopedPin` on `SessionScope`** — pins are memory-only, per-session, and carry a decay timer.
- **Add `pinTimeout` config option** — configurable TTL for all scoped pins (default: 10 minutes).
- **Add `defaultPin` config option** — the "floor" that decay returns to (default: `"auto"` meaning no pin, heuristic decides freely).
- **Implement priority-based pin override** — user commands (P1) can override any active pin and reset the timer; system sources (heuristic, classifier, rules, auto-upgrade) can only set a pin when no active pin exists (P2).
- **Clean break on decay** — when a pin expires, `previousDecision` is also cleared so the sticky heuristic cannot immediately re-trigger.
- **Remove pin persistence to disk** — no more `pinByProfile`/`pinTier` in `router-state.json`.
- **`/router pin auto` becomes immediate decay** — clears scopedPin and previousDecision for a fresh start.

## Capabilities

### New Capabilities
- `scoped-pin-decay`: Session-scoped pin with TTL, priority-based override, and config-anchored decay floor.

### Modified Capabilities
<!-- No existing spec-level capabilities are being modified at the requirement level -->

## Impact

- **`src/state/index.ts`** — `SessionScope` gains `scopedPin` field; `pinnedTierByProfile` removed from `RouterState`.
- **`src/state/persist.ts`** — Remove `pinByProfile`/`pinTier` from persistence and restoration.
- **`src/routing/compose.ts`** — Pin resolution reads from `scope.scopedPin` with expiry check instead of global map.
- **`src/routing/heuristic.ts`** — Rule J output now creates a scoped pin rather than relying on `previousDecision` stickiness.
- **`src/commands/pin.ts`** — Sets `scope.scopedPin` with `source:"user"`.
- **`src/commands/fix.ts`** — Sets `scope.scopedPin` with `source:"user"`.
- **`src/provider.ts`** — Pin resolution changes from `state.pinnedTierByProfile[model.id]` to scoped pin lookup.
- **`src/config.ts`** / **`src/types.ts`** — New `defaultPin` and `pinTimeout` config fields.
- **`src/ui/status.ts`** — Widget shows scoped pin + remaining TTL instead of global pin map.
- **`test/`** — Existing pin-related tests need rewrite; new tests for decay, priority, session scoping.
- **`router-state.json`** — **BREAKING**: `pinByProfile` and `pinTier` fields no longer written or read. Old persisted pins are silently ignored on upgrade.
