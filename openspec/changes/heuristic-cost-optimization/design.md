# Design: Heuristic Cost Optimization

## Current Decision Flow

```
decideRouting(context, ...)
  │
  ├─ pinnedTier? → return pinned
  │
  ├─ custom rules (containsAny, substring) → return matched tier
  │
  └─ heuristic cascade:
       ├─ EXPLICIT_HIGH_HINTS → high
       ├─ EXPLICIT_LOW_HINTS → low
       ├─ SUMMARY_MATCHER → low
       ├─ PLANNING_MATCHER || "why " || wordCount≥high || multiLinePrompt → high  ← PROBLEM
       ├─ IMPLEMENTATION_MATCHER → medium
       ├─ LOOKUP_MATCHER (short, no tools) → low
       ├─ phase-bias sticky (planning + exploratory) → high
       ├─ tool results / implementation context → medium
       └─ wordCount≤low → low
```

The problematic line (routing.ts ~L349–355):
```typescript
} else if (
    matchesKeywords(prompt, PLANNING_MATCHER) ||
    prompt.startsWith("why ") ||
    wordCount >= highThreshold ||
    multiLinePrompt                              // ← Fix A: remove
) {
```

## Fix A: Remove multiLinePrompt

### Current Behavior
```typescript
const multiLinePrompt = prompt.split("\n").length >= 4;
```
Any prompt with 4+ lines routes to Opus. Examples that false-trigger:
- Pasting a 5-line error log followed by "what does this mean?"
- Pasting a JSON config with "update the port"
- Pasting code with "fix the typo on line 3"

### Change
1. Delete the `multiLinePrompt` variable declaration (routing.ts L293).
2. Remove `multiLinePrompt` from the OR-condition (routing.ts L355).

### Why This Is Safe
- Genuinely complex multi-part prompts already trigger `wordCount >= highThreshold` (40–120 words depending on phase bias).
- Planning keywords in the pasted content will still fire `PLANNING_MATCHER`.
- The gate provides zero unique true-positive coverage that other signals don't already capture.

### Interaction with Other Gates
- `wordCount >= highThreshold`: Still active, catches long complex prompts.
- Phase bias: Still active, provides stickiness for planning conversations.
- `prompt.startsWith("why ")`: Still active, catches exploratory questions.

---

## Fix B: Strong/Weak Keyword Split with Corroboration Gate

### Current Behavior
All `PLANNING_KEYWORDS` are treated equally — any single match routes to high tier:
```typescript
const PLANNING_KEYWORDS: readonly string[] = [
    "plan", "planning", "architecture", "architect", "design",
    "tradeoff", "trade-off", "research", "investigate", "root cause",
    "analyze", "analysis", "migration", "strategy",
    "compare", "options", "approach",
];
```

### Problem
Keywords like `"compare"`, `"options"`, `"approach"` are contextually ambiguous:
- "compare these two implementations" → could be planning OR a quick diff
- "what are my options for this error" → likely a simple question
- "what's the best approach" → could mean anything

### Proposed Split

**Strong keywords** (sufficient alone to route high):
```typescript
const STRONG_PLANNING_KEYWORDS: readonly string[] = [
    "architecture", "architect",
    "tradeoff", "trade-off",
    "root cause",
    "investigate",
    "migration",
    "analyze", "analysis",
];
```

**Weak keywords** (require corroboration to route high):
```typescript
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

### Corroboration Gate

A weak keyword routes to high tier **only if** at least one corroborating signal is present:

```
weakKeywordTriggersHigh = matchesKeywords(prompt, WEAK_PLANNING_MATCHER)
    AND (
        wordCount >= 20                              // non-trivial prompt length
        OR prompt.startsWith("why ")                 // exploratory framing
        OR previousPhase === "planning"              // already in planning mode
        OR matchesKeywords(prompt, STRONG_PLANNING_MATCHER)  // strong keyword also present
    )
