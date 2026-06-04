## 1. RouterState.activateSession — late-binding semantics

- [x] 1.1 In `src/state/index.ts` `activateSession(sessionId, parentSessionId?)`: if scope already exists AND `scope.parentSessionId === undefined` AND `parentSessionId !== undefined`, late-bind the parent.
- [x] 1.2 Never overwrite a non-undefined `scope.parentSessionId`.
- [x] 1.3 Add a private `Set<sessionId>` (e.g., `parentAttributionLogged`) used by the debug logger to ensure write-once-per-scope logging (consumed by Task 4 hooks).
- [x] 1.4 Add a small private helper `setParentIfAbsent(scope, parentSessionId)` so the late-binding rule is expressed in one place and unit-testable in isolation.

## 2. Parent resolution at activation sites

- [x] 2.1 In `src/index.ts` `session_start` handler: read `ctx.sessionManager.getHeader()?.parentSession`; pass to `state.activateSession(sessionId, parent)`.
- [x] 2.2 In `src/index.ts` `session_branch` handler: same pattern — pull `parentSession` from header, pass to `activateSession`.
- [x] 2.3 In `src/index.ts` `turn_start` handler: resolve `headerParent = ctx.sessionManager.getHeader()?.parentSession`; resolve `fallbackParent = state.activeSessionId` (existing behavior, but only when `sessionId !== state.activeSessionId`); pass `headerParent ?? fallbackParent` to `activateSession`.
- [x] 2.4 Wrap `getHeader()?.parentSession` reads in a single helper (e.g., `resolveParentFromHeader(ctx)`) co-located with the handlers, so a future async-API migration is a one-line change.
- [x] 2.5 Guard each call: `getHeader()` may throw on a malformed session file; catch and fall through to the fallback path (or `undefined` if no fallback applies). Never let parent resolution crash the activation path.

## 3. Disagreement detection (turn_start only)

- [x] 3.1 When both `headerParent` and `fallbackParent` are defined AND they differ, prefer `headerParent` and emit debug log: `[model-router] parent attribution disagreement for <child>: header=<a> fallback=<b> — using header`.
- [x] 3.2 Log gated on `state.currentConfig.debug === true`.
- [x] 3.3 Log fires at most once per child sessionId per process (use the `parentAttributionLogged` set from Task 1.3).

## 4. Debug logging — attribution events

- [x] 4.1 In `activateSession`, when a scope is created OR a late-bind occurs, emit one of:
  - `[model-router] parent attribution: child=<id> source=header parent=<id>`
  - `[model-router] parent attribution: child=<id> source=fallback parent=<id>`
  - `[model-router] parent attribution: child=<id> source=none (root or orphan)`
  - `[model-router] late-bound parent for <id>: <parentId>`
- [x] 4.2 Source ("header" | "fallback" | "none") must be passed to `activateSession` as an optional third argument (e.g., `source?: "header" | "fallback" | "none"`) so the call site's intent is preserved; default to "none" if omitted.
- [x] 4.3 Logs gated on `state.currentConfig.debug === true`; use `console.log` consistent with other debug paths (`src/routing/compose.ts` style).
- [x] 4.4 Idempotent: each (sessionId, event-type) combination logs at most once via the `parentAttributionLogged` set.

## 5. Test coverage — test/session-parent-link.test.ts

- [x] 5.1 Test: header provides parent → `scope.parentSessionId` equals header value.
- [x] 5.2 Test: header has no parent, no previous active session → `scope.parentSessionId === undefined`.
- [x] 5.3 Test: header has no parent, previous active session exists (turn_start path) → `scope.parentSessionId` equals the previous session (fallback).
- [x] 5.4 Test: header and fallback disagree → `scope.parentSessionId` equals header; disagreement warning observable via captured console output when debug enabled.
- [x] 5.5 Test: repeated `activateSession` for same sessionId with same/different parent → first non-undefined wins, no overwrite.
- [x] 5.6 Test: first activation passes `undefined`, second passes a value → parent is late-bound on second call.
- [x] 5.7 Test: integration — set up parent + child scopes via the new path, record cost on child, call `finalizeChildSession`, verify parent receives the rolled-up cost (this protects against regressions when Thread B expands the rollup field set).
- [x] 5.8 Test: `getHeader()` throws → activation completes, `scope.parentSessionId === undefined` (or fallback value if applicable), no exception propagates.
- [x] 5.9 Test: helper `resolveParentFromHeader(ctx)` returns `undefined` cleanly when `getHeader()` returns `undefined`.

## 6. Documentation

- [x] 6.1 Update `AGENTS.md` "Pitfalls (read before editing)" section: add a subsection "Parent attribution for sub-agent sessions" describing the header-first resolution, the fallback heuristic, and how to diagnose missing rollup via debug logs.
- [x] 6.2 Mention the follow-on threads (B: complete rollup field set, A: wire usage report to in-memory scope, D: per-tree budget posture, E: move `frozenCompressionBlock` into scope) in `AGENTS.md` so future contributors see the intended trajectory.
- [x] 6.3 In `src/state/index.ts`, add JSDoc on `activateSession` documenting:
  - The late-binding rule (first non-undefined parent wins).
  - That callers should pass parent from `ctx.sessionManager.getHeader()?.parentSession`.
  - The optional `source` argument's semantics for debug logging.
- [x] 6.4 In `src/state/index.ts`, add JSDoc on `finalizeChildSession` referencing the parent-attribution contract and explaining that a missing `parentSessionId` results in scope deletion without rollup (audit via debug logs).
- [x] 6.5 No README or user-facing doc changes — this is foundational plumbing with no observable behavior change.

## 7. Verification

- [x] 7.1 `bun run test test/session-parent-link.test.ts` — new tests pass.
- [x] 7.2 `bun run test` — full suite (~334 tests today) still green; no regressions in `session-scoped-metrics.test.ts` or related state tests.
- [x] 7.3 Manual smoke: `bun run deploy:dev`, start a session in OMP with `debug: true`, spawn a sub-agent (e.g., via `task` tool), observe the parent-attribution debug lines for both root and child sessions.
- [x] 7.4 Manual smoke: confirm `/router usage` continues to render unchanged (this change does not modify reporting; that's Thread A).
