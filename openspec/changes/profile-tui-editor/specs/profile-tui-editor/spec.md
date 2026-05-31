## ADDED Requirements

### Requirement: Profile Manager Entry Point

`/router profile` with no arguments MUST launch an interactive profile manager (ProfileListComponent) via `ctx.ui.custom()` when `ctx.hasUI` is true. When `ctx.hasUI` is false (print/RPC mode), it MUST fall back to the existing plain-text profile list notification.

#### Scenario: No-arg invocation in interactive mode
- **WHEN** the user runs `/router profile` with no arguments in an interactive OMP session
- **THEN** a custom ProfileListComponent is displayed (full-screen, not overlay) showing all configured profile names with active marker (*), tier model summaries, and action hints

#### Scenario: No-arg invocation in non-interactive mode
- **WHEN** the user runs `/router profile` with no arguments in print or RPC mode
- **THEN** the existing notification is shown (unchanged behavior)

---

### Requirement: Component Factory Signature

All 4 custom components (ProfileListComponent, ProfileEditorComponent, ModelPickerComponent, FallbackPickerComponent) MUST be created via `ctx.ui.custom((tui, theme, keybindings, done) => new Component(...), { overlay: false })` and implement the Component interface: `render(width: number): string[]` and `handleInput(data: string): void`.

#### Invariants

- **Done guarantee**: `done(value)` is called exactly once on every exit path (confirm, cancel, save, discard). No exit path bypasses `done()`.
- **Render safety**: Every line in `render()` is wrapped with `truncateToWidth(replaceTabs(line), width)` before returning.
- **Input handling**: `handleInput(data: string)` receives raw terminal data (bytes). Use `keybindings.matches(data, "tui.select.cancel")` for standard keys and `matchesKey(data, "ctrl+e")` for custom Ctrl combos.
- **No cleanup**: No `dispose()` method needed; no timers, sockets, or file watchers.
- **Theme**: All components use `getSelectListTheme()` from `@oh-my-pi/pi-coding-agent`. No custom theme; use theme.fg("accent"), theme.fg("muted"), theme.fg("default"), theme.fg("warning").

---

### Requirement: Profile List Screen

The profile list MUST display all configured profiles in a list with fuzzy-searchable filter, active profile marker, tier model summaries, and actions (activate, edit, create, rename, delete).

#### Scenario: Profile list contents
- **WHEN** ProfileListComponent is displayed
- **THEN** each profile is shown on one line with format: `[*] {name} [H: {model}] [M: {model}] [L: {model}]` at 80 columns, or `[*] {name} [H: {model}] [M: {abbrev}] [L: {abbrev}]` at 60 columns (narrow mode)
- **AND** the currently active profile is marked with `*` in accent color
- **AND** a search input line shows `> {query}` at the top, updated as user types

#### Scenario: Fuzzy filter
- **WHEN** the user types printable characters
- **THEN** the profile list is filtered by fuzzy match against profile name + tier model summaries (case-insensitive)
- **AND** pressing Backspace removes a character from the filter

#### Scenario: Action dispatch on key press
- **WHEN** the user presses a key matching the hint line:
  - `Enter` → activate highlighted profile
  - `Ctrl+E` → edit highlighted profile
  - `Ctrl+N` → create new profile
  - `Ctrl+D` → delete highlighted profile (omitted if only 1 profile exists)
  - `Ctrl+R` → rename highlighted profile
  - `Esc` → cancel
- **THEN** the component calls `done({ action, profile })` or `done(undefined)` accordingly

#### Scenario: Navigate with cursor keys
- **WHEN** the user presses Up or Down
- **THEN** the cursor (❯) moves to the previous or next profile in the filtered list, wrapping at edges

#### Scenario: Edge state: no profiles
- **WHEN** no profiles are configured
- **THEN** ProfileListComponent displays: `(no profiles configured)` and hint line: `ctrl+n new · ESC close`

