## Why

`/router usage` re-derives its numbers by scanning `ctx.sessionManager.getBranch()` — the JSONL entries of the current session. That scan only sees assistant messages in the current session's file. Sub-agent sessions are stored in separate JSONL files and are therefore invisible to `getBranch()`.

After Threads C and B, the in-memory `RouterState` scope (`state.modelCosts`, `state.tierCounter`, `state.accumulatedCost`) is correct and complete for the agent tree — sub-agent costs have been rolled up by `finalizeChildSession`. But the usage command uses the JSONL data when it's non-empty (which it always is for any active session), discarding the rolled-up in-memory data entirely.

The result: running `/router usage` after a sub-agent completes shows only the parent session's activity, even though all the child activity is correctly accumulated in memory.

## What Changes

- **Preference rule in `handleUsage`** (`src/commands/usage.ts`): when `state.modelCosts.size > 0 || state.accumulatedCost > 0`, skip the JSONL rescan and use the in-memory scope as the authoritative data source. The JSONL rescan runs only when the scope is empty — i.e., a resumed session where the process restarted and no turns have run yet.
- **JSONL rescan is preserved**, not deleted. It becomes an else-branch (fallback for resumed sessions). No information is lost; the fallback fires exactly when in-memory is empty.
- **Report inputs**: `renderUsageReport` receives `state.modelCosts`, `state.tierCounter`, and `state.accumulatedCost` directly in the primary path. All fields and rendering are unchanged — only the data source changes.
- **Test coverage** in a new `test/session-rollup-reporting.test.ts` verifying the in-memory path, the JSONL fallback path, and that rolled-up sub-agent model entries appear in the report string.

## Capabilities

### Modified Capabilities

- `session-rollup`: `/router usage` now reports the full agent-tree activity for the current process session, not just the current session's JSONL. Per-model breakdown and tier distribution include sub-agent contributions. Cost total includes sub-agent cost. Compression stats are unchanged (already use in-memory scope).

## Non-Goals

- Thread D (per-tree budget enforcement during routing) — separate change.
- Thread E (`frozenCompressionBlock` into scope) — separate change.
- Persisting in-memory scope across restarts. Resumed sessions still use JSONL as fallback; no change to that behavior.
- Changing the rendered format of `/router usage` — output appearance is identical; only the data source changes.
- Reading sub-agent JSONL files from disk to extend the JSONL fallback path.
