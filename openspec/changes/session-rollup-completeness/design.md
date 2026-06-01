## Context

`RouterState.finalizeChildSession(childSessionId)` runs on `agent_end`. After Thread C, `child.parentSessionId` is reliably set from `SessionHeader.parentSession`. The method merges child counters into the parent scope and deletes the child scope.

`SessionScope` has 15 fields. Their rollup disposition:

```
Field                           Type                Rollup
─────────────────────────────── ─────────────────── ──────────────────────────────
sessionId                       string              SKIP  — identity
parentSessionId                 string | undefined  SKIP  — identity
accumulatedCost                 number              SUM   (already done)
accumulatedOriginalTokens       number              SUM   (already done)
accumulatedCompressedTokens     number              SUM   (already done)
accumulatedTokensSaved          number              SUM   (already done)
accumulatedCacheReadTokens      number              SUM   (already done)
compressionRequestCount         number              SUM   ← add this
compressionTotalOriginalChars   number              SUM   ← add this
compressionTotalCompressedChars number              SUM   ← add this
tierCounter                     TierCounter         SUM   ← element-wise (high/medium/low)
modelCosts                      Map<string,Entry>   MERGE ← by model key (see D1)
debugHistory                    RoutingDecision[]   SKIP  — parent's own trace
lastDecision                    RoutingDecision?    SKIP  — parent's own last decision
lastTurnTimestamp               number | undefined  SKIP  — per-session timing
currentCheckpoint               Checkpoint?         SKIP  — per-session TOON state
isStreaming                     boolean             SKIP  — live-status flag
```

## Goals / Non-Goals

**Goals:**
- All 8 aggregable fields are merged, not just 5.
- `modelCosts` Map merge is correct under all three collision cases.
- Deliberately-excluded fields are documented and test-asserted.
- A regression guard test ensures future additions to `SessionScope` don't silently go unrolled.

**Non-Goals:**
- Thread A (usage reporting from in-memory scope).
- Changing what `/router usage` renders — the data becomes complete; visibility is Thread A.

## Decisions

### D1: `mergeModelCosts(target, source)` — merge rule for colliding model keys

**Scenario A — key absent from target:** copy the child entry wholesale into target.

**Scenario B — key present in both, same tier:** sum `invocations`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost` in-place on the existing target entry.

**Scenario C — key present in both, different tier labels:** sum the numeric fields (identical to B); **keep the parent's `tier` label**. Rationale: the parent is the primary scope for reporting; the child likely ran the same model under a different profile assignment. The tier label is presentational; the cost numbers are authoritative.

**Why a private helper:** the merge logic is non-trivial (Map iteration + conditional copy vs. in-place mutation). Extracting `mergeModelCosts` makes the logic independently testable without constructing full `RouterState` instances.

### D2: `tierCounter` merge is element-wise sum, not Map

`TierCounter` is `{ high: number; medium: number; low: number }` — a simple struct, not a Map. Merge is three additions: `parent.tierCounter.high += child.tierCounter.high`, etc.

**Why not derive from `modelCosts`:** `tierCounter` and `modelCosts` track different things. `tierCounter` is incremented at routing-decision time (before the LLM call). `modelCosts` is updated at stream-completion time (when usage arrives). A tier decision can happen without a `modelCosts` update (e.g. if the stream errors before returning usage). Keeping both correct independently preserves this invariant.

### D3: Explicitly excluded fields are documented in code, not just design

Each `SKIP` in the rollup table is represented by a named comment in `finalizeChildSession` so future contributors don't silently add them to the merge by mistake. Pattern:

```ts
// SKIP: lastDecision, debugHistory — parent retains its own routing trace.
// SKIP: isStreaming, lastTurnTimestamp, currentCheckpoint — per-session ephemeral state.
// SKIP: sessionId, parentSessionId — identity fields.
```

### D4: Regression guard test

`SessionScope` currently has 15 fields. The regression guard lists every field by name and asserts each is either in the "merged" set or the "skipped" set. When a new field is added to `SessionScope` without updating the test, the guard fails with a clear message.

Implementation: maintain a Set of known field names in the test, compare against `Object.keys(emptyScope)`.

## Architecture

### Before (5 fields)

```
finalizeChildSession(childId):
    child = scopes.get(childId)
    parent = scopes.get(child.parentSessionId)
    parent.accumulatedCost              += child.accumulatedCost
    parent.accumulatedOriginalTokens    += child.accumulatedOriginalTokens
    parent.accumulatedCompressedTokens  += child.accumulatedCompressedTokens
    parent.accumulatedTokensSaved       += child.accumulatedTokensSaved
    parent.accumulatedCacheReadTokens   += child.accumulatedCacheReadTokens
    scopes.delete(childId)
