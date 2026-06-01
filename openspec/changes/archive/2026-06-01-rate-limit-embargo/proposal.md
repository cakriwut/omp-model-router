## Why

When a provider returns HTTP 429 (rate limited), 529 (overloaded), or 503 (service unavailable), the current fallback chain retries alternative models but re-evaluates from scratch on the next turn. This means the rate-limited primary model is retried every single turn, wasting latency on guaranteed failures until the embargo window expires. We need a "model embargo" mechanism that temporarily promotes the successful fallback as the effective primary, automatically lifting the embargo after a configurable cooldown or when the provider signals recovery.

## What Changes

- Introduce a **model embargo map** in router state that tracks which models are temporarily blocked and when the embargo expires
- On retryable HTTP errors (429, 529, 503, 502), record the failed model with a cooldown timestamp (default 60s, configurable; respects `Retry-After` header when available)
- During model chain construction, **skip embargoed models** — the first non-embargoed fallback becomes the effective primary
- Embargo auto-lifts when the cooldown expires; no manual intervention needed
- Add `/router embargo` subcommand to view/clear active embargoes
- Debug logging shows embargo decisions (`[model-router] ⏸ Embargoed: anthropic/claude-sonnet → 45s remaining`)

## Capabilities

### New Capabilities
- `rate-limit-embargo`: Automatic model embargo on retryable HTTP errors with time-based recovery

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- `src/provider.ts` — Fallback loop gains embargo-aware model filtering and status-aware error classification
- `src/state.ts` — New `embargoMap` field tracking model → expiry timestamps
- `src/commands/` — New `/router embargo` subcommand
- `src/types.ts` — New `EmbargoConfig` type and `embargo` field on `RouterConfig`
- `src/ui.ts` — Status widget shows embargo indicator when active
- `test/` — New test file for embargo logic
