## ADDED Requirements

### Requirement: Embargo on retryable HTTP errors
The system SHALL automatically embargo a model when it returns a retryable HTTP error status (429, 503, 529, 502) during the fallback chain execution.

#### Scenario: Model returns 429 rate limited
- **WHEN** a model in the fallback chain returns HTTP 429 (rate limited)
- **THEN** the model ref SHALL be added to the embargo map with an expiry timestamp of `now + computedDuration`
- **AND** the embargo SHALL be persisted to disk
- **AND** the fallback chain SHALL continue to the next model

#### Scenario: Model returns 503 service unavailable
- **WHEN** a model returns HTTP 503 during streaming
- **THEN** the model ref SHALL be embargoed with the computed cooldown duration and persisted

#### Scenario: Model returns error with rate-limit text but no status code
- **WHEN** a model returns an error with no `errorStatus` but `errorMessage` contains "rate limit", "overloaded", or "throttled" (case-insensitive)
- **THEN** the system SHALL treat it as a retryable error and embargo the model

#### Scenario: Model returns 401 unauthorized
- **WHEN** a model returns HTTP 401 or 403
- **THEN** the system SHALL NOT embargo the model (non-retryable)
- **AND** the fallback chain SHALL continue to the next model without recording an embargo

### Requirement: Embargoed models skipped in chain construction
The system SHALL skip embargoed models when constructing the fallback chain for a turn, effectively promoting the first non-embargoed fallback as the primary.

#### Scenario: Primary model is embargoed
- **WHEN** the primary model for a tier is in the embargo map with a future expiry
- **THEN** the system SHALL skip it and use the first non-embargoed fallback model
- **AND** the decision SHALL indicate `isEmbargoed: true` in debug output

#### Scenario: All models in chain are embargoed
- **WHEN** every model in the fallback chain is currently embargoed
- **THEN** the system SHALL use the model with the soonest expiry timestamp
- **AND** the system SHALL NOT return a total failure without attempting at least one model

#### Scenario: Embargo has expired
- **WHEN** the current time is past the embargo expiry timestamp for a model
- **THEN** the model SHALL be treated as available and included in the chain normally

### Requirement: Embargo auto-lifts on success
The system SHALL remove a model from the embargo map when it successfully completes a stream, and persist the change.

#### Scenario: Previously embargoed model succeeds
- **WHEN** an embargoed model is retried (because embargo expired or it was soonest-expiry fallback)
- **AND** the stream completes successfully
- **THEN** the embargo entry SHALL be removed immediately and the change persisted to disk

### Requirement: Embargo persistence across reload and restart
The system SHALL persist embargo state to disk so that long-duration embargoes survive `/reload` and process restarts.

#### Scenario: Embargo survives reload
- **WHEN** a model is embargoed with 1 hour duration
- **AND** the user runs `/reload` after 10 minutes
- **THEN** the embargo SHALL be restored from disk with the remaining 50 minutes of duration

#### Scenario: Expired embargo discarded on reload
- **WHEN** a model was embargoed but the expiry time has passed
- **AND** the system reloads or restarts
- **THEN** the expired embargo entry SHALL NOT be restored (model is available)

#### Scenario: Embargo file location
- **WHEN** the system persists embargo state
- **THEN** it SHALL write to `~/.omp/agent/model-router-embargo.json`

#### Scenario: Embargo file missing or corrupt
- **WHEN** the embargo file does not exist or contains invalid JSON
- **THEN** the system SHALL start with an empty embargo map (no error thrown)

#### Scenario: Debounced persistence
- **WHEN** multiple embargo mutations occur within 100ms (e.g., multiple models fail in one fallback chain)
- **THEN** the system SHALL batch them into a single disk write

### Requirement: Retry-After signal parsing from error message
The system SHALL parse the `retry-after-ms=<milliseconds>` hint embedded in `errorMessage` by the pi-ai framework and use it to set accurate embargo duration.

