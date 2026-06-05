## 1. Delete `src/calibration/agent.ts`

- [ ] 1.1 Delete the file entirely. It exists solely for the async path.

## 2. Clean `src/calibration/types.ts`

- [ ] 2.1 Delete `ClassifierPollResult` interface (entire block).
- [ ] 2.2 Delete all `pending*` fields from `SessionCalibration`:
  `pendingAgentId`, `pendingHeuristicTier`, `pendingHeuristicPhase`, `pendingHeuristicReasoning`, `pendingRuleMatched`, `pendingPrompt`, `pendingToolResultCount`, `pendingTurnIndex`, `pendingSpawnTime`, `pendingClassifierPrompt`, `pendingBucket`, `pendingUserMsgIndex`, `promptLogPath`.
- [ ] 2.3 Keep: `matrix`, `totalComparisons`, `llmCallsAttempted`, `llmCallsFailed`, `sessionStartTime`, `turnsProcessed`, `traceFilePath`.

## 3. Clean `src/calibration/index.ts`

- [ ] 3.1 Remove the entire agent re-export block:
  ```ts
  export {
      spawnClassifierAgent,
      pollClassifierResult,
      abandonClassifier,
  } from "./agent";
  ```
- [ ] 3.2 Remove `ClassifierPollResult` from the types export line.

## 4. Clean `src/calibration/hooks.ts`

- [ ] 4.1 Remove imports: `spawnClassifierAgent`, `pollClassifierResult`, `abandonClassifier` from `"./index"`.
- [ ] 4.2 Remove imports: `buildClassifierPrompt` from `"./classifier-utils"`, `appendPromptRecord` from `"./trace.js"`, `join` from `"node:path"`, `shortenModelRef` from `"../ui/theme.js"`, `countWords` from `"../routing/text.js"`. Keep only what the remaining lifecycle hooks use.
- [ ] 4.3 Delete `spawnClassifierForTurn` function entirely (lines ~144–565).
- [ ] 4.4 Delete `clearPending` function entirely (bottom of file).
- [ ] 4.5 Delete `writeCompletedTrace` and `writePendingAsFailed` internal helpers if they exist and are only used by `spawnClassifierForTurn`.
- [ ] 4.6 Simplify `onTurnEnd` — it is already a no-op; keep the function signature but remove the body comment about promises (just `return`).
- [ ] 4.7 Verify remaining exports: `onSessionStart`, `onSessionBranch`, `onTurnStart`, `onTurnEnd`, `onSessionEnd` — all still present and correct.

## 5. Clean `src/state/index.ts`

- [ ] 5.1 Remove `lastAsyncClassifierKey: string | undefined` from the `SessionScope` interface.
- [ ] 5.2 Remove the JSDoc comment above it explaining async dedup.
- [ ] 5.3 Remove the initializer `lastAsyncClassifierKey: undefined` from wherever `SessionScope` is created (search for the object literal that sets all scope fields).
- [ ] 5.4 Remove the `get lastAsyncClassifierKey` / `set lastAsyncClassifierKey` accessors from `RouterState` (around lines 527–528).

## 6. Clean `src/types.ts`

- [ ] 6.1 Remove `syncClassifierRan?: boolean` field and its JSDoc comment from `RoutingDecision`.

## 7. Wire prompt logging into `src/routing/compose.ts`

Read the file fully before editing. The `buildClassifierPrompt` import was added by a prior change — verify it's present. The `appendPromptRecord` import was also added — verify it's present.

- [ ] 7.1 In the `else` branch (fresh classifier call, not cache hit), add a timer and prompt capture before `runClassifier`:
  ```ts
  const classifierSpawnTime = Date.now();
  const builtPrompt = buildClassifierPrompt(
      input.context,
      decision.phase,
      toolCounts,
      config.pitfalls,
  );
  ```

