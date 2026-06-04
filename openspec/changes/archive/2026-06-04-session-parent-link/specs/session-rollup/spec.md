## ADDED Requirements

### Requirement: Parent attribution at session activation

The router SHALL determine each session scope's `parentSessionId` from the harness's authoritative session header (`ctx.sessionManager.getHeader()?.parentSession`) at the first activation of that session within a process. Activation occurs in three lifecycle events: `session_start`, `session_branch`, and `turn_start` (when the active sessionId changes).

#### Scenario: Header provides parent at session_start

- **GIVEN** a sub-agent session whose harness-persisted header has `parentSession: "P"`
- **WHEN** the `session_start` event fires for that session
- **THEN** the router calls `activateSession(sessionId, "P")` and the resulting `SessionScope.parentSessionId` equals `"P"`

#### Scenario: Header provides parent at session_branch

- **GIVEN** a branched session whose harness-persisted header has `parentSession: "P"`
- **WHEN** the `session_branch` event fires for that session
- **THEN** the router calls `activateSession(sessionId, "P")` and the resulting `SessionScope.parentSessionId` equals `"P"`

#### Scenario: Root session has no parent

- **GIVEN** a root session whose harness-persisted header has no `parentSession`
- **WHEN** any activation event fires for that session
- **THEN** the router calls `activateSession(sessionId, undefined)` and the resulting `SessionScope.parentSessionId` is `undefined`

### Requirement: Legacy "previously active" fallback in turn_start only

When `getHeader()?.parentSession` is `undefined` AND the activation site is `turn_start` AND a different session was previously active in this process, the router SHALL pass that previously-active sessionId as `parentSessionId` (preserving prior behavior). This fallback SHALL NOT apply to `session_start` or `session_branch`.

#### Scenario: Header missing, previous session active

- **GIVEN** `turn_start` fires for sessionId `"C"`
- **AND** `getHeader()?.parentSession` returns `undefined`
- **AND** `state.activeSessionId` is `"P"` (a different session was last active)
- **WHEN** activation runs
- **THEN** the router calls `activateSession("C", "P")` and `SessionScope("C").parentSessionId` equals `"P"`

#### Scenario: Header missing at session_start does not fall back

- **GIVEN** `session_start` fires for sessionId `"C"`
- **AND** `getHeader()?.parentSession` returns `undefined`
- **AND** another session `"X"` was previously active in this process
- **WHEN** activation runs
- **THEN** the router calls `activateSession("C", undefined)` — the fallback heuristic does not apply outside `turn_start`

### Requirement: First non-undefined parent wins

`RouterState.activateSession(sessionId, parentSessionId?)` SHALL NOT overwrite a `SessionScope.parentSessionId` that is already non-undefined. When the existing parent is `undefined` and a defined parent is now available, it SHALL late-bind that parent.

#### Scenario: Re-activation does not overwrite existing parent

- **GIVEN** `SessionScope("C").parentSessionId === "P1"`
- **WHEN** `activateSession("C", "P2")` is called
- **THEN** `SessionScope("C").parentSessionId` remains `"P1"`

#### Scenario: Late binding when first attribution was undefined

- **GIVEN** `SessionScope("C")` exists with `parentSessionId === undefined`
- **WHEN** `activateSession("C", "P")` is called
- **THEN** `SessionScope("C").parentSessionId` becomes `"P"`

#### Scenario: Activation with undefined does not clear existing parent

- **GIVEN** `SessionScope("C").parentSessionId === "P"`
- **WHEN** `activateSession("C", undefined)` is called
- **THEN** `SessionScope("C").parentSessionId` remains `"P"`

### Requirement: Header preferred when header and fallback disagree

When `turn_start` produces both a `headerParent` and a `fallbackParent` AND they differ, the router SHALL use `headerParent` for the activation. When `config.debug === true`, it SHALL emit exactly one warning per child sessionId per process indicating the disagreement.

#### Scenario: Disagreement is resolved in favor of header

- **GIVEN** `turn_start` for sessionId `"C"` with `headerParent === "Ph"` and `fallbackParent === "Pf"`
- **WHEN** activation runs
- **THEN** `SessionScope("C").parentSessionId` equals `"Ph"`

#### Scenario: Disagreement emits debug-only warning

- **GIVEN** `config.debug === true` and the above disagreement scenario
- **WHEN** activation runs
- **THEN** a single console message matching `parent attribution disagreement for C: header=Ph fallback=Pf — using header` is emitted, and a second `turn_start` for `"C"` does not emit it again

### Requirement: Resilient header read

The router SHALL handle failures of `ctx.sessionManager.getHeader()` (throws or returns malformed data) without aborting session activation. On failure, the router SHALL treat the header parent as `undefined` and proceed with the fallback path (or `undefined` if no fallback applies).

#### Scenario: getHeader throws

- **GIVEN** `ctx.sessionManager.getHeader()` throws
- **WHEN** any activation event fires
- **THEN** activation completes, the scope is created, and `SessionScope.parentSessionId` is determined as if `getHeader()` returned `undefined`

### Requirement: Debug observability for attribution events

When `config.debug === true`, the router SHALL emit exactly one log line per `(sessionId, event-type)` describing the parent-attribution outcome. Event types are: scope-create (`source: "header" | "fallback" | "none"`), late-bind, and disagreement (covered above).

#### Scenario: Header attribution logged once

- **GIVEN** `config.debug === true`
- **WHEN** `activateSession("C", "P", "header")` is called for the first time
- **THEN** a single message matching `parent attribution: child=C source=header parent=P` is emitted

#### Scenario: Late-bind logged once

- **GIVEN** `config.debug === true` and `SessionScope("C").parentSessionId === undefined`
- **WHEN** a subsequent `activateSession("C", "P", "header")` late-binds the parent
- **THEN** a single message matching `late-bound parent for C: P` is emitted

#### Scenario: No log when debug disabled

- **GIVEN** `config.debug === false`
- **WHEN** any activation event fires
- **THEN** no parent-attribution log is emitted

### Requirement: finalizeChildSession honors the attributed parent

`RouterState.finalizeChildSession(childSessionId)` SHALL continue to roll up the child scope's metrics into the scope identified by `child.parentSessionId`. When `parentSessionId` is `undefined` OR the parent scope does not exist, the child scope SHALL be deleted without rollup (existing behavior, preserved).

#### Scenario: Attributed parent receives rollup

- **GIVEN** parent scope `"P"` exists and child scope `"C"` has `parentSessionId === "P"` with `accumulatedCost === 0.42`
- **WHEN** `finalizeChildSession("C")` is called
- **THEN** parent's `accumulatedCost` increases by `0.42` and `SessionScope("C")` is deleted

#### Scenario: Missing parent attribution results in no rollup

- **GIVEN** child scope `"C"` has `parentSessionId === undefined` with `accumulatedCost === 0.42`
- **WHEN** `finalizeChildSession("C")` is called
- **THEN** no parent scope is modified and `SessionScope("C")` is deleted
