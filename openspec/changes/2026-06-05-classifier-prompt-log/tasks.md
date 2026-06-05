## 1. Extend `SessionCalibration` (`src/calibration/types.ts`)

- [ ] 1.1 Add four new optional fields after `pendingSpawnTime`:
  ```ts
  /** Full classifier prompt string (for prompt log) */
  pendingClassifierPrompt?: string;
  /** Tool-mix bucket at spawn time */
  pendingBucket?: string;
  /** User message index at spawn time */
  pendingUserMsgIndex?: number;
  /** Path to classifierPrompt.jsonl (resolved once at spawn, if traceEnabled) */
  promptLogPath?: string;
  ```

## 2. Add `toolBucket` to `RoutingDecision` (`src/types.ts` or `src/routing/heuristic.ts`)

- [ ] 2.1 Find the `RoutingDecision` interface (likely in `src/types.ts`). Add:
  ```ts
  /** Tool-mix bucket computed during routing (for tracing) */
  toolBucket?: string;
  ```
- [ ] 2.2 In `src/routing/compose.ts` `resolveRouting`, after `const bucket = getBucket(toolCounts)` is computed (line ~291), assign `decision.toolBucket = bucket` before returning. The assignment must happen after all decision mutations (context trigger, classifier override, image upgrade) — set it on the final `decision` object just before `return decision`.

## 3. Add `appendPromptRecord` helper (`src/calibration/trace.ts`)

- [ ] 3.1 Import `appendFileSync` if not already imported (it is — check existing imports).
- [ ] 3.2 Add exported function:
  ```ts
  export interface PromptLogRecord {
    timestamp: string;
    turnIndex: number;
    userMsgIndex: number;
    bucket: string | undefined;
    model: string;
    heuristicTier: RouterTier;
    verdict: { tier: RouterTier; reasoning: string } | null;
    error?: string;
    latencyMs: number;
    prompt: string;
  }

  export function appendPromptRecord(path: string, record: PromptLogRecord): void {
    try {
      appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
    } catch {
      // best-effort — never throw
    }
  }
  ```

## 4. Update `spawnClassifierForTurn` (`src/calibration/hooks.ts`)

- [ ] 4.1 Add `bucket?: string` parameter to the function signature (after `sessionScope`).
- [ ] 4.2 After `cal.pendingPrompt = truncatePrompt(userPrompt, 500)`, add:
  ```ts
  cal.pendingClassifierPrompt = classifierPrompt;
  cal.pendingBucket = bucket;
  cal.pendingUserMsgIndex = scope.userMessagesSeen;
  ```
- [ ] 4.3 Resolve prompt log path. After the existing `const traceFilePath = traceEnabled ? cal.traceFilePath : undefined;` line, add:
  ```ts
  const ctxForLog = state.getSessionContext(scope.sessionId);
  const artifactsDir = traceEnabled
    ? (ctxForLog?.sessionManager as any)?.getArtifactsDir?.() ?? null
    : null;
  const promptLogPath = (artifactsDir as string | null)
    ? join(artifactsDir as string, "classifierPrompt.jsonl")
    : undefined;
  cal.promptLogPath = promptLogPath;
  ```
  Add `import { join } from "node:path"` at the top if not already present.

- [ ] 4.4 In `clearPending` (bottom of file), add:
  ```ts
  cal.pendingClassifierPrompt = undefined;
  cal.pendingBucket = undefined;
  cal.pendingUserMsgIndex = undefined;
  cal.promptLogPath = undefined;
  ```

- [ ] 4.5 Import `appendPromptRecord` and `PromptLogRecord` from `"./trace.js"` at top of file.
- [ ] 4.6 Import `RouterTier` type if needed for `PromptLogRecord`.

## 5. Write prompt log records in the async closure (`src/calibration/hooks.ts`)

The closure already has `state` in scope. Read `state.calibration.promptLogPath` and `state.calibration.pendingClassifierPrompt` where needed.

