# Tasks: Classifier Tool-Mix Signal

## Execution Order

Task 1 is a **prerequisite** (trace bug fix) — it does not gate the bucket implementation itself but must land before Task 7's empirical validation.

Tasks 2 → 3 → 4 → 5 are the implementation spine in dependency order. Task 6 (unit tests) can land alongside each implementation task. Task 7 is post-deployment.

**Dependency on Phase 1 (`classifier-prompt-cache`):** Task 4 modifies the cache-key construction added by Phase 1. Phase 1 MUST be merged and deployed before starting Task 4.

---

## Task 1: Fix `toolResultCount` Trace Bug (Prerequisite)

### 1.1: Locate the bug in promptFeatures extraction
**Files:** `src/calibration/*.ts` (likely `agent.ts`, `hooks.ts`, or `trace.ts` — the field is written when promptFeatures are recorded).

**Steps:**
1. Search for `toolResultCount` writes: `search` for `toolResultCount` across `src/`.
2. Identify the extraction site — it should count `role === "toolResult"` messages in `context.messages` (or the equivalent block-walking pattern used in `context-compression.ts`).
3. Verify the bug: traces consistently show `toolResultCount: 0` even when the assistant has clearly received tool output (cross-check against `serializeToolSequence` output which does see `toolResult` messages).
4. Fix the counting logic. Likely causes:
   - Counting on the wrong message role (`assistant` instead of `toolResult`).
   - Counting only top-level results and missing array-form `content` traversal.
   - Reading from a stale snapshot taken before tool results were appended.

**Acceptance:**
- A trace from a session with `≥1` tool round-trip shows `toolResultCount > 0`.
- Existing tests still pass.
- The number matches `serializeToolSequence`'s observed `result(...)` count for the same window.

### 1.2: Add a regression test
**File:** `test/calibration-trace.test.ts` (create if missing) or extend nearest existing calibration test.

**Test case:** Construct a `Context` with one user message, one assistant message containing a `toolCall` block, and one `toolResult` message. Run the promptFeatures extraction and assert `toolResultCount === 1`.

**Acceptance:** Test passes against the fix, fails against the unfixed code.

---

## Task 2: Add `extractRecentToolCalls(context)` to `src/utils/messages.ts`

### 2.1: Implement the extractor
**File:** `src/utils/messages.ts`

**Signature:**
```typescript
export function extractRecentToolCalls(
    context: Context,
): { counts: Record<string, number>; names: string[] };
```

**Steps:**
1. Iterate `context.messages` from the end backwards.
2. Stop (exclusive) at the first message with `role === "user"`.
3. For each `assistant` message in the window with `Array.isArray(msg.content)`, push `block.name` for every block where `block.type === "toolCall"` and `typeof block.name === "string"`.
4. Reverse the collected list to chronological order.
5. Slice to the **last 12** entries (`names.slice(-12)`).
6. Aggregate into `counts` via a single pass.

**Reference shape:** mirror the block-walking pattern in `src/context-compression.ts:219-240` (`serializeToolSequence`) — same `Array.isArray(msg.content)` + `block.type === "toolCall"` + `block.name` assumption.

**Acceptance:**
- Returns `{ counts: {}, names: [] }` when there are no assistant messages since the last user message.
- Returns `{ counts: {}, names: [] }` when assistant messages have no `toolCall` blocks (text-only).
- Respects the 12-entry cap by keeping the **most recent** entries.
- Never reads `block.arguments` or `toolResult` message content.

---

## Task 3: Add `getBucket(counts)` Helper

### 3.1: Implement bucket categorization
**File:** Collocate in `src/utils/messages.ts` (preferred — already the home of the extractor) OR `src/routing/tool-mix.ts` (acceptable if `messages.ts` exceeds a comfortable size).

**Signature:**
```typescript
export type Bucket =
    | "exploration"
    | "implementation"
    | "verification"
    | "delegation"
    | "mixed"
    | "fresh";

export function getBucket(counts: Record<string, number>): Bucket;
```

