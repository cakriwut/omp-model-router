# Proposal: Classifier Tool-Mix Signal — Detect Mid-Loop Phase Transitions

## Problem

Phase 1 (`classifier-prompt-cache`) reduces classifier invocations by ~80% by caching on `(lastUserText, userMsgIndex)`. The cache busts when a new user message arrives, which is the right invalidation edge for the vast majority of turns. But it cannot detect **phase transitions inside a single user-message run**:

- Turn 5: assistant has executed 6× `read` + 2× `search` — clearly in **exploration**.
- Turn 12: same user message still active, but assistant has now done 4× `edit` + 1× `write` — clearly in **implementation**.

Under Phase 1, both turns produce the same classifier verdict (cache hit on identical prompt). The classifier has no signal that the agent's behavior has shifted, and the heuristic alone cannot bridge the gap because the user text is stale.

This matters in long loops (median 5, p90 = 31, max = 92 turns/msg in 2,183-turn dataset) where the actual work changes character mid-stream — exactly the case where re-routing would be most valuable.

## Why It Matters

Phase 2 closes the cache's one structural blind spot:

1. **Cache invalidates at real phase transitions.** When the tool-mix bucket flips (`exploration` → `implementation`), the classifier re-runs and can re-route appropriately (e.g., drop from Sonnet to Haiku for mechanical edits).
2. **Classifier gets a richer signal at near-zero cost.** A single line — `Recent agent activity (last 12 tool calls): read×4 edit×3 bash×1` — is ~15 tokens and gives the LLM a concrete behavioral summary that no other input provides.
3. **No tool-result content ever reaches the classifier.** Tool names and counts only — preserves the existing privacy/size invariants in `classifier-utils.ts`.

## Approach

| Step | Change | Risk |
|------|--------|------|
| **1** | Fix `toolResultCount` trace bug (prerequisite) | Zero — fixes existing trace inaccuracy |
| **2** | Walk `context.messages` back to last user msg; extract tool names from intervening assistant messages; cap at 12 | Low — pure read of existing structure |
| **3** | Bucket counts into `exploration / implementation / verification / delegation / mixed / fresh` via 60% dominance rule | Low — local pure function, fully unit-testable |
| **4** | Extend Phase 1 cache key from `lastUserText\|userMsgIndex` to `lastUserText\|userMsgIndex\|bucket` | Low — extends, does not replace |
| **5** | Inject one summary line into `buildClassifierPrompt` before the tier definitions | Low — additive, ≤20 extra tokens |

## Dependency

**Phase 1 (`classifier-prompt-cache`) MUST be deployed first.** Phase 2 extends the Phase 1 cache key; it does not stand alone. If Phase 1 is reverted, Phase 2's bucket signal has no cache to invalidate against and degenerates to a constant prompt-padding line.

## Prerequisite

`promptFeatures.toolResultCount` is stuck at `0` in every observed trace (separate trace-extraction bug). This must be fixed **before** the empirical validation task (Task 7) — without accurate baseline tool counts, bucket thresholds cannot be tuned against real data.

The fix itself is a prerequisite for Task 7 only; the bucket extraction (Task 2) walks `context.messages` directly and does not depend on `promptFeatures`.

## Who Benefits

- **Long-loop users** — anyone whose agent runs 10+ turns per user message (the p90 case). Cache invalidation at phase transitions surfaces the right tier for the right work.
- **Cost-sensitive users** — verification phases (test runs, lint) are cheap and short; routing them to Haiku saves on the highest-frequency tail of any session.
- **Classifier accuracy generally** — the activity summary gives the LLM concrete behavioral evidence, reducing reliance on text-only heuristics.

## Success Metrics

| Metric | Baseline (Phase 1 only) | Target (Phase 1 + Phase 2) |
|--------|-------------------------|----------------------------|
| Cache invalidations per long loop (>20 turns) | 0 (only on new user msg) | ≥1 per genuine phase transition |
| Classifier prompt size delta | — | ≤20 extra tokens per invocation |
| Classifier flip rate on bucket transitions | unmeasured | Measurable signal (>0%, captured in Task 7) |
| Tool-result content reaching classifier | 0 bytes | 0 bytes (invariant preserved) |
| `toolResultCount` trace accuracy | always 0 (broken) | matches actual count |

## Non-Goals

- Feeding tool **result content** (text payloads) to the classifier. Names and counts only.
- Changing tier definitions, classifier prompt structure beyond one added line, or the parsed output format.
- Replacing the heuristic with the tool-mix signal. The bucket is classifier input, not a heuristic gate.
- Tuning bucket-category membership (which tools count as `exploration` vs `verification`) post-deployment — that requires Task 7's empirical data.
- Applying the cache-key extension to the async classifier path (`hooks.ts:140`). Phase 1's scope (sync path in `compose.ts`) carries over unchanged.

## Assumptions

1. Tool names in `context.messages` assistant blocks are stable identifiers (e.g., `"read"`, `"edit"`, `"bash"`) — verified by the existing `serializeToolSequence` pattern in `context-compression.ts:219-240` which already extracts `block.name`.
2. A 12-call window covers the recent phase without leaking too far back. Median run-length is 5 turns/msg; 12 calls is ~2× median and captures the working context.
3. A 60% dominance threshold is conservative — it routes to a named bucket only when behavior is clearly skewed; ambiguous mixes correctly route to `mixed`.
4. `<2` total tool calls is insufficient signal — route to `fresh` (a stable cache-key value that does not destabilize the cache during the first turns of a new user message).
