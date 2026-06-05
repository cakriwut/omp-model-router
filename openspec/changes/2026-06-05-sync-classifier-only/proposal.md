## Why

The classifier has two completely separate execution paths:

1. **Sync path** (`resolveRouting` in `compose.ts` → `runClassifier`): Runs before model selection. Verdict controls routing in adaptive mode.
2. **Async path** (`spawnClassifierForTurn` in `hooks.ts` → `spawnClassifierAgent` → polling loop): Fires after routing, in the background. Verdict is only used for calibration matrix training in telemetry mode.

This split creates inconsistency and accidental complexity:
- Prompt logging had to be wired to the async path, missing the sync path entirely — causing `classifierPrompt.jsonl` to never be written in adaptive mode.
- Two separate prompt-building calls, two separate verdict-parsing paths, two separate failure modes.
- ~250 lines of async machinery: spawn, poll, timeout, tracking IDs, `pendingAgentId`, `lastAsyncClassifierKey`, `spawnClassifierAgent`, `pollClassifierResult`, `abandonClassifier`, `spawnViaSubagent`, `spawnViaStreamSimple`, `runClassifierStream`.
- `syncClassifierRan` flag exists solely to suppress the async spawn when the sync path already ran — a band-aid over the split.
- The `agent.ts` module (pi-subagents + streamSimple fallback) exists entirely to serve the async path.

## What Changes

**Keep**: sync path in `resolveRouting`. It already handles both modes correctly:
- adaptive: verdict overrides heuristic tier
- telemetry: verdict records into calibration matrix, heuristic tier kept

**Delete**: entire async path — `spawnClassifierForTurn`, `spawnClassifierAgent`, `pollClassifierResult`, `abandonClassifier`, `spawnViaSubagent`, `spawnViaStreamSimple`, `runClassifierStream`, and all supporting state.

**Move prompt logging into the sync path**: `appendPromptRecord` called directly in `resolveRouting` after `runClassifier` returns (fresh call only, not cache hits). `promptLogPath` passed via `RoutingConfig` (already partially wired by `2026-06-05-classifier-prompt-log`).

**Wire `promptLogPath` from `provider.ts`**: resolve `ctx.sessionManager.getArtifactsDir()` before calling `resolveRouting`, pass as `config.promptLogPath`.

**Clean up dead state**:
- `SessionCalibration`: remove `pendingAgentId`, all `pending*` fields (now unnecessary — sync path has the data in scope)
- `SessionScope`: remove `lastAsyncClassifierKey`
- `RoutingDecision`: remove `syncClassifierRan` (no async path to suppress)
- `calibration/index.ts`: remove exports of `spawnClassifierAgent`, `pollClassifierResult`, `abandonClassifier`, `ClassifierPollResult`
- `calibration/agent.ts`: delete file entirely

**Telemetry mode behavior after**: classifier still runs every new user message (respects cache), verdict is recorded into matrix, heuristic tier is used for routing — identical observable behavior, just synchronous instead of deferred.

**Latency impact**: telemetry mode now blocks ~1-3s per turn while classifier runs. Acceptable: `SYNC_CLASSIFIER_TIMEOUT_MS = 10s` caps worst case; users who chose telemetry mode already accept classifier overhead.

## Capabilities

### Modified Capabilities

- `calibration`: Classifier runs synchronously on every eligible turn for both adaptive and telemetry modes. No background polling, no spawn/abandon machinery. Prompt log (`classifierPrompt.jsonl`) is now written correctly for both modes.

## Non-Goals

- Changing routing logic, tier selection, cache key, or TTL behavior.
- Changing `traceEnabled` / `*-calibration.jsonl` trace format.
- Adding a config flag for async opt-in — simplicity over configurability.
- Removing the telemetry mode itself — it still exists, just runs synchronously.
