# Tasks: Heuristic Cost Optimization

## Execution Order

Fixes A, B, C are independent and can be implemented in any order. Recommended sequence: A → C → B (simplest first, highest-impact first, most complex last).

All changes are confined to `routing.ts`. Tests are added/updated in `simple-routing.test.ts`.

---

## Task A: Remove multiLinePrompt Gate

### A.1: Delete multiLinePrompt variable and usage
**File:** `routing.ts`
**Lines:** ~L293 (declaration), ~L355 (usage in OR-condition)

**Steps:**
1. Delete line: `const multiLinePrompt = prompt.split("\n").length >= 4;`
2. Remove `multiLinePrompt` from the OR-condition:
   ```
   Before: matchesKeywords(prompt, PLANNING_MATCHER) || prompt.startsWith("why ") || wordCount >= highThreshold || multiLinePrompt
   After:  matchesKeywords(prompt, PLANNING_MATCHER) || prompt.startsWith("why ") || wordCount >= highThreshold
   ```
3. Update the reasoning string if it references multi-line prompts (currently it doesn't — it says "complexity or keywords").

**Acceptance:**
- A 10-line code paste with "fix the typo" routes to medium (not high).
- A 120-word single-line prompt still routes to high (wordCount gate).
- All existing tests pass.

### A.2: Add regression tests for multi-line pastes
**File:** `simple-routing.test.ts` (or new `routing-heuristic.test.ts`)

**Test cases:**
- `"here's my error:\nline1\nline2\nline3\nline4\nwhat's wrong?"` → medium (not high)
- `"fix this:\n  const x = 1;\n  const y = 2;\n  const z = 3;\n  return x + y + z;"` → medium
- Same prompt but with planning keyword: `"analyze this:\nline1\nline2\nline3\nline4"` → high (keyword fires)
- Same prompt but 120+ words across lines → high (wordCount fires)

**Acceptance:** Tests assert medium tier for multi-line pastes without other high-tier signals.

---

## Task B: Strong/Weak Keyword Split with Corroboration Gate

### B.1: Split PLANNING_KEYWORDS into two arrays
**File:** `routing.ts`
**Lines:** ~L119–136 (current `PLANNING_KEYWORDS` definition)

**Steps:**
1. Replace `PLANNING_KEYWORDS` with two new arrays:
   ```typescript
   const STRONG_PLANNING_KEYWORDS: readonly string[] = [
       "architecture", "architect",
       "tradeoff", "trade-off",
       "root cause",
       "investigate",
       "migration",
       "analyze", "analysis",
   ];

   const WEAK_PLANNING_KEYWORDS: readonly string[] = [
       "plan", "planning",
       "design",
       "research",
       "strategy",
       "compare",
       "options",
       "approach",
   ];
   ```
2. Build two matchers at module scope:
   ```typescript
   const STRONG_PLANNING_MATCHER = buildKeywordMatcher(STRONG_PLANNING_KEYWORDS);
   const WEAK_PLANNING_MATCHER = buildKeywordMatcher(WEAK_PLANNING_KEYWORDS);
   ```
3. Remove the old `PLANNING_MATCHER` (or rename it if other code references it).

### B.2: Implement corroboration gate in decision logic
**File:** `routing.ts`
**Lines:** ~L349–356 (the planning condition block)

**Steps:**
Replace the single `matchesKeywords(prompt, PLANNING_MATCHER)` check with:
```typescript
} else if (matchesKeywords(prompt, STRONG_PLANNING_MATCHER)) {
    phase = "planning";
    tier = "high";
    reasoning = "Detected strong planning keyword indicating architectural or investigative work.";
} else if (
    matchesKeywords(prompt, WEAK_PLANNING_MATCHER) &&
    (wordCount >= 20 || prompt.startsWith("why ") || previousDecision?.phase === "planning")
) {
    phase = "planning";
    tier = "high";
    reasoning = "Detected planning keyword corroborated by prompt length or conversational context.";
} else if (prompt.startsWith("why ") || wordCount >= highThreshold) {
```

**Note:** The `prompt.startsWith("why ")` check appears in both the corroboration gate and the complexity-signals check. This is intentional — if a prompt starts with "why" AND has a weak keyword, it routes high via corroboration. If it starts with "why" WITHOUT any keyword, it routes high via the complexity-signals gate. Both paths produce the same result but with different reasoning strings.

### B.3: Add tests for strong/weak keyword behavior
**File:** `simple-routing.test.ts` (or new test file)

**Test cases — strong keywords (always high):**
- `"investigate the crash"` → high
- `"root cause of the failure"` → high
- `"migration plan"` → high (strong keyword "migration" fires first)
- `"architecture"` → high (even single word)

**Test cases — weak keywords without corroboration (NOT high):**
- `"compare these two"` → falls through (medium or low depending on other signals)
- `"what are my options"` → falls through
- `"design looks good"` → falls through
- `"plan"` (single word, 1 wordCount) → falls through

**Test cases — weak keywords WITH corroboration (high):**
- `"I need to design the authentication system for our new microservice"` → high (wordCount ≥ 20)
- `"compare the performance implications of these two caching strategies for our system"` → high (wordCount ≥ 20)
- `"options"` during planning phase (previousPhase = "planning") → high (phase corroboration)
- `"why is this design failing"` → high (startsWith "why ")

**Acceptance:** All strong keywords route high unconditionally. Weak keywords alone do NOT route high. Weak keywords + corroboration route high.

---

## Task C: Word-Boundary Matching in containsAny

### C.1: Update containsAny implementation
**File:** `routing.ts`
**Lines:** ~L233–235 (containsAny function body)

**Steps:**
Replace the function body:
```typescript
export const containsAny = (text: string, keywords: string[]): boolean => {
    return keywords.some((keyword) => {
        if (keyword.includes(" ")) {
            return text.includes(keyword);
        }
        return new RegExp(`\\b${keyword}\\b`, "i").test(text);
    });
};
```

**Note:** The function remains exported and `@deprecated` — it's only used for custom rule matching. The deprecation warning guides future refactors toward `matchesKeywords` but doesn't block this fix.

### C.2: Add tests for word-boundary rule matching
**File:** `simple-routing.test.ts` (or new test file)

**Test cases:**
- Rule `{ matches: ["deploy"], tier: "high" }`:
  - `"deploy the service"` → matches (word boundary)
  - `"undeployed resources"` → does NOT match
  - `"redeployment plan"` → does NOT match
  - `"deploy"` → matches (exact word)
- Rule `{ matches: ["deploy to production"], tier: "high" }`:
  - `"we need to deploy to production"` → matches (multi-word, substring)
  - `"deploy to production-staging"` → matches (substring of multi-word)
- Rule `{ matches: ["release"], tier: "high" }`:
  - `"release the build"` → matches
  - `"prereleased version"` → does NOT match

**Acceptance:** Single-word rule keywords use word-boundary matching. Multi-word phrases use substring matching. No false substring matches for single-word rules.

---

## Task D: Verification & Cleanup

### D.1: Run full test suite
**Command:** `bun test`

**Acceptance:** All existing tests pass. Any test that relied on:
- Multi-line paste → high: update expectation to medium
- Weak keyword alone → high: update expectation (or add corroboration to test input)
- Substring rule matching: update expectation

### D.2: Manual routing verification
Test the following prompts through the actual router and verify tier assignment:

| Prompt | Expected Tier | Signal |
|--------|---------------|--------|
| `"fix the bug on line 5\nhere's the code:\nconst x = 1;\nconst y = 2;\nreturn x;"` | medium | Multi-line paste, impl keyword |
| `"investigate why the service is crashing"` | high | Strong keyword "investigate" |
| `"compare these two"` | medium | Weak keyword, no corroboration |
| `"I need to compare the architectural tradeoffs between monolith and microservices for our team"` | high | Weak "compare" + wordCount ≥ 20 |
| `"deploy the fix"` (with rule matching "deploy") | high | Rule word-boundary match |
| `"the undeployed changes"` (with same rule) | medium (default) | Rule does NOT match |

### D.3: Performance verification
**Method:** Run `decideRouting` in a tight loop (10,000 iterations) before and after changes.

**Expected:** Same or faster (we removed a `String.split("\n")` call and added no new allocations in the hot path). The only new per-call work is one integer comparison (`wordCount >= 20`) which is already computed.

**Acceptance:** No measurable regression. The `split("\n")` removal should save ~0.002ms/call.

---

## Rollout Considerations

### Deployment Strategy
All three fixes ship together in a single version bump. They are composable but the combined behavioral change is easier to reason about as a unit.

### Rollback
If regressions are reported:
1. Revert the single commit.
2. No config changes needed — the fix is entirely in routing logic.

### Monitoring
After deployment, check `/router debug` output for:
- Reduction in "planning" phase entries that have short prompts (success signal)
- No increase in "Classifier override" corrections from medium→high (would indicate the heuristic is now under-routing)

### Breaking Changes
None. This is a behavioral improvement:
- Users who were over-routed to Opus get cheaper, equally-good responses on Sonnet.
- Users who were correctly routed to Opus are unaffected (strong keywords, word count, explicit hints all unchanged).
- Custom rules become more precise (word-boundary), which is the expected semantic.

### Version
Bump patch version (cost optimization, no API change): `0.2.1` → `0.2.2`

---

## Summary Table

| Task | Files | Lines Changed | Risk | Effort |
|------|-------|---------------|------|--------|
| A.1 | routing.ts | 2 lines deleted | Zero | Trivial |
| A.2 | test file | ~20 lines added | Zero | Low |
| B.1 | routing.ts | ~15 lines (split arrays) | Low | Low |
| B.2 | routing.ts | ~12 lines (new condition) | Low | Low |
| B.3 | test file | ~30 lines added | Zero | Low |
| C.1 | routing.ts | ~5 lines changed | Low | Trivial |
| C.2 | test file | ~20 lines added | Zero | Low |
| D.1 | — | — | — | Verify |
| D.2 | — | — | — | Verify |
| D.3 | — | — | — | Verify |

**Total implementation:** ~55 lines changed in routing.ts, ~70 lines of new tests. No new files, no new dependencies.
