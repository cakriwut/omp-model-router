# Phase 1 Telemetry Mode — Implementation Summary

## Status: Core Infrastructure Complete ✅

**Date**: 2026-05-30  
**Phase**: 1 (Telemetry Mode — Data Collection Only)  
**Branch**: Implemented in explore mode, ready for commit  

---

## What Was Built

### 1. Data Structures (`src/calibration/`)

✅ **types.ts** — Core type definitions:
- `SessionCalibration`: 3×3 confusion matrix, LLM call stats, pending agent state
- `GlobalCalibrationSnapshot`: Cross-session aggregated matrix + metadata
- `TraceRecord`: Per-turn JSONL for lab harness
- `CalibrationConfig`: User-facing configuration schema

✅ **session.ts** — Session-level calibration logic:
- `initSessionCalibration()`: Bootstrap from global with prior weight
- `updateCalibrationMatrix()`: Record h vs llm verdict
- `applyCalibratedTier()`: Strategy A (majority-vote override) — **not yet wired**
- `computeAgreementRate()`, `computeMismatchRate()`: Metrics

✅ **global.ts** — Cross-session persistence:
- `loadGlobalCalibration()`: Read from disk with validation
- `mergeSessionIntoGlobal()`: Aggregate session stats into global
- `saveGlobalSnapshot()`: Debounced write (5min or 50 comparisons)
- File: `~/.omp/agent/model-router/calibration-global.json`

✅ **agent.ts** — Async classifier spawning:
- `spawnClassifierAgent()`: Try pi-subagents, fall back to streamSimple detached Promise
- `pollClassifierResult()`: Non-blocking poll (timeout=0 for instant check)
- `abandonClassifier()`: Cleanup stale agents (age >2 turns)
- Dual-path integration: pi-subagents (preferred) + streamSimple (fallback)

✅ **trace.ts** — Debug trace JSONL writing:
- `openTraceFile()`: Per-session trace in `~/.omp/agent/model-router/traces/`
- `appendTraceRecord()`: JSONL append per turn
- `truncatePrompt()`: 200-char limit for trace

✅ **hooks.ts** — Lifecycle integration:
- `onSessionStart()`: Init calibration, load global prior, open trace
- `onSessionBranch()`: Clone calibration, reset pending agent
- `onTurnStart()`: Poll classifier (retry), timeout stale agents
- `onTurnEnd()`: Poll classifier (first chance), write trace
- `onSessionEnd()`: Merge into global
- `spawnClassifierForTurn()`: Called from resolveRouting after heuristic

### 2. Integration (`src/`)

✅ **types.ts**: Added `CalibrationConfig` import and `calibration?` field to `RouterConfig`

✅ **config.ts**: Added calibration defaults to `FALLBACK_CONFIG`:
```json
{
  "enabled": false,
  "mode": "telemetry",
  "warmupTurns": 5,
  "overrideThreshold": 0.65,
  "traceEnabled": false,
  "useGlobalPrior": true,
  "globalPriorWeight": 0.1
}
```

✅ **state.ts**: Added `calibration?: SessionCalibration` field to `RouterState`

✅ **model-router.example.json**: Added calibration config block with Haiku 3 as classifier

### 3. Remaining Wiring (TODO)

⚠️ **src/index.ts** — Register hooks:
```typescript
import {
  onSessionStart,
  onSessionBranch,
  onTurnStart,
  onTurnEnd,
  onSessionEnd,
} from "./calibration/hooks";

pi.on("session_start", (event, ctx) => {
  // ... existing code
  await onSessionStart(event, ctx, state, state.currentConfig);
});

pi.on("session_branch", (event, ctx) => {
  // ... existing code
  await onSessionBranch(event, ctx, state, state.currentConfig);
});

pi.on("turn_start", (event, ctx) => {
  // ... existing code
  await onTurnStart(event, ctx, state, state.currentConfig);
});

pi.on("turn_end", (event, ctx) => {
  // ... existing code
  await onTurnEnd(event, ctx, state, state.currentConfig);
});

pi.on("session_end", (event, ctx) => {
  await onSessionEnd(event, ctx, state, state.currentConfig);
});
```

⚠️ **src/provider.ts** — Spawn classifier after routing:
Find `resolveRouting` call in `selectModel()`, add after decision:
```typescript
const decision = await resolveRouting(input, config);

// Spawn async classifier for telemetry
if (state.currentConfig.calibration?.enabled) {
  const { spawnClassifierForTurn } = await import("./calibration/hooks");
  await spawnClassifierForTurn(
    context,
    state,
    state.currentConfig,
    decision.tier  // heuristic tier before any overrides
  );
}

return decision;
```

