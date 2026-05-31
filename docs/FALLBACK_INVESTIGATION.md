# Model Fallback Investigation — Ground Truth Report

**Date:** 2026-05-31  
**Status:** Unit tests created and passing; ground truth established

## Summary

The model-router fallback mechanism **IS correctly implemented** in code. User's config **IS correctly configured** with comprehensive fallbacks. All 355 unit tests pass. However, **the fallback chain is not being triggered during actual OMP sessions** when models fail.

## Ground Truth: User Config Structure

✅ **User has excellent fallback coverage:**
- **6 profiles:** auto, opus-lean, deep, cheap, oss, hybrid
- **100% coverage:** All 6 profiles have fallbacks on ALL 3 tiers (high/medium/low)
- **Redundancy:** 2-4 fallbacks per tier

Example (auto profile):
```
HIGH:
  Primary:   amazon-bedrock/global.anthropic.claude-opus-4-7
  Fallback1: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  Fallback2: amazon-bedrock/moonshotai.kimi-k2.5
  Fallback3: amazon-bedrock/global.anthropic.claude-sonnet-4-6

MEDIUM:
  Primary:   amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0
  Fallback1: amazon-bedrock/global.anthropic.claude-sonnet-4-6
  Fallback2: openai/o4-mini
  Fallback3: amazon-bedrock/zai.glm-5

LOW:
  Primary:   amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0
  Fallback1: amazon-bedrock/amazon.nova-micro-v1:0
  Fallback2: amazon-bedrock/amazon.nova-lite-v1:0
  Fallback3: openai/gpt-4.1-nano
```

## Code Review: Fallback Mechanism

### Implementation Status ✅

**Location:** `src/provider.ts:431-780`

**Chain Construction** (lines 433-441):
```typescript
let modelsToTry = [
  decision.targetLabel,                    // Primary
  ...(profile[decision.tier].fallbacks ?? []),  // Fallbacks
];

// If image attached, filter to image-capable only
if (imageAttached) {
  const filtered = modelsToTry.filter(ref => modelSupportsImage(ref, ...));
  modelsToTry = filtered.length > 0 ? filtered : [decision.targetLabel];
}
```
✅ **Correct:** Primary + fallbacks array + image filtering

**Loop Through Chain** (lines 448-776):
```typescript
for (let i = 0; i < modelsToTry.length; i++) {
  const modelRef = modelsToTry[i];
  
  // Skip conditions
  if (targetProvider === "router") continue;
  if (!targetModel) continue;
  if (!apiKey) continue;
  
  try {
    // Call streamSimple, consume stream
    for await (const event of delegatedStream) {
      if (event.type === "error") throw new Error(...);
      stream.push(event);
    }
    success = true;
    if (i > 0) decision.isFallback = true;
    break;
  } catch (err) {
    lastError = err;
    // Loop continues to next model
  }
}

if (!success) throw lastError;
```
✅ **Correct:** Tries all models, skips on error, marks isFallback flag

**Decision Flag** (line 771):
```typescript
if (i > 0) decision.isFallback = true;  // i=0 is primary, i>0 is fallback
```
✅ **Correct:** Flag properly set when fallback is used

### Tests Added ✅

**File:** `test/fallback-chain.test.ts` (13 passing tests)

Coverage:
- ✅ Config parsing: fallback arrays loaded correctly
- ✅ Chain building: [primary, ...fallbacks] constructed
- ✅ Image filtering: non-image models filtered from chain
- ✅ Skip conditions: registry lookup, API key, router provider checks
- ✅ Loop termination: stops on success, continues on error, throws when exhausted
- ✅ Decision flags: isFallback set correctly
- ✅ Real config verification: all profiles have fallbacks

## The Mystery: "After 3 Retries, Failed"

### What We Know

1. **Code is correct** — fallback loop properly implemented
2. **Config is correct** — all tiers have 2-4 fallbacks
3. **Tests pass** — logic verified
4. **But user observes:** "retries 3 times then fails"

### Hypotheses

#### Hypothesis A: Models Not In Registry ❓
When a model is not found in `modelRegistry.find()`, the loop skips to the next without calling `streamSimple`. This might feel like "retries" but are actually registry lookups failing.

**To test:** Check if any fallback models are misconfigured or not available in the registry during OMP session.

