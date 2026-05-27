# Design: Structural Refactor

## Architecture After Refactor

```
                           index.ts (entry, ~150 LOC)
                               │
                               ▼
                          RouterState (class, state.ts)
                         ╱    │    ╲
                       ╱      │      ╲
                     ╱        │        ╲
              provider.ts  commands.ts  ui.ts
                   │
                   ▼
             routing.ts (resolveRouting + decideRouting + classifier)
                   │
                   ▼
              config.ts
                   │
                   ▼
              types.ts + constants.ts
```

## RouterState Class

```typescript
// state.ts (expanded from 49 → ~130 LOC)
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterTier,
  RoutingDecision,
  RouterPersistedState,
} from "./types";
import { FALLBACK_CONFIG, resolveProfileName } from "./config";
import { MAX_DEBUG_HISTORY } from "./constants";

export class RouterState {
  // ─── Config & environment ──────────────────────────
  currentConfig: RouterConfig = FALLBACK_CONFIG;
  currentModelRegistry: ExtensionContext["modelRegistry"] | undefined;
  currentCwd = process.cwd();
  lastExtensionContext: ExtensionContext | undefined;

  // ─── Router lifecycle ──────────────────────────────
  routerEnabled = false;
  selectedProfile: string;
  isInternalModelSwitch = false;
  isStreaming = false;

  // ─── Routing state ─────────────────────────────────
  lastDecision: RoutingDecision | undefined;
  pinnedTierByProfile: RouterPinByProfile = {};
  thinkingByProfile: RouterThinkingByProfile = {};

  // ─── Debug & UI ────────────────────────────────────
  debugEnabled = false;
  widgetEnabled = false;
  debugHistory: RoutingDecision[] = [];

  // ─── Cost & model tracking ─────────────────────────
  accumulatedCost = 0;
  lastNonRouterModel: string | undefined;
  lastRegisteredModels = "";

  // ─── Internal ──────────────────────────────────────
  private lastPersistedSnapshot: string | undefined;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.selectedProfile = resolveProfileName(FALLBACK_CONFIG, FALLBACK_CONFIG.defaultProfile);
  }

  recordDecision(decision: RoutingDecision): void {
    this.debugHistory = [...this.debugHistory, decision].slice(-MAX_DEBUG_HISTORY);
  }

  getThinkingOverride(profileName: string, tier: RouterTier) {
    return this.thinkingByProfile[profileName]?.[tier];
  }

  persist(): void {
    const state = this.buildPersistedState();
    // Snapshot-diff to avoid redundant writes
    const snapshot = JSON.stringify({
      ...state,
      timestamp: 0,
      lastDecision: state.lastDecision ? { ...state.lastDecision, timestamp: 0 } : undefined,
      debugHistory: state.debugHistory?.map(d => ({ ...d, timestamp: 0 })),
    });
    if (snapshot === this.lastPersistedSnapshot) return;
    try {
      this.pi.appendEntry("router-state", state);
    } catch {
      return; // Runtime not yet initialized
    }
    this.lastPersistedSnapshot = snapshot;
  }

  /** Resets all per-session state and restores from session entries. */
  restoreFromSession(ctx: ExtensionContext): void {
    // ... (moves logic from index.ts restoreStateFromSession)
  }

  private buildPersistedState(): RouterPersistedState {
    return {
      enabled: this.routerEnabled,
      selectedProfile: this.selectedProfile,
      pinTier: this.pinnedTierByProfile[this.selectedProfile],
      pinByProfile: { ...this.pinnedTierByProfile },
      thinkingByProfile: { ...this.thinkingByProfile },
      debugEnabled: this.debugEnabled,
      widgetEnabled: this.widgetEnabled,
      debugHistory: this.debugHistory,
      lastPhase: this.lastDecision?.phase,
      lastDecision: this.lastDecision,
      lastNonRouterModel: this.lastNonRouterModel,
      accumulatedCost: this.accumulatedCost,
      timestamp: Date.now(),
    };
  }
}

// Keep for backward-compat deserialization:
export const isRouterPersistedState = (value: unknown): value is RouterPersistedState => { ... };
```