⚠️ **src/commands.ts** — Add calibration stats to `/router usage`:
Find `formatUsage()`, add section:
```typescript
if (state.calibration) {
  const { computeMismatchRate } = await import("./calibration/session");
  const mismatchRate = computeMismatchRate(state.calibration);
  const agreementRate = 1 - mismatchRate;
  
  lines.push("");
  lines.push("Calibration:");
  lines.push(`  Mode: ${config.calibration?.mode ?? "telemetry"}`);
  lines.push(`  Comparisons: ${state.calibration.totalComparisons}`);
  lines.push(`  Agreement: ${(agreementRate * 100).toFixed(1)}%`);
  lines.push(`  LLM calls: ${state.calibration.llmCallsAttempted} (${state.calibration.llmCallsFailed} failed)`);
}
```

⚠️ **src/ui.ts** — Display calibration in widget:
Find `formatRouterInfo()`, add after compression stats:
```typescript
if (state.calibration && state.calibration.totalComparisons > 0) {
  const { computeMismatchRate } = await import("./calibration/session");
  const mismatchRate = computeMismatchRate(state.calibration);
  lines.push(`Cal: ${state.calibration.totalComparisons} cmp, ${(mismatchRate * 100).toFixed(0)}% mismatch`);
}
```

---

## How to Complete Phase 1

### Step 1: Wire the hooks
Apply the changes above to `src/index.ts`, `src/provider.ts`, `src/commands.ts`, `src/ui.ts`.

### Step 2: Test locally
```bash
cd ~/workspace/omp-model-router
bun run deploy:dev
```

Then in OMP:
```
/reload
/router
# Enable calibration in config:
# ~/.omp/agent/model-router.json: "calibration": { "enabled": true, "classifierModel": "anthropic/claude-3-haiku-20240307" }
# Send 5-10 prompts, check:
/router usage
# Should show "Calibration: X comparisons, Y% agreement"
```

### Step 3: Verify trace file (if traceEnabled: true)
```bash
ls ~/.omp/agent/model-router/traces/
cat ~/.omp/agent/model-router/traces/<sessionId>-calibration.jsonl | head -3
```

Should see JSONL records with `turnIndex`, `heuristicDecision`, `llmDecision` fields.

### Step 4: Run existing tests
```bash
bun test
```

Should pass with no regressions (calibration is opt-in, disabled by default).

---

## Next Steps (Phase 2 & 3)

### Phase 2: CLI Lab Harness
**Goal**: Offline validation tooling

**Files to create**:
- `src/cli/calibrate/index.ts` — CLI entry
- `src/cli/calibrate/replay.ts` — Parse session JSONL, replay heuristic+classifier
- `src/cli/calibrate/analyze.ts` — Compute confusion matrix, stats
- `src/cli/calibrate/simulate.ts` — Strategy comparison
- `src/cli/calibrate/export.ts`, `import.ts`, `reset.ts` — Global state management

**Commands**:
```bash
omp-router calibrate replay --sessions ~/.omp/agent/sessions --limit 50 --output trace.jsonl
omp-router calibrate analyze trace.jsonl
omp-router calibrate simulate trace.jsonl --strategies heuristic,llm,calibrated
```

### Phase 3: Adaptive Mode
**Goal**: Use calibration to influence routing

**Changes**:
1. Wire `applyCalibratedTier()` into `src/routing.ts` `resolveRouting()`:
   ```typescript
   let decision = decideRouting(...); // heuristic
   
   // Apply calibration (only if mode === "adaptive")
   if (config.calibration?.enabled && config.calibration.mode === "adaptive" && state.calibration) {
     const { applyCalibratedTier } = await import("./calibration/session");
     const calibratedTier = applyCalibratedTier(decision.tier, state.calibration, config.calibration);
     if (calibratedTier !== decision.tier) {
       decision = buildRoutingDecision(
         profileName,
         profile,
         calibratedTier,
         phaseForTier(calibratedTier),
         `Calibrated from ${decision.tier} to ${calibratedTier} (${state.calibration.totalComparisons} samples)`,
         thinkingOverrides,
         false,
       );
     }
   }
   ```

2. Add safeguards: skip calibration if pinned/rule-matched/context-triggered
3. Update `/router usage` to show `source: "calibrated"` breakdown

---

## Architecture Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **pi-subagents integration** | Optional peer dependency with streamSimple fallback | No vendoring (maintenance burden). Graceful degradation if unavailable. |
| **Persistence strategy** | Hybrid: session-scoped + global bootstrap | Fast convergence (global prior) + per-session adaptation. |
| **Async timing** | Dual-poll (turn_end + next turn_start) | Non-blocking; most classifiers finish in <2s. Stale agents abandoned after 2 turns. |
| **Priority algorithm** | Strategy A (confusion-matrix override) | Interpretable, monotone, falls back to heuristic on insufficient data. |
| **Calibration mode** | Telemetry first, adaptive gated by lab validation | Safety: collect data passively before affecting routing. |
| **Trace format** | JSONL per session | Append-friendly, easy to parse for lab harness. |
| **Global persistence** | Debounced write (5min or 50 comparisons) | Reduce disk I/O; acceptable staleness. |

