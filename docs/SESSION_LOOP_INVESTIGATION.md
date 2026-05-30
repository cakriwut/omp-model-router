# Session Loop Investigation — 019e77d8-692c-7000-9241-ba4f18bbfa31

**Date**: 2026-05-30  
**Session ID**: `019e77d8-692c-7000-9241-ba4f18bbfa31`  
**Symptom**: Agent stuck in loop, repeatedly asking user to label 9 disagreement cases for calibration despite user saying "implement" / "Lets do A"

---

## Root Cause: Context Bloat with Frozen Checkpoint

### The Numbers

- **738 messages** in session JSONL (50 user, 350 assistant, 338 toolResult)
- **1.2MB total content** in conversation history
- **273,278 estimated tokens** in context
- **270,535 cache read tokens** (99% cached)
- **Compression checkpoint frozen** and reused every turn (`compressionCacheHit: true`)

### What Happened

1. **Session accumulated 738 messages over ~6 hours** of back-and-forth on calibration work
2. **Two massive bash tool results** (78KB each) from debug/trace dumps polluted the context around 13:01-13:02
3. **Compression triggered late** — checkpoint created when context was already 270K+ tokens
4. **Checkpoint froze the bloated state** — every subsequent turn reused the same 270K checkpoint
5. **Agent lost coherence** — with 273K tokens (mostly cached), the agent can't track user intent and loops on the same task

### Why TOON Compression Didn't Help

**TOON compression is working correctly**. The problem is:

- Progressive compression triggered at **~80% of context window** (160K for 200K window)
- But by that point, the session had already bloated to **270K+ tokens**
- Checkpoint froze a **bloated state** that included:
  - 78KB bash outputs (debug dumps)
  - Hundreds of tool call sequences
  - Repetitive back-and-forth on calibration labeling
- **`compressionCacheHit: true`** means every turn **reuses** the frozen checkpoint instead of re-compressing
- The frozen checkpoint is **never refreshed**, so the bloat persists indefinitely

---

## Evidence

### Message Distribution

```
Role         Count    Total Size    Avg Size
────────────────────────────────────────────
user            50        8,468       169 bytes
assistant      350      692,658     1,979 bytes
toolResult     338      565,204     1,672 bytes
────────────────────────────────────────────
TOTAL          738    1,266,330 bytes
```

### Largest Tool Results

```
bash        78,795 bytes at 2026-05-30T13:02:39
bash        78,721 bytes at 2026-05-30T13:01:19
read        20,666 bytes at 2026-05-30T08:05:29
read        19,087 bytes at 2026-05-30T11:36:34
```

### Router State (Last Turn)

```json
{
  "reasoning": "Context usage (273278) exceeds threshold (150000). Forced high tier.",
  "compressionCacheHit": true,
  "usage": {
    "inputTokens": 1,
    "outputTokens": 381,
    "cacheReadTokens": 270535,
    "cacheWriteTokens": 2212,
    "cost": 0.1586225
  }
}
```

### Last User Messages (from tail -100)

```
2026-05-30T13:17:50  "what do I expect? run herdr new tab..."
2026-05-30T13:20:19  "yes run simulated"
2026-05-30T13:21:41  "ok C"
2026-05-30T13:27:29  "I put my label, check it"
2026-05-30T13:30:06  "ok do rule fix"
2026-05-30T13:33:13  "should we fix the prompt? ... Proceed to phase 4 adaptive mode"
2026-05-30T13:35:02  "Do B and A"
2026-05-30T13:37:32  "implement"
2026-05-30T13:39:17  "Lets do A"
```

Agent kept responding with:
```
"Here are the **9 unique disagreement cases** to label..."
"Let me show you the 9 unique disagreement cases inline..."
"You've labeled all 9. Let me compute the ground-truth scoreboard."
```

---

## Why AWS Bedrock Logs Were Unavailable

Attempted to check actual prompts sent to Bedrock via CloudWatch Logs:

```bash
aws logs tail /aws/bedrock/modelinvocations --since 6h --filter-pattern "019e77d8..."
# ERROR: ResourceNotFoundException — log group does not exist
```

**Model invocation logging is not enabled** for this AWS account. To enable:
1. Go to Bedrock console → Settings → Model invocation logging
2. Enable CloudWatch Logs with log group `/aws/bedrock/modelinvocations`
3. Optionally enable S3 logging for long-term retention

---

## Solutions

### Immediate (User Action)

**Start a fresh session** — this one is unsalvageable. The frozen checkpoint is too bloated to recover.

```bash
# User should start new session or manually prune
omp  # New session in same project
```

### Short-Term Fix (Code)

Add a **checkpoint expiry threshold** to force re-compression when context exceeds a hard limit even with a cached checkpoint:

```typescript
// In src/provider.ts, around line 567
if (state.currentCheckpoint) {
  const checkpointAge = turnNumber - state.currentCheckpoint.metadata.turn;
  const currentContextTokens = estimateContextTokens(effectiveContext);
  
  // Force refresh if:
  // 1. Checkpoint is >50 turns old, OR
  // 2. Current context exceeds 200K tokens despite checkpoint
  if (checkpointAge > 50 || currentContextTokens > 200_000) {
    // Invalidate checkpoint and force fresh compression
    state.currentCheckpoint = undefined;
    triggerReason = "checkpoint_expired";
    // Fall through to compression logic below
  } else {
    // Reuse checkpoint as before
    const keepLastN = compressionCfg.keepLastN ?? 4;
    const recentMessages = effectiveContext.messages.slice(-keepLastN);
    finalContext = { ...effectiveContext, messages: [...] };
    decision.compressionCacheHit = true;
  }
}
```

### Long-Term Improvements

1. **Checkpoint refresh strategy**
   - Track checkpoint age (turns since creation)
   - Automatically refresh if context grows beyond 150% of original checkpoint size
   - Add config: `progressive.maxCheckpointAge` (default 50 turns)

2. **Aggressive pruning for pathological cases**
   - Detect when toolResult messages exceed threshold (e.g. >20KB)
   - Summarize or truncate massive tool outputs before adding to history
   - Add config: `maxToolResultSize` (default 10KB)

3. **Session health metrics**
   - Track message count, context size, checkpoint age
   - Warn user when session approaches unmanageable size
   - Suggest fresh session or context reset

4. **Enable Bedrock logging**
   - Set up CloudWatch Logs for model invocations
   - Add to deployment docs / setup guide
   - Useful for debugging prompt construction issues

---

## Config Context

From `~/.omp/agent/model-router.json`:

```json
{
  "largeContextThreshold": 150000,  // Forced high tier at 150K tokens
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,      // Compress at 80% of context window
      "timeThreshold": 300           // 5 minutes
    },
    "excludeModels": ["kimi", "nova"]
  }
}
```

For Opus-4-7 with ~200K context window:
- Compression should trigger at **160K tokens** (0.8 × 200K)
- Session reached **273K tokens** — far beyond threshold
- But checkpoint was created **once** and reused forever

---

## Conclusion

**TOON compression is not broken** — it's working as designed. The issue is:

1. **Late trigger**: Compression triggered after session was already bloated
2. **Frozen bloat**: Checkpoint captured a pathological state (738 messages, 1.2MB)
3. **No expiry**: Checkpoint reused indefinitely without refresh, even as context grew
4. **Agent confusion**: 273K token context (99% cached) exceeded model's ability to track coherent conversation flow

**Immediate action**: User should start a fresh session.  
**Next sprint**: Implement checkpoint expiry/refresh logic to prevent frozen bloat.
