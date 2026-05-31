# `/router update` Fix + Best Practices Audit — Complete Summary

**Date:** 2026-05-31  
**Version:** v0.6.1 → v0.6.2 (pending release)

---

## 🎯 Overview

Two deliverables completed:

1. **Fixed `/router update` error** for dev installs
2. **Audited extension against Oh-My-Pi best practices** — fully compliant

---

## 🐛 Issue: `/router update` Fails

### Problem
Users running `/router update` encountered:
```
Error: No matching package found for npm:@cakriwut/omp-model-router
```

### Root Cause
Extension installed via **local file path** (`file:../../../../workspace/omp-model-router`) instead of npm. The `pi update npm:@cakriwut/omp-model-router` command couldn't match the installed source.

### Solution Implemented

**1. Enhanced `isDevInstall()` detection** (`src/version-check.ts`):
- Detects symlinked directories
- Detects workspace-relative paths
- **NEW**: Detects `file:` dependencies in parent `package.json`

**2. Added guard in `/router update`** (`src/commands.ts`):
- Blocks update attempts on dev installs
- Shows clear reinstall instructions

**3. Updated documentation** (`AGENTS.md`, `docs/UPDATE_COMMAND_FIX.md`):
- Troubleshooting section with fix instructions
- User-facing guidance for reinstalling from npm

### User Fix (for affected users)

**Option A — Bun:**
```bash
cd ~/.omp/agent/extensions/model-router
bun add @cakriwut/omp-model-router
```

**Option B — Pi CLI:**
```bash
pi uninstall model-router
pi install npm:@cakriwut/omp-model-router
```

**Verify:**
```bash
cat ~/.omp/agent/extensions/model-router/package.json
# Should show: "@cakriwut/omp-model-router": "^0.6.1"
# NOT: "@cakriwut/omp-model-router": "file:..."
```

---

## ✅ Best Practices Audit

**Reference:** https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md

### Compliance Status: **PASS** ✅

No critical violations. Extension follows all Oh-My-Pi authoring guidelines.

### Key Findings

| Area | Status | Details |
|---|---|---|
| Factory signature | ✅ Pass | Default export, receives `ExtensionAPI` |
| Package manifest | ✅ Pass | Uses `omp.extensions` field |
| No runtime actions during load | ✅ Pass | All actions inside event handlers |
| Event handlers | ✅ Pass | Proper async handlers, standard events only |
| Error handling | ✅ Pass | `tool_call` handlers never throw |
| Command registration | ✅ Pass | Single `/router` command, no conflicts |
| Dev install detection | ✅ Excellent | Enhanced detection with `file:` deps |
| CLI binary shebang | ✅ Pass | Uses `#!/usr/bin/env bun` |

### No `session_end` Pitfall
Extension correctly avoids the non-existent `session_end` event and persists state on:
- `turn_end` ✅
- Debounced writes in calibration subsystem ✅

### No `ctx.session`/`ctx.context` Access
Uses proper alternatives:
- `ctx.sessionManager.getBranch()` for history ✅
- Synthetic session IDs via timestamps ✅

---

## 📁 Files Changed

### New Files
- `test/dev-install-detection.test.ts` — Test coverage for dev install detection
- `docs/UPDATE_COMMAND_FIX.md` — Detailed fix documentation
- `docs/UPDATE_COMMAND_FIX_SUMMARY.md` — Quick reference
- `docs/BEST_PRACTICES_AUDIT.md` — Full compliance audit report

### Modified Files
- `src/version-check.ts` — Enhanced `isDevInstall()` to detect `file:` dependencies
- `src/commands.ts` — Added dev install guard + import `isDevInstall`
- `AGENTS.md` — Added best practices section + troubleshooting

---

## 🧪 Testing

**Test suite:** ✅ **All 334 tests pass** (+ 4 new tests, 4 skipped)

```
✓ 334 pass
✓ 4 skip
✓ 0 fail
✓ 841 expect() calls
```

New test file documents expected behavior:
- Dev installs via workspace paths are detected
- File dependencies in `package.json` are detected
- Node_modules installs are not flagged as dev

---

## 🚀 Release Plan

### Version: v0.6.2 (patch)

**Changes:**
- Fixed: `/router update` now detects dev installs and shows helpful message
- Enhanced: Dev install detection includes `file:` dependencies
- Docs: Best practices audit confirms full Oh-My-Pi compliance
- Tests: Added dev install detection test coverage

**Release script:**
```bash
bun run release:patch  # v0.6.1 → v0.6.2
```

**After release:**
- Existing npm users: automatic detection, no action needed
- Dev users: will see guidance when running `/router update`
- New users: documented installation best practices

---

## 📊 Impact

### Backward Compatibility
✅ **Safe** — No breaking changes

- Existing npm-installed users: unaffected
- Dev users: now get helpful message instead of cryptic error
- No changes to core routing/calibration/compression logic

### User Experience Improvements
1. **Clear error messages** — Users know why update failed and how to fix it
2. **Documentation** — Troubleshooting section in AGENTS.md
3. **Confidence** — Best practices audit confirms robust implementation

---

## 🎓 Lessons Learned

### Dev Install Detection
The `isDevInstall()` function now covers three scenarios:
1. Symlinks (original detection)
2. Workspace paths (original detection)
3. **File dependencies** (new detection via package.json walk)

This catches the most common dev workflow: `bun add file:...` or symlink-based deploys.

### Pi Update Command
The `pi update <source>` command matches by **source string**, not by package name. When the installed source is `file:...` but the update command uses `npm:...`, there's no match.

Future improvements could enhance `pi update` to:
- Auto-detect file installs and offer to switch to npm
- Support updating file paths by pulling from git
- Provide `--force-npm` flag to convert installs

These are upstream `pi` CLI concerns, not extension-level fixes.

---

## 📚 Documentation

All documentation updated:
- ✅ `AGENTS.md` — Best practices section + troubleshooting
- ✅ `docs/BEST_PRACTICES_AUDIT.md` — Full compliance report
- ✅ `docs/UPDATE_COMMAND_FIX.md` — Detailed fix documentation
- ✅ `docs/UPDATE_COMMAND_FIX_SUMMARY.md` — Quick reference

---

## ✨ Conclusion

The `/router update` error is **fixed** and the extension is **fully compliant** with Oh-My-Pi best practices. The codebase demonstrates:

- ✅ Proper lifecycle management
- ✅ Robust error handling
- ✅ Good separation of concerns
- ✅ Excellent dev tooling
- ✅ Clear documentation

Ready for v0.6.2 release.

---

**Next Steps:**
1. Review this summary
2. Run `bun run release:patch` when ready
3. Monitor for user feedback on update flow