#### Hypothesis B: Bedrock Inference Profile Issue ❓
Bedrock models require **inference profile ARNs**, not just model IDs. If configured wrong, `modelRegistry.find()` fails for all Bedrock models.

Example:
```
❌ WRONG:  amazon-bedrock/global.anthropic.claude-opus-4-7
✅ RIGHT:  amazon-bedrock/us.anthropic.invoke-anthropic-claude-opus-4-7:0:200k
```

**To test:** Verify Bedrock model IDs are valid inference profile references.

#### Hypothesis C: API Key Missing/Expired ❓
If the API key is unavailable or expired during OMP session, the loop skips all models (both primary + fallbacks) at the auth check stage (line 469).

**To test:** Verify API keys are configured for all providers in active use.

#### Hypothesis D: Error Event Thrown Too Early ❓
If `streamSimple()` returns a stream that immediately emits an error event (before first "done"), the try-catch catches it correctly. But maybe the error message is misleading, making it look like only 3 attempts were made.

**To test:** Add debug logging to count actual attempts.

## Next Steps

### Immediate: Add Debug Logging

Modify `src/provider.ts` to log each fallback attempt:

```typescript
for (let i = 0; i < modelsToTry.length; i++) {
  const modelRef = modelsToTry[i];
  const { provider: targetProvider, modelId: targetModelId } = parseCanonicalModelRef(modelRef);

  if (state.currentConfig.debug) {
    console.log(`[model-router] Attempt ${i+1}/${modelsToTry.length}: ${modelRef}`);
  }

  // Skip checks
  if (targetProvider === "router") {
    if (state.currentConfig.debug) console.log(`  ✗ Skipped: router provider`);
    continue;
  }

  const targetModel = state.currentModelRegistry.find(targetProvider, targetModelId);
  if (!targetModel) {
    if (state.currentConfig.debug) console.log(`  ✗ Skipped: model not in registry`);
    lastError = new Error(`Routed model not found: ${modelRef}`);
    continue;
  }

  const apiKey = await state.currentModelRegistry.getApiKey(targetModel);
  if (!apiKey) {
    if (state.currentConfig.debug) console.log(`  ✗ Skipped: no API key`);
    lastError = new Error(`No API key for routed model: ${modelRef}`);
    continue;
  }

  try {
    if (state.currentConfig.debug) console.log(`  ➤ Invoking streamSimple...`);
    // ... stream logic ...
    if (state.currentConfig.debug) console.log(`  ✓ Success`);
    success = true;
    break;
  } catch (err) {
    if (state.currentConfig.debug) {
      console.log(`  ✗ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    lastError = err;
  }
}

if (!success) {
  if (state.currentConfig.debug) {
    console.log(`[model-router] All ${modelsToTry.length} models failed`);
  }
  throw lastError;
}
```

### Simulation Test

1. Modify `~/.omp/agent/model-router.json`:
   ```json
   {
     "high": {
       "model": "invalid/model-that-does-not-exist",
       "fallbacks": ["valid/model1", "valid/model2", "valid/model3"]
     }
   }
   ```

2. Enable debug: `debug: true`

3. Launch OMP in herdr pane

4. Send a prompt, capture console logs

5. Expected: See attempt 1 fail (not in registry), then attempt 2-3 try the fallbacks

### Verify Bedrock Model IDs

Check if Bedrock model IDs are in the correct format:

```bash
# See what modelRegistry actually has
jq '.models[] | select(.provider == "amazon-bedrock") | {id, name}' ~/.omp/agent/extensions/model-router/cache.json
```

### Capture Error Message

When the fallback fails in live OMP, get the exact error message:
- Screenshot or copy the error
- Check `/router usage` for the last decision
- Look for `isFallback: true` flag

## Recommendations

1. **Add debug logging** (non-breaking change)
2. **Document Bedrock model ID format** in AGENTS.md
3. **Add integration test** that mocks actual streamSimple failures
4. **Monitor real sessions** with debug flag enabled

## Files Changed

- ✅ `test/fallback-chain.test.ts` — New unit tests (13 passing)

## Files to Change Next

- 🔄 `src/provider.ts` — Add debug logging
- 📝 `AGENTS.md` — Document Bedrock model ID format
- 📝 `docs/DEBUGGING.md` — Fallback troubleshooting guide
