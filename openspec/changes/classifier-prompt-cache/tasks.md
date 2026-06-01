# Tasks: Classifier Prompt Cache

## Execution Order

Tasks 1 → 2 → 3 → 4 are strictly sequential (each depends on the previous symbol existing).
Task 5 (tests) runs after task 4. Task 6 (regression) is the final gate.

All implementation is confined to four files:

- `src/state/index.ts` — add cache fields to `RouterState`
- `src/types.ts` — extend `RouterConfig`
- `src/config.ts` — populate `FALLBACK_CONFIG`
- `src/routing/compose.ts` — implement the cache gate
- `test/classifier-prompt-cache.test.ts` — new test file

---

## Task 1: Add Cache Fields to RouterState

**File:** `src/state/index.ts`
**Lines:** ~86–94 (the "Routing state" group, before "Session-scoped state")

**Steps:**

1. Import `RouterTier` is already in scope (line 7).
2. Add the three fields to the `RouterState` class body, grouped under a new section comment:
   ```typescript
   // ─── Classifier prompt cache (Phase 1: prompt-equality, TTL-gated) ────
   /** Signature of the last prompt the classifier scored. */
   lastClassifierKey: string | undefined;
   /** Verdict the classifier returned for `lastClassifierKey`. */
   lastClassifierVerdict: { tier: RouterTier; reasoning: string } | undefined;
   /** Turns elapsed since the classifier last ran (0 = it just ran this turn). */
   classifierTurnsSinceRun = 0;
   ```
3. No changes to `persist.ts` — these fields are transient and intentionally not serialized.
4. No changes to the constructor — class field initializers cover initialization
   (`undefined / undefined / 0`).

**Acceptance:**

- `RouterState` instantiation compiles with no TS errors.
- The fields are accessible via `state.lastClassifierKey`, `state.lastClassifierVerdict`,
  `state.classifierTurnsSinceRun`.
- `bun run build` (or `tsc --noEmit`) passes.
- The existing persistence round-trip tests (anything in `test/` touching `RouterPersistedState`)
  still pass without modification — the new fields must not appear in `buildPersistedState`.

---

## Task 2: Extend RouterConfig and FALLBACK_CONFIG

**File:** `src/types.ts`
**Lines:** 133–162 (the `RouterConfig` interface)

**Steps:**

1. Add the optional block at the end of `RouterConfig`, before the closing brace:
   ```typescript
   /** Classifier prompt-equality cache (Phase 1). */
   classifierCache?: {
       /** Force the classifier to re-run after this many turns even if the prompt is unchanged. Default: 20. */
       ttlTurns?: number;
   };
   ```

**File:** `src/config.ts`
**Lines:** 18+ (inside the `FALLBACK_CONFIG` object literal)

2. Add to `FALLBACK_CONFIG`:
   ```typescript
   classifierCache: { ttlTurns: 20 },
   ```
   Per AGENTS.md "Adding a new top-level field" rule: any new optional field on `RouterConfig`
   MUST also appear in `FALLBACK_CONFIG` so the spread-merge invariant in config loading preserves
   defaults across partial user configs.

**Acceptance:**

- `RouterConfig` and `FALLBACK_CONFIG` compile.
- A user config that omits `classifierCache` still receives `{ ttlTurns: 20 }` after the standard
  fallback merge.
- A user config with `classifierCache: { ttlTurns: 5 }` overrides only `ttlTurns` and keeps every
  other default field.

---

## Task 3: Implement Cache Gate in resolveRouting

**File:** `src/routing/compose.ts`
**Lines:** 171–235 (the existing classifier-override block)

**Prerequisites:**

- `RouterState` must be reachable from `resolveRouting`. Audit the current call sites — either
  `state` is already threaded through `RoutingInput`, or it must be added. (Inspect by searching
  for `resolveRouting(` call sites; if `state` is not present, add it as a required field of
  `RoutingInput`: `state: RouterState;`, and update each call site.)

**Steps:**

1. **Add helper at module top (after imports):**
   ```typescript
   import { getLastUserText } from "../utils/messages";

   const computeClassifierSig = (context: Context): string => {
       const text = getLastUserText(context) ?? "";
       let userMsgIndex = 0;
       for (const m of context.messages) {
           if (m.role === "user") userMsgIndex++;
       }
       return `${text}|${userMsgIndex}`;
   };
   ```

2. **Add `state: RouterState` to `RoutingInput`** if not already present. Import `RouterState`
   from `../state`.

