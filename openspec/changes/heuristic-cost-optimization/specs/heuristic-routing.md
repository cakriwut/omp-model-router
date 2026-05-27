# Specification: Heuristic Routing Decision Logic

## Scope

This specification defines the heuristic decision logic within `decideRouting()` after applying fixes A, B, and C. It covers only the heuristic cascade — not pin overrides, budget gates, classifier, context-trigger, or image-upgrade (those are unchanged and specified elsewhere).

## Definitions

| Term | Definition |
|------|-----------|
| **Tier** | `"high" \| "medium" \| "low"` — maps to a model in the active profile |
| **Phase** | `"planning" \| "implementation" \| "lightweight"` — semantic label for the conversation state |
| **Strong keyword** | A keyword whose presence alone is sufficient to route high |
| **Weak keyword** | A keyword that requires corroboration from another signal to route high |
| **Corroboration** | A secondary signal that confirms a weak keyword's planning intent |
| **Word-boundary match** | Keyword matches at `\b` boundaries (start/end of word, not substring) |

## Keyword Classifications

### Explicit High Hints (routes high, no conditions)
```
"best", "deep", "deeply", "carefully", "thoroughly",
"robust", "comprehensive", "step by step", "think hard", "highest quality"
```

### Explicit Low Hints (routes low, no conditions)
```
"fast", "fastest", "cheap", "quick", "quickly",
"brief", "briefly", "one sentence", "one line", "tiny", "small"
```

### Summary Keywords (routes low, no conditions)
```
"summarize", "summary", "changelog", "rewrite", "reformat",
"format", "rename", "explain briefly", "recap", "tl;dr"
```

### Strong Planning Keywords (routes high, no corroboration needed)
```
"architecture", "architect",
"tradeoff", "trade-off",
"root cause",
"investigate",
"migration",
"analyze", "analysis"
```

### Weak Planning Keywords (routes high ONLY with corroboration)
```
"plan", "planning",
"design",
"research",
"strategy",
"compare",
"options",
"approach"
```

### Implementation Keywords (routes medium, no conditions)
```
"implement", "code", "fix", "update", "edit", "editing",
"write", "refactor", "add tests", "unit tests", "write tests",
"tests", "patch", "change", "apply", "continue", "continued",
"resume", "make the changes", "go ahead"
```

### Lookup Keywords (routes low, conditional on short + no tools)
```
"where is", "which file", "show me", "list", "find", "grep"
```

## Matching Semantics

### For built-in keyword matchers (matchesKeywords)
- **Single-word keywords:** Matched using pre-compiled `\b` word-boundary regex (case-insensitive).
- **Multi-word phrases:** Matched using `String.includes()` (natural word boundaries from spaces).
- Matchers are compiled at module load. Zero per-call allocation.

### For custom rule matching (containsAny)
- **Single-word keywords:** Matched using `\b` word-boundary regex (case-insensitive).
- **Multi-word phrases:** Matched using `String.includes()`.
- RegExps are constructed per-call (acceptable: ≤5 rules × ≤5 keywords = ≤25 regex constructions, <0.01ms).

## Decision Pseudocode

