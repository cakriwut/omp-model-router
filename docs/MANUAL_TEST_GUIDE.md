# Manual Progressive Compression Test Guide

## Setup

1. **Ensure fix is deployed:**
   ```bash
   cd ~/workspace/omp-model-router
   bun run deploy:dev
   ```

2. **Start new OMP session:**
   ```bash
   omp  # from ~/workspace/omp-model-router directory
   ```

3. **Verify version and reload:**
   ```
   /reload
   /router
   ```
   Expected: `version: 0.5.0` or higher

4. **Enable debug mode:**
   ```
   /router set debug on
   ```

---

## Test Execution

### Test 1: First Message (No Compression)

**Action:** Send first user message
```
Hello, I'm testing progressive compression behavior
```

**Expected:**
- Response completes normally
- **NO compression triggered**

**Verify:**
```
/router usage
```

**Expected output:**
```
Compression: 0 requests compressed, 0 tokens saved (0% reduction)
```

---

### Test 2: Second Message (No Compression)

**Action:** Send second user message
```
Can you explain how the router decides compression triggers?
```

**Expected:**
- Response completes normally
- **NO compression triggered** (context still trivial)

**Verify:**
```
/router usage
```

**Expected output:**
```
Compression: 0 requests compressed, 0 tokens saved (0% reduction)
```

✅ **If unchanged:** PASS — fix is working (progressive mode active)
❌ **If compression count > 0:** FAIL — bug NOT fixed (unconditional compression still active)

---

### Test 3: Third Message (No Compression)

**Action:** Send third user message
```
What are the compression thresholds currently configured?
```

**Expected:**
- Response completes normally
- **NO compression triggered** (context < 160k tokens)

**Verify:**
```
/router usage
```

**Expected output:**
```
Compression: 0 requests compressed, 0 tokens saved (0% reduction)
```

---

### Test 4: Large Context Request (Compression May Trigger)

**Action:** Generate large context
```
Read all TypeScript files in src/ directory and summarize their purposes
```

**Expected:**
- Response includes file summaries
- **Compression may trigger IF context approaches 160k tokens** (0.8 * 200k)

**Verify:**
```
/router usage
```

**Expected output (if triggered):**
```
Compression: 1 request compressed, ~XX,XXX tokens saved (XX% reduction)
```

**Note:** Compression may or may not trigger depending on actual token count. The key is it should NOT have triggered in Tests 1-3.

---

## Success Criteria

| Test | Compression Count | Result |
|------|------------------|--------|
| Test 1 (1st message) | 0 | ✅ PASS |
| Test 2 (2nd message) | 0 | ✅ PASS |
| Test 3 (3rd message) | 0 | ✅ PASS |
| Test 4 (large context) | 0 or 1 | ✅ PASS (depends on size) |

**Overall verdict:**
- ✅ **PASS:** Compression count stays 0 through Tests 1-3
- ❌ **FAIL:** Compression triggered in Test 1 or Test 2 (unconditional compression bug persists)

---

## Capture Results

After each test, copy the `/router usage` output here:

### Test 1 Results
```
(paste /router usage output here)
```

### Test 2 Results
```
(paste /router usage output here)
```

### Test 3 Results
```
(paste /router usage output here)
```

### Test 4 Results
```
(paste /router usage output here)
```

---

## Debug Session Analysis

To analyze compression behavior post-test:

1. **Find your session jsonl:**
   ```bash
   ls -lat ~/.omp/agent/sessions/-workspace-omp-model-router/ | head -5
   ```

2. **Run analysis script:**
   ```bash
   bash scripts/test-progressive-compression.sh ~/.omp/agent/sessions/-workspace-omp-model-router/<SESSION_FILE>.jsonl
   ```

This will show:
- Compression timeline
- Trigger reasons
- Message count before first compression
- Test verdict (PASS/FAIL)

---

## Expected Behavior Summary

**Before fix:**
- Compression triggered on 2nd user message (unconditional mode)
- `compressionRequestCount` incremented immediately

**After fix:**
- Compression does NOT trigger until:
  - Context size ≥ 160,000 tokens, OR
  - Time gap ≥ 300 seconds (5 minutes)
- `compressionRequestCount` stays 0 for trivial conversations
