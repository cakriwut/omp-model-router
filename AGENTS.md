# @cakriwut/omp-model-router

Cost-optimized model routing for Oh-My-Pi — routes prompts to cheap/mid/expensive models based on task complexity. Tracks per-turn and session costs. Optionally compresses conversation history using TOON format to reduce input tokens.

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
├── version-check.ts      # Auto-upgrade detection
├── constants.ts          # Shared constants
└── types.ts              # Type definitions

test/                     # Test suite (bun test)
```

## Key Features

- **Intelligent Routing**: Classifies prompts into High/Medium/Low tiers based on complexity
- **Cost Optimization**: Automatically selects cheaper models for simple tasks
- **History Compression (TOON)**: Compresses old conversation history, saving 30–50% of input tokens
- **Budget Tracking**: Enforces session budgets and downgrades tiers when exceeded
- **Configurable Profiles**: Auto, Deep, Cheap, Hybrid, OSS profiles

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
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "excludeModels": ["kimi", "nova"]
  },
  "rules": [
    { "matches": ["deploy", "production"], "tier": "high" },
    { "matches": ["changelog", "summarize"], "tier": "low" }
  ]
}
```

## Development

```bash
bun install
bun test
```

## Publish

```bash
# Version bump → git tag → npm publish
npm version patch  # or minor/major
git push --tags
npm publish
```

## License

MIT © Riwut Libinuko
