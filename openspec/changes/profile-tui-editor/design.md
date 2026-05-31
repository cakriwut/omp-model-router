## Context

The model router extension manages routing profiles stored in `~/.omp/agent/model-router.json`. Each profile is a `RouterProfile` — three `RoutedTierConfig` entries (high/medium/low), each with a primary `model` string, optional `thinking` level, and optional `fallbacks` array.

Currently the only mutation surface is `/router set <profile>.<tier>.<field> <value>`, which requires knowing exact model IDs. OMP's `ExtensionContext` exposes `ctx.modelRegistry` (a `ModelRegistry` instance), whose `getAvailable()` method returns all models with validated provider auth — this is the exact set the user can actually use. The `pi-tui` package (already a peer dep) exports `SelectList` and `SettingsList`, which are the same components OMP uses for its own settings TUI.

**Constraint**: The `router` virtual provider registers models named after profiles (e.g. `router/auto`). These must never appear in model picker lists — they are internal routing handles, not real models.

## Goals / Non-Goals

**Goals:**
- Interactive create/edit/rename/delete for profiles via `/router profile` (no args)
- Model picker shows only auth-validated, non-virtual models with cost metadata
- Fallback selection is multi-select (checkbox style) from the same validated model list
- Edits are drafted in memory; committed atomically on explicit save (disk write + `reloadConfig`)
- New TUI components are self-contained and reusable
- Zero new runtime dependencies

**Non-Goals:**
- Editing global config keys (`budget`, `compression`, etc.) — that stays with `/router set`
- Per-profile `historyCompression` override editing — out of scope for this change
- Calibration config editing — out of scope
- Any change to `/router profile <name>` (profile switching) — unchanged

## Decisions

### D1: Extend `/router profile` (no args) rather than adding a new command

**Decision**: No-arg `/router profile` launches the TUI, replacing the current plain-text list.

**Rationale**: Users already reach for `/router profile` to manage profiles. A new `/router profiles` command would fragment discoverability. The current no-arg behavior (one-line notification) is strictly inferior to the TUI and has no existing users relying on its text format.

**Alternative considered**: New `/router profiles` subcommand. Rejected — extra subcommand to document and remember, for no gain.

### D2: `SettingsList` + `ctx.ui.custom()` for the profile editor, not a chain of `ctx.ui.select()` calls

**Decision**: Use `ctx.ui.custom()` with a `SettingsList` component to show all 9 fields of a profile in one screen.

**Rationale**: Sequential `select()` dialogs for 9 fields would be tedious and give no overview of the profile state. `SettingsList` renders all rows simultaneously, supports submenu drilling for complex fields, and matches OMP's own settings TUI pattern exactly. The `ctx.ui.custom()` API is designed for this: it takes a factory and returns a typed promise.

**Alternative considered**: `ctx.ui.select()` chain. Rejected — poor UX for multi-field editing.

### D3: Model picker as a `SelectList` submenu inside `SettingsList`

**Decision**: The `model` row's `submenu` field opens a `SelectList` of available models. Items are formatted as `"provider/id · Xk ctx · $in/$out per M"`. The primary model of the current tier is pre-selected.

**Rationale**: `SettingsList.submenu` is exactly the hook for nested pickers. `SelectList` supports fuzzy filtering natively. Showing cost metadata (from `Model.cost.input` and `Model.cost.output`, in $/M tokens) lets users make informed decisions inline.

**Filter**: `ctx.modelRegistry.getAvailable().filter(m => m.provider !== "router")` — excludes the virtual router provider.

**Cost formatting**: `$${(cost.input).toFixed(2)}/$${(cost.output).toFixed(2)} per M`. When cost is absent, show `cost unknown`.

### D4: New `CheckboxList` component for fallbacks, not additive `select()` loop

**Decision**: Write a minimal `CheckboxList` TUI component (~80 lines in `src/tui/checkbox-list.ts`) as a `SettingsList` submenu for the fallbacks row.

**Rationale**: Additive `select()` loops require multiple round-trips and leave the user uncertain about the accumulated state. A checkbox list shows the full model set with current selections visible at once. The component is small enough to own — it does not justify adding an npm dependency.

**Interface**:
```typescript
export interface CheckboxItem {
  value: string;
  label: string;
  description?: string;
}

export class CheckboxList implements Component {
  onConfirm?: (selected: string[]) => void;
  onCancel?: () => void;
  // Space: toggle; Enter: confirm; Esc: cancel
}
```

**Filter**: same as model picker — `m.provider !== "router"`, minus the already-selected primary model for that tier (can't be its own fallback).

### D5: All TUI logic in `src/tui/profile-editor.ts`; `commands.ts` only calls it

**Decision**: Extract all interactive profile-management TUI into a new `src/tui/profile-editor.ts`. `commands.ts`'s `handleProfile` becomes a thin dispatcher that calls `openProfileEditor(...)` from that module.

**Rationale**: `commands.ts` is already 971 lines. The profile editor needs ~220 lines of component wiring. Co-locating them would push the file past 1200 lines with dense TUI logic mixed into command dispatch.

**Exported surface**:
```typescript
export async function openProfileEditor(
  profileName: string,
  config: RouterConfig,
  modelRegistry: ModelRegistry,
  ctx: ExtensionCommandContext,
  onSave: (updatedProfiles: Record<string, RouterProfile>) => void,
): Promise<void>
```

### D6: Save = `patchConfigFile` + `reloadConfig` + `ensureValidActiveRouterProfile`

**Decision**: On save, call `patchConfigFile({ profiles: updatedProfiles })` then `actions.reloadConfig(ctx, { preserveDebug: true })` then `actions.ensureValidActiveRouterProfile(ctx)`.

**Rationale**: This is exactly the pattern used by `handleSet` for profile mutations today. Reusing the same path means no special-casing in `reloadConfig` and the router provider re-registers correctly after a profile add/rename/delete.

**For delete/rename**: `patchConfigFile` receives the full updated `profiles` map (with key removed or renamed), so the patch is always a full `profiles` replacement — no partial key surgery on the JSON.

## Risks / Trade-offs

| Risk | Likelihood | Mitigation |
|---|---|---|
| `ctx.ui.custom()` unavailable in non-interactive mode (print/RPC) | Low | Guard with `if (!ctx.hasUI)` before launching TUI; fall back to existing text behavior |
| `SettingsList` submenu API changes in a future `pi-tui` version | Low | We depend on a peer dep version range (`^13`); pin the submenu shape in a unit test |
| User saves a profile with a model that later loses auth | Acceptable | Config stores model IDs as strings; router already handles missing-model gracefully at routing time |
| Deleting the currently active profile mid-session | Low | `ensureValidActiveRouterProfile` already handles this case — it falls back to the first available profile |
| `CheckboxList` scroll behavior on large model lists (50+ models) | Low | Inherit the same scroll/visible-range logic from `SelectList` |
