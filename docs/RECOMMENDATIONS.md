# Recommendations — Session Loop Prevention

**For**: @cakriwut  
**Re**: Session 019e77d8-692c-7000-9241-ba4f18bbfa31 loop issue  
**Status**: ✅ Fix deployed (v0.5.1)

---

## Immediate Actions

### 1. Reload OMP to Activate Fix

```bash
# In OMP terminal
/reload
```

Expected output:
```
✓ Reloaded extensions
✓ model-router v0.5.1 active
```

### 2. Abandon Stuck Session

The stuck session is **unsalvageable** — it has 738 messages and 273K tokens. Start fresh:

```bash
# New session in same project
cd ~/workspace/omp-model-router
omp
```

The new session will have checkpoint expiry enabled automatically.

### 3. Install RTK and Enable Integration

**Recommended** to prevent future bloat from large tool outputs:

#### A. Install RTK Binary

```bash
# Homebrew (recommended)
brew install rtk

# Or quick install
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh

# Verify
rtk --version  # Should show "rtk 0.28.2" or later
```

#### B. Enable in Config

`~/.omp/agent/model-router.json`:

```json
{
  "enableRtk": true,
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,
      "timeThreshold": 300,
      "maxCheckpointAge": 50,        // Refresh checkpoint after 50 turns
      "maxCheckpointSize": 200000    // Refresh if context > 200K tokens
    },
    "excludeModels": ["kimi", "nova"]
  }

---

## Long-Term Improvements

### 1. Enable AWS Bedrock Logging

Model invocation logging was **not enabled**, which blocked investigation of actual prompts sent to Bedrock.

**To enable**:

1. Go to [AWS Bedrock Console](https://console.aws.amazon.com/bedrock/) → Settings → Model invocation logging
2. Enable CloudWatch Logs with log group `/aws/bedrock/modelinvocations`
3. Optionally enable S3 logging for long-term retention

**Usage**:

```bash
# Tail logs for a session
aws logs tail /aws/bedrock/modelinvocations --since 1h --filter-pattern "019e77d8"

# Check specific prompts
aws logs filter-log-events \
  --log-group-name /aws/bedrock/modelinvocations \
  --filter-pattern "019e77d8-692c-7000-9241-ba4f18bbfa31" \
  --start-time $(date -d '6 hours ago' +%s)000
