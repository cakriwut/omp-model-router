# Session-Scoped Metrics Fix

## Problem

When starting a new session, `/router usage` displayed accumulated savings and cache statistics from **previous sessions**, even though the current session hadn't performed any TOON compression yet.

Example symptom:
```
Savings ~12314.5k tokens from TOON compression
Cache 📦5198.2k tokens read from cache
```

But the TOON section showed:
```
TOON: no compressions yet
```

## Root Cause

The router state persists certain values to disk between sessions (user preferences like pinned tiers, widget state, etc.). However, it was **also persisting** session-scoped metrics:

- `accumulatedCost`
- `accumulatedOriginalTokens`
- `accumulatedCompressedTokens`
- `accumulatedTokensSaved`
- `accumulatedCacheReadTokens`

When a new session started, `restoreFromSession()` would:
1. **Reset** these values to 0 (lines 201-205 in `state.ts`)
2. **Immediately overwrite** them with persisted values from disk (lines 248-252)

This meant the "reset" was ineffective — accumulated values carried over from previous sessions.

## Solution

Changed the behavior so accumulated metrics are **truly session-scoped**:

1. **Removed** lines 248-252 that restored accumulated values from persisted state
2. **Removed** lines 264-268 that persisted accumulated values to disk
3. **Removed** corresponding fields from `RouterPersistedState` type definition

Now when a new session starts:
- Accumulated metrics are reset to 0
- They are NOT restored from previous sessions
- They reflect only the current session's activity

User preferences (pins, thinking overrides, widget state, debug history) continue to persist across sessions as expected.

## Files Changed

- `src/state.ts`: Removed restore + persist logic for accumulated metrics
- `src/types.ts`: Removed accumulated fields from `RouterPersistedState`
- `test/session-scoped-metrics.test.ts`: Added regression test

## Verification

```bash
bun test test/session-scoped-metrics.test.ts
```

The test verifies:
1. Accumulated values are NOT restored from persisted state (remain at 0)
2. User preferences ARE restored from persisted state (as intended)