```

### Justification for Corroborating Signals

| Signal | Rationale |
|--------|-----------|
| `wordCount >= 20` | Multi-sentence prompts with planning keywords are genuinely planning |
| `prompt.startsWith("why ")` | Exploratory framing combined with planning keywords = planning |
| `previousPhase === "planning"` | Phase stickiness — if already planning, weak keywords maintain it |
| Strong keyword also present | Belt-and-suspenders: strong + weak = definitely planning |

### Why 20 Words?

- Median false-positive prompt: 5–12 words ("compare these two", "what are my options")
- Median true-positive prompt: 25–60 words ("I need to plan the migration strategy for...")
- 20 words is conservative: catches most true positives, blocks most false positives.
- This is NOT a new threshold constant — it's a local gate within the weak-keyword branch only.

### What Changes for "plan" and "design"

These are moved to weak because:
- "plan" alone: "follow the plan" (implementation), "here's the plan:" (pasted content)
- "design" alone: "the design looks good" (acknowledgment), "design this component" (might be medium-tier bounded work)

When corroborated (e.g., "plan the migration strategy for our database schema" — 9 words but also contains strong keyword "migration"), they still route high.

---

## Fix C: Word-Boundary Matching in containsAny

### Current Behavior
```typescript
export const containsAny = (text: string, keywords: string[]): boolean => {
    return keywords.some((keyword) => text.includes(keyword));
};
```
Used only for custom routing rules (routing.ts L308):
```typescript
if (containsAny(prompt, matches)) { ... }
```

### Problem
A rule `{ matches: ["deploy"], tier: "high" }` also matches:
- "undeployed"
- "redeployment"  
- "deployable"

### Change
Replace the body of `containsAny` with the same word-boundary logic used in `matchesKeywords`:

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

### Performance Note
`containsAny` is called at most once per routing decision (only when rules exist), with typically 1–5 keywords per rule and 1–5 rules total. The overhead of constructing a few RegExps per call is negligible (<0.01ms). Pre-compilation is not justified here because:
1. Rules can change at runtime (config reload).
2. The function is marked `@deprecated` — it exists only for this single callsite.
3. The call frequency is 1x per routing decision at most.

If performance becomes a concern (>50 rules), the rules matcher can be pre-compiled on config load. This is a future optimization, not a blocker.

### Alternative: Migrate rules to use matchesKeywords
Instead of fixing `containsAny`, we could build a `KeywordMatcher` per rule at config-load time. This is cleaner but:
- Requires changes to config loading
- Changes the rule evaluation semantics (currently rules use `includes()`, changing to `\b` matching)
- Larger blast radius for a low-frequency issue

**Decision:** Fix `containsAny` in-place. It's 3 lines, confined, and the semantic change (word-boundary) is the correct behavior for rule matching.

---

## Signal Composition After Changes

```
decideRouting(context, ...)
  │
  ├─ pinnedTier? → return pinned
  │
  ├─ custom rules (containsAny, word-boundary) → return matched tier     ← Fix C
  │
  └─ heuristic cascade:
       ├─ EXPLICIT_HIGH_HINTS → high
       ├─ EXPLICIT_LOW_HINTS → low
       ├─ SUMMARY_MATCHER → low
       ├─ STRONG_PLANNING_MATCHER → high                                  ← Fix B (strong)
       ├─ WEAK_PLANNING_MATCHER + corroboration → high                    ← Fix B (weak)
       ├─ "why " || wordCount≥highThreshold → high                        ← Fix A (multiLine removed)
       ├─ IMPLEMENTATION_MATCHER → medium
       ├─ LOOKUP_MATCHER (short, no tools) → low
       ├─ phase-bias sticky (planning + exploratory) → high
       ├─ tool results / implementation context → medium
       └─ wordCount≤low → low
```

## Edge Cases

### E1: Weak keyword + exactly 20 words
Gate fires. This is intentional — 20 words is the minimum for corroboration, not an exclusion threshold.

### E2: Strong keyword in pasted content
If the user pastes code containing `"migration"` but asks "fix the typo", the strong keyword still fires. This is acceptable because:
- The prompt text is extracted from user content only (`getLastUserText`)
- Natural-language keywords in code are rare
- If this becomes a problem, a future fix can weight keywords by position (early = more likely intentional)

### E3: Rule with multi-word match containing a single word
A rule like `{ matches: ["deploy to production"] }` uses substring matching (multi-word). A rule like `{ matches: ["deploy"] }` uses word-boundary. This matches user intent.

### E4: Empty prompt or very short prompt
- 0–3 words with no keywords → falls through to `wordCount <= lowThreshold` → low tier (unchanged)
- 1 word that is a weak keyword without corroboration → falls through to medium (new behavior, correct)

### E5: Phase bias interaction
If `previousPhase === "planning"`:
- Strong keywords still route high (unchanged)
- Weak keywords route high (corroboration via phase)
- No keywords: sticky-phase logic at the bottom still catches it (unchanged)

The phase-bias interaction means weak keywords during an active planning conversation still maintain the planning tier — no regression in conversational continuity.

## Interaction with Other Override Gates

| Gate | Runs After Heuristic? | Affected by This Change? |
|------|----------------------|--------------------------|
| Pin override | Before heuristic | No — pinned tier skips all heuristic logic |
| Budget gate | After heuristic | No — only downgrades high→medium, doesn't upgrade |
| Context trigger | After heuristic | No — forces high regardless of heuristic result |
| Classifier override | After heuristic | No — replaces heuristic entirely when active |
| Image upgrade | After classifier | No — only upgrades tier for image support |

**Conclusion:** This change is fully confined to the heuristic cascade. No interaction with any downstream override gate.
