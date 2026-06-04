# Design: Classifier Prompt Cache

## Current Flow (compose.ts:171-235)

```
resolveRouting(input, config)
  │
  ├─ 1. heuristic decision (decideRouting)
  │
  ├─ 2. context-capacity promotion → may set decision.isContextTriggered = true
  │
  └─ 3. classifier override (this section)
        if (classifierModel && !pinnedTier && !isContextTriggered && !isRuleMatched):
            verdict = await runClassifier(...)        ← UNCONDITIONAL LLM CALL
            if verdict:
                updateCalibrationMatrix(heuristic, verdict)
                decision = buildRoutingDecision(verdict.tier, ...)
            else:
                # fallback path (matrix calibration / heuristic)
```

Every turn whose heuristic decision isn't pinned/context-triggered/rule-matched pays the classifier
RTT. In tool loops, 81.9% of these calls receive the **same prompt** as the previous turn.

## Target Flow (after change)

```
resolveRouting(input, config)
  │
  ├─ 1. heuristic decision (unchanged)
  ├─ 2. context-capacity promotion (unchanged; sets isContextTriggered)
  │
  └─ 3. classifier override (gated by cache)
        if (classifierModel && !pinnedTier && !isContextTriggered && !isRuleMatched):
            sig = lastUserText + "|" + userMsgIndex
            cacheHit = (
                state.lastClassifierKey === sig
                && state.classifierTurnsSinceRun < ttlTurns
            )

            if cacheHit:
                verdict = state.lastClassifierVerdict         ← reuse
                state.classifierTurnsSinceRun += 1
            else:
                verdict = await runClassifier(...)            ← run + store
                if verdict:
                    state.lastClassifierKey = sig
                    state.lastClassifierVerdict = verdict
                    state.classifierTurnsSinceRun = 0
                # else: leave cache untouched, fallback path runs

            if verdict:
                updateCalibrationMatrix(heuristic, verdict)   ← ALWAYS, hit or miss
                decision = buildRoutingDecision(...)
            # else: existing fallback path unchanged
```

`pinnedTier` / `isRuleMatched` / `isContextTriggered` paths never reach the classifier block today
and never reach it after the change. The cache is a **gate strictly in front of `runClassifier`**
inside the existing `if (classifierModel && !pinned && !triggered && !rule)` branch.

## Data Model

### RouterState additions (`src/state/index.ts`)

Three fields, declared next to the existing routing-state group (around line 86–94):

```typescript
// ─── Classifier prompt cache (Phase 1: prompt-equality, TTL-gated) ────
/** Signature of the last prompt the classifier scored. */
lastClassifierKey: string | undefined;
/** Verdict the classifier returned for `lastClassifierKey`. */
lastClassifierVerdict: { tier: RouterTier; reasoning: string } | undefined;
/** Turns elapsed since the classifier last ran (0 = it just ran this turn). */
classifierTurnsSinceRun: number;
```

Initial values: `undefined / undefined / 0`. They are NOT persisted (transient session state),
following the precedent of `toolFailureStreak`, `autoUpgradeTier`, and `updateAvailable`.

### RouterConfig addition (`src/types.ts`)

```typescript
export interface RouterConfig {
    // … existing fields
    /** Classifier prompt-equality cache (Phase 1). */
    classifierCache?: {
        /** Force the classifier to re-run after this many turns even if the prompt is unchanged. Default: 20. */
        ttlTurns?: number;
    };
}
```

### FALLBACK_CONFIG addition (`src/config.ts`)

Per AGENTS.md, any new top-level field on `RouterConfig` must appear in `FALLBACK_CONFIG` so the
config-spread preservation invariant holds:

```typescript
export const FALLBACK_CONFIG: RouterConfig = {
    // …
    classifierCache: { ttlTurns: 20 },
};
```

The effective TTL at call time is `config.classifierCache?.ttlTurns ?? 20`.

## Signature Construction

```typescript
const lastUserText = getLastUserText(input.context) ?? "";
let userMsgIndex = 0;
for (const m of input.context.messages) {
    if (m.role === "user") userMsgIndex++;
}
const sig = `${lastUserText}|${userMsgIndex}`;
```

### Why include `userMsgIndex`?

