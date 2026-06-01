# Design: Classifier Tool-Mix Signal

## Context

Phase 1 (`classifier-prompt-cache`) caches classifier verdicts on `(lastUserText, userMsgIndex)` plus a TTL. Phase 2 adds one more dimension to that key — the **tool-mix bucket** — so that mid-loop behavioral phase transitions also invalidate the cache. As a side effect, the same bucket-source counts are surfaced to the classifier as a single summary line, giving the LLM a concrete behavioral input.

## Data Flow

```
resolveRouting(context, ...)
  │
  ├─ Phase 1: compute lastUserText + userMsgIndex
  │
  ├─ Phase 2:
  │    extractRecentToolCalls(context)
  │       └─ walk context.messages backwards to last role=="user"
  │       └─ collect block.name for block.type === "toolCall" on assistant msgs
  │       └─ cap at last 12 names (preserve recency)
  │       └─ aggregate: { read: 4, edit: 3, bash: 1 }
  │    getBucket(counts)
  │       └─ apply category map → category totals
  │       └─ if total < 2 → "fresh"
  │       └─ if max share ≥ 60% → that category
  │       └─ else → "mixed"
  │
  ├─ cache key = lastUserText + "|" + userMsgIndex + "|" + bucket
  │
  ├─ cache HIT → reuse verdict (skip runClassifier)
  ├─ cache MISS → buildClassifierPrompt(context) — now includes:
  │      "Recent agent activity (last 12 tool calls): read×4 edit×3 bash×1"
  │   then runClassifier → store (sig, verdict, turn counter)
```

## Components

### `extractRecentToolCalls(context)` — `src/utils/messages.ts`

**Signature:**
```typescript
export function extractRecentToolCalls(
    context: Context,
): { counts: Record<string, number>; names: string[] };
```

**Behavior:**
1. Iterate `context.messages` from `length-1` down to `0`.
2. Stop the moment a message with `role === "user"` is reached (exclusive — do not include).
3. For each assistant message in the window, walk `msg.content` (array form only — plain string assistant messages have no tool calls) and collect `block.name` for every block where `block.type === "toolCall"`.
4. Reverse the collected list to chronological order, then keep only the **last 12** entries (preserves the most recent context).
5. Build `counts` by tallying the trimmed list.

**Rationale for walking backwards:**
- Matches Phase 1's `userMsgIndex` semantic (current user-message window).
- Avoids re-scanning the full transcript on every turn.
- Mirrors the existing pattern in `serializeToolSequence` (`context-compression.ts:219-240`) which iterates messages and extracts `block.name` from `toolCall` blocks — we reuse the same shape assumption, no new schema dependencies.

**What is explicitly NOT extracted:**
- Tool arguments (`block.arguments`)
- Tool result bodies (`toolResult` messages and their content)
- Thinking blocks
- Text content of assistant messages

This preserves the privacy/size invariant documented at the top of `classifier-utils.ts` ("Tool calls, tool results, thinking blocks, and other non-text content are excluded").

### `getBucket(counts)` — `src/utils/messages.ts` (collocated) OR `src/routing/tool-mix.ts`

**Signature:**
```typescript
export function getBucket(counts: Record<string, number>): Bucket;
type Bucket = "exploration" | "implementation" | "verification" | "delegation" | "mixed" | "fresh";
```

**Category map:**

| Bucket | Tool names |
|--------|-----------|
| `exploration` | `read`, `search`, `find`, `ast_grep`, `lsp_hover`, `lsp_references`, `lsp_definition`, `lsp_symbols`, `web_search`, `browser` |
| `implementation` | `edit`, `write`, `ast_edit`, `lsp_rename`, `lsp_code_actions` |
| `verification` | `bash` (when matching test/lint patterns), `debug` |
| `delegation` | `task`, `eval` |
| `other` | everything else (folded into total but never wins) |

LSP sub-tools are listed by their actual block names; if the underlying tool surface exposes a single `lsp` name with a sub-command argument, the implementation falls back to bucketing all LSP calls as `exploration` (the safer default, since args are not inspected by design).

