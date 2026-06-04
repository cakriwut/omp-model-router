# @cakriwut/omp-model-router

Cost-optimized model routing for Oh-My-Pi — routes prompts to cheap/mid/expensive models based on task complexity. Tracks per-turn and session costs. Optionally compresses conversation history using TOON format to reduce input tokens. Integrates with RTK (Rust Token Killer) for 60-90% token savings on tool outputs. **NEW**: Classifier prompt cache eliminates ~80% of redundant LLM classifier calls in tool loops; tool-mix bucket signal enables mid-loop phase-transition detection.

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

- **Intelligent Routing**: Classifies prompts into High/Medium/Low tiers based on complexity
- **Adaptive Calibration**: LLM-powered classifier for routing decisions (when enabled)
- **Classifier Prompt Cache**: Caches classifier verdicts per `(userText, msgIndex, toolBucket)` — eliminates ~80% of redundant classifier calls in tool loops (TTL-gated, per-session)
- **Tool-Mix Bucket Signal**: Detects mid-loop phase transitions (exploration → implementation) and re-routes appropriately; injects `read×4 edit×3 …` activity summary into classifier prompt
- **Cost Optimization**: Automatically selects cheaper models for simple tasks
- **Model Fallback Chain**: Automatically retries fallback models when primary fails
- **History Compression (TOON)**: Compresses old conversation history, saving 30–50% of input tokens
- **RTK Integration**: Reduces tool output tokens by 60-90% (requires `rtk` binary)
- **Budget Tracking**: Enforces session budgets and downgrades tiers when exceeded
- **Debug Logging**: Detailed fallback attempt logging when `debug: true`


## Installation

### For Users (Recommended)

```bash
pi install npm:@cakriwut/omp-model-router
```

Then in OMP:
```
/reload
/router
```

### For Developers

```bash
cd ~/workspace
git clone https://github.com/cakriwut/omp-model-router.git
cd omp-model-router
bun install
bun run deploy:dev
```

Then in OMP: `/reload`

**Dev installs won't support `/router update`** — see troubleshooting section below.
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
  "defaultPin": "auto",
  "pinTimeout": 600000,
  "enableRtk": true,
  "classifierCache": {
    "ttlTurns": 20
  },
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
    "classifierModel": [
      "anthropic/claude-3-haiku-20240307",
      "openai/gpt-4.1-nano",
      "amazon-bedrock/amazon.nova-micro-v1:0"
    ],
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

When `calibration.enabled` is `true` and `calibration.mode` is `"adaptive"`, the `classifierModel` (e.g., `anthropic/claude-3-haiku-20240307`) is used for real routing decisions instead of the heuristic.

**New in v0.7.0**: The confusion matrix now closes the feedback loop:
- Sync classifier verdicts are recorded into the matrix immediately
- When sync classifier fails (model not found, API error), the matrix-based calibration (`applyCalibratedTier`) is used as a fallback
- Async classifier spawn is **skipped** in adaptive mode when sync classifier runs (50% cost savings)

**Classifier Prompt Cache** (Phase 1): In tool loops, ~80% of classifier calls receive identical input — the cache eliminates them. The cache key is `lastUserText|userMsgIndex|toolBucket` (TTL default: 20 turns). Calibration matrix is still updated on every turn regardless of cache source. Configure via `classifierCache.ttlTurns`.

**Tool-Mix Bucket Signal** (Phase 2): Extends the cache key with a phase bucket (`exploration`, `implementation`, `verification`, `delegation`, `mixed`, `fresh`) derived from the last 12 tool calls since the last user message. A bucket transition (e.g. `exploration → implementation`) causes a cache miss and re-runs the classifier with a tool-activity summary line added to the prompt. `bash` is conservatively bucketed as `other` pending argument-based disambiguation.

### Classifier Fallback Chain (v0.7.3+)

`classifierModel` accepts either a single string (backward compat) or an array of refs. Entries are tried in order; if one fails (not in registry, no API key, stream error, parse failure), the next is attempted. If all classifiers in the chain fail, the router falls back to the heuristic — no hard error.

```json
"classifierModel": [
  "anthropic/claude-3-haiku-20240307",
  "openai/gpt-4.1-nano",
  "amazon-bedrock/amazon.nova-micro-v1:0"
]
```

With `debug: true`, each attempt logs:

