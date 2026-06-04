# Proposal: Consolidation Pass

## Problem

The omp-model-router codebase has accumulated structural debt that makes maintenance harder than necessary:

1. **Large files** — 4 files exceed 700 LOC (commands.ts=1076, routing.ts=891, provider.ts=846, ui.ts=735). Files > 500 LOC are harder to review, test, and modify. Past bugs cluster in large files.

2. **Code duplication** — Text extraction implemented 3 times with subtle differences. Context helpers duplicated across routing.ts and classifier-utils.ts. Test helpers redefined in 3+ test files.

3. **High coupling** — Provider.ts has betweenness centrality 0.095 (should be < 0.05). Compression decision logic split between provider.ts and context-compression.ts.

4. **Mixed concerns** — commands.ts mixes 7 unrelated subcommands. routing.ts mixes low-level text extraction with high-level classifier orchestration. state.ts mixes business logic with I/O persistence.

**Source:** Graphify analysis (2026-05-31) of 530 nodes, 845 edges across 121 files. See [design.md](./design.md) for full analysis.

## Graphify Findings

**God Nodes (high degree):**
- `RouterState` — 30 edges (central mutable state)
- `decideRouting()` — 13 edges (routing heuristic)
- `updateStatus()` — 11 edges (UI refresh)
- `resolveRouting()` — 10 edges (tier resolution)

**High-coupling nodes (betweenness centrality):**
- `commands.ts` — 0.120 (should be < 0.05)
- `routing.ts` — 0.110
- `provider.ts` — 0.095
- `ui.ts` — 0.089

**Verified duplications:**
- Text extraction: 3 implementations
- `getLastUserText`: 2 copies
- `isRouterTier`: 2 copies
- Test helpers: 3+ duplicates (`stripAnsi`, `makeTheme`, token estimators)

## Consequences

**For maintainers:**
- Bug fixes require editing multiple files (duplication)
- PRs are large (1076-line files hard to review)
- Rollbacks are risky (mixed concerns in same file)

**For new contributors:**
- Hard to find where a feature lives (scattered concerns)
- Hard to understand what a file does (mixed responsibilities)
- Hard to test in isolation (high coupling)

**For bug velocity:**
- Past bugs clustered in large files (provider.ts → 3 bugs, state.ts → 2 bugs, ui.ts → 1 bug)
- Duplications delay fixes (must fix in 3 places)
- High coupling makes changes riskier (changing provider.ts can break compression)

## Proposed Solution

**Two-phase refactor:**

### Phase 1: Mechanical Deduplication (2 hours, low risk)

1. **Unify text extraction** — Create `message-text.ts` with configurable `extractMessageText(msg, opts)`. Delete 2 duplicate implementations.
2. **Delete duplicate helpers** — Import `getLastUserText` and `isRouterTier` from canonical locations. Delete duplicates in `classifier-utils.ts`.
3. **Extract test helpers** — Centralize `stripAnsi`, `makeTheme`, token estimators in `test/_helpers/`. Delete inline definitions.

**Benefits:**
- Bug fixes in one place (was 3)
- Future changes happen once (no N edits)
- Test suite more maintainable

**Risk:** Low. Tests verify behavior unchanged. TypeScript catches import errors at compile time.

### Phase 2: File Splits (4.5 hours, medium risk)

1. **Split commands.ts (1076 → 7×150 LOC)** — Extract subcommand handlers to `commands/usage.ts`, `commands/profile.ts`, etc. Create dispatcher in `commands/index.ts`.

2. **Split routing.ts (891 → 4×200 LOC)** — Layer into `routing/text.ts` (low-level), `routing/heuristic.ts` (mid-level), `routing/compose.ts` (mid-level), `routing/index.ts` (orchestration).

3. **Split ui.ts (735 → 4×180 LOC)** — Extract to `ui/status.ts`, `ui/usage.ts`, `ui/profile.ts`, `ui/theme.ts`.

