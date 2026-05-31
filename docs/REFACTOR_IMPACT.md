# Refactor Impact — Before/After Visualization

## Text Extraction Duplication (BEFORE)

```
routing.ts
  ├─ extractTextFromContent()  [18 LOC]
  └─ imported by: provider.ts, commands.ts

calibration/classifier-utils.ts
  ├─ extractTextOnly()  [16 LOC]
  └─ imported by: classifier-utils.ts (self), hooks.ts

context-compression.ts
  ├─ extractText()  [17 LOC]
  └─ imported by: context-compression.ts (self)

TOTAL: 51 LOC, 3 implementations, 0 shared
```

## Text Extraction (AFTER)

```
utils/text.ts
  ├─ extractTextFromContent()  [18 LOC]
  ├─ extractTextFromMessage()  [3 LOC]
  └─ imported by:
      ├─ routing.ts
      ├─ calibration/classifier-utils.ts
      ├─ calibration/hooks.ts
      ├─ context-compression.ts
      └─ provider.ts

TOTAL: 21 LOC, 1 implementation, 5 consumers
SAVINGS: 30 LOC removed, 5 import statements added
```

---

## Routing Utilities Duplication (BEFORE)

```
routing.ts
  ├─ getLastUserText()  [9 LOC]
  ├─ getRecentUserText()  [12 LOC]
  └─ imported by: routing.ts (self), provider.ts

calibration/classifier-utils.ts
  ├─ getLastUserText()  [9 LOC]  [DUPLICATE]
  └─ imported by: classifier-utils.ts (self), hooks.ts

TOTAL: 30 LOC, 2 implementations
```

## Routing Utilities (AFTER)

```
utils/context.ts
  ├─ getLastUserText()  [9 LOC]
  ├─ getRecentUserText()  [12 LOC]
  └─ imported by:
      ├─ routing.ts
      ├─ calibration/classifier-utils.ts
      ├─ calibration/hooks.ts
      └─ provider.ts

TOTAL: 21 LOC, 1 implementation, 4 consumers
SAVINGS: 9 LOC removed
```

---

## Config Type Guard Duplication (BEFORE)

```
config.ts
  ├─ isRouterTier()  [2 LOC]
  └─ exported (public API)

calibration/classifier-utils.ts
  ├─ isRouterTier()  [2 LOC]  [DUPLICATE]
  └─ private function

TOTAL: 4 LOC, 2 implementations
```

## Config Type Guard (AFTER)

```
config.ts
  ├─ isRouterTier()  [2 LOC]
  └─ imported by:
      ├─ calibration/classifier-utils.ts
      ├─ routing.ts
      └─ provider.ts

TOTAL: 2 LOC, 1 implementation, 3 consumers
SAVINGS: 2 LOC removed
```

---

## Summary

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Text extraction implementations** | 3 | 1 | -66% |
| **Routing util implementations** | 2 | 1 | -50% |
| **Type guard implementations** | 2 | 1 | -50% |
| **Total duplicated LOC** | 85 | 44 | **-41 LOC** |
| **DRY violations** | 7 | 0 | ✅ **0 duplication** |
| **Cross-file coupling** | 13 (config), 6 (routing) | 4 (utils avg) | -69% (routing) |

---

## Dependency Graph (AFTER)

```
utils/
  ├─ text.ts          (0 imports, pure functions)
  └─ context.ts       (imports: text.ts)
      ↓
config.ts             (imports: types.ts)
      ↓
routing.ts            (imports: utils/text, utils/context, config)
      ↓
calibration/
  ├─ classifier-utils.ts  (imports: utils/text, utils/context, config)
  └─ hooks.ts        (imports: utils/text, utils/context, routing)
      ↓
provider.ts           (imports: routing, config)
context-compression.ts (imports: utils/text)
```

**Key Properties:**
- ✅ **Acyclic:** No circular imports
- ✅ **Layered:** utils → config → routing → calibration → provider
- ✅ **Single source of truth:** Each utility has one canonical location
- ✅ **Low coupling:** utils/ has 0 external dependencies

---

## Test Impact

**No test changes required** — all tests import from public APIs:

```typescript
// Tests continue to work unchanged
import { extractTextFromContent } from "../src/routing";  // → now re-exported from utils/text
import { isRouterTier } from "../src/config";            // → unchanged
```

**Strategy:**
1. `routing.ts` re-exports `extractTextFromContent` from `utils/text` (backward compat)
2. Gradually update imports to `utils/text` in new code
3. Eventually deprecate re-export (breaking change, semver major)

---

## Rollout Strategy

### Step 1: Create utils/ with backward compat (Non-breaking)
```typescript
// src/utils/text.ts
export function extractTextFromContent(...) { ... }

// src/routing.ts (temporary re-export)
export { extractTextFromContent } from "./utils/text";
```

### Step 2: Update internal imports
```diff
// src/calibration/classifier-utils.ts
- function extractTextOnly(msg: Message): string { ... }
+ import { extractTextFromMessage } from "../utils/text";
```

### Step 3: Deprecate re-exports (v0.8.0)
```typescript
// src/routing.ts
/** @deprecated Use `import { extractTextFromContent } from "./utils/text"` instead */
export { extractTextFromContent } from "./utils/text";
```

### Step 4: Remove re-exports (v1.0.0)
Breaking change — users must update imports.

---

## Verification Checklist

- [ ] All 334 tests pass (`bun run test`)
- [ ] No TypeScript errors (`bun run typecheck`)
- [ ] No LSP diagnostics (`bun run lint`)
- [ ] Dep graph is acyclic (check with `madge --circular src/`)
- [ ] No runtime errors (`bun run deploy:dev` + manual smoke test)
- [ ] Backward compat maintained (re-exports in place)
