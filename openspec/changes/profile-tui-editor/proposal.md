## Why

Current profile configuration requires text commands (`/router set <profile>.<tier>.model <id>`) with no browsable model list, no cost metadata, and no way to manage profiles beyond editing config files. This is error-prone and inaccessible. Users need an interactive TUI-based profile manager that shows available models (auth-validated), displays pricing, and supports full CRUD (create/edit/rename/delete/switch).

## What Changes

- **4 custom TUI components** (ProfileListComponent, ProfileEditorComponent, ModelPickerComponent, FallbackPickerComponent) built on `ctx.ui.custom()` factory with strict invariants: `done(value)` called exactly once per exit path, `render(width)` returns terminal-safe wrapped strings, `handleInput(data)` receives raw terminal data.
- **Profile List screen** (`/router profile` with no args): fuzzy-searchable list of profiles with active marker (*), tier model summaries, and actions (activate, edit, create, rename, delete).
- **Profile Editor screen** (full-replace modal): 9 editable slots (high/medium/low × model/thinking/fallbacks) with dirty-state tracking and explicit save (`S` key) + discard flow.
- **Model Picker submenu** (single-select): tabbed provider scoping, fuzzy search, cost metadata per model (`$input/$output per M tokens`), badges showing primary (★) and fallback (#) assignments.
- **Fallback Picker submenu** (multi-select, ordered): checkbox-based selection with primary-model exclusion, fallback ordering via stable Map, and confirmation.
- **Atomic transactions**: Draft edits accumulate in memory; disk write + config reload + profile validation happens only on explicit save. No auto-save, no partial writes.
- **Cost-aware selection**: Each model item displays provider, context window, and per-million-token pricing so users can optimize tier assignments.

## Capabilities

### New Capabilities

- `profile-tui-manager`: Interactive full-screen TUI for creating, editing, renaming, deleting, and activating router profiles with auth-gated model picker and ordered fallback selection.

### Modified Capabilities

- `/router profile` — Now with no arguments launches the interactive profile manager (was: single-line text output). With an argument, still switches profiles (unchanged).
