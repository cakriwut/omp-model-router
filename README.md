# @cakriwut/omp-model-router

Cost-optimized model routing for [Oh-My-Pi](https://github.com/can1357/oh-my-pi) — routes prompts to cheap/mid/expensive models based on task complexity. Tracks per-turn and session costs.

> **Note**: This is a TypeScript source package for Oh-My-Pi extensions. Users need the OMP environment with `@oh-my-pi/pi-coding-agent` installed.

## Features

- **Intelligent Routing**: Classifies prompts into High/Medium/Low tiers based on complexity
- **Cost Optimization**: Automatically selects cheaper models for simple tasks  
- **Budget Tracking**: Enforces session budgets and downgrades tiers when exceeded
- **Configurable Profiles**: Auto, Deep, Cheap, Hybrid, OSS profiles with different cost/quality tradeoffs
- **Fallback Chains**: Graceful degradation when primary models are unavailable
- **Rule-Based Routing**: Custom rules for specific keywords (e.g., "deploy" → High tier)

## Installation

```bash
# Install in OMP environment
npm install @cakriwut/omp-model-router

# Or include in OMP extensions folder
cp -r node_modules/@cakriwut/omp-model-router/* ~/.omp/agent/extensions/model-router/
```

## Configuration

Create `~/.omp/agent/model-router.json`:

```json
{
  "defaultProfile": "auto",
  "debug": false,
  "maxSessionBudget": 5.0,
  "largeContextThreshold": 150000,
  "rules": [
    {
      "matches": ["deploy", "production", "release", "migration"],
      "tier": "high",
      "reason": "Safety-critical operations require deep reasoning"
    },
    {
      "matches": ["changelog", "summarize", "tl;dr", "recap"],
      "tier": "low"
    }
  ],
  "profiles": {
    "auto": {
      "high": {
        "model": "amazon-bedrock/global.anthropic.claude-opus-4-7",
        "thinking": "high",
        "fallbacks": ["amazon-bedrock/global.anthropic.claude-opus-4-6-v1"]
      },
      "medium": {
        "model": "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        "thinking": "medium"
      },
      "low": {
        "model": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "thinking": "low",
        "fallbacks": ["amazon-bedrock/zai.glm-4.7"]
      }
    }
  }
}
```

## Usage Commands

```bash
/router                     # Show current router status
/router profile hybrid      # Switch to hybrid profile  
/router config             # Show current configuration
/router debug              # Toggle debug mode
/router budget             # Show accumulated cost
```

## Available Profiles

| Profile | Description | Use Case |
|---------|-------------|----------|
| **auto** | Balanced cost/quality with tiered Claude models | General development work |
| **deep** | Maximum quality with Claude Opus for all complex tasks | Critical architecture decisions |
| **cheap** | Cost-optimized with GLM models for low/medium tiers | Simple tasks, batch processing |
| **hybrid** | Mix of Claude Opus (high), DeepSeek (medium), GLM (low) | Balanced across providers |
| **oss** | Open-source models only (DeepSeek, GLM, Qwen) | Open-source preference |

## How It Works

### Classification Logic

1. **Keyword Matching**: Checks for keywords like "deploy", "summarize", "plan"
2. **Word Count**: Long prompts → High tier, short prompts → Low tier
3. **Complexity Heuristics**: Multi-line prompts, implementation keywords trigger Medium/High tiers
4. **Explicit Hints**: User can add "deep" or "quick" to influence routing

### Tier Definitions

- **High Tier**: Complex planning, architecture design, safety-critical operations
- **Medium Tier**: Implementation work, debugging, refactoring  
- **Low Tier**: Summaries, formatting, simple lookups, changelogs

### Budget Enforcement

- Default session budget: $5.00
- When budget exceeded: High tier → Medium tier downgrade
- Context triggers (150k+ tokens) force High tier for safety

## Development

```bash
# Clone repository
git clone https://github.com/cakriwut/omp-model-router.git
cd omp-model-router

# Install dependencies (requires OMP environment)
bun install

# Test (requires OMP runtime)
bun test
```

## Testing

Run the included test suite (requires OMP):

```bash
bun test
```

Test files:
- `simple-routing.test.ts` - Basic routing tests
- `profile-effectiveness.test.ts` - Profile-specific routing tests  
- `provider.test.ts` - Provider integration tests

## Related Projects

- [Oh-My-Pi](https://github.com/can1357/oh-my-pi) - Required runtime environment
- [@oh-my-pi/pi-coding-agent](https://npmjs.com/package/@oh-my-pi/pi-coding-agent) - Required dependency

## License

MIT © Riwut Libinuko