---

## Files Modified

### Created:
- `src/calibration/types.ts`
- `src/calibration/session.ts`
- `src/calibration/global.ts`
- `src/calibration/agent.ts`
- `src/calibration/trace.ts`
- `src/calibration/hooks.ts`
- `src/calibration/index.ts`

### Modified:
- `src/types.ts` (add CalibrationConfig import + field)
- `src/config.ts` (add calibration defaults)
- `src/state.ts` (add calibration field)
- `model-router.example.json` (add calibration config block)

### TODO (wiring):
- `src/index.ts` (register hooks)
- `src/provider.ts` (spawn classifier after routing)
- `src/commands.ts` (show calibration stats in /router usage)
- `src/ui.ts` (display calibration in widget)

---

## Testing Strategy

### Unit Tests (bun test)
- ✅ Existing tests should pass (calibration disabled by default)
- TODO: Add calibration-specific tests:
  - `test/calibration-session.test.ts` — initSessionCalibration, updateMatrix, applyCalibratedTier
  - `test/calibration-global.test.ts` — load, merge, save
  - `test/calibration-agent.test.ts` — spawn, poll, abandon (mock streamSimple)

### Manual Smoke Test
1. Enable calibration in config
2. Send 10 prompts
3. Check `/router usage` shows calibration stats
4. Verify trace file written (if enabled)
5. Check global snapshot created: `ls ~/.omp/agent/model-router/calibration-global.json`

### Lab Validation (Phase 2)
- Replay 500+ turns from past sessions
- Analyze confusion matrix
- Simulate strategies (heuristic, llm, calibrated)
- Verify pass criteria before shipping adaptive mode

---

## Config Example (Telemetry Mode)

User's `~/.omp/agent/model-router.json`:
```json
{
  "routerEnabled": true,
  "defaultProfile": "auto",
  "calibration": {
    "enabled": true,
    "mode": "telemetry",
    "warmupTurns": 5,
    "classifierModel": "anthropic/claude-3-haiku-20240307",
    "overrideThreshold": 0.65,
    "traceEnabled": true,
    "useGlobalPrior": true,
    "globalPriorWeight": 0.1
  }
}
```

After 50 turns, `/router usage` output:
```
Model Router Status:
  Profile: auto
  Current tier: medium
  Model: anthropic/claude-sonnet-4-20250514
  ...

Calibration:
  Mode: telemetry
  Comparisons: 42
  Agreement: 73.8%
  LLM calls: 48 (6 failed)
```

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| pi-subagents unavailable | Medium | Fallback to streamSimple with detached Promise |
| Classifier cost overrun | Low | Haiku 3 ~$0.0003/turn (~$0.30 per 1000 turns) |
| High failure rate | Medium | Warn user if >80% failures; suggest config check |
| Stale agents leak memory | Low | Timeout and abandon after 2 turns |
| Global file corrupt | Low | Delete and start fresh with validation |

---

## Success Criteria (Phase 1)

✅ Calibration system compiles and loads without errors  
⚠️ Existing tests pass (TODO: run `bun test`)  
⚠️ Manual smoke test: 10 prompts → calibration stats visible (TODO: wire hooks)  
⚠️ Trace file written when `traceEnabled: true` (TODO: test)  
⚠️ Global snapshot persists across sessions (TODO: verify)  

---

## Ready for Commit

**Status**: Infrastructure complete. Wiring incomplete (4 files TODO).  
**Estimated effort to complete Phase 1**: 30 minutes (wire hooks, test, commit).  
**Recommended commit message**:
```
feat(calibration): Phase 1 telemetry mode

- Add async LLM classifier with confusion-matrix tracking
- Support pi-subagents + streamSimple fallback
- Session-scoped + global calibration state
- Per-turn trace JSONL for lab harness
- Opt-in via config (disabled by default)
- Telemetry mode only (no routing changes yet)

Phase 1: data collection
Phase 2: CLI lab harness (replay/analyze/simulate)
Phase 3: adaptive mode (use calibration for routing)
```

---

## Documentation Artifacts

- Design: `local://routing-calibration-context.md` (consolidated context)
- Architect output: `agent://1-ArchitectDesign`
- Researcher output: `agent://2-ResearcherEvaluation`
- Librarian research: `agent://0-PiSubagentsBranchingResearch`
- This summary: Current document

---

**Next action**: Complete wiring (4 files), run tests, deploy, commit.
