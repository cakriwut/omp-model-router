# Debug Log Management Proposal

## Problem

When `debug: true` is enabled, the router generates persistent debug logs that can consume significant disk space:

1. **Session JSONL logs** — `router:compression-trigger` custom entries written unconditionally
2. **Persisted state file** — Full `debugHistory` (12 routing decisions) with all metadata saved to `~/.omp/agent/model-router/router-state.json` on every state change
3. **No automatic cleanup** — Logs accumulate indefinitely

## Current Behavior

| Component | Storage Location | Current Limit | Impact |
|-----------|-----------------|---------------|--------|
| `debugHistory` | In-memory + persisted state file | 12 entries (MAX_DEBUG_HISTORY) | ~50KB per persist |
| Compression trigger logs | Session JSONL (`router:compression-trigger`) | Unlimited | ~500B per trigger |
| Persisted state | `~/.omp/agent/model-router/router-state.json` | No rotation | Grows with each `persist()` call |

## Proposed Solutions

### 1. Conditional Session Logging (Quick Win)

**Change:** Only write `router:compression-trigger` entries when explicitly requested.

**Implementation:**
```typescript
// src/types.ts
export interface RouterConfig {
  debug?: boolean;
  debugVerbose?: boolean; // NEW: opt-in for session JSONL logging
  ...
}

// src/provider.ts
if (state.currentConfig.debug && triggerReason) {
  const compressionDebugData = { ... };
  
  // Always log to console for real-time visibility
  console.log('[ROUTER] Compression triggered:', compressionDebugData);
  
  // Only persist to session if debugVerbose is true
  if (state.currentConfig.debugVerbose) {
    ctx.sessionManager.appendCustomEntry('router:compression-trigger', compressionDebugData);
  }
}
```

**Impact:**
- ✅ Reduces session JSONL growth by ~500B per compression trigger
- ✅ No breaking changes (defaults to console-only)
- ✅ Users can opt-in with `/router set debugVerbose true`

---

### 2. Configurable Debug History Limit

**Change:** Allow users to configure `MAX_DEBUG_HISTORY` size.

**Implementation:**
```typescript
// src/types.ts
export interface RouterConfig {
  debug?: boolean;
  debugHistoryLimit?: number; // Default: 12
  ...
}

// src/state.ts
recordDecision(decision: RoutingDecision): void {
  const limit = this.currentConfig.debugHistoryLimit ?? MAX_DEBUG_HISTORY;
  this.debugHistory = [...this.debugHistory, decision].slice(-limit);
}
```

**Impact:**
- ✅ Users can reduce memory footprint with `/router set debugHistoryLimit 5`
- ✅ Or increase for deeper investigation `/router set debugHistoryLimit 50`

---

### 3. State File Rotation (Medium Effort)

**Change:** Rotate persisted state file when it exceeds size threshold.

**Implementation:**
```typescript
// src/state.ts
const STATE_FILE = () => {
  const dir = join(getAgentDir(), "model-router");
  return join(dir, "router-state.json");
};

const STATE_FILE_MAX_SIZE = 1024 * 1024; // 1MB

const savePersistentState = (state: RouterPersistedState): void => {
  const filePath = STATE_FILE();
  const dir = dirname(filePath);
  ensureStateDir();
  
  // Check file size before write
  if (existsSync(filePath)) {
    const stats = statSync(filePath);
    if (stats.size > STATE_FILE_MAX_SIZE) {
      // Rotate: router-state.json → router-state.1.json
      const backup = filePath.replace('.json', '.1.json');
      if (existsSync(backup)) unlinkSync(backup);
      renameSync(filePath, backup);
    }
  }
  
  writeFileSync(filePath, JSON.stringify(state, null, 2));
};
```

**Impact:**
- ✅ Prevents unbounded growth of state file
- ✅ Keeps one backup for recovery
- ⚠️  Loses old state when rotated (acceptable for debug data)

---

### 4. Trim Debug Decisions Before Persist

**Change:** Strip verbose fields from `debugHistory` before persisting.

**Implementation:**
```typescript
// src/state.ts
private buildPersistedState(): RouterPersistedState {
  // Trim debugHistory to save space
  const trimmedDebugHistory = this.debugHistory.map(d => ({
    tier: d.tier,
    phase: d.phase,
    targetLabel: d.targetLabel,
    reasoning: d.reasoning.slice(0, 100), // Truncate long reasoning
    timestamp: d.timestamp,
    // Omit: usage, compression (verbose)
  }));
  
  return {
    ...
    debugHistory: trimmedDebugHistory,
    ...
  };
}
```

**Impact:**
- ✅ Reduces persisted state size by ~70%
- ⚠️  Loses detailed metrics (acceptable for long-term storage)
- ✅ Full data still available in session JSONL

---

### 5. TTL-Based Cleanup (Advanced)

**Change:** Add TTL to debug entries and auto-purge on session load.

**Implementation:**
```typescript
// src/types.ts
export interface RouterConfig {
  debugTTL?: number; // Hours; default: 168 (7 days)
  ...
}

// src/state.ts
restoreFromSession(ctx: ExtensionContext): void {
  ...
  if (isRouterPersistedState(savedState)) {
    // Purge old debug entries
    const ttlMs = (this.currentConfig.debugTTL ?? 168) * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    
    this.debugHistory = (savedState.debugHistory ?? [])
      .filter(d => d.timestamp > cutoff)
      .slice(-MAX_DEBUG_HISTORY);
  }
}
```

**Impact:**
- ✅ Auto-cleanup without manual intervention
- ✅ Configurable retention period
- ✅ Reduces state file size over time

---

## Recommended Implementation Plan

**Phase 1: Quick Wins** (1-2 hours)
1. ✅ Add `debugVerbose` flag (defaults to `false`)
2. ✅ Make session JSONL logging opt-in
3. ✅ Add `debugHistoryLimit` config option

**Phase 2: Medium Effort** (2-3 hours)
4. ✅ Implement state file rotation (1MB threshold)
5. ✅ Trim verbose fields before persist

**Phase 3: Advanced** (optional, 3-4 hours)
6. ⚠️  Add TTL-based cleanup
7. ⚠️  Add `/router debug clean` command for manual purge

---

## Configuration Example

```json
{
  "debug": true,
  "debugVerbose": false,
  "debugHistoryLimit": 12,
  "debugTTL": 168,
  "historyCompression": {
    "enabled": true,
    ...
  }
}
```

**User commands:**
```bash
/router set debug on              # Enable console logging only
/router set debugVerbose on       # Also write to session JSONL
/router set debugHistoryLimit 5   # Keep only 5 recent decisions
/router debug clear               # Manual purge of debugHistory
```

---

## Disk Space Impact Analysis

**Before** (debug: true, 100 routing decisions, 20 compression triggers):
- Session JSONL: ~10KB (compression triggers)
- State file: ~200KB (12 full decisions with usage/compression stats)
- **Total: ~210KB per long session**

**After Phase 1** (debugVerbose: false):
- Session JSONL: ~0B (no compression trigger logs)
- State file: ~200KB (unchanged)
- **Total: ~200KB per long session**

**After Phase 2** (state rotation + trim):
- Session JSONL: ~0B
- State file: ~50KB (trimmed decisions) + ~50KB backup = 100KB
- **Total: ~100KB per long session**

**Savings: ~52% disk space reduction**
