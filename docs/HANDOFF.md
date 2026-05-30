# Calibration Project — Handoff

Last updated: 2026-05-30

## Current State

**Phase 1 (Telemetry Mode): SHIPPED & VERIFIED LIVE**

- Async LLM classifier runs every turn (fire-and-forget, no latency impact)
- 3×3 confusion matrix accumulates heuristic vs LLM verdicts in session
- Per-turn JSONL trace written to `~/.omp/agent/model-router/traces/`
- Global snapshot at `~/.omp/agent/model-router/calibration-global.json` (debounced)
- `/router usage` shows `Calibration N comparisons | X% agreement | M LLM calls (F failed)`
- 279 tests passing, no regressions

Verified working in OMP session 019e7837-16ea-7000-a517-5e5cc90aaf7a:
```
[calibration] Initialized (mode: telemetry, warmup: 5)
[calibration] Spawned (agent: classifier-...)
[calibration] h=high, llm=low ✗ (1 comparisons)
```

## Active Config

`~/.omp/agent/model-router.json`:
```json
"calibration": {
  "enabled": true,
  "mode": "telemetry",
  "warmupTurns": 5,
  "classifierModel": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "overrideThreshold": 0.65,
  "traceEnabled": true,
  "useGlobalPrior": true,
  "globalPriorWeight": 0.1
}
```

## Files Touched (Phase 1)

New (`src/calibration/`):
- `types.ts` — SessionCalibration, GlobalCalibrationSnapshot, TraceRecord, CalibrationConfig
- `session.ts` — initSessionCalibration, updateCalibrationMatrix, applyCalibratedTier (Strategy A; **defined but not yet wired into routing**)
- `global.ts` — load/merge/save with debouncing
- `agent.ts` — spawnClassifierAgent (pi-subagents preferred, streamSimple fallback), pollClassifierResult
- `trace.ts` — JSONL trace writing
- `hooks.ts` — onSessionStart/Branch/TurnStart/TurnEnd/SessionEnd, spawnClassifierForTurn
- `index.ts` — barrel

Modified:
- `src/types.ts` — RouterConfig.calibration
- `src/config.ts` — FALLBACK_CONFIG default + parseConfigFile parses raw.calibration + **mergeConfig refactored to spread** (recurring-bug fix; see AGENTS.md Pitfalls)
- `src/state.ts` — RouterState.calibration field
- `src/index.ts` — registers session_start/branch + turn_start/end calibration hooks; reloadConfig also inits calibration if newly enabled
- `src/provider.ts` — calls `spawnClassifierForTurn(state, config, decision.tier, context)` after `resolveRouting`
- `src/commands.ts` — passes calibration data to renderUsageReport
- `src/ui.ts` — renders calibration line in /router usage
- `model-router.example.json` — example calibration block
- `AGENTS.md` — Pitfalls section: mergeConfig drop-fields, async hook caveats, ExtensionContext shape

## Known Gotchas (do not relearn)

1. **mergeConfig drop-fields bug**: any new top-level `RouterConfig` field needs handling in 4 places. Now mitigated by spread refactor (`{...base, ...override, profiles}`), but the doc is in `AGENTS.md` for the next time you add a deep-merge field.
2. **No `session_end` event** in OMP extension API. Calibration merges to global on debounced timer + every turn_end persist; final flush relies on debounce, not session-end.
3. **`ExtensionContext` shape**: no `ctx.session.sessionId`, no `ctx.context`. Use `ctx.sessionManager.getBranch()` for messages, synthesize a session ID for trace files.
4. **`turn_start` handler must be async** if it `await`s.
5. **Pin overrides everything**: `/router pin <tier>` short-circuits the heuristic, so calibration traces show `heuristicDecision.tier = pin`, not the actual heuristic verdict. Run with `/router pin auto` for clean data.
6. **Bedrock classifier model must use `global.anthropic.*` inference profile prefix**, not raw `anthropic.claude-*` IDs (those need inference profile ARNs). The Bedrock 400 errors in the logs are from this — pre-existing, unrelated to calibration code.

## Immediate Next Action (you)

```
/router pin auto
```

Then use OMP normally. Target ~100 comparisons before trusting the matrix. Inspect with:
```
/router usage
cat ~/.omp/agent/model-router/calibration-global.json
ls ~/.omp/agent/model-router/traces/
```

## Phase 2 — CLI Lab Harness (next implementation work)

Goal: offline replay + simulation against a strong-model judge so we don't have to wait for live data to validate strategies.

### Files to create