#### Scenario: Edge state: filter matches nothing
- **WHEN** the user's filter query has no matches
- **THEN** the list shows `(no matches)` and hint: `← backspace · ENTER · ctrl+e edit · ctrl+n new · ESC`

#### Scenario: Edge state: single profile (cannot delete)
- **WHEN** exactly one profile is configured
- **THEN** the hint line omits `ctrl+d delete`
- **AND** footer detail shows: `{name}: ONLY PROFILE — cannot delete`

---

### Requirement: Profile Editor Screen

The profile editor MUST display a full-screen modal with 9 editable rows (high/medium/low × model/thinking/fallbacks), dirty-state tracking, and a state machine for save/discard/cancel.

#### Scenario: Editor layout
- **WHEN** ProfileEditorComponent opens for profile `"auto"`
- **THEN** the screen shows three tier sections:
  ```
  ─── HIGH ───
  ❯ model       {value}
    thinking    {value}
    fallbacks   {count models: list} or (none configured)
  ─── MEDIUM ───
  …
  ─── LOW ───
  …
  ```

#### Scenario: Changed field marker
- **WHEN** the user edits a field and its value differs from the original profile via `JSON.stringify` comparison
- **THEN** the row displays as: `* {field} [{new-value}]` (asterisk prefix + brackets around value)

#### Scenario: Missing-fallbacks warning
- **WHEN** any tier has `fallbacks: undefined` or `[]`
- **THEN** the footer shows: `⚠ {TIER} has no fallbacks — requests fail without retries`
- **AND** save is still permitted

#### Scenario: Key dispatch in editing state
- **WHEN** the user presses a key:
  - `↑`/`↓` → move cursor (skip tier headers)
  - `Enter`/`Space` on model row → open ModelPickerComponent
  - `Enter`/`Space` on fallbacks row → open FallbackPickerComponent
  - `Space` on thinking row → cycle to next thinking level (low → medium → high → low)
  - `S` (uppercase) → save draft: `done(draft)`
  - `Esc` → check dirty state:
    - If clean: `done(undefined)`
    - If dirty: transition to `dirty_confirm` state
- **THEN** the appropriate action is taken

#### Scenario: Dirty-confirm state machine
- **WHEN** user presses `Esc` with unsaved changes
- **THEN** state transitions to `dirty_confirm` and hint line becomes: `Unsaved: S save · y discard · n continue`
- **WHEN** user presses:
  - `S` → save: `done(draft)`
  - `y` → discard: `done(undefined)`
  - `n` → cancel: state returns to `editing`, hint line restored
  - Any other key → ignored

#### Scenario: Submenu delegation for model field
- **WHEN** user presses `Enter`/`Space` on the model row
- **THEN** ProfileEditorComponent delegates to ModelPickerComponent
- **AND** on ModelPickerComponent's `done(modelRef)`, draft is updated: `draft.{tier}.model = modelRef`

#### Scenario: Submenu delegation for fallbacks field
- **WHEN** user presses `Enter`/`Space` on the fallbacks row
- **THEN** ProfileEditorComponent delegates to FallbackPickerComponent
- **AND** on FallbackPickerComponent's `done(modelRefs)`, draft is updated: `draft.{tier}.fallbacks = modelRefs` (or undefined if empty)

---

### Requirement: Model Picker Screen

The model picker MUST display models from `ctx.modelRegistry.getAvailable()` with router provider excluded, tabbed provider scoping, fuzzy search, and badges showing tier assignments.

#### Scenario: Model list contents
- **WHEN** ModelPickerComponent opens
- **THEN** only models where `model.provider !== "router"` are shown
- **AND** each item displays: `{badge} {provider}/{id} · {ctxWindow}k ctx · ${in}/${out} per M` (or `cost unknown`)
- **AND** the item matching the current tier's model is pre-selected
- **AND** a TabBar at the top shows provider scopes: ALL, AMAZON BEDROCK, ANTHROPIC, OPENAI, GOOGLE

