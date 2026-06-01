## Why

`RouterState.finalizeChildSession` merges a sub-agent's `SessionScope` into its parent when `agent_end` fires. Today it merges only 5 of the 12 fields on `SessionScope`, silently dropping the rest:

| Dropped field | Impact |
|---|---|
| `compressionRequestCount` | Parent's compression stat under-counts how many times the tree compressed |
| `compressionTotalOriginalChars` | Compression ratio shown in `/router usage` is wrong for agent-tree sessions |
| `compressionTotalCompressedChars` | Same — denominator of the char-savings metric is incomplete |
| `tierCounter {high,medium,low}` | Per-tier decision counts are wrong; pie-bar in usage report misrepresents routing distribution |
| `modelCosts Map<string,ModelCostEntry>` | Per-model breakdown in usage report shows 0 invocations and 0 tokens for any model used exclusively by a sub-agent |

The correct numbers exist in memory (each sub-agent scope accumulates correctly for its own session) but are silently discarded at `finalizeChildSession`. Thread C (session-parent-link) ensured the parent link is reliable; Thread B wires the merge.

This is a prerequisite for Thread A (wire `/router usage` to in-memory scopes) — the reporting thread can only expose complete numbers once the rollup is complete.

## What Changes

- **Expand `finalizeChildSession`** in `src/state/index.ts` to merge all 8 aggregable numeric/map fields, not just 5. New fields added: `compressionRequestCount`, `compressionTotalOriginalChars`, `compressionTotalCompressedChars`, and element-wise `tierCounter`.
- **Extract `mergeModelCosts(target, source)`** — a private helper that merges a child `Map<string, ModelCostEntry>` into the parent's map. Merge rule: if key exists in parent, sum all numeric fields (`invocations`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost`) and keep the parent's `tier` label. If key is absent, copy the child entry directly.
- **Deliberately exclude** ephemeral fields (`isStreaming`, `lastTurnTimestamp`, `currentCheckpoint`) and presentation-only fields (`debugHistory`, `lastDecision`) from rollup — these describe a specific session's state, not aggregate metrics.
- **Test coverage** in a new `test/session-rollup-completeness.test.ts` covering all 8 merged fields, Map merge cases (new key, colliding key, collision with different tier labels), exclusion of ephemeral fields, multi-level rollup (grandchild → child → parent), and a regression guard that every future `SessionScope` field is either explicitly merged or explicitly excluded.

## Capabilities

### Modified Capabilities

- `session-rollup`: `finalizeChildSession` now merges the complete set of aggregable metrics. The parent scope after `agent_end` reflects the full activity of the agent tree, not just the 5 cost/token counters.

## Non-Goals

- Wiring `/router usage` to read from in-memory scopes — Thread A / separate change. The data will be complete after this change; reporting it is Thread A's job.
- Per-tree budget enforcement — Thread D / separate change.
- Moving `frozenCompressionBlock` into `SessionScope` — Thread E / separate change.
- Changing the rollup trigger (`agent_end`) or rollup timing.
- Cross-process rollup (child restarts in a new process; Thread C established this is out of scope).
