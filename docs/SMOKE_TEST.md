# Smoke Test Guide — Consolidation Pass

**Status:** Deployed to dev (`bun run deploy:dev` ✅)  
**Version:** v0.7.2  
**Date:** 2026-05-31

---

## Prerequisites

1. Deploy complete: ✅
   ```bash
   bun run deploy:dev
   # ✓ Symlinked workspace → extension node_modules
   # ✓ Created wrapper package.json and index.ts
   ```

2. In Oh-My-Pi, run:
   ```
   /reload
   ```

---

## Smoke Test Checklist

### 1. Basic Status Check

```
/router
```

**Expected:**
- Shows "Model Router Status"
- Version: v0.7.2
- Router enabled: yes/off
- Selected profile, pins, widget status
- Last decision details (if any routing happened)

**Verifies:** Extension loads, state.ts refactor preserved session state

---

### 2. Usage Report

```
/router usage
```

**Expected:**
- Model usage table (high/medium/low tiers)
- Session cost breakdown
- Per-model statistics (invocations, tokens, cache hits)
- Compression diagnostic (if enabled)

**Verifies:** ui.ts split preserved formatting, commands/usage.ts works

---

### 3. Profile Management

```
/router profile
```

**Expected (if interactive TUI available):**
- Shows list: "router/auto", "router/deep", etc.
- Options: "＋ Create new profile", "✎ Rename", "✕ Delete"

**Switch profile:**
```
/router profile hybrid
```

**Expected:**
- "Switched to router profile: hybrid"
- Status widget updates

**Verifies:** commands/profile.ts works, TUI integration intact

---

### 4. Tier Pinning

```
/router pin high
```

**Expected:**
- "Router profile [name] pinned to high"
- Status widget updates

**Clear pin:**
```
/router pin auto
```

**Expected:**
- "Router profile [name] pin cleared; heuristic routing restored"

**Verifies:** commands/pin.ts works, state persistence works

---

### 5. Configuration Updates

```
/router set debug on
```

**Expected:**
- Config file patched
- Debug mode enabled

```
/router set compression on
```

**Expected:**
- Compression enabled in config

**Verifies:** commands/set.ts works, config updates preserved

---

### 6. Widget Toggle

```
/router widget on
```

**Expected:**
- Status widget appears in UI
- "Router widget enabled"

```
/router widget off
```

**Expected:**
- Widget disappears

**Verifies:** commands/widget.ts works, ui/status.ts renders correctly

---

### 7. Routing Decision (End-to-End)

Send a simple prompt:
```
How do I list files in Linux?
```

**Expected:**
- Router makes tier decision (likely "low" for simple question)
- Response comes from appropriate tier model
- Status widget shows last decision
- Debug history updated (if debug=on)

**Verifies:**
- routing/* modules work (text.ts, heuristic.ts, compose.ts)
- provider.ts calls routing correctly
- compression decision logic works (context-compression.ts)
- state.ts tracks decision correctly

---

### 8. Compression Trigger (if enabled)

If compression is enabled, send several long prompts to trigger 80% context threshold.

**Expected:**
- Compression kicks in at 80% context OR 5min idle
- `/router usage` shows compression stats

**Verifies:** Task 2.4 (move compression decision) preserved behavior

---

## Results

| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| 1. `/router` status | Displays v0.7.2 | | ⏳ |
| 2. `/router usage` | Shows model usage | | ⏳ |
| 3. `/router profile hybrid` | Switches profile | | ⏳ |
| 4. `/router pin high` | Pins tier | | ⏳ |
| 5. `/router set debug on` | Enables debug | | ⏳ |
| 6. `/router widget on` | Shows widget | | ⏳ |
| 7. Routing decision | Routes prompt correctly | | ⏳ |
| 8. Compression trigger | Compresses at threshold | | ⏳ |

---

## Known Issues (Pre-Refactor)

None expected. All 367 tests pass, behavior preserved.

If any test fails:
1. Check console for errors
2. Check `~/.omp/agent/extensions/model-router/index.ts` exists
3. Verify symlink: `ls -la ~/.omp/agent/extensions/model-router/node_modules/@cakriwut`
4. Re-run: `/reload`

---

## Post-Test: Graph Re-Analysis

After smoke test passes, run:

```bash
cd ~/workspace/omp-model-router
/graphify . --update
```

**Expected metrics (from GRAPH_REPORT.md):**
- Betweenness centrality: all files < 0.05 (was 0.120 for commands.ts)
- Zero duplicate function names in "DRY violations" section
- God nodes unchanged: RouterState (30 edges), decideRouting (13 edges)

---

## Completion Criteria

✅ All 8 smoke tests pass  
✅ No console errors  
✅ Graph re-analysis shows improved metrics  
✅ Manual verification: behavior identical to pre-refactor

---

## Rollback (if needed)

```bash
cd ~/workspace/omp-model-router
git log --oneline -12  # Find commit before cd0b437
git reset --hard <hash-before-refactor>
bun run deploy:dev
# In OMP: /reload
```

All 12 refactor commits can be reverted atomically.
