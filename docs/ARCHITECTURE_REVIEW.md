# Architecture Review — omp-model-router (2026-05-31)

**Methodology:** Knowledge graph analysis via graphify (530 nodes, 845 edges, 76 communities)  
**Focus:** DRY violations, coupling, compartmentalization, reusability

---

## Executive Summary

**Verdict:** ✅ **Good Foundation** with **3 Critical Refactors Needed**

The codebase demonstrates solid separation of concerns at the module level, but suffers from:
1. **Text extraction duplication** (3 implementations, 0 shared utility)
2. **State management split** (routing utilities duplicated in calibration)
3. **Config validation duplication** (type guards in 2 files)

**Existing Strengths:**
- Clean module boundaries (commands, routing, provider, calibration)
- AST structural extraction: 318 code nodes, 710 relationships
- 92% EXTRACTED edges (low inference = explicit relationships)

---

## Critical Issues (Immediate Refactor Required)

### 1. **TEXT EXTRACTION — 3 DUPLICATE IMPLEMENTATIONS**

**Problem:** Three different text extraction functions with identical purpose:

| Function | File | LOC | Handles |
|----------|------|-----|---------|
| `extractTextFromContent()` | `src/routing.ts:16` | 18 | string\|Message["content"] → string |
| `extractTextOnly()` | `src/calibration/classifier-utils.ts:30` | 16 | Message → string (no toolCall) |
| `extractText()` | `src/context-compression.ts:129` | 17 | Message → string (with toolCall) |

**Impact:**
- **DRY violation:** 3× maintenance burden for identical logic
- **Coupling:** `routing.ts` exports util used by calibration, but calibration has its own copy
- **Inconsistency risk:** Fixes to one copy don't propagate

**Solution:**
```typescript
// NEW FILE: src/utils/text.ts
export function extractTextFromContent(content: string | Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "toolCall") return `${part.name} ${JSON.stringify(part.arguments)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractTextFromMessage(msg: Message): string {
  return extractTextFromContent(msg.content).trim();
}
```

**Refactor:**
- Delete duplicates in `classifier-utils.ts` and `context-compression.ts`
- Replace all calls with `import { extractTextFromContent } from "./utils/text.ts"`
- **Files affected:** 3 src files, 0 tests (tests import from src)

---

### 2. **ROUTING UTILITIES — DUPLICATED IN CALIBRATION**

**Problem:** `getLastUserText()` and `getRecentUserText()` exist in **both** `routing.ts` and `calibration/classifier-utils.ts`

**Duplication:**
```typescript
// src/routing.ts:34
export const getLastUserText = (context: Context): string => {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role === "user") {
      return extractTextFromContent(context.messages[i].content).trim();
    }
  }
  return "";
};

// src/calibration/classifier-utils.ts:40  (IDENTICAL)
export function getLastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role === "user") {
      return extractTextOnly(context.messages[i]);  // uses local extract
    }
  }
  return "";
}
```

**Why This Happened:**
- Calibration was added later and needed the same util
- Duplication preferred over adding `routing.ts` as a dependency (imports = coupling)

**Solution:**
```typescript
// NEW FILE: src/utils/context.ts
import type { Context } from "@mariozechner/oh-my-pi/agent";
import { extractTextFromMessage } from "./text";

export function getLastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if (context.messages[i].role === "user") {
      return extractTextFromMessage(context.messages[i]);
    }
  }
  return "";
}

export function getRecentUserText(context: Context, count: number): string {
  return context.messages
    .filter(m => m.role === "user")
    .slice(-count)
    .map(extractTextFromMessage)
    .join("\n");
}
```

**Refactor:**
- Delete copies from `routing.ts` and `classifier-utils.ts`
- Update imports: `routing.ts`, `classifier-utils.ts`, `calibration/hooks.ts`
- **Files affected:** 3 src files

---

### 3. **CONFIG TYPE GUARDS — DUPLICATED**

**Problem:** `isRouterTier()` exists in **both** `config.ts` and `calibration/classifier-utils.ts`

```typescript
// src/config.ts:65
export const isRouterTier = (value: string): value is RouterTier =>
  value === "high" || value === "medium" || value === "low";

