## Context

The model router extension manages routing profiles in `~/.omp/agent/model-router.json`. Each `RouterProfile` has three `RoutedTierConfig` entries (high/medium/low), each with primary `model` string, optional `thinking` level, and optional `fallbacks` array.

Profile configuration today is text-based (`/router set <profile>.<tier>.model <id>`), opaque, and inaccessible. OMP's `ExtensionContext` exposes `ctx.modelRegistry.getAvailable()` — all auth-validated models — and `ctx.ui.custom()` for building reusable TUI components. The `@oh-my-pi/pi-tui` package (peer dep) exports `Input`, `SelectList`, `TabBar`, `Container` — the same primitives OMP uses.

**Spec reference**: `docs/PROFILE_TUI_DESIGN_v2.md` (post-review, all blockers resolved).

**Virtual provider constraint**: The `router` virtual provider registers models named after profiles (e.g., `router/auto`). These must never appear in picker lists — they are internal routing handles, not real models.

## Goals / Non-Goals

**Goals:**
- Interactive create/edit/rename/delete for profiles via `/router profile` (no args)
- Full-screen TUI with 4 custom components (ProfileList, ProfileEditor, ModelPicker, FallbackPicker)
- All components built on `ctx.ui.custom()` factory with strict invariants
- Model picker shows auth-validated, non-virtual models with cost metadata
- Fallback picker supports multi-select with stable ordering and primary-model exclusion
- Dirty-state tracking with explicit save (S key) and discard confirmation
- Atomic transactions: disk write + config reload happens only on explicit save
- Cost-aware selection: all models display pricing per million tokens

**Non-Goals:**
- Editing global config keys (`budget`, `compression`, etc.) — stays with `/router set`
- Per-profile `historyCompression` override editing
- Calibration config editing
- Any change to `/router profile <name>` (profile switching) — unchanged

## Decisions

### D1: 4 custom TUI components, not SettingsList + CheckboxList

**Decision**: Build `ProfileListComponent`, `ProfileEditorComponent`, `ModelPickerComponent`, `FallbackPickerComponent` as custom components on `ctx.ui.custom()` factory, not wrappers around reusable OMP components.

**Rationale**: The specification requires strict invariants (`done(value)` exactly once, `render(width)` terminal-safe, `handleInput(data)` raw terminal data, state machines like dirty_confirm) that go beyond what `SettingsList` supports. Custom components ensure:
- Exact control over render output (line wrapping, truncation)
- Precise key dispatch ordering (critical for UX)
- State machines (dirty_confirm, checkbox ordering Map)
- Component composition (submenus via ProfileEditor delegating to ModelPicker/FallbackPicker)

**Trade-off**: ~500 lines of TUI code instead of ~150 lines using OMP components, but with full control and re-usability for future features.

### D2: Dirty-state confirmation machine in ProfileEditorComponent

**Decision**: When user presses Esc in ProfileEditor with unsaved changes, transition to `dirty_confirm` state and show `"Unsaved: S save · y discard · n continue"` in hint line.

**Rationale**: Prevents accidental data loss. Users who legitimately want to discard can press `y`; users who change their mind can press `n` to continue editing. Save/discard are explicit, intentional actions.

**State machine**:
```
"editing" + Esc (dirty) → "dirty_confirm" hint line changes
"dirty_confirm" + S → done(draft)  
"dirty_confirm" + y → done(undefined)
"dirty_confirm" + n → "editing" hint line restored
```

### D3: Fallback ordering via stable Map<modelRef, order>

**Decision**: Maintain fallback selection order in a `Map<string, number>` where value is 1-based order. Toggle removes; removal triggers re-compact: `Map([a:1, c:3]) → Map([a:1, b:2])`.

**Rationale**: Order matters for fallback retry chain. Checkboxes naturally toggle; a Map tracks both checked state and order without coupling them to list position. Re-compaction ensures gaps don't accumulate (user unchecks fallback #2, #3 becomes #2).

**Result**: When user confirms, extract `[...map.entries()].sort((a, b) => a[1] - b[1]).map(([ref]) => ref)` to get ordered fallback list.

### D4: TabBar for provider scoping in ModelPicker and FallbackPicker

**Decision**: Show provider tabs (ALL, AMAZON BEDROCK, ANTHROPIC, OPENAI, GOOGLE) and allow Tab key to cycle scope.

