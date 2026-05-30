# Calibration System Design for omp-model-router


### System Flow

The calibration system operates as a **passive learner** layered on top of the existing routing heuristic. The heuristic continues to run synchronously on every turn; the LLM classifier runs **asynchronously in the background** to label the heuristic's decision. Over time, the system builds a confusion matrix (`heuristic → LLM`) that reveals systematic biases, which adaptive mode uses to correct future routing.

```text
+-------------------+      +----------------------+      +--------------------+
|    turn_start     |      |  resolveRouting()    |      |    turn_end        |
| (session context) |----->| 1. Heuristic tier    |      | (session context)  |
+-------------------+      |    rawTier           |      +--------------------+
                           | 2. Adaptive override  |           |
                           |    applyCalibratedTier|           |
                           | 3. Spawn classifier   |           v
                           |    async (if enabled) |      +--------------------+
                           +----------------------+      |  poll classifier    |
                                  |                      |  result & update    |
                                  v                      |  SessionCalibration  |
                         +----------------+              +--------------------+
                         | Background LLM |                     |
                         | classifier via |                     v
                         | pi-subagent    |              +--------------------+
                         +----------------+              | session_end hook   |
                                  |                      | persist global     |
                                  v                      | calibration state  |
                         +----------------+              +--------------------+
                         |  Classifier    |
                         |  result object |
                         +----------------+
```

### Key Principles

1. **Heuristic-first**: The heuristic always runs first and produces `rawTier`. This ensures zero added latency on cold start.
2. **Async classifier**: The LLM classifier spawns in the background using pi-subagents; the main turn proceeds without waiting.
3. **Next-turn availability**: Classifier results are polled in `turn_end` (non-blocking) and stored in session state. If not ready by `turn_end`, we poll again on the next `turn_start`.
4. **Calibration bias**: After warmup, `applyCalibratedTier()` adjusts `rawTier` based on historical agreement patterns before context/image/budget overrides.
5. **Two modes**:
   - **telemetry**: collect data, no routing changes (for validation).
   - **adaptive**: apply calibration bias to routing decisions (production use).

### Async Timing Strategy

**Decision: poll in `turn_end` first, fallback to `turn_start` of next turn.**

Why not background timer? Timers add complexity (cancellation, state synchronization) and can poll when no turn is active. Polling at hook boundaries ensures we only check when the session is live and avoids race conditions with state persistence.

```ts
// turn_end hook
if (state.calibration?.pendingAgentId) {
  const result = await pollSubagentResult(state.calibration.pendingAgentId, { timeout: 0 });
  if (result) {
    updateCalibrationMatrix(state.calibration, lastDecision.tier, result.tier);
    state.calibration.pendingAgentId = undefined;
  }
  // if not ready, leave pendingAgentId set; next turn_start will retry
}

// turn_start hook (before routing)
if (state.calibration?.pendingAgentId) {
  const result = await pollSubagentResult(state.calibration.pendingAgentId, { timeout: 0 });
  if (result) {
    updateCalibrationMatrix(state.calibration, state.lastDecision.tier, result.tier);
    state.calibration.pendingAgentId = undefined;
  }
  // if still not ready after 2 turns, count as timeout and clear
  if (state.calibration.pendingAgentAge++ > 2) {
    state.calibration.llmCallsFailed++;
    state.calibration.pendingAgentId = undefined;
  }

## 2. Data Schema

### 2.1 SessionCalibration (in-memory, per session)

Lives in `RouterState.calibration`, ephemeral per session (persisted across turns via `RouterPersistedState`):

```ts
interface SessionCalibration {
  // Confusion matrix: heuristic[row] vs llm[col]
  // indices: 0=low, 1=medium, 2=high
  matrix: number[][];  // 3×3, matrix[h][llm] = count
  
  // Metadata
  totalComparisons: number;     // successful h vs llm comparisons
  llmCallsAttempted: number;    // how many classifier invocations
  llmCallsFailed: number;       // returned undefined or timed out
  sessionStartTime: number;     // epoch ms
  turnsProcessed: number;       // user turns only
  