4. **Move compression decision** — Extract `shouldCompress` and `compressIfNeeded` to `context-compression.ts`. Provider calls `compressIfNeeded`, doesn't decide.

5. **Separate state persistence** — Move I/O serialization to `state/persist.ts`. Keep business logic in `state/index.ts`.

**Benefits:**
- Zero files > 500 LOC (was 4)
- Betweenness centrality < 0.05 (was 0.09-0.12)
- Smaller PR diffs (subcommand bugs only touch 1 file)
- Better testability (layers independent, no mocks needed)

**Risk:** Medium. File splits require careful import management. Tests catch behavior regressions. Manual smoke test verifies integration.

## Success Metrics

| Metric | Before | After |
|--------|--------|-------|
| Files > 500 LOC | 4 | 0 |
| Max betweenness centrality | 0.120 | <0.05 |
| Text extraction implementations | 3 | 1 |
| Duplicate helper functions | 2 | 0 |
| Test suite pass rate | 100% | 100% |

**Verification:** Run `/graphify . --update` after Phase 2. Metrics should match targets.

## Why Now?

1. **Graph analysis shows measurable problems** — Not subjective aesthetics. Verified duplications, quantified coupling.

2. **No major features in flight** — Refactor requires clean slate. Better before starting profile-tui-editor or heuristic-cost-optimization.

3. **Bug patterns justify it** — Past bugs clustered in large files. Refactor reduces future bug velocity.

4. **Low disruption** — Phase 1 ships independently (2 hours, low risk). Phase 2 can land in separate PR if needed.

## Alternatives Considered

1. **Keep as-is** — Zero effort, but debt accumulates. Future refactors harder.
2. **Rewrite in one big PR** — High risk, hard to review, no rollback granularity.
3. **Split only commands.ts** — Addresses worst offender, but leaves 3 other large files.
4. **Automated refactoring tools** — Fast but brittle output. Tools like jscodeshift break imports and comments.

**Decision:** Phased manual refactor. Incremental rollback. Each commit independently reviewable.

## Timeline

**Phase 1:** 2 hours (4 tasks, 15-45 min each)  
**Phase 2:** 4.5 hours (5 tasks, 30-90 min each)  
**Final verification:** 30 min (tests, deploy, smoke test, graph re-analysis)  
**Grand total:** ~7 hours

**Can be interrupted:** Phase 1 ships independently. Tasks 2.1-2.5 are independent (can be done in any order).

## Rollback Plan

**Per-task rollback:**
```bash
git revert HEAD              # Undo last commit
bun test                     # Verify rollback successful
```

**Phase-level rollback:**
```bash
git revert <hash>..HEAD      # Revert all Phase 2 commits
bun test                     # Verify Phase 1 still works
```

**Full rollback:**
```bash
git reset --hard <hash-before-refactor>
```

**Safe:** Each task is one atomic commit. Phase 1 has value on its own.

## Done Criteria

- [ ] All 334 tests pass after each commit
- [ ] Zero files > 500 LOC
- [ ] Betweenness centrality: all files < 0.05
- [ ] 1 text extraction implementation (was 3)
- [ ] Zero duplicate helper functions (was 2)
- [ ] Manual smoke test passes (all `/router` commands work)
- [ ] Graph re-analysis confirms metrics improved

## Approval Request

**Request:** Proceed with Phase 1 (mechanical deduplication) immediately. Phase 2 (file splits) after Phase 1 merges.

**Rationale:**
- Phase 1 low risk, high value (fixes duplications verified by graph analysis)
- Phase 2 can be reviewed separately (smaller PR, easier review)
- Rollback granularity per-phase (can ship Phase 1 without Phase 2 if needed)

**Next steps after approval:**
1. Create feature branch: `refactor/consolidation-pass`
2. Execute Phase 1 tasks (4 commits)
3. Open PR for Phase 1 review
4. Merge Phase 1
5. Execute Phase 2 tasks (5 commits)
6. Open PR for Phase 2 review
7. Run `/graphify . --update` to verify metrics
