## Deletion Map

| Symbol | File | Action |
|--------|------|--------|
| `spawnClassifierForTurn` | `src/calibration/hooks.ts` | Delete function (lines ~144–565) |
| `spawnClassifierAgent` | `src/calibration/agent.ts` | Delete file |
| `pollClassifierResult` | `src/calibration/agent.ts` | Delete file |
| `abandonClassifier` | `src/calibration/agent.ts` | Delete file |
| `spawnViaSubagent` | `src/calibration/agent.ts` | Delete file |
| `spawnViaStreamSimple` | `src/calibration/agent.ts` | Delete file |
| `runClassifierStream` | `src/calibration/agent.ts` | Delete file |
| `ClassifierPollResult` | `src/calibration/types.ts` | Delete type |
| `pendingAgentId` | `src/calibration/types.ts` | Delete field |
| `pendingHeuristicTier` | `src/calibration/types.ts` | Delete field |
| `pendingHeuristicPhase` | `src/calibration/types.ts` | Delete field |
| `pendingHeuristicReasoning` | `src/calibration/types.ts` | Delete field |
| `pendingRuleMatched` | `src/calibration/types.ts` | Delete field |
| `pendingPrompt` | `src/calibration/types.ts` | Delete field |
| `pendingToolResultCount` | `src/calibration/types.ts` | Delete field |
| `pendingTurnIndex` | `src/calibration/types.ts` | Delete field |
| `pendingSpawnTime` | `src/calibration/types.ts` | Delete field |
| `pendingClassifierPrompt` | `src/calibration/types.ts` | Delete field — prompt available in sync scope |
| `pendingBucket` | `src/calibration/types.ts` | Delete field |
| `pendingUserMsgIndex` | `src/calibration/types.ts` | Delete field |
| `promptLogPath` | `src/calibration/types.ts` | Delete field — resolved per-call in compose.ts |
| `lastAsyncClassifierKey` | `src/state/index.ts` `SessionScope` | Delete field + accessors |
| `syncClassifierRan` | `src/types.ts` `RoutingDecision` | Delete field |
| `clearPending` | `src/calibration/hooks.ts` | Delete function |
| `onTurnEnd` | `src/calibration/hooks.ts` | Simplify to no-op comment removal |
| `calibration/index.ts` | agent re-exports | Remove `spawnClassifierAgent`, `pollClassifierResult`, `abandonClassifier`, `ClassifierPollResult` |
| import of `spawnClassifierForTurn` | `src/provider.ts` | Remove import + call |

## Addition Map

| Symbol | File | Action |
|--------|------|--------|
| `promptLogPath?: string` | `src/routing/compose.ts` `RoutingConfig` | Keep (already added by prior change) |
| `toolBucket?: string` | `src/types.ts` `RoutingDecision` | Keep (already added) |
| `appendPromptRecord` call | `src/routing/compose.ts` | Add after fresh `runClassifier` call |
| `promptLogPath` resolution | `src/provider.ts` | Add before `resolveRouting` call |

## Sync Path After Change

```
resolveRouting() — same logic, both modes:
  if classifierModel && !isSubAgent && !pinnedTier && !contextTriggered && !ruleMatched:
    compute sig (lastUserText | userMsgIndex | bucket)
    if cache hit:
      verdict = cached
    else:
      t0 = Date.now()
      verdict = await runClassifier(...)       // ~1-3s, already was sync
      latency = Date.now() - t0
      if verdict && promptLogPath:             // NEW: log full prompt
        appendPromptRecord(promptLogPath, {
          timestamp, turnIndex, userMsgIndex,
          bucket, model, heuristicTier: decision.tier,
          verdict, latencyMs: latency, prompt: builtPrompt
        })
    update calibration matrix (both modes)
    if adaptive: override decision with verdict tier
    if telemetry: keep heuristic decision, matrix updated
```

The only thing `promptLogPath` needs is `getArtifactsDir()` from the session context. Provider.ts has `sessionCtx` in scope:

```ts
// provider.ts — before resolveRouting call
const artifactsDir = (traceEnabled && sessionCtx)
    ? (sessionCtx.sessionManager as any).getArtifactsDir?.() ?? null
    : null;
const promptLogPath = typeof artifactsDir === "string" && artifactsDir
    ? join(artifactsDir, "classifierPrompt.jsonl")
    : undefined;
```

Pass as `config.promptLogPath` in the `RoutingConfig` object.

## `buildClassifierPrompt` call in compose.ts

The sync path needs the built prompt string for `appendPromptRecord`. `buildClassifierPrompt` is already imported in `compose.ts` (added by `2026-06-05-classifier-prompt-log`). Call it once, before `runClassifier`:

```ts
const builtPrompt = buildClassifierPrompt(
    input.context,
    decision.phase,
    toolCounts,
    config.pitfalls,
);
// pass builtPrompt to runClassifier (or let runClassifier rebuild it — same inputs)
// after runClassifier returns, use builtPrompt in appendPromptRecord
```

`runClassifier` also calls `buildClassifierPrompt` internally with the same arguments. This is a double-call. Two options:
- **A**: Accept the double-call (two cheap string operations, no I/O). Simple.
- **B**: Refactor `runClassifier` to accept a pre-built prompt string. More invasive.

**Decision A**: Accept the double-call. `buildClassifierPrompt` is pure string concatenation, no I/O. Not measurable.

## `hooks.ts` After Change

Keeps only lifecycle hooks:
- `onSessionStart` — initialize `state.calibration`, open trace file
- `onSessionBranch` — clear state, open new trace file
- `onTurnStart` — increment `turnsProcessed`
- `onTurnEnd` — no-op (can be removed or kept as empty stub for future use)
- `onSessionEnd` — merge calibration into global snapshot

Remove: `spawnClassifierForTurn`, `clearPending`, all imports of `spawnClassifierAgent` / `pollClassifierResult` / `abandonClassifier`.

## `calibration/index.ts` After Change

Remove from exports:
```ts
// Delete entire block:
export {
    spawnClassifierAgent,
    pollClassifierResult,
    abandonClassifier,
} from "./agent";

// Delete from types:
export type { ClassifierPollResult } from "./types";
```

## Test Impact

| Test file | Action |
|-----------|--------|
| `test/async-classifier-dedup.test.ts` | Delete — tests async dedup logic that no longer exists |
| `test/mock-check.test.ts` | Delete or rework — tests async spawn mock |
| `test/badge-logging.test.ts` | Audit — may test async badge; update to sync path |
| `test/session-rollup-completeness.test.ts` | Audit — may reference `pendingAgentId`; update |
| `test/classifier-prompt-log.test.ts` | Rework — currently mocks async path; rewrite for sync path |

New test: `test/sync-classifier-only.test.ts` — verifies that:
1. Telemetry mode: classifier runs, matrix updated, heuristic tier returned
2. Adaptive mode: classifier runs, verdict tier returned
3. Prompt log written on fresh call, not on cache hit
4. `spawnClassifierForTurn` no longer exported (compile-time check)

## Migration / Rollback

- **Migration**: none. Same observable routing behavior — telemetry users see +1-3s latency per new user message.
- **Rollback**: revert `src/routing/compose.ts`, `src/provider.ts`, `src/calibration/hooks.ts`, `src/calibration/types.ts`, `src/state/index.ts`, `src/types.ts`. Restore `agent.ts`.
