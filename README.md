# @cakriwut/omp-model-router

Cost-optimized model routing for [Oh-My-Pi](https://github.com/can1357/oh-my-pi) — routes prompts to cheap/mid/expensive models based on task complexity. Tracks per-turn and session costs. Optionally compresses conversation history using [TOON format](https://github.com/toon-format/toon) to reduce input tokens.


> **Note**: This is a TypeScript source package for Oh-My-Pi extensions. Users need the OMP environment with `@oh-my-pi/pi-coding-agent` installed. For extension development patterns, see [Extension Authoring](https://omp.sh/docs/extension-authoring).

## Features

- **Intelligent Routing**: Classifies prompts into High/Medium/Low tiers based on complexity
- **Cost Optimization**: Automatically selects cheaper models for simple tasks  
- **History Compression (TOON)**: Compresses old conversation history into compact TOON format before sending to the LLM, saving 30–50% of input tokens on long conversations
- **Budget Tracking**: Enforces session budgets and downgrades tiers when exceeded
- **Configurable Profiles**: Auto, Deep, Cheap, Hybrid, OSS profiles with different cost/quality tradeoffs
- **Fallback Chains**: Graceful degradation when primary models are unavailable
- **Rule-Based Routing**: Custom rules for specific keywords (e.g., "deploy" → High tier)

## Installation

### For Coding Agents (Oh-My-Pi)

To install this extension in your OMP environment, use this prompt:

```
Install the omp-model-router extension from npm package @cakriwut/omp-model-router.
Create the extension at ~/.omp/agent/extensions/model-router/ with:
1. package.json with dependency "@cakriwut/omp-model-router": "^0.4.0"
2. index.ts that re-exports: export { default } from "@cakriwut/omp-model-router";
3. Run npm install in that directory
```

### Manual Installation

```bash
# Create extension directory
mkdir -p ~/.omp/agent/extensions/model-router
cd ~/.omp/agent/extensions/model-router

# Create package.json
cat > package.json << 'EOF'
{
  "name": "model-router-extension",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@cakriwut/omp-model-router": "^0.4.0"
  }
}
EOF

# Install dependencies
npm install

# Create entry point
echo 'export { default } from "@cakriwut/omp-model-router";' > index.ts
```

## Local Development

To run your development build of the router in OMP (dogfooding):

### Automated Deployment

```bash
cd ~/workspace/omp-model-router
bun run deploy:dev
```

This script creates the extension wrapper at `~/.omp/agent/extensions/model-router/` and symlinks it to your workspace so edits take effect immediately after `/reload`.

### Manual Deployment

```bash
# Create extension wrapper directory
mkdir -p ~/.omp/agent/extensions/model-router
cd ~/.omp/agent/extensions/model-router

# Create package.json pointing to workspace
cat > package.json << 'EOF'
{
  "name": "model-router-extension",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@cakriwut/omp-model-router": "file:../../../../workspace/omp-model-router"
  }
}
EOF

# Create symlink to workspace source
mkdir -p node_modules/@cakriwut
rm -rf node_modules/@cakriwut/omp-model-router
ln -s ~/workspace/omp-model-router node_modules/@cakriwut/omp-model-router

# Create entry point
echo 'export { default } from "@cakriwut/omp-model-router";' > index.ts
```

### Verify Deployment

After deploying, reload the extension and verify the running version:

```bash
# In OMP:
/reload
/router
# → Should show "Model Router (v0.4.0) [auto]"

# From shell:
cat ~/.omp/agent/extensions/model-router/node_modules/@cakriwut/omp-model-router/package.json | grep version
# → Should match workspace version
```

### Development Workflow

1. Edit source files in `~/workspace/omp-model-router/src/`
2. Run tests: `bun test`
3. Reload OMP: `/reload`
4. Test changes: `/router usage`, `/router profile hybrid`, etc.

**Note**: OMP loads TypeScript source directly, so no build step is required. Changes take effect on `/reload`.

## Release Process

### Automated Release

```bash
# Run tests, bump version, tag, publish, and create GitHub release
bun run release:patch   # 0.4.0 → 0.4.1
bun run release:minor   # 0.4.0 → 0.5.0
bun run release:major   # 0.4.0 → 1.0.0
```

The release script (`scripts/release.sh`):
1. Runs test suite (gates on failures)
2. Bumps version in `package.json`
3. Commits and tags (`git tag v<version>`)
4. Publishes to npm
5. Pushes to git with tags
6. Creates GitHub release (requires `gh` CLI)

### Manual Release

```bash
# 1. Run tests
bun test

# 2. Bump version
npm version patch  # or minor/major

# 3. Push tags
git push && git push --tags

# 4. Publish to npm
npm publish

# 5. Create GitHub release
gh release create v0.4.1 --generate-notes
```

### Post-Release

After releasing, production users can upgrade:

```bash
cd ~/.omp/agent/extensions/model-router
# Update package.json dependency to: "@cakriwut/omp-model-router": "^0.4.1"
npm install
# Then /reload in OMP
```


After installation, run `/reload` in your OMP session to activate the extension.

## Configuration

Create `~/.omp/agent/model-router.json`:

```json
{
  "defaultProfile": "auto",
  "debug": false,
  "maxSessionBudget": 5.0,
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "excludeModels": ["kimi", "nova"]
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
        "model": "amazon-bedrock/moonshotai.kimi-k2.5",
        "thinking": "medium",
        "fallbacks": ["amazon-bedrock/global.anthropic.claude-sonnet-4-6"]
      },
      "low": {
        "model": "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "thinking": "low",
        "fallbacks": ["amazon-bedrock/amazon.nova-micro-v1:0"]
      }
    }
  }
}
```


## History Compression (TOON)

When enabled, the router compresses older conversation messages into [TOON format](https://toonformat.dev) before sending the request to the LLM. This eliminates repeated JSON keys (`"role"`, `"content"`, etc.) across hundreds of messages, saving 30-60% of input tokens while maintaining full conversation context.

### Three Compression Strategies

| Strategy | When It Compresses | Cache Behavior | Best For | Savings |
|----------|-------------------|----------------|----------|---------|
| **Progressive** ⭐ (default) | Only at triggers: context >= 80% OR >5min gap | HIT between checkpoints | Long sessions (15+ turns) | **94%** |
| **Static** | Once at turn N, never update | HIT forever | Predictable compression point | **92%** |
| **Dynamic** | Every turn | MISS every turn | Context-constrained models | **57%** |

### Progressive TOON (Recommended)

**Intelligent checkpointing** — compresses only when beneficial:

```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,    // Compress at 80% of context window
      "timeThreshold": 300         // Compress after 5min gap (cache TTL)
    },
    "excludeModels": ["kimi", "nova"]
  }
}
```

**How it works:**

```
Turn 1-35: No compression (history < 160K tokens)
  ├─ Cache works perfectly
  └─ Cost: $0.028/turn

Turn 36: TRIGGER (context >= 160K)
  ├─ Compress turn[1-35] → TOON[1-35] (~60K)
  ├─ Create checkpoint
  └─ Cache MISS → $0.065 (one-time)

Turn 37-70: Reuse checkpoint
  ├─ Frozen TOON[1-35] cached (90% discount)
  ├─ Only recent turns pay full price
  └─ Cost: $0.023/turn

Turn 71: TRIGGER (context >= 160K again)
  ├─ Compress turn[1-70] → new checkpoint
  └─ Cache MISS → $0.145 (one-time)

Result: 94% savings vs no optimization
```

**Config options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `progressive.enabled` | boolean | `false` | Enable progressive checkpointing |
| `progressive.contextThreshold` | number | `0.8` | Compress when context reaches this fraction of window (0.0-1.0) |
| `progressive.timeThreshold` | number | `300` | Compress after this many seconds gap (cache TTL) |

### Static TOON

**Freeze compression at a specific turn:**

```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "freezeAfter": 10,  // Freeze TOON at turn 10, never update
    "excludeModels": ["kimi", "nova"]
  }
}
```

**Best for:** Sessions where you want predictable compression at a known turn count (e.g., always compress after 10 turns).

### Dynamic TOON (Original Behavior)

**Compress every turn** (default if neither `progressive` nor `freezeAfter` is set):

```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4
  }
}
```

**Note:** Dynamic mode breaks prompt caching because the TOON block changes every turn. Use **progressive** or **static** for better cache reuse.

### Model Exclusion

Some models handle raw conversation history better than TOON format. Use `excludeModels` to skip compression:

```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "excludeModels": ["kimi", "nova"]
  }
}
```

Patterns are matched as substrings against `provider/modelId`:
- `"kimi"` matches `amazon-bedrock/moonshotai.kimi-k2.5`
- `"nova"` matches `amazon-bedrock/amazon.nova-micro-v1:0`

**Why exclude?**
- Kimi K2.5: Tool-call validation failures on Bedrock (violates `^[a-zA-Z0-9_-]+$` regex)
- Nova models: More sensitive to synthetic message formats

### Monitoring

The `/router usage` command shows compression and cache statistics:

```
claude-sonnet-4-6 (medium) ↑5,230 ↓2,140 📦125,000 $0.0234
                           ↑ fresh  ↑ output  ↑ cached

Token Savings: ~45.2k tokens saved by TOON compression
Cache Savings: ~125k tokens cached (90% discount)

→ Checkpoint created: context_size (165K >= 160K)
```

**Widget displays:**
- `[toon]` flag when compression is applied
- 📦 icon with cached token count when cache hits


## Usage Commands

```bash
/router                     # Show current router status
/router usage               # Show model usage, cost, and compression stats
/router profile hybrid      # Switch to hybrid profile  
/router pin high            # Force high tier for current profile
/router pin auto            # Restore heuristic routing
/router thinking medium     # Override thinking level
/router fix low             # Correct last routing decision
/router widget on           # Toggle persistent status widget
/router debug on            # Toggle debug mode
/router set compression on        # Enable TOON history compression
/router set budget 3.0            # Set session budget to $3.00
/router set auto.medium.model amazon-bedrock/moonshotai.kimi-k2.5
/router set                       # List all settable keys
/router reload              # Hot-reload config from disk
/router help                # Show all subcommands
```

## Available Profiles

| Profile | Description | Use Case |
|---------|-------------|----------|
| **auto** | Kimi K2.5 (medium) + Opus (high) + Haiku (low) | General development — cost-effective |
| **deep** | Maximum quality with Claude Opus xhigh thinking | Critical architecture decisions |
| **cheap** | Kimi K2.5 (high) + GPT-4.1-mini/nano | Batch processing, simple tasks |
| **hybrid** | Opus (high) + DeepSeek (medium) + Gemini Flash (low) | Balanced across providers |
| **oss** | Kimi K2.5, Devstral, DeepSeek, Gemini Flash | Open-source/open-weight preference |

## How It Works

### Classification Logic

1. **Custom Rules**: Keyword matches in user prompt (e.g., "deploy" → High)
2. **Explicit Hints**: "deep", "carefully" → High; "quick", "fast" → Low
3. **Git Operations**: "commit", "push", "merge", etc. → Low (no reasoning needed)
4. **Planning Keywords**: "architecture", "investigate" → High; "plan", "design" → High with corroboration
5. **Implementation Keywords**: "implement", "fix", "refactor" → Medium
6. **Lookup Keywords**: "where is", "show me" → Low
7. **Word Count / Phase Bias**: Long prompts → High; short → Low; sticky phase from prior decisions

### Tier Definitions

- **High Tier**: Complex planning, architecture design, safety-critical operations
- **Medium Tier**: Implementation work, debugging, refactoring  
- **Low Tier**: Git ops, summaries, formatting, simple lookups, changelogs

### Budget Enforcement

- Default session budget: configurable via `maxSessionBudget`
- When budget exceeded: High tier → Medium tier downgrade
- Context triggers (`largeContextThreshold` tokens) force High tier for safety

## Development

```bash
git clone https://github.com/cakriwut/omp-model-router.git
cd omp-model-router
bun install
bun test
```

## Testing

```bash
bun test
```

Test files:
- `simple-routing.test.ts` — End-to-end routing classification
- `routing-optimization.test.ts` — Keyword matching, git ops, word-boundary tests
- `resolve-routing.test.ts` — Full routing pipeline (heuristic + overrides)
- `profile-effectiveness.test.ts` — Profile-specific routing
- `context-compression.test.ts` — TOON compression and stats
- `usage-format.test.ts` — Usage report rendering

## Related Projects

- [Oh-My-Pi](https://github.com/can1357/oh-my-pi) — Required runtime environment
- [@toon-format/toon](https://github.com/toon-format/toon) — Token-Oriented Object Notation
- [@oh-my-pi/pi-coding-agent](https://npmjs.com/package/@oh-my-pi/pi-coding-agent) — Required dependency

## License

MIT © Riwut Libinuko
