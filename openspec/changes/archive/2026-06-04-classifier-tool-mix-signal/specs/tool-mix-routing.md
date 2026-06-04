# Specification: Tool-Mix Routing Signal

## Scope

This specification defines the behavior added by `classifier-tool-mix-signal` on top of the cache established by `classifier-prompt-cache` (Phase 1). It covers:

- Tool-name extraction from recent assistant messages.
- Bucket categorization of the extracted counts.
- Cache-key extension with the bucket value.
- Classifier-prompt augmentation with a tool-activity summary line.

It does NOT cover Phase 1's cache semantics (TTL, scope, calibration-on-hit, context-capacity invalidation) — those are unchanged and specified in Phase 1's spec.

## Definitions

| Term | Definition |
|------|-----------|
| **Tool call** | A content block with `type === "toolCall"` on an assistant message; identified by `block.name`. |
| **Tool result** | A message with `role === "toolResult"`. **Never** read by this specification. |
| **Recent window** | All assistant messages occurring strictly after the most recent `role === "user"` message in `context.messages`. |
| **Tool-name list** | The chronological sequence of `block.name` values from `toolCall` blocks within the recent window, capped at the most recent 12 entries. |
| **Counts** | `Record<string, number>` mapping tool name → call count, derived from the tool-name list. |
| **Bucket** | One of `"exploration" \| "implementation" \| "verification" \| "delegation" \| "mixed" \| "fresh"`. |
| **Dominance threshold** | `0.60` — the minimum share of total calls for a named bucket to win. |
| **Window cap** | `12` — maximum number of tool names retained for counting. |

## Tool Extraction Rules

1. Iterate `context.messages` from the last index backwards.
2. Stop **exclusive** at the first `role === "user"` message encountered.
3. For each `role === "assistant"` message in the window where `Array.isArray(msg.content)`:
   - For each block `b` in `msg.content`:
     - If `b.type === "toolCall"` and `typeof b.name === "string"` and `b.name.length > 0`: collect `b.name`.
   - Skip all other block types (`text`, `thinking`, etc.).
4. Reverse the collected list to chronological order.
5. Keep only the **last 12** entries (most recent preserved on truncation).
6. Aggregate into `counts`.

**MUST NOT** read:
- `block.arguments` of any tool call.
- Any content of `role === "toolResult"` messages.
- Any text or thinking blocks.

## Bucket Mapping

### Category Map

| Bucket | Tool names |
|--------|-----------|
| `exploration` | `read`, `search`, `find`, `ast_grep`, `lsp_hover`, `lsp_references`, `lsp_definition`, `lsp_symbols`, `web_search`, `browser` |
| `implementation` | `edit`, `write`, `ast_edit`, `lsp_rename`, `lsp_code_actions` |
| `verification` | `debug` (and `bash` once argument-based disambiguation lands; see limitation below) |
| `delegation` | `task`, `eval` |
| `other` | every tool name not listed above, including `bash` in the initial implementation |

### Bucket Algorithm

```
total = sum(counts.values())
if total < 2:
    return "fresh"

categoryTotals = aggregate counts via category map
                 (unmapped names accumulate into "other")

topCategory, topCount = argmax over {exploration, implementation, verification, delegation}
                       of categoryTotals
if topCount / total >= 0.60:
    return topCategory
return "mixed"
```

The `other` bucket is included in `total` (denominator) but **never** returned as a winner. A run dominated entirely by unmapped tools resolves to `"mixed"`.

### Known Limitation: `bash`

`bash` is intentionally mapped to `other` in the initial implementation. Disambiguating verification (`bash bun test`, `bash bun run lint`) from general shell (`bash git status`) requires inspecting arguments, which this specification forbids. The limitation is documented and reviewed in Task 7's empirical validation; promotion of `bash` to `verification` is a future change scoped by that data.

## Cache Key Contract

Phase 1 cache signature is extended:

```
Phase 1: sig = lastUserText + "|" + userMsgIndex
Phase 2: sig = lastUserText + "|" + userMsgIndex + "|" + bucket
```

