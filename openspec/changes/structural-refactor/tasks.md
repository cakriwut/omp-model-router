# Tasks: Structural Refactor

## Phase 1: Extract RouterState

### Task 1.1: Create RouterState class in state.ts
- Move all 18 mutable `let` bindings from `index.ts` closure into a `RouterState` class
- Include methods: `persist()`, `recordDecision()`, `getThinkingOverride()`, `restoreFromSession(ctx)`
- `buildPersistedState` becomes a private method on the class (absorbs the 10-positional-arg free function)
- Keep `isRouterPersistedState` as a standalone exported function (used for type narrowing during deserialization)
- Remove dead `isInitialized` field (write-only, never read)
- `shimmerInterval` stays local in index.ts (timer handle, not semantic state)
- Constructor takes `pi: ExtensionAPI`
- **Acceptance:** Class compiles, existing tests still pass (routing logic unchanged)

### Task 1.2: Refactor index.ts to use RouterState
- Replace 18 `let` bindings with `const state = new RouterState(pi)`
- Remove all inline getter/setter proxy objects (lines 207-257, 353-401)
- Pass `state` directly to `registerRouterProvider(pi, state, actions)` and `registerCommands(pi, state, actions)`
- Simplify `actions` object — most methods now call `state.persist()` directly
- `restoreStateFromSession` moves into `state.restoreFromSession(ctx)` — index.ts just calls `await state.restoreFromSession(ctx)`
- Only `shimmerInterval` and the shimmer setInterval/clearInterval logic remains local
- **Acceptance:** `index.ts` under 150 LOC, no getter/setter proxies, all tests pass

### Task 1.3: Update provider.ts and commands.ts signatures
- Change `registerRouterProvider` to accept `RouterState` instead of ad-hoc state object
- Change `registerCommands` to accept `RouterState` instead of ad-hoc state object
- Both `actions` parameter types shrink (remove overlapping concerns absorbed by state methods)
- **Acceptance:** All tests pass, types compile clean

## Phase 2: Split Provider

### Task 2.1: Extract resolveRouting function
- Create `resolveRouting(input: RoutingInput, config: RoutingConfig): Promise<RoutingDecision>` in routing.ts
- Define `RoutingInput` (per-request: context, previousDecision, pinnedTier, isBudgetExceeded, modelRegistry, lastExtensionContext)
- Define `RoutingConfig` (stable: profileName, profile, thinkingOverrides, phaseBias, rules, largeContextThreshold, classifierModel)
- Move context-trigger upgrade, classifier override, and image-attachment upgrade logic from provider.ts into this function
- `resolveRouting` calls `decideRouting` internally, then applies overrides in sequence
- Extract `maybeUpgradeForImage` as named helper within routing.ts
- **Acceptance:** Provider's `streamSimple` calls `resolveRouting` for decision, handles only delegation

### Task 2.2: Slim down streamSimple to delegation loop
- After resolveRouting extraction, streamSimple should only:
  - Call `resolveRouting` to get decision
  - Build `modelsToTry` list (with image filtering)
  - Iterate fallback model chain: resolve model, get API key, truncate context, set thinking, forward stream
  - Accumulate cost from done events
  - Handle errors
- Extract `checkModelSupportsImage` as named module-level helper (deduplication)
- **Acceptance:** `streamSimple` body under 120 lines, all tests pass

### Task 2.3: Add unit tests for resolveRouting
- Test: heuristic decision alone (no overrides active)
- Test: classifier upgrades tier from medium to high
- Test: classifier + budget exceeded → downgrade from high to medium
- Test: image attachment forces tier upgrade when current tier doesn't support images
- Test: context trigger forces high tier
- Test: pinned tier skips classifier
- Test: rule match skips classifier
- **Acceptance:** 7+ test cases covering the composition of overrides

## Phase 3: Hot-Path Performance & Correctness

### Task 3.1: Hoist keyword arrays to module scope
- Move all 6 keyword arrays (`explicitHighHints`, `explicitLowHints`, `planningKeywords`, `summaryKeywords`, `implementationKeywords`, `lookupKeywords`) to module-level `const` declarations as `readonly string[]`
- **Acceptance:** `decideRouting` allocates zero arrays; existing routing tests pass

