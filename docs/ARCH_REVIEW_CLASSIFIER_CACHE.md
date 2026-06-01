# Architecture Review — Classifier Prompt-Equality Cache (Phase 1)

Reviewer artifact for the design in `local://classifier-cache-shared-context.md`.
Goal: gate `runClassifier` in `compose.ts` on a `(lastUserText|userMsgIndex)` signature
to eliminate the 81.9 % redundant classifier invocations measured across 2,183 turns.

This review only audits Phase 1 (sync path). Phase 2 (tool-mix bucket) is out of scope
except where it interacts with Phase 1 invariants.

---

## 1. Call-site audit

**Lifecycle of a turn**

1. User submits a message → harness fires `turn_start` (`src/index.ts:293`) which only
   re-activates the session scope (`state.activateSession`, `src/index.ts:315`) and
   increments `calibration.turnsProcessed` via `onTurnStart` (`src/calibration/hooks.ts:84`).
   No routing or classifier work happens here.
2. Harness calls `router/<profile>` as the model → `createChatCompletion` in
   `src/provider.ts` reaches the routing block at `src/provider.ts:259` and calls
   `resolveRouting(input, config)`.
3. `resolveRouting` (`src/routing/compose.ts:119`) runs the heuristic (step 1, line 124),
   the context-capacity promotion (step 2, line 141), and **only then** decides whether
   to invoke the classifier at `src/routing/compose.ts:171`.
4. The classifier itself is `runClassifier`, dynamically imported at
   `src/routing/compose.ts:180` and awaited at line 181.
5. After `resolveRouting` returns, the provider also fires the *async* calibration spawn
   at `src/provider.ts:303` (`spawnClassifierForTurn`, `src/calibration/hooks.ts:140`).

**Where does the cache gate belong?**

The gate **must** sit at `src/routing/compose.ts:171-235`, wrapping the entire
classifier `if` branch. Justification, by elimination:

- **Not in `provider.ts`**: provider does not know whether the classifier will actually
  fire — that decision depends on `pinnedTier`, `decision.isContextTriggered`, and
  `decision.isRuleMatched`, all of which are produced inside `resolveRouting`. Gating
  upstream would either re-implement those checks or short-circuit pinned/rule-matched
  paths incorrectly. Provider also has no idea what `decision.phase` ends up being,
  which feeds the cache signature.
- **Not in `index.ts` / `turn_start`**: the handler has no access to the user message
  inputs at routing-decision time (the chat context arrives in the provider call), and
  the four skip conditions on lines 174-179 are not evaluable there.
- **Not deeper in `runClassifier`** (`src/routing/index.ts`): caching inside the
  classifier would still pay the dynamic `import("./index.js")` cost and the function
  call overhead, and it would scatter cache state across a module boundary while the
  cache really belongs to *this routing turn's decision context*. The cheapest, most
  honest gate is "decide whether to call `runClassifier` at all".

Conclusion: the design's site (`compose.ts:171`) is correct. The cache key, calibration
update, and `syncClassifierRan` metadata flag all live in the same block already.

---

## 2. State scope analysis

**Where does `RouterState` actually keep per-session data?**

`RouterState` (`src/state/index.ts:74`) is a *singleton* per extension load, but
session-scoped fields are stored in `sessionScopes: Map<string, SessionScope>`
(line 91) and accessed through the `get scope()` accessor (line 229) plus the
backward-compatible getter/setter pairs at lines 332-372. The top-level class fields
(`pinnedTierByProfile`, `thinkingByProfile`, `frozenCompressionBlock`, `calibration`,
`toolFailureStreak`, `autoUpgradeTier`) are **process-global**, shared across all
sessions including sub-agents.

**Does `RouterState` survive session branch?**

The singleton itself does; what it carries is rebuilt:
- `session_branch` handler (`src/index.ts:246-291`) calls `state.activateSession` then
  `state.restoreFromSession(ctx)`.
