# Proposal: Heuristic Cost Optimization — Eliminate False High-Tier Routes

## Problem

The routing heuristic in `decideRouting` produces false-positive high-tier (Opus) routes in three systematic categories:

1. **Multi-line paste → Opus.** Any prompt with ≥4 newlines routes to high tier via the `multiLinePrompt` gate. Pasting a stack trace, config file, code snippet, or error log triggers Opus regardless of the actual question complexity. This is the single highest-frequency false positive.

2. **Weak planning keywords without context → Opus.** Keywords like `"compare"`, `"options"`, `"approach"`, and `"strategy"` in `PLANNING_KEYWORDS` fire with no corroboration. A user asking "compare these two lines" or "what's the best approach to fix this typo" routes to Opus. These keywords are semantically ambiguous — they indicate planning only when corroborated by other signals (high word count, no prior tool results, exploratory phrasing).

3. **Substring matching in custom rules → unintended tier.** The `containsAny` function used for custom routing rules matches substrings: a rule matching `"deploy"` also fires on `"undeployed"`, `"redeployment"`, etc. This is less frequent but produces incorrect routing when it hits.

## Why It Matters

Every false high-tier route costs 5–15× more than the correct tier (Opus vs. Haiku/Sonnet). In observed usage patterns:

- Multi-line pastes occur in ~20–30% of coding conversations (error logs, config snippets, code blocks).
- Weak planning keywords appear in ~10–15% of non-planning prompts.
- Combined, these produce an estimated 15–25% overtier rate — requests routed to Opus that Sonnet handles equally well.

**Cost impact:** At $15/MTok (Opus) vs. $3/MTok (Sonnet), a 20% overtier rate on a $50/month usage pattern wastes ~$8–12/month per active user.

## Approach

Three composable, independently-deployable fixes:

| Fix | Change | Risk | Impact |
|-----|--------|------|--------|
| **A** | Remove `multiLinePrompt` from high-tier condition | Zero — no other code path uses it | HIGH false-positive reduction |
| **B** | Split PLANNING_KEYWORDS into strong/weak; weak requires corroboration | Low — strong keywords unchanged | MEDIUM false-positive reduction |
| **C** | Word-boundary matching in `containsAny` for custom rules | Low — aligns with `matchesKeywords` behavior | LOW false-positive reduction |

## Who Benefits

- **All users** with cost sensitivity (the default use case — cost optimization is this extension's reason to exist).
- **Heavy paste workflows** — developers who paste logs, configs, error outputs frequently.
- **Users with broad custom rules** that inadvertently match substrings.

## Success Metrics

| Metric | Baseline | Target |
|--------|----------|--------|
| False high-tier on multi-line pastes | ~100% | 0% (removed gate) |
| False high-tier on weak keywords alone | ~100% | <10% (corroboration gate) |
| Substring false matches in rules | Variable | 0% (word-boundary) |
| Overall overtier rate | ~15–25% est. | <5% est. |
| Routing decision latency | ~0.1ms | Same or faster (no new computation) |
| Quality regressions | 0 | 0 (no true-positive changes) |

## Non-Goals

- Changing threshold values (highThreshold, lowThreshold, phaseBias).
- Adding new keyword categories or new routing signals.
- Modifying the classifier, budget gate, context-trigger, or image-upgrade logic.
- Changing the tier model assignments or fallback chains.

## Assumptions

1. The `multiLinePrompt` gate was originally intended to catch "complex multi-part questions" but in practice overwhelmingly fires on pastes. The `wordCount >= highThreshold` gate already handles genuine complex prompts.
2. Strong planning keywords (e.g., "architecture", "root cause", "migration") are sufficient alone to indicate high-tier work. Weak keywords only indicate planning when combined with other signals.
3. Custom rule authors expect word-level matching semantics (matching `"deploy"` means the word "deploy", not any string containing those characters).