#### Scenario: Badge display
- **WHEN** a model is the primary model for any tier
- **THEN** it displays badge: `★ {TIER}.primary` in accent+bold color, left-aligned in 12-char column
- **WHEN** a model is a fallback for any tier
- **THEN** it displays badge: `↓ {TIER}.fb-N` (in muted color), left-aligned in 12-char column
- **WHEN** a model has no assignment
- **THEN** the badge column is blank

#### Scenario: Fuzzy filter
- **WHEN** the user types printable characters
- **THEN** the model list is filtered by fuzzy match against `"{provider}/{id} {name}"` (case-insensitive)

#### Scenario: Provider scope via Tab
- **WHEN** the user presses Tab
- **THEN** the provider scope cycles to the next tab (ALL → BEDROCK → ANTHROPIC → … → ALL)
- **AND** the filtered list is re-scoped to that provider (if not ALL)

#### Scenario: Confirm selection
- **WHEN** the user presses Enter
- **THEN** ModelPickerComponent calls `done(modelRef)` where `modelRef` is `"provider/id"`

#### Scenario: Cancel
- **WHEN** the user presses Esc
- **THEN** ModelPickerComponent calls `done(undefined)`

#### Scenario: Footer detail
- **WHEN** a model is highlighted
- **THEN** the footer shows: `{name} · {provider} · {ctxWindow}k ctx · ${in}/${out} per M`

---

### Requirement: Fallback Picker Screen

The fallback picker MUST display models as multi-select checkboxes with stable ordering, primary-model exclusion, and provider scoping.

#### Scenario: Fallback list excludes primary and virtual models
- **WHEN** FallbackPickerComponent opens for a tier whose primary model is `"anthropic/claude-sonnet-4-5"`
- **THEN** `"anthropic/claude-sonnet-4-5"` is not present in the list
- **AND** no `router/*` models are present
- **AND** header shows: `Pick fallbacks for {TIER} (primary: {short-name})`

#### Scenario: Pre-checked state
- **WHEN** FallbackPickerComponent opens for a tier with `fallbacks: ["openai/gpt-4o", "anthropic/claude-opus-4-7"]`
- **THEN** both models are shown as checked: `[1] {model}`, `[2] {model}`
- **AND** unchecked models show `[ ] {model}`

#### Scenario: Checkbox ordering
- **WHEN** the user presses Space on an unchecked model
- **THEN** the model is checked and assigned the next available order number
- **WHEN** the user presses Space on a checked model
- **THEN** the model is unchecked and all higher-order models are re-compacted: `[1,3] → [1,2]`

#### Scenario: Clear all with Ctrl+A
- **WHEN** the user presses Ctrl+A
- **THEN** all checked models are unchecked

#### Scenario: Confirm selection
- **WHEN** the user presses Enter
- **THEN** FallbackPickerComponent calls `done(sortedModelRefs)` where `sortedModelRefs` is ordered by checked order (1, 2, 3, …)

#### Scenario: Confirm with no items checked
- **WHEN** the user presses Enter with zero items checked
- **THEN** FallbackPickerComponent calls `done([])`

#### Scenario: Cancel
- **WHEN** the user presses Esc
- **THEN** FallbackPickerComponent calls `done(undefined)`

#### Scenario: Footer display
- **WHEN** items are selected
- **THEN** footer shows: `Selected: {N} fallbacks · {short-name-1}, {short-name-2}, …`
- **WHEN** no items are selected
- **THEN** footer shows: `Selected: (none)`

---

### Requirement: Create Profile

Creating a new profile MUST prompt for a name, validate uniqueness, then open the profile editor pre-filled with the currently active profile's configuration.

#### Scenario: Create with unique name
- **WHEN** command layer receives action `create` from ProfileListComponent and user enters a unique name
- **THEN** ProfileEditorComponent opens pre-filled with a deep copy of the active profile
- **AND** saving persists the new profile to disk via `patchConfigFile({ profiles: { …, [newName]: draft } })`

