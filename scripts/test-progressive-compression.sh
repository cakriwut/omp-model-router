#!/usr/bin/env bash
# Progressive Compression Test Execution Script
#
# Tests that TOON compression triggers only when thresholds are met,
# not unconditionally on every request.

set -euo pipefail

TEST_SESSION="${1:-}"
if [[ -z "$TEST_SESSION" ]]; then
    echo "Usage: $0 <session_jsonl_path>"
    echo "Example: $0 ~/.omp/agent/sessions/-workspace-omp-model-router/2026-05-30T*.jsonl"
    exit 1
fi

echo "=== Progressive Compression Test ==="
echo "Session: $TEST_SESSION"
echo ""

# Extract key metrics from session jsonl
echo "Analyzing compression triggers..."

python3 <<'EOF'
import sys, json
from datetime import datetime, timezone

session_path = sys.argv[1]
rows = [json.loads(line) for line in open(session_path)]

compression_events = []
router_states = []

for i, r in enumerate(rows):
    t = r.get('type')
    ts = r.get('timestamp', '')
    
    # Track router-state entries
    if t == 'router-state' or r.get('customType') == 'router-state':
        d = r.get('data', {})
        router_states.append({
            'index': i,
            'timestamp': ts,
            'crc': d.get('compressionRequestCount', 0),
            'origChars': d.get('compressionTotalOriginalChars', 0),
            'compChars': d.get('compressionTotalCompressedChars', 0),
        })
    
    # Track compression-trigger custom entries
    elif t == 'custom' and r.get('customType') == 'router:compression-trigger':
        compression_events.append({
            'index': i,
            'timestamp': ts,
            'reason': r['data'].get('reason'),
        })

print(f"Total router-state entries: {len(router_states)}")
print(f"Total compression triggers: {len(compression_events)}")
print("")

# Show compression evolution
print("Compression Timeline:")
print("Index | Timestamp               | CRC | Orig Chars | Comp Chars | Savings")
print("------|-------------------------|-----|------------|------------|--------")

prev_crc = 0
for s in router_states:
    if s['crc'] != prev_crc:
        savings_pct = 0
        if s['origChars'] > 0:
            savings_pct = ((s['origChars'] - s['compChars']) / s['origChars']) * 100
        print(f"{s['index']:5} | {s['timestamp']} | {s['crc']:3} | {s['origChars']:10} | {s['compChars']:10} | {savings_pct:5.1f}%")
        prev_crc = s['crc']

print("")
print("Compression Trigger Events:")
if compression_events:
    for e in compression_events:
        print(f"  {e['index']:5} | {e['timestamp']} | reason={e['reason']}")
else:
    print("  (none logged)")

print("")

# Final metrics
if router_states:
    final = router_states[-1]
    print("Final Metrics:")
    print(f"  Compression Requests: {final['crc']}")
    print(f"  Original Chars: {final['origChars']:,}")
    print(f"  Compressed Chars: {final['compChars']:,}")
    if final['origChars'] > 0:
        savings_pct = ((final['origChars'] - final['compChars']) / final['origChars']) * 100
        print(f"  Savings: {savings_pct:.1f}%")

# Test verdict
print("")
print("=== TEST VERDICT ===")

# Count messages before first compression
if compression_events or (router_states and router_states[-1]['crc'] > 0):
    first_comp_index = None
    for s in router_states:
        if s['crc'] > 0:
            first_comp_index = s['index']
            break
    
    if first_comp_index:
        # Count user messages before first compression
        user_msgs = 0
        for i, r in enumerate(rows):
            if i >= first_comp_index:
                break
            if r.get('type') == 'message' and r.get('message', {}).get('role') == 'user':
                user_msgs += 1
        
        print(f"First compression at index {first_comp_index} after {user_msgs} user messages")
        
        if user_msgs <= 2:
            print("❌ FAIL: Compression triggered TOO EARLY (unconditional mode)")
        elif user_msgs >= 5:
            print("✅ PASS: Compression triggered appropriately (progressive mode)")
        else:
            print("⚠️  WARN: Compression at edge case ({user_msgs} messages)")
else:
    print("✅ PASS: No compression triggered (as expected for short session)")

EOF
python3 - "$TEST_SESSION"

echo ""
echo "=== Test Complete ==="
