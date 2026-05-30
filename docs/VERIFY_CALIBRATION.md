# How to Verify Calibration is Live

## Quick Check (in OMP session)

### 1. Check Router Status
```
/router usage
```

**What to look for**:
- If calibration is active but no data yet:
  ```
  Calibration enabled (mode: telemetry) — no comparisons yet
  ```

- After a few turns with data:
  ```
  Calibration 5 comparisons | 80% agreement | 6 LLM calls (1 failed)
  ```

### 2. Enable Debug Mode (see initialization)
If debug is enabled in your config, you'll see notifications when:
- Calibration initializes: `[calibration] Initialized (mode: telemetry, warmup: 5)`
- Classifier spawns: `[calibration] Spawned async classifier (agent: classifier-...)`
- Results arrive: `[calibration] h=medium, llm=high ✗ (3 comparisons)`

### 3. Send a Test Prompt
Try sending any message, then wait ~2 seconds and send another. On the second message, check `/router usage` — the comparison count should increase.

## File System Checks

### 4. Check Trace File (if traceEnabled: true)
```bash
# List trace files
ls -lh ~/.omp/agent/model-router/traces/

# View latest trace
ls -t ~/.omp/agent/model-router/traces/*.jsonl | head -1 | xargs cat | tail -5
```

**What to look for**:
- File exists with current session ID
- JSONL records with `turnIndex`, `heuristicDecision`, `llmDecision` fields

Example trace record:
```json
{
  "turnIndex": 2,
  "timestamp": 1748596123456,
  "prompt": "fix the bug in auth.ts",
  "promptFeatures": {
    "wordCount": 5,
    "toolResultCount": 0,
    "hasImages": false,
    "matchedKeywords": []
  },
  "heuristicDecision": {
    "tier": "medium",
    "phase": "implementation",
    "reasoning": "Detected implementation work"
  },
  "llmDecision": {
    "tier": "high",
    "reasoning": "Requires careful debugging and analysis",
    "latencyMs": 1234
  },
  "finalDecision": {
    "tier": "medium",
    "source": "heuristic"
  },
  "agreement": false
}
```

### 5. Check Global Snapshot (after session ends)
```bash
# Check if global calibration file exists
ls -lh ~/.omp/agent/model-router/calibration-global.json

# View contents
cat ~/.omp/agent/model-router/calibration-global.json
```

**What to look for**:
```json
{
  "version": 1,
  "matrix": [
    [5, 2, 0],
    [3, 12, 4],
    [0, 1, 8]
  ],
  "metadata": {
    "totalSessions": 1,
    "totalComparisons": 35,
    "lastUpdated": 1748596123456,
    "routerVersion": "0.5.1"
  }
}
```

## Programmatic Checks

### 6. Check OMP Session File
```bash
# Find current session
CURRENT_SESSION=$(ls -t ~/.omp/agent/sessions/-workspace-omp-model-router/*.jsonl | head -1)

# Check for calibration custom entries
grep '"type":"custom"' "$CURRENT_SESSION" | grep calibration
```

### 7. Monitor Haiku API Calls
If you have access to Anthropic dashboard, check for Haiku 3 API calls:
- Model: `claude-3-haiku-20240307`
- Request pattern: Simple 2-line response ("Tier: X\nReasoning: Y")
- Frequency: ~1 call per user turn

## Troubleshooting

### Calibration NOT Running?

**Check 1: Is it enabled?**
```bash
grep -A 5 '"calibration"' ~/.omp/agent/model-router.json
```
Should show `"enabled": true`.

**Check 2: Did you reload?**
After editing config, run `/reload` in OMP.

**Check 3: Check for errors**
If debug mode is on, look for:
- `[calibration] Failed to spawn classifier: ...`
- `[calibration] Classifier failed: ...`

**Check 4: Verify classifier model**
```bash
# Check if Haiku 3 is available in your model registry
# (This depends on your Anthropic API key being configured)
```

### High Failure Rate?

If you see:
```
⚠ High failure rate (85%) — check classifierModel config
```

**Possible causes**:
- Model not available (API key missing)
- Model ref incorrect (typo in config)
- Rate limiting on Haiku 3 API

**Fix**:
1. Verify API key: Check `~/.omp/agent/auth/` for Anthropic credentials
2. Try different model: Change to `anthropic/claude-3-5-haiku-20241022`
3. Disable temporarily: Set `"enabled": false` in config

## Expected Timeline

| After | What to Expect |
|-------|----------------|
| **1 turn** | Calibration initialized, no comparisons yet |
| **2-3 turns** | First LLM results arrive, 1-2 comparisons recorded |
| **10 turns** | ~8 comparisons, agreement rate visible |
| **50 turns** | ~40 comparisons, reliable statistics |
| **Session end** | Data merged into global snapshot |

## Quick Verification Script

```bash
#!/bin/bash
# verify-calibration.sh

echo "=== Calibration Status Check ==="
echo

echo "1. Config enabled?"
grep -A 2 '"calibration"' ~/.omp/agent/model-router.json | grep enabled

echo
echo "2. Trace files exist?"
ls -lh ~/.omp/agent/model-router/traces/ 2>/dev/null | tail -5

echo
echo "3. Global snapshot exists?"
ls -lh ~/.omp/agent/model-router/calibration-global.json 2>/dev/null

echo
echo "4. Latest trace record:"
ls -t ~/.omp/agent/model-router/traces/*.jsonl 2>/dev/null | head -1 | xargs tail -1 | python3 -m json.tool 2>/dev/null

echo
echo "Done. If all checks pass, calibration is live."
```

Run it:
```bash
chmod +x verify-calibration.sh
./verify-calibration.sh
```

## Still Not Sure?

**Definitive test**:
1. Send 3 messages in OMP
2. Run `/router usage`
3. Look for "Calibration" section

If you see "Calibration enabled ... — no comparisons yet" even after 3+ turns, the classifier is not running. Check debug logs or file an issue with error output.