3. **Rewrite the classifier block (compose.ts:171-211)** to gate on the cache:
   ```typescript
   // 3. Classifier override — gated by prompt-equality cache.
   let syncClassifierRan = false;
   let verdict: { tier: RouterTier; reasoning: string } | undefined;
   if (
       config.classifierModel &&
       !input.pinnedTier &&
       !decision.isContextTriggered &&
       !decision.isRuleMatched
   ) {
       const ttlTurns = input.state.currentConfig.classifierCache?.ttlTurns ?? 20;
       const sig = computeClassifierSig(input.context);
       const cacheHit =
           input.state.lastClassifierKey === sig &&
           input.state.lastClassifierVerdict !== undefined &&
           input.state.classifierTurnsSinceRun < ttlTurns;

       if (cacheHit) {
           verdict = input.state.lastClassifierVerdict;
           input.state.classifierTurnsSinceRun += 1;
       } else {
           const { runClassifier } = await import("./index.js");
           verdict = await runClassifier(
               config.classifierModel,
               input.modelRegistry,
               input.context,
               decision.phase,
               config.debug,
           );
           syncClassifierRan = true;
           if (verdict) {
               input.state.lastClassifierKey = sig;
               input.state.lastClassifierVerdict = verdict;
               input.state.classifierTurnsSinceRun = 0;
           }
       }

       if (verdict) {
           if (input.calibration && config.calibrationConfig?.enabled) {
               updateCalibrationMatrix(input.calibration, decision.tier, verdict.tier);
           }
           decision = buildRoutingDecision(
               config.profileName,
               config.profile,
               verdict.tier,
               phaseForTier(verdict.tier),
               cacheHit
                   ? `Classifier (cached): ${verdict.reasoning}`
                   : `Classifier: ${verdict.reasoning}`,
               config.thinkingOverrides,
               true,
           );
           if (input.isBudgetExceeded && decision.tier === "high") {
               decision.tier = "medium";
               decision.phase = "implementation";
               decision.reasoning = `Budget exceeded. Downgraded classifier decision to medium. (Original: ${decision.reasoning})`;
               decision.isBudgetForced = true;
           }
       } else {
           // Classifier failed (MISS path only — cache HIT always yields a verdict).
           // Existing fallback path: matrix calibration + heuristic.
           if (input.calibration && config.calibrationConfig?.enabled) {
               const calibratedTier = applyCalibratedTier(
                   decision.tier,
                   input.calibration,
                   config.calibrationConfig,
               );
               if (calibratedTier !== decision.tier) {
                   decision = buildRoutingDecision(
                       config.profileName,
                       config.profile,
                       calibratedTier,
                       phaseForTier(calibratedTier),
                       `Calibrated: heuristic ${decision.tier} → ${calibratedTier} (matrix-based override)`,
                       config.thinkingOverrides,
                       false,
                   );
               }
           }
           decision.reasoning = `Classifier unavailable, using heuristic: ${decision.reasoning}`;
       }
   }
   ```

4. **Add context-capacity cache bust** at `compose.ts:152-165` (inside the existing block that sets
   `decision.isContextTriggered = true`):
   ```typescript
   if (promoted && promoted.tier !== decision.tier) {
       decision = buildRoutingDecision(/* … existing args … */);
       decision.isContextTriggered = true;
       // Cache bust: routing context changed, force re-eval on next eligible turn.
       input.state.lastClassifierKey = undefined;
       input.state.lastClassifierVerdict = undefined;
       input.state.classifierTurnsSinceRun = 0;
   }
   ```

5. **Verify the local rename** (`syncClassifierVerdict` → `verdict`) does not break the metadata
   attachment on line 238: `(decision as RoutingDecision & { syncClassifierRan?: boolean }).syncClassifierRan = syncClassifierRan;` — still correct because the variable is in scope.

**Acceptance:**

- Cache HIT path: classifier verdict is reused; `runClassifier` is **not** awaited.
- Cache MISS path: identical behavior to pre-change, plus stores `(sig, verdict)` and resets counter.
- TTL boundary: at `classifierTurnsSinceRun === ttlTurns` the gate falls into the MISS branch.
- `syncClassifierRan` reflects only sync **execution**, not cache reuse.
- Context-capacity promotion clears cache fields.
- The `pinnedTier` / `isRuleMatched` / `isContextTriggered` short-circuit paths still skip the
  cache block entirely — no new code runs on those paths.

---

## Task 4: Wire userMsgIndex Computation

**File:** `src/routing/compose.ts` (the `computeClassifierSig` helper from Task 3)

**Steps:**

1. Confirm the inline loop counts only `m.role === "user"` messages (not assistant, not tool).
2. Confirm no new imports beyond `getLastUserText` from `../utils/messages`.
3. Confirm the helper is module-private (no `export`).
4. No changes to `src/utils/messages.ts`. The count is a 4-line inline accumulator.

**Acceptance:**

- For `context.messages = [{role:'user'}, {role:'assistant'}, {role:'user'}, {role:'assistant'}]`,
  `computeClassifierSig` returns `"<text>|2"`.
- For an empty `context.messages`, returns `"|0"` (does not throw).
- `getLastUserText` returning `undefined` becomes `""` in the signature, not the string
  `"undefined"`.

---

## Task 5: Unit Tests

**File:** `test/classifier-prompt-cache.test.ts` (new file)

**Setup:**

- Stub `runClassifier` (via Bun mock or a test-only export) to return a deterministic verdict and
  count invocations.
- Construct a minimal `RouterState` + `RoutingInput` + `RoutingConfig` per test, with
  `classifierModel: "stub-provider/stub-model"` so the classifier branch is eligible.