**Steps:**
1. Declare the category map as a module-scope constant:
   ```typescript
   const TOOL_CATEGORIES: Record<string, Exclude<Bucket, "mixed" | "fresh" | "other">> = {
       read: "exploration", search: "exploration", find: "exploration",
       ast_grep: "exploration", lsp_hover: "exploration",
       lsp_references: "exploration", lsp_definition: "exploration",
       lsp_symbols: "exploration", web_search: "exploration",
       browser: "exploration",
       edit: "implementation", write: "implementation",
       ast_edit: "implementation", lsp_rename: "implementation",
       lsp_code_actions: "implementation",
       debug: "verification",
       // bash: intentionally NOT mapped — buckets to "other" by default
       // (cannot disambiguate test/lint vs. general shell without arg inspection)
       task: "delegation", eval: "delegation",
   };
   ```
2. Compute `total = sum(Object.values(counts))`. If `total < 2` → return `"fresh"`.
3. Build `categoryTotals: Record<string, number>` by folding `counts` through `TOOL_CATEGORIES`. Unmapped names go to a synthetic `"other"` bucket included in the total but excluded from the winner search.
4. Find the category with the maximum share among the four named buckets (exploration / implementation / verification / delegation). If `maxShare / total >= 0.60` → return that category.
5. Otherwise → return `"mixed"`.

**Acceptance:**
- `getBucket({}) === "fresh"` and `getBucket({ read: 1 }) === "fresh"` (total < 2).
- `getBucket({ read: 4, search: 2, edit: 1 }) === "exploration"` (6/7 ≈ 86% ≥ 60%).
- `getBucket({ read: 3, edit: 3 }) === "mixed"` (no category ≥ 60%).
- `getBucket({ task: 5, eval: 3 }) === "delegation"` (8/8 = 100%).
- `getBucket({ bash: 10 }) === "mixed"` (bash unmapped → "other" → no named winner) — documents the bash limitation.

---

## Task 4: Extend Cache Key in `src/routing/compose.ts`

### 4.1: Plumb bucket into the Phase 1 signature
**File:** `src/routing/compose.ts`
**Lines:** wherever Phase 1 (`classifier-prompt-cache`) builds `sig` (likely in the classifier-gating block at compose.ts:171-235 per shared context).

**Steps:**
1. Import `extractRecentToolCalls` and `getBucket` from `../utils/messages.js`.
2. Immediately after Phase 1 computes `lastUserText` and `userMsgIndex`, call:
   ```typescript
   const { counts } = extractRecentToolCalls(input.context);
   const bucket = getBucket(counts);
   ```
3. Change the signature construction:
   ```typescript
   // Before (Phase 1):
   const sig = `${lastUserText}|${userMsgIndex}`;
   // After (Phase 2):
   const sig = `${lastUserText}|${userMsgIndex}|${bucket}`;
   ```
4. Pass `counts` forward to `buildClassifierPrompt` (see Task 5) only on cache MISS — Phase 1's cache HIT path remains untouched.

**Acceptance:**
- Cache key changes when bucket transitions (e.g., 7 reads → +5 edits flips `exploration` → `mixed`).
- Cache key is stable when only counts grow within the same bucket (e.g., 6 reads → 8 reads, still `exploration`).
- `fresh` is a valid stable bucket value early in a session.
- No change to Phase 1's TTL, calibration-on-hit, or context-capacity invalidation logic.

### 4.2: Unit test cache invalidation on bucket transition
**File:** `test/classifier-cache.test.ts` (extend the Phase 1 test file).

**Test case:**
1. Build a Phase 1 cache HIT scenario (same user text, two consecutive turns, bucket = `exploration`).
2. Add 5 `edit` toolCalls to the second turn's context so bucket flips to `mixed` or `implementation`.
3. Assert `runClassifier` is invoked again (cache MISS) on the second turn.