The pure-text key is unsafe in one edge case: a user **repeats** the same message. Without the
index, "run the tests" sent at turn 5 and "run the tests" sent again at turn 40 would collide and
reuse a stale verdict. Including the running count of user messages disambiguates: turn 5's signature
is `"run the tests|3"`, turn 40's is `"run the tests|7"`. They are different keys, the classifier
re-runs on the repeat, and the cache is correct.

### Why inline the count instead of a new helper?

`context.messages` is already in scope; a single integer accumulator is O(n) on the message array
which the existing classifier prompt builder already walks. Adding `extractUserMsgIndex` to
`src/utils/messages.ts` is a separate module + import for two lines of code — declined.

## Cache Gate Logic

Inserted at `compose.ts:174` (immediately after the existing `if (config.classifierModel && …)`
condition opens its body, before `const { runClassifier } = await import("./index.js");`).

```typescript
const ttlTurns = state.currentConfig.classifierCache?.ttlTurns ?? 20;
const sig = computeClassifierSig(input.context);
const cacheHit =
    state.lastClassifierKey === sig &&
    state.lastClassifierVerdict !== undefined &&
    state.classifierTurnsSinceRun < ttlTurns;

let verdict: { tier: RouterTier; reasoning: string } | undefined;
if (cacheHit) {
    verdict = state.lastClassifierVerdict;
    state.classifierTurnsSinceRun += 1;
    syncClassifierRan = false;            // for telemetry parity
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
        state.lastClassifierKey = sig;
        state.lastClassifierVerdict = verdict;
        state.classifierTurnsSinceRun = 0;
    }
}
```

The downstream block (`if (verdict) { updateCalibrationMatrix(...); decision = buildRoutingDecision(...) }
else { … fallback … }`) is **unchanged** — it operates on `verdict` regardless of source.

`syncClassifierVerdict` in the existing code is renamed to `verdict` (local rename, no API change).
`syncClassifierRan` continues to feed the async-telemetry metadata at line 238 — on a cache HIT we
report `false` because the sync classifier did not actually fire.

## Invalidation Cases

| Event | State after event |
|-------|-------------------|
| New user message (different text) | `sig` changes → MISS → classifier runs |
| Same user text, `userMsgIndex` increments (user repeats themselves) | `sig` changes → MISS → classifier runs |
| `classifierTurnsSinceRun >= ttlTurns` | gate fails → MISS → classifier runs (TTL expiry) |
| Context-capacity promotion (`isContextTriggered=true`) | The outer `if (!isContextTriggered)` already skips the whole classifier block; cache fields are untouched, but the next turn's MISS will refresh them naturally |
| Sub-agent spawn (new `RouterState`) | New scope, fresh fields — no cross-contamination by construction |
| Process restart | All state lost (intentional — cache is in-memory only) |

### Note on context-capacity busting

The shared context calls out that context-capacity promotion should bust the cache because routing
context changed even though user text did not. In the existing code, context-capacity sets
`decision.isContextTriggered = true`, which makes the **outer** classifier guard short-circuit:

```typescript
if (config.classifierModel && !input.pinnedTier && !decision.isContextTriggered && !decision.isRuleMatched) {
    // classifier block — never entered on context-triggered turns
}
```

So on a context-triggered turn we never reach the cache gate at all; the decision is already pinned
to the promoted tier. On the **next** turn after promotion, the heuristic re-runs from scratch; if
the prompt text is still equal to `lastClassifierKey`, the cache HIT would reuse a verdict made under
a smaller-context world. To guard against this we explicitly clear the cache when promoting:

```typescript
if (promoted && promoted.tier !== decision.tier) {
    decision = buildRoutingDecision(...);
    decision.isContextTriggered = true;
    // Cache bust: the routing world changed, force classifier re-eval next turn.
    state.lastClassifierKey = undefined;
    state.lastClassifierVerdict = undefined;
    state.classifierTurnsSinceRun = 0;
}
```

This is a 3-line addition inside the existing context-capacity block at `compose.ts:152-165`.

## Edge Cases

### E1: Classifier returns `undefined` (model unavailable, parse failure, etc.)

The current code already handles this with a matrix-calibration fallback path. Cache behavior:
- On MISS, if `verdict` is `undefined`, **do not** update cache fields. The next turn will retry.
- Existing fallback path (lines 211–234) runs unchanged.

### E2: Pinned tier / rule-matched / context-triggered

