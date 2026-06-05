# @cakriwut/omp-model-router

Cost-optimized model routing for [Oh-My-Pi](https://github.com/can1357/oh-my-pi) — routes prompts to cheap/mid/expensive models based on task complexity. Tracks per-turn and session costs. Integrates with RTK (Rust Token Killer) for 60-90% token savings on tool outputs.

> **Note**: This is a TypeScript source package for Oh-My-Pi extensions. Users need the OMP environment with `@oh-my-pi/pi-coding-agent` installed.

---

## Features
### 🎯 Intelligent Routing
- **Tier-based selection**: Automatically classifies prompts as High/Medium/Low complexity
- **Adaptive calibration**: Optional LLM-powered classifier for routing decisions (see [Calibration Modes](#calibration-modes))
- **Classifier Pitfalls Harness**: Markdown files that teach the classifier known misclassification patterns — no training data required (see [Classifier Pitfalls Harness](#classifier-pitfalls-harness))
- **Configurable profiles**: Auto, Deep, Cheap, Hybrid, OSS (bring your own!)
- **Manual overrides**: Pin a tier when you need control
- **Heuristic refinement**: Detects clarifications, code edits, planning, and explicit speed requests
- **Rule-based routing**: Match keywords to force specific tiers (e.g., "production" → high tier)

### 💰 Cost Optimization
- **Session budget tracking**: Enforce max spend per session
- **Automatic downgrade**: Exceeds budget? Router demotes to cheaper tiers
- **Real-time usage display**: See per-model usage and cost breakdowns via `/router usage`

### 🔍 Observability
- **Status widget**: Live display of current profile, tier, and model
- **Usage reports**: Detailed per-model usage and cost metrics
- **Debug mode**: Session-persisted logs for routing decisions
- **Cost tracking**: Accumulated session cost vs budget with visual progress bar

---

## Installation

### Via CLI (Recommended)

**Using `pi` CLI:**
```bash
pi install npm:@cakriwut/omp-model-router
```

**Using `omp` CLI:**
```bash
omp install @cakriwut/omp-model-router
```

Then in OMP:
```
/reload
/router help
```

### From Source (Development)

```bash
git clone https://github.com/cakriwut/omp-model-router.git
cd omp-model-router
bun install
bun run deploy:dev
```

Then in OMP:
```
/reload
/router help
```

> **Note**: Source installs use `file:` dependencies and won't support `/router update`. For production use, install via Pi CLI above.

---

## Configuration

### Config File

Create or edit `~/.omp/agent/model-router.json`:

```json
{
  "routerEnabled": true,
  "defaultProfile": "auto",
  "debug": false,
  "maxSessionBudget": 2.0,
  "rules": [
    {
      "matches": ["deploy", "production", "release"],
      "tier": "high",
      "reason": "Safety check for production tasks"
    },
    {
      "matches": "changelog",
      "tier": "low"
    }
  ],
  "calibration": {
    "enabled": false,
    "mode": "telemetry",
    "classifierModel": "anthropic/claude-3-haiku-20240307",
    "warmupTurns": 5,
    "traceEnabled": false
  },
  "profiles": {
    "auto": {
      "high": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high" },
      "medium": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium" },
      "low": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" }
    }
  }
}
```


### Key Options

| Field | Description | Default |
|-------|-------------|---------|
| `routerEnabled` | Enable/disable router | `true` |
| `defaultProfile` | Active profile on start | `"auto"` |
| `debug` | Enable debug logging to session JSONL | `false` |
| `maxSessionBudget` | Max $ spend per session (triggers downgrade when exceeded) | `5.0` |
| `calibration.enabled` | Enable calibration system | `false` |
| `calibration.mode` | `"telemetry"` (data only) or `"adaptive"` (controls routing) | `"telemetry"` |
| `calibration.classifierModel` | Model for LLM classifier (e.g., `anthropic/claude-3-haiku-20240307`) | - |
| `rules` | Array of keyword → tier mappings | `[]` |
---

## Usage Commands

/router                     # Show current router status
/router usage               # Show model usage and cost
/router profile hybrid      # Switch to hybrid profile
/router pin high            # Force high tier (all prompts use high until unpinned)
/router pin off             # Remove tier pin
/router set thinking high min   # Override thinking level for high tier
/router set budget 3.0      # Set session budget to $3.00
/router reset               # Reset to config defaults (clears pins, thinking overrides)
/router widget on           # Show status widget
/router help                # Show all subcommands
```

### Example: `/router usage` Output

```
Router: auto                       $0.1234 / $2.00
████████████████████████████████████████████████ 42 decisions
  high 15%           medium 60%          low 25%

  HIGH    claude-sonnet-4-5                       6x   $0.0800
  MEDIUM  claude-sonnet-4-5                      25x   $0.0350
  LOW     claude-haiku-4-5                       11x   $0.0084

Last: medium → anthropic/claude-sonnet-4-5 (thinking: medium)
```

---

## Calibration Modes

The calibration system lets an LLM classifier drive routing decisions instead of the heuristic.

### Telemetry Mode (default)

```json
{
  "calibration": {
    "enabled": true,
    "mode": "telemetry",
    "classifierModel": "anthropic/claude-3-haiku-20240307"
  }
}
```

- Classifier runs in the background for **data collection only**
- Heuristic routing decisions are used for actual routing
- Use this to observe classifier behaviour before committing

### Adaptive Mode

```json
{
  "calibration": {
    "enabled": true,
    "mode": "adaptive",
    "classifierModel": "anthropic/claude-3-haiku-20240307"
  }
}
```

- Classifier **controls routing decisions** — its verdict is the final tier
- Bypassed when tier is pinned, context-triggered, or rule-matched
- When classifier fails (rate-limit, model unavailable), heuristic is used automatically
- Use a cheap fast model (Haiku, Nova Micro) to keep overhead near zero

### Classifier Fallback Chain

`classifierModel` accepts a single string or an array. Entries are tried in order until one succeeds; if all fail the heuristic is used with no hard error:

```json
"classifierModel": [
  "anthropic/claude-3-haiku-20240307",
  "openai/gpt-4.1-nano",
  "amazon-bedrock/amazon.nova-micro-v1:0"
]
```

---

## Classifier Pitfalls Harness

The pitfalls harness injects known misclassification patterns directly into the classifier prompt. This replaces the need for open-ended telemetry to discover failure modes — you describe the pitfall once in a markdown file and the classifier sees it on every routing decision.

### How It Works

When a classifier model is active, the router looks for a pitfalls file in this order:

1. `pitfallsPath` config field (explicit override)
2. `model-router-pitfalls.md` in the current project directory
3. `~/.omp/agent/model-router/pitfalls.md` (global, applies everywhere)

The file contents are injected between the tier definitions and the conversation history in the classifier prompt, so the LLM sees ground truth before evaluating.

### File Format

Plain markdown. Use `##` headings to name each pitfall. Two to three lines per entry is enough — the classifier reads all of them.

```markdown
## Pitfall: Changelog or release notes
Short summaries and version bumps are mechanical text assembly.
Correct: **low**. Common misclass: medium.

## Pitfall: Architecture decision or tradeoff analysis
Even a short "should we use X or Y" prompt demands weighing trade-offs.
Correct: **high**. Common misclass: medium (short prompt ≠ simple task).

## Pitfall: Debugging across unfamiliar code with no repro
Requires hypothesis generation and broad search — high cognitive load even for small fixes.
Correct: **high**. Common misclass: medium (eventual fix may be a one-liner).
```

A starter file with 10 common pitfalls is installed at `~/.omp/agent/model-router/pitfalls.md` automatically. See `pitfalls.example.md` in this repo for the full template.

### Project-Local Pitfalls

Drop a `model-router-pitfalls.md` in your project root (the directory OMP runs from). It takes precedence over the global file and lets you encode domain-specific routing signals — e.g. "deploying to staging counts as low not high in this project".

### Config Override

To point at a non-standard path:

```json
{
  "pitfallsPath": "./docs/router-pitfalls.md"
}
```

### Caching

The file is read once on the first routing decision that needs a classifier and cached in-process. Changes take effect on the next process start or `/reload`.

### Debug Messages

When `debug: true`, calibration emits messages like:
```
[calibration] Initialized (mode: adaptive, warmup: 5)
[calibration] h=medium, llm=high ✗ (42 comparisons, 1200ms)
```
To hide these messages: set `"debug": false` and run `/reload`.



## Development

```bash
bun install
bun run test                # Run test suite with summary output (recommended)
bun run test:verbose        # Show all test output with dots reporter
bun run deploy:dev          # Deploy to ~/.omp/agent/extensions/model-router
```

**Test output modes:**
- `bun run test` (recommended): Shows only summary when all tests pass; shows full output with failure details on any failure
- `bun run test:verbose`: Shows dots for each test (.) plus all console output, full traceability
- `bun test` (direct): Bun's default behavior, shows all output (bypasses package.json script)

After deploying, run `/reload` in OMP to pick up changes.

---

## Publishing

Automated release workflow using **GitHub Actions**:

### Local Release Script

```bash
bun run release:patch  # 0.5.0 → 0.5.1
bun run release:minor  # 0.5.0 → 0.6.0
bun run release:major  # 0.5.0 → 1.0.0
```

The script:
1. ✅ Runs full test suite
2. ✅ Bumps version in `package.json`
3. ✅ Commits and pushes to GitHub
4. ✅ Creates git tag and pushes it
5. 🤖 **Triggers GitHub Actions workflow**

### GitHub Actions Workflow

When a `v*.*.*` tag is pushed, `.github/workflows/publish.yml` automatically:
1. ✅ Runs tests on CI
2. ✅ Verifies package.json version matches tag
3. ✅ Publishes to NPM (so `npx @cakriwut/omp-model-router@X.Y.Z` resolves)
4. ✅ Creates GitHub release with auto-generated notes

**Setup required (one-time):**

1. **Create NPM automation token:**
   ```bash
   npm login
   # Go to https://www.npmjs.com/settings/<your-username>/tokens
   # Create new "Automation" token (for CI/CD)
   ```

2. **Add NPM_TOKEN to GitHub Secrets:**
   ```
   Repository Settings → Secrets and variables → Actions → New repository secret
   Name: NPM_TOKEN
   Value: <your-npm-automation-token>
   ```

**Manual release** (if GitHub Actions fails):

```bash
npm login
npm publish --access public
gh release create v0.5.1 --generate-notes
```

---

## Project Structure

```
src/
├── index.ts              # Extension entry point + lifecycle hooks
├── commands/             # /router subcommands (usage, profile, pin, etc.)
├── config.ts             # Config loading + validation
├── routing/              # Classification heuristic (High/Medium/Low)
├── provider.ts           # Model provider integration
├── state/                # Session state + budget tracking
├── ui/                   # Status widget rendering + usage reports
├── calibration/          # LLM classifier + calibration matrix
├── utils/                # Shared utilities (message helpers, etc.)
├── constants.ts          # Shared constants
└── types.ts              # Type definitions

test/                     # Test suite (~370 tests, bun test)
docs/                     # Implementation docs
```

---

## Troubleshooting

### "Router not active"
1. Check `routerEnabled: true` in config
2. Verify config file exists: `~/.omp/agent/model-router.json`
3. Run `/router` to see current status
4. Try `/reload` to re-initialize the extension

---

## License

MIT © Riwut Libinuko

---

## Related Documentation

- `docs/FALLBACK_TESTING_GUIDE.md` - Model fallback chain testing
- `docs/BEST_PRACTICES_AUDIT.md` - OMP extension compliance report
- `docs/RTK_INTEGRATION.md` - RTK token optimization setup
- `docs/CALIBRATION_DESIGN.md` - Calibration system design
