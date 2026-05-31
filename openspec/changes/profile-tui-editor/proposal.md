## Why

Configuring router profiles today requires knowing exact model IDs and issuing text commands (`/router set <profile>.<tier>.model <id>`), with no way to browse available models or see their cost. This makes profile management error-prone and inaccessible — users must memorize opaque model strings instead of selecting from a live, auth-validated list.

## What Changes

- **New interactive profile manager** launched by `/router profile` with no arguments — replaces the current plain-text list output with a full TUI session.
- **Profile CRUD**: create new profiles (with name prompt + editor), rename existing profiles, and delete profiles (with confirmation guard), all from within the TUI.
- **Visual profile editor**: `SettingsList`-based editor showing all 9 configurable slots (high/medium/low × model/thinking/fallbacks) for the selected profile.
- **Model picker submenu**: single-select `SelectList` populated from `ctx.modelRegistry.getAvailable()` — only models with validated auth shown; virtual `router/*` provider models excluded.
- **Fallback checkbox submenu**: new `CheckboxList` component (multi-select) for selecting ordered fallback model lists per tier.
- **Informed selection**: each model item displays `provider · context-window · $input/$output per M` so the user can make cost-aware decisions.
- **Atomic save**: draft edits accumulate in memory; write to `model-router.json` + `reloadConfig` + `ensureValidActiveRouterProfile` only on explicit save.
- **New file `src/tui/checkbox-list.ts`**: reusable `CheckboxList` TUI component (~80 lines).
- **New file `src/tui/profile-editor.ts`**: all profile-editor TUI logic extracted from `commands.ts` (~220 lines).
- `src/commands.ts`: `handleProfile` extended for TUI entry; help text and completions updated; no other handlers touched.

## Capabilities

### New Capabilities

- `profile-tui-editor`: Interactive TUI for creating, editing, renaming, and deleting router profiles, with auth-gated model picker and multi-select fallback checkboxes.

### Modified Capabilities

<!-- none — existing command-line profile switching via `/router profile <name>` is unchanged -->
