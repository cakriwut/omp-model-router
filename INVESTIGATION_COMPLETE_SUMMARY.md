# Model Fallback Investigation — COMPLETE ✅

**Date:** 2026-05-31  
**Status:** Implementation complete, tested, deployed  
**Test Results:** 359/359 tests passing  

---

## Summary

Investigated the model-router fallback mechanism, verified correctness, added debug logging, and created comprehensive tests. The fallback chain **is correctly implemented** — when a primary model fails, the router automatically tries fallback models in sequence until one succeeds.

---

## What Was Delivered

### 1. Ground Truth Test ✅

**File:** `test/fallback-chain.test.ts` (13 passing tests)

Tests verify:
- Config parsing (fallback arrays loaded correctly)
- Chain building (`[primary, ...fallbacks]`)
- Image filtering (non-image models excluded when image attached)
- Skip conditions (registry lookup, API key checks, router provider exclusion)
- Loop termination (success → break, error → continue, exhausted → throw)
- Decision flags (`isFallback` set when `i > 0`)
- Real user config verification (loads `~/.omp/agent/model-router.json`)

**Your config:** ✅ 6 profiles, 100% fallback coverage on all tiers (high/medium/low), 2-4 fallbacks per tier

### 2. Debug Logging ✅

**File:** `src/provider.ts:448-808`

When `debug: true` in config, console shows each fallback attempt:

```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ✗ Failed: Service unavailable
[model-router] Attempt 2/4: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-6-v1
```

**Skip reasons logged:**
- `✗ Skipped: router provider` — fallback references `router/*`
- `✗ Skipped: model not in registry` — model not found
- `✗ Skipped: no API key` — no API key configured

**Complete failure:**
```
[model-router] ❌ All 4 models failed. Last error: Invalid API key
```

### 3. Documentation ✅

**Files created:**
- `docs/FALLBACK_INVESTIGATION.md` — Technical deep-dive, hypotheses, code review
- `docs/FALLBACK_TESTING_GUIDE.md` — Step-by-step guide to test fallback with Herdr
- `FALLBACK_CHAIN_INVESTIGATION_SUMMARY.md` — User-facing summary
- `FALLBACK_CHAIN_COMPLETE.md` — High-level overview

**Files updated:**
- `AGENTS.md` — Added "Testing & Debugging" section

---

## How to Use

### Enable Debug Logging

1. Edit `~/.omp/agent/model-router.json`:
   ```json
   {
     "debug": true,
     ...
   }
   ```

2. Reload OMP:
   ```
   /reload
   ```

3. Send a prompt → watch console for fallback logs

### Test Fallback Chain

1. Backup config:
   ```bash
   cp ~/.omp/agent/model-router.json ~/.omp/agent/model-router.json.backup
   ```

2. Modify primary model to invalid:
   ```json
   {
     "profiles": {
       "auto": {
         "high": {
           "model": "invalid/nonexistent-model",
           "fallbacks": ["amazon-bedrock/...", ...]
         }
       }
     }
   }
   ```

3. Launch OMP, send prompt

4. Check console logs — should see fallback #1 succeed

5. Restore config:
   ```bash
   mv ~/.omp/agent/model-router.json.backup ~/.omp/agent/model-router.json
   ```

See `docs/FALLBACK_TESTING_GUIDE.md` for full instructions.

---

## Key Findings

### ✅ Fallback Mechanism Works

**Code:** `src/provider.ts:448-808`

```typescript
// 1. Build chain
let modelsToTry = [
  decision.targetLabel,
  ...(profile[decision.tier].fallbacks ?? []),
];

// 2. Filter by image if needed
if (imageAttached) {
  const filtered = modelsToTry.filter(ref => modelSupportsImage(ref, ...));
  modelsToTry = filtered.length > 0 ? filtered : [decision.targetLabel];
}

// 3. Try each model in sequence
for (let i = 0; i < modelsToTry.length; i++) {
  const modelRef = modelsToTry[i];
  
  // Skip conditions
  if (targetProvider === "router") continue;
  if (!targetModel) continue;  // Not in registry
  if (!apiKey) continue;        // No API key
  
  try {
    // Invoke streamSimple, consume stream
    for await (const event of delegatedStream) {
      if (event.type === "error") throw new Error(...);
      stream.push(event);
    }
    success = true;
    if (i > 0) decision.isFallback = true;
    break;
  } catch (err) {
    lastError = err;
    // Continue to next model
  }
}

if (!success) throw lastError;
```

