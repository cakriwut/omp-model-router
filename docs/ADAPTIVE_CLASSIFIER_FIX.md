# Adaptive Mode Classifier Silent Failure Fix

## Problem

When `calibration.mode` is `"adaptive"` with a `classifierModel` configured, the synchronous classifier in `resolveRouting` should override heuristic decisions. However, when the classifier fails (model not found, API error, response parsing error), the error is silently swallowed at `routing.ts:571-573`:

```typescript
} catch (_error) {
    // Ignore classifier errors and fall back to heuristics
}
return undefined;
```

This causes:
1. Routing falls back to heuristic decision (user expects classifier to control routing)
2. Background telemetry classifier succeeds and records disagreement in trace
3. User sees "heuristic high, llm medium, system uses high" — no indication the sync classifier failed

## Evidence

Analysis of recent trace files shows:
- 144/160 turns: sync classifier ran successfully (reasoning starts with "Classifier:")
- 16/160 turns: sync classifier silently failed (reasoning is pure heuristic)
  - 14 agreed by luck
  - **2 disagreed** — visible to user as routing ignoring LLM verdict

## Solution

### 1. Log classifier failures (debug mode)

When `runClassifier` catches an error, log it if debug mode is enabled. This requires passing `debug` flag to `runClassifier`.

### 2. Surface classifier failure in decision reasoning

When classifier returns `undefined` in adaptive mode, update the decision reasoning to indicate fallback:

```typescript
if (classifierResult) {
    decision = buildRoutingDecision(...);
} else {
    // Classifier failed or timed out
    decision.reasoning = `Classifier unavailable (${decision.reasoning})`;
}
```

### 3. Emit notification on repeated failures

If classifier fails N consecutive times (e.g. 3), emit a user-facing notification suggesting config check.

## Implementation Plan

1. Update `runClassifier` signature to accept optional `debug` flag
2. Log caught exceptions when debug=true
3. Update `resolveRouting` to mark decision when classifier was attempted but failed
4. Add failure counter to `RouterState` for notification threshold
5. Update trace format to distinguish "classifier not attempted" vs "classifier failed"

## Testing

1. Corrupt `classifierModel` ref (e.g. `amazon-bedrock/nonexistent-model`)
2. Verify debug log shows "Classifier failed: model not found"
3. Verify decision reasoning shows fallback indicator
4. Verify notification appears after threshold

## Related Files

- `src/routing.ts` — `runClassifier`, `resolveRouting`
- `src/provider.ts` — calls `resolveRouting`
- `src/calibration/hooks.ts` — background classifier spawn
- `src/types.ts` — `RoutingDecision` type