**Invariants:**
- The bucket value is the output of the algorithm above on the current `context.messages`.
- `"fresh"` and `"mixed"` are stable signature components; both persist across turns until the bucket genuinely transitions.
- A bucket transition (`exploration → implementation`, `mixed → verification`, etc.) MUST cause a cache MISS.
- A bucket-stable turn (same bucket as previous turn, including `fresh → fresh` and `mixed → mixed`) MUST NOT cause an invalidation on bucket grounds alone (Phase 1's TTL and capacity-event edges still apply orthogonally).

**Out of scope:**
- The async classifier path in `hooks.ts` is not modified.
- No changes to `RouterState` fields beyond what Phase 1 added.

## Classifier Prompt Contract

When `counts` is non-empty, `buildClassifierPrompt` MUST include exactly one line of the form:

```
Recent agent activity (last 12 tool calls): NAME1×COUNT1 NAME2×COUNT2 ...
```

Requirements:

1. The line appears immediately after the history block and before the tier-definition block.
2. Entries are sorted by count **descending**. Ties may be in any deterministic order.
3. Each entry is `name×count` with no spaces around `×` and a single space between entries.
4. The line is **omitted entirely** (no header, no blank placeholder) when `counts` is `undefined`, `{}`, or `total === 0`.
5. The line MUST NOT contain tool arguments, tool result content, file paths, code snippets, or any data beyond tool names and integer counts.
6. The added line MUST add ≤20 tokens to the classifier prompt in the worst case (12 distinct one-character names — bounded by the window cap).

The bucket label is **never** placed in the classifier prompt. The prompt receives raw counts; the bucket exists only as a cache-key derivative.

## Trace Contract: `toolResultCount`

`promptFeatures.toolResultCount` MUST reflect the actual count of `role === "toolResult"` messages in the routing context. The previously broken behavior (constant `0`) is fixed as a prerequisite to this specification.

This field is consumed by trace analysis only; it does NOT affect routing decisions in Phase 2. (The bucket signal walks `context.messages` directly and is independent of `promptFeatures`.)

## Behavior Examples

### Example 1: Exploration phase
- Window: 8 messages with tool calls `read, read, search, read, read, find, read, ast_grep`.
- Counts: `{ read: 5, search: 1, find: 1, ast_grep: 1 }`.
- Total: 8. Exploration share: 8/8 = 100%. **Bucket: `exploration`**.
- Cache key: `...|exploration`.
- Prompt line: `Recent agent activity (last 12 tool calls): read×5 search×1 find×1 ast_grep×1`.

### Example 2: Implementation phase
- Window: tool calls `read, edit, edit, write, edit, bash`.
- Counts: `{ read: 1, edit: 3, write: 1, bash: 1 }`.
- Total: 6. Implementation share: 4/6 ≈ 66.7% ≥ 60%. **Bucket: `implementation`**.
- Prompt line: `Recent agent activity (last 12 tool calls): edit×3 read×1 write×1 bash×1`.

### Example 3: Mixed
- Window: `read, read, edit, edit, bash, debug`.
- Counts: `{ read: 2, edit: 2, bash: 1, debug: 1 }`.
- Category totals: exploration=2, implementation=2, verification=1, delegation=0, other=1.
- Total: 6. Max named share: 2/6 ≈ 33% < 60%. **Bucket: `mixed`**.

### Example 4: Fresh (insufficient signal)
- Window: 1 tool call `read`.
- Total: 1 < 2. **Bucket: `fresh`**.
- Cache key: `...|fresh`. Prompt line is still emitted (`read×1`) because counts is non-empty.

### Example 5: Phase transition within a single user message
- Turn 5: window has `read × 7`, bucket = `exploration`. Cache key A.
- Turn 12: same user msg, window now has `read × 4, edit × 5, write × 2`. Exploration share 4/11 = 36%; implementation share 7/11 = 64%. Bucket = `implementation`. Cache key B ≠ A. **Cache MISS → classifier re-runs.**

### Example 6: Bucket-stable cache HIT
- Turn 5: bucket = `exploration`. Cache key A.
- Turn 6: bucket still `exploration` (one more `read` added). Cache key A.  **Cache HIT → classifier skipped.** Calibration matrix still updated per Phase 1.

## Invariants

1. **Privacy.** No tool argument, tool result body, or non-name tool metadata reaches the classifier prompt or the cache key under any code path defined by this specification.
2. **Determinism.** Given the same `context.messages`, `extractRecentToolCalls` and `getBucket` return the same result. No reliance on wall-clock, randomness, or session state.
3. **Bounded cost.** Extraction is O(messages-in-window) and stops at the last user message. Bucket is O(distinct tool names). No allocations beyond a 12-entry array and ≤6-key record per call.
4. **Phase 1 invariants preserved.** TTL, calibration-on-hit, context-capacity invalidation, and `RouterState` scoping remain exactly as defined by `classifier-prompt-cache`.
5. **Additive prompt change.** The classifier prompt is identical to Phase 1's output when `counts` is empty or undefined, ensuring backward-compatible verdicts on fresh user messages.
6. **No `RouterConfig` surface added.** All Phase 2 constants (window cap, dominance threshold, category map) live in source. Promotion to config is gated by Task 7's empirical findings.

## Out of Scope

- Tuning bucket category membership post-deployment (requires Task 7 data).
- Argument-based `bash` disambiguation.
- Surfacing the bucket label to the classifier prompt.
- Modifying the async classifier path in `hooks.ts`.
- Adding any new `RouterConfig` fields or `FALLBACK_CONFIG` entries.
