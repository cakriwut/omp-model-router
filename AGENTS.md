# @cakriwut/omp-model-router

Cost-optimized model routing for Oh-My-Pi — routes prompts to cheap/mid/expensive models based on task complexity. Tracks per-turn and session costs. Optionally compresses conversation history using TOON format to reduce input tokens. **NEW**: Integrates with RTK (Rust Token Killer) for 60-90% token savings on tool outputs.

## Structure

```
src/
├── index.ts              # Extension entry point + lifecycle hooks
├── commands.ts           # /router commands (usage, profile, pin, etc.)
├── config.ts             # Config loading + validation
├── routing.ts            # Classification heuristic (High/Medium/Low)
├── provider.ts           # Model provider integration
├── state.ts              # Session state + budget tracking
├── ui.ts                 # Status widget rendering
├── context-compression.ts # TOON history compression
├── rtk-integration.ts     # RTK (Rust Token Killer) integration
├── version-check.ts      # Auto-upgrade detection
├── constants.ts          # Shared constants

test/                     # Test suite (bun test)
```

## Key Features

- **Intelligent Routing**: Classifies prompts into High/Medium/Low tiers based on complexity
- **Adaptive Calibration**: LLM-powered classifier for routing decisions (when enabled)
- **Cost Optimization**: Automatically selects cheaper models for simple tasks
- **History Compression (TOON)**: Compresses old conversation history, saving 30–50% of input tokens
- **RTK Integration**: Reduces tool output tokens by 60-90% (requires `rtk` binary)
- **Budget Tracking**: Enforces session budgets and downgrades tiers when exceeded

## Usage

```bash
/router                     # Show current router status
/router usage               # Show model usage, cost, and compression stats
/router profile hybrid      # Switch to hybrid profile
/router pin high            # Force high tier
/router set compression on  # Enable TOON history compression
/router set budget 3.0      # Set session budget to $3.00
/router help                # Show all subcommands
```

## Configuration

Config file: `~/.omp/agent/model-router.json`

```json
{
  "defaultProfile": "auto",
  "debug": false,
  "maxSessionBudget": 5.0,
  "enableRtk": true,
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "progressive": {
      "enabled": true,
      "maxCheckpointAge": 50,
      "maxCheckpointSize": 200000
    },
    "excludeModels": ["kimi", "nova"]
  },
    { "matches": ["deploy", "production"], "tier": "high" },
    { "matches": ["changelog", "summarize"], "tier": "low" }
  ],
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "warmupTurns": 5,
    "classifierModel": "anthropic/claude-3-haiku-20240307",
    "overrideThreshold": 0.65,
    "traceEnabled": false,
    "useGlobalPrior": true,
    "globalPriorWeight": 0.1
  }
}
```
## Calibration Modes

The calibration system allows you to train and use an LLM classifier for routing decisions:

- **`telemetry` mode** (default): Classifier runs in the background for data collection only. Heuristic routing decisions are used.
- **`adaptive` mode**: Classifier controls routing decisions. The LLM evaluates each prompt and overrides heuristic classification (unless a tier is pinned, context-triggered, or rule-matched).

When `calibration.enabled` is `true` and `calibration.mode` is `"adaptive"`, the `classifierModel` (e.g., `anthropic/claude-3-haiku-20240307`) is used for real routing decisions instead of the heuristic. The telemetry classifier still runs in the background to track accuracy.

**Use cases:**
- Start with `telemetry` to collect data and tune the heuristic
- Switch to `adaptive` when you trust the classifier and want maximum accuracy
- Use a cheap, fast model (e.g., Haiku) as the classifier to minimize overhead


## Development

```bash
bun install
bun run test                # Run test suite with summary output (323 tests)
bun run test:verbose        # Show all output with dots reporter
bun run deploy:dev          # Deploy to ~/.omp/agent/extensions/model-router for local testing
```

After deploying, run `/reload` in OMP to pick up changes.

## Pitfalls (read before editing)

### Adding a new top-level field to `RouterConfig`

**As of v0.5.2**, the config system uses **spread-based preservation** — new optional fields automatically flow through `mergeConfig` and `normalizeConfig`. You only need to update **two locations**:

1. **`src/types.ts`** — Add `foo?: FooType` to the `RouterConfig` interface
2. **`src/config.ts` `FALLBACK_CONFIG`** — Add the default value (optional, but recommended)

**That's it.** The `normalizeConfig` function uses `{ ...raw, ...overrides }` so any field in `raw` is preserved. The `mergeConfig` function uses `{ ...base, ...override }` so values flow through.

**Verification** — Run the regression test:

```bash
bun test test/config-field-preservation.test.ts
```

This test catches:
- Boolean fields not flowing through
- Number fields being dropped
- String fields being lost
- Nested objects (`historyCompression`, `progressive`) being incomplete
- **Arbitrary new fields being preserved** (future-proofing test)

**Quick verification** before assuming wiring works:

```bash
bun -e "import {loadRouterConfig} from './src/config.ts'; console.log(JSON.stringify(loadRouterConfig(process.cwd()).config.foo))"
```

If that prints `undefined` while the JSON file contains `foo`, the field is being dropped somewhere — but with the spread-based normalize, this should never happen.

### Adding extension hooks

- `pi.on("turn_start", ...)` handler must be `async` if the body uses `await`. TypeScript will catch this, but if you copy a sync handler and add `await` you'll see `error TS1308`.
- There is **no `session_end` event** in the OMP extension API. Persist on `turn_end` and on debounced timers instead.
- `ExtensionContext` does **not** expose `ctx.session` or `ctx.context`. For session ID, derive a synthetic one (e.g. timestamp). For conversation messages, use `ctx.sessionManager.getBranch()`.


## Publish

```bash
# Automated release (test → bump → tag → publish → GitHub release)
bun run release:patch  # 0.4.0 → 0.4.1
bun run release:minor  # 0.4.0 → 0.5.0
bun run release:major  # 0.4.0 → 1.0.0
```

## License

MIT © Riwut Libinuko