**Acceptance:** Test passes — bucket transition reliably busts the cache.

---

## Task 5: Inject Tool-Count Summary into `buildClassifierPrompt`

### 5.1: Surface the counts line
**File:** `src/calibration/classifier-utils.ts`
**Function:** `buildClassifierPrompt` (line ~84)

**Steps:**
1. Extend the signature (additive optional parameter — preserves existing callers):
   ```typescript
   export function buildClassifierPrompt(
       context: Context,
       currentPhase?: RouterPhase,
       toolCounts?: Record<string, number>,
   ): string
   ```
2. Build the summary line when `toolCounts` is provided and non-empty:
   ```typescript
   const entries = Object.entries(toolCounts ?? {})
       .sort((a, b) => b[1] - a[1]);
   const activityLine = entries.length
       ? `Recent agent activity (last 12 tool calls): ${entries.map(([n, c]) => `${n}×${c}`).join(" ")}`
       : "";
   ```
3. Insert `activityLine` into the assembled prompt immediately after the history block (output of `getConversationSummary`) and before the tier definitions. Use a single blank line separator. Omit entirely when empty.

**Acceptance:**
- Prompt contains exactly one `Recent agent activity (last 12 tool calls): ...` line when counts are non-empty.
- Prompt is byte-identical to pre-change when `toolCounts` is `undefined` or `{}`.
- Line is sorted by count descending.
- No tool **arguments** or **result content** appear anywhere in the prompt.
- Token delta measured on a representative classifier prompt: ≤20 tokens.

### 5.2: Wire `toolCounts` through `compose.ts` on cache MISS
**File:** `src/routing/compose.ts`

**Steps:** Pass the `counts` computed in Task 4 to `buildClassifierPrompt` at the existing call site. No new variable plumbing — `counts` is already in scope from the cache-key computation.

**Acceptance:** Manual inspection of one captured classifier prompt confirms the activity line is present mid-loop and absent (or empty) for a fresh user message.

---

## Task 6: Unit Tests

### 6.1: `extractRecentToolCalls` semantics
**File:** `test/tool-mix-extract.test.ts` (new)

**Test cases:**
- Empty context → `{ counts: {}, names: [] }`.
- Context with only user messages → empty result.
- Context with user → assistant (text only) → empty result.
- Context with user → assistant (1 toolCall: `read`) → `{ read: 1 }`, `names: ["read"]`.
- Context with user → assistant (10 toolCalls of mixed names) → 10 entries, correct tallies.
- Context with **15** toolCalls since last user → only the last 12 returned (capped, recency-preserved).
- Context with user₁ → assistant (3 toolCalls) → user₂ → assistant (2 toolCalls) → extraction returns ONLY the 2 calls after user₂.
- Context where assistant block has `block.type === "toolCall"` but `block.name` is missing → that block is skipped (no crash).
- Verifies `block.arguments` is **never** read (use a spy/assertion that the result object contains no argument values).

### 6.2: `getBucket` dominance and edge cases
**File:** `test/tool-mix-bucket.test.ts` (new) — see acceptance cases in Task 3.1.

**Additional cases:**
- `getBucket({ read: 5, search: 5 }) === "exploration"` (combined exploration share = 100%).
- `getBucket({ read: 6, edit: 4 }) === "mixed"` (60% threshold not met for either: 60% exact → bucket wins; 6/10 = 60% → `exploration`. Re-verify boundary).
- `getBucket({ read: 6, edit: 4 })`: at the **exact** 60% threshold → returns `exploration` (use `>=`).
- `getBucket({ unknown_tool: 10 }) === "mixed"` (unmapped folds to `other`, no named winner).

### 6.3: Cache invalidation on bucket transition
Covered by Task 4.2.

### 6.4: Classifier prompt contains tool summary
**File:** `test/classifier-prompt.test.ts` (new or extend existing).