```
[model-router] Sync classifier attempt 1/3: anthropic/claude-3-haiku-20240307
[model-router] Classifier failed: Rate limited
[model-router] Sync classifier attempt 2/3: openai/gpt-4.1-nano
⚡ classifier → gpt-4.1-nano (sync·adaptive) → high
```

**Use cases:**
- Start with `telemetry` to collect data and tune the heuristic
- Switch to `adaptive` when you trust the classifier and want maximum accuracy
- Use a cheap, fast model (e.g., Haiku, Nova Micro) as the classifier to minimize overhead

**Troubleshooting adaptive mode:**

If the classifier decision isn't being used (check decision reasoning with `debug: true`):
1. Verify `classifierModel` ref is valid and model exists in registry
2. Check API key is configured for the model's provider
3. Look for `[model-router] Classifier failed: ...` in console logs (requires `debug: true`)
4. Decision reasoning will show `"Classifier unavailable, using heuristic: ..."` when classifier fails
5. If matrix has sufficient data (>= `warmupTurns`), matrix-based calibration will be applied as fallback
6. Decision reasoning shows `"Classifier (cached): ..."` on cache hits — this is expected in tool loops

## Development

```bash
bun install
bun run test                # Run test suite with summary output (500 tests)
bun run test:verbose        # Show all output with dots reporter
bun run deploy:dev          # Deploy to ~/.omp/agent/extensions/model-router for local testing
```

After deploying, run `/reload` in OMP to pick up changes.


## Extension Best Practices

This extension **follows Oh-My-Pi best practices** (audited 2026-05-31). Key compliance areas:

✅ **Factory pattern** — Default export receiving `ExtensionAPI`  
✅ **No runtime actions during load** — All `ctx` actions happen inside handlers  
✅ **Proper event handlers** — Uses standard events (`session_start`, `turn_end`, `tool_call`, etc.)  
✅ **Error handling** — `tool_call` handlers never throw; errors logged with debug flag  
✅ **Manifest** — `package.json` uses `omp.extensions` field  
✅ **Dev install detection** — Detects symlinks, workspace paths, and `file:` dependencies  

See `docs/BEST_PRACTICES_AUDIT.md` for detailed compliance report.

**Reference:** https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md
## Pitfalls (read before editing)

### Pin system: session-scoped, decaying, config-anchored

As of v0.8.0, pins are **memory-only** and **session-scoped**. They decay after `pinTimeout` ms and return to `defaultPin` (the config floor).

| Config field | Default | Description |
|---|---|---|
| `defaultPin` | `"auto"` | Floor tier after decay. `"auto"` = no pin, heuristic free. A tier value (`"high"`, `"medium"`, `"low"`) acts as a permanent non-decaying baseline. |
| `pinTimeout` | `600000` | How long a scoped pin stays active (ms). Default: 10 minutes. |

**Priority model:**
- **P1 (user):** `/router pin <tier>` and `/router fix <tier>` always override any existing pin and reset the timer.
- **P2 (system):** Heuristic Rule J, classifier override, rule match, and auto-upgrade only set a pin when no active pin exists.
- `/router pin auto` = immediate decay + clears `lastDecision` for a clean break.

**Pins are never persisted to disk.** `router-state.json` no longer contains `pinByProfile` or `pinTier`. Old persisted pins are silently ignored on upgrade.

---

### Classifier prompt cache: key format and cache invalidation

As of the `classifier-prompt-cache` + `classifier-tool-mix-signal` changes, the classifier cache key has **three components**:

```
sig = lastUserText + "|" + userMsgIndex + "|" + bucket
```

| Component | Purpose |
|---|---|
| `lastUserText` | Busts cache on new user message |
| `userMsgIndex` | Disambiguates repeated identical user text |
| `bucket` | Busts cache on mid-loop phase transitions (exploration → implementation, etc.) |

**Bucket values:** `exploration`, `implementation`, `verification`, `delegation`, `mixed`, `fresh`.

**Fresh** is the stable value when fewer than 2 tool calls exist since the last user message. Early turns of a new message stay at `fresh` until the agent starts using tools.

**Cache fields on `RouterState`** (transient, never persisted):
- `lastClassifierKey: string | undefined`
- `lastClassifierVerdict: { tier, reasoning } | undefined`
- `classifierTurnsSinceRun: number` (resets to 0 on MISS, increments on HIT)