Build a shared helper inline at the top of the closure to avoid repetition:
```ts
const writePromptLog = (
  verdict: { tier: RouterTier; reasoning: string } | null,
  error: string | undefined,
  latencyMs: number,
) => {
  const pl = state.calibration?.promptLogPath;
  const pr = state.calibration?.pendingClassifierPrompt;
  if (!pl || !pr) return;
  const refForModel = Array.isArray(classifierModelRef)
    ? classifierModelRef[0]
    : classifierModelRef;
  appendPromptRecord(pl, {
    timestamp:    new Date().toISOString(),
    turnIndex:    state.calibration?.pendingTurnIndex ?? 0,
    userMsgIndex: state.calibration?.pendingUserMsgIndex ?? 0,
    bucket:       state.calibration?.pendingBucket,
    model:        refForModel ?? "unknown",
    heuristicTier: state.calibration?.pendingHeuristicTier ?? "medium",
    verdict,
    error,
    latencyMs,
    prompt: pr,
  });
};
```

- [ ] 5.1 **spawn-no-id failure path** (after `state.calibration.llmCallsFailed++`): call `writePromptLog(null, "spawn-no-id", 0)`.
- [ ] 5.2 **timeout path** (after `abandonClassifier` + `llmCallsFailed++`): call `writePromptLog(null, "timeout", ageMs)`.
- [ ] 5.3 **result.error path** (after `llmCallsFailed++`): call `writePromptLog(null, `error:${result.error.slice(0, 60)}`, ageMs)`.
- [ ] 5.4 **no-verdict path**: call `writePromptLog(null, "no-verdict-or-tier", ageMs)`.
- [ ] 5.5 **success path** (after `updateCalibrationMatrix`, before `if (traceFilePath)`): call `writePromptLog(verdict, undefined, ageMs)`.
- [ ] 5.6 **catch block** (after `llmCallsFailed++`): call `writePromptLog(null, reason, ageMs)`.
- [ ] 5.7 **.catch block** (after `llmCallsFailed++`): call `writePromptLog(null, `spawn-threw:${String(err).slice(0,40)}`, 0)`.

## 6. Thread `bucket` to `spawnClassifierForTurn` call site (`src/index.ts`)

- [ ] 6.1 Find the call to `spawnClassifierForTurn` in `src/index.ts`. Read `decision.toolBucket` from the routing decision (set in task 2.2). Pass it as the new `bucket` argument.

## 7. Tests — `test/classifier-prompt-log.test.ts`

Write a new test file using `bun:test`. Create a temp dir for `artifactsDir`. Mock `state.getSessionContext` to return a `ctx` whose `sessionManager.getArtifactsDir()` returns the temp dir path.

- [ ] 7.1 `traceEnabled: false` → after triggering a classifier spawn+verdict, assert no `classifierPrompt.jsonl` file exists in temp dir.
- [ ] 7.2 `traceEnabled: true`, `getArtifactsDir()` returns `null` → no file created, no error thrown.
- [ ] 7.3 Successful verdict → file created; parse first line; assert `prompt` starts with `"You are a model router classifier"`, `verdict.tier` is a valid tier, `heuristicTier` is correct, `latencyMs >= 0`, `turnIndex` and `userMsgIndex` are numbers.
- [ ] 7.4 Failed call (`spawn-no-id`) → file created; record has `verdict === null`, `error === "spawn-no-id"`, `prompt` is present.
- [ ] 7.5 Two sequential successful calls → file has two newline-separated JSON records.
- [ ] 7.6 Bucket field → `bucket` in record matches what was passed to `spawnClassifierForTurn`.

## 8. Verification and Documentation

- [ ] 8.1 `bun test test/classifier-prompt-log.test.ts` — all tests pass.
- [ ] 8.2 `bun run test` — full suite green.
- [ ] 8.3 Update `AGENTS.md` calibration section: add a note that `traceEnabled: true` now also writes `classifierPrompt.jsonl` to the session artifact dir, with full prompt and verdict per call.
