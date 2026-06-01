## Context

The model-router extension already implements a fallback chain in `provider.ts`: when a model stream emits an `error` event, the loop catches it and tries the next model in `modelsToTry`. However, this is stateless — every new turn re-evaluates the full chain from the primary model, meaning a rate-limited model is retried (and fails) on every single turn until the provider recovers.

The `@oh-my-pi/pi-ai` library provides two key signals:

1. **`AssistantMessage.errorStatus`** — HTTP status code (429, 503, 529, etc.) populated by every provider's catch block
2. **`AssistantMessage.errorMessage`** — Contains embedded `retry-after-ms=<milliseconds>` suffix when providers surface `Retry-After` headers

The upstream `formatErrorMessageWithRetryAfter()` utility (in `@oh-my-pi/pi-ai/utils/retry-after`) automatically appends `retry-after-ms=<value>` to error messages by parsing:
- Standard `Retry-After` header (seconds or HTTP-date)
- `x-ratelimit-reset-ms` header (epoch ms or relative ms)
- `x-ratelimit-reset` header (epoch seconds or relative seconds)

This means the retry delay is **already embedded in the error message** by the time our extension sees it. We just need to parse it out.

### Provider-specific rate limit behaviors

| Provider | Status | Retry-After | Typical Duration |
|----------|--------|-------------|------------------|
| Anthropic (API) | 429 | `retry-after` header, seconds | 10-60s (per-minute) |
| Anthropic (Max subscription) | 429 | `retry-after` header | **1-8 hours** (daily limit) |
| OpenAI | 429 | `x-ratelimit-reset-ms`, `retry-after` | 10-60s (TPM/RPM), up to 24h (daily) |
| AWS Bedrock | 429 (ThrottlingException) | Sometimes `retry-after` | 1-60s (token bucket) |
| Google Vertex | 429 | `retry-after` | 30-60s |
| Google AI Studio | 429 | `retry-after` | 60s (free tier can be minutes) |

**Critical insight:** Anthropic Max subscriptions and OpenAI Tier-1 accounts can return `Retry-After` values of **hours** (not seconds). A fixed 60s default cooldown would be far too short — we must honor the actual `retry-after-ms` value from the error message when available, with a configurable maximum cap to prevent extreme starvation.

## Goals / Non-Goals

**Goals:**
- Automatically embargo models that return retryable HTTP errors (429, 503, 529, 502)
- Skip embargoed models in the fallback chain so the successful fallback becomes effective primary
- Auto-lift embargo after a configurable cooldown (default 60s; respects `Retry-After` if available)
- Surface embargo state via `/router embargo` and debug logging
- Preserve the `errorStatus` from stream error events for smarter error classification
- Non-retryable errors (401, 403) should NOT trigger embargo (they indicate config issues, not transient load)

**Non-Goals:**
- Persistent embargo across process restarts (embargo is ephemeral/in-memory only)
- Proactive health-check pings to embargoed models (too complex, not needed)
- Per-provider embargo (we embargo individual model refs, not entire providers)
- Retry-with-backoff within the same turn (the fallback chain already handles this)

## Decisions

### 1. Embargo stored as Map on RouterState + persisted to disk

**Decision:** Add `embargoMap: Map<string, EmbargoEntry>` to `RouterState`, backed by a lightweight JSON file at `~/.omp/agent/model-router-embargo.json`. On embargo change (set/lift/clear), write the map to disk. On init (`session_start`, `/reload`), read it back and restore non-expired entries.

**File format:**
```json
{
  "anthropic/claude-sonnet-4-20250514": {
    "expiresAt": 1748793600000,
    "reason": "429 rate limited",
    "status": 429,
    "embargoedAt": 1748790000000,
    "requestedDurationMs": 14400000,
    "effectiveDurationMs": 3600000
  }
}
```

**Rationale:** Long embargoes (Anthropic Max daily limit = hours, OpenAI Tier-1 daily = hours) survive `/reload` and process restarts. Without persistence, the router would waste one request per reload re-discovering the 429 and then re-embargo — acceptable for 60s embargoes but unacceptable for hour-long ones where the user may reload multiple times during the embargo window.

**Lifecycle:**
- **Write:** Debounced (100ms) after any embargo mutation (set/lift/clear) — same pattern as `RouterState.persist()`
- **Read:** On `session_start` and `reloadConfig()`. Discard entries where `expiresAt < Date.now()`
- **Cleanup:** Expired entries are filtered out on read; no background timer needed

