# Adaptive Mode Classifier Silent Failure — Fixed

**Issue**: User reported that in adaptive mode, the LLM classifier's decision was not being used. Traces showed "heuristic high, llm medium, system uses high" — but the user expected the system to follow the LLM verdict.

## Root Cause

The synchronous classifier in `resolveRouting` (line 739-744) runs before routing is finalized when `calibration.mode === "adaptive"`. However, when the classifier fails (model not found, API error, or response parsing error), the error is **silently swallowed** at `routing.ts:571-573`:

```typescript
} catch (_error) {
    // Ignore classifier errors and fall back to heuristics
}
return undefined;
```

When `runClassifier` returns `undefined`, `resolveRouting` falls back to the heuristic decision — **with no indication to the user that the classifier failed**.

Meanwhile, the background telemetry classifier (which has its own retry/error logic) succeeds and records a disagreement in the trace file — making it appear as though the system is ignoring the LLM verdict.

### Evidence

Analysis of recent trace files across 5 sessions (160 total turns):
- **144 turns**: sync classifier ran successfully (reasoning starts with "Classifier:")
- **16 turns**: sync classifier silently failed (reasoning is pure heuristic)
  - 14 agreed by luck
  - **2 disagreed** — visible to user as "routing ignoring LLM verdict"

## Changes

### 1. Added debug logging when classifier fails

**File**: `src/routing.ts`

- Added `debug?: boolean` parameter to `runClassifier` (line 499)
- Replaced silent `catch (_error)` with logging when `debug=true` (lines 572-577):

```typescript
} catch (error) {
    if (debug) {
        console.warn(
            `[model-router] Classifier failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    // Ignore classifier errors and fall back to heuristics
}
```

### 2. Surfaced classifier failure in decision reasoning

**File**: `src/routing.ts`

When classifier returns `undefined` in adaptive mode, the decision reasoning now indicates fallback (lines 762-765):

```typescript
} else {
    // Classifier failed or unavailable — mark decision to indicate fallback
    decision.reasoning = `Classifier unavailable, using heuristic: ${decision.reasoning}`;
}
```

### 3. Wired debug flag through call chain

**Files**: `src/routing.ts`, `src/provider.ts`

- Added `debug?: boolean` to `RoutingConfig` interface (line 669)
- Pass `config.debug` to `runClassifier` (line 744)
- Pass `state.currentConfig.debug` from `provider.ts` (line 400)

## User Impact

### Before

When classifier model is misconfigured or unavailable:
- Heuristic decision silently used ✗
- Background telemetry classifier shows disagreement in trace
- User sees "heuristic high, llm medium, system uses high" with no explanation
- Zero logs indicating classifier failure

### After

When classifier model is misconfigured or unavailable:
- Heuristic decision used with clear reasoning: `"Classifier unavailable, using heuristic: Detected planning keyword..."`
- Debug log (when `debug: true`): `[model-router] Classifier failed: model not found`
- User can diagnose: either fix `classifierModel` config or accept heuristic fallback

## Testing

Added two new test files with 8 test cases total:

1. **`test/classifier-failure-handling.test.ts`** (4 tests)
   - Classifier model invalid → fallback with clear reasoning
   - Classifier model valid but returns undefined → graceful fallback
   - Pinned tier → classifier skipped (no "unavailable" message)
   - Rule matched → classifier skipped (no "unavailable" message)

2. **`test/adaptive-mode-integration.test.ts`** (4 tests)
   - Classifier failure visible in reasoning
   - Pinned tier reasoning correct (no classifier mention)
   - Rule-matched reasoning correct (no classifier mention)
   - Heuristic keywords respected when classifier fails

All 334 tests pass (326 existing + 8 new).

## Configuration Guide

Users in adaptive mode should verify their `classifierModel` config:

```json
{
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "classifierModel": "amazon-bedrock/us.amazon.nova-micro-v1:0"
  },
  "debug": true
}
```

If classifier consistently fails:
1. Check `classifierModel` ref is valid (provider/model exists in registry)
2. Check API key is configured for that provider
3. Check model has text input/output capability
4. Check console logs (when `debug: true`) for error messages

## Related Files

- `src/routing.ts` — `runClassifier`, `resolveRouting`, `RoutingConfig`
- `src/provider.ts` — calls `resolveRouting` with debug flag
- `test/classifier-failure-handling.test.ts` — unit tests
- `test/adaptive-mode-integration.test.ts` — integration tests
- `docs/ADAPTIVE_CLASSIFIER_FIX.md` — detailed implementation notes

## Next Steps (Optional Enhancements)

1. **Notification on repeated failures**: Track consecutive classifier failures and emit a user-facing notification after N failures (e.g. 3)
2. **Trace format update**: Distinguish "classifier not attempted" vs "classifier failed" in trace records
3. **Fallback chain**: Allow `classifierFallback` model ref for when primary classifier fails
4. **Metrics**: Track classifier success/failure rate in `/router usage` output
