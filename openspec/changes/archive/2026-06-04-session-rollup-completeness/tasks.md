## 1. `mergeModelCosts` private helper

- [ ] 1.1 Add `private mergeModelCosts(target: Map<string, ModelCostEntry>, source: Map<string, ModelCostEntry>): void` to `RouterState` in `src/state/index.ts`.
- [ ] 1.2 For each `[key, srcEntry]` in `source`: if `target` has `key`, sum `invocations`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost` in-place and keep `target`'s `tier`; otherwise `target.set(key, { ...srcEntry })` (shallow copy, not reference).
- [ ] 1.3 No side effects outside the two maps. No error thrown for empty source or empty target.

## 2. Expand `finalizeChildSession`

- [ ] 2.1 In `src/state/index.ts` `finalizeChildSession`, after the existing 5 numeric fields, add:
  - `parent.compressionRequestCount      += child.compressionRequestCount;`
  - `parent.compressionTotalOriginalChars += child.compressionTotalOriginalChars;`
  - `parent.compressionTotalCompressedChars += child.compressionTotalCompressedChars;`
- [ ] 2.2 Add element-wise `tierCounter` merge:
  - `parent.tierCounter.high   += child.tierCounter.high;`
  - `parent.tierCounter.medium += child.tierCounter.medium;`
  - `parent.tierCounter.low    += child.tierCounter.low;`
- [ ] 2.3 Call `this.mergeModelCosts(parent.modelCosts, child.modelCosts);`.
- [ ] 2.4 Add skip-comments immediately after the merge block (before `scopes.delete`):
  ```ts
  // SKIP: debugHistory, lastDecision — parent retains its own routing trace.
  // SKIP: isStreaming, lastTurnTimestamp, currentCheckpoint — per-session ephemeral state.
  // SKIP: sessionId, parentSessionId — identity fields.
  ```
- [ ] 2.5 Update the JSDoc on `finalizeChildSession` to list all 8 merged fields explicitly and reference the skip rationale from the design doc.

## 3. Test coverage — `test/session-rollup-completeness.test.ts`

- [ ] 3.1 Test: all 8 numeric fields roll up (parent + child for each of the 8 fields).
- [ ] 3.2 Test: `tierCounter` element-wise sum — both parent and child have non-zero values across all three tiers.
- [ ] 3.3 Test: `modelCosts` — child-only key is copied to parent after rollup.
- [ ] 3.4 Test: `modelCosts` — colliding key, same tier: invocations and all token/cost fields summed; tier unchanged.
- [ ] 3.5 Test: `modelCosts` — colliding key, different tier labels: numeric fields summed; parent's tier label wins.
- [ ] 3.6 Test: ephemeral fields not touched — assert `lastDecision`, `isStreaming`, `currentCheckpoint`, `lastTurnTimestamp` on parent are unchanged after rollup.
- [ ] 3.7 Test: child scope is deleted after `finalizeChildSession`.
- [ ] 3.8 Test: no parent (`parentSessionId === undefined`) — no error, scope deleted, no other scope mutated.
- [ ] 3.9 Test: multi-level rollup — grandchild → child → parent; all 8 numeric fields accumulate transitively.
- [ ] 3.10 Test: regression guard — `Object.keys` of a freshly-created `SessionScope` matches the union of known-merged and known-skipped field sets; fails with a clear message if a new field appears without classification.

## 4. Documentation

- [ ] 4.1 Update the JSDoc on `finalizeChildSession` in `src/state/index.ts` to enumerate all 8 merged fields and all explicitly-skipped fields with brief rationale for each skip.
- [ ] 4.2 Update `AGENTS.md` "Follow-on rollup threads" section (added in Thread C): mark Thread B as complete, describe what was added so the progression is clear.

## 5. Verification

- [ ] 5.1 `bun test test/session-rollup-completeness.test.ts` — all 10 tests pass.
- [ ] 5.2 `bun run test` — full suite still green, no regressions (Thread C's 5.7 integration test remains valid).
