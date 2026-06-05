## Context

`spawnClassifierForTurn` in `src/calibration/hooks.ts` builds the classifier prompt via `buildClassifierPrompt(context, ...)` and passes the string to `spawnClassifierAgent`. The string is never stored anywhere persistent. The async closure that handles the verdict captures only primitives and the `RouterState` ref — no `ctx`, no `context`.

`SessionCalibration` already carries `pending*` fields to bridge spawn-time data into the async closure. The same pattern applies here: store the prompt string and the log file path in `pending*` fields before spawning, read them in the closure when writing the verdict.

`ctx.sessionManager.getArtifactsDir()` returns the per-session artifact directory (e.g. `~/.omp/agent/sessions/-workspace-omp-model-router/<ts>_<id>/`). Writing `classifierPrompt.jsonl` there follows the same convention as sub-agent artifact files. The method is available via `state.getSessionContext(scope.sessionId).sessionManager`.

## Goals / Non-Goals

**Goals:**
- Full classifier prompt persisted per session when `traceEnabled: true`
- One record per actual call (not cache hits), complete on write (verdict + prompt together)
- Failed/timed-out calls also written (with `verdict: null`, `error` field)
- Zero new config surface — reuses `traceEnabled`

**Non-Goals:**
- Sync classifier path logging (separate concern, different call site in `resolveRouting`)
- CLI reader for `classifierPrompt.jsonl`
- Changing `*-calibration.jsonl` format

## Decisions

### D1: Reuse `traceEnabled` gate, no new config

**Decision**: Write `classifierPrompt.jsonl` if and only if `config.calibration.traceEnabled === true`.

**Rationale**: `traceEnabled` already signals "I want observability data for this session". Adding a separate flag fragments the config for what is the same intent. One flag, two files (trace + prompt log).

### D2: Write on verdict arrival, not at spawn time

**Decision**: Append the record when the verdict (or failure) is known, not when the prompt is built.

**Rationale**: A spawn-time write would require a second append when the verdict arrives or a file-rewrite. A single append at resolution time produces a self-contained record. The `prompt` string is carried via `cal.pendingClassifierPrompt` (same pattern as `cal.pendingPrompt` today).

### D3: Cache hits not written

**Decision**: Do not write a record when `cacheHit === true` in `resolveRouting`.

**Rationale**: Cache hits mean no prompt was sent to the classifier model. The file is called `classifierPrompt.jsonl` — it should only contain actual calls. Cache behavior is already observable via `debug: true` UI notifications.

### D4: `promptLogPath` resolved from `getArtifactsDir()`, stored on `SessionCalibration`

**Decision**: In `spawnClassifierForTurn`, resolve `artifactsDir = ctx.getArtifactsDir?.()`, derive `promptLogPath = join(artifactsDir, "classifierPrompt.jsonl")`, store on `cal.promptLogPath`. The closure reads `state.calibration.promptLogPath`.

**Rationale**: Consistent with how `traceFilePath` is handled today — resolved once at spawn time, stored as a string, captured by the closure through `state.calibration`. No `ctx` object in the closure.

**Edge case**: `getArtifactsDir()` may return `null` when the session is not persisted to a file (in-memory / test mode). Guard with `if (!artifactsDir) { promptLogPath = undefined }`.

### D5: `bucket` and `userMsgIndex` added to record

**Decision**: Include `bucket` (tool-mix phase) and `userMsgIndex` in the record alongside the existing `pendingTurnIndex`.

**Rationale**: These are the two components of the cache key beyond `lastUserText`. Without them, a prompt log record is incomplete for understanding why the classifier was or wasn't called.

**Source**: `bucket` and `userMsgIndex` are available at spawn time in `spawnClassifierForTurn` via `scope.userMessagesSeen` (already used for `asyncKey`) and the bucket is computed in `resolveRouting`. Problem: `spawnClassifierForTurn` doesn't receive the bucket. **Solution**: add `bucket?: string` parameter to `spawnClassifierForTurn` and thread it from the call site in `src/index.ts`.

### D6: Model ref in record is the first entry of `classifierModelRef`

