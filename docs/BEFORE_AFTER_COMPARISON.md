# Visual Comparison: Before vs After Fix

## Scenario

User has adaptive mode enabled with a misconfigured classifier model:

```json
{
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "classifierModel": "amazon-bedrock/us.amazon.nova-micro-v1:0"  // Model not in registry
  },
  "debug": true
}
```

User prompt: `"investigate why the router ignores LLM decisions"`

---

## Before Fix

### Console Output
```
(no output)
```

### Decision Object
```typescript
{
  tier: "high",
  phase: "planning",
  reasoning: "Detected strong planning keyword indicating architectural or investigative work.",
  isClassifier: false,
  // No indication classifier was attempted
}
```

### Trace File (`session-xxx-calibration.jsonl`)
```json
{
  "turnIndex": 6,
  "heuristicDecision": {
    "tier": "high",
    "reasoning": "Detected strong planning keyword indicating architectural or investigative work."
  },
  "llmDecision": {
    "tier": "medium",
    "reasoning": "focused debugging on classifier decision logic"
  },
  "finalDecision": {
    "tier": "high",
    "source": "heuristic"
  },
  "agreement": false
}
```

### User Experience

❌ **User sees disagreement in trace but no explanation why**
- Heuristic: high
- LLM: medium
- System used: high
- **Question**: "Why is the router ignoring the LLM decision?"

---

## After Fix

### Console Output
```
[model-router] Classifier model not found: amazon-bedrock/us.amazon.nova-micro-v1:0
```

### Decision Object
```typescript
{
  tier: "high",
  phase: "planning",
  reasoning: "Classifier unavailable, using heuristic: Detected strong planning keyword indicating architectural or investigative work.",
  isClassifier: false,
  // Clear indication classifier failed
}
```

### Trace File (`session-xxx-calibration.jsonl`)
```json
{
  "turnIndex": 6,
  "heuristicDecision": {
    "tier": "high",
    "reasoning": "Classifier unavailable, using heuristic: Detected strong planning keyword indicating architectural or investigative work."
  },
  "llmDecision": {
    "tier": "medium",
    "reasoning": "focused debugging on classifier decision logic"
  },
  "finalDecision": {
    "tier": "high",
    "source": "heuristic"
  },
  "agreement": false
}
```

### User Experience

✅ **User can immediately diagnose the issue**
- Console: `[model-router] Classifier model not found: amazon-bedrock/us.amazon.nova-micro-v1:0`
- Reasoning: `"Classifier unavailable, using heuristic: ..."`
- **Action**: Fix `classifierModel` config or accept heuristic routing

---

## Fix: Three Failure Modes Now Logged

### 1. Model Not Found

**Before:**
```typescript
const model = modelRegistry.find(provider, modelId);
if (!model) return undefined;  // Silent failure
```

**After:**
```typescript
const model = modelRegistry.find(provider, modelId);
if (!model) {
    if (debug) {
        console.warn(`[model-router] Classifier model not found: ${provider}/${modelId}`);
    }
    return undefined;
}
```

### 2. API Key Missing

**Before:**
```typescript
const apiKey = await modelRegistry.getApiKey(model);
if (!apiKey) return undefined;  // Silent failure
```

**After:**
```typescript
const apiKey = await modelRegistry.getApiKey(model);
if (!apiKey) {
    if (debug) {
        console.warn(`[model-router] Classifier model API key missing: ${provider}/${modelId}`);
    }
    return undefined;
}
```

### 3. Exception Thrown

**Before:**
```typescript
} catch (_error) {
    // Ignore classifier errors and fall back to heuristics
}
```

**After:**
```typescript
} catch (error) {
    if (debug) {
        console.warn(
            `[model-router] Classifier failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    // Ignore classifier errors and fall back to heuristics
}
```

---

## Reasoning Update

### Before (in resolveRouting)

```typescript
if (classifierResult) {
    decision = buildRoutingDecision(...);
}
// No else branch — decision remains heuristic with no marker
```

### After

```typescript
if (classifierResult) {
    decision = buildRoutingDecision(...);
} else {
    // Classifier failed or unavailable — mark decision to indicate fallback
    decision.reasoning = `Classifier unavailable, using heuristic: ${decision.reasoning}`;
}
```

---

## Impact Summary

| Aspect | Before | After |
|--------|--------|-------|
| **Classifier failure visibility** | ❌ Silent | ✅ Logged to console |
| **Decision reasoning** | ❌ Pure heuristic | ✅ "Classifier unavailable, using heuristic: ..." |
| **User can diagnose** | ❌ No | ✅ Yes (console + reasoning) |
| **Debug mode required** | N/A | ✅ `debug: true` for logs |
| **Heuristic fallback** | ✅ Works | ✅ Works (no change) |
| **Test coverage** | 326 tests | 334 tests (+8) |

---

## Real-World Example

### User's actual config

```json
{
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "classifierModel": "amazon-bedrock/us.amazon.nova-micro-v1:0"
  }
}
```

### Problem

Model ref uses `us.amazon` inference profile prefix, which may not be registered in the model registry if AWS region is different or profile doesn't exist.

### Before: Symptom

```
Turn 6: H=high L=medium → high (src=heuristic)
Turn 7: H=high L=medium → high (src=heuristic)
```

User: "Why is the router ignoring LLM decisions?"

### After: Diagnosis

```
[model-router] Classifier model not found: amazon-bedrock/us.amazon.nova-micro-v1:0
```

User: "Ah! The model ref is wrong. Let me fix it."

### Solution

Change to:
```json
"classifierModel": "amazon-bedrock/amazon.nova-micro-v1:0"
```

Or use a different region:
```json
"classifierModel": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
```

---

## Testing the Fix

### Manual Test

```bash
cd ~/workspace/omp-model-router
bun test/manual-classifier-failure-test.ts
```

**Expected output:**
```
🧪 Testing classifier failure handling in adaptive mode
════════════════════════════════════════════════════════════════════════════════

📝 Prompt: "investigate why the router ignores LLM decisions in adaptive mode"
[model-router] Classifier model not found: amazon-bedrock/us.amazon.nova-micro-v1:0
   🎯 Tier: high
   💭 Reasoning: Classifier unavailable, using heuristic: Detected strong planning keyword...
   🤖 isClassifier: false
   ✅ Failure marker present: YES

════════════════════════════════════════════════════════════════════════════════
✅ All tests passed! Classifier failure is correctly surfaced.
```

### Automated Tests

```bash
bun run test
```

**Expected:**
```
330 pass
4 skip
0 fail
837 expect() calls
Ran 334 tests across 28 files. [~600ms]
```

---

## Conclusion

The fix transforms a **silent failure** into a **diagnosed misconfiguration**. Users can now see exactly why their classifier isn't being used and fix it, rather than assuming the system is broken.
