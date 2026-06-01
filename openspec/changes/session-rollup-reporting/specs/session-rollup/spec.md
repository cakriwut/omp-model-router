## CHANGED Requirements

### Requirement: `/router usage` prefers in-memory scope when populated

When `handleUsage` is invoked, the router SHALL select its data source according to the following rule:

- **Primary path** (in-memory scope): if `state.modelCosts.size > 0 OR state.accumulatedCost > 0`, use `state.modelCosts`, `state.tierCounter`, and `state.accumulatedCost` as the data source for the usage report. The JSONL rescan SHALL be skipped entirely.
- **Fallback path** (JSONL rescan): if the above condition is false (scope is empty), scan `ctx.sessionManager.getBranch()` to derive per-model costs, tier counts, and total cost, as currently implemented.

#### Scenario: primary path fires when modelCosts has entries

- **GIVEN** `state.modelCosts` contains at least one entry (model `"M1"`)
- **AND** `ctx.sessionManager.getBranch()` would yield entries for a different model (`"M2"`) if scanned
- **WHEN** `handleUsage` is invoked
- **THEN** the rendered report contains `"M1"` and does not contain `"M2"` (JSONL was not scanned)

#### Scenario: primary path fires when accumulatedCost is positive and modelCosts is empty

- **GIVEN** `state.accumulatedCost > 0` and `state.modelCosts.size === 0`
- **WHEN** `handleUsage` is invoked
- **THEN** the JSONL fallback does not run; the report uses in-memory state

#### Scenario: fallback path fires when scope is empty

- **GIVEN** `state.modelCosts.size === 0` and `state.accumulatedCost === 0`
- **AND** `ctx.sessionManager.getBranch()` returns assistant messages for model `"M3"`
- **WHEN** `handleUsage` is invoked
- **THEN** the rendered report contains `"M3"` (derived from JSONL rescan)

### Requirement: sub-agent model costs are visible in the primary path

When the parent scope has received a rolled-up `modelCosts` entry from a child session (via `finalizeChildSession` from Thread B), that entry SHALL appear in the `/router usage` report.

#### Scenario: child model entry visible after rollup

- **GIVEN** `state.modelCosts` contains entries for both `"parent-model"` (parent's own activity) and `"child-model"` (rolled up from a sub-agent)
- **WHEN** `handleUsage` is invoked
- **THEN** the rendered report contains both `"parent-model"` and `"child-model"`

### Requirement: cost total uses `state.accumulatedCost` in the primary path

In the primary path, the cost total shown in the usage report header SHALL be `state.accumulatedCost`. This value includes sub-agent cost rolled up by `finalizeChildSession`. The JSONL-derived `sessionTotalCost` SHALL NOT be used as the header cost in the primary path.

#### Scenario: in-memory total cost used

- **GIVEN** `state.accumulatedCost === 1.2345` (includes child rollup)
- **AND** JSONL rescan would have yielded a different total (e.g. $0.50)
- **WHEN** `handleUsage` is invoked (primary path fires)
- **THEN** the rendered report cost string contains `"1.2345"`

### Requirement: JSONL total cost used in fallback path

In the fallback (JSONL) path, the cost total SHALL be derived from scanning `getBranch()`, as currently implemented.

#### Scenario: JSONL total cost in fallback

- **GIVEN** scope is empty (`state.modelCosts.size === 0`, `state.accumulatedCost === 0`)
- **AND** `getBranch()` assistant messages sum to $0.25
- **WHEN** `handleUsage` is invoked
- **THEN** the rendered cost string contains `"0.2500"`

### Requirement: compression stats always from in-memory scope

Compression stats (`compressionRequestCount`, `compressionTotalOriginalChars`, `compressionTotalCompressedChars`) SHALL always be read from the in-memory scope, in both the primary and fallback paths. This is unchanged behavior from before this proposal; this requirement documents and guards it.

#### Scenario: compression count reflects in-memory value

- **GIVEN** `state.compressionRequestCount === 3`
- **WHEN** `handleUsage` is invoked (either path)
- **THEN** the rendered report reflects a compression count of 3

### Requirement: rendered output format is unchanged

The string produced by `renderUsageReport` SHALL have the same sections, field ordering, and formatting as before this change. Only the values of model cost entries, tier counts, and total cost may differ (they are now correct for agent-tree sessions).

This requirement is validated by the existing test suite passing unchanged after the refactor (no snapshot deltas expected for single-session scenarios).