- `restoreFromSession` (`src/state/persist.ts:131`) explicitly resets
  `pinnedTierByProfile`, `thinkingByProfile`, `widgetEnabled`, `debugHistory`,
  `lastDecision` (lines 147-158).
- It then *re-hydrates* pins / thinking / debugEnabled from disk (lines 178-195) but
  **does not** restore `accumulatedCost`, `tierCounter`, `modelCosts` (line 196 comment:
  "intentionally NOT restored"). Those live on the active `SessionScope` and only zero
  when a *new* scope is allocated (`activateSession` line 170).
- `calibrationSessionBranch` (`src/calibration/hooks.ts:63-79`) clears pending and
  reopens a trace file — it does **not** clear `state.calibration` itself.

**What happens on sub-agent spawn?**

`turn_start` (`src/index.ts:297-316`) checks `ctx.sessionManager.getSessionId()`. If the
session id changed (sub-agent boundary), `activateSession` is called with the new id;
this allocates a fresh `SessionScope` (lines 170-186 of `state/index.ts`) with zeroed
counters. Existing scopes are kept in the map so `finalizeChildSession` (line 263) can
later roll the child's cost back into the parent.

**Where do cache fields belong?**

Cache fields are `lastClassifierKey`, `lastClassifierVerdict`, `classifierTurnsSinceRun`.
The decisions:

| Field placement                                | Verdict | Reasoning |
|------------------------------------------------|---------|-----------|
| Top-level `RouterState`                        | **No** — global state would cause a sub-agent's first turn to silently inherit the parent's classifier verdict for an unrelated prompt. Empirical correctness fails the moment any session branches. |
| `SessionScope` (per-session map entry)         | **Yes** — exactly the granularity we want. A sub-agent gets a fresh scope at line 170 → fresh cache. Branches and `/reload` already wipe routing state but keep scope-cost; cache fields naturally follow scope-cost behavior (ephemeral, per-session). |
| `RouterConfig`                                 | No — config is loaded state, not runtime mutation surface. |
| Module-level closure in `compose.ts`           | No — a module-level singleton would alias across concurrent sessions in the same process. Worse than RouterState because it bypasses scope isolation entirely. |

**Recommendation:** add the three fields to the `SessionScope` interface
(`src/state/index.ts:25-45`), initialize them in `activateSession`
(`src/state/index.ts:170-186`), and expose them through a single accessor
(`state.scope.lastClassifierKey` etc.) rather than adding three more
delegating getter/setter pairs. Three accessors of one-liner ceremony is not worth it.

**Does `persist.ts` persist anything that would stale the cache across restarts?**

`buildPersistedState` (`src/state/persist.ts:59-79`) persists: enabled, profile, pins,
thinking overrides, debug flags, debugHistory, lastPhase, lastDecision,
lastNonRouterModel, accumulated cost/token totals. **It does NOT persist any classifier
verdict.** Adding cache fields to `SessionScope` (not to `RouterPersistedState`) keeps
the cache ephemeral by construction — a process restart correctly forces a cold
classifier call on the next turn. Confirm: do **not** add the three fields to
`buildPersistedState`.

---

## 3. Concurrency / race conditions

**The two classifier paths**

- **Sync** (`compose.ts:181`): `await runClassifier(...)` blocks `resolveRouting`. The
  awaited verdict is what is actually applied to the routing decision returned to the
  provider on line 293. Sync timing is bounded by the LLM call.
