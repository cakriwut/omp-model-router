# Fallback Chain Testing Guide

This guide helps you test and verify that the model-router fallback mechanism works correctly when the primary model fails.

## Quick Start: Enable Debug Logging

The fallback chain now includes detailed logging. To see fallback attempts in action:

### 1. Enable Debug Mode

Edit `~/.omp/agent/model-router.json`:

```json
{
  "debug": true,
  ...
}
```

### 2. Reload OMP

```bash
/reload
```

### 3. Send a Prompt

Watch the console for fallback logs:

```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ➤ Invoking streamSimple...
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-7
```

Or if primary fails:

```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ✗ Failed: Service unavailable
[model-router] Attempt 2/4: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-6-v1
```

## Simulated Failure Test (Using Herdr)

### Scenario: Force Primary Model Failure

#### Step 1: Open Herdr Pane

```bash
herdr open pane -n "test-fallback"
```

#### Step 2: Create Test Config

In the new pane, create a backup:

```bash
cp ~/.omp/agent/model-router.json ~/.omp/agent/model-router.json.backup
```

#### Step 3: Modify Config with Invalid Primary

Edit `~/.omp/agent/model-router.json`, replace the primary model with an invalid one:

```json
{
  "profiles": {
    "auto": {
      "high": {
        "model": "nonexistent/invalid-model-xyz-123",
        "thinking": "high",
        "fallbacks": [
          "amazon-bedrock/global.anthropic.claude-opus-4-6-v1",
          "amazon-bedrock/moonshotai.kimi-k2.5",
          "amazon-bedrock/global.anthropic.claude-sonnet-4-6"
        ]
      },
      ...
    }
  }
}
```

#### Step 4: Launch OMP in Herdr

```bash
omp
```

#### Step 5: Send a Prompt

In OMP, send: `test message` or similar.

#### Step 6: Check Console Logs

You should see:

```
[model-router] Attempt 1/4: nonexistent/invalid-model-xyz-123
  ✗ Skipped: model not in registry
[model-router] Attempt 2/4: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  ➤ Invoking streamSimple...
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-6-v1
```

#### Step 7: Restore Config

```bash
mv ~/.omp/agent/model-router.json.backup ~/.omp/agent/model-router.json
```

#### Step 8: Reload OMP

```
/reload
```

## What the Logs Mean

### Success Path

```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ➤ Invoking streamSimple...
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-7
```

✅ **Primary model succeeded immediately.** No fallback needed.

### Fallback Path

```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ✗ Failed: Service unavailable
[model-router] Attempt 2/4: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  ➤ Invoking streamSimple...
  ✓ Success with amazon-bedrock/global.anthropic.claude-opus-4-6-v1
```

✅ **Primary failed, first fallback succeeded.** The response came from fallback #1.

Check `/router usage` — you should see a flag like `[fallback]` for this decision.

### Skip Conditions

```
[model-router] Attempt 1/4: invalid/model
  ✗ Skipped: model not in registry
```

The model was not found in the registry. The loop skipped to the next model without calling `streamSimple`.

```
[model-router] Attempt 1/4: some/model
  ✗ Skipped: no API key
```

The model exists but has no configured API key. Skipped to next.

```
[model-router] Attempt 1/4: router/auto
  ✗ Skipped: router provider
```

The fallback list contained a router provider reference (like `router/auto`). These are intentionally skipped (see provider.ts:459).

### Complete Failure

```
[model-router] Attempt 1/4: amazon-bedrock/global.anthropic.claude-opus-4-7
  ✗ Failed: Invalid API key
[model-router] Attempt 2/4: amazon-bedrock/global.anthropic.claude-opus-4-6-v1
  ✗ Failed: Invalid API key
[model-router] Attempt 3/4: amazon-bedrock/moonshotai.kimi-k2.5
  ✗ Failed: Invalid API key
[model-router] Attempt 4/4: amazon-bedrock/global.anthropic.claude-sonnet-4-6
  ✗ Failed: Invalid API key
[model-router] ❌ All 4 models failed. Last error: Invalid API key
```

❌ **All models exhausted.** The fallback chain is complete, and no model succeeded.

## Debugging Tips

### Check Your Fallback Configuration

Run the test:

```bash
bun test test/fallback-chain.test.ts
```

This displays your current config structure with all fallbacks.

### Verify Bedrock Model IDs

Bedrock models require special format. Examples:

```
✅ amazon-bedrock/global.anthropic.claude-opus-4-7
✅ amazon-bedrock/us.amazon.nova-micro-v1:0
❌ claude-opus-4-7 (wrong — missing provider/region prefix)
```

Check that all your Bedrock model IDs are valid by checking OMP's model registry during a session.

### Check API Keys

If you see "No API key" skips for all models:

1. Verify API keys are configured:
   ```bash
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   ```
   (for Bedrock)

2. Or configure in OMP settings.

### Monitor /router usage

After running a prompt with a fallback, check:

```
/router usage
```

Look for:
- Model marked with `[fallback]` flag
- Decision count increases
- Last decision shows the fallback model

## Files

- **Code:** `src/provider.ts:448-808` — Fallback loop with debug logging
- **Tests:** `test/fallback-chain.test.ts` — 13 unit tests verifying structure
- **Documentation:** `docs/FALLBACK_INVESTIGATION.md` — Detailed investigation findings

## Still Seeing Issues?

If fallbacks still aren't working as expected:

1. **Enable debug:** Set `debug: true` in config
2. **Capture logs:** Send a prompt and screenshot the console output
3. **Check `/router usage`:** Verify the last decision shows the model used
4. **Verify config:** Run `bun test test/fallback-chain.test.ts` to see your fallback structure
5. **Report:** Share the debug logs + `/router usage` output

## Related Reading

- `AGENTS.md` — Full model-router documentation
- `docs/FALLBACK_INVESTIGATION.md` — Technical investigation findings
