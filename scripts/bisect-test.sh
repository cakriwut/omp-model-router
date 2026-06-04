#!/usr/bin/env bash
# bisect-test.sh <commit>
# Deploy the given commit's code, start omp, monitor memory for 15s, kill omp.
# Exits 0 = OK (memory stable), 1 = BAD (memory spike).

COMMIT=${1:-HEAD}
REPO=/home/riwut/workspace/omp-model-router
THRESHOLD_PCT=15   # % RAM growth in 15s = bad
SPIKE_ABS=3000000  # 3GB RSS in kB = definitely bad

echo "=== Testing commit: $COMMIT ==="

cd "$REPO"
git checkout "$COMMIT" -- src/ 2>&1 | tail -3

# Deploy
bun run deploy:dev 2>&1 | tail -3

# Start omp in background (no stdin, no tty)
OMP_PID=""
omp --no-interactive --print-and-exit "test" &>/tmp/omp-bisect.log &
OMP_PID=$!

# Poll RSS for 15 seconds
MAX_RSS=0
for i in $(seq 1 15); do
    sleep 1
    RSS=$(cat /proc/$OMP_PID/status 2>/dev/null | grep VmRSS | awk '{print $2}')
    [ -z "$RSS" ] && RSS=0
    [ "$RSS" -gt "$MAX_RSS" ] && MAX_RSS=$RSS
    echo "  t+${i}s: RSS=${RSS} kB"
    [ "$RSS" -gt "$SPIKE_ABS" ] && { echo "SPIKE DETECTED at t+${i}s"; break; }
done

kill -9 $OMP_PID 2>/dev/null
wait $OMP_PID 2>/dev/null

echo "Max RSS: $MAX_RSS kB"
if [ "$MAX_RSS" -gt "$SPIKE_ABS" ]; then
    echo "RESULT: BAD (spike > 3GB)"
    exit 1
else
    echo "RESULT: OK"
    exit 0
fi
