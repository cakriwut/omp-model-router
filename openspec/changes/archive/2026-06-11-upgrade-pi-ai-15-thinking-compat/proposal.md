## Why

The OMP runtime (v15.11) moved its model catalog to `@oh-my-pi/pi-catalog` and changed `ThinkingConfig` from range-based (`minLevel`/`maxLevel`) to explicit list (`efforts: []`). The deployed extension's `@oh-my-pi/pi-ai` (v13.19) still reads `thinking.minLevel` — which is `undefined` in catalog 15.11 models — causing `expandEffortRange()` to return `[]`, and `requireSupportedEffort("medium", [])` throws: *"Thinking effort medium is not supported"*. The router is broken for all Bedrock reasoning models.

## What Changes

- **Upgrade** `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-agent-core`, and `@oh-my-pi/pi-coding-agent` peer dependencies from `^13.x`/`^15.5.2` to `^15.11.0`
- **Update** `src/provider.ts` to use `clampThinkingLevelForModel()` from `@oh-my-pi/pi-catalog/model-thinking` (the new API) instead of raw `ThinkingLevel` comparisons, so `delegatedReasoning` is safely clamped before being passed to `streamSimple`
- **Update** `src/routing/heuristic.ts` and any other files referencing `ThinkingLevel` constants to use the new `Effort` enum from `@oh-my-pi/pi-catalog` where the `ThinkingLevel` type no longer re-exports the same values
- **Update** any imports of model-thinking utilities that moved from `@oh-my-pi/pi-ai` subpaths to `@oh-my-pi/pi-catalog` subpaths (e.g., `clampThinkingLevelForModel`, `getSupportedEfforts`)
- **Verify** that the `ThinkingConfig` type used in `src/types.ts` aligns with the new `efforts[]`-based schema

## Capabilities

### New Capabilities

- `thinking-effort-clamping`: Safe effort resolution that clamps the router's `delegatedReasoning` to the model's declared supported efforts before delegating — eliminates the "not supported" crash for any model with a non-full effort range.

### Modified Capabilities

*(none — no spec-level behavior changes; this is a compatibility and upgrade fix)*

## Impact

- **`package.json`** — peer dep version bumps for all three `@oh-my-pi/*` packages
- **`src/provider.ts`** — `delegatedReasoning` construction uses `clampThinkingLevelForModel()` as safety guard
- **`src/routing/heuristic.ts`** — may need import updates if `ThinkingLevel` enum values diverged
- **`src/commands/thinking.ts`**, **`src/ui/theme.ts`**, **`src/tui/profile-editor.ts`** — audit all `ThinkingLevel` usages for v15.11 compat
- **`bun.lock`** — regenerated after `bun update`
- All existing tests must pass after upgrade; add regression test for the "medium effort on Bedrock" path