**`bash` disambiguation:** without inspecting arguments (which we don't), `bash` cannot reliably be split between `verification` (test/lint) and `other` (general shell). The implementation MUST treat all `bash` calls as `other` unless a future enhancement (out of scope here) makes args available; **the table above documents the intent**, the initial implementation buckets `bash` conservatively into `other` and notes the divergence as a known limitation for Task 7's empirical review.

**Dominance algorithm:**
```
total = sum(counts.values())
if total < 2: return "fresh"

categoryTotals = aggregate counts by category map
topCategory, topShare = argmax_by_value(categoryTotals)
if topShare / total >= 0.60: return topCategory
return "mixed"
```

**Why 60%?**
- 50% is the natural "majority" but unstable: a 5-call window with 3 reads / 2 edits flips between `exploration` and `mixed` on every single new edit.
- 60% requires a clearer lean. In a 12-call window, that's ≥8 calls of one category — a genuine pattern, not noise.
- 100% would be too strict — real exploration phases interleave the occasional `bash` (e.g. `git status`).

**Why "fresh" for <2 calls?**
- Zero or one tool call is not a phase, it's the start of work. Treating it as a real bucket would cause the cache key to swing between `fresh → exploration` on the second turn — a spurious invalidation.
- `fresh` is a stable string that the classifier prompt does NOT need to know about (the prompt receives the raw counts line, which will simply be absent or empty for fresh sessions).

### Cache Key Extension — `src/routing/compose.ts`

**Phase 1 signature:**
```
sig = lastUserText + "|" + userMsgIndex
```

**Phase 2 signature:**
```
sig = lastUserText + "|" + userMsgIndex + "|" + bucket
```

**Invariants preserved from Phase 1:**
- `RouterState`-scoped cache fields (`lastClassifierKey`, `lastClassifierVerdict`, `classifierTurnsSinceRun`).
- TTL of 20 turns (force re-run even on stable sig).
- Context-capacity event still busts the cache (orthogonal invalidation edge).
- Calibration matrix still updated on cache HIT.

**New invalidation edge:** bucket transition. When `bucket` flips (`exploration → implementation`, `mixed → verification`, etc.), `sig` changes and the cache misses. Re-run captures the new behavioral context in both the cache key and the prompt summary line.

**Stability cases:**
- `fresh → fresh`: stable, no invalidation (correct — still gathering signal).
- `mixed → mixed`: stable.
- `exploration → exploration` (with growing counts): stable — same bucket, same key. The counts line in the prompt changes, but the prompt is only computed on cache MISS, so this is moot for cache behavior.

### Classifier Prompt Injection — `src/calibration/classifier-utils.ts`

**Injection point:** `buildClassifierPrompt`, immediately after the history section (output of `getConversationSummary`) and before the tier-definition block.

**Format:**
```
Recent agent activity (last 12 tool calls): read×4 edit×3 bash×1
```

- Sorted by count descending (most-used tool first).
- Token cost: ~15 tokens for typical 3-5 distinct tools. Bounded at ~20 tokens worst case (12 distinct tool names, each `name×1`).
- Omitted entirely when `total === 0` (no tool calls yet — nothing to say).
- Counts are sent as raw `name×count`, NOT as the bucket label. The bucket is a cache-key derivative; the LLM benefits more from raw counts because it can reason about specific tools (e.g. "lots of `bash` + `debug` = debugging") rather than a pre-categorized label that loses information.

**Why raw counts, not the bucket label?**
- The bucket is a coarse aggregation optimized for cache stability (60% threshold, fixed categories).
- The classifier benefits from finer signal: distinguishing `read×8` (exploration) from `bash×8` (verification or general shell) matters for tier choice, but both might fall into different buckets — or the same `mixed` bucket — depending on the exact mix.
- Raw counts cost the same ~15 tokens and lose no information.

## Interfaces

**Already in scope (no new types needed):**
- `Context` from `@oh-my-pi/pi-ai`
- `Message` content blocks (`type: "toolCall"` with `name: string`)
- `RouterState` fields added in Phase 1

**New exports:**
- `extractRecentToolCalls(context: Context): { counts: Record<string, number>; names: string[] }` from `src/utils/messages.ts`
- `getBucket(counts: Record<string, number>): Bucket` collocated with above
- `type Bucket` (string literal union)

**No `RouterConfig` changes.** Phase 2 has no user-facing config — bucket categories, dominance threshold, and window size are constants in the source. (If empirical data from Task 7 motivates tuning, a future change can lift them into config — out of scope here.)

## Edge Cases

### E1: Sub-agent spawn (task tool)
A `task` block creates a `delegation`-bucketed call in the parent's history. The sub-agent runs in its own `RouterState` scope (Phase 1's design) and gets a fresh cache. No special handling needed — the parent sees `delegation` activity, the child sees its own fresh window.

### E2: No assistant messages since last user message
Empty `names` list, empty `counts`, `total = 0` → bucket = `"fresh"`. Cache key contains `"fresh"`, prompt omits the activity line.

### E3: Window of exactly 12 tool calls before any user message in context
Hit the cap exactly. No truncation overhead matters.

### E4: Window of 50+ tool calls (long autonomous loop with no user input yet)
Keep only the last 12 (most recent). Earlier calls are intentionally dropped — phase transitions are about recent behavior, not full history.

### E5: Tool call to an unknown name (e.g., a new tool not in any category)
Folded into the `other` aggregate. It contributes to `total` (and therefore to the dominance denominator) but cannot win the dominance race. If a session is dominated by unknown tools, the bucket correctly resolves to `mixed`.

### E6: Assistant message has both text and toolCall blocks
Only `toolCall` blocks are extracted. Text content is ignored (already covered by the existing `getConversationSummary` path).

### E7: Message ordering anomaly (toolResult before its toolCall)
Not addressed — Phase 2 only reads `toolCall` blocks on assistant messages. `toolResult` messages are skipped entirely.

### E8: Stochastic classifier disagreement on identical bucket
Phase 1's mitigation (cache HIT reuses verdict) still applies. The bucket only changes the cache key when behavior genuinely shifts; within a stable bucket, the cached verdict persists.

## Migration Notes

- **Order of deployment:** Phase 1 ships first, stabilizes for ≥1 week with cache hit-rate telemetry. Phase 2 ships after.
- **Backward compatibility:** Phase 2 extends the cache key. Old cached entries (Phase 1, no bucket suffix) will simply miss once on first turn after Phase 2 deploys and rebuild correctly. No data migration needed (cache is in-memory `RouterState`).
- **Rollback:** Revert the cache-key extension in `compose.ts` and the prompt injection in `classifier-utils.ts`. `extractRecentToolCalls` and `getBucket` can remain as dead exports — they have no side effects and zero callers after revert.

## Performance Notes

- `extractRecentToolCalls` is O(messages × blocks-per-message) in the worst case, but the backwards walk stops at the last user message — typically ≤30 messages traversed even in long loops.
- Allocations per call: one `Record<string, number>` (≤12 keys), one intermediate `names: string[]` (≤12 entries). Reused on every classifier invocation that misses the cache; on HITs, this still runs to compute the key.
- `getBucket` is O(distinct tool names) ≤ ~20 entries in the category map. No allocations in the hot path beyond the categoryTotals object.
- Net effect: a single classifier invocation costs ~1–10ms for the LLM call; the bucket computation is <0.05ms. Negligible.