**Decision**: `model` field = `Array.isArray(classifierModelRef) ? classifierModelRef[0] : classifierModelRef`.

**Rationale**: The actual model that answered may differ if fallback chain was used. Recording the first ref is consistent with what `console.log` already does for the badge line. Actual model is observable from the verdict if needed.

## Architecture

### `SessionCalibration` additions (`src/calibration/types.ts`)

```ts
/** Full classifier prompt string at spawn time (for prompt log) */
pendingClassifierPrompt?: string;
/** Path to classifierPrompt.jsonl (if traceEnabled and artifactsDir available) */
promptLogPath?: string;
```

### `spawnClassifierForTurn` changes (`src/calibration/hooks.ts`)

New parameter: `bucket?: string`

At spawn time (after existing `cal.pendingPrompt = ...`):
```ts
cal.pendingClassifierPrompt = classifierPrompt;  // full string, not truncated

const artifactsDir = ctx?.sessionManager?.getArtifactsDir?.() ?? null;
const promptLogPath = (traceEnabled && artifactsDir)
  ? join(artifactsDir, "classifierPrompt.jsonl")
  : undefined;
cal.promptLogPath = promptLogPath;
```

Store bucket for the record:
```ts
cal.pendingBucket = bucket;           // new field on SessionCalibration
cal.pendingUserMsgIndex = scope.userMessagesSeen;  // new field
```

### `appendPromptRecord` helper (`src/calibration/hooks.ts` or `src/calibration/trace.ts`)

```ts
function appendPromptRecord(
  path: string,
  record: {
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
): void {
  try {
    appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // silent — prompt log is best-effort
  }
}
```

### Write points in the async closure

**Success path** (after `updateCalibrationMatrix`):
```ts
if (state.calibration.promptLogPath && state.calibration.pendingClassifierPrompt) {
  appendPromptRecord(state.calibration.promptLogPath, {
    timestamp: new Date().toISOString(),
    turnIndex:    state.calibration.pendingTurnIndex ?? 0,
    userMsgIndex: state.calibration.pendingUserMsgIndex ?? 0,
    bucket:       state.calibration.pendingBucket,
    model:        Array.isArray(classifierModelRef) ? classifierModelRef[0] : classifierModelRef,
    heuristicTier: heuristicTierFinal,
    verdict,
    latencyMs: ageMs,
    prompt:    state.calibration.pendingClassifierPrompt,
  });
}
```

**Failure paths** (spawn-no-id, timeout, error, catch): same shape with `verdict: null` and `error: reason`.

### `clearPending` extension (`src/calibration/hooks.ts`)

Add `cal.pendingClassifierPrompt = undefined` and `cal.promptLogPath = undefined` and the two new pending fields to `clearPending`.

### Call site update (`src/index.ts`)

`spawnClassifierForTurn` is called after `resolveRouting` returns. The `bucket` is computed inside `resolveRouting` but not currently returned. Two options:
- A: Extract `getBucket(toolCounts)` call to `src/index.ts` before `resolveRouting` and pass it to both
- B: Return `bucket` from `resolveRouting` as part of `RoutingDecision`

**Decision B**: Add `toolBucket?: string` to `RoutingDecision` and set it inside `resolveRouting` before returning. `spawnClassifierForTurn` reads it from `decision.toolBucket`. Cleaner — `resolveRouting` already computes the bucket and it belongs on the decision object for tracing.

## Test Strategy

### `test/classifier-prompt-log.test.ts`

1. **`traceEnabled: false`** → no `classifierPrompt.jsonl` created.
2. **`traceEnabled: true`, no artifactsDir** (null from `getArtifactsDir`) → no error, no file.
3. **`traceEnabled: true`, successful verdict** → file created, one record, `prompt` field equals the built prompt, `verdict.tier` correct, `heuristicTier` correct, `latencyMs >= 0`.
4. **Failed call** → file created, record has `verdict: null`, `error` field non-empty, `prompt` field present.
5. **Two calls, same session** → file has two records (append semantics).
6. **Cache hits not written** → seed classifier cache; fire two turns with same user text; assert file has exactly one record (first call only).
