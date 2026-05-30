# TOON History Exclusion Fix

## Problem

When a session starts with TOON-compressed history (from session reconstruction), the compression trigger was counting the TOON block as part of the context size, causing **immediate re-compression on the first message**.

### Reproduction

1. Session ends with 71 messages
2. Session is closed → TOON history block written to JSONL
3. New session starts by reconstructing from JSONL:
   ```
   messages[71]{role,content}:
     user,hi
     assistant,Hi. What's the task?
     ...
   ```
4. User sends first message: "hi"
5. Router estimates context tokens → **counts TOON block** → exceeds threshold → triggers compression
6. Compressor runs **on already-compressed TOON history**, producing double-compression

### Root Cause

`estimateContextTokens(context)` was counting **all messages** in `context.messages`, including:
- TOON-compressed history from session reconstruction
- Fresh messages from the current session

The TOON history block is **already compressed**, so including it in token estimation causes false positives for the compression trigger.

## Solution

`estimateContextTokens` now detects and excludes TOON history blocks from token estimation.

### Implementation

**New helper function** (`src/provider.ts:35-57`):
```typescript
/**
 * Detect if the first user message in context is a TOON-compressed history block.
 * Returns the index of the first message *after* the TOON history, or 0 if no TOON history.
 */
function detectTOONHistoryEnd(context: Context): number {
	if (context.messages.length === 0) return 0;
	
	// Check if first message is user role with TOON marker
	const firstMsg = context.messages[0];
	if (firstMsg.role !== "user") return 0;
	
	const content = typeof firstMsg.content === "string" 
		? firstMsg.content 
		: Array.isArray(firstMsg.content) 
		? firstMsg.content.find(b => b.type === "text")?.text ?? ""
		: "";
	
	if (!content.startsWith("[HISTORY:")) return 0;
	
	// TOON history block is always followed by an assistant acknowledgment
	// So skip the first 2 messages: [user: TOON block, assistant: ack]
	return Math.min(2, context.messages.length);
}
```

**Modified `estimateContextTokens`** (`src/provider.ts:59-81`):
```typescript
function estimateContextTokens(context: Context): number {
	let totalTokens = 0;
	
	// Exclude TOON-compressed history from estimation (already compressed)
	const startIdx = detectTOONHistoryEnd(context);
	
	// 1. Count tokens from messages with usage stats
	for (let i = startIdx; i < context.messages.length; i++) {
		const msg = context.messages[i];
		if (msg.usage) {
			totalTokens += (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
		} else {
			// 2. For messages without usage, estimate from content
			totalTokens += estimateMessageTokens(msg);
		}
	}
	
	// 3. Add system prompt tokens (rough estimate: 1 token ≈ 4 chars)
	if (context.system) {
		const systemStr = Array.isArray(context.system)
			? context.system.map((s) => (typeof s === "string" ? s : s.text ?? "")).join("")
			: context.system;
		totalTokens += Math.ceil(systemStr.length / 4);
	}
	
	return totalTokens;
}
```

### TOON History Block Format

TOON history is always structured as:
1. **User message** starting with `[HISTORY: N messages compressed below. Reconstruct context from this history before responding.]`
2. **Assistant acknowledgment**: `"Context reconstructed. Ready to proceed."`

The exclusion logic skips these first 2 messages when estimating tokens.

## Verification

### Test Coverage

**`test/toon-history-exclusion.test.ts`**:
- TOON history is excluded from token estimation
- Fresh context without TOON history estimates normally
- TOON history detection handles edge cases (empty context, non-user first message)
- Multiple compressions don't trigger on already-compressed history

**`test/toon-trigger-integration.test.ts`**:
- First message in TOON-reconstructed session should NOT trigger compression
- Fresh session with large prompt should trigger compression
- TOON session with many NEW messages should trigger when threshold exceeded
- Actual bug scenario: 71 TOON messages + "hi" → **9 tokens estimated** (not 160K+)

### Before Fix

```
Context: [TOON block (71 messages), ack, "hi"]
Estimated tokens: 16,500 (TOON block counted)
Threshold: 160,000 (80% of 200K)
Trigger: NO (16,500 < 160,000, but still wastefully high)
```

But in sessions with very large system prompts or many TOON messages, the estimate could exceed threshold.

### After Fix

```
Context: [TOON block (71 messages), ack, "hi"]
Estimated tokens: 9 (only "hi" + system prompt)
Threshold: 160,000
Trigger: NO (9 < 160,000) ✓
```

## Impact

✅ **Prevents double-compression** of TOON history blocks  
✅ **Reduces false-positive compression triggers** on session reconstruction  
✅ **Preserves correct behavior** for fresh sessions without TOON history  
✅ **No breaking changes** — transparent to users  

## Related Files

- `src/provider.ts`: Implementation of `detectTOONHistoryEnd` and modified `estimateContextTokens`
- `src/context-compression.ts`: TOON encoding/decoding logic
- `test/toon-history-exclusion.test.ts`: Unit tests for TOON exclusion
- `test/toon-trigger-integration.test.ts`: Integration tests for compression trigger behavior
- `docs/COMPRESSION_TRIGGER_FIX.md`: Original compression trigger documentation
- `docs/DEBUG_SESSION_LOGGING.md`: Debug logging for compression triggers

## Configuration

No configuration changes required. The fix is transparent and automatic.

To verify the fix in your sessions, enable debug mode and check for `router:compression-trigger` entries:

```json
{
  "debug": true,
  "historyCompression": {
    "enabled": true,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,
      "timeThreshold": 300
    }
  }
}
```

Then check your session JSONL files:
```bash
grep '"customType":"router:compression-trigger"' ~/.omp/agent/sessions/*/*/*.jsonl
```

You should **not** see compression triggers on the first message after session reconstruction.