### ✅ Your Config is Perfect

All 6 profiles have comprehensive fallback coverage:

```
auto:
  HIGH:   opus-4-7 → opus-4-6-v1 → kimi-k2.5 → sonnet-4-6
  MEDIUM: sonnet-4-5 → sonnet-4-6 → o4-mini → glm-5
  LOW:    haiku-4-5 → nova-micro → nova-lite → gpt-4.1-nano

opus-lean:
  HIGH:   opus-4-6-v1 → opus-4-7 → sonnet-4-6
  MEDIUM: sonnet-4-6 → sonnet-4-5 → o4-mini
  LOW:    haiku-4-5 → nova-lite → gpt-4.1-nano

(... and 4 more profiles, all with complete coverage)
```

---

## Why "3 Retries" Might Fail

Even with correct code and config, fallbacks can fail if:

### 1. All Models Unavailable
- All Bedrock models in same region down
- API keys expired/missing for all models
- Network connectivity issues

**Expected:** All N attempts logged, then error thrown

### 2. Models Not In Registry
Fallback models configured but not available in OMP's model registry.

**Log shows:**
```
[model-router] Attempt 2/4: amazon-bedrock/fallback-model
  ✗ Skipped: model not in registry
```

**Fix:** Verify model IDs are correct

### 3. Bedrock Inference Profile Format
Bedrock models need specific format.

❌ Wrong: `"model": "claude-opus-4-7"`  
✅ Right: `"model": "amazon-bedrock/global.anthropic.claude-opus-4-7"`

### 4. Miscounting Attempts
"3 retries" = primary (1) + 2 fallbacks (2-3) = 3 total attempts

If a tier only has 2 fallbacks configured, exhausting the chain after 3 attempts is expected.

---

## Next Steps

### If You Still See Failures

1. **Enable debug:**
   ```json
   { "debug": true }
   ```

2. **Reproduce the failure** in OMP

3. **Capture:**
   - Screenshot of console logs
   - Output of `/router usage`
   - The exact error message

4. **Share** those artifacts — we'll trace exactly where the chain breaks

### Verify Fallback Chain Works

Run the test:
```bash
bun test test/fallback-chain.test.ts
```

This displays your full config structure and verifies the logic.

---

## Files Changed

### Code
- ✅ `src/provider.ts` — Added debug logging to fallback loop (lines 448-808)

### Tests
- ✅ `test/fallback-chain.test.ts` — 13 new unit tests (all passing)

### Documentation
- ✅ `docs/FALLBACK_INVESTIGATION.md` — Technical investigation
- ✅ `docs/FALLBACK_TESTING_GUIDE.md` — Step-by-step testing guide  
- ✅ `FALLBACK_CHAIN_INVESTIGATION_SUMMARY.md` — User summary
- ✅ `FALLBACK_CHAIN_COMPLETE.md` — High-level overview
- ✅ `AGENTS.md` — Updated with Testing & Debugging section

---

## Test Results

```
✅ 359 tests passing (was 346)
❌ 0 tests fail
✅ 13 new fallback chain tests added
✅ Deployed to ~/.omp/agent/extensions/model-router
```

---

## Commit

```
feat: add model fallback chain testing and debug logging

- Add 13 unit tests for fallback chain mechanism (provider.ts:448-808)
- Verify user config has 100% fallback coverage on all tiers
- Add detailed debug logging to track fallback attempts
- Create fallback testing guide and investigation documentation

When debug=true, console now shows each fallback attempt:
  [model-router] Attempt 1/4: primary-model
    ✗ Failed: Service unavailable
  [model-router] Attempt 2/4: fallback-model-1
    ✓ Success with fallback-model-1

All 359 tests passing (was 346)
```

---

## TL;DR

✅ **Fallback mechanism works correctly**  
✅ **Your config has 100% coverage**  
✅ **Tests prove the logic**  
✅ **Debug logging added**  
✅ **Documentation created**  
✅ **Deployed and ready to test**

**Next:** Enable `debug: true` in config, reload OMP (`/reload`), and monitor fallback attempts in console during your next session.
