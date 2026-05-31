# Fix: `/router update` fails with "No matching package found"

## Issue

When users run `/router update`, they get:
```
Error: Update failed (exit 1): Error: No matching package found for npm:@cakriwut/omp-model-router
```

## Root Cause

The extension was installed via a **local file path** (e.g., `file:../../../../workspace/omp-model-router`) instead of from npm. This happens when:

1. Users manually install during development using `bun add file:...`
2. The `deploy:dev` script creates a local symlink/file reference
3. Users follow dev setup instructions that use local paths

When `pi update npm:@cakriwut/omp-model-router` runs, it looks for an **installed package** matching that npm source. Since the actual installation uses `file:...`, there's no match and the command fails.

### Why This Happens

The `pi update <source>` command works by:
1. Finding installed extensions in `~/.omp/agent/extensions/`
2. Matching the provided source against the installed package's source
3. Updating packages that match

Since the installed source is `file:...` but the update command uses `npm:...`, there's no match.

## Solution

### 1. Enhanced Dev Install Detection

Updated `isDevInstall()` in `src/version-check.ts` to detect three scenarios:
- Symlinked extension directories
- Workspace-relative paths (`/workspace/` without `node_modules`)
- **NEW**: `file:` dependencies in parent `package.json`

The function now walks up the directory tree to find the extension's `package.json` and checks if `@cakriwut/omp-model-router` is listed as a `file:` dependency.

### 2. Update Command Guard

Added a check at the start of `handleUpdate()` in `src/commands.ts`:

```typescript
if (isDevInstall()) {
  ctx.ui.notify(
    [
      "Update unavailable: dev install detected.",
      "",
      "This extension is installed via local file path or symlink.",
      "To enable updates, reinstall from npm:",
      "",
      "  cd ~/.omp/agent/extensions/model-router",
      "  bun add @cakriwut/omp-model-router",
      "",
      "Or reinstall via pi CLI:",
      "  pi uninstall model-router",
      "  pi install npm:@cakriwut/omp-model-router",
    ].join("\n"),
    "info",
  );
  return;
}
```

This prevents the error and provides clear instructions on how to switch to an npm-based install.

## User Fix Instructions

If you're affected by this error, you have two options:

### Option A: Reinstall via npm (Bun)

```bash
cd ~/.omp/agent/extensions/model-router
bun add @cakriwut/omp-model-router
```

This will replace the `file:` dependency with the npm package.

### Option B: Reinstall via Pi CLI

```bash
pi uninstall model-router
pi install npm:@cakriwut/omp-model-router
```

This does a clean uninstall and reinstall from npm.

### Verification

After reinstalling, check your `package.json`:

```bash
cat ~/.omp/agent/extensions/model-router/package.json
```

The `dependencies` should show:
```json
{
  "dependencies": {
    "@cakriwut/omp-model-router": "^0.6.1"
  }
}
```

**NOT** this:
```json
{
  "dependencies": {
    "@cakriwut/omp-model-router": "file:../../../../workspace/omp-model-router"
  }
}
```

## Testing

New test file: `test/dev-install-detection.test.ts`

Documents the expected behavior:
- Dev installs via workspace paths are detected
- File dependencies in package.json are detected
- Node_modules installs are not flagged as dev

## Files Changed

- `src/version-check.ts` — Enhanced `isDevInstall()` to detect `file:` dependencies
- `src/commands.ts` — Added dev install guard to `/router update` command
- `test/dev-install-detection.test.ts` — Test coverage for dev install detection

## Backward Compatibility

✅ **Safe** — No breaking changes. Existing npm-installed users are unaffected. Dev users now get a helpful message instead of a cryptic error.

## Future Considerations

The `pi update` command could be enhanced to:
1. Detect `file:` dependencies and auto-switch to npm versions
2. Support updating local file paths by pulling from git
3. Provide a `--force-npm` flag to convert file installs to npm installs

However, these are upstream `pi` CLI concerns, not extension-level fixes.
