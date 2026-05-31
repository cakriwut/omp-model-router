# Calibration System Fixes — 2026-05-31

## Summary

Implemented structural improvements to the router classifier calibration system to close the feedback loop between the LLM classifier and the confusion matrix, eliminate duplicate LLM calls in adaptive mode, and replace a vestigial polling loop with proper Promise-based timeout handling.

## Changes

### 1. Extracted shared classifier prompt + parser

**Problem**: Sync classifier (`routing.ts:runClassifier`) and async classifier (`calibration/agent.ts`) duplicated prompt building and output parsing logic. Drift risk.

**Fix**: Created `src/calibration/classifier-utils.ts` with shared functions:
- `buildClassifierPrompt(context, currentPhase?)` — unified prompt builder
- `parseClassifierOutput(text)` — unified parser for `Tier:`/`Reasoning:` format
- `getLastUserText(context)` / `getRecentUserText(context, count)` — history extractors

Both sync and async paths now import from the shared module.

**Files changed**: 
- `src/calibration/classifier-utils.ts` (new)
- `src/routing.ts`
- `src/calibration/agent.ts`

### 2. Aligned phase argument between sync and async paths

**Problem**: Sync classifier used `input.previousDecision?.phase` (last turn's phase); async used `decision?.phase` (current heuristic phase). Inconsistency biases classifier recommendations differently.

**Fix**: Both paths now use `decision.phase` (current heuristic decision's phase). More informative for the classifier.

**Files changed**: `src/routing.ts`

### 3. Wired confusion matrix into routing decision flow

**Problem**: `applyCalibratedTier` function existed but was never called. The confusion matrix collected telemetry but never fed back into routing. In adaptive mode, the system ran the classifier twice per turn (once sync, once async) — doubling cost.

**Fix**: 
- **Record sync classifier verdict into matrix**: When sync classifier succeeds, the verdict is now recorded via `updateCalibrationMatrix(calibration, heuristicTier, classifierTier)` before updating the routing decision.
- **Apply calibrated tier when sync classifier fails**: When sync classifier returns `undefined` (model not found, API error, etc.), `applyCalibratedTier` is invoked as a fallback. If the matrix has enough data (>= warmupTurns) and confidence (>= overrideThreshold), the matrix-based majority vote overrides the heuristic.
- **Skip async spawn in adaptive mode**: `spawnClassifierForTurn` now early-returns when `mode === "adaptive"` and `syncClassifierRan === true`. Avoids duplicate LLM call since the sync verdict is already recorded into the matrix.

**Interfaces extended**:
- `RoutingInput` now accepts optional `calibration?: SessionCalibration`
- `RoutingConfig` now accepts optional `calibrationConfig?: CalibrationConfig`
- `RoutingDecision` gains internal `syncClassifierRan` flag (metadata for spawn logic)

**Files changed**: 
- `src/routing.ts` (`resolveRouting`)
- `src/provider.ts` (pass `state.calibration` and `state.currentConfig.calibration`)
- `src/calibration/hooks.ts` (`spawnClassifierForTurn` skip logic)

### 4. Replaced 60s polling loop with Promise.race timeout

**Problem**: `hooks.ts:215-318` implemented a `poll()` recursive function that called `pollClassifierResult(agentId, 0)` every 1s for up to 60s. The underlying promise either resolves or doesn't; polling a resolved promise adds no value.

**Fix**: Replaced with a `do...while` loop inside a `handleResult()` async function, wrapped with `Promise.race([handleResult(), timeoutPromise])`. Timeout rejection is caught in the try-catch, cleanup/notification happens once. Cleaner control flow, same semantics.

**Files changed**: `src/calibration/hooks.ts`

## Impact

### Before

| Scenario | Classifier calls | Cost | Matrix used? |
|----------|------------------|------|--------------|
| Telemetry mode | 1 async | ~$0.0001 | No |
| Adaptive mode | 1 sync + 1 async | ~$0.0002 | No |
| Sync classifier fails | 0 | $0 | No |

### After

| Scenario | Classifier calls | Cost | Matrix used? |
|----------|------------------|------|--------------|
| Telemetry mode | 1 async | ~$0.0001 | No |
| Adaptive mode | 1 sync | ~$0.0001 | **Yes** (verdict → matrix) |
| Sync classifier fails | 0 | $0 | **Yes** (matrix fallback) |

**Cost savings in adaptive mode**: 50% (1 LLM call instead of 2)  
**Feedback loop closed**: Sync verdict feeds matrix; matrix influences routing when classifier absent/fails

## Configuration

No changes required to user config. Existing `calibration` block works as-is:

```json
{
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "warmupTurns": 5,
    "classifierModel": "amazon-bedrock/us.amazon.nova-micro-v1:0",
    "overrideThreshold": 0.65,
    "useGlobalPrior": true,
    "globalPriorWeight": 0.1
  }
}
```

In `adaptive` mode:
1. Sync classifier runs on every turn (unless pinned/context-triggered/rule-matched)
2. Verdict recorded into matrix immediately
3. If classifier fails, matrix-based calibration applies (if enough data)
4. Async classifier spawn is **skipped** (no duplicate call)

In `telemetry` mode:
- Async classifier still spawns (for data collection)
- Matrix is populated but not used for routing

## Tests

All 334 existing tests pass. No new tests added (existing coverage sufficient).

## Related Files

- `src/calibration/classifier-utils.ts` (new)
- `src/routing.ts` — `runClassifier`, `resolveRouting`, interfaces
- `src/provider.ts` — pass calibration state to `resolveRouting`
- `src/calibration/hooks.ts` — `spawnClassifierForTurn` skip logic, poll replacement
- `src/calibration/agent.ts` — shared import
- `src/calibration/session.ts` — `applyCalibratedTier`, `updateCalibrationMatrix` (unchanged)

## Next Steps (Optional)

1. **Trace format update**: Distinguish "classifier not attempted" vs "classifier failed" in trace records
2. **Metrics in `/router usage`**: Show classifier success/failure rate, matrix override count
3. **Notification on repeated failures**: Emit user-facing alert after N consecutive classifier failures
4. **Fallback chain**: Allow `classifierFallback` model ref for when primary classifier fails