- [ ] 7.2 After `runClassifier` returns (after `syncClassifierRan = true` and cache key assignment), add:
  ```ts
  // Write prompt log on fresh call (not cache hit)
  if (config.promptLogPath) {
      const refForModel = Array.isArray(config.classifierModel)
          ? config.classifierModel[0]
          : config.classifierModel;
      appendPromptRecord(config.promptLogPath, {
          timestamp:    new Date().toISOString(),
          turnIndex:    input.calibration?.turnsProcessed ?? 0,
          userMsgIndex: resolvedScope?.userMessagesSeen ?? 0,
          bucket,
          model:        refForModel ?? "unknown",
          heuristicTier: decision.tier,
          verdict:      verdict ?? null,
          error:        verdict ? undefined : "no-verdict",
          latencyMs:    Date.now() - classifierSpawnTime,
          prompt:       builtPrompt,
      });
  }
  ```

- [ ] 7.3 Remove `decision.syncClassifierRan = syncClassifierRan` line (field deleted in task 6.1). Also remove the `let syncClassifierRan = false` declaration and all assignments to it.

## 8. Wire `promptLogPath` from `src/provider.ts`

- [ ] 8.1 Remove the import of `spawnClassifierForTurn` from `"./calibration/hooks"`.
- [ ] 8.2 Remove the `spawnClassifierForTurn(...)` call (line ~516).
- [ ] 8.3 Before the `resolveRouting` call, add:
  ```ts
  const traceEnabled = !!state.currentConfig.calibration?.traceEnabled;
  const artifactsDir = (traceEnabled && sessionCtx)
      ? (sessionCtx.sessionManager as any).getArtifactsDir?.() ?? null
      : null;
  const promptLogPath = typeof artifactsDir === "string" && artifactsDir
      ? join(artifactsDir, "classifierPrompt.jsonl")
      : undefined;
  ```
  Add `import { join } from "node:path"` if not already present.
- [ ] 8.4 Add `promptLogPath` to the `RoutingConfig` object passed to `resolveRouting`:
  ```ts
  promptLogPath,
  ```

## 9. Update affected tests

- [ ] 9.1 **Delete** `test/async-classifier-dedup.test.ts` — tests async dedup that no longer exists.
- [ ] 9.2 **Delete** `test/mock-check.test.ts` — tests async spawn mock infrastructure that no longer exists. Verify nothing else depends on it.
- [ ] 9.3 **Audit `test/badge-logging.test.ts`** — read it; if it tests async badge output (`async·telemetry` / `async·adaptive` label), update the expected label to `sync·telemetry` / `sync·adaptive` or remove the mode suffix. Do not delete if it tests badge output that still works.
- [ ] 9.4 **Audit `test/session-rollup-completeness.test.ts`** — read it; remove any references to `pendingAgentId`, `lastAsyncClassifierKey`, or async spawn. Update or delete as appropriate.
- [ ] 9.5 **Rewrite `test/classifier-prompt-log.test.ts`** — currently mocks async path. Rewrite to test the sync path: mock `runClassifier` (imported from `./routing/index.js`) to return a verdict, pass `promptLogPath` via `RoutingConfig`, assert file is written. No `spawnClassifierForTurn` needed.

## 10. New test: `test/sync-classifier-only.test.ts`

- [ ] 10.1 Telemetry mode: call `resolveRouting` with `calibrationConfig.mode = "telemetry"`, mock `runClassifier` → `{ tier: "high", reasoning: "test" }`. Assert returned decision tier = heuristic tier (not "high"), and calibration matrix updated.
- [ ] 10.2 Adaptive mode: same setup with `mode = "adaptive"`. Assert returned decision tier = "high" (classifier verdict).
- [ ] 10.3 Prompt log written on fresh call: pass a `promptLogPath` pointing to a temp file. Assert file created with correct fields after `resolveRouting`.
- [ ] 10.4 Prompt log NOT written on cache hit: seed `scope.lastClassifierKey` to match the sig; assert file is NOT created.
- [ ] 10.5 `syncClassifierRan` field no longer on `RoutingDecision` — TypeScript compile check (access `decision.syncClassifierRan` should be a type error; use `@ts-expect-error` to assert its absence).

## 11. Verification

- [ ] 11.1 `bun run test` — full suite green.
- [ ] 11.2 Deploy: `bun run deploy:dev`.
- [ ] 11.3 Update `AGENTS.md`: remove references to async classifier path, `syncClassifierRan`, `lastAsyncClassifierKey`. Update calibration section to say classifier runs synchronously in both modes.
