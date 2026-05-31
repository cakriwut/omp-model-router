# Design: Consolidation Pass

## Analysis

### Graph Metrics (Before)

**File complexity (symbol count per file):**
```
36  src/state.ts
20  src/routing.ts
19  src/ui.ts
15  src/config.ts
14  src/provider.ts
14  src/tui/profile-editor.ts
13  src/context-compression.ts
```

**File sizes (LOC):**
```
1076  src/commands.ts
 891  src/routing.ts
 846  src/provider.ts
 735  src/ui.ts
 498  src/state.ts
 467  src/config.ts
```

**Betweenness centrality (coupling):**
```
0.120  commands.ts
0.110  routing.ts
0.095  provider.ts
0.089  ui.ts
```

**Verified duplications:**
1. Text extraction: 3 implementations
   - `routing.ts:16` — `extractTextFromContent`
   - `classifier-utils.ts:30` — `extractTextOnly`
   - `context-compression.ts:129` — `extractText`
   
2. Context helpers: 2 copies
   - `routing.ts:35` — `getLastUserText`
   - `classifier-utils.ts:40` — `getLastUserText`
   
3. Type guards: 2 copies
   - `config.ts:65` — `isRouterTier`
   - `classifier-utils.ts:150` — `isRouterTier`

4. Test helpers: 3+ copies
   - `stripAnsi` in 3 test files
   - Token estimators in 2 test files
   - `makeTheme` in 2 test files

## Phase 1: Mechanical Deduplication

### Task 1.1: Unify Text Extraction

**Problem:** 3 implementations with subtle differences.

**Comparison:**
```typescript
// routing.ts:16 (most complete)
export const extractTextFromContent = (content: string | Message["content"]): string => {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "toolCall") return `${part.name} ${JSON.stringify(part.arguments)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

// classifier-utils.ts:30 (incomplete — no toolCall handling)
function extractTextOnly(msg: Message): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      return "";
    })
    .join(" ");
}

// context-compression.ts:129 (no thinking, no toolCall)
function extractText(msg: Message): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}
```

**Decision:** Create unified `extractMessageText` in new `src/lib/message-text.ts`:

```typescript
export interface ExtractOptions {
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  separator?: string;
}

export function extractMessageText(
  content: string | Message["content"],
  opts: ExtractOptions = {}
): string {
  const {
    includeThinking = true,
    includeToolCalls = true,
    separator = "\n",
  } = opts;

  if (typeof content === "string") return content;

  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking" && includeThinking) return part.thinking;
      if (part.type === "toolCall" && includeToolCalls)
        return `${part.name} ${JSON.stringify(part.arguments)}`;
      return "";
    })
    .filter(Boolean)
    .join(separator);
}

// Convenience wrapper for Message objects
export function extractText(msg: Message, opts?: ExtractOptions): string {
  return extractMessageText(msg.content, opts);
}
```

**Migration:**
1. Create `src/lib/message-text.ts`
2. Replace all 3 call sites with new API
3. Delete old implementations

**Call sites:**
- `routing.ts` — 4 uses of `extractTextFromContent` → `extractMessageText`
- `classifier-utils.ts` — 2 uses of `extractTextOnly` → `extractText(msg, {separator: " "})`
- `context-compression.ts` — many uses of `extractText` → `extractText(msg, {includeThinking: false, includeToolCalls: false})`

### Task 1.2: Deduplicate Context Helpers

**Problem:** `getLastUserText` duplicated in routing.ts and classifier-utils.ts.

**Comparison:**
```typescript
// routing.ts:35 (canonical)
export const getLastUserText = (context: Context): string => {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message.role === "user") {
      return extractTextFromContent(message.content).trim();
    }
  }
  return "";
};

// classifier-utils.ts:40 (duplicate)
export function getLastUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "user") {
      return extractTextOnly(msg).trim();
    }
  }
  return "";
}
```

**Decision:** Keep `routing.ts` version (already exported, used by 3 files). Delete `classifier-utils.ts` copy.

**Migration:**
1. Import from `routing.ts` in `classifier-utils.ts`
2. Delete duplicate implementation
3. Verify all call sites still work

### Task 1.3: Deduplicate Type Guards

**Problem:** `isRouterTier` duplicated in config.ts and classifier-utils.ts.

**Comparison:**
```typescript
// config.ts:65 (canonical)
export function isRouterTier(value: string): value is RouterTier {
  return value === "high" || value === "medium" || value === "low";
}

// classifier-utils.ts:150 (duplicate)
function isRouterTier(value: string): value is RouterTier {
  return value === "high" || value === "medium" || value === "low";
}
```

**Decision:** Keep `config.ts` version (config owns types). Delete `classifier-utils.ts` copy.

**Migration:**
1. Import from `config.ts` in `classifier-utils.ts`
2. Delete duplicate implementation

### Task 1.4: Extract Test Helpers

**Problem:** Test utilities redefined in 3+ test files.

**Found duplicates:**
- `stripAnsi` in `tier-label-display.test.ts`, `badge-logging.test.ts`, `debug-log-management.test.ts`
- Token estimators in multiple test files
- `makeTheme` in 2 test files

**Decision:** Create `test/_helpers/` directory with:
- `test/_helpers/ansi.ts` — `stripAnsi`
- `test/_helpers/theme.ts` — `makeTheme`, mock themes
- `test/_helpers/tokens.ts` — token counting utilities

**Migration:**
1. Create `test/_helpers/` structure
2. Move implementations to helpers
3. Replace inline definitions with imports
4. Run `bun test` to verify

## Implementation Order

**Commit 1:** Task 1.1 (unify text extraction)  
**Commit 2:** Task 1.2 (deduplicate getLastUserText)  
**Commit 3:** Task 1.3 (deduplicate isRouterTier)  
**Commit 4:** Task 1.4 (extract test helpers)  

Each commit:
- Atomic (one logical change)
- Tests pass after commit
- Can be reverted independently

## Verification

After each commit:
```bash
bun test                    # All tests pass
bun run typecheck           # No type errors
bun run lint                # No lint errors (if linter present)
```

After Phase 1 complete:
```bash
/graphify . --update        # Re-analyze graph
# Expect: "Text extraction implementations: 1 (was 3)"
# Expect: "Duplicate helper functions: 0 (was 2)"
```

## Rollback Plan

**Per-commit rollback:**
```bash
git revert HEAD
bun test
```

**Full Phase 1 rollback:**
```bash
git revert <hash>..HEAD     # Revert commits 1-4
bun test
```

Each task is independent — can revert any single commit without breaking others.

## Benefits

**Immediate:**
- Bug fixes in one place (was 3)
- Future changes happen once (no N edits)
- Tests more maintainable (shared helpers)

**Long-term:**
- Easier onboarding (one canonical location per concern)
- Safer refactors (change once, tests verify all call sites)
- Lower cognitive load (no "which implementation do I use?")

## Risks

**Low risk because:**
- All changes mechanical (no logic changes)
- TypeScript catches import errors at compile time
- Tests verify behavior unchanged
- Each commit atomic (easy rollback)

**Possible failures:**
- Import cycle (mitigated by layered architecture)
- Test flakiness (mitigated by running full suite per commit)
- Subtle behavioral difference in duplicates (mitigated by reading all 3 implementations first)

## Success Criteria

- [ ] 1 text extraction implementation (was 3)
- [ ] 0 duplicate context helpers (was 2)
- [ ] 0 duplicate type guards (was 2)
- [ ] All test helpers centralized in `test/_helpers/`
- [ ] All 334 tests pass
- [ ] No type errors
- [ ] Manual smoke test: `/router`, `/router usage`, `/router profile auto`