#### Scenario: Create with conflicting name
- **WHEN** user enters a name that already exists in `config.profiles`
- **THEN** an error notification is shown and the input prompt is re-shown

---

### Requirement: Rename Profile

Renaming a profile MUST select the source profile, prompt for the new name, validate uniqueness, then write the config atomically (remove old key, add new key with same value).

#### Scenario: Rename with conflicting name
- **WHEN** user enters a new name that already exists
- **THEN** an error notification is shown

#### Scenario: Rename currently active profile
- **WHEN** the renamed profile is the currently active profile (`state.selectedProfile`)
- **THEN** after reload `state.selectedProfile` is updated to the new name and router provider re-registers under the new name

---

### Requirement: Delete Profile

Deleting a profile MUST present a confirmation dialog and only proceed on affirmative confirmation. The deleted profile's key is removed from `profiles` and config is reloaded.

#### Scenario: Confirm delete
- **WHEN** user confirms deletion
- **THEN** `patchConfigFile` is called with the profile key removed
- **AND** `reloadConfig`, `ensureValidActiveRouterProfile`, and a success notification are called

#### Scenario: Cancel delete
- **WHEN** user declines confirmation
- **THEN** no write to disk occurs

#### Scenario: Attempt to delete last profile
- **WHEN** only one profile exists
- **THEN** deletion is blocked with error: `"Cannot delete the last profile."`

---

### Requirement: Command Integration

`handleProfile` in `commands.ts` MUST dispatch to all 4 components via `ctx.ui.custom()` and handle the result actions (activate, edit, create, rename, delete).

#### Scenario: Non-interactive fallback
- **WHEN** `ctx.hasUI === false` or `ctx.ui.custom()` is unavailable
- **THEN** existing plain-text behavior is preserved (text notification, no TUI)

---

## Hint Line Standard

All hint lines MUST use ` · ` (space-dot-space) as separator. Modifier keys and special keys are UPPERCASE (CTRL+E, SPACE, ENTER, ESC, TAB); single letters are lowercase. ESC is always last.

**Examples**:
- `ENTER activate · ctrl+e edit · ctrl+n new · ESC`
- `Unsaved: S save · y discard · n continue`
- `type filter · TAB scope · SPACE toggle · ↑↓ navigate · ENTER save · ESC cancel`

---

## Theme / Color Palette

All components use `getSelectListTheme()` and follow this palette:

| Element | Theme call | Notes |
|---------|------------|-------|
| Active profile `*` | `theme.fg("accent")` | Eye-catching |
| `★ {TIER}.primary` badge | `theme.fg("accent")` + bold | Critical |
| `[N]` checked | `theme.fg("accent")` + bold | Selected |
| `↓ {TIER}.fb-N` badge | `theme.fg("muted")` | Lower priority |
| `[ ]` unchecked | `theme.fg("muted")` | Faded |
| Tier headers `─── HIGH ───` | `theme.fg("accent")` | Section |
| Search input `>` | `theme.fg("muted")` | Low priority |
| Hint line | `theme.fg("muted")` | Meta |
| Footer detail | `theme.fg("muted")` | Info |
| Warning `⚠` | `theme.fg("warning")` | Alert |
| All other text | `theme.fg("default")` | Standard |

---

## Layout Constraints

- **80-column primary layout**: All screens designed for 80-column display
- **60-column narrow layout**: Model names and profile summaries truncate intelligently (e.g., `claude-opus-4-7` → `opus-4-7`, `sonnet` → `sonnet`, `haiku` → `hk`)
- **Vertical scroll**: Lists with 20+ items scroll with visible-range logic (show max 15 items, move window on navigation)
- **Line wrapping**: Every line wrapped via `truncateToWidth(replaceTabs(line), width)` to prevent buffer overflow
