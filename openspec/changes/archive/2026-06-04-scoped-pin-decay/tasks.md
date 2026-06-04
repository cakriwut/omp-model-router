## 1. Data Model & Types

- [x] 1.1 Add `ScopedPin` interface to `src/types.ts` with fields: `tier: RouterTier`, `setAt: number`, `source: "user" | "heuristic" | "classifier" | "rule" | "auto-upgrade"`
- [x] 1.2 Add `scopedPin?: ScopedPin` to `SessionScope` interface in `src/state/index.ts`
- [x] 1.3 Add `defaultPin?: RouterTier | "auto"` and `pinTimeout?: number` to `RouterConfig` in `src/types.ts`
- [x] 1.4 Add `defaultPin` and `pinTimeout` defaults to `FALLBACK_CONFIG` in `src/config.ts` (defaultPin: "auto", pinTimeout: 600000)

## 2. Pin Resolution Logic

- [x] 2.1 Create `src/routing/pin.ts` module with `resolveEffectivePin(scope, config): RouterTier | undefined` — checks scopedPin expiry, clears on decay (+ clears lastDecision), returns tier or undefined
- [x] 2.2 Add `setScopedPin(scope, tier, source, config)` helper — creates pin with `setAt: Date.now()`; respects priority (P1 user always sets, P2 system only when no active pin)
- [x] 2.3 Add `clearScopedPin(scope)` helper — clears `scopedPin` and `scope.lastDecision`

## 3. Integrate Pin Resolution into Routing

- [x] 3.1 Update `src/provider.ts` — replace `state.pinnedTierByProfile[model.id]` with `resolveEffectivePin(state.scope, state.currentConfig)` call
- [x] 3.2 Update `src/routing/compose.ts` — `RoutingInput.pinnedTier` now receives result from `resolveEffectivePin` (tier or undefined)
- [x] 3.3 After heuristic/classifier runs in `compose.ts`, call `setScopedPin` for pin-creating events (Rule J, classifier override, rule match) — only when source is P2 and no active pin

## 4. Update Commands

- [x] 4.1 Rewrite `src/commands/pin.ts` — `/router pin <tier>` sets `scope.scopedPin` via `setScopedPin(scope, tier, "user", config)` with P1 priority; `/router pin auto` calls `clearScopedPin(scope)`
- [x] 4.2 Rewrite `src/commands/fix.ts` — `/router fix <tier>` sets `scope.scopedPin` via `setScopedPin(scope, tier, "user", config)` with P1 priority
- [x] 4.3 Update `src/commands/status.ts` — show scoped pin tier, source, and remaining TTL instead of global pin map

## 5. Remove Global Pin State

- [x] 5.1 Remove `pinnedTierByProfile: RouterPinByProfile` from `RouterState` class in `src/state/index.ts`
- [x] 5.2 Remove `RouterPinByProfile` type from `src/types.ts` (or deprecate) — kept as `@deprecated` for backward-compat deserialization of old `router-state.json` files; not used in active code
- [x] 5.3 Remove `pinByProfile` and `pinTier` from `RouterPersistedState` in `src/types.ts`
- [x] 5.4 Remove pin persistence in `src/state/persist.ts` — delete `pinTier`/`pinByProfile` from `buildPersistedState`, remove restoration of pins in `restoreFromSession`
- [x] 5.5 Update `src/ui/status.ts` — replace all `pinnedTierByProfile` references with scoped pin reads
- [x] 5.6 Update `src/ui/profile.ts` — remove `pinnedTierByProfile` parameter, use scoped pin

## 6. Auto-Upgrade Integration

- [x] 6.1 Update auto-upgrade in `src/index.ts` (`tool_execution_end` handler) — when `autoUpgradeTier` is set, use `setScopedPin(scope, tier, "auto-upgrade", config)` instead of the one-shot override pattern in provider.ts
- [x] 6.2 Remove `state.autoUpgradeTier` field and the one-shot override block in `src/provider.ts` (auto-upgrade now goes through scoped pin system)

## 7. Tests

- [x] 7.1 Write unit tests for `resolveEffectivePin` — active pin, expired pin, absent pin, config floor variations
- [x] 7.2 Write unit tests for `setScopedPin` — P1 override, P2 blocked by active pin, P2 sets when none active
- [x] 7.3 Write unit tests for `clearScopedPin` — clears pin and lastDecision
- [x] 7.4 Write integration test: sticky loop is bounded — simulate Rule J firing, verify pin expires after timeout and heuristic runs fresh
- [x] 7.5 Write integration test: user pin overrides system pin and decays independently
- [x] 7.6 Write integration test: sub-agent session has independent pin lifecycle
- [x] 7.7 Update/remove existing pin-related tests that reference `pinnedTierByProfile`
- [x] 7.8 Run `bun run test` — verify all 334+ tests pass (update count as needed) — 548 pass, 0 fail

## 8. Config & Documentation

- [x] 8.1 Update `AGENTS.md` — document `defaultPin` and `pinTimeout` config fields, remove "Adding a new top-level field" pitfall for pin (it's gone)
- [x] 8.2 Update config example in `AGENTS.md` to include `defaultPin` and `pinTimeout`
- [x] 8.3 Verify `bun run test test/config-field-preservation.test.ts` passes with new fields
