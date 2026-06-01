## CHANGED Requirements

### Requirement: `finalizeChildSession` merges all aggregable `SessionScope` fields

When a child session scope is finalized, the router SHALL merge the following fields from child into parent (in addition to the 5 already merged by Thread C):

- `compressionRequestCount` — summed
- `compressionTotalOriginalChars` — summed
- `compressionTotalCompressedChars` — summed
- `tierCounter.high`, `tierCounter.medium`, `tierCounter.low` — each summed individually
- `modelCosts` — merged by model key (see model-costs merge requirement below)

The router SHALL NOT merge the following fields; they MUST remain the parent's own values:

- `debugHistory` — parent's routing trace is not the child's
- `lastDecision` — parent's own last routing decision
- `isStreaming` — per-session live-status flag
- `lastTurnTimestamp` — per-session timing
- `currentCheckpoint` — per-session TOON compression checkpoint
- `sessionId`, `parentSessionId` — identity fields

#### Scenario: compressionRequestCount rolls up

- **GIVEN** parent scope has `compressionRequestCount: 2`, child has `compressionRequestCount: 3`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent's `compressionRequestCount === 5`

#### Scenario: compressionTotalOriginalChars rolls up

- **GIVEN** parent has `compressionTotalOriginalChars: 10000`, child has `8000`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent's `compressionTotalOriginalChars === 18000`

#### Scenario: compressionTotalCompressedChars rolls up

- **GIVEN** parent has `compressionTotalCompressedChars: 4000`, child has `3000`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent's `compressionTotalCompressedChars === 7000`

#### Scenario: tierCounter rolls up element-wise

- **GIVEN** parent `tierCounter === {high:2, medium:1, low:0}`, child `{high:1, medium:0, low:3}`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent `tierCounter === {high:3, medium:1, low:3}`

#### Scenario: lastDecision is not overwritten

- **GIVEN** parent `lastDecision === DecisionA`, child `lastDecision === DecisionB`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent `lastDecision === DecisionA` (unchanged)

### Requirement: `modelCosts` Map merged by key with numeric accumulation

When merging child `modelCosts` into parent `modelCosts`, the router SHALL apply the following rule for each entry in the child map:

**Case A — key absent from parent map:** copy the child entry into the parent map as a new entry. The copy MUST be a value copy (not a reference), so subsequent mutations to one map do not affect the other.

**Case B — key present in parent map, same tier label:** sum `invocations`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cost` in-place on the existing parent entry. Keep the parent's `tier` label unchanged.

**Case C — key present in parent map, different tier label:** sum all numeric fields identically to Case B. Keep the parent's `tier` label (not the child's).

#### Scenario: new model key from child added to parent

- **GIVEN** parent `modelCosts` has no entry for `"anthropic/claude-haiku"`, child has entry with `{invocations:5, cost:0.01, ...}`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent `modelCosts` has entry `"anthropic/claude-haiku"` with `invocations:5, cost:0.01`

#### Scenario: colliding key — numeric fields summed

- **GIVEN** parent has `"bedrock/nova"` with `{invocations:2, cost:0.05, inputTokens:1000, outputTokens:200, cacheReadTokens:50, cacheWriteTokens:10, tier:"low"}`, child has same key with `{invocations:3, cost:0.08, inputTokens:1500, outputTokens:300, cacheReadTokens:75, cacheWriteTokens:15, tier:"low"}`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent entry has `invocations:5, cost:0.13, inputTokens:2500, outputTokens:500, cacheReadTokens:125, cacheWriteTokens:25, tier:"low"`

#### Scenario: colliding key — parent tier label wins

- **GIVEN** parent has `"openai/gpt-4o"` with `tier:"high"`, child has same key with `tier:"medium"`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** parent entry `tier === "high"`

#### Scenario: child entry copy is independent

- **GIVEN** child has model key `"k"` absent from parent; after rollup, the entry is in parent
- **WHEN** the child scope is deleted (as always on `finalizeChildSession`)
- **THEN** the parent's entry for `"k"` is unaffected (copy, not reference)

### Requirement: multi-level transitivity

Rollup is transitive: if grandchild rolls up into child, then child rolls up into parent, the parent SHALL reflect the sum of all three scopes for all 8 aggregable numeric fields and the full model cost merge.

#### Scenario: three-level rollup

- **GIVEN** grandchild, child, and parent scopes each have `compressionRequestCount: 1` and a distinct model key in `modelCosts`
- **WHEN** `finalizeChildSession(grandchild)` is called, then `finalizeChildSession(child)` is called
- **THEN** parent's `compressionRequestCount === 3` and `modelCosts` has all three model keys

### Requirement: missing parent does not corrupt state

When `child.parentSessionId` is `undefined` OR the parent scope no longer exists in memory, `finalizeChildSession` SHALL delete the child scope and return without modifying any other scope.

#### Scenario: no parent attributed

- **GIVEN** child scope with `parentSessionId === undefined`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** no other scope is modified; child scope is deleted; no error thrown

#### Scenario: parent scope evicted

- **GIVEN** child `parentSessionId === "P"` but `"P"` is not in `sessionScopes`
- **WHEN** `finalizeChildSession(child)` is called
- **THEN** child scope is deleted; no error thrown

### Requirement: regression guard

Every field in `SessionScope` MUST be classified as either aggregable (merged by `finalizeChildSession`) or non-aggregable (explicitly skipped). A test assertion SHALL enumerate all current field names and verify the union of the two sets equals the full field list. This fails loudly when a future `SessionScope` field addition goes unclassified.