```
src/cli/calibrate/
  index.ts        # subcommand router, exports CLI entrypoint
  replay.ts       # parse session JSONL, reconstruct Context per user turn,
                  # run decideRouting() + classifier + judge
  analyze.ts      # confusion matrix, per-rule agreement, mismatch rate
  simulate.ts     # strategy comparison loop (heuristic / llm / calibrated)
  export.ts       # dump global calibration as JSON
  import.ts       # restore global calibration from JSON
  reset.ts        # delete global file
```

Wire as either:
- Standalone bin in `package.json` (`omp-router-calibrate`), OR
- `/router calibrate <subcommand>` slash command in `src/commands.ts`

Recommend **both** — bin for CI / batch runs, slash for interactive use.

### Subcommand contracts

```bash
omp-router calibrate replay \
  --sessions ~/.omp/agent/sessions \
  --since 2025-01-01 --limit 100 \
  --classifier amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --judge anthropic/claude-sonnet-4-5 \
  --output trace.jsonl --parallel 4

omp-router calibrate analyze trace.jsonl --format table
omp-router calibrate simulate trace.jsonl \
  --strategies heuristic,llm,calibrated \
  --warmup 5 --output comparison.txt

omp-router calibrate export --output backup.json
omp-router calibrate import backup.json
omp-router calibrate reset
```

### Replay implementation notes

- OMP session JSONL files at `~/.omp/agent/sessions/<cwd-encoded>/*.jsonl`
- Format: `SessionHeader` first line, then typed `SessionEntry` rows (NDJSON, version 3)
- Reconstruct `Context` by walking entries up to (but not including) each `user` message — call `decideRouting()` at that point
- For each turn, call (a) heuristic, (b) classifier model, (c) judge model = ground truth
- Output JSONL: `{sessionId, turnIndex, prompt, heuristic, llm, judge}`

### Analyze output (target shape)

```
Confusion Matrix (heuristic rows × LLM cols):
       low    medium  high
low    45     8       2
medium 12     38      15
high   1      5       24

Agreement: 73.4% | Mismatch: 26.6%
Regret (calibration would override correct heuristic): 1.8%

Per-rule agreement:
  STRONG_PLANNING       92% (23 samples)
  GIT_MATCHER          100% (8)
  IMPLEMENTATION_MATCHER 68% (41) ← candidate for downweighting
```

### Simulate output (target shape)

```
| Strategy   | Accuracy | Cost/100  | Latency  | Regret |
|------------|----------|-----------|----------|--------|
| heuristic  |   72%    | $0.000    |   0ms    |  N/A   |
| llm        |   81%    | $0.030    | 450ms    |  N/A   |
| calibrated |   79%    | $0.003    |  50ms    |  1.8%  |
```

### Pass criteria for Phase 3 gate

| Metric | Threshold |
|--------|-----------|
| Accuracy lift over heuristic | ≥ +5% |
| Cost vs llm-only | ≤ 25% |
| Added latency | ≤ 100ms/turn |
| Mismatch after warmup | ≤ 10% |
| Regret | ≤ 2% |
| Flapping (similar prompts → tier toggling) | ≤ 5% |
| Convergence | ≤ warmup + 5 turns |

## Phase 3 — Adaptive Mode (gated on Phase 2 results)

Wire `applyCalibratedTier()` into `src/routing.ts` `resolveRouting`, after heuristic + before context-size upgrade. Skip if pinned, rule-matched, context-triggered, or budget-forced. Add `source: "calibrated"` to RoutingDecision.

Default `mode: "telemetry"` even after adaptive ships. Adaptive is opt-in via config until production telemetry confirms lab numbers at scale.

## Open Questions (defer until data is in)

1. Override threshold: 0.65 uniform, or per-tier (e.g. 0.75 for low→high jumps to reduce regret)?
2. Global prior weight: 0.1 default — test 0%, 10%, 25% in simulation
3. Should we segment global calibration by project type if cross-session transfer is poor?
4. Trace sampling rate — write every turn (current) or 1-in-N for large deployments?
5. Add `samplingRate` / `skipHighConfidence` to skip classifier when heuristic rule fires with strong keyword match (Phase 3 cost optimization, deferred per user instruction "keep every-turn for now").

## References

- Design context: `local://routing-calibration-context.md`
- Architect output: `agent://1-ArchitectDesign`, `docs/CALIBRATION_DESIGN.md`
- Researcher output: `agent://2-ResearcherEvaluation`
- pi-subagents research: `agent://0-PiSubagentsBranchingResearch`
- Phase 1 implementation log: `docs/PHASE1_TELEMETRY_IMPLEMENTATION.md`
- Verification guide: `docs/VERIFY_CALIBRATION.md`
- OMP session-tree: https://omp.sh/docs/session-tree
- OMP extension dev: https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/DEVELOPMENT.md
