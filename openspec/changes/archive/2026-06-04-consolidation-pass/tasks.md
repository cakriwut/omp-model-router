# Tasks: Consolidation Pass

## Phase 1: Mechanical Deduplication

### Task 1.1: Unify Text Extraction

**Goal:** Consolidate 3 text extraction implementations into 1 configurable function.

**Current implementations:**
- `routing.ts:extractTextFromContent` (includeThinking=true, toolCall=args)
- `classifier-utils.ts:extractTextOnly` (includeThinking=false, toolCall=skip)
- `context-compression.ts:extractText` (includeThinking=true, toolCall=name-only)

**Steps:**

1. Create `src/message-text.ts`:
```ts
export type TextExtractionOpts = {
  includeThinking?: boolean;      // Default: true
  toolCallFormat?: "args" | "name-only" | "skip";  // Default: "args"
};

export const extractMessageText = (
  msg: Message,
  opts: TextExtractionOpts = {}
): string => {
  const { includeThinking = true, toolCallFormat = "args" } = opts;
  
  if (typeof msg.content === "string") return msg.content;
  
  return msg.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return includeThinking ? part.thinking : "";
      if (part.type === "toolCall") {
        if (toolCallFormat === "skip") return "";
        if (toolCallFormat === "name-only") return part.name;
        return `${part.name} ${JSON.stringify(part.arguments)}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
};
```

2. Update `routing.ts`:
```ts
import { extractMessageText } from "./message-text";

export const extractTextFromContent = (content: string | Message["content"]): string => {
  if (typeof content === "string") return content;
  return extractMessageText({ content } as Message, { toolCallFormat: "args" });
};
```

3. Update `classifier-utils.ts`:
```ts
import { extractMessageText } from "../message-text";

function extractTextOnly(msg: Message): string {
  return extractMessageText(msg, { includeThinking: false, toolCallFormat: "skip" });
}
```

4. Update `context-compression.ts`:
```ts
import { extractMessageText } from "./message-text";

function extractText(msg: Message): string {
  return extractMessageText(msg, { toolCallFormat: "name-only" });
}
```

5. Run tests:
```bash
bun test
```

6. Commit:
```bash
git add src/message-text.ts src/routing.ts src/calibration/classifier-utils.ts src/context-compression.ts
git commit -m "refactor: unify text extraction into message-text.ts"
```

**Acceptance:** All 334 tests pass. Zero behavior change verified by test suite.

---

### Task 1.2: Delete Duplicate Context Helpers

**Goal:** Remove `getLastUserText` duplication.

**Steps:**

1. Delete duplicate in `classifier-utils.ts`:
```bash
# Verify routing.ts has the canonical implementation
grep -A 10 "export const getLastUserText" src/routing.ts

# Check classifier-utils.ts uses it
grep -n "getLastUserText" src/calibration/classifier-utils.ts
```

2. Update `classifier-utils.ts` to import from `routing.ts`:
```ts
import { getLastUserText, getRecentUserText } from "../routing";
```

3. Delete the duplicate function (lines ~40-50 in `classifier-utils.ts`).

4. Run tests:
```bash
bun test
```

5. Commit:
```bash
git add src/calibration/classifier-utils.ts
git commit -m "refactor: remove duplicate getLastUserText, import from routing"
```

**Acceptance:** All 334 tests pass. `classifier-utils.ts` imports `getLastUserText` from `routing.ts`.

---

### Task 1.3: Delete Duplicate Type Guard

**Goal:** Remove `isRouterTier` duplication.

**Steps:**

1. Verify `config.ts` has the canonical implementation:
```bash
grep -A 5 "export function isRouterTier" src/config.ts
```

2. Update `classifier-utils.ts` to import from `config.ts`:
```ts
import { isRouterTier } from "../config";
```

3. Delete the duplicate function (lines ~150-160 in `classifier-utils.ts`).

4. Run tests:
```bash
bun test
```

5. Commit:
```bash
git add src/calibration/classifier-utils.ts
git commit -m "refactor: remove duplicate isRouterTier, import from config"
```

**Acceptance:** All 334 tests pass. `classifier-utils.ts` imports `isRouterTier` from `config.ts`.

---

### Task 1.4: Extract Test Helpers

**Goal:** Centralize test helpers to reduce duplication across test files.

**Steps:**

1. Create `test/_helpers/ansi.ts`:
```ts
export const stripAnsi = (str: string): string => {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
};
```

2. Create `test/_helpers/theme.ts`:
```ts
import type { Theme } from "../src/ui";

