## Context

The router extension uses `@oh-my-pi/pi-ai` for `streamSimple` and `@oh-my-pi/pi-agent-core` for `ThinkingLevel`. When it delegates a call to a reasoning-capable model it passes `reasoning: effectiveThinking` in the stream options. The OMP runtime (v15.11) hosts the actual provider implementation that validates the effort level against the model's `thinking` metadata.

**The schema break:** pi-ai ≤ 15.5.x stored thinking capability as `{ minLevel, maxLevel }` — a range. pi-catalog 15.11 (introduced as a separate package in 15.6+) uses `{ efforts: ["minimal","low","medium","high"] }` — an explicit list. The deployed extension has `@oh-my-pi/pi-ai` **13.19.0** in its `node_modules`. Its `expandEffortRange()` reads `thinking.minLevel` which is `undefined` in the new format → returns `[]` → `requireSupportedEffort("medium", [])` throws.

**Current extension peer deps** (`package.json`):
```
"@oh-my-pi/pi-coding-agent": "^15.5.2"
"@oh-my-pi/pi-agent-core":   "^15.5.2"
"@oh-my-pi/pi-ai":           "^15.5.2"
```

The deployed `node_modules` was last installed at **13.19.0**, which is below the peer dep floor — a lockfile or install-time issue caused the stale install.

## Goals / Non-Goals

**Goals:**
- Bump peer deps to `^15.11.0` (the OMP runtime version) so the extension's `node_modules` uses the current schema
- Add `@oh-my-pi/pi-catalog` as a peer dep so `clampThinkingLevelForModel` is directly importable
- Guard `delegatedReasoning` in `provider.ts` with `clampThinkingLevelForModel` before it reaches `streamSimple` — eliminates the crash even if a version skew reoccurs in future
- Update all `ThinkingLevel`-related imports to remain compatible with the new `Effort` type from `@oh-my-pi/pi-catalog/effort` (same string values, different package origin)
- Confirm all tests pass; add a regression test for the "medium effort on Bedrock model with bounded effort range" scenario

**Non-Goals:**
- Migrating the router to use `@oh-my-pi/pi-catalog` for model discovery (out of scope)
- Changing routing logic or thinking-level heuristics
- Supporting the new `anthropic-adaptive` effort transport mode (separate capability)

## Decisions

### D1 — Bump peer deps to `^15.11.0`

**Decision:** Set all three `@oh-my-pi/*` peer deps to `^15.11.0`.

**Rationale:** The OMP runtime is at 15.11. Pinning lower means the extension's `node_modules` may resolve a version whose `ThinkingConfig` schema is incompatible with the model objects it receives at runtime. Using the caret (`^`) allows patch/minor upgrades without requiring a code change.

**Alternative considered:** Leaving deps at `^15.5.2` and relying only on the `clampThinkingLevelForModel` guard. Rejected because the version mismatch can cause subtler failures in other provider code paths (e.g., `mapEffortToAnthropicAdaptiveEffort`) and gives a false install signal.

### D2 — Add `@oh-my-pi/pi-catalog` as peer dep + import `clampThinkingLevelForModel`

**Decision:** Add `"@oh-my-pi/pi-catalog": "^15.11.0"` to `peerDependencies`. Import `clampThinkingLevelForModel` from `@oh-my-pi/pi-catalog/model-thinking` in `src/provider.ts` and use it to guard `delegatedReasoning`.

**Rationale:** `clampThinkingLevelForModel` is the idiomatic safe API — it returns `undefined` for non-reasoning models, clamps to the nearest supported effort below the requested level, and is stable across minor versions. A direct guard in the router prevents any future version skew from causing a hard crash; the router will silently clamp or disable thinking rather than surfacing an error to the user.

**Alternative considered:** Catching the `requireSupportedEffort` error in `provider.ts` and falling back to `undefined` reasoning. Rejected because it's silent and requires catching a runtime error for normal operation — a bad pattern.

**Alternative considered:** Importing from `@oh-my-pi/pi-ai/model-thinking` (old subpath). Rejected — this subpath was removed in 15.6+ (per CHANGELOG: "Deep subpath exports … `/model-thinking` … are gone — import the `@oh-my-pi/pi-catalog` equivalents").

### D3 — `ThinkingLevel` import stays in `src/` files, `Effort` only in `provider.ts`

**Decision:** Keep using `ThinkingLevel` from `@oh-my-pi/pi-agent-core` in all existing files. Only `provider.ts` needs to import `clampThinkingLevelForModel` (which takes `Effort`). Since `ThinkingLevel` values are the same strings as `Effort` values (e.g., `"medium" === Effort.Medium`), the cast is safe.

**Rationale:** Minimal diff. The `ThinkingLevel` → `Effort` type alignment is already stable — both are `"off" | "inherit" | "minimal" | "low" | "medium" | "high" | "xhigh"`. A wholesale migration to `Effort` throughout the codebase is a separate cosmetic change.

## Risks / Trade-offs

- **[Risk] Future OMP version bumps break again** → Mitigation: `clampThinkingLevelForModel` guard in D2 provides a permanent safety net independent of version alignment.
- **[Risk] `bun update` pulls in breaking API changes beyond ThinkingConfig** → Mitigation: Run full test suite after update; review CHANGELOG sections between 13.19.0→15.11.0 for router-relevant changes before committing.
- **[Risk] `@oh-my-pi/pi-catalog` peer dep requires users to install it separately** → Mitigation: Since the router is loaded by OMP which already bundles `pi-catalog`, the transitive resolution works. For npm-published users, `bun install` resolves it via the global OMP install path automatically.
- **[Trade-off] Adding a new peer dep** — minor increase in installation surface. Acceptable given the catalog package is already present in every OMP installation.

## Migration Plan

1. Run `bun update @oh-my-pi/pi-ai @oh-my-pi/pi-agent-core @oh-my-pi/pi-coding-agent` in the workspace
2. Add `@oh-my-pi/pi-catalog` to `peerDependencies` in `package.json` and run `bun add --peer @oh-my-pi/pi-catalog@^15.11.0` (or manually edit + `bun install`)
3. Edit `src/provider.ts` to import and apply `clampThinkingLevelForModel`
4. Audit and update any files that import from removed `@oh-my-pi/pi-ai` subpaths
5. Run `bun run test` — all 500+ tests must pass
6. Run `bun run deploy:dev` then test in OMP with a Bedrock model at medium tier
7. Bump package version, publish

**Rollback:** Revert `bun.lock` and `package.json` to the previous versions. No data migration needed — the change is purely in code and dependencies.

## Open Questions

- Does the OMP extension loader deduplicate `@oh-my-pi/pi-ai` between the global install and the extension's `node_modules`, or does each extension get its own copy? (Investigation showed each extension uses its own `node_modules` copy — this is why the version mismatch caused the bug.)
- Are there other router code paths that call `streamSimple` with `reasoning` set without clamping? (Probe-retry path in `provider.ts` does not set `reasoning` — safe. Classifier calls in `calibration/` don't use reasoning — safe.)