```

**Cost**: CloudWatch Logs is cheap (~$0.50/GB ingested, $0.03/GB stored). Bedrock invocations are ~1-10KB each.

### 2. Monitor Session Health

Add periodic checks for bloat indicators:

```bash
# Check session size
ls -lh ~/.omp/agent/sessions/-workspace-omp-model-router/*.jsonl | tail -5

# Count messages in current session
wc -l ~/.omp/agent/sessions/-workspace-omp-model-router/$(ls -t ~/.omp/agent/sessions/-workspace-omp-model-router/*.jsonl | head -1)

# Watch for checkpoint expiry events
tail -f ~/.omp/agent/logs/*.log | grep "Checkpoint expired"
```

**Healthy session**:
- < 200 messages
- < 500KB JSONL file size
- Checkpoint refreshes every 50-100 turns

**Bloated session** (restart recommended):
- > 500 messages
- > 2MB JSONL file size
- Checkpoint not refreshing despite high message count

### 3. Add Session Health to UI Widget

**Proposal**: Extend `/router` widget to show session health:

```
Router: auto                       $0.12 / $2.00
████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 15 decisions

Session Health:
  Messages: 142 / ~500 (healthy)
  Context: 45K tokens (22% of window)
  Checkpoint: age 12 turns (fresh)

Last: medium → anthropic/claude-sonnet-4-6 (medium)
```

**Implementation**: Track in `RouterState`:
- `sessionMessageCount`
- `sessionContextTokens`
- `checkpointAge`

**Thresholds**:
- **Healthy**: < 200 messages, < 100K tokens, checkpoint < 30 turns old
- **Warning**: 200-500 messages, 100-150K tokens, checkpoint 30-50 turns old
- **Critical**: > 500 messages, > 150K tokens, checkpoint > 50 turns old

### 4. Add `/router reset-checkpoint` Command

**Proposal**: Manual checkpoint refresh for power users:

```bash
/router reset-checkpoint
```

Output:
```
✓ Checkpoint invalidated
✓ Next turn will force fresh compression
```

**Use case**: User notices session is getting sluggish, wants to force a refresh before hitting automatic expiry limits.

**Implementation**: Add to `commands.ts`:

```typescript
if (subcommand === "reset-checkpoint") {
  state.currentCheckpoint = undefined;
  console.log("[ROUTER] Checkpoint manually reset");
  return "✓ Checkpoint invalidated. Next turn will compress fresh.";
}
```

### 5. Aggressive Tool Output Truncation

**Current**: Tool results can be arbitrarily large (saw 78KB bash outputs in stuck session)

**Proposal**: Add `maxToolResultSize` config (default 10KB):

```json
{
  "historyCompression": {
    "enabled": true,
    "maxToolResultSize": 10000  // Truncate tool outputs > 10KB
  }
}
```

**Implementation**: In `context-compression.ts`, before adding tool result to history:

```typescript
function truncateToolResult(content: string, maxSize: number): string {
  if (content.length <= maxSize) return content;
  
  const half = Math.floor(maxSize / 2);
  return (
    content.slice(0, half) +
    `\n\n... [${content.length - maxSize} chars truncated] ...\n\n` +
    content.slice(-half)
  );
}
```

This preserves start and end of large outputs while preventing context bloat.

---

## Monitoring Checklist

After deploying fix, watch for:

- ✅ Checkpoint expiry events in logs (`grep "Checkpoint expired"`)
- ✅ Session message count stays < 300
- ✅ Context size stays < 150K tokens
- ✅ No new reports of agent loops
- ✅ Cost trends remain stable (no spike from over-compression)

---

## When to Restart a Session

**Restart when**:
- Message count > 500
- Session feels "sluggish" (agent losing context)
- Repeated loops or off-topic responses
- JSONL file > 2MB

**How to restart**:
```bash
# Save current work first
git commit -m "WIP before session restart"

# Start fresh
omp  # Same project, clean session
```

---

## Questions?

If you see unexpected behavior:

1. Check logs: `tail -f ~/.omp/agent/logs/*.log`
2. Check session size: `ls -lh ~/.omp/agent/sessions/-workspace-omp-model-router/*.jsonl | tail -1`
3. Check checkpoint age: Look for "Checkpoint expired" or "compressionCacheHit" in JSONL
4. DM me or open an issue with session ID

---

## Fix Verification

**Expected behavior** after `/reload`:

1. **New sessions**: Checkpoint expires after 50 turns or when context > 200K
2. **Existing bloated sessions**: Auto-refresh on next turn (if over limits)
3. **Debug logs** (if `debug: true`):
   ```
   [ROUTER] Checkpoint expired: { reason: 'size', age: 15, contextTokens: 215000 }
   ```

**To verify fix is active**:

```bash
# Check version
/router

# Should show v0.5.1
# Output: "Router: auto  v0.5.1  $X.XX / $Y.YY"
```

---

## Summary

| Action | Priority | Status |
|--------|----------|--------|
| `/reload` in OMP | **HIGH** | ⬜ User |
| Abandon stuck session | **HIGH** | ⬜ User |
| Enable Bedrock logging | **MEDIUM** | ⬜ User |
| Add session health to UI | **LOW** | ⬜ Future |
| Add `/router reset-checkpoint` | **LOW** | ⬜ Future |
| Add tool output truncation | **LOW** | ⬜ Future |

**Bottom line**: Fix is live. Reload OMP, start fresh session, you're good to go. Checkpoint bloat won't recur.