**Alternative considered:**
- In-memory only (ephemeral) — rejected because Anthropic Max and OpenAI daily limits can be hours; losing embargo state on reload means repeated 429s
- Store in `SessionScope` per-session — rejected because embargo state should be global (if Claude is rate-limited for session A, it's also rate-limited for session B in the same process)
- Persist only long embargoes (> 5 min) — rejected for added complexity; the file is tiny and writes are debounced, so persisting all embargoes has negligible cost

### 2. Error classification: retryable vs non-retryable

**Decision:** Extract `errorStatus` from the stream error event. Classify as retryable:
- `429` — Rate limited
- `503` — Service unavailable
- `529` — Overloaded (Anthropic-specific)
- `502` — Bad gateway (usually transient)
- `undefined` status with error message containing "rate limit", "overloaded", "throttl" — heuristic fallback for providers that don't set status

Non-retryable (skip embargo, still fallback within turn):
- `401`, `403` — Auth/permission errors
- `400` — Bad request (implementation bug)

**Alternative considered:** Only embargo on 429 — rejected because 503/529 are equally transient and equally benefit from embargo.

### 3. Cooldown duration: provider-signaled with configurable bounds

**Decision:**
- **Primary signal:** Parse `retry-after-ms=<value>` from `errorMessage` (already appended by pi-ai's `formatErrorMessageWithRetryAfter`)
- **Fallback default:** `embargo.defaultCooldownMs` (default: 60000ms = 60s) when no `retry-after-ms` is present
- **Minimum floor:** `embargo.minCooldownMs` (default: 5000ms = 5s) — prevents rapid on/off cycling
- **Maximum cap:** `embargo.maxCooldownMs` (default: 3600000ms = 1 hour) — prevents extreme starvation from providers requesting multi-hour waits
- Final embargo duration: `clamp(retryAfterMs ?? defaultCooldownMs, minCooldownMs, maxCooldownMs)`

**Parsing `retry-after-ms`:**
```typescript
function parseRetryAfterMs(errorMessage: string): number | undefined {
  const match = errorMessage.match(/retry-after-ms=(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}
```

**Rationale:** The pi-ai framework already does the heavy lifting of parsing `Retry-After`, `x-ratelimit-reset-ms`, and `x-ratelimit-reset` headers and converting them to milliseconds. We simply extract the embedded hint. The configurable max cap (1 hour) balances respecting provider signals (Anthropic Max can request 8 hours) against user experience — if a user's primary model is embargoed for 8 hours, they'll want to know and possibly clear it manually. The `/router embargo` command provides that escape hatch.

**Alternative considered:**
- Fixed 60s cap (original design) — rejected because it ignores provider signals and would retry too aggressively against daily-limit 429s, wasting latency and possibly triggering harder bans.
- No maximum cap (blindly trust provider) — rejected because a provider could request hours and the user would have no recourse without the `/router embargo clear` command, which they may not know about.

### 4. Embargo-aware chain construction

**Decision:** Before the `for` loop in `streamSimple`, filter `modelsToTry` to exclude embargoed models. If ALL models are embargoed, use the one with the soonest expiry (never deadlock).

```
modelsToTry = modelsToTry.filter(ref => !isEmbargoed(ref))
if (modelsToTry.length === 0) modelsToTry = [soonestExpiry]
```

**Rationale:** Simple filter before the loop. The "soonest expiry" fallback prevents total service denial — better to retry a nearly-recovered model than return nothing.

### 5. Embargo lifecycle: set on retryable error, clear on success

**Decision:**
- **Set:** When a model fails with a retryable status in the fallback loop catch block
- **Clear (proactive):** When a model succeeds in the fallback loop, remove it from the embargo map (it recovered)
- **Clear (time):** `isEmbargoed(ref)` checks `Date.now() < entry.expiresAt`; expired entries are lazy-cleaned

### 6. `/router embargo` subcommand

**Decision:** Add subcommand showing active embargoes with time remaining. Include `clear` option to manually lift all embargoes.

```
/router embargo         → show active embargoes
/router embargo clear   → clear all embargoes
```

## Risks / Trade-offs

- **[Risk] All fallbacks embargoed simultaneously** → Mitigation: "soonest expiry" fallback ensures at least one model is always tried; never returns a total failure without attempting.
- **[Risk] False positive embargo from transient network blip** → Mitigation: 60s default is short enough that occasional false positives self-heal quickly. Single errors already trigger embargo — this is intentional for fast failover, and the cost is only 60s of avoidance.
- **[Risk] `errorStatus` not always populated by providers** → Mitigation: Heuristic text matching on `errorMessage` as secondary signal for "rate limit" / "overloaded" / "throttled" patterns.
- **[Trade-off] In-memory only means embargo lost on process restart** → Acceptable: process restarts are rare and the cost of one extra failed request on restart is negligible vs. complexity of persistence.
