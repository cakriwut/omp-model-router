# Investigation Summary: Adaptive Mode Classifier Not Being Used

**Date**: 2026-05-30  
**Issue**: User reported that in adaptive mode, the LLM classifier's decision was not being used. Traces showed "heuristic high, llm medium, system uses high" but expected the system to follow the LLM verdict.

---

## Root Cause Analysis

### The Problem

The omp-model-router extension runs **two separate classifiers** per turn:

1. **Synchronous classifier** in `resolveRouting` (`routing.ts:739-765`)
   - Runs **before** routing is finalized
   - Used for actual routing decisions in adaptive mode
   - Blocks request until LLM responds

2. **Background telemetry classifier** in `spawnClassifierForTurn` (`hooks.ts:137-336`)
   - Runs **after** routing decision is made
   - Fire-and-forget, used only for trace/matrix
   - Never affects routing

When the **synchronous classifier fails** (model not found, API error, response parsing error), the error is silently swallowed at `routing.ts:571-573`:

```typescript
} catch (_error) {
    // Ignore classifier errors and fall back to heuristics
}
return undefined;
```

This causes:
1. Routing falls back to heuristic decision (user expects classifier to control routing)
2. Background telemetry classifier succeeds and records disagreement in trace
3. User sees "heuristic high, llm medium, system uses high" with **no indication the sync classifier failed**

### Evidence

Analysis of 5 recent sessions (160 total turns):
- **144 turns (90%)**: sync classifier ran successfully (reasoning starts with "Classifier:")
- **16 turns (10%)**: sync classifier silently failed (reasoning is pure heuristic)
  - 14 agreed by luck
  - **2 disagreed** — visible to user as "routing ignoring LLM verdict"

### Why It Failed Silently

The function had **three failure modes**, all returning `undefined` with no logging:

1. **Model not found** (line 504): `modelRegistry.find()` returns `undefined`
2. **API key missing** (line 507): `modelRegistry.getApiKey()` returns `undefined`
3. **Exception** (lines 571-573): Any thrown error is caught and swallowed

---

## Solution

### Changes Made

#### 1. Added debug logging for all failure modes

**File**: `src/routing.ts`

- Added `debug?: boolean` parameter to `runClassifier` (line 499)
- Log when model not found (lines 505-507)
- Log when API key missing (lines 513-515)
- Log caught exceptions (lines 580-585)

```typescript
if (!model) {
    if (debug) {
        console.warn(`[model-router] Classifier model not found: ${provider}/${modelId}`);
    }
    return undefined;
}
```

#### 2. Surfaced classifier failure in decision reasoning

**File**: `src/routing.ts`

When classifier returns `undefined` in adaptive mode, the decision reasoning now indicates fallback (lines 762-765):

```typescript
} else {
    // Classifier failed or unavailable — mark decision to indicate fallback
    decision.reasoning = `Classifier unavailable, using heuristic: ${decision.reasoning}`;
}
```

#### 3. Wired debug flag through call chain

- Added `debug?: boolean` to `RoutingConfig` interface (`routing.ts:669`)
- Pass `config.debug` to `runClassifier` (`routing.ts:744`)
- Pass `state.currentConfig.debug` from provider (`provider.ts:400`)

---

## User Impact

### Before Fix

When classifier model is misconfigured or unavailable:
- ✗ Heuristic decision silently used
- ✗ Background telemetry classifier shows disagreement in trace
- ✗ User sees "heuristic high, llm medium, system uses high" with no explanation
- ✗ Zero logs indicating classifier failure

### After Fix

When classifier model is misconfigured or unavailable:
- ✓ Heuristic decision used with clear reasoning: `"Classifier unavailable, using heuristic: Detected planning keyword..."`
- ✓ Debug log (when `debug: true`): `[model-router] Classifier model not found: amazon-bedrock/us.amazon.nova-micro-v1:0`
- ✓ User can diagnose: either fix `classifierModel` config or accept heuristic fallback

---

## Testing

### Automated Tests

Added two new test files with 8 test cases:

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

**All 334 tests pass** (326 existing + 8 new).

### Manual Verification

Created `test/manual-classifier-failure-test.ts` which simulates:
- Classifier model not found
- Debug logging working
- Reasoning contains "Classifier unavailable" marker
- `isClassifier` flag is `false`

**Output sample:**

```
📝 Prompt: "investigate why the router ignores LLM decisions in adaptive mode"
[model-router] Classifier model not found: amazon-bedrock/us.amazon.nova-micro-v1:0
   🎯 Tier: high
   💭 Reasoning: Classifier unavailable, using heuristic: Detected strong planning keyword...
   🤖 isClassifier: false
   ✅ Failure marker present: YES
```

---

## Configuration Guide for Users

To enable adaptive mode with proper debugging:

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

### Troubleshooting Steps

If classifier consistently fails:

1. **Check model ref is valid**
   ```bash
   # Model should exist in registry
   /router
   # Look for classifier model in available models
   ```

2. **Check API key is configured**
   ```bash
   # Verify provider has API key
   # For Bedrock: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
   ```

3. **Enable debug logging**
   ```json
   { "debug": true }
   ```
   Look for `[model-router] Classifier failed: ...` in console

4. **Check decision reasoning**
   - Should start with `"Classifier: ..."` when working
   - Shows `"Classifier unavailable, using heuristic: ..."` when failed

---

## Files Changed

| File | Changes |
|------|---------|
| `src/routing.ts` | Added debug param, logging for all failure modes, fallback reasoning marker |
| `src/provider.ts` | Pass debug flag to resolveRouting |
| `test/classifier-failure-handling.test.ts` | New: 4 unit tests |
| `test/adaptive-mode-integration.test.ts` | New: 4 integration tests |
| `test/manual-classifier-failure-test.ts` | New: manual verification script |
| `docs/ADAPTIVE_MODE_FIX_SUMMARY.md` | Fix documentation |
| `docs/ADAPTIVE_CLASSIFIER_FIX.md` | Implementation notes |
| `AGENTS.md` | Updated test count, added troubleshooting section |

---

## Next Steps (Optional Future Enhancements)

1. **Notification on repeated failures**
   - Track consecutive classifier failures
   - Emit user-facing notification after N failures (e.g. 3)

2. **Trace format update**
   - Distinguish "classifier not attempted" vs "classifier failed" in trace records
   - Add `classifierError` field to TraceRecord

3. **Fallback chain**
   - Allow `classifierFallback` model ref for when primary classifier fails
   - E.g. primary=nova-micro, fallback=haiku

4. **Metrics in `/router usage`**
   - Show classifier success/failure rate
   - Track latency percentiles for classifier calls

---

## Deployment

```bash
cd ~/workspace/omp-model-router
bun run test         # 334 tests pass
bun run deploy:dev   # Deploy to ~/.omp/agent/extensions/model-router
```

Then in OMP:
```
/reload
/router
```

Verify version is v0.6.1 and decision reasoning shows classifier status.

---

## Conclusion

The issue was **not** that the classifier verdict was being ignored — it was that the classifier was failing silently and never producing a verdict in the first place. The background telemetry classifier succeeded (different code path, different error handling), creating the illusion that the system was ignoring a valid LLM decision.

The fix makes classifier failures visible through:
1. Debug console logs
2. Decision reasoning prefix
3. `isClassifier` flag remains false

Users can now diagnose and fix their `classifierModel` configuration when running in adaptive mode.
