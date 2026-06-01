## Context

A router process can host multiple sessions concurrently or sequentially:

- A **root session** started by the user via OMP.
- **Sub-agent sessions** spawned by tools (e.g. `task`, planner agents). Each has its own `sessionId`, its own context window, its own model, and is recorded in its own session JSONL file.
- **Branched sessions** created via `session_branch` — a fork of an existing session at a chosen entry, with a `parentSession` pointer in its header.
- **Resumed sessions** loaded fresh into a new process (`session_start` fires with no live ancestor in memory).

`RouterState.sessionScopes: Map<sessionId, SessionScope>` keeps cost/usage isolated per session. `finalizeChildSession(childId)` runs on `agent_end` and merges the child's `accumulatedCost` (and four other counters today; expanded in a later change) into the parent scope located via `child.parentSessionId`.

The bug surface this change addresses is purely the **attribution of `parentSessionId`** when scopes are created. It does **not** touch what is rolled up, when rollup fires, or how rollup results are displayed — those are separate threads tracked as follow-on changes.

**Authoritative source of truth.** `@oh-my-pi/pi-coding-agent` `session-manager.d.ts` defines `SessionHeader.parentSession?: string`. The full `SessionInfo` struct also exposes `parentSessionPath`. The header is persisted into the session JSONL on creation and survives process restarts. The `ReadonlySessionManager` exposed via `ctx.sessionManager` includes `getHeader()` (per the `Pick<…>` union in `session-manager.d.ts:188`), so extensions can read it without privileged access.

## Goals / Non-Goals

**Goals:**
- `child.parentSessionId` reflects the harness's authoritative `SessionHeader.parentSession` whenever available.
- The parent attribution is set as early as possible — at the first `activateSession` call for that sessionId — so the scope's `parentSessionId` is correct before any cost accrues.
- Behavior is deterministic across all three activation paths (`session_start`, `session_branch`, `turn_start`).
- Resumed sub-agent sessions in a new process correctly identify their parent (the existing heuristic fails this case completely).
- Debuggable: under `debug: true`, every parent-attribution decision is logged with its source.
- Backward compatible: root sessions (no parent) and existing single-session deployments behave identically.

**Non-Goals:**
- Changing rollup field set (Thread B).
- Changing rollup timing or trigger event (out of scope; `agent_end` stays).
- Changing reporting (Thread A).
- Cross-process parent reconstruction beyond what `getHeader()` provides natively. If the harness doesn't know the parent, the router doesn't either.
- Persisting the parent link in router state across restarts. The harness's session header is the canonical store; we read it on each activation.

## Decisions

### D1: Authoritative source is `ctx.sessionManager.getHeader()?.parentSession`

**Decision**: All three activation sites resolve parent via `ctx.sessionManager.getHeader()?.parentSession` and pass the result (possibly `undefined`) to `activateSession(sessionId, parentSessionId?)`.

**Rationale**: The header is the harness's persisted record of parentage, set at session creation and stable across process restarts. The current "previously active sessionId" inference cannot survive restarts, swaps, or branches and is the root cause of silent rollup loss.

**Alternative considered**: Walk `SessionInfo.parentSessionPath` on disk. Rejected: more I/O, more failure modes, and `getHeader()` already wraps the same data with cleaner semantics.

### D2: Legacy "previously active" inference downgraded to last-resort fallback

**Decision**: When `getHeader()?.parentSession` is undefined and a different session was active in this process immediately before, fall back to that previous sessionId — but only in `turn_start` (which is the only site where the previous-active heuristic ever produced a value), and only with a debug-tagged log entry.

**Rationale**: Removing the heuristic entirely is the cleanest move, but it would silently break any current deployment where the harness header omits `parentSession` for legitimate sub-agent flows we haven't audited. Treating it as fallback preserves today's behavior in those cases while making the header path the default and surfacing disagreements via logs.

**Sunset path**: Once telemetry (or manual debug runs) confirm the header is always populated for genuine sub-agents, the fallback can be removed in a future change. This proposal does not commit to that timeline.

### D3: First non-undefined parent wins; never overwrite

**Decision**: `activateSession(sessionId, parentSessionId?)` mutates `scope.parentSessionId` only when the existing value is `undefined` AND the new value is defined. A defined value already on the scope is never overwritten.

**Rationale**:
- Idempotency: `turn_start` fires repeatedly; activating an already-known session must not churn the parent link.
- Race safety: if `session_start` set the parent from the header and a later `turn_start` would fall back to "previously active" (a sibling), the header-set parent must win.
- Late binding: if `session_start` ran before the harness populated the header (unlikely but defensible), a later activation can bind the correct parent without clobbering a prior decision.

### D4: Disagreement between header and fallback is a debug warning, not an error

**Decision**: When both header parent and fallback parent are computable AND they disagree, prefer the header, and emit `[model-router] parent attribution disagreement for <child>: header=<a> fallback=<b> — using header` under `debug: true`.

**Rationale**: Disagreement is a signal that the legacy heuristic was producing wrong rollups in this deployment. Logging makes it auditable without breaking anything. Throwing or aborting would risk regressions in flows we haven't observed.

### D5: No persistence of parent link in router state

