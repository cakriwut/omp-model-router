## Why

`/router usage` has two problems with the cost/token report:

**Problem 1 — Decision counter conflated with LLM calls.**
`state.tierCounter` counts routing decisions, but the report bar labels them as if each decision equals one LLM call. A decision can be made before a stream that fails and retries on a fallback model, or before a stream that is never started (e.g. context-triggered abort). The counter is correct; the label is ambiguous.

**Problem 2 — Context token cost is not tracked correctly for parent+child sessions.**
The current implementation reads token counts from `state.modelCosts` (in-memory) or `getBranch()` (JSONL rescan). Both sources only capture what the router's own `recordModelCost()` tracked: i.e. the LLM stream tokens the router proxied. They miss:
- Turns where the router was not yet active (before first routing decision)
- The classifier model calls (tracked separately, not surfaced in `/router usage`)
- Child (sub-agent) sessions entirely, unless `agent_end` already fired and `finalizeChildSession` merged them

The JSONL is the ground truth. Every assistant message in every session file records `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite`, and `usage.cost.total` for the model that served that turn. If we read the parent JSONL + all child JONLs under the parent's artifact directory, we get the complete, authoritative per-model cost rollup — with no state to maintain and no risk of double-counting.

## What Changes

- **`/router usage` is split into two independent counters:**
  - **Counter A — Routing decisions**: `state.tierCounter` (high/medium/low), unchanged from today. Shows how many times the router picked each tier. Labels clarified to say "routing decisions" not "decisions".
  - **Counter B — True context cost**: computed on-the-fly by scanning the session JSONL tree. Per-model totals of `input + cacheRead + cacheWrite + output` tokens and `cost.total`. Covers the full tree (parent + all children), not just what the router proxied.

- **New utility `scanSessionTree(sessionFile)`** in `src/commands/usage.ts` (or a shared util):
  - Reads `sessionFile` line-by-line (never full JSON.parse of the whole file at once)
  - Pre-filters with string check (`'"assistant"'` + `'"usage"'`) before JSON.parse — keeps parse cost low
  - Derives child dir as `sessionFile.replace(/\.jsonl$/, "")`, scans `*.jsonl` files in it if the dir exists
  - Returns `Map<modelKey, { invocations, input, output, cacheRead, cacheWrite, cost }>` for the full tree
  - Skips `router/auto` entries (zero-cost router bookkeeping lines)

- **`handleUsage` updated** to call `scanSessionTree` when `ctx.sessionManager.getSessionFile()` returns a path. Falls back to existing in-memory scope when no session file (in-memory / test).

- **`renderUsageReport` updated**: accepts the two counters independently. Counter A (tier decisions) and Counter B (JSONL-scanned per-model cost) are shown as distinct sections.

- **Counter A (tier decisions) is unaffected** — still sourced from `state.tierCounter` which already rolls up child decisions via `finalizeChildSession`.

## Capabilities

### Modified Capabilities

- `session-rollup`: `/router usage` now shows the **true** per-model cost from the session JSONL tree. Includes turns the router didn't proxy, classifier calls, child sub-agent sessions. Tier decision distribution remains sourced from in-memory `state.tierCounter`.

## Non-Goals

- Persisting the JSONL scan results across restarts (always re-scan on demand — fast enough at ~5–20 ms).
- Changing budget enforcement logic (`maxSessionBudget`) — still enforced per-session in-memory.
- Removing or replacing `state.modelCosts` / `finalizeChildSession` — still used for budget enforcement and status widget.
- Paginating or limiting the JSONL scan (all files in the tree are always scanned).
- Showing per-child-session breakdown in the report (tree total per model is sufficient; child breakdown is future work).
