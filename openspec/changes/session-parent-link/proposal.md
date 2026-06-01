## Why

The router maintains per-session cost/usage scopes (`SessionScope` in `src/state/index.ts`) and a rollup hook (`finalizeChildSession`) that merges a child sub-agent's metrics into its parent on `agent_end`. The rollup only fires when `child.parentSessionId` is set — and today that field is populated from a fragile heuristic.

`session_start` (`src/index.ts:178`) and `session_branch` (`src/index.ts:243`) call `activateSession(sessionId)` with **no parent argument**. The only place parent is set is `turn_start` (`src/index.ts:289`), where it passes whatever happened to be `state.activeSessionId` at that moment. That value:

- is `undefined` for a freshly resumed sub-agent session (no parent ever recorded → rollup silently skipped),
- can be a sibling sessionId when two unrelated sessions swap in the same process (rollup goes to the wrong parent),
- can drift after `session_branch`.

The harness already exposes the authoritative parent at `ctx.sessionManager.getHeader()?.parentSession` (see `SessionHeader.parentSession` in `@oh-my-pi/pi-coding-agent` `session-manager.d.ts`). The router never reads it. This change makes the router consult that source of truth so subsequent rollup-correctness work (Threads B and A) is built on a valid parent link.

## What Changes

- **Authoritative parent detection**: In `session_start`, `session_branch`, and the `turn_start` activation-fallback, read `ctx.sessionManager.getHeader()?.parentSession` and pass it to `RouterState.activateSession(sessionId, parentSessionId)`.
- **Legacy inference becomes a fallback only**: If `getHeader()` returns no parent AND a different session was previously active in this process, fall back to today's "previously active" inference — but when both sources are present and disagree, prefer the header and emit a debug-only warning.
- **`activateSession` semantics clarified**: When called for an existing scope whose `parentSessionId` is `undefined`, late-bind the parent if one is now available. Never overwrite a non-undefined parent (the first authoritative answer wins).
- **Debug logging**: Under `config.debug`, log every parent attribution event (`source: "header" | "fallback" | "none"`, `parent`, `child`) once per scope, so users can audit rollup correctness.
- **Test coverage**: Add `test/session-parent-link.test.ts` exercising header-provided parent, header-missing fallback, header/fallback disagreement, no-parent root session, and `activateSession` idempotency on re-entry.

## Capabilities

### New Capabilities

- `session-rollup`: Per-session cost and usage scoping with deterministic parent attribution for sub-agent sessions, used by `finalizeChildSession` to roll metrics into the correct parent scope. This change establishes the parent-attribution requirements; subsequent changes (`session-rollup-completeness`, `session-rollup-reporting`) extend what is rolled up and how it is reported.

### Modified Capabilities

None. This is a foundational change. No user-facing command, config, or report behavior changes in this proposal — the wiring becomes correct, but no new field is reported and no rollup field is added. User-visible improvements land in the follow-on changes.

## Non-Goals

- Rolling up additional fields (`tierCounter`, `modelCosts`, compression stats) — Thread B / separate change.
- Wiring `/router usage` to read from in-memory scopes — Thread A / separate change.
- Per-tree budget enforcement — Thread D / separate change.
- Moving `frozenCompressionBlock` into `SessionScope` — Thread E / separate change.
- Changing `agent_end` semantics or adding new lifecycle events.
- Reading sub-agent JSONL files from disk to reconstruct parent links after process restart.
