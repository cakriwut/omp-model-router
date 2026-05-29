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

When enabled, the router compresses older conversation messages into [TOON format](https://toonformat.dev) before sending the request to the LLM. This eliminates repeated JSON keys (`"role"`, `"content"`, etc.) across hundreds of messages.

### How it works

Given a 100-message conversation with `keepLastN: 4`:

```
messages[0]: user     ← TOON block containing messages 0–95 (role + content only)
messages[1]: assistant ← "Understood. I have the conversation history."
messages[2–5]:        ← original messages 96–99 as native JSON turns
```

The LLM receives the full conversation context, but the older portion uses ~40% fewer tokens than raw JSON. Only `role`, `content`, and `toolName` are preserved in the compressed block — metadata like `api`, `provider`, `model`, `usage`, `timestamp` are stripped since the LLM doesn't need them.

### Configuration

```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4
  }
}
```

| `enabled` | boolean | `false` | Enable TOON compression |
| `keepLastN` | number | `4` | Recent messages to keep as native JSON turns (minimum 1) |
| `excludeModels` | string[] | `[]` | Model patterns to skip compression (substring match against `provider/modelId`) |

### Model Exclusion

Some models handle raw conversation history better than the TOON format. Use `excludeModels` to skip compression for specific models:
```json
{
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "excludeModels": ["kimi", "nova"]
  }
}
```
Patterns are matched as substrings against the full model reference (`provider/modelId`). For example:
- `"kimi"` matches `amazon-bedrock/moonshotai.kimi-k2.5`
- `"nova"` matches `amazon-bedrock/amazon.nova-micro-v1:0`
- `"deepseek"` matches `amazon-bedrock/deepseek.v3.2` (included for illustration, but DeepSeek supports compression)
**Why exclude certain models?**
- Open-weight models (Kimi, Nova) are often more sensitive to synthetic message formats.
- Kimi K2.5 is excluded by default due to known tool‑call validation failures on Bedrock (violates `^[a-zA-Z0-9_-]+$` regex).
- GLM‑5 handles TOON compression reliably and is **not** excluded by default.
Patterns are matched as substrings against the full model reference (`provider/modelId`). For example:
- `"kimi"` matches `amazon-bedrock/moonshotai.kimi-k2.5`
- `"deepseek"` matches `amazon-bedrock/deepseek.v3.2`
- `"nova"` matches `amazon-bedrock/amazon.nova-micro-v1:0`

**Why exclude certain models?**
- Open-weight models (Kimi, Nova, DeepSeek) are often more sensitive to synthetic message formats.
- Kimi K2.5 is excluded by default due to known tool‑call validation failures on Bedrock (violates `^[a-zA-Z0-9_-]+$` regex).

**Note:** GLM‑5 handles TOON compression reliably and is **not** excluded by default.

Can be set globally or per-profile (profile overrides global):

```json
{
  "historyCompression": { "enabled": false },
  "profiles": {
    "cheap": {
      "historyCompression": { "enabled": true, "keepLastN": 2 },
      "high": { ... },
      "medium": { ... },
      "low": { ... }
    }
  }
}
```

### Monitoring

The `/router usage` command shows compression statistics:

```
  TOON    12 requests compressed | ↓42% smaller | est. ~4.2k tokens saved
```

The status widget shows a `[toon]` flag on decisions where compression was applied.

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