export const createMockTheme = (): Theme => ({
  primary: (s: string) => s,
  secondary: (s: string) => s,
  success: (s: string) => s,
  warning: (s: string) => s,
  error: (s: string) => s,
  dim: (s: string) => s,
  badge: (s: string, color?: string) => s,
  code: (s: string) => s,
  bold: (s: string) => s,
});
```

3. Create `test/_helpers/tokens.ts`:
```ts
import type { Message, Context } from "oh-my-pi";

export const estimateMessageTokens = (msg: Message): number => {
  // Simple heuristic: 1 token ≈ 4 chars
  const text = typeof msg.content === "string" 
    ? msg.content 
    : msg.content.map(p => p.type === "text" ? p.text : "").join("");
  return Math.ceil(text.length / 4);
};

export const estimateContextTokens = (ctx: Context): number => {
  return ctx.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
};
```

4. Update test files to import helpers:
```ts
// tier-label-display.test.ts, usage-compression-diagnostic.test.ts, session-metrics-reset.test.ts
import { stripAnsi } from "./_helpers/ansi";

// Any tests creating themes
import { createMockTheme } from "./_helpers/theme";

// Any tests estimating tokens
import { estimateMessageTokens, estimateContextTokens } from "./_helpers/tokens";
```

5. Delete inline helper definitions in test files.

6. Run tests:
```bash
bun test
```

7. Commit:
```bash
git add test/_helpers/ test/*.test.ts
git commit -m "refactor: extract test helpers into test/_helpers/"
```

**Acceptance:** All 334 tests pass. Test helpers centralized in `test/_helpers/`.

---

## Phase 2: File Splits

### Task 2.1: Split commands.ts

**Goal:** Split 1076-line `commands.ts` into 7 subcommand handlers + dispatcher.

**Steps:**

1. Create `src/commands/` directory:
```bash
mkdir -p src/commands
```

2. Extract shared helpers to `src/commands/shared.ts`:
```ts
export const resolveConfigValue = (...) => { ... };
export const applyConfigUpdate = (...) => { ... };
```

3. Extract subcommand handlers:
- `src/commands/usage.ts` — `handleUsage`
- `src/commands/profile.ts` — `handleProfile`
- `src/commands/pin.ts` — `handlePin`
- `src/commands/set.ts` — `handleSet`
- `src/commands/update.ts` — `handleUpdate`
- `src/commands/help.ts` — `handleHelp`

4. Create `src/commands/index.ts` dispatcher:
```ts
import { handleUsage } from "./usage";
import { handleProfile } from "./profile";
// ... other imports

export const registerCommands = (ctx: ExtensionContext, state: RouterState) => {
  ctx.commands.register("router", async (args) => {
    const subcommand = args[0];
    
    switch (subcommand) {
      case "usage": return handleUsage(ctx, state, args.slice(1));
      case "profile": return handleProfile(ctx, state, args.slice(1));
      case "pin": return handlePin(ctx, state, args.slice(1));
      case "set": return handleSet(ctx, state, args.slice(1));
      case "update": return handleUpdate(ctx, state, args.slice(1));
      case "help": 
      default: return handleHelp(ctx);
    }
  });
};
```

5. Update `src/index.ts` to import from new location:
```ts
import { registerCommands } from "./commands";
```

6. Delete old `src/commands.ts`.

7. Run tests:
```bash
bun test
```

8. Commit:
```bash
git add src/commands/ src/index.ts
git rm src/commands.ts
git commit -m "refactor: split commands.ts into subcommand handlers"
```

**Acceptance:** All 334 tests pass. `/router` commands work in manual smoke test.

---

### Task 2.2: Split routing.ts

**Goal:** Split 891-line `routing.ts` into text / heuristic / compose / orchestration.

**Steps:**

1. Create `src/routing/` directory:
```bash
mkdir -p src/routing
```

2. Extract text helpers to `src/routing/text.ts`:
```ts
export const extractTextFromContent = (...) => { ... };
export const getLastUserText = (...) => { ... };
export const getRecentConversationText = (...) => { ... };
```

3. Extract heuristic to `src/routing/heuristic.ts`:
```ts
export const decideRouting = (...) => { ... };
// Keyword arrays
const highSignals = [...];
const lowSignals = [...];
```

4. Extract tier resolution to `src/routing/compose.ts`:
```ts
export const resolveRouting = (...) => { ... };
export const applyOverrides = (...) => { ... };
```

5. Keep classifier orchestration in `src/routing/index.ts`:
```ts
import { decideRouting } from "./heuristic";
import { resolveRouting } from "./compose";
import { getLastUserText } from "./text";

// Classifier orchestration + re-exports
export * from "./text";
export * from "./heuristic";
export * from "./compose";
```

6. Update imports in other files:
```ts
// No changes needed if they import from "routing" (re-exports handle it)
// If they import from "routing.ts" explicitly, update path
```

7. Delete old `src/routing.ts`.

8. Run tests:
```bash
bun test
```

9. Commit:
```bash
git add src/routing/
git rm src/routing.ts
git commit -m "refactor: split routing.ts into text/heuristic/compose layers"
```

**Acceptance:** All 334 tests pass. Routing decisions work in manual smoke test.

---

### Task 2.3: Split ui.ts

**Goal:** Split 735-line `ui.ts` into status / usage / profile / theme.

**Steps:**

1. Create `src/ui/` directory:
```bash
mkdir -p src/ui
```

2. Extract modules:
- `src/ui/status.ts` — `updateStatus`, `buildStatusLines`
- `src/ui/usage.ts` — `renderUsageReport`, token/cost formatting
- `src/ui/profile.ts` — `renderProfileHelp`
- `src/ui/theme.ts` — `makeTheme`

3. Create `src/ui/index.ts` with re-exports:
```ts
export * from "./status";
export * from "./usage";
export * from "./profile";
export * from "./theme";
```

4. Update imports in other files (no changes needed if they import from "ui").

5. Delete old `src/ui.ts`.

6. Run tests:
```bash
bun test
```

7. Commit:
```bash
git add src/ui/
git rm src/ui.ts
git commit -m "refactor: split ui.ts into status/usage/profile/theme modules"
```

**Acceptance:** All 334 tests pass. `/router usage` and status widget render correctly.

---

### Task 2.4: Move Compression Decision

**Goal:** Move compression decision from `provider.ts` to `context-compression.ts`.

**Steps:**

1. Add `shouldCompress` and `compressIfNeeded` to `context-compression.ts`:
```ts
export const shouldCompress = (
  context: Context,
  config: RouterConfig,
  state: RouterState
): boolean => {
  const contextTokens = estimateContextSize(context);
  const contextLimit = state.getContextLimit();
  const idleTime = Date.now() - state.lastUserMessageAt;
  const excluded = config.historyCompression?.excludeModels || [];
  const modelName = state.currentModel;
  
  return (
    contextTokens > contextLimit * 0.8 ||
    idleTime > 5 * 60 * 1000 ||
    excluded.includes(modelName)
  );
};

export const compressIfNeeded = (
  context: Context,
  config: RouterConfig,
  state: RouterState
): Context => {
  if (!shouldCompress(context, config, state)) return context;
  return compressContext(context, config);
};
```

2. Update `provider.ts` to call `compressIfNeeded`:
```ts
import { compressIfNeeded } from "./context-compression";

// In provideLLM:
const finalContext = compressIfNeeded(context, config, state);
const response = await llm.stream(finalContext, ...);
```

3. Delete compression decision logic from `provider.ts` (lines ~170-180).

4. Run tests:
```bash
bun test
```

5. Commit:
```bash
git add src/context-compression.ts src/provider.ts
git commit -m "refactor: move compression decision to context-compression.ts"
```

**Acceptance:** All 334 tests pass. Compression still triggers at 80% context or 5min idle.

---

### Task 2.5: Separate State Persistence

**Goal:** Separate state persistence I/O from session lifecycle.

**Steps:**

1. Create `src/state/` directory:
```bash
mkdir -p src/state
```

2. Create `src/state/persist.ts`:
```ts
import type { RouterState } from "./index";
import type { ExtensionContext } from "oh-my-pi";

export const buildPersistedState = (state: RouterState): Record<string, unknown> => {
  return {
    decisions: state.decisions,
    metrics: state.metrics,
    confusionMatrix: state.confusionMatrix,
    // ... 15 more fields
  };
};

export const persist = (ctx: ExtensionContext, state: RouterState): void => {
  const data = buildPersistedState(state);
  ctx.sessionManager.persistData("model-router", data);
};

export const restoreFromSession = (ctx: ExtensionContext, state: RouterState): void => {
  const data = ctx.sessionManager.retrieveData("model-router");
  if (!isRouterPersistedState(data)) return;
  
  // Restore fields onto state instance
  state.decisions = data.decisions || [];
  state.metrics = data.metrics || {};
  // ... restore all fields
};
```

3. Update `src/state/index.ts` (rename from `state.ts`):
```ts
import { persist as persistImpl, restoreFromSession as restoreImpl } from "./persist";

export class RouterState {
  // Business logic: recordDecision, getThinkingOverride, updateMetrics
  
  persist(ctx: ExtensionContext): void {
    return persistImpl(ctx, this);
  }
  
  restoreFromSession(ctx: ExtensionContext): void {
    return restoreImpl(ctx, this);
  }
}

// Re-export persist for testing
export { buildPersistedState, isRouterPersistedState } from "./persist";
```

4. Update imports in other files (change `from "./state"` to `from "./state/index"` if needed).

5. Delete old `src/state.ts`.

6. Run tests:
```bash
bun test
```

7. Commit:
```bash
git add src/state/
git rm src/state.ts
git commit -m "refactor: separate state persistence I/O into state/persist.ts"
```

**Acceptance:** All 334 tests pass. Session restore works in manual smoke test (`/reload`, verify state persists).

---

## Final Verification

### Step 1: Run Full Test Suite
```bash
bun test
```
**Expected:** All 334 tests pass.

### Step 2: Deploy and Manual Smoke Test
```bash
bun run deploy:dev
```

In OMP:
```
/reload
/router                        # Check status widget
/router usage                  # Verify usage report
/router profile hybrid         # Test profile switch
/router pin high               # Test tier pinning
```

**Expected:** All commands work. No runtime errors.

### Step 3: Graph Re-Analysis
```bash
/graphify . --update
```

**Expected:**
- Betweenness centrality: all files < 0.05 (down from 0.09-0.12)
- Zero duplicate function names in "DRY violations" section
- Zero files > 500 LOC

### Step 4: Git History Audit
```bash
git log --oneline --all | head -20
```

**Expected:** 9 commits (4 in Phase 1, 5 in Phase 2), each with passing tests.

---

## Rollback Plan

If any task fails:
```bash
git revert HEAD
bun test                       # Verify rollback works
```

If Phase 2 must be aborted mid-way:
```bash
git revert <hash-of-last-good-phase1-commit>..HEAD
bun test
```

Phase 1 can ship independently (mechanical deduplication has value on its own).

---

## Done Criteria

- [ ] All 334 tests pass after each commit
- [ ] Zero files > 500 LOC
- [ ] Betweenness centrality: all files < 0.05
- [ ] 1 text extraction implementation (was 3)
- [ ] Zero duplicate helper functions (was 2)
- [ ] Manual smoke test passes (all `/router` commands work)
- [ ] Graph re-analysis confirms metrics improved
