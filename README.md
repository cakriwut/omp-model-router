# @cakriwut/omp-model-router

Cost-optimized model routing for [Oh-My-Pi](https://github.com/can1357/oh-my-pi) — routes prompts to cheap/mid/expensive models based on task complexity. Tracks per-turn and session costs. Optionally compresses conversation history using [TOON format](https://github.com/toon-format/toon) to reduce input tokens.


> **Note**: This is a TypeScript source package for Oh-My-Pi extensions. Users need the OMP environment with `@oh-my-pi/pi-coding-agent` installed.

---

## Features

### 🎯 Intelligent Routing
- **Tier-based selection**: Automatically classifies prompts as High/Medium/Low complexity
- **Adaptive calibration**: Optional LLM-powered classifier for routing decisions (see [Calibration Modes](#calibration-modes))
- **Configurable profiles**: Auto, Deep, Cheap, Hybrid, OSS (bring your own!)
- **Manual overrides**: Pin a tier when you need control
- **Heuristic refinement**: Detects clarifications, code edits, planning, and explicit speed requests
- **Rule-based routing**: Match keywords to force specific tiers (e.g., "production" → high tier)

### 💰 Cost Optimization
- **Session budget tracking**: Enforce max spend per session
- **Automatic downgrade**: Exceeds budget? Router demotes to cheaper tiers
- **Real-time usage display**: See per-model usage, cost breakdowns, and compression savings via `/router usage`

### 📦 History Compression (TOON)
- **Progressive mode** (default): Compresses only when triggers fire:
  - **Context size trigger**: Fires when context >= 80% of model's window
  - **Cache expiry trigger**: Fires 5 minutes after last turn (prevents prompt cache expiry)
- **Smart TOON history exclusion**: When sessions are reconstructed from JSONL with TOON-compressed history, the compression trigger excludes the already-compressed history from token estimation, preventing double-compression on the first message
- **Frozen checkpoints**: Freeze compressed blocks at turn 5 to reuse across turns (reduces compression overhead)
- **Model exclusions**: Skip compression for models that don't benefit (e.g., Kimi, Nova)
- **Token savings**: 30–50% reduction in input tokens for long sessions
- **Debug logging**: When `debug: true`, compression triggers are persisted to session JSONL for auditability
### 🔍 Observability
- **Status widget**: Live display of current profile, tier, model, and compression state
- **Usage reports**: Detailed per-model usage, cost, TOON compression stats, and cache metrics
- **Debug mode**: Session-persisted logs for compression triggers (reviewable via JSONL)
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
  "historyCompression": {
    "enabled": true,
    "keepLastN": 4,
    "progressive": {
      "enabled": true,
      "contextThreshold": 0.8,
      "timeThreshold": 300
    },
    "excludeModels": ["kimi", "nova"]
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
| `historyCompression.enabled` | Enable TOON compression | `true` |
| `historyCompression.progressive.enabled` | Use progressive mode (trigger-based) | `true` |
| `historyCompression.progressive.contextThreshold` | Context size trigger (0.0-1.0) | `0.8` (80%) |
| `historyCompression.progressive.timeThreshold` | Cache expiry trigger (seconds) | `300` (5 min) |
| `rules` | Array of keyword → tier mappings | `[]` |

---

## Usage Commands

```bash
/router                     # Show current router status
/router usage               # Show model usage, cost, and compression stats
/router profile hybrid      # Switch to hybrid profile  
/router pin high            # Force high tier (all prompts use high until unpinned)
/router pin off             # Remove tier pin
/router set thinking high min   # Override thinking level for high tier
/router set compression on  # Enable TOON compression
/router set compression off # Disable TOON compression
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

Savings ~15432 tokens from TOON compression
Cache 📦8241 tokens read from cache

TOON: 8 compressions, frozen at turn 5
  Turn 12 → 145K to 98K (-47K)
  Turn 15 → 165K to 112K (-53K)
  ...

Last: medium → anthropic/claude-sonnet-4-5 (thinking: medium)
```

---

## How Progressive TOON Compression Works

Progressive mode compresses **only when triggers fire**, avoiding unnecessary overhead.

### Trigger 1: Context Size
Fires when `contextTokens >= 0.8 * modelContextWindow`

**Example**: For a model with 200k context window, triggers at ~160k tokens.

### Trigger 2: Cache Expiry
Fires when time since last turn >= 300 seconds (5 minutes).

**Purpose**: Anthropic's prompt cache expires after 5 minutes. Compressing before expiry keeps the compressed block cached, avoiding full recomputation.

### Debug Logging

When `debug: true`, compression triggers are persisted to session JSONL:

```json
{
  "type": "custom",
  "customType": "router:compression-trigger",
  "data": {
    "reason": "cache-expiry",
    "contextTokens": 165432,
    "threshold": 160000,
    "timeSinceLastTurn": 310,
    "timeThreshold": 300,
    "turnNumber": 15,
    "messageCount": 30
  }
}
```

**To review logs**:

```bash
jq 'select(.customType == "router:compression-trigger")' \
  ~/.omp/agent/sessions/<workspace>/<session-id>/0-*.jsonl
```

### Frozen Checkpoints

At turn 5 (configurable), the router creates a **frozen checkpoint** — a TOON-compressed block that is reused across subsequent turns without re-compressing. This reduces CPU overhead while maintaining cache benefits.

**Widget displays:**
- `[toon]` flag when compression is applied
- 📦 icon with cached token count when cache hits

---

## Calibration Modes

The calibration system allows you to use an LLM classifier for routing decisions instead of the heuristic.

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
- Tracks accuracy: heuristic vs LLM predictions
- Use this to evaluate classifier performance before switching to adaptive mode

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

- Classifier **controls routing decisions**
- LLM evaluates each prompt and overrides heuristic classification
- Bypassed when tier is pinned, context-triggered, or rule-matched
- Telemetry classifier still runs in background for accuracy tracking

### Use Cases

**Start with `telemetry`:**
- Collect data and tune the heuristic
- Validate classifier accuracy before committing
- No impact on routing performance

**Switch to `adaptive`:**
- When you trust the classifier
- Want maximum routing accuracy
- Use a cheap, fast model (e.g., Haiku) to minimize overhead

### Debug Messages

When `debug: true`, calibration emits messages like:
```
[calibration] Initialized (mode: adaptive, warmup: 5)
[calibration] h=medium, llm=high ✗ (42 comparisons, 1200ms)
```

To hide these messages: set `"debug": false` and run `/reload`.


## Usage Commands

```bash
/router                     # Show current router status
/router usage               # Show model usage, cost, and compression stats
/router profile hybrid      # Switch to hybrid profile  
/router pin high            # Force high tier
/router set compression on  # Enable TOON history compression
/router set budget 3.0      # Set session budget to $3.00
/router help                # Show all subcommands
```

---

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

## Recent Fixes

### Early Compression Fix (2026-05-30)
**Bug**: TOON compression triggered after just 2 turns (4 messages) instead of waiting for progressive thresholds (80% context OR 5min idle).

**Root Cause**: `FALLBACK_CONFIG` was missing the `historyCompression` field, causing eager compression mode to activate by default.

**Fix**: Added `historyCompression` defaults with `progressive.enabled: true` to `FALLBACK_CONFIG`.

**Files Changed**:
- `src/config.ts`: Added default `historyCompression` with progressive mode
- `test/early-compression-bug.test.ts`: Regression test
- `docs/EARLY_COMPRESSION_FIX.md`: Full analysis


### Session-Scoped Metrics (2026-05-30)
**Bug**: `/router usage` showed accumulated savings from **previous sessions** even when the current session had no compressions yet.

**Fix**: Accumulated metrics (`accumulatedTokensSaved`, `accumulatedCost`, etc.) are now **truly session-scoped** — they reset to 0 on each new session and are NOT restored from persisted state.

**Files Changed**:
- `src/state.ts`: Removed restore + persist for accumulated metrics
- `src/types.ts`: Removed accumulated fields from `RouterPersistedState`
- `test/session-scoped-metrics.test.ts`: Added regression test

### Debug Session Logging (2026-05-30)
**Enhancement**: Compression trigger debug logs are now **persisted to session JSONL** (as `router:compression-trigger` custom entries) instead of only appearing in ephemeral console output.

**Benefits**:
- ✅ **Auditability**: Full history of when compression triggered
- ✅ **Persistent**: Logs survive process restart
- ✅ **Reviewable**: Use `jq` to extract and analyze compression behavior post-session

**Files Changed**:
- `src/provider.ts`: Added `ctx.sessionManager.appendCustomEntry` for compression triggers
- `test/compression-trigger.test.ts`: Added test for session logging
- `docs/DEBUG_SESSION_LOGGING.md`: Full documentation

---

## Project Structure

```
src/
├── index.ts              # Extension entry point + lifecycle hooks
├── commands.ts           # /router commands (usage, profile, pin, etc.)
├── config.ts             # Config loading + validation
├── routing.ts            # Classification heuristic (High/Medium/Low)
├── provider.ts           # Model provider integration + compression triggers
├── state.ts              # Session state + budget tracking
├── ui.ts                 # Status widget rendering + usage reports
├── context-compression.ts # TOON history compression
├── version-check.ts      # Auto-upgrade detection
├── constants.ts          # Shared constants
└── types.ts              # Type definitions

test/                     # Test suite (252 tests, bun test)
docs/                     # Implementation docs and fix explanations
```

---

## Troubleshooting

### "Compression never triggers"
1. Check `debug: true` is enabled in config
2. Verify `historyCompression.progressive.enabled: true`
3. Check session JSONL for `router:compression-trigger` entries:
   ```bash
   jq 'select(.customType == "router:compression-trigger")' ~/.omp/agent/sessions/<workspace>/<session-id>/0-*.jsonl
   ```
4. If no entries, compression hasn't triggered (context not large enough, or < 5 minutes since last turn)

### "Usage shows incorrect savings"
This was fixed in v0.2.2. Upgrade to the latest version:
```bash
cd omp-model-router && git pull && bun install && bun run deploy:dev
/reload  # in OMP
```

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

- `docs/SESSION_SCOPED_METRICS_FIX.md` - Accumulated metrics bug fix
- `docs/DEBUG_SESSION_LOGGING.md` - Session logging implementation
- `docs/COMPRESSION_TRIGGER_FIX.md` - Compression trigger behavior explanation
- `AUTO_UPGRADE_FEATURE.md` - Auto-upgrade mechanism details
