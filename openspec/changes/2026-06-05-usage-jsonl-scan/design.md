## Context

`/router usage` calls `renderUsageReport` which takes `tierCounter`, `modelCosts`, and `accumulatedCost` as inputs. Today all three come from `RouterState` (in-memory scope, populated by `recordModelCost` as the router proxies streams).

From exploration we know:
- `ctx.sessionManager.getSessionFile()` → absolute path to `<dir>/<ts>_<id>.jsonl`
- Child sessions live in `<dir>/<ts>_<id>/<name>.jsonl` (same base path, no `.jsonl`)
- Every assistant message has `usage: { input, output, cacheRead, cacheWrite, cost: { total } }`
- `ctx.sessionManager.getUsageStatistics()` gives the parent-only aggregate for free (no I/O)
- Pre-filtering lines with `'"assistant"'` + `'"usage"'` string check before JSON.parse reduces parse cost 3×
- Worst-case observed: 9.3 MB across 6 files scanned in **18 ms** — well within interactive budget

## Goals / Non-Goals

**Goals:**
- Counter A (tier decisions): unchanged source (`state.tierCounter`), clarified label
- Counter B (true per-model cost): scan session JSONL tree on demand, no persistent state
- Children included: any `*.jsonl` inside the sibling artifact dir

**Non-Goals:**
- Per-child breakdown in report (tree total only)
- Changing `state.modelCosts` or budget enforcement
- Caching scan results between `/router usage` calls

## Decisions

### D1: Read from JSONL, not from in-memory `state.modelCosts`, for Counter B

**Decision**: Counter B always comes from JSONL scan, not from `state.modelCosts`.

**Rationale**: `state.modelCosts` only records what the router's own stream proxy saw. It misses pre-router turns, classifier calls, and — until `agent_end` fires — in-flight child sessions. The JSONL is the harness's own authoritative record; it includes every LLM call regardless of whether the router was involved.

**Trade-off**: We pay ~5–20 ms of I/O on every `/router usage` invocation. Acceptable — this is a user-initiated slash command, not a hot path.

### D2: `getUsageStatistics()` for parent, filesystem scan for children

**Decision**: Use `ctx.sessionManager.getUsageStatistics()` for the parent session aggregate (zero I/O — harness already computed it), then scan child `.jsonl` files from `readdirSync(childDir)`.

**Rationale**: Avoids re-reading the (potentially large) parent JSONL. Children must be read from disk because the harness does not provide their stats to the parent's context.

**Edge case**: `getUsageStatistics()` returns an aggregate with no per-model breakdown. We still need to scan the parent JSONL for per-model breakdown. So in practice we always scan the parent JSONL for the model map — `getUsageStatistics()` is only useful as a quick sanity check or if we later want a cost-only fast path.

**Revised decision**: Always scan parent JSONL for per-model breakdown. `getUsageStatistics()` not used (simpler, no special-casing).

### D3: Skip `router/auto` entries

**Decision**: Any entry where `provider === "router"` is skipped during scan.

**Rationale**: These are the router's own bookkeeping messages (zero cost, zero tokens). Including them would inflate invocation counts misleadingly.

### D4: Counter A stays on `state.tierCounter`, not derived from JSONL

**Decision**: Tier decision distribution continues to come from `state.tierCounter` (in-memory).

**Rationale**: Routing decisions are not recorded in the JSONL — only LLM responses are. The in-memory counter already rolls up child decisions via `finalizeChildSession`. No need to change this.

### D5: `scanSessionTree` lives in `src/commands/usage.ts`

**Decision**: Implement as a module-level function `scanSessionTree(sessionFile: string): Map<string, ModelCostEntry>` in `src/commands/usage.ts`.

**Rationale**: It's only called from `handleUsage`. No need to extract to a shared util yet. If other consumers emerge, move it then.

### D6: Label clarification — "routing decisions" not "decisions"

**Decision**: Change the bar suffix from `${totalDecisions} decisions` to `${totalDecisions} routing decisions` in `renderUsageReport`.

**Rationale**: Clarifies that this counter measures how many times the router picked a tier, not how many LLM calls completed.

## Architecture