- **Async** (`hooks.ts:140` `spawnClassifierForTurn`, called from `provider.ts:303`):
  fire-and-forget. Spawns a separate agent via `spawnClassifierAgent`
  (`hooks.ts:184`), polls up to 30 s (`MAX_WAIT_MS`, line 216), and on resolution
  writes into `state.calibration` via the trace/matrix utilities (not directly into
  any routing field). The skip on `hooks.ts:153` ("Skip async spawn in adaptive mode
  when sync classifier already ran") means the async path runs **only** in pure
  telemetry mode, *not* when the sync classifier already produced a verdict.

**Can a new turn start before the async classifier finishes?**

Yes, easily — `spawnClassifierForTurn` is fire-and-forget at `provider.ts:303` and the
provider stream returns immediately after `resolveRouting`. A 30 s poll budget vs.
sub-second turn arrival in long agent loops means overlap is the normal case. The
guard on `hooks.ts:149` (`if (cal.pendingAgentId) return;`) means a second async spawn
is suppressed while one is pending — so overlap means the *next* async spawn is
**dropped**, not racing.

**Could a stale async result overwrite a fresher sync cache hit?**

No, by the following chain:
1. The async path's only mutation surface is `state.calibration` (the matrix and
   trace) — verified by reading `hooks.ts:140-263` and noting it never assigns
   `state.lastClassifierVerdict`-like fields.
2. The sync cache fields on `SessionScope` are written only inside `compose.ts:171-235`
   (the sync block).
3. In adaptive mode (where the cache matters), the async path is **explicitly
   suppressed** when the sync classifier ran (`hooks.ts:153`). On a sync cache HIT we
   will *not* set `syncClassifierRan = true` (we are skipping the call entirely), so
   the async spawn condition flips and the async path *will* run.

**Action item for the design:** when implementing the cache, the `syncClassifierRan`
metadata flag (`compose.ts:188`, `compose.ts:238`) **must still be set to `true` on a
cache HIT**, otherwise we re-introduce duplicate classifier work via the async path
that the sync cache was meant to eliminate. Both the cached-HIT branch and the
classifier-ran branch set `syncClassifierRan = true`; only the "classifier was skipped
entirely because pinned/context-triggered/rule-matched" branch leaves it false.

**Ordering guarantee:** none required between sync and async paths because they have
disjoint write targets after the above fix.

---

## 4. Calibration matrix integrity

`updateCalibrationMatrix(heuristic, classifier)` is called once per sync classifier
run at `compose.ts:193`. The design proposes: on cache HIT, still call it with
`(decision.tier, cachedVerdict.tier)`.

**Bias analysis.** The matrix is a frequency table of (heuristic → classifier) pairs.
Recording `(newHeuristic, oldVerdict)` is only honest under the assumption that the
classifier would have returned `oldVerdict` again given the same prompt. The empirical
data backs this directly: 86.6 % of identical-prompt back-to-back invocations *did*
return the same verdict. So replaying the cached verdict is a low-bias estimator of
what a fresh classifier call would have produced.

**But:** consider the cross-product. A cache hit can only happen when the user
message is unchanged (signature stable). The *heuristic* tier, however, may flip
across turns within the same user message run — the heuristic looks at message
phase, prior decision, rules, and budget (`decideRouting` args at `compose.ts:124-134`).
So `(newHeuristic, oldVerdict)` is the natural value to record, and it carries real
signal: it tells the matrix "for this *new* heuristic guess on the same user prompt,
the classifier had said X". That is exactly the calibration mapping we want.

Recording `undefined` (i.e. skipping the matrix update) on cache HIT would throw away
80 %+ of training rows and break calibration on the long-running agent loops that
dominate cost — exactly the opposite of what we want.

**Recommendation:** record `(decision.tier, cachedVerdict.tier)` on HIT as designed.
Add a per-row `cached: true` flag to the matrix entry **only if** the matrix structure
allows it cheaply (no change otherwise — the bias is small enough that we can defer).
Out of scope for Phase 1 surgery; flag as a Phase 1.5 follow-up if calibration drift
becomes visible.

---

## 5. TTL interaction with context-capacity promotion

The context-triggered promotion at `compose.ts:141-170` sets
`decision.isContextTriggered = true` (line 164). The classifier block at
`compose.ts:171-179` already short-circuits on that flag — the classifier never runs
when context triggers a promotion. So:

- A context-triggered turn neither reads nor writes the cache (the entire block at
  171-235 is skipped). The cache is naturally orthogonal to context promotion on the
  *triggering* turn.
