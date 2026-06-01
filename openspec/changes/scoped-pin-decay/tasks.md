## 1. Data Model & Types

- [ ] 1.1 Add `ScopedPin` interface to `src/types.ts` with fields: `tier: RouterTier`, `setAt: number`, `source: "user" | "heuristic" | "classifier" | "rule" | "auto-upgrade"`
- [ ] 1.2 Add `scopedPin?: ScopedPin` to `SessionScope` interface in `src/state/index.ts`
- [ ] 1.3 Add `defaultPin?: RouterTier | "auto"` and `pinTimeout?: number` to `RouterConfig` in `src/types.ts`
- [ ] 1.4 Add `defaultPin` and `pinTimeout` defaults to `FALLBACK_CONFIG` in `src/config.ts` (defaultPin: "auto", pinTimeout: 600000)

## 2. Pin Resolution Logic

- [ ] 2.1 Create `src/routing/pin.ts` module with `resolveEffectivePin(scope, config): RouterTier | undefined` — checks scopedPin expiry, clears on decay (+ clears lastDecision), returns tier or undefined
- [ ] 2.2 Add `setScopedPin(scope, tier, source, config)` helper — creates pin with `setAt: Date.now()`; respects priority (P1 user always sets, P2 system only when no active pin)
- [ ] 2.3 Add `clearScopedPin(scope)` helper — clears `scopedPin` and `scope.lastDecision`

## 3. Integrate Pin Resolution into Routing

- [ ] 3.1 Update `src/provider.ts` — replace `state.pinnedTierByProfile[model.id]` with `resolveEffectivePin(state.scope, state.currentConfig)` call
- [ ] 3.2 Update `src/routing/compose.ts` — `RoutingInput.pinnedTier` now receives result from `resolveEffectivePin` (tier or undefined)
- [ ] 3.3 After heuristic/classifier runs in `compose.ts`, call `setScopedPin` for pin-creating events (Rule J, classifier override, rule match) — only when source is P2 and no active pin

## 4. Update Commands

- [ ] 4.1 Rewrite `src/commands/pin.ts` — `/router pin <tier>` sets `scope.scopedPin` via `setScopedPin(scope, tier, "user", config)` with P1 priority; `/router pin auto` calls `clearScopedPin(scope)`
- [ ] 4.2 Rewrite `src/commands/fix.ts` — `/router fix <tier>` sets `scope.scopedPin` via `setScopedPin(scope, tier, "user", config)` with P1 priority
- [ ] 4.3 Update `src/commands/status.ts` — show scoped pin tier, source, and remaining TTL instead of global pin map

## 5. Remove Global Pin State

- [ ] 5.1 Remove `pinnedTierByProfile: RouterPinByProfile` from `RouterState` class in `src/state/index.ts`
- [ ] 5.2 Remove `RouterPinByProfile` type from `src/types.ts` (or deprecate)
- [ ] 5.3 Remove `pinByProfile` and `pinTier` from `RouterPersistedState` in `src/types.ts`
- [ ] 5.4 Remove pin persistence in `src/state/persist.ts` — delete `pinTier`/`pinByProfile` from `buildPersistedState`, remove restoration of pins in `restoreFromSession`
- [ ] 5.5 Update `src/ui/status.ts` — replace all `pinnedTierByProfile` references with scoped pin reads
- [ ] 5.6 Update `src/ui/profile.ts` — remove `pinnedTierByProfile` parameter, use scoped pin

## 6. Auto-Upgrade Integration

- [ ] 6.1 Update auto-upgrade in `src/index.ts` (`tool_execution_end` handler) — when `autoUpgradeTier` is set, use `setScopedPin(scope, tier, "auto-upgrade", config)` instead of the one-shot override pattern in provider.ts
- [ ] 6.2 Remove `state.autoUpgradeTier` field and the one-shot override block in `src/provider.ts` (auto-upgrade now goes through scoped pin system)

## 7. Tests

- [ ] 7.1 Write unit tests for `resolveEffectivePin` — active pin, expired pin, absent pin, config floor variations
- [ ] 7.2 Write unit tests for `setScopedPin` — P1 override, P2 blocked by active pin, P2 sets when none active
- [ ] 7.3 Write unit tests for `clearScopedPin` — clears pin and lastDecision
- [ ] 7.4 Write integration test: sticky loop is bounded — simulate Rule J firing, verify pin expires after timeout and heuristic runs fresh
- [ ] 7.5 Write integration test: user pin overrides system pin and decays independently
- [ ] 7.6 Write integration test: sub-agent session has independent pin lifecycle
- [ ] 7.7 Update/remove existing pin-related tests that reference `pinnedTierByProfile`
- [ ] 7.8 Run `bun run test` — verify all 334+ tests pass (update count as needed)

## 8. Config & Documentation

- [ ] 8.1 Update `AGENTS.md` — document `defaultPin` and `pinTimeout` config fields, remove "Adding a new top-level field" pitfall for pin (it's gone)
- [ ] 8.2 Update config example in `AGENTS.md` to include `defaultPin` and `pinTimeout`
- [ ] 8.3 Verify `bun run test test/config-field-preservation.test.ts` passes with new fields
