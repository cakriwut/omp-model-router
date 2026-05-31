## ADDED Requirements

### Requirement: Profile Manager Entry Point

`/router profile` with no arguments MUST launch an interactive profile manager TUI when `ctx.hasUI` is true. When `ctx.hasUI` is false (print/RPC mode), it MUST fall back to the existing plain-text profile list notification.

#### Scenario: No-arg invocation in interactive mode
- **WHEN** the user runs `/router profile` with no arguments in an interactive OMP session
- **THEN** a profile selection screen is displayed listing all configured profile names, plus three action items: "＋ Create new profile", "✎ Rename a profile", "✕ Delete a profile"

#### Scenario: No-arg invocation in non-interactive mode
- **WHEN** the user runs `/router profile` with no arguments in print or RPC mode
- **THEN** the existing notification is shown: `"Current profile: <name>. Available: <list>"` (unchanged behavior)

---

### Requirement: Profile Selection Screen

The profile selection screen MUST use `ctx.ui.select()` to present profile names and actions. Selecting an existing profile name opens the profile editor for that profile. Selecting a CRUD action opens the corresponding flow.

#### Scenario: Select existing profile to edit
- **WHEN** the user selects an existing profile name from the selection screen
- **THEN** the profile editor opens for that profile, pre-filled with its current configuration

#### Scenario: Select "＋ Create new profile"
- **WHEN** the user selects the "＋ Create new profile" action
- **THEN** a text input prompt appears asking for the new profile name

#### Scenario: Select "✎ Rename a profile"
- **WHEN** the user selects the "✎ Rename a profile" action
- **THEN** a profile selector appears (listing only existing profiles), followed by a text input for the new name

#### Scenario: Select "✕ Delete a profile"
- **WHEN** the user selects the "✕ Delete a profile" action
- **THEN** a profile selector appears (listing only existing profiles), followed by a confirmation dialog

---

### Requirement: Profile Editor

The profile editor MUST display a `SettingsList` component inside `ctx.ui.custom()` with exactly nine rows: `high.model`, `high.thinking`, `high.fallbacks`, `medium.model`, `medium.thinking`, `medium.fallbacks`, `low.model`, `low.thinking`, `low.fallbacks`. Unsaved changes accumulate in memory. Pressing `S` commits the draft. Pressing `Esc` cancels without saving.

#### Scenario: Open editor for existing profile
- **WHEN** the profile editor opens for profile `"auto"`
- **THEN** all nine rows show the current values from `config.profiles["auto"]`; the `changed` flag on each row is `false`

#### Scenario: Modify a field
- **WHEN** the user changes any field value
- **THEN** the `changed` flag for that row becomes `true`; no write to disk occurs yet

#### Scenario: Save draft
- **WHEN** the user presses `S` with pending changes
- **THEN** `patchConfigFile` is called with `{ profiles: { ...existingProfiles, [name]: draft } }`, then `reloadConfig` is called with `preserveDebug: true`, then `ensureValidActiveRouterProfile` is called, then a success notification is shown

#### Scenario: Cancel without saving
- **WHEN** the user presses `Esc` with or without pending changes
- **THEN** the TUI closes with no write to disk and no `reloadConfig` call

---

### Requirement: Model Picker

The model picker MUST be a `SelectList` populated from `ctx.modelRegistry.getAvailable()` with the `router` provider excluded. Each item MUST display the model's provider, context window, and cost per million tokens (input/output). The current primary model MUST be pre-selected.

#### Scenario: Model list contents
- **WHEN** the model picker opens for any tier
- **THEN** only models where `model.provider !== "router"` are shown
- **AND** each item shows `"provider/id · Xk ctx · $in/$out per M"` (or `"cost unknown"` when cost data is absent)
- **AND** the item matching the tier's current `model` value is pre-selected

#### Scenario: Model with no cost data
- **WHEN** a model has no `cost` field
- **THEN** its item description shows `"cost unknown"` instead of a price

#### Scenario: Select a model
- **WHEN** the user confirms a selection in the model picker
- **THEN** the `model` field for that tier in the draft is updated to `"provider/id"` and the row's `currentValue` and `changed` flag update accordingly

---

### Requirement: Fallback Checkbox List

The fallback selector MUST be a `CheckboxList` component populated from `ctx.modelRegistry.getAvailable()` with the `router` provider excluded AND the tier's current primary model excluded (a model cannot be its own fallback). Pre-checked items MUST match the tier's current `fallbacks` array. Confirming returns the ordered list of checked model IDs.

#### Scenario: Fallback list excludes primary and virtual models
- **WHEN** the fallback picker opens for the `high` tier whose primary model is `"anthropic/claude-sonnet-4-5"`
- **THEN** `"anthropic/claude-sonnet-4-5"` is not present in the list
- **AND** no `router/*` models are present

#### Scenario: Pre-checked state
- **WHEN** the fallback picker opens for a tier with `fallbacks: ["openai/gpt-4o"]`
- **THEN** the `"openai/gpt-4o"` item is checked; all others are unchecked

#### Scenario: Confirm selection
- **WHEN** the user presses Enter in the fallback picker with items checked
- **THEN** the `fallbacks` field for that tier in the draft is updated to the checked model IDs in list order (top-to-bottom)

#### Scenario: Confirm with no items checked
- **WHEN** the user presses Enter with zero items checked
- **THEN** the `fallbacks` field for that tier in the draft is set to `undefined` (removed)

---

### Requirement: Create Profile

Creating a new profile MUST prompt for a name, validate uniqueness, then open the profile editor pre-filled with a copy of the currently active profile's configuration. Saving from the editor persists the new profile.

#### Scenario: Name conflict
- **WHEN** the user enters a name that already exists in `config.profiles`
- **THEN** an error notification is shown and no profile is created

#### Scenario: Valid new name
- **WHEN** the user enters a unique, non-empty name
- **THEN** the profile editor opens with all fields pre-filled from the active profile
- **AND** saving writes the new profile to disk

---

### Requirement: Rename Profile

Renaming a profile MUST select the source profile, prompt for the new name, validate uniqueness, then write the config atomically (add new key = old value, remove old key) and reload.

#### Scenario: Rename with conflicting name
- **WHEN** the new name already exists in `config.profiles`
- **THEN** an error notification is shown and no rename occurs

#### Scenario: Rename currently active profile
- **WHEN** the renamed profile is the currently active profile (`state.selectedProfile`)
- **THEN** after reload `state.selectedProfile` is updated to the new name and `ensureValidActiveRouterProfile` re-activates it correctly

---

### Requirement: Delete Profile

Deleting a profile MUST present a confirmation dialog and only proceed on affirmative confirmation. The deleted profile's key is removed from `profiles`, the config is patched and reloaded. `ensureValidActiveRouterProfile` handles fallback if the deleted profile was active.

#### Scenario: Confirm delete
- **WHEN** the user confirms deletion
- **THEN** `patchConfigFile` is called with the profile key removed, `reloadConfig` is called, `ensureValidActiveRouterProfile` is called, and a success notification is shown

#### Scenario: Cancel delete
- **WHEN** the user does not confirm deletion
- **THEN** no write to disk occurs and a cancellation notification is shown

#### Scenario: Attempt to delete last profile
- **WHEN** only one profile exists in `config.profiles`
- **THEN** deletion is blocked with an error notification: `"Cannot delete the last profile."`
