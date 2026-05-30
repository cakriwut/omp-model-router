# Session Metrics Display Fix

**Issue**: On fresh sessions, `/router usage` displayed misleading metrics:
- "Savings ~222.0k tokens from TOON compression" when no compression had occurred yet
- "Cache 📦7961.8k tokens read from cache" on the very first turn

**Root Cause**: `restoreFromSession()` in `src/state.ts` was loading accumulated metrics (cost, tokens saved, cache reads) from the previous session's persisted state file (`~/.omp/agent/model-router/router-state.json`). These metrics carried over even though they weren't relevant to the new session.

**Fix**: 
1. Removed lines 253-257 from `src/state.ts` that restored accumulated metrics from persisted state
2. Added explanatory comment that these metrics are session-scoped and intentionally NOT restored
3. Metrics now always start at 0 for each new session

**Behavior**:
- `accumulatedCost`, `accumulatedOriginalTokens`, `accumulatedCompressedTokens`, `accumulatedTokensSaved`, `accumulatedCacheReadTokens` now reset to 0 on every new session
- Other session preferences (pins, thinking overrides, widget state, debug history) continue to be restored normally
- Display shows "Savings ~0k" and "Cache 📦0k" until actual compression/cache events occur

**Test Coverage**: `test/session-metrics-reset.test.ts`
- Verifies metrics reset to 0 even when state had non-zero values
- Verifies metrics remain 0 when persisted state or session entries contain non-zero values
- Verifies other session preferences are still restored correctly

**Files Changed**:
- `src/state.ts` - removed accumulated metrics restoration
- `test/session-metrics-reset.test.ts` - new test coverage

**Verification**:
```bash
bun test test/session-metrics-reset.test.ts
bun test  # all tests pass
```

## Before/After

**Before** (fresh session with persisted state from previous session):
```
TOON    enabled — progressive mode (no triggers yet)
  Savings ~222.0k tokens from TOON compression  ❌ Misleading
  Cache 📦7961.8k tokens read from cache        ❌ Misleading
```

**After** (fresh session):
```
TOON    enabled — progressive mode (no triggers yet)
  (no metrics displayed until actual compression occurs)  ✅ Accurate
```