### Task 3.2: Fix containsAny with word-boundary matching
- Create `buildKeywordMatcher(keywords)` that pre-compiles `RegExp(\b...\b)` for single-word keywords and keeps multi-word keywords as-is for `includes()` matching
- Create `matchesKeywords(text, matcher)` as replacement for `containsAny`
- Build all matchers at module scope (zero per-call allocation)
- Update `decideRouting` to use the new matchers
- **Behavioral audit — add derived forms to keyword lists:**
  - Add `"editing"` to `implementationKeywords` (was false-positive matching via `"edit"`)
  - Add `"fastest"` to `explicitLowHints` (was false-positive matching via `"fast"`)
  - Add `"continued"` to `implementationKeywords` (was false-positive matching via `"continue"`)
- **Tests to add:**
  - `"check information flow"` does NOT match keyword `"format"` (was false positive)
  - `"the code is unchanged"` does NOT match keyword `"change"` (was false positive)
  - `"encode the payload"` does NOT match keyword `"code"` (was false positive)
  - `"format this code"` DOES match keyword `"format"` (true positive preserved)
  - `"editing the file"` DOES match keyword `"editing"` (derived form added)
  - `"planning the architecture"` DOES match keyword `"planning"` (exact keyword)
  - `"quickly fix this"` DOES match keyword `"quickly"` (exact keyword)
- **Acceptance:** False-positive cases fixed, all existing routing behavior tests pass (update any that relied on false-positive substring matching)

### Task 3.3: Fix truncateContext to O(n)
- Pre-compute per-message token costs in a single pass into an array
- Calculate target removal amount, then find cut index by accumulating from front
- Use `slice(cutIndex)` instead of repeated `shift()`
- **Acceptance:** Truncation behavior identical for all existing test cases; no quadratic loop

### Task 3.4: Deduplicate checkModelSupportsImage
- Extract to a named function at module level in provider.ts:
  ```typescript
  const modelSupportsImage = (modelRef: string, registry: ModelRegistry): boolean => { ... }
  ```
- Replace both inline definitions with calls to the shared function
- **Acceptance:** No duplicated logic, tests pass

## Phase 4: Cleanup

### Task 4.1: Remove ThinkingLevel redefinition in ui.ts
- Import `ThinkingLevel` from `@oh-my-pi/pi-agent-core`
- Remove the local `type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` on line 47
- Add `inherit` entries to `THINKING_COLOR` map (→ `"dim"`) and `THINKING_ICON` map (→ `"○"`)
- **Acceptance:** Single source of truth for ThinkingLevel type; compiles clean

### Task 4.2: Extract handleUsage rendering to ui.ts
- Move the bar-chart/model-line rendering from `commands.ts:handleUsage` into a `renderUsageReport()` function in `ui.ts`
- `handleUsage` in commands.ts becomes: call `renderUsageReport(...)`, then `ctx.ui.notify(result, "info")`
- **Acceptance:** Rendering logic co-located with other format helpers in ui.ts

### Task 4.3: Document setTimeout workarounds
- Add JSDoc comments to both `await new Promise(resolve => setTimeout(resolve, 50))` calls explaining:
  - They wait for `pi.registerProvider()` to propagate to the model registry so `ctx.modelRegistry.find("router", profile)` resolves
  - 50ms is empirical; the framework has no event for "provider registration complete"
- If after Phase 1 restructuring the timing changes (e.g., provider registration becomes synchronous within the state class), remove the delays entirely
- **Acceptance:** No unexplained magic delays; either documented or eliminated

---

## Execution Order

Phases MUST be executed sequentially (1 → 2 → 3 → 4). Within each phase:

- **Phase 1:** 1.1 → 1.2 → 1.3 (sequential, each depends on prior)
- **Phase 2:** 2.1 → 2.2 → 2.3 (2.1 and 2.2 sequential; 2.3 can start after 2.1)
- **Phase 3:** 3.1 → 3.2 (must be sequential: 3.2 uses hoisted arrays from 3.1); 3.3, 3.4 (independent, parallelizable with 3.1/3.2)
- **Phase 4:** 4.1, 4.2, 4.3 (all independent, parallelizable)

## Verification

After each phase:
- Run `bun test` — all existing tests must pass
- After Phase 2: new `resolveRouting` tests must pass
- After Phase 3: new word-boundary tests must pass; existing routing tests pass (with updates for behavioral fix)
- Final: confirm `index.ts` < 150 LOC, `provider.ts:streamSimple` < 120 LOC
