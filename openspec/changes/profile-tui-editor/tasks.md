## 1. CheckboxList Component

- [ ] 1.1 Create `src/tui/checkbox-list.ts` — implement `CheckboxItem` interface and `CheckboxList` class implementing `Component` with Space-toggle, Enter-confirm, Esc-cancel, and scrolling for large lists
- [ ] 1.2 Add scroll/visible-range logic to `CheckboxList` (same pattern as `SelectList`) so lists with 50+ items render correctly
- [ ] 1.3 Write unit test `test/checkbox-list.test.ts` covering: toggle, confirm with selection, confirm with empty selection (returns `undefined`), cancel, scroll bounds

## 2. Model Picker Utilities

- [ ] 2.1 Create `src/tui/profile-editor.ts` with a `buildModelItems(modelRegistry, excludePrimary?)` helper that calls `ctx.modelRegistry.getAvailable()`, filters out `provider === "router"`, formats each item as `"provider/id · Xk ctx · $in/$out per M"` (or `"cost unknown"`), and returns `SelectItem[]`
- [ ] 2.2 Verify the `router` provider exclusion with a unit test that asserts no `router/*` entries appear in the result regardless of what `getAvailable()` returns

## 3. Profile Editor TUI

- [ ] 3.1 Implement `buildProfileItems(profile, modelRegistry)` in `profile-editor.ts` — returns 9 `SettingItem[]` rows (high/medium/low × model/thinking/fallbacks) with correct `currentValue`, `values` (for thinking cycle), `submenu` (for model and fallbacks), and `changed: false`
- [ ] 3.2 Implement the `model` submenu factory: builds a `SelectList` from `buildModelItems(...)`, pre-selects the current model, wires `onSelect` → `done(selectedValue)`, `onCancel` → `done(undefined)`
- [ ] 3.3 Implement the `fallbacks` submenu factory: builds a `CheckboxList` from `buildModelItems(...)` minus the tier's primary model, pre-checks current `fallbacks`, wires `onConfirm` → `done(selected.length ? selected : undefined)`, `onCancel` → `done(undefined)`
- [ ] 3.4 Implement the draft accumulator: `onChange(id, newValue)` callback mutates a deep copy of the profile; sets `changed: true` on the affected row via `settingsList.updateValue(...)`
- [ ] 3.5 Implement save handler (key `S`): validates draft is non-empty, calls `patchConfigFile({ profiles: { ...allProfiles, [name]: draft } })`, calls `onSave(updatedProfiles)`, closes the component via `done`
- [ ] 3.6 Wire Esc to cancel without save; wire the `custom()` overlay option correctly so the editor takes full keyboard focus
- [ ] 3.7 Export `openProfileEditor(profileName, config, modelRegistry, ctx, onSave)` as the single public function from `profile-editor.ts`

## 4. Profile CRUD Flows

- [ ] 4.1 Implement `openCreateProfile(config, modelRegistry, ctx, onSave)` in `profile-editor.ts`: prompts `ctx.ui.input()` for name, validates uniqueness, opens `openProfileEditor` pre-filled with active profile copy on success
- [ ] 4.2 Implement `openRenameProfile(config, modelRegistry, ctx, onSave)` in `profile-editor.ts`: prompts `ctx.ui.select()` for source profile, prompts `ctx.ui.input()` for new name, validates uniqueness, calls `patchConfigFile` with renamed key, calls `onSave`
- [ ] 4.3 Implement `openDeleteProfile(config, ctx, onSave)` in `profile-editor.ts`: guards against deleting the last profile, prompts `ctx.ui.select()` for target, prompts `ctx.ui.confirm()`, calls `patchConfigFile` with key removed, calls `onSave`

## 5. Command Integration

- [ ] 5.1 Update `handleProfile` in `src/commands.ts`: when `args` is empty and `ctx.hasUI` is true, call `ctx.ui.select()` with profile names + three action items (`"＋ Create new profile"`, `"✎ Rename a profile"`, `"✕ Delete a profile"`), dispatch to the correct function from `profile-editor.ts`
- [ ] 5.2 Wire the `onSave` callback passed to all profile-editor functions to call `actions.reloadConfig(ctx, { preserveDebug: true })` then `actions.ensureValidActiveRouterProfile(ctx)` then `ctx.ui.notify("Profile saved.", "info")`
- [ ] 5.3 Ensure non-interactive fallback: when `ctx.hasUI` is false and no args, retain the existing `ctx.ui.notify(...)` text output
- [ ] 5.4 Update the `getArgumentCompletions` block for the `"profile"` subcommand to also suggest `"create"`, `"rename"`, `"delete"` as tab-completable action names (future CLI entry points, currently no-op)
- [ ] 5.5 Update `/router help` text to document the new interactive mode: `"profile [name]  Switch profile or launch interactive profile manager (no args)."`

## 6. Tests

- [ ] 6.1 Write `test/profile-editor-model-filter.test.ts`: asserts `buildModelItems` with a mock registry containing a `router/auto` model returns zero `router` entries and all others are formatted correctly
- [ ] 6.2 Write `test/profile-crud.test.ts`: unit tests for create (name conflict, success), rename (conflict, success, currently-active profile), delete (last-profile guard, confirm, cancel) — mock `patchConfigFile` and assert call args
- [ ] 6.3 Run `bun test` and confirm all new and existing tests pass