```

### After (8 summed fields + Map merge)

```
finalizeChildSession(childId):
    child = scopes.get(childId)
    parent = scopes.get(child.parentSessionId)
    // numeric sums
    parent.accumulatedCost              += child.accumulatedCost
    parent.accumulatedOriginalTokens    += child.accumulatedOriginalTokens
    parent.accumulatedCompressedTokens  += child.accumulatedCompressedTokens
    parent.accumulatedTokensSaved       += child.accumulatedTokensSaved
    parent.accumulatedCacheReadTokens   += child.accumulatedCacheReadTokens
    parent.compressionRequestCount      += child.compressionRequestCount      ← new
    parent.compressionTotalOriginalChars+= child.compressionTotalOriginalChars ← new
    parent.compressionTotalCompressedChars += child.compressionTotalCompressedChars ← new
    // struct sum
    parent.tierCounter.high   += child.tierCounter.high                       ← new
    parent.tierCounter.medium += child.tierCounter.medium                     ← new
    parent.tierCounter.low    += child.tierCounter.low                        ← new
    // Map merge
    mergeModelCosts(parent.modelCosts, child.modelCosts)                      ← new
    // explicit skips (documented)
    scopes.delete(childId)
```

### `mergeModelCosts` helper

```
mergeModelCosts(target: Map<string, ModelCostEntry>, source: Map<string, ModelCostEntry>):
    for each [key, srcEntry] of source:
        existing = target.get(key)
        if existing:
            existing.invocations      += srcEntry.invocations
            existing.inputTokens      += srcEntry.inputTokens
            existing.outputTokens     += srcEntry.outputTokens
            existing.cacheReadTokens  += srcEntry.cacheReadTokens
            existing.cacheWriteTokens += srcEntry.cacheWriteTokens
            existing.cost             += srcEntry.cost
            // keep existing.tier (parent's label wins — D1)
        else:
            target.set(key, { ...srcEntry })   // copy, not reference
```

## Test Strategy

### `test/session-rollup-completeness.test.ts`

1. **All 8 numeric fields roll up**: create parent + child with known values for all 8 numeric fields; call `finalizeChildSession`; assert parent totals equal parent-original + child for each field.

2. **tierCounter element-wise sum**: parent has `{high:2, medium:1, low:0}`, child has `{high:1, medium:0, low:3}`; after rollup, parent has `{high:3, medium:1, low:3}`.

3. **modelCosts — new key in child**: child has model `"anthropic/claude-haiku"` with cost=0.01; parent doesn't; after rollup, parent's map has the entry.

4. **modelCosts — colliding key, same tier**: parent has `"bedrock/nova"` with 2 invocations; child has same key with 3 invocations; after rollup, 5 invocations, summed tokens and cost.

5. **modelCosts — colliding key, different tier labels**: parent has `"openai/gpt-4o"` with `tier: "high"`; child has same key with `tier: "medium"`; after rollup, `tier` stays `"high"` (parent wins).

6. **Ephemeral fields not copied**: after rollup, `parent.lastDecision` is still the parent's own value (not overwritten by child's); `parent.isStreaming` unchanged; `parent.currentCheckpoint` unchanged; `parent.lastTurnTimestamp` unchanged.

7. **Child scope deleted**: after `finalizeChildSession`, `sessionScopes.get(childId)` returns `undefined`.

8. **No parent: no rollup, scope deleted**: child with `parentSessionId = undefined`; call `finalizeChildSession`; no error; child scope deleted; parent scope (if any) unchanged.

9. **Multi-level rollup (grandchild → child → parent)**: set up grandchild → child → parent; call `finalizeChildSession(grandchild)`, then `finalizeChildSession(child)`; assert all 8 numeric fields accumulated correctly in parent.

10. **Regression guard**: every field in `SessionScope` is either in the "merged" set or the "skipped" set. Fails loudly if a new field is added without updating this test.

## Migration / Rollback

- **Migration**: none. No config change, no schema change. The merge is additive — parent numbers increase where they were previously wrong.
- **Rollback**: revert. Parent numbers return to under-counting.
- **Compatibility**: all existing tests pass unchanged. Thread C's test (5.7) remains a valid subset of Thread B's coverage.