**Decision**: `parentSessionId` lives only on the in-memory `SessionScope`. It is not written to `RouterPersistedState`.

**Rationale**: The harness's session JSONL is the durable record. Re-reading `getHeader()` on next activation is cheap and avoids two sources of truth. Persisting would create a stale-data risk if the harness ever rewrites a session's parent.

### D6: Logging is opt-in via existing `config.debug` flag

**Decision**: No new config knob. Parent-attribution logs gate on the existing `state.currentConfig.debug` boolean.

**Rationale**: The codebase already uses this flag for classifier and routing diagnostics (see `src/routing/compose.ts` debug paths). One more category fits the existing mental model; a dedicated flag would be over-engineered for a foundational fix.

## Architecture

### Parent-Attribution Flow

```
event              resolution                                           result
─────              ──────────                                           ──────
session_start      header = ctx.sessionManager.getHeader()              activateSession(
                   parent = header?.parentSession                          sessionId,
                                                                           header?.parentSession
                                                                       )

session_branch     header = ctx.sessionManager.getHeader()              activateSession(
                   parent = header?.parentSession                          sessionId,
                                                                           header?.parentSession
                                                                       )

turn_start         if sessionId !== activeSessionId:                    activateSession(
                     header = ctx.sessionManager.getHeader()               sessionId,
                     parent = header?.parentSession                        parent ?? previousActive
                              ?? state.activeSessionId  (fallback)      )
                     if both present and disagree: debug-warn
```

### activateSession Late-Binding Semantics

```
activateSession(sessionId, parentSessionId?):
    activeSessionId = sessionId
    scope = sessionScopes.get(sessionId)
    if scope is undefined:
        create new scope with parentSessionId
    else:
        if scope.parentSessionId is undefined AND parentSessionId is defined:
            scope.parentSessionId = parentSessionId     ← late bind
            (debug log: "late-bound parent")
        // else: keep existing parent (first-write-wins)
```

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `getHeader()` returns `undefined` on a freshly created scope before the header is persisted | Late-binding (D3): a subsequent `turn_start` activation re-attempts attribution. |
| Header reports a parent that no longer has an in-memory scope (parent process restarted, child still running) | `finalizeChildSession` already guards `parentId` lookup with `if (parent) {...}`. Child cost is simply not rolled up in this orphan case. Acceptable — there is nowhere correct to roll it to. |
| Existing deployments relying on the legacy heuristic that happened to produce a useful parent in cases the header omits | Fallback (D2) preserves the heuristic when the header is silent. Debug log surfaces any divergence for future audit. |
| Calibration session lifecycle (`src/calibration/hooks.ts`) holds its own session-id state | This change touches only `activateSession` plumbing in `src/index.ts` and the `RouterState.activateSession` method. Calibration consumes scopes but does not own attribution — no change required. Confirm in test that calibration counters still flow into the correct scope. |
| `getHeader()` is synchronous in current API but may become async in a future major version | Wrap the call site in a small helper so a future migration is one edit point. |

## Observability

Under `config.debug` only:

```
[model-router] parent attribution: child=<id> source=header parent=<id>
[model-router] parent attribution: child=<id> source=fallback parent=<id>
[model-router] parent attribution: child=<id> source=none (root or orphan)
[model-router] parent attribution disagreement for <id>: header=<a> fallback=<b> — using header
[model-router] late-bound parent for <id>: <parentId>
```

These are write-once per scope (tracked via a small `Set<sessionId>` on `RouterState` so we don't spam `turn_start`).

## Test Strategy

A single new file `test/session-parent-link.test.ts` covers:

1. **Header-provided parent**: `getHeader()` returns `{parentSession: "P"}` → child scope's `parentSessionId === "P"`.
2. **Header-missing, no previous session**: root case → `parentSessionId === undefined`.
3. **Header-missing, previous session present (turn_start)**: fallback fires → `parentSessionId === <previous>`.
4. **Header and fallback disagree**: header wins; verify warning under debug.
5. **Activation idempotency**: repeated `turn_start` for same session does not change a non-undefined parent.
6. **Late binding**: first activation sets `undefined`, second activation with header → parent late-bound; third activation does not overwrite.
7. **`finalizeChildSession` integration**: parent-attributed scope rolls up; non-attributed (root) scope does not.

Each test uses a mock `ExtensionContext` with a stub `sessionManager.getHeader()` returning the scenario-specific header.

## Migration / Rollback

- **Migration**: None. The change is internal plumbing; no config schema change, no persisted-state schema change, no CLI surface change.
- **Rollback**: Revert the change. Existing scopes built under the new code continue to function (they hold a `parentSessionId` string the old code would also accept; the rollup logic is unchanged).
- **Compatibility with persisted state**: `RouterPersistedState` (see `src/types.ts:193`) does not include `parentSessionId` — no schema migration needed.

## Out-of-Band Documentation Updates

Update `AGENTS.md` "Pitfalls" section to document:

- How the router determines parent for sub-agent sessions (`getHeader()?.parentSession`, with the legacy fallback noted).
- Why `finalizeChildSession` may appear to "do nothing" — usually missing `parentSessionId`, now diagnosable via debug logs.
- The follow-on threads (B, A, D, E) that build on this foundation, so future contributors don't re-derive the same investigation.
