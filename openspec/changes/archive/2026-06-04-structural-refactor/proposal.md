# Proposal: Structural Refactor — Extract State, Split Provider

## Problem

The extension works correctly but has structural issues that impede testability and maintainability:

1. **God-closure in `index.ts`** — 18 mutable `let` bindings communicated to subsystems via ad-hoc getter/setter proxy objects (40+ lines of boilerplate per subsystem). Adding a new state field requires editing 2-3 structural literals.

2. **Monolithic `streamSimple` in `provider.ts`** — A 300-line async IIFE handles routing decision, classifier override, image upgrade, context truncation, fallback iteration, and stream forwarding. Untestable in isolation.

3. **Performance issues in hot path** — 6 keyword arrays allocated on every `decideRouting` call; `truncateContext` is O(n²) in message count; `containsAny` uses substring matching causing false positives (`"information"` matches keyword `"format"`, `"unchanged"` matches `"change"`, `"encode"` matches `"code"`).

4. **Duplicated logic** — `checkModelSupportsImage` defined twice in provider.ts; `handleUsage` in commands.ts reimplements rendering concepts from ui.ts; `ThinkingLevel` type redefined locally in ui.ts (with 6 values, missing `"inherit"` from the upstream 7-value enum).

## Proposed Solution

### Phase 1: Extract RouterState

Replace the 18 `let` bindings with a single `RouterState` class that owns all mutable state and exposes mutation methods (`persist()`, `recordDecision()`, `resetForSession()`). Eliminate the getter/setter proxy objects entirely — pass the state instance directly to `registerRouterProvider` and `registerCommands`.

**Included in state:** all semantic state (`routerEnabled`, `selectedProfile`, `lastDecision`, `accumulatedCost`, `pinnedTierByProfile`, `thinkingByProfile`, `debugHistory`, `debugEnabled`, `widgetEnabled`, `lastNonRouterModel`, `currentConfig`, `currentModelRegistry`, `currentCwd`, `lastExtensionContext`, `lastRegisteredModels`, `isInternalModelSwitch`, `isStreaming`).

**Excluded from state (remain local in index.ts):** `shimmerInterval` (timer handle, not semantic state), `lastPersistedSnapshot` (internal to `persist()`).

**Dead code removed:** `isInitialized` (write-only, never read).

### Phase 2: Split Provider into Decision + Delegation

Extract routing decision logic from `streamSimple` into a standalone `resolveRouting()` function that composes:
- `decideRouting` (existing heuristic)
- context trigger upgrade
- classifier override
- image attachment upgrade

The remaining `streamSimple` becomes a thin delegation loop: resolve model chain → filter for image support → truncate context → forward stream → accumulate cost.

**Target: `streamSimple` under 120 lines** (not 80 — the image-model-filtering and stream-forwarding-with-cost-accumulation are inherently ~40 lines that don't belong in routing).

### Phase 3: Fix Hot-Path Performance & Correctness

- Hoist keyword arrays to module scope as `readonly string[]`.
- Replace `containsAny` with word-boundary matching using pre-compiled RegExp patterns at module scope.
- Fix `truncateContext` to O(n) with running total subtraction.
- Deduplicate `checkModelSupportsImage`.

**Behavioral change note:** Phase 3 Task 3.2 is NOT a pure refactor — it is a correctness fix. Word-boundary matching will change routing for prompts that currently false-match (e.g., `"check information flow"` currently routes to low tier via substring `"format"` in `"information"`). Multi-word keywords and exact-match keywords (where the keyword IS the word) are unaffected.

### Phase 4: Cleanup

- Remove local `ThinkingLevel` redefinition in ui.ts. Import from `@oh-my-pi/pi-agent-core` instead. Note: core has 7 values (`inherit` | `off` | `minimal` | `low` | `medium` | `high` | `xhigh`), local has 6 (missing `inherit`). The existing `THINKING_COLOR` and `THINKING_ICON` maps will need an `inherit` entry (fallback to `"dim"` / `"○"`).
- Extract `handleUsage` rendering into ui.ts alongside existing format helpers.
- Document the 50ms `setTimeout` workaround (it waits for `registerProvider` to propagate to the model registry lookup).

## Non-Goals

- Changing routing heuristic behavior (keyword lists, thresholds, scoring) — except the word-boundary fix in Phase 3.
- Changing the public API (commands, config format, persisted state shape).
- Adding new features.

## Risks

- **Phase 1** touches every file. Must be done atomically to avoid broken intermediate state.
- **Phase 3** word-boundary change alters observable behavior. Key risk: the keyword `"plan"` currently matches `"planning"` via substring. With word-boundary matching, this would NOT match. However, `"planning"` is ALSO a keyword in `planningKeywords`, so it still routes correctly. Similar analysis needed for `"quickly"` (matches `"quick"` keyword — `\b` would fail since 'l' follows 'k'; but `"quickly"` is its own keyword in `explicitLowHints`). Full audit of keyword list needed before implementation.
- **Phase 2** timing: the two `setTimeout(50)` calls depend on `registerProvider` completing before `modelRegistry.find()`. After restructuring, must verify the same timing guarantee holds.

## Success Criteria

- All existing tests pass unchanged (routing behavior preserved for Phases 1-2, 4).
- `provider.ts:streamSimple` is under 120 lines.
- `index.ts` closure has zero getter/setter proxy objects.
- `decideRouting` allocates no arrays (keyword lists hoisted).
- `truncateContext` is O(n).
- New unit tests for `resolveRouting` covering classifier + budget + image interactions.
- Phase 3 includes regression tests proving existing routing for `"planning"`, `"quickly"`, etc. still works with word-boundary matching.
