# Compression Trigger Behavior

## Question from User

> "check in debug, when compression kick in and is it correct? currently we configure progressive"

## Answer

✅ **The compression trigger logic is correct**.

Your configuration (`~/.omp/agent/model-router.json`) has:
```json
{
  "debug": true,
  "historyCompression": {
    "enabled": true,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,
      "timeThreshold": 300
    }
  }
}
```

## How Progressive Compression Works

Progressive mode compresses history **only when triggers fire**:

### Trigger 1: Context Size
- **Fires when**: `contextTokens >= 0.8 * modelContextWindow`
- **Example**: For a model with 200k context window, triggers at ~160k tokens

### Trigger 2: Cache Expiry
- **Fires when**: Time since last turn >= 300 seconds (5 minutes)
- **Purpose**: Prevents cache expiry by compressing before the 5-minute prompt cache TTL expires

## Debug Logging

When `debug: true` and a trigger fires, you'll see:

```
[ROUTER] Compression triggered: {
  reason: 'context-size' | 'cache-expiry',
  contextTokens: 165432,
  threshold: 160000,
  timeSinceLastTurn: 287,
  timeThreshold: 300,
  turnNumber: 42,
  messageCount: 84
}
```

**Note**: These logs appear in **stdout**, not in OMP session JSONL files.

## When Compression Actually Runs

Even when a trigger fires, compression may **not** execute if:

1. **History too short**: `messages.length <= keepLastN` (default 4)
2. **Safe split leaves nothing**: Cannot find a safe cutoff point
3. **Past freeze point**: Reuses existing frozen checkpoint instead

When compression succeeds:
- `result.stats` is populated
- `accumulatedTokensSaved` increments
- A checkpoint is created (and frozen at turn 5 if configured)

## Verification

To verify compression is working:

1. **Enable debug**: `"debug": true` in config
2. **Watch for logs**: `[ROUTER] Compression triggered:`
3. **Check `/router usage`**: Shows TOON compression stats
4. **Important**: Logs appear in **stdout** (where OMP process runs), not in session files

## Related Issues Fixed

This investigation led to fixing the **session-scoped metrics bug** (see `SESSION_SCOPED_METRICS_FIX.md`), where `/router usage` was showing accumulated savings from **previous sessions** instead of just the current session.
