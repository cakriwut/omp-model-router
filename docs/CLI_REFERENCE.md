# CLI Reference: pi vs omp

Both `pi` and `omp` CLIs can install the model-router extension, but with different syntax.

## Installation

### pi CLI (node-based)
```bash
pi install npm:@cakriwut/omp-model-router
```
- Requires `npm:` prefix for npm packages
- Package installed to: `~/.pi/agent/npm/node_modules/@cakriwut/omp-model-router`

### omp CLI (rust-based)
```bash
omp install @cakriwut/omp-model-router
```
- No prefix needed (auto-detects npm packages)
- Package installed to: `~/.omp/agent/plugins/` or similar

## Verification

### pi CLI
```bash
pi list | grep omp-model-router
# Shows:
#   npm:@cakriwut/omp-model-router
#     /home/user/.pi/agent/npm/node_modules/@cakriwut/omp-model-router
```

### omp CLI
```bash
omp plugin list | grep omp-model-router
# Or
omp list
```

## Uninstall

### pi CLI
```bash
pi remove npm:@cakriwut/omp-model-router
```

### omp CLI
```bash
omp plugin uninstall @cakriwut/omp-model-router
```

## Testing Installation

Both methods work the same once installed:

```bash
# Start OMP session
pi  # or: omp

# Test extension
/reload
/router
/router help
```

## Recommendation

**Both CLIs work equally well.** Use whichever one you have installed:
- If you have `pi` → use `pi install npm:@cakriwut/omp-model-router`
- If you have `omp` → use `omp install @cakriwut/omp-model-router`

## Troubleshooting

### "Invalid package name" with pi CLI

**Problem:** Used `pi install @cakriwut/omp-model-router` (missing `npm:` prefix)

**Solution:** Add the prefix: `pi install npm:@cakriwut/omp-model-router`

### Package not found

**Problem:** Package name typo or not yet published

**Solution:** Verify package exists:
```bash
npm view @cakriwut/omp-model-router version
# Should show: 0.6.2
```

### Extension doesn't load

**Problem:** Extension not discovered after install

**Solution:**
1. Restart OMP: close and reopen, or use `/reload`
2. Check installation: `pi list` or `omp list`
3. Check logs: `pi --log-level debug` or `omp --log-level debug`