  // Pending state
  pendingAgentId?: string;      // classifier agent awaiting result
  pendingAgentAge: number;      // turns since spawn (for timeout)
  pendingHeuristicTier?: RouterTier;  // remember what heuristic decided
  
  // Trace file (optional)
  traceFilePath?: string;       // ~/.omp/agent/model-router/traces/<sessionId>.jsonl
}
```

**Initialization**: `session_start` hook creates a fresh `SessionCalibration` with zeroed matrix `[[0,0,0],[0,0,0],[0,0,0]]`.

**Persistence**: Serialized into `RouterPersistedState` on every `state.persist()` call (turn_end, session_end). Session branches inherit the parent's matrix.

### 2.2 GlobalCalibrationSnapshot (persisted to disk)

File: `~/.omp/agent/model-router/calibration-global.json`

```ts
interface GlobalCalibrationSnapshot {
  version: 1;
  matrix: number[][];  // 3×3, aggregated across all sessions
  metadata: {
    totalSessions: number;
    totalComparisons: number;
    lastUpdated: number;  // epoch ms
    routerVersion: string;
  };
}
```

**Update cadence**: `session_end` hook merges session matrix into global (element-wise addition), debounced to max 1 write per session.

**Bootstrap**: `session_start` loads global snapshot and initializes session matrix with a small fraction (e.g., 10%) of global counts as Bayesian prior. This accelerates warmup for new sessions.

### 2.3 Per-Turn Trace (for lab harness)

File: `~/.omp/agent/model-router/traces/<sessionId>.jsonl`

Each line (JSONL):
```ts
{
  turnIndex: number;
  timestamp: number;
  prompt: string;  // truncated to 200 chars
  promptFeatures: {
    wordCount: number;
    toolResultCount: number;
    hasImages: boolean;
    matchedKeywords: string[];
  };
  heuristicDecision: {
    tier: RouterTier;
    phase: RouterPhase;
    reasoning: string;
    ruleName?: string;
  };
  llmDecision?: {  // undefined if classifier didn't run or timed out
    tier: RouterTier;
    reasoning: string;
    latencyMs: number;
  };
  finalDecision: {
    tier: RouterTier;
    source: "heuristic" | "llm" | "calibrated" | "pinned" | "budget" | "context" | "image";
  };
  agreement: boolean | null;  // h vs llm (null if no llm result)
}
```

**Written when**: `config.debug = true AND config.calibration.traceEnabled = true`.

**Append point**: `turn_end` hook after classifier result is processed.

## 3. Integration Points

### 3.1 Hook-by-Hook Breakdown

| Hook           | Timing       | Action                                                                 |
|----------------|--------------|------------------------------------------------------------------------|
| `session_start`| Once         | Initialize `state.calibration = new SessionCalibration()`. Load global snapshot and apply 10% prior to session matrix. Open trace file if `traceEnabled`. |
| `session_branch`| On branch   | Clone parent's calibration state (matrix, counters). Reset `pendingAgentId` (orphan the classifier from parent branch). |
| `turn_start`   | Every turn   | Poll pending classifier (retry from turn_end). If result ready, update matrix. Clear stale agents (age > 2 turns). Increment `turnsProcessed`. |
| **`resolveRouting`** | Every turn | 1. Run heuristic → `rawTier`. 2. If mode==adaptive: `tier = applyCalibratedTier(rawTier)`. 3. Spawn async classifier (store agentId, tier, timestamp). |
| `turn_end`     | Every turn   | Poll pending classifier (first chance). If ready: update matrix, append trace, clear pendingAgentId. Persist state. |
| `session_end`  | Once         | Merge session matrix into global snapshot (element-wise add). Write global JSON. Close trace file. |

### 3.2 Detailed Hook Logic

#### `session_start`
```ts
pi.on("session_start", async (_event, ctx) => {
  // existing restoration logic...
  
  if (state.currentConfig.calibration?.enabled) {
    const global = loadGlobalCalibration();
    state.calibration = {
      matrix: global ? scaleMatrix(global.matrix, 0.1) : [[0,0,0],[0,0,0],[0,0,0]],
      totalComparisons: 0,
      llmCallsAttempted: 0,
      llmCallsFailed: 0,
      sessionStartTime: Date.now(),
      turnsProcessed: 0,
      pendingAgentAge: 0,
    };
    
    if (state.currentConfig.calibration.traceEnabled && state.debugEnabled) {
      state.calibration.traceFilePath = openTraceFile(ctx.sessionId);
    }
  }
});
```

#### `turn_start`
```ts
pi.on("turn_start", async (_event, ctx) => {
  // existing logic...
  
  if (state.calibration?.pendingAgentId) {
    const result = await pollClassifierResult(state.calibration.pendingAgentId, { timeout: 0 });
    if (result) {
      updateCalibrationMatrix(
        state.calibration,
        state.calibration.pendingHeuristicTier!,
        result.tier
      );
      appendTrace(state.calibration, ctx.turnIndex, state.lastDecision, result);
      state.calibration.pendingAgentId = undefined;
    } else {
      state.calibration.pendingAgentAge++;
      if (state.calibration.pendingAgentAge > 2) {
        state.calibration.llmCallsFailed++;
        state.calibration.pendingAgentId = undefined;
      }
    }
  }
  
  state.calibration?.turnsProcessed++;
});
```

#### `resolveRouting` modification
```ts
export const resolveRouting = async (
  input: RoutingInput,
  config: RoutingConfig,
): Promise<RoutingDecision> => {
  // 1. Heuristic decision (existing)
  let decision = decideRouting(...);
  const rawTier = decision.tier;
  
  // 2. Calibration override (NEW)
  if (config.calibration?.enabled && config.calibration.mode === "adaptive") {
    const calibratedTier = applyCalibratedTier(
      rawTier,
      input.sessionCalibration,
      config.calibration
    );
    if (calibratedTier !== rawTier) {
      decision = buildRoutingDecision(
        config.profileName,
        config.profile,
        calibratedTier,
        phaseForTier(calibratedTier),
        `Calibrated from ${rawTier} to ${calibratedTier} based on historical LLM agreement.`,
        config.thinkingOverrides,
        false
      );
      decision.isCalibrated = true;
    }
  }
  
  // 3. Context, image, budget overrides (existing)
  // ...
  
  // 4. Spawn async classifier (NEW)
  if (config.calibration?.enabled && !input.pinnedTier && !decision.isContextTriggered) {
    const agentId = await spawnClassifierAgent(
      config.classifierModel ?? config.calibration.classifierModel,
      input.context,
      decision.phase
    );
    if (agentId) {
      input.sessionCalibration.pendingAgentId = agentId;
      input.sessionCalibration.pendingHeuristicTier = rawTier;
      input.sessionCalibration.pendingAgentAge = 0;
      input.sessionCalibration.llmCallsAttempted++;
    }
  }
  
  return decision;
};
```

#### `turn_end`
```ts
pi.on("turn_end", async (_event, ctx) => {
  // existing logic...
  
  if (state.calibration?.pendingAgentId) {
    const result = await pollClassifierResult(state.calibration.pendingAgentId, { timeout: 0 });
    if (result) {
      updateCalibrationMatrix(
        state.calibration,
        state.calibration.pendingHeuristicTier!,
        result.tier
      );
      appendTrace(state.calibration, ctx.turnIndex, state.lastDecision, result);
      state.calibration.pendingAgentId = undefined;
    }
  }
  
  state.persist();
});
```

#### `session_end`
```ts
pi.on("session_end", async (_event, ctx) => {
  if (state.calibration && state.calibration.totalComparisons > 0) {
    mergeIntoGlobalCalibration(state.calibration);
    closeTraceFile(state.calibration);
  }
});
```

## 4. pi-subagents Strategy

### 4.1 Dependency Decision: Optional Peer Dependency

**Recommendation**: Declare `@oh-my-pi/pi-subagents` as **optional peer dependency** with graceful fallback.

```json
// package.json
{
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": "^13",
    "@oh-my-pi/pi-agent-core": "^13",
    "@oh-my-pi/pi-ai": "^13"
  },
  "peerDependenciesMeta": {
    "@oh-my-pi/pi-subagents": {
      "optional": true
    }
  }
}
```

**Why not vendor?**
- pi-subagents is actively maintained; vendoring creates stale copy risk.
- SessionManager.inMemory() depends on internal state that may change.
- Fallback path (streamSimple in detached Promise) is simple enough.

**Why not require?**
- omp-model-router should work standalone (current users unaffected).
- Calibration is opt-in experimental feature.

### 4.2 Implementation: Agent Wrapper Module

File: `src/calibration/agent.ts`

```ts
import type { Context } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseCanonicalModelRef } from "../config";
import { runClassifier } from "../routing";

