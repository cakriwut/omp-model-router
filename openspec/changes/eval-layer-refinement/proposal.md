# Proposal: LLM Evaluation Layer for Routing Refinement

**Status:** DEFERRED — pending metrics from `heuristic-cost-optimization` deployment

## Problem

After the heuristic improvements (Path A), an estimated 5–10% of routing decisions will still be suboptimal — cases where keyword heuristics cannot capture user intent. These are ambiguous prompts where context, phrasing nuance, or domain knowledge determines whether the request is truly high-tier.

Example residual false positives:
- "How should we handle this edge case?" — could be planning or a simple implementation question
- "Think about the error handling here" — contains "think" but not necessarily Opus-worthy
- Novel phrasings that don't match any keyword list

## Approach

Use the cheapest available LLM (Claude Haiku 4.5, ~$0.00033/request) as an optional validation gate that fires only on low-confidence heuristic decisions.

## Prerequisites (Must Be True Before Implementation)

1. `heuristic-cost-optimization` change is deployed and stable (≥2 weeks in production)
2. Measured residual false positive rate exceeds 0.5% of total requests
3. The marginal savings from catching residual false positives justifies the eval cost

## Architecture Summary

```
                    EXISTING                           NEW (OPTIONAL)
                    ────────                           ──────────────
User prompt ──▶ decideRouting() ──▶ [confidence?] ──▶ cheapEval() ──▶ final tier
                  (heuristic)         LOW only          (Haiku call)
                  ~0ms                                  ~300-800ms
```

Key design decisions:
- **Reuses existing `classifierModel` infrastructure** — no new system, just smarter activation
- **Adaptive activation** — only fires when heuristic confidence is low (~15–30% of requests)
- **Asymmetric override** — lower threshold for downgrades (save cost) than upgrades (preserve quality)
- **Opt-in** — `evaluation.enabled: false` by default

## Configuration

```json
{
  "classifierModel": "anthropic/claude-haiku-4-5",
  "evaluation": {
    "enabled": false,
    "activation": "adaptive",
    "confidenceThreshold": 0.7,
    "cooldownRequests": 3
  }
}
```

## Cost-Benefit Estimate

| Metric | Value |
|--------|-------|
| Cost per evaluation | $0.00033 (Haiku 4.5) |
| Firing rate (adaptive) | ~20% of requests |
| Effective cost per request | $0.000066 |
| Savings per caught false positive | $0.02–0.05 |
| Break-even catch rate | ≥0.3% of total requests |

## Model Selection

| Option | Cost/eval | Latency | Notes |
|--------|-----------|---------|-------|
| Claude Haiku 4.5 | $0.00033 | 300–500ms | **Recommended** — already in profiles |
| Gemini 2.0 Flash | $0.00003 | 150–300ms | 10× cheaper, requires new provider |
| GLM-4.7-flash (Bedrock) | ~$0.0002 | 200–400ms | Good for Bedrock-only users |

## Activation Strategies Evaluated

| Strategy | When to Fire | Verdict |
|----------|-------------|---------|
| Every request | Always | NOT RECOMMENDED — latency cost too high post-improvements |
| Random sampling (20%) | Random coin flip | Good for telemetry, not real-time correction |
| **Adaptive (confidence-based)** | Heuristic returns low confidence | **RECOMMENDED** |
| Budget-triggered | Budget >30% consumed | Optional companion to adaptive |

## Merge/Disagreement Policy

| Heuristic | Eval | Eval Confidence | Action |
|-----------|------|-----------------|--------|
| high | medium | ≥0.7 | Downgrade to medium (save cost) |
| high | medium | <0.7 | Keep high (eval not confident) |
| medium | high | ≥0.85 | Upgrade to high (higher bar for upgrades) |
| medium | low | ≥0.7 | Downgrade to low (save cost) |
| any | any | <threshold | Keep heuristic |

## Implementation Sequence (When Activated)

1. Add `confidence: 'high' | 'medium' | 'low'` to `decideRouting` output
2. Refactor `runClassifier` → `runCheapEval` with minimal prompt + JSON confidence output
3. Add `evaluation` config block to `RouterConfig`
4. Wire activation logic in `provider.ts` Step 3
5. Add metrics logging for A/B comparison

## Success Criteria

- Eval layer catches ≥3 false positives per 1000 requests (0.3% catch rate)
- Net cost savings positive after subtracting eval costs
- No quality regression reports from users
- TTFT increase <500ms on adaptive-activated requests

## Open Questions (To Answer Before Implementation)

1. Does Haiku 4.5 actually classify better than the improved heuristic on real prompts?
2. What is the measured residual false positive rate post-heuristic-improvements?
3. Is 300–800ms TTFT increase acceptable to power users who opt in?
4. Should we ship this as always-on for `cheap` profile (where cost matters most)?

## Decision Gate

**Implement if:** Measured residual false positive rate > 0.5% after 2 weeks of heuristic improvements in production.

**Skip if:** Residual rate < 0.2% (not cost-effective given eval overhead).

**Re-evaluate if:** Rate is 0.2–0.5% (marginal zone; may depend on user volume).
