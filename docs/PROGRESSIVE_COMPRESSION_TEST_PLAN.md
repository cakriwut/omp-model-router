# Progressive Compression Test Plan

**Objective:** Verify TOON progressive compression triggers ONLY when thresholds are met, not unconditionally.

**Config under test:**
```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,
      "timeThreshold": 300
    }
  }
}
```

**Test conditions:**
- Model: Claude Sonnet 4.5 (context window 200k)
- Compression threshold: 0.8 * 200k = **160,000 tokens**
- Cache expiry: **300 seconds (5 minutes)**

---

## Test 1: No compression on initial messages

**Scenario:** Send 3 short messages (trivial context)

**Expected behavior:**
- ✅ No compression triggered (context << 160k, time gap << 5min)
- ✅ `/router usage` shows: `Compression: 0 requests compressed`

**Test steps:**
1. Start fresh OMP session
2. User: "Hello, test message 1"
3. Wait for response
4. User: "Test message 2"
5. Wait for response
6. User: "/router usage"

**Expected `/router usage` output:**
```
Compression: 0 requests compressed, 0 tokens saved (0% reduction)
```

---

## Test 2: No compression on moderate context

**Scenario:** Build context with ~10k tokens (still below threshold)

**Expected behavior:**
- ✅ No compression triggered (10k << 160k threshold)
- ✅ `/router usage` shows: `0 requests compressed`

**Test steps:**
1. Continue from Test 1
2. User: "Explain how TOON compression works in detail"
3. Wait for response
4. User: "What are the benefits and trade-offs?"
5. Wait for response
6. User: "/router usage"

**Expected `/router usage` output:**
```
Compression: 0 requests compressed, 0 tokens saved (0% reduction)
```

---

## Test 3: Compression triggered by context size

**Scenario:** Build context approaching 160k tokens

**Expected behavior:**
- ✅ Compression triggers when context ≥ 160k tokens
- ✅ `/router usage` shows: `1+ requests compressed, X tokens saved`

**Test steps:**
1. Continue from Test 2
2. User: "Read all files in src/ directory" (generates large tool output)
3. Wait for response (context likely exceeds 160k)
4. User: "/router usage"

**Expected `/router usage` output:**
```
Compression: 1 request compressed, ~XX,XXX tokens saved (XX% reduction)
```

---

## Test 4: No compression after recent compression

**Scenario:** Verify compression doesn't trigger again immediately

**Expected behavior:**
- ✅ No compression (recent messages kept, context reduced from previous compression)
- ✅ `/router usage` shows: same count as Test 3

**Test steps:**
1. Continue from Test 3
2. User: "Show router status"
3. Wait for response
4. User: "/router usage"

**Expected `/router usage` output:**
```
Compression: 1 request compressed (unchanged from Test 3)
```

---

## Test 5: Compression triggered by cache expiry (manual)

**Scenario:** Wait 5+ minutes, then send message

**Expected behavior:**
- ✅ Compression triggers due to cache expiry (time gap ≥ 300s)
- ✅ `/router usage` shows: `2 requests compressed`

**Test steps:**
1. Continue from Test 4
2. Wait 5+ minutes (or manually set lastTurnTimestamp in debug)
3. User: "Test cache expiry"
4. Wait for response
5. User: "/router usage"

**Expected `/router usage` output:**
```
Compression: 2 requests compressed, ~XX,XXX tokens saved (XX% reduction)
```

---

## Test 6: Verify compression metrics accumulate

**Scenario:** Check compression stats persist across turns

**Expected behavior:**
- ✅ `compressionRequestCount` increments only when compression triggers
- ✅ `compressionTotalOriginalChars` and `compressionTotalCompressedChars` accumulate
- ✅ Token savings percentage reflects actual compression ratio

**Test steps:**
1. After each test above, capture `/router usage` output
2. Verify `compressionRequestCount` increments only in Test 3 and Test 5
3. Verify token savings increase proportionally

---

## Success Criteria

| Metric | Expected |
|--------|----------|
| **Test 1-2 compression count** | 0 |
| **Test 3 compression count** | 1 (context size trigger) |
| **Test 4 compression count** | 1 (unchanged) |
| **Test 5 compression count** | 2 (cache expiry trigger) |
| **False triggers** | 0 (no compression on trivial context) |

---

## Failure Scenarios

❌ **If compression triggers in Test 1-2:** Bug NOT fixed (unconditional compression still active)

❌ **If compression never triggers in Test 3:** Context estimation broken or threshold too high

❌ **If compression triggers in Test 4:** Too aggressive (compressing on every turn)

❌ **If `/router usage` shows wrong counts:** Metrics tracking broken

---

## Execution Notes

- Run in herdr tab with `/omp` for clean session state
- Use `/router` to check current status between tests
- Use `/router set debug on` to see compression trigger logs
- Capture `/router usage` output after each test for comparison
