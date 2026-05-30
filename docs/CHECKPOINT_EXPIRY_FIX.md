# Checkpoint Expiry Fix

**Date**: 2026-05-30  
**Issue**: Sessions with frozen compression checkpoints could accumulate bloat indefinitely, leading to agent loops and coherence loss.

---

## Problem

Progressive TOON compression creates a **frozen checkpoint** when triggered, then reuses it across subsequent turns to maximize cache hit rate. But if the checkpoint was created when the context was already bloated, it stays bloated forever:

1. Session accumulates 738 messages over 6 hours
2. Context reaches 270K tokens (massive bash tool outputs, repetitive back-and-forth)
3. Compression triggers late, creates checkpoint from bloated state
4. Checkpoint is reused every turn (`compressionCacheHit: true`)
5. **No refresh mechanism** — checkpoint never expires, bloat persists indefinitely
6. Agent loses coherence, starts looping on same task

---

## Solution: Checkpoint Expiry

Added two expiry conditions to force checkpoint refresh:

### 1. Age Limit

If checkpoint is older than `maxCheckpointAge` turns (default 50), force refresh:

```typescript
const checkpointAge = turnNumber - state.currentCheckpoint.metadata.turn;
const isStale = checkpointAge > (config.progressive.maxCheckpointAge ?? 50);
```

### 2. Size Limit

If current context exceeds `maxCheckpointSize` tokens (default 200K), force refresh:

```typescript
const currentContextTokens = estimateContextTokens(effectiveContext);
const isOversized = currentContextTokens > (config.progressive.maxCheckpointSize ?? 200_000);
```

### Refresh Logic

When either condition triggers:

1. Invalidate checkpoint: `state.currentCheckpoint = undefined`
2. Force fresh compression
3. Create new checkpoint from current context
4. Log expiry reason (age or size) if debug enabled

```typescript
if (isStale || isOversized) {
  if (state.currentConfig.debug) {
    console.log('[ROUTER] Checkpoint expired:', {
      reason: isStale ? 'age' : 'size',
      age: checkpointAge,
      ageLimit: checkpointAgeLimit,
      contextTokens: currentContextTokens,
      sizeLimit: checkpointSizeLimit,
    });
  }
  
  state.currentCheckpoint = undefined;
  
  // Force compression with fresh context
  const result = compressHistory(effectiveContext, compressionCfg, turnNumber);
  // ... create new checkpoint
}
```

---

## Configuration

New fields in `historyCompression.progressive`:

```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,
      "timeThreshold": 300,
      "maxCheckpointAge": 50,        // NEW: refresh after 50 turns
      "maxCheckpointSize": 200000    // NEW: refresh if context > 200K tokens
    },
    "excludeModels": ["kimi", "nova"]
  }
}
```

### Defaults

- `maxCheckpointAge`: 50 turns
- `maxCheckpointSize`: 200,000 tokens

Both use `??` fallback, so missing values use defaults.

---

## Impact

### Before

- Checkpoint created at turn 100 with 270K tokens
- Reused at turns 101, 102, 103, ..., 738
- Context stays bloated forever
- Agent loops after ~400 messages

### After

- Checkpoint created at turn 100 with 270K tokens
- **Expired at turn 150** (age limit) or immediately (size limit)
- Fresh compression at turn 150 with current context
- New checkpoint created, bloat purged
- Agent maintains coherence

---

## Testing

Added `test/checkpoint-expiry.test.ts`:

```bash
bun test test/checkpoint-expiry.test.ts
# 5 pass, 0 fail
```

### Test Coverage

1. ✅ Refresh when age exceeds `maxCheckpointAge`
2. ✅ Refresh when context size exceeds `maxCheckpointSize`
3. ✅ No refresh when age and size are within limits
4. ✅ Graceful handling when no checkpoint exists
5. ✅ Default values when progressive config is missing

---

## Migration

### Existing Sessions

Sessions with frozen bloated checkpoints will auto-refresh on next turn **if**:

- Checkpoint is >50 turns old (default), OR
- Context exceeds 200K tokens (default)

No manual intervention required — fix is automatic on next model call.

### Config Migration

Existing configs without `maxCheckpointAge` / `maxCheckpointSize` will use defaults:

```typescript
const checkpointAgeLimit = compressionCfg.progressive.maxCheckpointAge ?? 50;
const checkpointSizeLimit = compressionCfg.progressive.maxCheckpointSize ?? 200_000;
```

No breaking changes — fully backward compatible.

---

## Related Files

- `src/provider.ts`: Checkpoint expiry logic (lines 567-650)
- `src/types.ts`: New config fields in `HistoryCompressionConfig`
- `model-router.example.json`: Updated example config
- `test/checkpoint-expiry.test.ts`: Test coverage
- `docs/SESSION_LOOP_INVESTIGATION.md`: Root cause analysis

---

## Next Steps

1. ✅ Implement checkpoint expiry logic
2. ✅ Add config fields and defaults
3. ✅ Write tests
4. ✅ Update example config
5. ⬜ Deploy to dev
6. ⬜ Monitor session health metrics
7. ⬜ Consider adding `/router reset-checkpoint` command for manual refresh

---

## Deployment

```bash
bun run deploy:dev
# Copy to ~/.omp/agent/extensions/model-router
# Reload OMP: /reload
```

Check logs for expiry events:

```bash
tail -f ~/.omp/agent/logs/*.log | grep "Checkpoint expired"
```
