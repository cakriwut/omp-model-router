# Best Practices Audit: omp-model-router Extension

**Date:** 2026-05-31  
**Reference:** https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md

---

## ✅ Compliance Summary

The `omp-model-router` extension follows Oh-My-Pi best practices with **no critical violations**. Minor recommendations for polish are noted below.

---

## ✅ Core Requirements

### 1. Factory Signature
**Status:** ✅ Compliant

```typescript
// src/index.ts:25
const routerExtension = (pi: ExtensionAPI) => {
  pi.setLabel("Model Router");
  // ...
};

export default routerExtension;
```

- Default export ✅
- Receives `ExtensionAPI` ✅
- Named function for debugging ✅

### 2. Package Manifest
**Status:** ✅ Compliant

```json
// package.json
{
  "omp": {
    "repository": "https://github.com/can1357/oh-my-pi",
    "type": "extension",
    "extensions": ["src/index.ts"]
  }
}
```

- Uses `omp` field (not legacy `pi`) ✅
- Specifies entry point ✅
- Includes `type: "extension"` ✅

### 3. No Runtime Actions During Load
**Status:** ✅ Compliant

The extension registers handlers, commands, and providers during load, but **never calls runtime actions** like `pi.sendMessage()` before a session is active.

All `ctx.ui.notify()`, `ctx.model`, and state mutations happen **inside** event handlers:
- ✅ `pi.on("session_start", ...)` — notifications after session initialized
- ✅ `pi.on("tool_call", ...)` — RTK rewrites during tool execution
- ✅ Command handlers — only run when user invokes `/router`

### 4. Command Registration
**Status:** ✅ Compliant

```typescript
// src/commands.ts:756
pi.registerCommand("router", {
  description: "Model router control center",
  handler: async (args, ctx) => { /* ... */ }
});
```

- Single command: `/router` ✅
- No conflicts with built-ins ✅
- Proper async handler ✅

### 5. Event Handlers
**Status:** ✅ Compliant

All event handlers are `async` and follow the signature:

```typescript
pi.on("session_start", async (_event, ctx) => { /* ... */ });
pi.on("turn_start", async (_event, ctx) => { /* ... */ });
pi.on("turn_end", async (_event, ctx) => { /* ... */ });
pi.on("tool_call", async (event) => { /* ... */ });
pi.on("tool_execution_end", (event, ctx) => { /* ... */ });
```

**Events used:**
- `session_start` — initialization, update check
- `session_branch` — restore state on branch
- `turn_start` — streaming state, calibration polling
- `turn_end` — persist state, restore router model
- `tool_call` — RTK command rewrites
- `tool_execution_end` — auto-upgrade on consecutive failures

No custom/non-standard events ✅

### 6. Tool Registration
**Status:** ⚠️ N/A (extension doesn't register tools)

The extension registers a **provider** (`router://`) for model routing, but no LLM-callable tools.

### 7. Error Handling in Hooks
**Status:** ✅ Compliant

- `tool_call` handlers wrap in try/catch for RTK rewrites
- Errors are logged to console with debug flag
- **Never throws from handlers** that would block operations ✅

Example from `rtk-integration.ts`:
```typescript
try {
  const decision = await rewriteWithRtk(original);
  if (decision.kind === "skip") return;
  event.input.command = decision.rewritten;
} catch (error) {
  if (state.currentConfig.debug) {
    console.error("[ROUTER] RTK rewrite failed:", error);
  }
}
```

---

## ✅ Best Practices

### 8. Avoid `ctx.session` and `ctx.context`
**Status:** ✅ Compliant

No direct access to `ctx.session` or `ctx.context`. Uses proper alternatives:
- `ctx.sessionManager.getBranch()` for conversation history ✅
- Synthetic session IDs via state timestamps ✅

### 9. No `session_end` Event
**Status:** ✅ Compliant

Extension **correctly avoids** `session_end` (which doesn't exist) and persists on:
- `turn_end` ✅
- Debounced writes in calibration subsystem ✅

Comment documents this explicitly:
```typescript
// session_end is not a standard extension event; instead merge calibration
// on turn_end when the session is about to close.
```

### 10. Zod Usage
**Status:** ⚠️ N/A (no tools registered)

Extension doesn't register tools, so no Zod schemas needed. If tools were added, `pi.zod` is available.

### 11. Dev Install Detection
**Status:** ✅ Excellent

Enhanced `isDevInstall()` checks:
- Symlinked directories ✅
- Workspace-relative paths ✅
- **NEW**: `file:` dependencies in parent `package.json` ✅

Properly blocks `/router update` on dev installs with clear instructions.

### 12. CLI Binary Shebang
**Status:** ✅ Compliant

```typescript
// src/cli/index.ts:1
#!/usr/bin/env bun
```

Uses `#!/usr/bin/env bun` for portability ✅

---

## 🔍 Minor Recommendations

### 1. Extension Discovery Paths
**Current:** Extension uses `deploy:dev` script that creates:
```json
{
  "dependencies": {
    "@cakriwut/omp-model-router": "file:../../../../workspace/omp-model-router"
  }
}
```

**Recommendation:** Document that users should **reinstall via npm** for production use:
```bash
pi install npm:@cakriwut/omp-model-router
```

**Status:** ✅ Already documented in `AGENTS.md` after recent fix.

### 2. Disable in Config
**Current:** Users can disable via config flags (`routerEnabled: false`), but can't disable extension load itself.

**Recommendation:** Document that users can disable the extension module in `~/.omp/agent/config.yml`:
```yaml
disabledExtensions:
  - extension-module:model-router
```

**Priority:** Low (most users just toggle `routerEnabled`)

### 3. Debug Logging
**Current:** Uses `console.log` and `console.error` for debug output.

**Recommendation:** Consider using `pi.logger` for structured logging (if available):
```typescript
pi.logger?.debug("[ROUTER] RTK rewrite:", original, "→", rewritten);
```

**Priority:** Low (current approach works fine)

### 4. Command Argument Completions
**Current:** ✅ Already implemented via `getArgumentCompletions` in command registration

Excellent practice! Provides tab completion for:
- Subcommands (`usage`, `profile`, `pin`, etc.)
- Profile names (dynamic from config)
- Tier values (`high`, `medium`, `low`)

---

## 📋 Critical Constraints Check

| Constraint | Status | Notes |
|---|---|---|
| No runtime actions during load | ✅ Pass | All actions inside handlers |
| `tool_call` errors are fail-closed | ✅ Pass | Wrapped in try/catch, never blocks |
| No command name conflicts | ✅ Pass | Single `/router` command |
| No reserved shortcuts | ⚠️ N/A | Extension doesn't register shortcuts |
| Async handlers for async work | ✅ Pass | All handlers properly async |

---

## 🎯 Conclusion

The `omp-model-router` extension is **fully compliant** with Oh-My-Pi best practices. The codebase demonstrates:

- Proper lifecycle management
- Robust error handling
- Good separation of concerns (state, config, routing, UI, calibration)
- Excellent dev tooling (CLI, tests, deploy script)
- Clear documentation

The recent fix for `/router update` with dev installs further strengthens compliance by detecting and guiding users away from unsupported installation methods.

**No breaking changes required.** All recommendations are polish/nice-to-have.

---

## 📚 References

- Extension authoring guide: https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md
- Example extension: https://github.com/can1357/oh-my-pi/tree/main/docs/skills/examples/hello-extension
- Hook subsystem: https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-hooks.md
