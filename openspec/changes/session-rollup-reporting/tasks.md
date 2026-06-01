## 1. Refactor `handleUsage` data source selection

- [ ] 1.1 In `src/commands/usage.ts`, add a gate constant before the JSONL block:
  ```ts
  const useInMemory = state.modelCosts.size > 0 || state.accumulatedCost > 0;
  ```
- [ ] 1.2 Declare `reportModelCosts`, `reportTierCounter`, `reportTotalCost` before the gate.
- [ ] 1.3 When `useInMemory` is true: assign `state.modelCosts`, `state.tierCounter`, `state.accumulatedCost` directly. Do NOT run the JSONL rescan block.
- [ ] 1.4 Move the existing JSONL rescan block (lines 17-115) into the `else` branch. Rename local variables to `reportModelCosts`, `reportTierCounter`, `reportTotalCost` so the call site below compiles without conditional expressions.
- [ ] 1.5 Update the `renderUsageReport({...})` call: replace the three conditional expressions (`sessionModelCosts.size > 0 ? ... : ...`) with the plain `reportModelCosts`, `reportTierCounter`, `reportTotalCost` variables.
- [ ] 1.6 Add a comment block above the gate explaining the two-path logic:
  ```ts
  // ── Data source: prefer in-memory scope (includes sub-agent rollup) ──────
  // In-memory wins when populated by any routing in this process run.
  // JSONL rescan fires only for resumed sessions (fresh process, no turns yet).
  ```
- [ ] 1.7 Remove the now-redundant inline comments at the `renderUsageReport` call site that referenced `sessionTotalCost` / `sessionModelCosts` preference logic.

## 2. Test coverage — `test/session-rollup-reporting.test.ts`

- [ ] 2.1 Test: primary path used when `state.modelCosts` has data — notified string contains the in-memory model name, not the JSONL-only model name.
- [ ] 2.2 Test: JSONL fallback used when scope empty — notified string contains the JSONL model name.
- [ ] 2.3 Test: rolled-up child model entry appears — seed parent scope with both parent and child-rolled-up model entries; assert both names appear in report.
- [ ] 2.4 Test: total cost from `state.accumulatedCost` in primary path — `state.accumulatedCost = 1.2345`; assert `"1.2345"` in report (not a JSONL-derived total).
- [ ] 2.5 Test: JSONL total cost used in fallback path — scope empty; JSONL yields $0.25; assert `"0.2500"` in report.
- [ ] 2.6 Test: compression stats from in-memory scope regardless of path — set `state.compressionRequestCount = 3`; assert report mentions compression count in both primary and fallback paths.

## 3. Documentation

- [ ] 3.1 Update `AGENTS.md` "Follow-on rollup threads" section: mark Thread A as complete with a one-line note: "`/router usage` now reads from in-memory scope (primary) with JSONL rescan as fallback for resumed sessions. Sub-agent model/tier/cost breakdown is visible after `agent_end`."`
- [ ] 3.2 Add a code comment in `handleUsage` (in `src/commands/usage.ts`) cross-referencing Threads B and C by name so the dependency chain is obvious to future maintainers.

## 4. Verification

- [ ] 4.1 `bun test test/session-rollup-reporting.test.ts` — all 6 tests pass.
- [ ] 4.2 `bun run test` — full suite (386 tests) still green.
