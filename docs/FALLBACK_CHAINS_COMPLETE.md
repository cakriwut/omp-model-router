# Model & Classifier Fallback Chains — Complete Implementation

**Date:** 2026-05-31  
**Status:** ✅ Both model AND classifier fallback chains implemented  
**Test Results:** 359/359 tests passing

---

## Summary

Both **model fallback chains** and **classifier fallback chains** are now fully implemented and tested. When a primary model or classifier fails, the router automatically tries fallbacks in sequence until one succeeds.

---

## 1. Model Fallback Chains ✅

### Implementation

**File:** `src/provider.ts:448-808`

When a primary model fails (rate limit, service down, network error), the router automatically tries fallbacks:

```
Primary Model → Fallback 1 → Fallback 2 → Fallback 3 → ... → Throw Error
```

### Configuration

**File:** `~/.omp/agent/model-router.json`

```json
{
  "profiles": {
    "auto": {
      "high": {
        "model": "amazon-bedrock/global.anthropic.claude-opus-4-7",
        "fallbacks": [
          "amazon-bedrock/global.anthropic.claude-opus-4-6-v1",
          "amazon-bedrock/moonshotai.kimi-k2.5",
          "amazon-bedrock/global.anthropic.claude-sonnet-4-6"
        ]
      },
      "medium": {
        "model": "amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "fallbacks": [
          "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
          "openai/o4-mini",
          "amazon-bedrock/zai.glm-5"
        ]
      }
    }
  }
}
```

### Debug Output

When `debug: true` in config:

```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ✗ Failed: Service unavailable
[model-router] Attempt 2/4: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-6-v1
```

**Skip reasons:**
- `✗ Skipped: model not in registry` — Model not found
- `✗ Skipped: no API key` — No API key configured
- `✗ Skipped: router provider` — Fallback references `router/*`

**Complete failure:**
```
[model-router] ❌ All 4 models failed. Last error: Invalid API key
```

### Tests

**File:** `test/fallback-chain.test.ts` (13 passing tests)

Verifies:
- Config parsing (fallback arrays loaded)
- Chain building (`[primary, ...fallbacks]`)
- Image filtering (non-image models excluded when image attached)
- Skip conditions (registry, API key, router provider checks)
- Loop termination (success → break, error → continue, exhausted → throw)
- Decision flags (`isFallback` set when `i > 0`)
- Real user config verification

Run tests:
```bash
bun test test/fallback-chain.test.ts
```

---

## 2. Classifier Fallback Chains ✅

### Implementation

**Files:**
- `src/calibration/agent.ts:194-286` — Async classifier fallback (for telemetry mode)
- `src/routing.ts:499-610` — Sync classifier fallback (for adaptive mode)

When a classifier fails, the router tries fallbacks in sequence:

```
Classifier 1 → Classifier 2 → Classifier 3 → ... → Heuristic Fallback
```

### Configuration

**File:** `~/.omp/agent/model-router.json`

```json
{
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "classifierModel": [
      "anthropic/claude-3-haiku-20240307",
      "openai/gpt-4.1-nano",
      "amazon-bedrock/amazon.nova-micro-v1:0"
    ]
  }
}
```

**Backward compatibility:** Single string still works:
```json
{
  "calibration": {
    "classifierModel": "anthropic/claude-3-haiku-20240307"
  }
}
```

### Debug Output

When `debug: true` in config:

**Async classifier (telemetry mode):**
```
[model-router] Classifier fallback chain: 3 model(s)
[model-router] Classifier attempt 1/3: anthropic/claude-3-haiku-20240307
  ✗ Failed: Rate limited
[model-router] Classifier attempt 2/3: openai/gpt-4.1-nano
  ✓ Success: spawning gpt-4.1-nano (async·telemetry)
```

**Sync classifier (adaptive mode):**
```
[model-router] Sync classifier attempt 1/3: anthropic/claude-3-haiku-20240307
  ✗ Skipped: model not in registry
[model-router] Sync classifier attempt 2/3: openai/gpt-4.1-nano
  ✓ Success: gpt-4.1-nano
```

**Complete failure (all classifiers fail → heuristic fallback):**
```
[model-router] ❌ All 3 sync classifier models failed. Falling back to heuristic.
```

### When Classifiers Are Used

**Telemetry mode (`mode: "telemetry"`):**
- Async classifier spawns in background
- Does NOT affect routing (heuristic decision is used)
- Used only for data collection