These short-circuit before the cache gate (the outer `if` condition). The cache is neither read nor
written. State is preserved for whenever the classifier path becomes eligible again.

### E3: First turn of a session

`lastClassifierKey === undefined`, so the strict equality `state.lastClassifierKey === sig` returns
`false` (because `sig` is a non-empty string). MISS path runs and populates the cache. Correct.

### E4: Empty user text

`getLastUserText` may return `""` or `undefined`. We coerce to `""`. The signature becomes `"|<n>"`,
which is still a valid string key. Two consecutive empty-text turns at the same `userMsgIndex` would
HIT — but a turn with no user text is exotic (the classifier would also return garbage on it), and
the next user message bumps `userMsgIndex`, busting the cache. No correctness hazard.

### E5: TTL boundary (`turnsSinceRun === ttlTurns`)

The gate uses `<`, not `<=`. At exactly `ttlTurns`, we MISS and re-run. This is the intended cap —
"at most `ttlTurns` consecutive HIT turns between classifier calls".

### E6: Async telemetry classifier spawn (`hooks.ts:140`)

Out of scope. The async spawn is a separate code path that fires for telemetry/calibration after
the response stream completes. It has different idempotency requirements (it feeds matrix learning
independently). Phase 1 caches only the synchronous classifier in `compose.ts`. The
`syncClassifierRan` boolean we set on the decision (line 238) tells the async-spawn decision logic
whether the sync path ran, so reporting `false` on cache HIT means the async path will fire
naturally — preserving telemetry coverage on cached turns.

## Calibration Matrix on Cache HIT

The matrix records `(heuristicTier, classifierTier)` pairs to learn when the heuristic disagrees
with the classifier. The training signal is **per-turn**, not per-classifier-call. On a cache HIT
we still know the heuristic's verdict for **this** turn (which may differ from the previous turn
even when the user text is unchanged — `decision.tier` is recomputed every call), and we know the
classifier's verdict for this prompt (the cached one). We therefore still call:

```typescript
updateCalibrationMatrix(input.calibration, decision.tier, verdict.tier);
```

on every turn where a verdict is available, regardless of cache source. The training data remains
correct — we just stop paying the classifier to re-derive its half of the pair.

## What This Change Does **Not** Touch

- `decideRouting` — heuristic logic is untouched.
- `runClassifier` — its signature, prompt construction, and failure modes are unchanged.
- `buildClassifierPrompt` (`src/calibration/classifier-utils.ts`) — unchanged.
- The async telemetry classifier spawn in `hooks.ts` — unchanged.
- The pin/rule/context-trigger/image-upgrade gates — unchanged.
- Persistence — cache fields are transient, never serialized.

## Migration Notes

- **Config compatibility.** `classifierCache` is optional. Existing configs work without change.
  The default `ttlTurns: 20` is applied via fallback merge.
- **Behavioral compatibility.** On any non-tool-loop session (one user message → one turn), the
  cache always misses on every turn (each turn has a new `userMsgIndex`) and behavior matches the
  pre-change code exactly. The cache only activates in genuine tool loops, where it eliminates
  redundant work.
- **Telemetry compatibility.** `syncClassifierRan=false` on HIT is meaningful — it tells the async
  spawn decision logic to treat the turn as one where the classifier did not synchronously execute.
  This preserves the async spawn cadence the calibration system expects.

## Why Not …

### Why not a global LRU keyed by `lastUserText` alone?

- Cross-session leakage. Two different sessions with the same prompt would share a verdict; this
  defeats per-conversation context the classifier uses.
- Repeated-message hazard (E2 above) without `userMsgIndex`.
- Memory growth with no natural eviction.

`RouterState`-scoped + TTL turns these problems into non-issues.

### Why not key on a content hash?

`lastUserText` strings are bounded (typical user message: <2 KB) and the comparison is one
`===` per turn. A SHA-256 adds 50 µs and an import; the saving is zero.

### Why TTL in turns, not wall-clock seconds?

- Tool loops are the only place this cache fires. A loop's "rate" is turns/second, which varies
  wildly across machines and models. Turns are the unit the routing system already counts; wall
  time would add a clock dependency for no behavioral gain.
- Turn-counted TTL guarantees the classifier sees fresh input at least every N turns regardless
  of how fast the loop runs.
