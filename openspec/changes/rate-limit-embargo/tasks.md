## 1. Types & Configuration

- [x] 1.1 Add `EmbargoEntry` interface and `EmbargoConfig` interface to `src/types.ts` (fields: `enabled`, `defaultCooldownMs`, `minCooldownMs`, `maxCooldownMs`)
- [x] 1.2 Add `embargo?: EmbargoConfig` field to `RouterConfig` interface
- [x] 1.3 Add default embargo config to `FALLBACK_CONFIG` in `src/config.ts` (`enabled: true, defaultCooldownMs: 60000, minCooldownMs: 5000, maxCooldownMs: 3600000`)

## 2. Embargo State Management

- [x] 2.1 Add `embargoMap: Map<string, EmbargoEntry>` to `RouterState` class in `src/state/index.ts`
- [x] 2.2 Implement `embargoModel(modelRef, status, reason, durationMs)` method on `RouterState` — sets entry and triggers persist
- [x] 2.3 Implement `isEmbargoed(modelRef): boolean` method (checks expiry, lazy-cleans expired entries)
- [x] 2.4 Implement `liftEmbargo(modelRef)` method (removes entry from map, triggers persist)
- [x] 2.5 Implement `getActiveEmbargoes(): EmbargoEntry[]` method for UI/commands
- [x] 2.6 Implement `clearAllEmbargoes()` method (clears map, triggers persist)
- [x] 2.7 Implement `getSoonestExpiry(modelRefs: string[]): string` helper for deadlock prevention
- [x] 2.8 Implement `persistEmbargo()` — debounced write to `~/.omp/agent/model-router-embargo.json`
- [x] 2.9 Implement `restoreEmbargo()` — read from file on init, discard expired entries
- [x] 2.10 Call `restoreEmbargo()` in `session_start` handler and `reloadConfig()`

## 3. Error Classification & Retry-After Parsing

- [x] 3.1 Create `src/embargo.ts` module with `isRetryableStatus(status: number | undefined, message: string): boolean` function
- [x] 3.2 Implement `parseRetryAfterMs(errorMessage: string): number | undefined` — extracts `retry-after-ms=<value>` pattern embedded by pi-ai's `formatErrorMessageWithRetryAfter`
- [x] 3.3 Implement `computeEmbargoDuration(retryAfterMs: number | undefined, config: EmbargoConfig): number` — applies `clamp(retryAfterMs ?? defaultCooldownMs, minCooldownMs, maxCooldownMs)`
- [x] 3.4 Create `StatusAwareError` class that preserves `status`, `retryAfterMs`, and original message from stream error events

## 4. Provider Fallback Loop Integration

- [x] 4.1 Update error event handler in `provider.ts` to extract `errorStatus` and `errorMessage` from the error event; throw `StatusAwareError` with parsed `retryAfterMs`
- [x] 4.2 Add embargo-aware filtering of `modelsToTry` before the `for` loop (skip embargoed, use soonest-expiry if all blocked)
- [x] 4.3 Update catch block to call `state.embargoModel()` when error is retryable, passing computed duration from `computeEmbargoDuration`
- [x] 4.4 Add `state.liftEmbargo(modelRef)` call on successful stream completion
- [x] 4.5 Add debug logging for embargo events (embargoed with duration, skipped, lifted)
- [x] 4.6 Add `isEmbargoed?: boolean` and `embargoTimeRemaining?: number` fields to `RoutingDecision` type for observability

## 5. Command Integration

- [x] 5.1 Add `/router embargo` subcommand that displays active embargoes with model, reason, status, and time remaining
- [x] 5.2 Add `/router embargo clear` to manually clear all embargoes
- [x] 5.3 Register embargo subcommand in command router (`src/commands/index.ts`)

## 6. Testing

- [x] 6.1 Unit tests for `isRetryableStatus` — covers 429, 503, 529, 502, undefined+text match, and non-retryable 401/403
- [x] 6.2 Unit tests for `parseRetryAfterMs` — extracts value from `retry-after-ms=30000`, handles missing, handles malformed
- [x] 6.3 Unit tests for `computeEmbargoDuration` — applies clamp with min/max/default correctly; Anthropic-style long retry (4h) capped to max
- [x] 6.4 Unit tests for `RouterState` embargo methods — set, check, lift, expiry, clear, soonest-expiry
- [x] 6.5 Integration test: embargo-aware chain skips embargoed primary and uses fallback
- [x] 6.6 Integration test: all-embargoed scenario uses soonest-expiry model
- [x] 6.7 Integration test: successful stream lifts embargo
- [x] 6.8 Test embargo disabled via config (`embargo.enabled: false`)
- [x] 6.9 Test provider-signaled long embargo (retry-after-ms=14400000) is capped to maxCooldownMs
- [x] 6.10 Test `persistEmbargo()` writes correct JSON to file
- [x] 6.11 Test `restoreEmbargo()` reads file, discards expired entries, restores valid ones
- [x] 6.12 Test `restoreEmbargo()` handles missing/corrupt file gracefully (empty map, no throw)