**Adaptive mode (`mode: "adaptive"`):**
- Sync classifier runs **before** model selection
- Classifier verdict overrides heuristic
- If classifier fails → falls back to heuristic

### Tests

**File:** `test/classifier-failure-handling.test.ts` (included in 359 tests)

Verifies:
- Single classifier works
- Classifier not found → skips to next
- Classifier fails → tries next
- All fail → falls back to heuristic
- Debug logging works

Run tests:
```bash
bun test test/classifier-failure-handling.test.ts
```

---

## How to Use

### Enable Debug Logging

1. Edit `~/.omp/agent/model-router.json`:
   ```json
   {
     "debug": true
   }
   ```

2. Reload OMP:
   ```
   /reload
   ```

3. Send a prompt → watch console for fallback logs

### Configure Model Fallbacks

Add fallback arrays to each tier:

```json
{
  "profiles": {
    "auto": {
      "high": {
        "model": "primary-model",
        "fallbacks": ["fallback1", "fallback2", "fallback3"]
      }
    }
  }
}
```

**Recommendation:** 2-4 fallbacks per tier for redundancy.

### Configure Classifier Fallbacks

Set `classifierModel` as an array:

```json
{
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "classifierModel": [
      "anthropic/claude-3-haiku-20240307",
      "openai/gpt-4.1-nano",
      "amazon-bedrock/amazon.nova-micro-v1:0"
    ]
  }
}
```

**Recommendation:** Use cheap/fast models for classifier (Haiku, Nano, Nova Micro).

---

## Testing

### Unit Tests

**Model fallback:**
```bash
bun test test/fallback-chain.test.ts
```

**Full suite:**
```bash
bun test
```

### Simulation Test (Herdr)

See `docs/FALLBACK_TESTING_GUIDE.md` for step-by-step instructions to force a failure and verify fallback works.

---

## Key Findings

### ✅ Both Mechanisms Work

1. **Model fallback** — Tries primary → fallback1 → fallback2 → ... → throws
2. **Classifier fallback** — Tries classifier1 → classifier2 → ... → heuristic

### ✅ Debug Logging

Both mechanisms log:
- Each attempt (`Attempt N/X: ...`)
- Skip reasons (`✗ Skipped: ...`)
- Success (`✓ Success with ...`)
- Complete failure (`❌ All N models failed...`)

### ✅ User Config Verified

Your config has:
- **6 profiles** with complete fallback coverage (2-4 fallbacks per tier)
- **No classifier fallbacks yet** (single `classifierModel` configured)

---

## Files Changed

### Code
- ✅ `src/provider.ts` — Added model fallback debug logging
- ✅ `src/calibration/agent.ts` — Added classifier fallback loop (async)
- ✅ `src/routing.ts` — Added classifier fallback loop (sync)

### Tests
- ✅ `test/fallback-chain.test.ts` — 13 new model fallback tests

### Documentation
- ✅ `docs/FALLBACK_INVESTIGATION.md` — Technical deep-dive
- ✅ `docs/FALLBACK_TESTING_GUIDE.md` — Step-by-step testing guide
- ✅ `docs/FALLBACK_CHAINS_COMPLETE.md` — This summary
- ✅ `AGENTS.md` — Updated with fallback testing section

---

## Test Results

```
✅ 359 tests passing
❌ 0 tests fail
✅ 13 new model fallback tests
✅ Classifier fallback tests included
✅ Deployed to ~/.omp/agent/extensions/model-router
```

---

## What to Do Next

### Configure Classifier Fallbacks

Edit `~/.omp/agent/model-router.json`:

```json
{
  "calibration": {
    "classifierModel": [
      "anthropic/claude-3-haiku-20240307",
      "openai/gpt-4.1-nano",
      "amazon-bedrock/amazon.nova-micro-v1:0"
    ]
  }
}
```

### Enable Debug Mode

```json
{
  "debug": true
}
```

### Reload and Monitor

```
/reload
```

Then send prompts and watch console logs for fallback attempts.

---

## TL;DR

✅ **Model fallback chain works** — Primary → Fallback1 → Fallback2 → ...  
✅ **Classifier fallback chain works** — Classifier1 → Classifier2 → ... → Heuristic  
✅ **Debug logging added** — See each attempt in console  
✅ **Tests verify logic** — 359 tests passing  
✅ **Documentation created** — Step-by-step guides  
✅ **Deployed and ready to test**

**Next:** Enable `debug: true`, configure classifier fallbacks, reload OMP, and monitor during your next session.