```
function decideRouting(context, profile, previousDecision, pinnedTier, ...):
    prompt = getLastUserText(context).toLowerCase()
    recentConversation = getRecentConversationText(context, 6)
    toolResultCount = countToolResults(context)
    wordCount = countWords(prompt)
    previousPhase = previousDecision?.phase

    // ─── Gate 0: Pin override ─────────────────────────────
    if pinnedTier:
        return { tier: pinnedTier, phase: phaseForTier(pinnedTier) }

    // ─── Gate 1: Custom rules (word-boundary) ─────────────
    if rules:
        for rule in rules:
            if containsAny(prompt, rule.matches):  // word-boundary
                return { tier: rule.tier, phase: phaseForTier(rule.tier) }

    // ─── Gate 2: Heuristic cascade ───────────────────────
    // Phase-bias thresholds
    highThreshold = max(40, 120 - (previousPhase == "planning" ? phaseBias * 80 : 0))
    lowThreshold = max(4, 12 - (previousPhase in ["implementation", "planning"] ? phaseBias * 8 : 0))

    // 2a: Explicit user quality hints
    if matchesKeywords(prompt, EXPLICIT_HIGH_HINTS):
        return { tier: "high", phase: "planning" }

    if matchesKeywords(prompt, EXPLICIT_LOW_HINTS):
        return { tier: "low", phase: "lightweight" }

    // 2b: Summary/transform detection
    if matchesKeywords(prompt, SUMMARY_MATCHER):
        return { tier: "low", phase: "lightweight" }

    // 2c: Strong planning keywords (sufficient alone)
    if matchesKeywords(prompt, STRONG_PLANNING_MATCHER):
        return { tier: "high", phase: "planning" }

    // 2d: Weak planning keywords (require corroboration)
    if matchesKeywords(prompt, WEAK_PLANNING_MATCHER):
        corroborated = (
            wordCount >= 20
            OR prompt.startsWith("why ")
            OR previousPhase == "planning"
            OR matchesKeywords(prompt, STRONG_PLANNING_MATCHER)  // redundant but explicit
        )
        if corroborated:
            return { tier: "high", phase: "planning" }
        // else: fall through to lower-priority checks

    // 2e: Complexity signals (without multiLinePrompt)
    if prompt.startsWith("why ") OR wordCount >= highThreshold:
        return { tier: "high", phase: "planning" }

    // 2f: Implementation detection
    if matchesKeywords(prompt, IMPLEMENTATION_MATCHER):
        return { tier: "medium", phase: "implementation" }

    // 2g: Lookup detection (short, no prior tools)
    if matchesKeywords(prompt, LOOKUP_MATCHER) AND wordCount <= 24 AND toolResultCount == 0:
        return { tier: "low", phase: "lightweight" }

    // 2h: Phase-bias sticky (keep planning if exploratory)
    if previousPhase == "planning" AND toolResultCount == 0 AND wordCount > lowThreshold:
        return { tier: "high", phase: "planning" }

    // 2i: Active implementation context
    if toolResultCount > 0 OR previousPhase == "implementation" OR "plan:" in recentConversation:
        return { tier: "medium", phase: "implementation" }

    // 2j: Very short prompt
    if wordCount <= lowThreshold:
        return { tier: "low", phase: "lightweight" }

    // 2k: Default
    return { tier: "medium", phase: "implementation" }
```

## Threshold Justification

| Threshold | Value | Justification |
|-----------|-------|---------------|
| `highThreshold` base | 120 words | ~2 paragraphs; beyond casual prompts |
| `highThreshold` biased | 40 words (min) | During planning phase, lower bar to maintain tier |
| `lowThreshold` base | 12 words | Very short prompts are bounded tasks |
| `lowThreshold` biased | 4 words (min) | During active work, only truly trivial prompts go low |
| Weak corroboration | 20 words | Above casual query length; below planning prompt median |
| Lookup max words | 24 words | Lookup queries are short by nature |

## Interaction Matrix

Shows how this heuristic interacts with gates that run **after** it in `resolveRouting`:

| Heuristic Output | Budget Exceeded | Context Trigger | Classifier Active | Image Needed | Final Tier |
|------------------|----------------|-----------------|-------------------|--------------|------------|
| high | yes | — | — | — | medium (downgraded) |
| high | no | — | — | — | high |
| medium | — | yes (>threshold) | — | — | high (upgraded) |
| medium | — | — | returns high | — | high (classifier wins) |
| low | — | — | — | low no image | medium or high (image upgrade) |
| any | — | — | — | — | heuristic result (no override) |

## Removed Signal: multiLinePrompt

**Previous:** `prompt.split("\n").length >= 4` contributed to high-tier routing.

**Removed because:**
1. False-positive rate: ~80–90% (most multi-line prompts are pastes, not complex questions).
2. Zero unique coverage: every genuine complex prompt also exceeds `wordCount >= highThreshold`.
3. The signal conflates "contains structured data" with "requires deep reasoning" — these are orthogonal.

**Migration:** None. The variable and its usage are simply deleted. No configuration references it.

## Invariants

1. **No regression on strong signals.** Any prompt that previously routed high via `EXPLICIT_HIGH_HINTS`, strong planning keywords, `wordCount >= highThreshold`, or `"why "` prefix continues to route high.
2. **No regression on low signals.** Any prompt that previously routed low via `EXPLICIT_LOW_HINTS`, `SUMMARY_MATCHER`, `LOOKUP_MATCHER`, or `wordCount <= lowThreshold` continues to route low.
3. **Weak keywords with corroboration still route high.** A prompt like "plan the architecture migration" (weak keyword "plan" + strong keyword "migration" + 4 words) still routes high because the strong keyword fires first.
4. **Custom rules still override heuristic.** Rule matching runs before the heuristic cascade (unchanged).
5. **Performance: zero additional allocations.** All matchers are pre-compiled at module load. The only new per-call work is a word-count comparison (`wordCount >= 20`), which is already computed.
