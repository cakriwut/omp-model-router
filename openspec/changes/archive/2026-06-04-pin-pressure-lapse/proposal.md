## Why

The 10-minute wall-clock `pinTimeout` was designed for idle sessions but causes over-routing in active, direction-changing conversations: once a system pin is set (by heuristic Rule J, classifier, or rule), all subsequent routing signals are silently blocked for up to 10 minutes regardless of how many consecutive turns indicate the phase has changed. A single planning-phase response can hold an entire lightweight Q&A session at "high" tier.

## What Changes

- Add `overridePressureCount` field to `ScopedPin` to track consecutive turns where the heuristic shadow disagrees with the active pin tier.
- Add `pinPressureThreshold` config option (default: `3`) — the number of consecutive disagreement turns before a system pin lapses early.
- Compute a **heuristic shadow** (free, regex-only, no classifier API call) inside `resolveRouting` whenever a system pin is active; increment or reset the counter based on agreement.
- When pressure reaches threshold: clear the pin, bust the classifier cache, and re-route freely for the current turn.
- **User pins (`source: "user"`) are immune** — they never pressure-lapse; only system pins (`heuristic`, `classifier`, `rule`, `auto-upgrade`) are affected.
- Expose pressure count in `/router pin` status output and debug log on lapse.

## Capabilities

### New Capabilities

- `pin-pressure-lapse`: Consecutive-signal pressure mechanism that causes system-set scoped pins to lapse early when the heuristic disagrees for N consecutive turns, enabling mid-conversation phase transitions without waiting for the wall-clock timeout.

### Modified Capabilities

*(none — no existing spec-level requirements change)*

## Impact

- `src/types.ts` — `ScopedPin` interface, `RouterConfig` interface
- `src/routing/pin.ts` — pressure increment/reset logic, expiry check
- `src/routing/compose.ts` — shadow heuristic run + pressure signal integration
- `src/config.ts` — `FALLBACK_CONFIG` default for `pinPressureThreshold`
- `src/commands/pin.ts` — display pressure count in status
- `test/` — new unit tests for pressure lapse behaviour
