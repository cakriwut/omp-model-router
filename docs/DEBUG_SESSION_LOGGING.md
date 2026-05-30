# Debug Session Logging

## Problem

Debug logs written to `console.log` are ephemeral and cannot be reviewed after the session ends. This makes post-mortem analysis and troubleshooting difficult — you can't go back and see what compression triggers fired, when they fired, or what the context was at the time.

## Solution

When `debug: true` is enabled in the router config, compression trigger events are now **persisted to the session JSONL file** as custom entries. This provides a permanent audit trail.

## Implementation

### Session Entry Type

Compression triggers are stored as custom entries with:
- **customType**: `"router:compression-trigger"`
- **data**: Object containing trigger details

### Data Structure

```json
{
  "reason": "context-size" | "cache-expiry",
  "contextTokens": 165432,
  "threshold": 160000,
  "timeSinceLastTurn": 287,  // seconds, or "N/A" for first turn
  "timeThreshold": 300,      // seconds
  "turnNumber": 42,
  "messageCount": 84
}
```

### Code Location

**File**: `src/provider.ts`  
**Lines**: 467-483

When `state.currentConfig.debug && triggerReason`:
1. Build compression debug data object
2. Call `ctx.sessionManager.appendCustomEntry('router:compression-trigger', compressionDebugData)`
3. Also log to console for real-time visibility

## Reviewing Session Logs

Session JSONL files are stored in `~/.omp/agent/sessions/<workspace>/<session-id>/`.

To extract compression trigger events from a session:

```bash
# Find all compression trigger entries
grep '"customType":"router:compression-trigger"' ~/.omp/agent/sessions/*/*/0-*.jsonl | jq -r .data

# Pretty-print with timestamps
jq 'select(.type == "custom" and .customType == "router:compression-trigger") | {timestamp, data}' \
  ~/.omp/agent/sessions/<workspace>/<session-id>/0-ArchitectSpec.jsonl
```

## Example Entry

```json
{
  "type": "custom",
  "id": "abc123",
  "parentId": "xyz789",
  "timestamp": "2026-05-30T06:00:00.000Z",
  "customType": "router:compression-trigger",
  "data": {
    "reason": "cache-expiry",
    "contextTokens": 145000,
    "threshold": 160000,
    "timeSinceLastTurn": 310,
    "timeThreshold": 300,
    "turnNumber": 15,
    "messageCount": 30
  }
}
```

## Benefits

✅ **Auditability**: Full history of when compression triggered  
✅ **Debugging**: Understand why compression triggered or didn't trigger  
✅ **Performance analysis**: Correlate trigger timing with session behavior  
✅ **Persistent**: Logs survive process restart, unlike console.log  

## Related Files

- `src/provider.ts`: Implementation of session logging
- `test/compression-trigger.test.ts`: Test suite including session logging verification
- `docs/COMPRESSION_TRIGGER_FIX.md`: Compression trigger behavior explanation

## Configuration

Enable debug mode in your config:

```json
{
  "debug": true,
  "historyCompression": {
    "enabled": true,
    "progressive": {
      "enabled": true
    }
  }
}
```

Then check your session JSONL files for `router:compression-trigger` entries.