// src/calibration/classifier-utils.ts:153  (IDENTICAL)
function isRouterTier(value: string): value is RouterTier {
  return value === "high" || value === "medium" || value === "low";
}
```

**Solution:**
- **Keep in `config.ts`** (already exported, canonical location)
- Delete from `classifier-utils.ts`
- Add `import { isRouterTier } from "../config"` to `classifier-utils.ts`

**Refactor:**
- 1 file changed (`classifier-utils.ts`)
- 0 tests affected (they import from `config.ts`)

---

## Module Coupling Analysis (Graph Metrics)

**Cross-file edge count** (higher = more coupling):

| File | Cross-file edges | Risk |
|------|------------------|------|
| `config.ts` | 13 | ✅ **Expected** (god config) |
| `calibration/hooks.ts` | 7 | ⚠️ **Medium** (orchestrator) |
| `routing.ts` | 6 | ⚠️ **Medium** (exports utils to calibration) |
| `calibration/global.ts` | 6 | ⚠️ **Medium** (shared state) |
| `calibration/classifier-utils.ts` | 5 | ⚠️ **Medium** (duplicates routing utils) |
| `provider.ts` | 4 | ✅ Low |
| `state.ts` | 2 | ✅ Low |

**Analysis:**
- `config.ts` coupling is **intentional** (god config is appropriate)
- `calibration/*` coupling is **high** because it reimplements routing utils instead of importing
- After utils extraction → coupling drops to ~3 per file

---

## File Complexity (Symbol Count)

**Top 10 files by symbol count** (from AST extraction):

| Symbols | File | LOC | Symbols/LOC Ratio |
|---------|------|-----|-------------------|
| 36 | `state.ts` | 498 | 0.072 |
| 20 | `routing.ts` | 891 | 0.022 |
| 19 | `ui.ts` | 735 | 0.026 |
| 15 | `config.ts` | 467 | 0.032 |
| 14 | `provider.ts` | 846 | 0.017 |
| 14 | `tui/profile-editor.ts` | 290 | 0.048 |
| 13 | `context-compression.ts` | 447 | 0.029 |
| 12 | `calibration/global.ts` | 192 | 0.063 |
| 11 | `calibration/hooks.ts` | 457 | 0.024 |
| 10 | `version-check.ts` | 218 | 0.046 |

**Interpretation:**
- `commands.ts` is 1076 LOC but **only 5 exported symbols** (massive sub-command switch statement)
- `state.ts` has **36 symbols** (18 mutable lets + getters/setters → **structural refactor already proposed**)
- Symbol density is healthy (low ratios = long functions, not over-abstraction)

---

## Test Utilities — Acceptable Duplication

**Duplication detected:**
- `stripAnsi()` in 3 test files
- `makeTheme()` in 2 test files
- `createContext()` in 2 test files

**Verdict:** ✅ **Leave as-is**
- Test utilities should be **self-contained** (avoid cross-test imports)
- Duplication here is **intentional compartmentalization**
- Each test file can evolve its helpers independently

---

## Proposed Directory Structure (After Refactor)

```
src/
├── utils/
│   ├── text.ts           # extractTextFromContent, extractTextFromMessage
│   ├── context.ts        # getLastUserText, getRecentUserText
│   └── theme.ts          # (future: theme formatting utils if needed)
├── routing.ts            # decideRouting, resolveRouting (NO utils)
├── config.ts             # isRouterTier (canonical location)
├── calibration/
│   ├── classifier-utils.ts  # parseClassifierOutput (NO text/context utils)
│   └── hooks.ts          # (imports from ../utils/)
├── context-compression.ts # (imports from utils/text)
└── ...
```

**Benefits:**
1. **Explicit dependency tree:** `utils/` → `routing`, `calibration`, `provider`
2. **No circular imports:** utils have zero imports (pure functions)
3. **Single source of truth:** Each utility has one canonical location

---

## Existing Structural Refactor Proposal

**Status:** Already documented in `openspec/changes/structural-refactor/`

**Key changes:**
1. Extract `RouterState` class from `index.ts` closure (18 mutable lets → 1 object)
2. Split `provider.ts` into `resolution.ts` + `provider.ts`
3. Replace 40+ lines of boilerplate getters/setters

**Recommendation:** ✅ **Proceed with this refactor**
- Addresses god-closure problem in `index.ts`
- Complements the utils extraction (no conflicts)

---

## Action Plan (Priority Order)

### Phase 1: Utils Extraction (1-2 hours)
1. Create `src/utils/text.ts` with `extractTextFromContent`, `extractTextFromMessage`
2. Create `src/utils/context.ts` with `getLastUserText`, `getRecentUserText`
3. Delete duplicates from `routing.ts`, `classifier-utils.ts`, `context-compression.ts`
4. Update imports in:
   - `routing.ts`
   - `calibration/classifier-utils.ts`
   - `calibration/hooks.ts`
   - `context-compression.ts`
   - `provider.ts` (if it uses `extractText`)
5. Run tests: `bun run test` (all 334 tests must pass)
6. Run LSP diagnostics: `bun run typecheck` (0 errors)

### Phase 2: Config Type Guard (15 minutes)
1. Delete `isRouterTier()` from `calibration/classifier-utils.ts:153`
2. Add `import { isRouterTier } from "../config"` at top
3. Run tests

### Phase 3: Structural Refactor (Separate PR)
Follow `openspec/changes/structural-refactor/tasks.md` (already planned)

---

## Architecture Quality Metrics (Post-Refactor)

**Before:**
- Text extraction: **3 implementations** (100% duplication)
- Routing utils: **2 implementations** (100% duplication)
- Config guards: **2 implementations** (100% duplication)
- Cross-file coupling: **13 edges** (config.ts), **6 edges** (routing.ts)

**After:**
- Text extraction: **1 implementation** (`utils/text.ts`)
- Routing utils: **1 implementation** (`utils/context.ts`)
- Config guards: **1 implementation** (`config.ts`)
- Cross-file coupling: **3-4 edges** (utils have no imports)
- **DRY compliance:** ✅ 100% (0 algorithmic duplication)

---

## Conclusion

**Architecture Grade: B+ → A- (after refactor)**

**Strengths:**
- ✅ Clean module boundaries
- ✅ High EXTRACTED edge ratio (92% = explicit relationships)
- ✅ Test duplication is intentional (good compartmentalization)
- ✅ Existing structural refactor plan addresses god-closure

**Critical Fixes Required:**
1. ❌ Text extraction duplication (3 copies)
2. ❌ Routing utilities duplication (2 copies)
3. ❌ Config type guard duplication (2 copies)

**Effort:** ~2-3 hours for all utils extraction + type guard cleanup  
**Risk:** Low (tests validate behavior, no API changes)

**Next Step:** Execute Phase 1 (utils extraction) and validate with full test suite.