let Agent: typeof import("@oh-my-pi/pi-subagents").Agent | undefined;
let fallbackWarningShown = false;

try {
  const mod = await import("@oh-my-pi/pi-subagents");
  Agent = mod.Agent;
} catch {
  // pi-subagents not installed; use fallback
}

export interface ClassifierResult {
  tier: RouterTier;
  reasoning: string;
  latencyMs: number;
}

/**
 * Spawn async classifier agent using pi-subagents if available,
 * otherwise fall back to detached streamSimple call.
 * Returns agent ID (string) or undefined on failure.
 */
export const spawnClassifierAgent = async (
  classifierModel: string,
  context: Context,
  currentPhase?: RouterPhase,
  ctx?: ExtensionContext
): Promise<string | undefined> => {
  const startTime = Date.now();
  
  if (Agent) {
    try {
      const agentId = await Agent({
        subagent_type: "quick_task",
        prompt: buildClassifierPrompt(context, currentPhase),
        description: "Routing tier classification",
        run_in_background: true,
        model: classifierModel,
        thinking: "low",
        isolated: true,
      });
      return agentId;
    } catch (error) {
      if (ctx && !fallbackWarningShown) {
        ctx.ui.notify("Calibration: pi-subagents failed, using fallback", "warning");
        fallbackWarningShown = true;
      }
    }
  }
  
  // Fallback: detached streamSimple in background
  if (!fallbackWarningShown && ctx) {
    ctx.ui.notify("Calibration: pi-subagents unavailable, using streamSimple fallback", "info");
    fallbackWarningShown = true;
  }
  
  const fallbackId = `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  
  // Store result in a global Map for polling
  classifierResults.set(fallbackId, { pending: true });
  
  Promise.resolve().then(async () => {
    const result = await runClassifier(
      classifierModel,
      ctx!.modelRegistry,
      context,
      currentPhase
    );
    if (result) {
      classifierResults.set(fallbackId, {
        pending: false,
        data: { ...result, latencyMs: Date.now() - startTime },
      });
    } else {
      classifierResults.set(fallbackId, { pending: false, data: undefined });
    }
  });
  
  return fallbackId;
};

/**
 * Poll for classifier result. Returns undefined if not ready or failed.
 * Non-blocking (timeout: 0).
 */
export const pollClassifierResult = async (
  agentId: string,
  options: { timeout?: number } = {}
): Promise<ClassifierResult | undefined> => {
  if (agentId.startsWith("fallback-")) {
    const entry = classifierResults.get(agentId);
    if (!entry || entry.pending) return undefined;
    classifierResults.delete(agentId);
    return entry.data;
  }
  
  if (Agent) {
    try {
      const result = await get_subagent_result(agentId, { timeout: options.timeout ?? 0 });
      // Parse result from agent output (assume structured response)
      return parseAgentOutput(result);
    } catch {
      return undefined;
    }
  }
  
  return undefined;
};

// Fallback storage
const classifierResults = new Map<string, { pending: boolean; data?: ClassifierResult }>();

function buildClassifierPrompt(context: Context, currentPhase?: RouterPhase): string {
  // Same logic as runClassifier in routing.ts
  // ...
}

function parseAgentOutput(output: unknown): ClassifierResult | undefined {
  // Extract tier/reasoning from agent's structured response
  // ...
}
```

### 4.3 Failure Modes & Safeguards

| Failure                        | Detection                     | Action                                   |
|--------------------------------|-------------------------------|------------------------------------------|
| pi-subagents not installed     | Import fails                  | Use streamSimple fallback, show info once|
| Agent spawn throws             | Catch in spawnClassifierAgent| Increment llmCallsFailed, skip turn      |
| Agent times out (>2 turns)     | pendingAgentAge check         | Increment llmCallsFailed, clear pending  |
| Classifier returns invalid tier| Validation in poll            | Treat as failed, increment llmCallsFailed|
| Fallback streamSimple fails    | runClassifier returns undef   | Store undefined, count as failed         |

**Graceful degradation**: If calibration consistently fails (>80% failure rate over 10 turns), log warning and suggest disabling calibration or checking classifier model config.

## 5. Priority Algorithm (`applyCalibratedTier`)

### 5.1 Strategy A: Confusion-Matrix Override (Recommended)

This is the baseline strategy. It applies a **majority-vote override** when the confusion matrix shows consistent LLM disagreement with the heuristic.

```ts
export function applyCalibratedTier(
  rawTier: RouterTier,
  cal: SessionCalibration | undefined,
  config: CalibrationConfig
): RouterTier {
  if (!cal || !config.enabled || config.mode !== 'adaptive') {
    return rawTier;
  }
  
  // Cold start: wait for warmup
  if (cal.totalComparisons < config.warmupTurns) {
    return rawTier;
  }
  
  const h = tierToIndex(rawTier);  // 0=low, 1=medium, 2=high
  const row = cal.matrix[h];       // [llm_low, llm_medium, llm_high]
  const totalSamples = row[0] + row[1] + row[2];
  
  if (totalSamples === 0) {
    return rawTier;  // no data for this heuristic tier yet
  }
  
  const majority = argmax(row);     // index of max count
  const confidence = row[majority] / totalSamples;
  
  // Override only if:
  // 1. LLM disagrees with heuristic (majority !== h)
  // 2. Confidence exceeds threshold (default 0.65)
  if (majority !== h && confidence >= config.overrideThreshold) {
    return indexToTier(majority);
  }
  
  return rawTier;
}

function tierToIndex(tier: RouterTier): number {
  return tier === 'low' ? 0 : tier === 'medium' ? 1 : 2;
}

function indexToTier(index: number): RouterTier {
  return index === 0 ? 'low' : index === 1 ? 'medium' : 'high';
}

function argmax(arr: number[]): number {
  return arr.indexOf(Math.max(...arr));
}
```

### 5.2 Configuration Parameters

```ts
interface CalibrationConfig {
  enabled: boolean;
  mode: "telemetry" | "adaptive";
  warmupTurns: number;           // default: 5
  overrideThreshold: number;     // default: 0.65 (65% confidence)
  classifierModel: string;       // e.g., "anthropic/claude-3-haiku-20240307"
  traceEnabled: boolean;         // default: false
  useGlobalPrior: boolean;       // default: true
}
```

### 5.3 Critique of Strategy A

**Strengths:**
- **Interpretable**: confusion matrix is human-readable, easy to debug.
- **Bounded**: won't override without sufficient evidence (warmup + confidence).
- **No refactor**: doesn't require changing the keyword cascade structure.

**Weaknesses:**
- **Coarse-grained**: treats all `low → medium` overrides the same, regardless of which keyword rule triggered.
- **Slow to converge**: requires many samples per tier (ideally 10+) before override kicks in.
- **No rule-level feedback**: can't identify which specific heuristic rules are misfiring.

**Alternative (Future Work): Strategy B — Per-Rule Weighting**

Instead of a single matrix, track agreement per keyword rule:
```ts
ruleStats: Map<string, { triggered: number; agreed: number; disagreed: { low: number; medium: number; high: number } }>
```

Then weight the cascade vote:
```ts
weight = baseWeight(rule) * (rule.agreed / rule.triggered)
```

After ~20 turns, rules that disagree with LLM get downweighted. This is more granular but requires refactoring `decideRouting()` into a weighted vote system.

**Recommendation**: Ship Strategy A first. If lab results show high regret on specific rules (e.g., IMPLEMENTATION_MATCHER has 30% disagreement), revisit Strategy B in Phase 3.

## 6. Failure Handling

### 6.1 Failure Modes

| Failure                        | Detection                     | Action                                   | Recoverable? |
|--------------------------------|-------------------------------|------------------------------------------|--------------|
| pi-subagents not installed     | Import fails                  | Use streamSimple fallback, show info once| Yes          |
| Agent spawn throws             | Catch in spawnClassifierAgent| Increment llmCallsFailed, skip turn      | Yes          |
| Agent times out (>2 turns)     | pendingAgentAge check         | Increment llmCallsFailed, clear pending  | Yes          |
| Classifier returns invalid tier| Validation in poll            | Treat as failed, increment llmCallsFailed| Yes          |
| Fallback streamSimple fails    | runClassifier returns undef   | Store undefined, count as failed         | Yes          |
| Global calibration file corrupt| JSON.parse throws             | Delete file, start fresh                 | Yes          |
| Wildly inconsistent matrix     | Detect entropy > threshold    | Log warning, continue (don't disable)    | Yes          |
| High failure rate (>80% over 10 turns) | Check llmCallsFailed ratio | Notify user, suggest config check   | Manual fix   |

### 6.2 Safeguards

1. **Confidence threshold**: Strategy A won't override unless `confidence >= 0.65`. This prevents noisy signals from flipping decisions.
2. **Warmup period**: No overrides until `totalComparisons >= warmupTurns` (default 5). Prevents cold-start instability.
3. **Sacred tiers**: Pinned/rule-matched/context-triggered tiers bypass calibration entirely (already intentional overrides).
4. **Budget enforcement**: Calibration runs after heuristic but before budget downgrade. If budget is exceeded, the budget logic still applies after calibration.
5. **Session isolation**: Each session starts with its own matrix (bootstrapped from global). A bad session won't poison the heuristic until it merges at session_end.
6. **Async timeout**: Stale agents (age > 2 turns) are abandoned. This prevents memory leaks from hung background tasks.

### 6.3 Rollback Plan

If calibration causes routing instability in production:
1. User disables via config: `calibration.enabled = false` or `calibration.mode = "telemetry"`.
2. Extension falls back to pure heuristic (zero added latency).
3. Trace files remain for post-mortem analysis.
4. Global calibration file can be deleted: `rm ~/.omp/agent/model-router/calibration-global.json`.

## 7. Code Organization

### 7.1 New Files

```
src/calibration/
  types.ts            # SessionCalibration, GlobalCalibrationSnapshot, ClassifierResult
  session.ts          # SessionCalibration class, updateCalibrationMatrix(), applyCalibratedTier()
  global.ts           # loadGlobalCalibration(), mergeIntoGlobalCalibration(), persistence
  agent.ts            # spawnClassifierAgent(), pollClassifierResult(), pi-subagents wrapper + fallback
  trace.ts            # openTraceFile(), appendTrace(), closeTraceFile()
  hooks.ts            # hook integration helpers (initCalibration, pollAndUpdate, persistGlobal)
  index.ts            # re-export public API

src/cli/calibrate/
  replay.ts           # omp-router calibrate replay — session JSONL parser + classifier replay
  analyze.ts          # omp-router calibrate analyze — confusion matrix stats
  simulate.ts         # omp-router calibrate simulate — strategy comparison
  export.ts           # omp-router calibrate export — dump global state to JSON
  import.ts           # omp-router calibrate import — load global state from JSON
  reset.ts            # omp-router calibrate reset — wipe global calibration
  index.ts            # register slash commands
```

### 7.2 Modified Files

```
src/types.ts        # Add CalibrationConfig to RouterConfig, SessionCalibration to RouterPersistedState
src/state.ts        # Add calibration: SessionCalibration field to RouterState
src/config.ts       # Merge calibration config from model-router.json
src/routing.ts      # Import applyCalibratedTier, call in resolveRouting after heuristic
src/index.ts        # Hook integration: session_start, turn_start, turn_end, session_end
src/commands.ts     # Register /router calibrate ... slash commands
```

### 7.3 Module Boundaries

- **calibration/**: Self-contained calibration subsystem. Zero dependencies on UI or commands. Exports:
  - `initCalibration(config) → SessionCalibration`
  - `applyCalibratedTier(rawTier, cal, config) → RouterTier`
  - `spawnClassifierAgent(...) → string | undefined`
  - `pollClassifierResult(agentId) → ClassifierResult | undefined`
  - `updateCalibrationMatrix(cal, hTier, llmTier) → void`
  - `mergeIntoGlobalCalibration(cal) → void`

- **cli/calibrate/**: CLI harness for offline replay/analysis. Can import from `calibration/` and `routing.ts`. Does NOT import from `state.ts` or `index.ts` (no runtime state dependency). Exports:
  - `replaySessions(options) → ReplayDataset`
  - `analyzeDataset(dataset) → AnalysisReport`
  - `simulateStrategies(dataset, strategies) → ComparisonTable`

- **index.ts**: Orchestrates hooks. Calls `calibration/hooks.ts` helpers. No direct calibration logic in hooks.

### 7.4 CLI Harness Integration

The CLI commands (`/router calibrate ...`) should work **both** inside OMP (slash command) and standalone (npm script for CI/batch jobs).

```bash
# Inside OMP session
/router calibrate replay --sessions ~/.omp/agent/sessions --limit 50 --output replay.jsonl

# Standalone (future: bun script)
bun run src/cli/calibrate/index.ts replay --sessions ~/.omp/agent/sessions --limit 50 --output replay.jsonl
```

Slash commands delegate to CLI modules, which are pure functions (no ExtensionContext dependency for core logic).

## 8. Open Questions for Researcher

1. **Ground-truth labels**: Confirmed use of strong-model judge (e.g., Sonnet 4.0) for offline replay. What model specifically? What's the labeling prompt?
2. **WarmupTurns**: Suggest default 5; validate optimal range (3–10) in simulation. Should warmup scale with matrix sparsity (e.g., 3 samples per tier)?
3. **OverrideThreshold**: Default 0.65 (65% confidence). Should this vary by tier? E.g., higher threshold for `low → high` jumps (more disruptive)?
4. **Global vs Hybrid**: Bootstrap session matrix with 10% of global counts. Is 10% optimal? Should we anonymize prompts before merging into global?
5. **Trace volume**: If traceEnabled on all sessions, disk usage could grow fast. Should we:
   - Sample (e.g., 1 in 10 turns)?
   - Rotate logs (keep last 7 days)?
   - Compress JSONL (gzip)?
6. **Mismatch tolerance**: When should calibration NOT override? Current: never override pinned/context-triggered. Should we also skip override if heuristic confidence is "strong" (e.g., explicit HIGH_HINT match)?
7. **Cross-session generalization**: Does calibration from architectural work help CRUD work, or should we segment by project type/phase?
8. **Classifier model choice**: Default to Haiku 3.5 for cost, or Gemini Flash for accuracy? Run cost/accuracy tradeoff in replay.
9. **Convergence speed**: How many turns until adaptive mode beats heuristic? Target <10 turns for positive ROI.
10. **Evaluation metrics**: Confirm:
    - Accuracy = % agreement with strong-model judge
    - Cost = cumulative classifier invocation cost
    - Latency = p50/p95 added latency (should be ~0 due to async)
    - Regret = % times calibration was wrong and heuristic was right

---

**Document Status**: Architecture design complete. Ready for Researcher review and parameter tuning based on lab evaluation.