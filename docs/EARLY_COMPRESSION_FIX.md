# Early Compression Bug Fix

**Date**: 2026-05-30  
**Status**: ✅ Fixed

## Problem

User reported that TOON compression triggered after just 2 turns (4 messages), even though progressive compression should wait until context reaches 80% of the limit OR 5 minutes idle time.

### Observed Behavior
```
# After turn 2:
TOON    1 requests compressed | ↓-39% smaller | est. ~-0.0k tokens saved
```

### Expected Behavior
With `keepLastN=4` and progressive thresholds:
- Compression should NOT trigger until context ≥80% of model limit OR 5min idle
- At turn 2 (4 messages), context is typically <10% of limit → no compression

## Root Cause

**`FALLBACK_CONFIG` was missing the `historyCompression` field entirely.**

### Pre-Fix Config
```typescript
export const FALLBACK_CONFIG: RouterConfig = {
  defaultProfile: "auto",
  debug: false,
  profiles: { /* ... */ },
  // ❌ No historyCompression field
};
```

### Impact
1. When no user config file exists, `compressionCfg` becomes `undefined`
2. Code path at `provider.ts:575-592` activates (eager mode)
3. **Unconditional compression** runs every turn once `messages.length > keepLastN`
4. With implicit `keepLastN=4`, compression triggers at message 5 (turn 3)
5. **But** if user had `keepLastN=1` in their config, compression would trigger at turn 2

### Why Progressive Mode Didn't Activate
```typescript
// provider.ts:482-513
if (compressionCfg.progressive?.enabled) {
  // ✅ Guarded compression with thresholds
  const triggerReason = shouldTriggerCompression(...);
  if (triggerReason) {
    compressHistory(...);
  }
} else {
  // ❌ Eager mode: compress unconditionally
  compressHistory(...);
}
```

Without `historyCompression.progressive.enabled`, the else branch runs, bypassing all threshold checks.

## Fix

### Updated `FALLBACK_CONFIG`
```typescript
export const FALLBACK_CONFIG: RouterConfig = {
  defaultProfile: "auto",
  debug: false,
  profiles: { /* ... */ },
  historyCompression: {
    enabled: true,
    keepLastN: 4,
    progressive: {
      enabled: true,
      contextThreshold: 0.8,  // 80% of context window
      timeThreshold: 300,     // 5 minutes
    },
  },
};
```

### Changed Files
- `src/config.ts` — Added default `historyCompression` with progressive mode
- `test/early-compression-bug.test.ts` — Regression test

### Verification
```bash
bun test test/early-compression-bug.test.ts
# ✅ 3 pass, 0 fail
```

## Testing

### Repro Steps (Before Fix)
1. Start new session with no `~/.omp/agent/model-router.json`
2. User: "hi"
3. Assistant: responds
4. User: "what can we do now?"
5. Assistant: responds
6. `/router usage`
7. **Bug**: Shows "1 requests compressed"

### Validation (After Fix)
1. Same steps 1-6
2. **Expected**: Shows "0 requests compressed" (context is only ~5k tokens of ~128k limit)
3. Continue conversation until context reaches 102k tokens (80% of 128k)
4. **Expected**: Compression triggers at next turn

## Related Work

- `docs/COMPRESSION_TRIGGER_FIX.md` — Separate issue about token estimation accuracy
- `test/compression-trigger.test.ts` — Integration test for progressive triggers
- `test/toon-history-exclusion.test.ts` — Test for model exclusion rules

## Notes

**Why `keepLastN=4` is safe:**  
With Claude Sonnet 4.5's 128k context window, keeping 4 messages uncompressed uses <1% of context even with large responses. Progressive thresholds ensure compression only fires when actually needed.

**Backward compatibility:**  
Users with existing config files that explicitly set `historyCompression.enabled: false` will still have compression disabled. Only users with no config (or no `historyCompression` section) get the new progressive defaults.
