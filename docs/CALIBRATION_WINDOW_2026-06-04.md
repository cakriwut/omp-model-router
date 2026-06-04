# 2-Week Calibration Observation Window — June 4–18, 2026

## Purpose

Measure the **residual false-positive rate** (heuristic over-routes to high tier) after the `heuristic-cost-optimization` changes. This data will determine readiness to implement `eval-layer-refinement`.

## Window Details

| Field | Value |
|-------|-------|
| **Start** | June 4, 2026 |
| **End** | June 18, 2026 |
| **Duration** | 14 days |
| **Config** | `calibration.mode: "adaptive"` (classifier runs for real routing) |
| **Traces** | Enabled (`traceEnabled: true`) |
| **Data location** | `~/.omp/agent/model-router/calibration-global.json` |

## Config Verification (June 4)

✅ **Calibration enabled:** `true`  
✅ **Mode:** `"adaptive"` (classifier is making real routing decisions)  
✅ **Trace writing:** `true`  
✅ **Classifier models:** `ollama-cloud/deepseek-v3.1:671b`, `amazon-bedrock/us.amazon.nova-micro-v1:0`  
✅ **Session traces:** 322 files present in `~/.omp/agent/model-router/traces/`

## Measurement

### Confusion Matrix

The calibration system tracks a 3×3 matrix: `matrix[heuristic_tier][llm_tier]`

- **Index 0:** Low tier
- **Index 1:** Medium tier
- **Index 2:** High tier

### False-Positive Rate Calculation

```
FP rate = (matrix[2][0] + matrix[2][1]) / totalComparisons
```

Where:
- `matrix[2][0]` = heuristic said **high**, LLM said **low** (over-routed to expensive tier)
- `matrix[2][1]` = heuristic said **high**, LLM said **medium** (over-routed, less severe)

## Decision Gate (After June 18)

Run the analysis script to compute the FPR:

```bash
bun scripts/analyze-calibration-fpr.ts
```

### Decision Thresholds

| Metric | Decision | Action |
|--------|----------|--------|
| **FPR > 0.5%** | Implement | Proceed with `eval-layer-refinement` (residual errors justify eval cost) |
| **FPR < 0.2%** | Defer | Skip `eval-layer-refinement` (heuristic already good enough) |
| **FPR 0.2–0.5%** | Re-evaluate | Decision depends on usage volume; marginal case |

## Related Work

- **heuristic-cost-optimization:** Completed & deployed. Changed strong/weak keyword split, removed `multiLinePrompt` gate, fixed word-boundary matching. All 112 routing tests pass.
- **eval-layer-refinement:** DEFERRED until this observation window completes. Requires:
  1. Measured FPR data (this window)
  2. `confidence` field added to `decideRouting()` output
  3. `evaluation.*` config block in `RouterConfig`

## Next Steps (Post-June 18)

**If FPR > 0.5%:**
1. Implement `confidence` field in `decideRouting()`
2. Create `evaluation` config section
3. Write `eval-layer-refinement` implementation plan with actual data
4. Transition classifier to validation-gate role (only fires on low-confidence decisions)

**If FPR < 0.2%:**
1. Archive `eval-layer-refinement` as not needed
2. Continue using improved heuristic as-is

**If FPR 0.2–0.5% (marginal):**
1. Collect additional data on peak usage hours
2. Re-evaluate cost-benefit with volume context
3. Decide case-by-case
