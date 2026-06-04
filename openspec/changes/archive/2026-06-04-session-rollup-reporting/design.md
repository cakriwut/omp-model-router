## Context

`handleUsage` (`src/commands/usage.ts`) constructs the data passed to `renderUsageReport`. It has two data sources:

1. **JSONL rescan** (`getBranch()` scan): parses assistant messages from the current session's on-disk JSONL, accumulates per-model usage stats, derives tier counts from model-to-tier mapping. Produces `sessionModelCosts`, `sessionTierCounter`, `sessionTotalCost`.

2. **In-memory scope** (`RouterState`): `state.modelCosts`, `state.tierCounter`, `state.accumulatedCost`. Updated live during the session by `recordModelCost()` and `recordRoutingDecision()`. After Threads C+B, includes sub-agent contributions via `finalizeChildSession`.

Today the JSONL path produces data for any non-trivial session (it always finds at least one assistant message), and the in-memory path is used only when JSONL yields nothing. The JSONL path wins — but it cannot see sub-agent sessions.

**The fix is a source-selection gate at the top of the data-building block.** No rendering change, no new fields, no new config.

## Goals / Non-Goals

**Goals:**
- In-memory scope is the primary source when it contains data from this process run.
- JSONL rescan is the fallback for resumed sessions (scope is empty, process just started).
- Sub-agent model costs and tier counts are visible in `/router usage` after `agent_end` fires.
- No change to rendered output format or fields.

**Non-Goals:**
- Extending the JSONL fallback to read sub-agent JSONL files from disk.
- Changing `renderUsageReport` or `UsageReportInput`.

## Decisions

### D1: Sentinel for "in-memory has data" — `state.modelCosts.size > 0 || state.accumulatedCost > 0`

**Decision**: Use a simple OR of two conditions: the model costs map has at least one entry, OR the accumulated cost is positive.

**Rationale**: `modelCosts` is populated by `recordModelCost()`, which fires on each stream completion. If any routing has happened this process, the map is non-empty. `accumulatedCost > 0` is a belt-and-suspenders fallback: if a model was used but had $0 cost (free tier), `accumulatedCost` stays 0 but `modelCosts.size` would be 1. The OR handles both.

**What if the user calls `/router usage` before their first turn?** `modelCosts` is empty, `accumulatedCost` is 0 → JSONL fallback fires. This is correct: the JSONL has prior turns from before the current process started, and the in-memory scope has nothing yet.

**What if the router was enabled mid-session after some turns ran under a non-router model?** Those pre-router turns are in JSONL but not in `state.modelCosts` (because `recordModelCost` only fires when the router streams). After the router's first turn, `state.modelCosts.size > 0` and the in-memory path takes over. The pre-router turns are not shown — acceptable, since the router wasn't active for them and has no tier assignment for them.

### D2: JSONL rescan becomes an else-branch, not deleted

**Decision**: Wrap the existing JSONL rescan in `else { ... }`. The `sessionModelCosts` and `sessionTierCounter` variables are declared outside (empty defaults) so the render call below is unchanged structurally.

**Rationale**: The rescan is valuable for resumed sessions and should be preserved. Deleting it would silently break the "restarted process, first call to `/router usage`" case.

### D3: `renderUsageReport` call is unchanged except variable names

**Decision**: The final `renderUsageReport({...})` call passes the same fields. Only the upstream variables that feed those fields change — `reportModelCosts`, `reportTierCounter`, `reportTotalCost` replace the conditional expressions.

**Why this over conditional expressions at the call site**: The conditional expressions (`sessionModelCosts.size > 0 ? sessionModelCosts : state.modelCosts`) obscure the intent and make the preference rule hard to see or test. A single gate block at the top is more readable and easier to verify.

### D4: `accumulatedCost` is passed as `reportTotalCost` in primary path — not as the `??` fallback it was before

**Before**: `accumulatedCost: sessionTotalCost > 0 ? sessionTotalCost : state.accumulatedCost`
The comment said "Use authoritative accumulatedCost if provided (avoids undercount from debug-history cap)". This was backwards: `sessionTotalCost` was preferred but lacked child session cost; `state.accumulatedCost` was the fallback.

**After**: In the primary (in-memory) path, `reportTotalCost = state.accumulatedCost`. This is the value that includes sub-agent rollup — it is the authoritative total. In the JSONL fallback path, `reportTotalCost = sessionTotalCost` (unchanged behavior).

