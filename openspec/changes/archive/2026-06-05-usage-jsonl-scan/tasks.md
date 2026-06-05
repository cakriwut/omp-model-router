## 1. Implement `scanSessionTree` in `src/commands/usage.ts`

- [ ] 1.1 Add imports at top of `src/commands/usage.ts`:
  ```ts
  import { existsSync, readFileSync, readdirSync } from "node:fs";
  import { join } from "node:path";
  ```
  (Check which are already imported — only add missing ones.)

- [ ] 1.2 Add module-level function `scanSessionTree(sessionFile: string): Map<string, ModelCostEntry>` before `handleUsage`. Implementation:
  - Declare `totals = new Map<string, ModelCostEntry>()`
  - Call inner `scanFile(sessionFile)` for the parent
  - Derive `childDir = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile`
  - If `existsSync(childDir)`: iterate `readdirSync(childDir)` filtering `.endsWith(".jsonl")`, call `scanFile(join(childDir, f))` for each
  - Return `totals`

- [ ] 1.3 Add inner helper `scanFile(path: string, totals: Map<string, ModelCostEntry>): void`:
  - Read file with `readFileSync(path, "utf8")`; split on `"\n"`
  - For each line: skip if not `(line.includes('"assistant"') && line.includes('"usage"'))`
  - JSON.parse surviving lines; extract `obj.message` (handle `obj.type === "message"` outer wrapper)
  - Skip if `msg?.role !== "assistant"` or `!msg?.usage`
  - Skip if `msg.provider === "router"`
  - Build `key = "${provider}/${model}"`
  - Accumulate into `totals` map: `invocations`, `inputTokens` (`u.input`), `outputTokens` (`u.output`), `cacheReadTokens` (`u.cacheRead`), `cacheWriteTokens` (`u.cacheWrite`), `cost` (`u.cost?.total ?? 0`)
  - Wrap entire function body in `try/catch` — silently swallow read errors so a missing/corrupt child doesn't crash the report

- [ ] 1.4 Add helper `resolveModelTier(modelKey: string, profile: RouterConfig["profiles"][string]): string`:
  - Iterate `ROUTER_TIERS`; return the tier whose `.model === modelKey` or `.fallbacks?.includes(modelKey)`
  - Return `""` if not found

## 2. Update `handleUsage` in `src/commands/usage.ts`

- [ ] 2.1 Replace the entire `useInMemory` gate + JSONL rescan + `renderUsageReport` block with the new two-counter approach:
  - Counter A: `const reportTierCounter = state.tierCounter`
  - Counter B: attempt `scanSessionTree` when session file is available; fall back to `state.modelCosts` + `state.accumulatedCost`
  - Resolve tier labels for all JSONL-scanned entries using `resolveModelTier`
  - Compute `reportTotalCost = [...reportModelCosts.values()].reduce((s, e) => s + e.cost, 0)`

- [ ] 2.2 Remove the old JSONL `getBranch()` rescan block entirely (the one iterating `branch` entries for assistant messages with usage). It is superseded by `scanSessionTree`.

- [ ] 2.3 Keep `state.totalCost` as the `treeCost` field in `renderUsageReport` — unchanged.

- [ ] 2.4 Add comment block above Counter B block:
  ```ts
  // ── Counter B: true per-model cost from session JSONL tree ───────────────
  // Scans parent .jsonl + all child .jsonl files in the sibling artifact dir.
  // Authoritative: includes all turns regardless of whether the router proxied them.
  // Falls back to in-memory scope when no session file exists (tests, in-memory mode).
  ```

## 3. Update `renderUsageReport` in `src/ui/usage.ts`

- [ ] 3.1 Change the bar label from `${totalDecisions} decisions` to `${totalDecisions} routing decisions`.

- [ ] 3.2 No other rendering changes.

## 4. Tests — `test/usage-jsonl-scan.test.ts`

Create a new test file. Use `bun:test`. No mocks — test `scanSessionTree` by writing real temp JSONL files to a temp dir.

- [ ] 4.1 Helper: `makeTmpSession(lines: object[]): string` — writes a temp `.jsonl` file, returns its path.

- [ ] 4.2 Helper: `makeAssistantLine(provider: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): object` — returns a JSONL entry shaped like the real harness format:
  ```json
  { "type": "message", "message": { "role": "assistant", "provider": "...", "model": "...", "usage": { "input": N, "output": N, "cacheRead": N, "cacheWrite": N, "cost": { "total": N } } } }
  ```

- [ ] 4.3 Test: empty parent file → `scanSessionTree` returns empty map.

- [ ] 4.4 Test: parent with 2 assistant messages, same model → one entry, `invocations=2`, tokens and cost summed correctly.

- [ ] 4.5 Test: parent with 2 different models → two entries, each correct.

- [ ] 4.6 Test: `router/auto` entries skipped → entry with `provider="router"` not in result.

- [ ] 4.7 Test: child dir does not exist → no error, returns parent-only totals.

- [ ] 4.8 Test: child dir with 2 child JSONL files → entries from children merged into totals; same model appearing in parent and child accumulates correctly.

- [ ] 4.9 Test: corrupt/unreadable child file → `scanSessionTree` still returns parent totals (error swallowed).

- [ ] 4.10 Test: non-assistant lines (tool result, session header) → ignored; only assistant lines with usage counted.

## 5. Verify full test suite

- [ ] 5.1 `bun test test/usage-jsonl-scan.test.ts` — all new tests pass.
- [ ] 5.2 `bun run test` — full suite still green (existing tests unaffected).

## 6. Documentation

- [ ] 6.1 Update `AGENTS.md` "Follow-on rollup threads" section — remove or close the note about Thread D limitation ("in-flight sub-agent spend is invisible to the parent until `agent_end`") now that `/router usage` reads JSONL directly and is accurate regardless of `agent_end` timing.

- [ ] 6.2 Add one-line comment in `handleUsage` referencing the old `getBranch()` JSONL rescan was replaced and why.
