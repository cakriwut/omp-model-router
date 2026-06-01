## 1. Types

- [x] 1.1 Add `overridePressureCount?: number` to `ScopedPin` interface in `src/types.ts`
- [x] 1.2 Add `pinPressureThreshold?: number` to `RouterConfig` interface in `src/types.ts`

## 2. Config

- [x] 2.1 Add `pinPressureThreshold: 3` to `FALLBACK_CONFIG` in `src/config.ts`

## 3. Pin mutation helpers

- [x] 3.1 Add `incrementPinPressure(scope, shadowTier, threshold, debug?)` helper to `src/routing/pin.ts` — increments or resets `overridePressureCount`, returns `true` when threshold is reached (lapse fires), clears `scopedPin` and `lastDecision` on lapse, emits debug log
- [x] 3.2 Ensure `setScopedPin` initialises `overridePressureCount: 0` on newly created `ScopedPin` objects

## 4. Routing composition

- [x] 4.1 In `src/routing/compose.ts` — after effective-pin is confirmed active and `pin.source !== "user"`, run `decideRouting(..., undefined)` (shadow, no pin) to get shadow tier
- [x] 4.2 Call `incrementPinPressure` with shadow tier; if it returns `true` (lapse), bust classifier cache on `input.state` and fall through to re-run routing freely for the current turn
- [x] 4.3 Pass `config.pinConfig` threshold value through to `incrementPinPressure`

## 5. Status display

- [x] 5.1 In `src/commands/pin.ts` — when a system pin is active and `overridePressureCount > 0`, append pressure info (e.g. `pressure: 2/3`) to the `/router pin` status line

## 6. Tests

- [x] 6.1 Unit test: pressure counter increments on consecutive heuristic disagreements
- [x] 6.2 Unit test: counter resets to 0 when heuristic agrees mid-streak
- [x] 6.3 Unit test: pin lapses exactly at threshold (not before)
- [x] 6.4 Unit test: user pin is immune — no lapse after N disagreements
- [x] 6.5 Unit test: `pinPressureThreshold: 0` disables pressure lapse entirely
- [x] 6.6 Unit test: classifier cache is busted on pressure lapse
- [x] 6.7 Unit test: new `ScopedPin` created by `setScopedPin` has `overridePressureCount === 0`