- **Problem:** the turn *after* a context-triggered promotion can re-enter the cache
  branch with the same `(lastUserText, userMsgIndex)` signature. If the cached verdict
  was "low" from an earlier classifier run, and the context capacity has since pushed
  us to "medium", reusing the cached "low" verdict would silently undo the promotion
  on every subsequent turn until TTL fires. That is the routing chaos the design
  worried about.

Wait — re-read. Context promotion happens at step 2 *before* the classifier block. So
on the next turn, the heuristic still produces (say) `low`, context-capacity still
promotes to `medium` (`isContextTriggered=true`), and the classifier block is again
skipped. The cached verdict is **never read** when `isContextTriggered` is true. So
the chaos scenario only materializes if the context *un-promotes* (tokens dropped
back under capacity, e.g. after TOON compression checkpoint) and we re-enter the
classifier branch with a stale cached verdict that predates the high-context regime.

**Recommendation:** simplest correct rule is **"bust cache when
`decision.isContextTriggered` is true on this turn"**. Implement as: at the top of the
cache check (after computing the new signature, before the HIT path), if
`decision.isContextTriggered` then treat as MISS and clear `lastClassifierKey`. This
costs one branch and avoids the "ghost verdict" class of bugs entirely.

Do **not** also add a sticky flag — sticky-after-context would suppress the classifier
forever on hot threads, defeating the calibration loop. The TTL reset is unnecessary
once the cache is busted (the new MISS will rewrite the key and reset the counter
naturally).

---

## 6. Budget-forced downgrade interaction

The downgrade at `compose.ts:205-210` mutates `decision.tier` from `high` → `medium`
and sets `decision.isBudgetForced` *after* the classifier verdict is applied. It
reads `input.isBudgetExceeded`, which is computed fresh in `provider.ts:246-248` on
every call (`state.accumulatedCost >= maxSessionBudget`). So:

- On a cache HIT, we restore `syncClassifierVerdict = cachedVerdict` and need to run
  the same post-classifier mutations: build the decision with the verdict's tier and
  reasoning, then re-apply the budget downgrade if `isBudgetExceeded`.
- The downgrade depends only on `isBudgetExceeded` and `decision.tier`, both of which
  are evaluated **at HIT time**, not at cache-write time. So the downgrade is
  correctly applied per-turn even with caching, provided the cache stores the *raw
  classifier verdict* (tier + reasoning) and the HIT path runs the same
  `buildRoutingDecision` → `if isBudgetExceeded && tier==="high"` sequence that the
  MISS path runs at lines 196-210.

**Recommendation:** do **not** cache the post-downgrade decision. Cache only the
`{ tier, reasoning }` returned by `runClassifier`. Re-run the build+downgrade block
on every HIT. The budget check is cheap (one comparison) and re-applying
`buildRoutingDecision` is what the MISS branch does anyway.

Do **not** bust the cache when budget transitions — the downgrade is idempotent and
deterministic given inputs.

---

## 7. `userMsgIndex` derivation

**Is `context.messages` full history or windowed?**

The `Context` type comes from `@oh-my-pi/pi-ai`. The compression layer
(`src/context-compression.ts`, 30 KB) demonstrably mutates the message array (TOON
checkpoints, frozen blocks at `state/index.ts:111`). Concretely: `frozenCompressionBlock`
holds compressed messages that *replace* prefixes of the live message array. So
`context.messages.length` is **not** monotonic across a session — it can shrink
between turns when a compression checkpoint fires.

**Failure mode of "count `role=='user'` messages".**

Compression collapses runs of mixed-role messages into a single TOON block
(`role` typically `user` or `system` — would need to verify the exact role of a TOON
block to know whether it counts). Two failure scenarios:

1. Compression preserves user messages → user count stays monotonic; design works.
2. Compression coalesces or replaces user messages → user count can decrease, the
   cache key changes back to a previously seen value, and we get a false HIT on a
   different prompt with the same `(text, index)` signature.