- Build `context.messages` directly; do not exercise the full hooks pipeline.

**Test cases:**

### T5.1 — Cache HIT skips runClassifier

```
1. Call resolveRouting twice with identical context.messages and identical state.
2. Assert runClassifier.callCount === 1 after the second call.
3. Assert both decisions have the same tier and reasoning.
4. Assert second decision.reasoning matches /Classifier \(cached\)/.
```

### T5.2 — TTL expiry triggers re-run

```
1. Set state.currentConfig.classifierCache = { ttlTurns: 3 }.
2. Call resolveRouting four times with identical context.
3. Assert runClassifier.callCount === 2 (turn 1 MISS, turns 2–3 HIT, turn 4 MISS at boundary).
4. Assert state.classifierTurnsSinceRun === 0 after the fourth call.
```

### T5.3 — New user message busts cache

```
1. Call resolveRouting with messages = [user("a"), assistant("ok")].
2. Append [user("b")] and call again.
3. Assert runClassifier.callCount === 2 (different lastUserText AND different userMsgIndex).
```

### T5.4 — Same user text repeated (userMsgIndex disambiguation)

```
1. Call with messages = [user("run tests")].
2. Append [assistant("done"), user("run tests")] and call again.
3. Assert runClassifier.callCount === 2 — userMsgIndex changed from 1 to 2, signatures differ.
```

### T5.5 — Context-capacity promotion clears cache

```
1. Call with normal context → MISS, cache populated.
2. Inject lastExtensionContext.getContextUsage returning tokens > tier capacity to force promotion.
3. Assert state.lastClassifierKey === undefined after the second call.
4. Call a third time with normal context — assert runClassifier ran again (MISS).
```

### T5.6 — Calibration matrix still updated on cache HIT

```
1. Enable calibration: calibrationConfig.enabled = true, input.calibration = freshMatrix.
2. Call twice with identical context.
3. Stub updateCalibrationMatrix and assert it was called BOTH times (with the same
   (heuristicTier, verdictTier) pair).
```

### T5.7 — Pinned tier path bypasses cache entirely

```
1. Set input.pinnedTier = "low".
2. Call resolveRouting; assert runClassifier never called and cache fields remain undefined.
3. Call again with pinnedTier removed; assert classifier MISS (cache was not stale-populated).
```

### T5.8 — Classifier returns undefined → cache not poisoned

```
1. Stub runClassifier to return undefined.
2. Call resolveRouting.
3. Assert state.lastClassifierKey === undefined, lastClassifierVerdict === undefined.
4. Call again with a working stub — assert MISS path runs (cache was not populated with a stale key).
```

### T5.9 — syncClassifierRan reflects execution, not cache reuse

```
1. First call → assert (decision as any).syncClassifierRan === true.
2. Second identical call (HIT) → assert (decision as any).syncClassifierRan === false.
```

**Acceptance:**

- All nine tests pass under `bun test test/classifier-prompt-cache.test.ts`.
- No flakiness — every test is deterministic (stubbed classifier, no real LLM call).

---

## Task 6: Regression — Existing Classifier Tests

**Files:**

- `test/classifier-fallback-chain.test.ts`
- `test/user-model-switch.test.ts`
- any test under `test/` whose name contains `classifier`, `routing`, `compose`, or `calibration`

**Command:** `bun test`

**Steps:**

1. Run the full test suite.
2. For any failures, classify:
   - **Expected updates:** a test that constructed `RoutingInput` without `state` — add it.
   - **Expected updates:** a test that called `resolveRouting` twice and expected two classifier
     invocations — either disable the cache for that test (`classifierCache: { ttlTurns: 0 }`)
     or vary the context between calls.
   - **Unexpected failures:** anything else is a real regression; fix the code, not the test.

**Acceptance:**

- `bun test` exit code 0.
- The set of changed test files is limited to constructor/input plumbing — no test's behavioral
  assertion is weakened or removed.
- The existing 372 tests pass (per memory summary baseline); 9 new tests bring the total to 381.

---

## Summary Table

| Task | Files Touched | Lines Δ | Risk | Notes |
|------|---------------|--------:|------|-------|
| 1 | `src/state/index.ts` | +6 | Trivial | Pure additive field declarations |
| 2 | `src/types.ts`, `src/config.ts` | +5, +1 | Trivial | Optional config block + fallback |
| 3 | `src/routing/compose.ts` | ~+40 / ~-20 | Medium | Cache gate, context-capacity bust, local rename |
| 4 | `src/routing/compose.ts` (same file as 3) | +5 | Trivial | Inline signature helper |
| 5 | `test/classifier-prompt-cache.test.ts` | +200 (new file) | Zero | Stubbed classifier; no real LLM |
| 6 | misc test plumbing | ±20 | Low | Add `state` to `RoutingInput` literals |

**Total implementation:** ~50 lines of production code, ~200 lines of new tests, ~20 lines of test
plumbing. No new modules, no new dependencies.
