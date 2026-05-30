# Session Restore Compression Bug Fix

**Date**: 2026-05-30  
**Severity**: High (affects all sessions)  
**Status**: Fixed

## Problem

Progressive TOON compression was triggering **immediately on every new session start** instead of waiting for the configured triggers (context size 80% or time threshold 5 min).

### Symptoms

- User observed TOON compression activating within 3 turns (user/ai/user/ai/user/ai)
- TUI stats showed 4.3% context usage (far below 80% trigger threshold)
- `/router usage` showed 5 compression requests despite minimal context
- Logs confirmed compression triggered on "cache_expiry" reason immediately

## Root Cause

The `RouterState` class was **not persisting progressive TOON state** across session restarts:

1. **Fields existed** in the class (lines 108-120 in `src/state.ts`):
   - `compressionRequestCount`
   - `compressionTotalOriginalChars`
   - `compressionTotalCompressedChars`
   - `currentCheckpoint`
   - `lastTurnTimestamp`

2. **But were NOT persisted** — `buildPersistedState()` didn't include them

3. **AND reset on every session start** — `restoreFromSession()` reset all accumulators, including setting `lastTurnTimestamp = undefined`

4. **Trigger logic misfire** — `shouldTriggerCompression()` (provider.ts:264-280) checks:
   ```typescript
   if (lastTurnTimestamp === undefined) {
       return "cache_expiry"; // 🔴 Always triggers on new session!
   }
   ```

## Fix

### 1. Updated `RouterPersistedState` interface (types.ts)

Added compression fields:
```typescript
export interface RouterPersistedState {
    // ... existing fields ...
    
    // ─── Progressive TOON state ───────────────────────────────────────
    compressionRequestCount?: number;
    compressionTotalOriginalChars?: number;
    compressionTotalCompressedChars?: number;
    currentCheckpoint?: CompressionCheckpoint;
    lastTurnTimestamp?: number;
}
```

### 2. Persist compression state (state.ts)

Updated `buildPersistedState()` to include compression fields:
```typescript
private buildPersistedState(): RouterPersistedState {
    return {
        // ... existing fields ...
        
        // ─── Progressive TOON state ───────────────────────────────────
        compressionRequestCount: this.compressionRequestCount,
        compressionTotalOriginalChars: this.compressionTotalOriginalChars,
        compressionTotalCompressedChars: this.compressionTotalCompressedChars,
        currentCheckpoint: this.currentCheckpoint,
        lastTurnTimestamp: this.lastTurnTimestamp,
    };
}
```

### 3. Initialize `lastTurnTimestamp` on session start (state.ts)

When creating a new session (no saved state), initialize to `Date.now()` to prevent immediate cache_expiry trigger:
```typescript
restoreFromSession(ctx: ExtensionContext): void {
    // ... reset session-scoped state ...
    
    // Progressive TOON: initialize lastTurnTimestamp to now to prevent immediate cache_expiry trigger
    this.compressionRequestCount = 0;
    this.compressionTotalOriginalChars = 0;
    this.compressionTotalCompressedChars = 0;
    this.currentCheckpoint = undefined;
    this.lastTurnTimestamp = Date.now(); // 🟢 Prevents immediate trigger
    
    // ... restore from saved state if available ...
}
```

### 4. Restore compression state from saved session (state.ts)

When resuming a session, restore compression fields:
```typescript
if (isRouterPersistedState(savedState)) {
    // ... restore other fields ...
    
    // ─── Restore progressive TOON state ────────────────────────────────
    if (savedState.compressionRequestCount !== undefined) {
        this.compressionRequestCount = savedState.compressionRequestCount;
    }
    if (savedState.compressionTotalOriginalChars !== undefined) {
        this.compressionTotalOriginalChars = savedState.compressionTotalOriginalChars;
    }
    if (savedState.compressionTotalCompressedChars !== undefined) {
        this.compressionTotalCompressedChars = savedState.compressionTotalCompressedChars;
    }
    if (savedState.currentCheckpoint) {
        this.currentCheckpoint = savedState.currentCheckpoint;
    }
    if (savedState.lastTurnTimestamp !== undefined) {
        this.lastTurnTimestamp = savedState.lastTurnTimestamp;
    }
}
```

## Tests Added

Created `test/session-restore-compression.test.ts` with 3 test cases:

1. **New session initializes `lastTurnTimestamp`** — Verifies fresh sessions set `lastTurnTimestamp = Date.now()` to prevent immediate trigger
2. **Persisted state is restored** — Verifies compression state (request count, checkpoint, timestamp) persists across session reloads
3. **State reset when no saved state** — Verifies fresh sessions start with clean compression state

All 267 tests pass, including:
- `test/early-compression-bug.test.ts` (written during diagnosis)
- `test/toon-trigger-integration.test.ts`
- `test/compression-trigger.test.ts`
- `test/session-restore-compression.test.ts` (new)

## Expected Behavior After Fix

✅ **New sessions**:
- `lastTurnTimestamp = Date.now()` (current time)
- Compression waits for real triggers (80% context OR 5 min idle)

✅ **Resumed sessions**:
- `lastTurnTimestamp`, `currentCheckpoint`, `compressionRequestCount` restored from disk
- Compression continues from prior checkpoint

✅ **Trigger logic**:
- Context size: triggers when `estimateContextTokens(context) >= 0.8 * contextWindow`
- Cache expiry: triggers when `Date.now() - lastTurnTimestamp >= 300_000` (5 min)
- First few turns in a session: **no trigger** (lastTurnTimestamp is recent)

## Related Files

- `src/types.ts` — Added compression fields to `RouterPersistedState`
- `src/state.ts` — Fixed `buildPersistedState()`, `restoreFromSession()`
- `src/provider.ts` — No changes (trigger logic was correct)
- `test/session-restore-compression.test.ts` — New test coverage
- `test/early-compression-bug.test.ts` — Diagnostic test (kept for regression)

## Migration

No migration needed — old state files without compression fields will:
1. Restore existing fields successfully
2. Initialize compression fields to defaults (as if fresh session)
3. Begin tracking compression state correctly from that point forward
