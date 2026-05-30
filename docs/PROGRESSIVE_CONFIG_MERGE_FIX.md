# Progressive Config Merge Fix

**Issue:** TOON compression triggered unconditionally on second user message despite `progressive.enabled: true` in config.

**Root cause:** `resolveCompressionConfig()` did NOT merge the `progressive` field from `globalConfig` / `profileConfig`, causing `provider.ts` routing logic to fall through to backward-compatible unconditional compression mode.

## Timeline

User session `2026-05-30T06:29:56.596Z`:

| Row | Timestamp | Event | Details |
|-----|-----------|-------|---------|
| 5 | 06:29:57.358 | router-state init | `crc=0`, `lastTurnTimestamp=2026-05-30T06:29:57.356Z` |
| 6 | 06:30:08.358 | user message #1 | "I am checking the toon compression, nothing todo" |
| 8 | 06:30:14.451 | assistant response | `usage={input:10, output:442}` |
| 12 | 06:31:05.258 | user message #2 | "so, this is second message..." |
| 13 | 06:31:11.034 | **compression triggered** | `crc=1`, `compressedMessages=1`, `estimatedOriginalTokens=1428` |

**Context at trigger:**
- 5 messages (1 user → 1 asst + toolResult + asst → 1 user)
- Estimated tokens: **1,428** (far below threshold `0.8 * 200k = 160,000`)
- Time gap: **64 seconds** (below threshold `300s`)

## Investigation

User config (`~/.omp/agent/model-router.json`):

```json
"historyCompression": {
  "enabled": true,
  "keepLastN": 4,
  "progressive": {
    "enabled": true,
    "contextThreshold": 0.8,
    "timeThreshold": 300
  }
}
```

But `resolveCompressionConfig` returned:

```typescript
{
  enabled: true,
  keepLastN: 4,
  excludeModels: undefined,
  // ❌ progressive: undefined
}
```

**Provider.ts logic** (lines 480-575):

```typescript
if (compressionCfg?.enabled && !isModelExcludedFromCompression(...)) {
  if (compressionCfg.progressive?.enabled) {
    // Progressive mode: compress only on triggers
    const triggerReason = shouldTriggerCompression(...);
    if (triggerReason) { /* compress */ }
  } else {
    // ❌ Backward-compatible mode: compress EVERY turn
    const result = compressHistory(effectiveContext, compressionCfg, turnNumber);
  }
}
```

Without `progressive` field merged, code fell through to unconditional compression.

## Fix

**File:** `src/context-compression.ts:264`

**Before:**

```typescript
export function resolveCompressionConfig(
  globalConfig?: HistoryCompressionConfig,
  profileConfig?: HistoryCompressionConfig,
): HistoryCompressionConfig | undefined {
  ...
  return {
    enabled: override.enabled ?? base.enabled,
    keepLastN: override.keepLastN ?? base.keepLastN ?? 4,
    excludeModels: override.excludeModels ?? base.excludeModels,
    // ❌ progressive field missing
  };
}
```

**After:**

```typescript
return {
  enabled: override.enabled ?? base.enabled,
  keepLastN: override.keepLastN ?? base.keepLastN ?? 4,
  excludeModels: override.excludeModels ?? base.excludeModels,
  progressive: override.progressive ?? base.progressive, // ✅ merged
};
```

## Verification

**Test:** `test/progressive-config-merge.test.ts`

- ✅ Merges `progressive` from globalConfig when profileConfig has none
- ✅ Merges `progressive` from profileConfig when globalConfig has none
- ✅ Prefers profileConfig `progressive` over globalConfig
- ✅ Handles undefined `progressive` gracefully
- ✅ Prevents unconditional compression when `progressive.enabled: true`

## Impact

**Before fix:** Compression triggered on **every request** after keepLastN threshold, regardless of context size or time gap.

**After fix:** Compression triggers **only when**:
1. Context size ≥ `contextThreshold * contextWindow`, OR
2. Time since last turn ≥ `timeThreshold`

**User sessions with `progressive.enabled: true` now behave correctly.**

## Related

- Compression trigger logic: `src/provider.ts:264-295`
- Progressive mode implementation: `src/provider.ts:480-575`
- TOON history compression: `src/context-compression.ts`
