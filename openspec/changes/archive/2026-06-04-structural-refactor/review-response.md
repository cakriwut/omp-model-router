# Review Response: Addressing Architect Feedback

## Concerns Addressed

### MAJOR #1: `containsKeyword` first-occurrence-only bug
**Fixed.** Replaced the manual `indexOf` + boundary check with pre-compiled `RegExp(\b...\b)` patterns at module scope. RegExp `.test()` finds ALL occurrences, not just the first. Zero per-call allocation since patterns are built once at module load.

### MAJOR #2: False "format inside performance" example
**Fixed.** Removed incorrect example. Replaced with verified real false positives: `"information"` contains `"format"`, `"unchanged"` contains `"change"`, `"encode"` contains `"code"`. Added full behavioral audit table in design.md showing which substring matches are eliminated and which derived forms (`"editing"`, `"fastest"`, `"continued"`) need to be added to keyword lists.

### MAJOR #3: RouterState missing `isStreaming` + `shimmerInterval`
**Fixed.** Design now explicitly lists `isStreaming` as part of `RouterState` (it IS semantic state — "is the router currently streaming?"). `shimmerInterval` explicitly stays local in `index.ts` (it's a timer handle, not semantic state). `isInitialized` is removed (confirmed write-only, never read in current source).

### MAJOR #4: streamSimple < 80 lines unachievable
**Fixed.** Relaxed target to < 120 lines. The image-model-filtering (~17 lines) and stream-forwarding-with-cost-accumulation (~40 lines) are inherently delegation concerns that don't belong in `resolveRouting`. Task 2.2 now explicitly scopes what remains: resolve model chain → image filter → truncate → forward stream → accumulate.

### MINOR #5: Set<string> misleading for iterated keywords
**Fixed.** Changed to `readonly string[]` at module scope + pre-compiled `RegExp[]`. The `RegExp` approach is the correct tool: it handles word boundaries naturally and communicates "pattern matching" intent clearly. No `Set` involved.

### MINOR #6: RoutingContext 13 fields — split suggestion
**Adopted.** Split into `RoutingInput` (per-request: context, previousDecision, pinnedTier, isBudgetExceeded, modelRegistry, lastExtensionContext) and `RoutingConfig` (stable: profileName, profile, thinkingOverrides, phaseBias, rules, largeContextThreshold, classifierModel). Callers can build `RoutingConfig` once and reuse across calls.

### MINOR #7: ThinkingLevel from core might not match
**Investigated.** Core `ThinkingLevel` enum has 7 values: `Inherit`, `Off`, `Minimal`, `Low`, `Medium`, `High`, `XHigh`. Local has 6 (missing `Inherit`). Task 4.1 now specifies: add `inherit` entries to `THINKING_COLOR` (→ `"dim"`) and `THINKING_ICON` (→ `"○"`) maps.

### MINOR #8: "Pure refactor" framing contradiction
**Fixed.** Proposal now explicitly states: "Phase 3 Task 3.2 is NOT a pure refactor — it is a correctness fix that changes observable behavior." The framing is: Phases 1-2 and 4 are pure structural refactor; Phase 3 includes a correctness fix.

### NIT #9: `buildPersistedState` 10 positional params
**Fixed.** Becomes a private method on `RouterState` — accesses fields directly, zero parameters.

### NIT #10: `restoreStateFromSession` placement unclear
**Fixed.** Becomes `RouterState.restoreFromSession(ctx)` — explicitly stated in both design and task 1.2.

## Questions Answered

### Q1: Does the test suite actually test real routing code?
`profile-effectiveness.test.ts` imports and calls the real `decideRouting` function directly. `simple-routing.test.ts` re-implements the logic (doesn't test real code — it's a specification test). `provider.test.ts` tests registry compatibility but not streaming. **Phase 2 Task 2.3 is the first real integration-level unit test of the routing composition (heuristic + classifier + budget + image).** This is a significant testability improvement.

### Q2: What race do the setTimeout(50) calls work around?
They wait for `pi.registerProvider()` to propagate to the `modelRegistry` lookup. The framework's `registerProvider` call mutates an internal registry, and `ctx.modelRegistry.find("router", profileName)` won't resolve until the next microtask/tick. 50ms is empirical slack. Task 4.3 documents this. Phase 1 restructuring preserves the same sequencing (state.persist() → registerProvider → setTimeout → find) so timing is unaffected.

### Q3: Will word-boundary matching regress "planning" → "plan"?
**No regression.** `"planning"` is an explicit keyword in `planningKeywords` at index 1. With word-boundary matching, `"plan"` won't match inside `"planning"`, but `"planning"` will match itself. Full audit included in design.md. The only cases where behavior changes are actual false positives (e.g., `"information"` matching `"format"`). For morphological variants that SHOULD still match, we add them explicitly: `"editing"`, `"fastest"`, `"continued"`.
