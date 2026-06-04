# Proposal: Classifier Prompt Cache — Eliminate Redundant Classifier Calls in Tool Loops

## Problem

In long agent loops, a single user message triggers many turns (median 5, p90 31, max 92 in observed
sessions). Each turn calls `resolveRouting` which, when a classifier model is configured, invokes
`runClassifier` over the **same user prompt** — because the user has not spoken again. The classifier
receives identical input across every turn of the loop and returns either:

1. The same verdict (no information gained), or
2. A different verdict driven purely by LLM stochasticity (a flip-flop with no underlying signal).

The classifier earns its keep when the prompt actually changes — heuristic ↔ classifier disagreement
is 44.9% across the corpus, so we are **not** removing it. We are eliminating the redundant calls
on prompts the classifier has already scored.

## Why It Matters

Measured on 2,183 real turns from 68 sessions of production usage:

| Observation | Value |
|-------------|------:|
| Classifier calls whose prompt equals the previous turn's prompt | **81.9%** |
| Of those duplicates, calls returning the **same** verdict | 86.6% |
| Of those duplicates, calls **flipping** the verdict (stochastic) | **13.4%** |
| TTL=20 retention of the savings ceiling | ~98% (80.1% hit rate vs 81.9% unbounded) |

Two costs follow:

- **Dollar cost.** Roughly 80% of classifier invocations are pure waste. Each call is a small LLM
  request, but in a tool-loop-heavy session it adds up to dozens of redundant requests.
- **Determinism cost.** The 13.4% stochastic flip rate means routing tier can change mid-loop with
  no underlying user-visible reason. Identical turns producing different tiers is a correctness
  defect for an extension whose contract is "predictable cost-optimized routing".

## Approach

Add a signature-keyed cache scoped to `RouterState`, gated by a TTL (in turns). The cache lives
beside the synchronous classifier call in `resolveRouting` (`src/routing/compose.ts:171-235`).

| Element | Value |
|---------|-------|
| Cache key | `lastUserText + "\|" + userMsgIndex` |
| `userMsgIndex` | Count of `role=="user"` messages in `context.messages` |
| Storage scope | Per-`RouterState` instance (per-session by construction) |
| TTL | 20 turns since last classifier run (configurable: `classifierCache.ttlTurns`) |
| Gate condition | `sig == lastKey && turnsSinceRun < ttl` AND no context-capacity promotion |
| On HIT | Skip `runClassifier`, reuse cached verdict, still update calibration matrix |
| On MISS | Run classifier, store `(sig, verdict)`, reset turn counter |

No new modules. No new dependencies. ~30 lines added to `compose.ts`, 3 fields on `RouterState`,
one optional config block.

## Success Metrics

| Metric | Baseline | Target |
|--------|----------|-------:|
| Classifier invocations per tool-loop turn | 1.0 | ~0.2 (TTL=20) |
| Identical-prompt verdict stability | 86.6% | 100% (within TTL window) |
| Stochastic flip rate on identical input | 13.4% | 0% (within TTL window) |
| Routing latency on cache HIT | ~150–400 ms (classifier RTT) | <0.1 ms (in-memory compare) |
| Calibration matrix coverage | 100% of turns | 100% of turns (HIT path still records) |
| Sub-agent cross-contamination | n/a | 0 (RouterState scope is per-session) |

## Non-Goals

- **Tool-mix bucket signal.** Recording `read×4 edit×3 bash×1` aggregates and busting the cache on
  phase shift is Phase 2 (`classifier-tool-mix-signal`). Phase 1 caches strictly on user-text equality.
- **Removing the classifier.** Heuristic ↔ classifier disagreement is 44.9% — the classifier is
  load-bearing. We are removing redundant calls, not the call itself.
- **Changing tier definitions, fallback chains, or routing thresholds.** The cache returns the same
  verdict the uncached classifier would have returned on this prompt; downstream gates are unchanged.
- **Caching across sessions or to disk.** State lives on `RouterState`. Restart clears it. There
  is no cross-session signal worth preserving (different conversations, different prompts).
- **Caching the async telemetry classifier spawn** (`hooks.ts:140`). Phase 1 gates only the
  synchronous path in `compose.ts`. Async telemetry is fire-and-forget and has separate semantics.

## Assumptions

1. **`RouterState` scope is per-session.** Sub-agent spawns (`task` tool) branch the context and
   get a fresh `RouterState` scope, so cached verdicts from the parent session do not leak into
   the child. This is current behavior — we are relying on it, not changing it.
2. **`getLastUserText` is stable within a turn.** The last user message text does not mutate during
   a single `resolveRouting` invocation. Signatures computed at the start of the function are valid
   throughout it.
3. **Context-capacity promotion is the only mid-loop event that legitimately changes routing without
   changing user text.** When `isContextTriggered` fires (compose.ts:141-170), the routing context
   has materially changed and the cache must be invalidated so the classifier re-evaluates.
4. **TTL=20 captures ≥98% of savings.** Validated empirically against the 2,183-turn corpus. The
   tail of long runs (p90=31, max=92) does see force re-runs under TTL=20, which is the safety
   margin we want — guarantees the classifier sees fresh input at least every 20 turns.
5. **Calibration matrix accuracy depends on per-turn `(heuristic, verdict)` pairs being recorded.**
   The cache HIT path still calls `updateCalibrationMatrix(heuristic, cachedVerdict)` so the
   training signal does not degrade — we just stop paying for the classifier call.
