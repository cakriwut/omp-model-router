# Auto-Upgrade Feature

Automatically upgrades the model router tier when the same tool call fails consecutively, enabling the model router to recover gracefully from transient or task-specific failures by delegating to more capable models.

## Configuration

Add to `~/.omp/agent/model-router.json`:

```json
{
  "autoUpgrade": {
    "enabled": true,
    "threshold": 2,
    "tools": ["find", "search", "edit", "ast_grep"]
  }
}
```

### Options

- **`enabled`** (boolean, required): Turn auto-upgrade on/off.
- **`threshold`** (number, optional): Number of consecutive failures before upgrading. Default: `2`.
- **`tools`** (string[], optional): Only track these tool names. If omitted, any tool failure counts. Example: `["find", "search", "edit"]`.

## How It Works

### 1. Extension Event Subscription

The model router subscribes to `tool_execution_end` events emitted by the pi-coding-agent after every tool execution:

```ts
pi.on("tool_execution_end", (event, ctx) => {
  if (event.isError) {
    // Track failure
  }
});
```

The event includes:
- `toolName`: name of the tool (e.g., "find", "search")
- `isError`: whether the tool threw an error
- `toolCallId`: unique identifier for this invocation

### 2. Failure Streak Tracking

Each tool maintains an independent failure streak counter:

- **On failure** (when `isError === true`):
  - Increment the streak counter for that tool
  - If streak reaches `threshold`: **trigger upgrade** (clear streak)
- **On success** (when `isError === false`):
  - Reset the streak counter to 0

Tools not in the `tools` filter (if configured) are ignored.

### 3. One-Shot Tier Override

When the threshold is reached:

1. Current tier is determined from the last routing decision (defaults to `"low"`)
2. Next higher tier is selected:
   - `low` → `medium`
   - `medium` → `high`
   - `high` → no upgrade (already at highest)
3. The router's next request uses the upgraded tier for **one turn only**
4. Streak counter resets; future requests use normal routing heuristics

### Example Flow

```
Turn 1: User runs /router profile=auto
  Route with: low tier (heuristic-based)
  Tool: find → ERROR ✗

Turn 2: User calls model again
  find failures streak: 1
  Route with: low tier (not yet at threshold)
  Tool: find → ERROR ✗

Turn 3: User calls model again
  find failures streak: 2 (>= threshold)
  >>> AUTO-UPGRADE TRIGGERED <<<
  Route with: medium tier (one-shot override)
  Tool: find → SUCCESS ✓

Turn 4: User calls model again
  find failure streak: 0 (reset after success)
  Route with: low or medium tier (normal heuristics)
```

## Implementation Details

### Config Schema

**`types.ts`**:
```ts
export interface AutoUpgradeConfig {
  enabled: boolean;
  threshold?: number;      // Default: 2
  tools?: string[];        // Default: all tools
}

export interface RouterConfig {
  autoUpgrade?: AutoUpgradeConfig;
  // ... other fields
}
```

### State Tracking

**`state.ts`**:
```ts
export class RouterState {
  toolFailureStreak: Map<string, number> = new Map();
  autoUpgradeTier: RouterTier | undefined;
}
```

### Event Handler

**`index.ts`**:
```ts
pi.on("tool_execution_end", (event, ctx) => {
  if (!event.isError) {
    state.toolFailureStreak.delete(event.toolName);
    return;
  }
  
  const streak = (state.toolFailureStreak.get(event.toolName) ?? 0) + 1;
  state.toolFailureStreak.set(event.toolName, streak);
  
  if (streak >= threshold) {
    state.autoUpgradeTier = nextHigherTier(currentTier);
  }
});
```

### Routing Override

**`provider.ts`** (inside `streamSimple`):
```ts
const decision = await resolveRouting(...);

// One-shot override
if (state.autoUpgradeTier) {
  const upgradeTier = state.autoUpgradeTier;
  state.autoUpgradeTier = undefined;
  
  decision.tier = upgradeTier;
  decision.targetLabel = profile[upgradeTier].model;
  decision.reasoning = `auto-upgrade: consecutive tool failures → ${upgradeTier}`;
}
```

## Test Coverage

**`auto-upgrade.test.ts`** — 14 tests:
- Config normalization (7 tests)
- Failure streak logic (7 tests)

All tests pass:
```
✓ normalizeConfig handles enabled/disabled/threshold/tools
✓ Upgrade triggers after threshold
✓ Success resets streak
✓ Tools filter works
✓ Cannot upgrade beyond high tier
✓ Independent tool streaks
```

## Debugging

Enable debug mode to see auto-upgrade notifications:

```json
{
  "debug": true,
  "autoUpgrade": { "enabled": true, "threshold": 2 }
}
```

When an upgrade triggers, you'll see:
```
Auto-upgrade: find failed 2× → upgrading to medium tier
```

## Edge Cases

1. **No upgrade at high tier**: If already routing to high tier, reaching threshold does nothing (already using best model).
2. **Mid-turn success**: If a tool succeeds after 1 failure, the streak resets. Upgrade only triggers if failures are consecutive without intervening successes.
3. **Different tools**: Streaks are independent. Failing `find` twice does not count toward `search` failures.
4. **Cross-session persistence**: Streaks are transient (not persisted). New sessions start with zero streaks.
5. **Config reload**: Changing `autoUpgrade` config and reloading does not affect in-flight streak counters.

## Related Docs

- [Extension Event Subscription](../finding.md) — How extensions receive tool_execution_end events
- [Router Architecture](README.md) — Overview of routing decisions and tier selection
- [Pi-coding-agent Extensions](https://github.com/oh-my-pi/pi-coding-agent/docs/skills/authoring-extensions.md) — Extension API reference