## Architecture

### Before

```
handleUsage():
    sessionModelCosts = {}
    sessionTotalCost = 0

    try:
        getBranch() → scan assistant messages
        populate sessionModelCosts, sessionTotalCost
        resolve tier labels for sessionModelCosts entries
    catch: (ignore)

    sessionTierCounter = derive from sessionModelCosts

    renderUsageReport({
        tierCounter:  sessionModelCosts.size > 0 ? sessionTierCounter : state.tierCounter,
        modelCosts:   sessionModelCosts.size > 0 ? sessionModelCosts  : state.modelCosts,
        accumulatedCost: sessionTotalCost > 0    ? sessionTotalCost   : state.accumulatedCost,
        ...
    })
```

### After

```
handleUsage():
    // Gate: in-memory wins when populated
    const useInMemory = state.modelCosts.size > 0 || state.accumulatedCost > 0;

    let reportModelCosts: Map<string, ModelCostEntry>;
    let reportTierCounter: TierCounter;
    let reportTotalCost: number;

    if (useInMemory) {
        reportModelCosts  = state.modelCosts;
        reportTierCounter = state.tierCounter;
        reportTotalCost   = state.accumulatedCost;
    } else {
        // JSONL fallback (resumed session)
        reportModelCosts  = {}  // populated by rescan below
        reportTierCounter = {}  // derived from reportModelCosts
        reportTotalCost   = 0   // accumulated during rescan

        try:
            getBranch() → scan assistant messages
            populate reportModelCosts, reportTotalCost
            resolve tier labels
        catch: (ignore)

        derive reportTierCounter from reportModelCosts
    }

    renderUsageReport({
        tierCounter:     reportTierCounter,
        modelCosts:      reportModelCosts,
        accumulatedCost: reportTotalCost,
        ...  (all other fields unchanged)
    })
```

## Test Strategy

### `test/session-rollup-reporting.test.ts`

Testing `handleUsage` end-to-end is complex (requires a full mock `ExtensionContext` with `ui.notify` and `ui.theme`). The practical approach: test the **data source selection logic** directly by observing what string is passed to `ctx.ui.notify`.

**Setup pattern:**
```ts
const notified: string[] = [];
const ctx = makeMockCtx({ branch: [], notified });
```

1. **Primary path: in-memory used when modelCosts has data**
   - Seed `state.modelCosts` with a model entry (e.g., `"openai/gpt-4o"`).
   - Set `ctx.sessionManager.getBranch()` to return entries for a different model (`"anthropic/claude-sonnet"`).
   - Call `handleUsage`.
   - Assert the notified string contains `"gpt-4o"` (in-memory) and does NOT contain `"claude-sonnet"` (JSONL, bypassed).

2. **Fallback path: JSONL used when modelCosts is empty**
   - Scope has no model costs, `accumulatedCost === 0`.
   - `getBranch()` returns an assistant message for `"anthropic/claude-haiku"`.
   - Assert the notified string contains `"claude-haiku"` (JSONL).

3. **Sub-agent rollup visible: rolled-up child model entry appears**
   - Seed `state.modelCosts` with entries from both parent (`"openai/gpt-4o"`) and a rolled-up child (`"anthropic/claude-haiku"`), simulating what `finalizeChildSession` would produce.
   - `getBranch()` returns only parent entries.
   - Assert both model names appear in the report string.

4. **Total cost: in-memory `accumulatedCost` used in primary path**
   - `state.accumulatedCost = 1.2345` (includes child rollup).
   - `getBranch()` would yield `sessionTotalCost = 0.5` if scanned.
   - Assert the notified string contains `"1.2345"` (not `"0.5"`).

5. **Fallback cost: JSONL total used when scope empty**
   - Scope empty. `getBranch()` returns assistant messages summing to $0.25.
   - Assert notified string contains `"0.2500"` (JSONL total).

6. **Compression stats unchanged**: compression fields always come from in-memory scope regardless of which path runs. Assert `state.compressionRequestCount` contributes to the report in both paths (they always did; this is a non-regression guard).

## Migration / Rollback

- **Migration**: none. Output format is identical; only the data source changes.
- **Rollback**: revert `src/commands/usage.ts`. JSONL path resumes as primary.
- **Behavioral delta**: after this change, `/router usage` in a session that spawned sub-agents will show higher totals (correct — child activity now visible). In a session without sub-agents, totals are identical between JSONL and in-memory paths (both see the same turns).