**Invalidation events:**
- New user message (text or index change) → MISS
- Tool-mix bucket transitions → MISS  
- `classifierTurnsSinceRun >= ttlTurns` (default 20) → MISS
- Context-capacity promotion (`isContextTriggered`) → cache cleared explicitly
- Process restart / new session → cache never persisted

**Calibration matrix is always updated** — even on HIT, `updateCalibrationMatrix(heuristic, cachedVerdict)` fires. Training signal is per-turn, not per-classifier-call.

---

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

### `/router update` fails with "No matching package found"

**Symptom:** Running `/router update` shows:
```
Error: No matching package found for npm:@cakriwut/omp-model-router
```

**Root cause:** Extension is installed via local file path (`file:...`) instead of npm.

**Fix:** Reinstall from npm:

```bash
# Option A: Using Bun
cd ~/.omp/agent/extensions/model-router
bun add @cakriwut/omp-model-router

# Option B: Using Pi CLI
pi uninstall model-router
pi install npm:@cakriwut/omp-model-router
```

**Verify:** Check `~/.omp/agent/extensions/model-router/package.json` shows:
```json
"dependencies": {
  "@cakriwut/omp-model-router": "^0.6.1"
}
```

NOT `"file:..."`.

After v0.6.2, the `/router update` command will detect dev installs and show this help automatically.

### Parent attribution for sub-agent sessions

The router tracks per-session cost in `RouterState.sessionScopes` (a `Map<sessionId, SessionScope>`). When a sub-agent ends (`agent_end`), `finalizeChildSession(childId)` rolls the child's accumulated cost up to its parent, identified by `SessionScope.parentSessionId`.

- `parentSessionId` is set inside `activateSession`, sourced from `ctx.sessionManager.getHeader()?.parentSession` — the harness's authoritative persistent record of the agent tree.
- **Fallback:** in the `turn_start` path, if the header has no `parentSession`, the previously-active sessionId is used (legacy heuristic). This is best-effort and only fires when the header is silent.
- **First non-undefined parent wins.** Once `parentSessionId` is set on a scope, later `activateSession` calls never overwrite it. This keeps attribution stable across re-activation of the same session within a turn.

**Diagnosing missing rollup.** Enable `debug: true` in config. Each attribution decision logs as:

```
[model-router] parent attribution: child=<id> source=<header|fallback|none> parent=<id>
```

If you see `source=none` for a session you expected to be a child, the harness header has no `parentSession` recorded for that session — the rollup will not happen and that is the symptom to chase upstream, not in the router.

### Follow-on rollup threads

Open work for future contributors:

- **Thread D:** Decide whether `maxSessionBudget` is per-session or per-agent-tree. Each session currently checks only its own `accumulatedCost`; in-flight sub-agent spend is invisible to the parent until `agent_end`.
- **Thread E:** Move `frozenCompressionBlock` from `RouterState` (shared) into `SessionScope` (per-session) to prevent cross-session compression-cache pollution in multi-agent runs.


## Publish

```bash
# Automated release (test → bump → tag → publish → GitHub release)
bun run release:patch  # 0.4.0 → 0.4.1
bun run release:minor  # 0.4.0 → 0.5.0
bun run release:major  # 0.4.0 → 1.0.0
```

## Testing & Debugging

### Fallback Chain Testing

To verify the model fallback mechanism works:

1. **Enable debug mode** (`debug: true` in config)
2. **Run unit tests:**
   ```bash
   bun test test/fallback-chain.test.ts
   ```
3. **Simulate a failure** by setting an invalid primary model
4. **Check logs** for fallback attempts:
   ```
   [model-router] Attempt 1/4: amazon-bedrock/primary-model
     ✗ Failed: Service unavailable
   [model-router] Attempt 2/4: amazon-bedrock/fallback-model
     ✓ Success with amazon-bedrock/fallback-model
   ```

See `docs/FALLBACK_TESTING_GUIDE.md` for detailed instructions.

### Common Issues

**Fallbacks not triggering?**
- Check logs with `debug: true`
- Verify fallback models exist in registry
- Ensure API keys are configured

**Bedrock models failing?**
- Use correct inference profile ARNs, not raw model IDs
- Example: `amazon-bedrock/global.anthropic.claude-opus-4-7`

## License

MIT © Riwut Libinuko