**Key decisions:**
- State is a mutable class, not a record + free functions. 18 fields that mutate together with coordination logic (persist-on-change, snapshot-diff) belong together.
- `persist()` encapsulates the snapshot-diff optimization internally.
- `buildPersistedState()` becomes a private method (was 10-arg free function — architect NIT #9).
- `restoreFromSession()` becomes a method on the class (architect NIT #10).
- `pinnedTierByProfile` and `thinkingByProfile` remain plain objects on the instance. Commands mutate them directly, then call `state.persist()`.
- `shimmerInterval` stays local in `index.ts` (timer handle, not semantic state).
- `isInitialized` is removed (dead code — write-only, never read).

## resolveRouting Function

```typescript
// routing.ts (new export)

export interface RoutingInput {
  context: Context;
  previousDecision: RoutingDecision | undefined;
  pinnedTier?: RouterTier;
  isBudgetExceeded: boolean;
  modelRegistry: ExtensionContext["modelRegistry"];
  lastExtensionContext?: ExtensionContext;
}

export interface RoutingConfig {
  profileName: string;
  profile: RouterProfile;
  thinkingOverrides?: RouterThinkingByTier;
  phaseBias: number;
  rules?: RoutingRule[];
  largeContextThreshold?: number;
  classifierModel?: string;
}

export const resolveRouting = async (
  input: RoutingInput,
  config: RoutingConfig,
): Promise<RoutingDecision> => {
  // 1. Heuristic decision
  let decision = decideRouting(
    input.context, config.profileName, config.profile,
    input.previousDecision, input.pinnedTier, config.thinkingOverrides,
    config.phaseBias, config.rules, input.isBudgetExceeded,
  );

  // 2. Context trigger upgrade
  if (config.largeContextThreshold && decision.tier !== "high" && input.lastExtensionContext) {
    const usage = await input.lastExtensionContext.getContextUsage();
    if (usage?.tokens && usage.tokens > config.largeContextThreshold) {
      decision = buildRoutingDecision(...);
      decision.isContextTriggered = true;
    }
  }

  // 3. Classifier override (only if not pinned, not context-triggered, not rule-matched)
  if (config.classifierModel && !input.pinnedTier && !decision.isContextTriggered && !decision.isRuleMatched) {
    const result = await runClassifier(config.classifierModel, input.modelRegistry, input.context, input.previousDecision?.phase);
    if (result) {
      decision = buildRoutingDecision(...);
      if (input.isBudgetExceeded && decision.tier === "high") { /* downgrade */ }
    }
  }

  // 4. Image attachment upgrade
  if (hasImageAttachment(input.context)) {
    decision = maybeUpgradeForImage(decision, config.profile, input.modelRegistry, config);
  }

  return decision;
};
```

**Design choice:** Split into `RoutingInput` (per-request, changes every call) and `RoutingConfig` (stable across calls within a profile). This makes callers cheaper when config doesn't change, and makes it clear which parts are "the question" vs "the configuration".

## Keyword Matching Fix

```typescript
// routing.ts (module-level, built once)

const EXPLICIT_HIGH_HINTS: readonly string[] = [
  "best", "deep", "deeply", "carefully", "thoroughly",
  "robust", "comprehensive", "step by step", "think hard", "highest quality",
];

// Pre-compiled RegExp for each single-word keyword (built once at module load)
const buildKeywordMatcher = (keywords: readonly string[]): {
  singleWord: RegExp[];
  multiWord: string[];
} => {
  const singleWord: RegExp[] = [];
  const multiWord: string[] = [];
  for (const kw of keywords) {
    if (kw.includes(" ")) {
      multiWord.push(kw);
    } else {
      singleWord.push(new RegExp(`\\b${kw}\\b`));
    }
  }
  return { singleWord, multiWord };
};

const HIGH_HINT_MATCHER = buildKeywordMatcher(EXPLICIT_HIGH_HINTS);
// ... same for all keyword lists

export const matchesKeywords = (text: string, matcher: ReturnType<typeof buildKeywordMatcher>): boolean => {
  for (const re of matcher.singleWord) {
    if (re.test(text)) return true;
  }
  for (const phrase of matcher.multiWord) {
    if (text.includes(phrase)) return true;
  }
  return false;
};
```

**Why RegExp over manual indexOf + boundary check:**
- Pre-compiled `RegExp` with `\b` is correct by construction (handles all occurrences, not just first)
- No first-occurrence-only bug (architect concern #1)
- Built once at module load — zero per-call allocation
- `\b` in JS regex means `\W` boundary or string start/end — exactly what we need

**Behavioral impact audit:**

| Keyword | Previously matched | Word-boundary matches? | Risk |
|---------|-------------------|----------------------|------|
| `"plan"` | `"planning"` ✓ | `"planning"` ✗ | **SAFE** — `"planning"` is its own keyword |
| `"code"` | `"encode"`, `"decode"` ✓ | ✗ | **Behavior change** — acceptable, these are false positives |
| `"change"` | `"unchanged"`, `"exchange"` ✓ | ✗ | **Behavior change** — acceptable |
| `"format"` | `"information"`, `"reformatting"` ✓ | ✗ | **Behavior change** — acceptable |
| `"find"` | `"finding"` ✓ | ✗ | **Behavior change** — "finding" should not route as lookup |
| `"list"` | `"blacklist"`, `"listing"` ✓ | ✗ | **Behavior change** — acceptable |
| `"edit"` | `"editing"` ✓ | ✗ | **Behavior change** — need to add `"editing"` as keyword |
| `"quick"` | `"quickly"` ✓ | ✗ | **SAFE** — `"quickly"` is its own keyword |
| `"fast"` | `"fastest"` ✓ | ✗ | **Behavior change** — may want to add `"fastest"` |
| `"brief"` | `"briefing"` ✓ | ✗ | **Behavior change** — acceptable, briefing ≠ brief |
| `"continue"` | `"continued"` ✓ | ✗ | **Behavior change** — may want to add `"continued"` |

**Mitigation:** Add derived forms (`"editing"`, `"fastest"`, `"continued"`) to the keyword lists where the morphological variant should still trigger the same routing.

## truncateContext Fix

```typescript
const truncateContext = (context: Context, limit: number): Context => {
  const messages = [...context.messages];
  if (messages.length <= 1) return context;

  const systemTokens = context.systemPrompt ? estimateTokens(context.systemPrompt) : 0;
  let totalTokens = systemTokens;
  const messageCosts: number[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const cost = estimateTokens(extractTextFromContent(messages[i].content));
    messageCosts[i] = cost;
    totalTokens += cost;
  }
  if (totalTokens <= limit) return context;

  // Remove from front, always preserve last message
  let removed = 0;
  let cutIndex = 0;
  const target = totalTokens - limit;
  while (cutIndex < messages.length - 1 && removed < target) {
    removed += messageCosts[cutIndex];
    cutIndex++;
  }

  return { ...context, messages: messages.slice(cutIndex) };
};
```

## File Change Summary

| File | Change |
|------|--------|
| `state.ts` | Expand from 49 → ~130 LOC. Add `RouterState` class. `buildPersistedState` becomes private method. Keep `isRouterPersistedState` as-is. |
| `index.ts` | Shrink from 434 → ~150 LOC. Instantiate `RouterState`, wire events, pass state to subsystems. Only `shimmerInterval` remains as local. Remove dead `isInitialized`. |
| `provider.ts` | Shrink from 514 → ~250 LOC. `streamSimple` becomes delegation loop. Accepts `RouterState` directly. |
| `routing.ts` | Add `resolveRouting`, `RoutingInput`, `RoutingConfig`. Hoist keywords, add `buildKeywordMatcher` + `matchesKeywords`. Grow ~60 LOC net. |
| `ui.ts` | Import `ThinkingLevel` from `@oh-my-pi/pi-agent-core`. Add `inherit` to color/icon maps. Add `renderUsageReport`. |
| `commands.ts` | Remove `handleUsage` rendering body (delegate to ui.ts). Accept `RouterState` directly. |
| `types.ts` | No change. |
| `constants.ts` | No change. |