**Rationale**: Users might have dozens of models across providers. Scoping reduces noise in fuzzy-filtered list. Tabs are native OMP widget (peer dep). Tab key is standard OMP keybinding for cycling options.

**Fallback**: If a scope has no models, show empty list with hint `← Tab to switch provider`.

### D5: Badges (★ primary, ↓ fallback-N) in fixed 12-char left column

**Decision**: ModelPicker and FallbackPicker show badges in a fixed 12-character left-aligned column: `★ H.primary`, `↓ H.fb-1`, `[1]` (checked), `[ ]` (unchecked), or blank.

**Rationale**: Badges give visual context without cluttering the model name. Fixed column ensures cursor and badges never overlap. Examples:
```
★ H.primary ❯ claude-opus-4-7
↓ H.fb-1      claude-opus-4-6
              claude-sonnet-4-6
```

### D6: Hint-line standard: " · " separator, uppercase modifiers, exit last

**Decision**: All hint lines use ` · ` (space-dot-space) as separator. Modifier keys (CTRL, SHIFT, TAB) and special keys (ENTER, ESC, SPACE) are uppercase; single letters lowercase. ESC always last.

**Rationale**: Consistent, readable, matches OMP conventions. Examples:
```
ENTER activate · ctrl+e edit · ctrl+n new · ESC
Unsaved: S save · y discard · n continue
```

### D7: Line wrapping via `truncateToWidth(replaceTabs(line), width)`

**Decision**: All render() methods wrap each line with `truncateToWidth(replaceTabs(line), width)`.

**Rationale**: Terminal safety. Tabs are unprintable; truncation prevents buffer overflow. Both functions come from `@oh-my-pi/pi-tui`.

### D8: Atomic save: draft is done(draft) from ProfileEditor, not from command layer

**Decision**: ProfileEditorComponent's render and key dispatch accumulate draft changes. On save (`S` key), component calls `done(updatedProfile)`. Command layer (`commands.ts`) receives the draft and handles `patchConfigFile + reloadConfig + notify`.

**Rationale**: Clean separation: component owns state machine and UI; command layer owns persistence. If persistence fails, command layer can show error; component is already closed. No circular dependencies.

## Risks / Trade-offs

| Risk | Likelihood | Mitigation |
|---|---|---|
| `ctx.ui.custom()` unavailable in non-interactive mode | Low | Guard with `if (!ctx.hasUI)` before launching TUI; fall back to text behavior |
| Custom components more complex than reusing OMP components | Medium | Well-specified in `docs/PROFILE_TUI_DESIGN_v2.md`; strict testing; patterns re-used across all 4 components |
| Fallback ordering Map breaks if user edits config manually | Low | Config is always user-editable; router gracefully handles any fallback order at runtime |
| Dirty-state confirmation adds friction for quick edits | Low | Esc is not the save key; users expect confirmation when canceling |
| 80-column layout too tight on narrow terminals | Low | 60-column narrow-mode layout provided; mobile/SSH users can truncate model names and hint lines |
| Submenu delegation (ProfileEditor → ModelPicker) complicates testing | Medium | Each component is independently testable with mock factory + done callback |

## Implementation Checklist

- [ ] All 4 components implement Component interface with (tui, theme, keybindings, done) factory signature
- [ ] All render() methods apply truncateToWidth(replaceTabs(...), width)
- [ ] All handleInput() methods follow key dispatch order specified in PROFILE_TUI_DESIGN_v2.md
- [ ] All components guarantee done(value) called exactly once; no exit path bypasses done()
- [ ] ProfileEditorComponent dirty_confirm state machine tested
- [ ] FallbackPickerComponent ordering Map re-compaction tested
- [ ] ModelPicker and FallbackPicker badge placement tested
- [ ] Hint line format consistent across all screens (` · ` separator, uppercase modifiers, ESC last)
- [ ] Edge states handled (no profiles, no matches, single profile, missing fallbacks)
- [ ] Theme uses getSelectListTheme() (no custom theme); accent/muted/default/warning colors correct
- [ ] Command integration guards ctx.hasUI before launching TUI
- [ ] `bun test` passes all 334+ tests
- [ ] Manual TUI smoke tests: create/edit/rename/delete/activate profiles
