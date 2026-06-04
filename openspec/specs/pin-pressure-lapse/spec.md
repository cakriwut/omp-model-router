# pin-pressure-lapse Specification

## Purpose
TBD - created by archiving change pin-pressure-lapse. Update Purpose after archive.
## Requirements
### Requirement: System pins lapse early under sustained signal pressure
When a system-set scoped pin (source: `heuristic`, `classifier`, `rule`, or `auto-upgrade`) is active, the router SHALL compute a heuristic shadow tier each turn (the tier the heuristic would have chosen without the pin). If the shadow tier disagrees with the pinned tier for `pinPressureThreshold` consecutive turns, the pin SHALL lapse immediately — clearing both `scopedPin` and `lastDecision` — and routing SHALL proceed freely for that turn.

#### Scenario: Pin lapses after threshold consecutive disagreements
- **WHEN** a system pin is active at tier T and the heuristic shadow returns a different tier for N consecutive turns (N ≥ `pinPressureThreshold`)
- **THEN** the pin is cleared, `lastDecision` is reset, the classifier cache is busted, and the current turn is routed freely by the heuristic

#### Scenario: Counter resets on agreement
- **WHEN** a system pin is active and the heuristic shadow agrees with the pinned tier on turn N+1 after one or more disagreements
- **THEN** `overridePressureCount` is reset to 0 and the pin remains active

#### Scenario: Isolated disagreements do not lapse the pin
- **WHEN** a system pin is active and the heuristic shadow disagrees on turn N, agrees on turn N+1, then disagrees again on turn N+2
- **THEN** the counter resets to 1 at turn N+2 and the pin is NOT lapsed (streak broken at N+1)

### Requirement: User pins are immune to pressure lapse
A scoped pin with `source: "user"` SHALL NOT be subject to pressure lapse regardless of how many consecutive turns the heuristic disagrees.

#### Scenario: User pin survives unlimited disagreement turns
- **WHEN** a user-set pin (`/router pin high`) is active and the heuristic shadow returns `low` for 10 consecutive turns
- **THEN** the pin remains active and all 10 turns are routed to `high`

### Requirement: Pressure counter is stored on the ScopedPin struct
The `ScopedPin` interface SHALL include an `overridePressureCount` field (number, default 0) that tracks the current consecutive disagreement streak. The counter SHALL be reset to 0 whenever a new `ScopedPin` is created (re-pin or post-lapse re-pin).

#### Scenario: New pin starts with zero pressure
- **WHEN** `setScopedPin` creates a new `ScopedPin` object
- **THEN** `overridePressureCount` is `0`

#### Scenario: Counter is updated in place on the existing pin object
- **WHEN** the heuristic shadow disagrees with an active system pin
- **THEN** `scopedPin.overridePressureCount` is incremented by 1 without replacing the `ScopedPin` object

### Requirement: `pinPressureThreshold` is a configurable RouterConfig field
`RouterConfig` SHALL include `pinPressureThreshold?: number`. When set to `0`, pressure lapse is disabled. When absent, the effective default SHALL be `3`.

#### Scenario: Pressure lapse disabled when threshold is zero
- **WHEN** `pinPressureThreshold` is `0` in config and a system pin is active with 10 consecutive disagreements
- **THEN** the pin is NOT lapsed early (only wall-clock timeout applies)

#### Scenario: Custom threshold respected
- **WHEN** `pinPressureThreshold` is `5` and a system pin has 4 consecutive disagreements
- **THEN** the pin is NOT lapsed (4 < 5)

#### Scenario: Custom threshold triggers lapse
- **WHEN** `pinPressureThreshold` is `5` and a system pin has 5 consecutive disagreements
- **THEN** the pin lapses and routing is free for that turn

### Requirement: Classifier cache is busted on pressure lapse
When a pressure lapse fires, the router SHALL clear `lastClassifierKey`, `lastClassifierVerdict`, and reset `classifierTurnsSinceRun` to `0` on the `RouterState`.

#### Scenario: Cache is cleared on lapse
- **WHEN** a pressure lapse triggers during a turn where classifier cache state is populated
- **THEN** `state.lastClassifierKey` is `undefined` after the lapse

### Requirement: Debug log emitted on pressure lapse
When `config.debug` is `true` and a pressure lapse fires, the router SHALL log a message including the tier, source, pressure count, and shadow tier.

#### Scenario: Debug log on lapse
- **WHEN** `debug: true` and pressure lapse fires (e.g. pin=high, shadow=low, count=3)
- **THEN** a line matching `[model-router] pin pressure lapse:` is logged to console containing the pin tier, source, pressure count, and shadow tier

### Requirement: `/router pin` status shows current pressure count
When a system pin is active and has `overridePressureCount > 0`, the `/router pin` status output SHALL include the current pressure count and configured threshold.

#### Scenario: Pressure shown in status
- **WHEN** `/router pin` is invoked with a system pin active and `overridePressureCount` is 2 with threshold 3
- **THEN** the status output includes text indicating `2/3` pressure or equivalent

