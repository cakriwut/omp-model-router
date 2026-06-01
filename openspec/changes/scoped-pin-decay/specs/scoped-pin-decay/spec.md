## ADDED Requirements

### Requirement: Scoped pin stored per session
The system SHALL store the active pin as a `scopedPin` field on each `SessionScope` instance. The `scopedPin` SHALL contain the tier, the timestamp when set (`setAt`), and the source (`"user"` | `"heuristic"` | `"classifier"` | `"rule"` | `"auto-upgrade"`).

#### Scenario: Sub-agent has independent pin
- **WHEN** a sub-agent session is activated with its own `SessionScope`
- **THEN** the sub-agent's `scopedPin` is independent of the parent session's pin

#### Scenario: Parent pin unaffected by child
- **WHEN** a sub-agent sets a scoped pin to "high"
- **THEN** the parent session's `scopedPin` remains unchanged

### Requirement: Pin decays after timeout
The system SHALL clear `scopedPin` when `Date.now() - scopedPin.setAt >= config.pinTimeout`. The default `pinTimeout` SHALL be 600,000 milliseconds (10 minutes).

#### Scenario: Pin expires after configured timeout
- **WHEN** a scoped pin was set 10 minutes ago (default timeout)
- **AND** a new routing decision is requested
- **THEN** the system clears `scopedPin` and routes without a pin

#### Scenario: Pin still active within timeout
- **WHEN** a scoped pin was set 5 minutes ago (default timeout is 10 min)
- **AND** a new routing decision is requested
- **THEN** the system uses the scoped pin's tier for routing

### Requirement: Decay clears previousDecision
The system SHALL clear `scope.lastDecision` when a scoped pin expires, preventing the heuristic from using stale phase information (Rule J re-trigger).

#### Scenario: Heuristic runs fresh after decay
- **WHEN** a scoped pin expires (timeout reached)
- **AND** the next routing decision is evaluated
- **THEN** `previousDecision` passed to heuristic is `undefined`
- **AND** the heuristic evaluates the prompt without any phase bias

### Requirement: Decay returns to config floor
The system SHALL use `config.defaultPin` as the effective pin after a scoped pin expires. When `defaultPin` is `"auto"`, no pin is applied and the heuristic decides freely. When `defaultPin` is a tier value (`"high"` | `"medium"` | `"low"`), that tier is used as a permanent (non-decaying) pin.

#### Scenario: Decay with defaultPin auto
- **WHEN** a scoped pin expires
- **AND** `config.defaultPin` is `"auto"`
- **THEN** no pin is active and the heuristic runs freely

#### Scenario: Decay with defaultPin high
- **WHEN** a scoped pin expires
- **AND** `config.defaultPin` is `"high"`
- **THEN** the effective pin is `"high"` (config floor acts as permanent pin)

### Requirement: User commands have P1 priority
User-initiated pin changes (`/router pin <tier>`, `/router fix <tier>`) SHALL always override any existing scoped pin and reset the decay timer, regardless of the current pin's source.

#### Scenario: User overrides system pin
- **WHEN** a scoped pin is active with `source: "heuristic"` and tier `"high"`
- **AND** user runs `/router pin medium`
- **THEN** `scopedPin` becomes `{ tier: "medium", setAt: now, source: "user" }`
- **AND** the decay timer resets

#### Scenario: User overrides user pin
- **WHEN** a scoped pin is active with `source: "user"` and tier `"high"`
- **AND** user runs `/router pin low`
- **THEN** `scopedPin` becomes `{ tier: "low", setAt: now, source: "user" }`
- **AND** the decay timer resets

### Requirement: System sources have P2 priority
System-initiated pin changes (heuristic Rule J, classifier override, custom rule match, auto-upgrade) SHALL only set a scoped pin when no active (non-expired) pin exists. They MUST NOT override or reset the timer of an existing pin.

#### Scenario: System blocked by active pin
- **WHEN** a scoped pin is active (not expired)
- **AND** the heuristic's Rule J wants to set tier "high"
- **THEN** the existing pin remains unchanged
- **AND** the heuristic's decision is still recorded as `lastDecision`

#### Scenario: System sets pin when none active
- **WHEN** no scoped pin is active (absent or expired)
- **AND** the heuristic's Rule J fires with tier "high"
- **THEN** `scopedPin` is set to `{ tier: "high", setAt: now, source: "heuristic" }`

#### Scenario: Classifier blocked by active pin
- **WHEN** a scoped pin is active with `source: "user"`, tier "medium"
- **AND** the classifier decides tier should be "high"
- **THEN** the pin remains `"medium"` (user's choice honored)

### Requirement: Pin auto clears immediately
The `/router pin auto` command SHALL immediately clear `scopedPin` AND `scope.lastDecision`, providing a manual "decay now" action. The next routing decision runs the heuristic fresh.

#### Scenario: User clears pin manually
- **WHEN** a scoped pin is active
- **AND** user runs `/router pin auto`
- **THEN** `scopedPin` is cleared
- **AND** `scope.lastDecision` is cleared
- **AND** the next routing decision runs the heuristic with no phase bias

### Requirement: Pin is memory-only
The system SHALL NOT persist `scopedPin` to disk (`router-state.json`) or to session entries. A new session always starts with no scoped pin (config floor applies).

#### Scenario: Fresh session has no pin
- **WHEN** a new session starts
- **THEN** `scope.scopedPin` is `undefined`
- **AND** effective pin is determined by `config.defaultPin`

#### Scenario: Pin not in persisted state
- **WHEN** state is persisted to `router-state.json`
- **THEN** no pin-related fields (`pinByProfile`, `pinTier`) are written

### Requirement: Pin-creating system events
The following system events SHALL create a scoped pin (when no active pin exists): heuristic Rule J (sticky planning), classifier override in adaptive mode, custom rule match, and auto-upgrade from tool failures. Normal heuristic results (implementation keywords, lookup, summary, git), budget downgrade, and context capacity promotion SHALL NOT create pins.

#### Scenario: Rule J creates pin
- **WHEN** no active pin exists
- **AND** heuristic Rule J fires ("kept planning-phase bias")
- **THEN** a scoped pin is created with `source: "heuristic"`

#### Scenario: Normal heuristic does not create pin
- **WHEN** heuristic routes to "medium" via implementation keywords
- **THEN** no scoped pin is created
- **AND** next turn re-evaluates heuristic fresh (unless another pin-creating event fires)

#### Scenario: Classifier creates pin
- **WHEN** no active pin exists
- **AND** classifier in adaptive mode overrides to "high"
- **THEN** a scoped pin is created with `source: "classifier"`
