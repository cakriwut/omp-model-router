# `/router update` Error Fix — Summary

## Problem
Users running `/router update` get:
```
Error: Update failed (exit 1): Error: No matching package found for npm:@cakriwut/omp-model-router
```

## Root Cause
Extension was installed via **local file path** (`file:...`) instead of npm. The `pi update npm:@cakriwut/omp-model-router` command can't find a matching installed package because the source is a local file reference, not an npm package.

## Fix
1. **Enhanced dev install detection** (`src/version-check.ts`):
   - Now detects `file:` dependencies in parent `package.json`
   - Walks up directory tree to check if package is installed as a file reference

2. **Added guard in update command** (`src/commands.ts`):
   - Blocks `/router update` on dev installs
   - Shows clear instructions on how to reinstall from npm

## User Instructions

### To fix the error, reinstall from npm:

**Option A — Using Bun:**
```bash
cd ~/.omp/agent/extensions/model-router
bun add @cakriwut/omp-model-router
```

**Option B — Using Pi CLI:**
```bash
pi uninstall model-router
pi install npm:@cakriwut/omp-model-router
```

### Verify the fix:
```bash
cat ~/.omp/agent/extensions/model-router/package.json
```

Should show:
```json
"dependencies": {
  "@cakriwut/omp-model-router": "^0.6.1"
}
```

NOT:
```json
"dependencies": {
  "@cakriwut/omp-model-router": "file:../../../../workspace/omp-model-router"
}
```

## Technical Details

### Files Changed
- `src/version-check.ts` — Enhanced `isDevInstall()` to detect file dependencies
- `src/commands.ts` — Added dev install guard + import `isDevInstall`
- `test/dev-install-detection.test.ts` — Test coverage
- `docs/UPDATE_COMMAND_FIX.md` — Detailed documentation

### Error Flow (Before Fix)
1. User runs `/router update`
2. Command executes: `pi update npm:@cakriwut/omp-model-router`
3. Pi CLI searches for installed package matching `npm:...` source
4. Finds extension installed with `file:...` source → **no match**
5. Fails with "No matching package found"

### Error Prevention (After Fix)
1. User runs `/router update`
2. Command checks `isDevInstall()` → **true** (detects `file:` dependency)
3. Shows helpful message with reinstall instructions
4. Returns early, never calls `pi update`

## Test Results
```
✓ 334 pass
✓ 4 skip
✓ 0 fail
✓ 841 expect() calls
```

All tests pass, including new dev install detection tests.

## Next Steps
- [ ] Merge fix to main
- [ ] Release as v0.6.2 (patch)
- [ ] Document in release notes
- [ ] Consider auto-migration in future (detect file deps → offer to convert to npm)
