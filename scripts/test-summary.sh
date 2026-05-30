#!/usr/bin/env bash
# Test runner with summary-first output:
# - Hides verbose console.log output from passing tests
# - Shows full output for failing tests
# - Always shows final summary

# Capture output and exit code separately
temp_file=$(mktemp)
bun test --dots > "$temp_file" 2>&1
exit_code=$?
output=$(cat "$temp_file")
rm "$temp_file"

if [ $exit_code -eq 0 ]; then
    # All tests passed - show only summary
    echo "bun test v$(bun --version)"
    echo ""
    echo "$output" | grep -E "^[0-9]+ (pass|fail|skip)|Ran [0-9]+ tests|expect\(\) calls" || {
        # Fallback: show last 5 lines if grep pattern doesn't match
        echo "$output" | tail -n 5
    }
else
    # Tests failed - show full output
    echo "$output"
fi

exit $exit_code
