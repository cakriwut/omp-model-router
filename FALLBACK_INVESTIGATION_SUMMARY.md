# Model Fallback Investigation — Complete Summary

**Date:** 2026-05-31  
**Status:** ✅ Tests added, debug logging implemented, ground truth established

---

## What Was Done

### 1. **Ground Truth Verification** ✅

Investigated your actual config at `~/.omp/agent/model-router.json`:

- **6 profiles** (auto, opus-lean, deep, cheap, oss, hybrid)
- **100% fallback coverage** — Every profile has 2-4 fallbacks on ALL tiers (high/medium/low)
- **Example (auto profile):**
  ```
  HIGH:   opus-4-7 → opus-4-6-v1 → kimi-k2.5 → sonnet-4-6
  MEDIUM: sonnet-4-5 → sonnet-4-6 → o4-mini → glm-5
  LOW:    haiku-4-5 → nova-micro → nova-lite → gpt-4.1-nano
  ```

**Conclusion:** Your config is perfectly set up. The fallback chain **should** work.

---

### 2. **Unit Tests Created** ✅

**File:** `test/fallback-chain.test.ts` (13 passing tests)

Tests verify:
- ✅ Config parsing: fallback arrays loaded correctly
- ✅ Chain building: `[primary, ...fallbacks]` array construction
- ✅ Image filtering: non-image-capable models filtered when image attached
- ✅ Skip conditions: registry lookup, API key, router provider checks
- ✅ Loop termination: success, continue, throw logic
- ✅ Decision flags: `isFallback` set when `i > 0`
- ✅ Real config: loads and displays your actual fallback structure

Run them anytime with:
```bash
bun test test/fallback-chain.test.ts
```

---

### 3. **Debug Logging Added** ✅

**File:** `src/provider.ts:448-808`

The fallback loop now logs each attempt when `debug: true`:

**Example output:**
```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ➤ Invoking streamSimple...
  ✗ Failed: Service unavailable
[model-router] Attempt 2/4: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  ➤ Invoking streamSimple...
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-6-v1
```

**To enable:**
1. Edit `~/.omp/agent/model-router.json`
2. Set `"debug": true`
3. Reload OMP: `/reload`
4. Send a prompt and watch console logs

---

### 4. **Documentation Created** ✅

**Files:**
- `docs/FALLBACK_INVESTIGATION.md` — Technical deep-dive into the fallback mechanism
- `docs/FALLBACK_TESTING_GUIDE.md` — Step-by-step guide to test fallbacks using Herdr

---

## Next Steps: Reproduce the Issue

Since the code **looks correct** and your config **is correct**, we need to capture what's actually happening during a real failure.

### Option 1: Enable Debug Logging (Recommended)

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

3. Use OMP normally until you hit a model failure

4. **Capture the console output** showing the fallback attempts

5. Share the logs so we can see:
   - How many models were attempted?
   - Why did they fail?
   - Were all fallbacks tried?

### Option 2: Simulate Failure with Herdr

Follow the guide in `docs/FALLBACK_TESTING_GUIDE.md`:

1. Open herdr pane
2. Backup your config
3. Replace primary model with `"invalid/nonexistent-model"`
4. Launch OMP
5. Send a prompt
6. Check if fallback #1 is used
7. Restore config

---

## What We Know

✅ **Fallback loop exists** — `provider.ts:448-808`  
✅ **Config has fallbacks** — All 6 profiles, all 3 tiers  
✅ **Tests pass** — 359 total tests including 13 new fallback tests  
✅ **Debug logging added** — Will show each attempt  

❓ **Still unknown:**
- What error do you see when it "fails after 3 retries"?
- Are the fallback models in the registry?
- Are API keys configured for fallback models?
- Does the error happen **before** entering the fallback loop?

---

## Files Changed

- ✅ `test/fallback-chain.test.ts` — New unit tests (13 passing)
- ✅ `src/provider.ts` — Added debug logging to fallback loop
- ✅ `docs/FALLBACK_INVESTIGATION.md` — Technical investigation findings
- ✅ `docs/FALLBACK_TESTING_GUIDE.md` — Step-by-step testing guide

---

## Test Results

```
✓ 359 tests passing
✓ Fallback chain unit tests pass
✓ Real config verified (100% fallback coverage)
```

---

## Your Action: Capture the Real Error

Next time you encounter "3 retries then failed", do this:

1. **If debug is enabled:** Screenshot the console logs
2. **Run `/router usage`** to see the last decision
3. **Check the error message** — does it mention which model failed?
4. **Share the logs** so we can identify:
   - Registry issue?
   - API key issue?
   - Network/transient failure?
   - Something else?

With the debug logging, we'll see exactly where the chain breaks.

---

**Ready to deploy and test?**

```bash
bun run deploy:dev
/reload
```

Then enable `debug: true` and monitor the next failure.
