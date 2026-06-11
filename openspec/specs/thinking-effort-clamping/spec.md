## Requirements

### Requirement: Router clamps delegated reasoning effort to model's supported range
Before delegating a stream call with a `reasoning` effort level, the router SHALL clamp the requested effort to the model's declared supported efforts using `clampThinkingLevelForModel`. If the requested effort is not in the model's supported list, the nearest lower supported effort SHALL be used. If no supported effort exists at or below the requested level, the minimum supported effort SHALL be used. If the model does not support reasoning, `reasoning` SHALL be omitted from the stream options entirely.

#### Scenario: Medium effort requested, model supports minimal/low/medium/high
- **WHEN** the router routes to a Bedrock model with `thinking.efforts: ["minimal","low","medium","high"]` and the decided thinking level is `"medium"`
- **THEN** the stream is delegated with `reasoning: "medium"` and no error is thrown

#### Scenario: Medium effort requested, model supports only low/high (non-contiguous)
- **WHEN** the router routes to a model whose supported efforts are `["low","high"]` and the decided thinking level is `"medium"`
- **THEN** the stream is delegated with `reasoning: "low"` (nearest lower supported level) and no error is thrown

#### Scenario: High effort requested, model supports only minimal/low
- **WHEN** the router routes to a model whose supported efforts are `["minimal","low"]` and the decided thinking level is `"high"`
- **THEN** the stream is delegated with `reasoning: "low"` (highest available) and no error is thrown

#### Scenario: Thinking level is Off
- **WHEN** the effective thinking level is `"off"` or `"inherit"`
- **THEN** `reasoning` is omitted from stream options (no clamping needed, model receives no reasoning parameter)

#### Scenario: Model does not support reasoning
- **WHEN** the target model has `reasoning: false` or `reasoning: undefined`
- **THEN** `reasoning` is omitted from stream options regardless of the decided thinking level

#### Scenario: Model thinking metadata is absent (future schema)
- **WHEN** the target model has `reasoning: true` but `thinking` is `undefined`
- **THEN** `clampThinkingLevelForModel` returns the requested effort as-is (pass-through), and the stream is delegated with the original effort — the router SHALL NOT crash

### Requirement: Effort clamping is transparent to routing decisions and UI
The clamping of `delegatedReasoning` SHALL occur only at the point of stream delegation in `provider.ts`. It SHALL NOT alter `decision.thinking`, `state.lastDecision`, the status widget display, or any calibration matrix entries. The router's routing tier, thinking-level heuristic, and user-visible state SHALL reflect the originally decided thinking level, not the clamped wire value.

#### Scenario: Status widget after clamped delegation
- **WHEN** the router delegates to a model that clamps medium→low
- **THEN** the status widget still displays the decided tier and thinking level (e.g., "medium") unchanged

#### Scenario: Calibration matrix after clamped delegation
- **WHEN** a clamped delegation completes successfully
- **THEN** the calibration matrix records the heuristic-decided tier/thinking level, not the clamped wire value