#### Scenario: Error message contains retry-after-ms hint
- **WHEN** a retryable error's `errorMessage` contains `retry-after-ms=30000`
- **THEN** the embargo duration SHALL be `clamp(30000, minCooldownMs, maxCooldownMs)` milliseconds

#### Scenario: Error message has no retry-after-ms hint
- **WHEN** a retryable error's `errorMessage` does NOT contain a `retry-after-ms=` pattern
- **THEN** the embargo duration SHALL use `defaultCooldownMs` (default 60000ms)

#### Scenario: Retry-After exceeds maximum cap
- **WHEN** a parsed `retry-after-ms` value exceeds `maxCooldownMs` (default 3600000ms = 1 hour)
- **THEN** the embargo duration SHALL be capped at `maxCooldownMs`

#### Scenario: Retry-After below minimum floor
- **WHEN** a parsed `retry-after-ms` value is below `minCooldownMs` (default 5000ms = 5s)
- **THEN** the embargo duration SHALL be raised to `minCooldownMs` to prevent rapid cycling

#### Scenario: Anthropic Max subscription daily limit (long retry-after)
- **WHEN** Anthropic returns 429 with `retry-after-ms=14400000` (4 hours) due to daily limit exhaustion
- **THEN** the embargo duration SHALL be capped at `maxCooldownMs` (1 hour by default)
- **AND** the embargo reason SHALL include the original requested duration for user visibility

### Requirement: Embargo configuration
The system SHALL support configuring embargo behavior via the `embargo` field in `model-router.json`.

#### Scenario: Custom default cooldown
- **WHEN** `embargo.defaultCooldownMs` is set to 120000 in config
- **THEN** new embargoes without a `retry-after-ms` signal SHALL use 120000ms as the default cooldown duration

#### Scenario: Custom maximum cap
- **WHEN** `embargo.maxCooldownMs` is set to 7200000 (2 hours) in config
- **THEN** embargo durations SHALL be capped at 7200000ms regardless of `retry-after-ms` value

#### Scenario: Custom minimum floor
- **WHEN** `embargo.minCooldownMs` is set to 10000 (10s) in config
- **THEN** embargo durations SHALL never be below 10000ms

#### Scenario: Embargo disabled
- **WHEN** `embargo.enabled` is set to `false` in config
- **THEN** no embargoes SHALL be recorded and the fallback chain SHALL behave as before (try all models each turn)

#### Scenario: Default configuration
- **WHEN** no `embargo` field exists in config
- **THEN** embargo SHALL be enabled by default with `defaultCooldownMs: 60000`, `minCooldownMs: 5000`, `maxCooldownMs: 3600000`

### Requirement: Embargo visibility via command
The system SHALL expose active embargoes via `/router embargo` subcommand.

#### Scenario: View active embargoes
- **WHEN** user runs `/router embargo`
- **AND** there are active (non-expired) embargoes
- **THEN** the system SHALL display each embargoed model, the reason, and time remaining

#### Scenario: No active embargoes
- **WHEN** user runs `/router embargo`
- **AND** there are no active embargoes
- **THEN** the system SHALL display "No active embargoes"

#### Scenario: Clear all embargoes
- **WHEN** user runs `/router embargo clear`
- **THEN** all entries in the embargo map SHALL be removed immediately
- **AND** the system SHALL confirm clearance

### Requirement: Debug logging for embargo decisions
The system SHALL log embargo-related events when `debug: true` is configured.

#### Scenario: Model embargoed during fallback
- **WHEN** `debug` is `true` and a model is embargoed due to retryable error
- **THEN** the system SHALL log `[model-router] ⏸ Embargoed: <modelRef> for <seconds>s (HTTP <status>)`

#### Scenario: Model skipped due to embargo
- **WHEN** `debug` is `true` and a model is skipped because it is embargoed
- **THEN** the system SHALL log `[model-router] ⏭ Skipped (embargoed): <modelRef> — <seconds>s remaining`

#### Scenario: Embargo lifted on success
- **WHEN** `debug` is `true` and a model's embargo is cleared after successful stream
- **THEN** the system SHALL log `[model-router] ✓ Embargo lifted: <modelRef>`
