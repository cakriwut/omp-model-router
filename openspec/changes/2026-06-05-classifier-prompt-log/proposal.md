## Why

There is currently no way to review what was sent to the classifier model after the fact. `traceEnabled: true` writes a per-session JSONL but only captures: heuristic tier, LLM verdict, latency, and a 500-char truncation of the user text. The full `buildClassifierPrompt()` output — conversation summary, tool-mix activity line, system instructions, and the complete user message — is discarded after being passed to `spawnClassifierAgent`.

This makes it impossible to audit routing decisions, debug misclassifications, or tune the prompt without adding temporary debug code.

## What Changes

- **New per-session file `classifierPrompt.jsonl`** written to `ctx.sessionManager.getArtifactsDir()/<sessionId>/classifierPrompt.jsonl` (same convention as the artifact dir used by sub-agents).
- **One record per actual classifier call** (not cache hits — nothing was sent). Written when the verdict arrives so the record is complete in a single append.
- **Gated on `traceEnabled: true`** — same flag as the existing trace JSONL, same intent, no new config surface.
- **`SessionCalibration`** gains `pendingClassifierPrompt?: string` and `promptLogPath?: string` fields to carry the full prompt string and the file path into the async closure without capturing `ctx`.
- **`spawnClassifierForTurn`** resolves `artifactsDir` from the session context, opens the file path, stores it in `cal.promptLogPath`, stores the full `classifierPrompt` string in `cal.pendingClassifierPrompt`, then writes the record on verdict arrival (success, failure, and timeout paths).

## Record Shape

```jsonl
{
  "timestamp": "2026-06-05T19:21:31.000Z",
  "turnIndex": 3,
  "userMsgIndex": 2,
  "bucket": "exploration",
  "model": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "heuristicTier": "medium",
  "verdict": { "tier": "high", "reasoning": "Broad investigation across multiple files" },
  "latencyMs": 1240,
  "prompt": "You are a model router classifier..."
}
```

Failed / timed-out calls:
```jsonl
{
  "timestamp": "2026-06-05T19:22:00.000Z",
  "turnIndex": 5,
  "userMsgIndex": 3,
  "bucket": "implementation",
  "model": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "heuristicTier": "medium",
  "verdict": null,
  "error": "timeout",
  "latencyMs": 30000,
  "prompt": "You are a model router classifier..."
}
```

## Capabilities

### Modified Capabilities

- `session-rollup` (calibration): when `traceEnabled: true`, a `classifierPrompt.jsonl` file is written alongside the existing `*-calibration.jsonl` trace. Contains the full prompt sent to the classifier and the verdict received. Allows post-session audit of routing decisions.

## Non-Goals

- Logging cache hits (no prompt was sent — nothing to review).
- Adding a new config flag (reuses `traceEnabled`).
- Changing the existing `*-calibration.jsonl` trace format.
- A CLI command to read `classifierPrompt.jsonl` (plain JSONL is sufficient for now).
- Logging the sync classifier path in `resolveRouting` — the same `buildClassifierPrompt` output is used; adding it there is a separate concern.