The design explicitly says `userMsgIndex` "never rolls back" — meaning the *intent* is
a monotonic per-session counter, not a derived count.

**Recommendation:** do **not** derive `userMsgIndex` by counting `context.messages`.
Maintain it as an explicit counter on `SessionScope` (`userMessagesSeen: number`),
incremented in `turn_start` *only when* the last message in `context.messages` has
`role==="user"` (or equivalently, when `getLastUserText(context)` differs from the
previous turn's stored value). This is O(1), survives compression, and matches the
"never rolls back" invariant by construction.

The cheaper proxy of `(context.messages.length, lastUserText)` has the same
compression vulnerability and adds nothing.

---

## 8. Risk matrix

| Risk                                                                                         | Likelihood | Impact   | Mitigation |
|----------------------------------------------------------------------------------------------|------------|----------|------------|
| Cache key derived from `context.messages` count goes stale under TOON compression            | Medium     | High     | Maintain `userMessagesSeen` as explicit `SessionScope` counter (§7). |
| Stale verdict survives across sub-agent boundary                                             | Low (if SessionScope-scoped) / High (if RouterState-scoped) | High | Place cache fields on `SessionScope`, not `RouterState` top-level (§2). |
| `syncClassifierRan` flag not set on cache HIT → async classifier re-runs in adaptive mode    | Medium     | Medium   | Set `syncClassifierRan = true` on HIT path same as MISS (§3). |
| Cached verdict reused after `isContextTriggered` un-promotion → ghost low-tier routing       | Low        | Medium   | Bust cache when `decision.isContextTriggered` on the current turn (§5). |
| Calibration matrix bias from replaying old verdict against new heuristic                     | Low        | Low      | Empirical 86.6 % stability says bias is small; record as designed; revisit if drift observed (§4). |
| Cache fields accidentally added to `RouterPersistedState` → stale verdict across `/reload`   | Low        | Medium   | Document non-persistence explicitly; ensure `buildPersistedState` (`persist.ts:59`) is **not** modified (§2). |
| TTL=20 too aggressive for short loops / too lax for long ones                                | Low        | Low      | Empirical data shows TTL=20 captures 98 % of savings; ship as default; expose via `classifierCache.ttlTurns` config. |
| Budget downgrade not re-applied on HIT                                                       | Low        | Medium   | Cache raw verdict only; rebuild + downgrade per-turn (§6). |
| Race between cached HIT and concurrent calibration matrix write                              | Very low   | Low      | Single-threaded JS event loop + matrix writes are sync within `compose.ts:193`; no lock needed. |

---

## 9. Verdict

**Proceed with modifications.** The design is sound at the architectural level (correct
gate site, correct rationale for caching, empirical backing). Five concrete
modifications are required before implementation:

1. **Place cache fields on `SessionScope`** (`src/state/index.ts:25-45`), not on
   `RouterState` top-level. Initialize in `activateSession` (line 170). Do not add
   them to `buildPersistedState`.
2. **Maintain `userMessagesSeen` as an explicit `SessionScope` counter**, incremented
   in `turn_start` when a new user message appears. Do not derive by counting
   `context.messages` (TOON compression breaks the count).
3. **Set `syncClassifierRan = true` on the cache-HIT branch** so the async calibration
   spawn at `provider.ts:303` is correctly suppressed in adaptive mode
   (`hooks.ts:153`).
4. **Bust the cache when `decision.isContextTriggered`** on the current turn. Implement
   as a HIT→MISS demotion that clears `lastClassifierKey` and resets the TTL counter.
5. **Cache only the raw `{tier, reasoning}` from `runClassifier`**. Re-run
   `buildRoutingDecision` and the budget-downgrade block (`compose.ts:196-210`) on
   every HIT so per-turn budget state is honored.

With those five changes the design is safe to implement as Phase 1. Phase 2 (tool-mix
bucket) is independently scoped and not blocked by anything here, but should not
land until Phase 1 has produced at least one round of telemetry confirming the hit
rate matches the 80 % prediction.