### `scanSessionTree(sessionFile: string): Map<string, ModelCostEntry>`

```
scanSessionTree(sessionFile):
  totals = new Map()

  scanFile(sessionFile)  // parent

  childDir = sessionFile.replace(/\.jsonl$/, "")
  if existsSync(childDir):
    for each file in readdirSync(childDir) where file.endsWith(".jsonl"):
      scanFile(join(childDir, file))

  return totals

scanFile(path):
  for each line in readFileSync(path, "utf8").split("\n"):
    if not ('"assistant"' in line and '"usage"' in line): continue
    obj = JSON.parse(line)
    msg = obj.message
    if msg?.role !== "assistant" or !msg?.usage: continue
    provider = msg.provider ?? "?"
    model = msg.model ?? "?"
    if provider === "router": continue  // skip router bookkeeping
    key = `${provider}/${model}`
    u = msg.usage
    entry = totals.get(key) ?? { model: key, tier: "", invocations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }
    entry.invocations      += 1
    entry.inputTokens      += u.input ?? 0
    entry.outputTokens     += u.output ?? 0
    entry.cacheReadTokens  += u.cacheRead ?? 0
    entry.cacheWriteTokens += u.cacheWrite ?? 0
    entry.cost             += u.cost?.total ?? 0
    totals.set(key, entry)
```

### `handleUsage` updated flow

```
handleUsage():
  profile = state.currentConfig.profiles[state.selectedProfile]

  // Counter A: routing decisions (unchanged)
  reportTierCounter = state.tierCounter

  // Counter B: true per-model cost from JSONL tree
  reportModelCosts = new Map()
  reportTotalCost  = 0

  sessionFile = ctx.sessionManager.getSessionFile?.()
  if sessionFile and existsSync(sessionFile):
    reportModelCosts = scanSessionTree(sessionFile)
    // resolve tier label for each model entry
    for each entry in reportModelCosts.values():
      entry.tier = resolveModelTier(entry.model, profile)
    reportTotalCost = sum of entry.cost for all entries
  else:
    // fallback: in-memory scope (no session file — tests, in-memory mode)
    reportModelCosts = state.modelCosts
    reportTotalCost  = state.accumulatedCost

  renderUsageReport({
    tierCounter:     reportTierCounter,   // Counter A
    modelCosts:      reportModelCosts,    // Counter B
    accumulatedCost: reportTotalCost,
    treeCost:        state.totalCost,     // unchanged
    ...
  })
```

### `renderUsageReport` — label change only

```diff
- barLine = ... + ` ${totalDecisions} decisions`
+ barLine = ... + ` ${totalDecisions} routing decisions`
```

No other rendering changes.

## Test Strategy

### `test/usage-jsonl-scan.test.ts`

Tests for `scanSessionTree`:

1. **Empty parent file** → returns empty map
2. **Parent with 2 assistant messages, same model** → one entry, invocations=2, tokens/cost summed
3. **Parent with 2 models** → two entries, each correct
4. **`router/auto` entries skipped** → zero-cost router lines not in result
5. **Child dir does not exist** → no error, returns parent-only totals
6. **Child dir with 2 child files** → entries from children merged into parent totals, same model accumulated across files
7. **Non-assistant lines (tool results, session header)** → ignored correctly

Tests for `handleUsage` integration (mock ctx):

8. **Session file exists** → `scanSessionTree` result used, not `state.modelCosts`
9. **No session file** → falls back to `state.modelCosts`
10. **Tier label resolved for scanned model** → entry.tier matches profile config
11. **Total cost** → sum of JSONL entries, not `state.accumulatedCost`
12. **Tier counter** → always from `state.tierCounter` regardless of JSONL path

## Migration / Rollback

- **Migration**: none. The report format is identical; only token/cost numbers change (now complete).
- **Rollback**: revert `src/commands/usage.ts`. In-memory path resumes.
- **Behavioral delta**: totals will be higher than before (now includes all turns, all children). This is correct — the old numbers were undercounts.
- **Existing `state.modelCosts` / `finalizeChildSession`**: untouched. Still used for budget enforcement, status widget, and the fallback path.