**Test cases:**
- `buildClassifierPrompt(ctx, phase, { read: 4, edit: 3, bash: 1 })` contains exactly the substring `"Recent agent activity (last 12 tool calls): read×4 edit×3 bash×1"`.
- `buildClassifierPrompt(ctx, phase)` (no counts arg) does NOT contain `"Recent agent activity"`.
- `buildClassifierPrompt(ctx, phase, {})` does NOT contain `"Recent agent activity"`.
- Token count of the activity line for `{ read: 4, edit: 3, bash: 1 }` is ≤20 (approximate check via `prompt.length` upper bound).

### 6.5: Privacy invariant
**File:** `test/classifier-prompt.test.ts`

**Test case:** Build a `Context` with a `toolResult` message whose content includes the sentinel string `"SECRET_PAYLOAD_XYZ"`. Build a classifier prompt with extracted counts. Assert the prompt does NOT contain `"SECRET_PAYLOAD_XYZ"`.

**Acceptance:** Test fails if any future change accidentally surfaces tool result content into the classifier path.

---

## Task 7: Empirical Validation (Post-Deployment)

### 7.1: Collect 1 week of traces
**Prerequisite:** Task 1 must be merged so `toolResultCount` is accurate, and Phase 1 + Phase 2 must be deployed.

**Steps:**
1. Sample sessions with `runLength > 10` turns/msg over a 7-day window.
2. For each long run, compute the sequence of `bucket` values (one per turn).
3. Count **bucket-transition turns** (current bucket ≠ previous bucket).
4. Cross-reference with classifier verdict changes on those transition turns.

### 7.2: Acceptance signals
- **Bucket-transition rate** in long runs: expected non-zero (otherwise the signal is dead weight — adjust threshold or category map).
- **Verdict flip on transition rate**: expected materially higher than the 13.4% baseline stochastic flip rate from Phase 1's analysis. If it isn't, the bucket signal is uninformative and should be revisited (not reverted yet — gather more data).
- **`bash` mis-categorization**: count sessions dominated by `bash`. If frequent and bucketing to `mixed` is masking true verification behavior, lift `bash` into a separate sub-task that inspects arguments.
- **Classifier prompt token delta**: measure mean and p99 tokens added. Confirm ≤20 token target holds.

### 7.3: Decide on tuning
Based on data:
- Adjust the 60% dominance threshold if `mixed` overwhelms named buckets.
- Adjust the 12-call window if too-recent bias is causing spurious transitions.
- Promote bucket categories or constants to `RouterConfig` only if data shows the defaults are wrong for a meaningful user segment.

**Acceptance:** A short follow-up doc (or PR description) summarizes the measurements and either confirms the defaults or proposes specific tuning. No code changes required by this task — it gates whether a follow-up change is needed.

---

## Summary Table

| Task | Files | Lines Changed | Risk | Notes |
|------|-------|---------------|------|-------|
| 1.1  | calibration/* | ~10 | Low | Bug fix; prerequisite for Task 7 |
| 1.2  | test/ | ~25 | Zero | Regression test |
| 2.1  | utils/messages.ts | ~30 | Low | Pure function, mirrors existing pattern |
| 3.1  | utils/messages.ts (or routing/tool-mix.ts) | ~40 | Low | Pure function, constants only |
| 4.1  | routing/compose.ts | ~5 | Low | Extends Phase 1 sig |
| 4.2  | test/ | ~30 | Zero | Cache-invalidation test |
| 5.1  | calibration/classifier-utils.ts | ~10 | Low | Additive prompt line |
| 5.2  | routing/compose.ts | ~2 | Low | Plumb counts through |
| 6.1–6.5 | test/ | ~150 | Zero | Unit tests for extractor, bucket, prompt, privacy |
| 7    | — | — | — | Post-deploy measurement |

**Total implementation:** ~100 lines across 3 source files, ~205 lines of tests. No new dependencies. No `RouterConfig` changes.
