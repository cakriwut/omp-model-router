## 1. ModelPickerComponent

- [x] 1.1 Create `src/tui/model-picker.ts` — implement `ModelPickerComponent` with factory signature `(tui, theme, keybindings, done) => Component`
- [x] 1.2 Wire TabBar for provider scoping (ALL, AMAZON BEDROCK, ANTHROPIC, OPENAI, GOOGLE); support Tab to cycle and selected scope indicator
- [x] 1.3 Implement fuzzy search via Input component and `fuzzyFilter(allModels, query, (m) => "...")`; apply scope filter on top of fuzzy results
- [x] 1.4 Build SelectList of models formatted as: `"provider/id · Xk ctx · $in/$out per M"` (or `"cost unknown"` when pricing absent)
- [x] 1.5 Badge system: left-aligned 12-char column showing `★ H.primary` (accent+bold) for current tier's model, `↓ H.fb-N` (muted) for fallback #N, blank otherwise
- [x] 1.6 Key dispatch: TabBar (1) → cancel (2) → up/down (3) → enter (4) → search input (5)
- [x] 1.7 Footer shows highlighted model detail: `{name} · {provider} · {ctxWindow}k ctx · ${input}/${output} per M`
- [x] 1.8 Invariant: `done(selectedModelRef)` on enter, `done(undefined)` on cancel; no exit path bypasses `done()`
- [x] 1.9 Render safety: wrap all lines via `truncateToWidth(replaceTabs(line), width)`
- [x] 1.10 Write unit test `test/model-picker.test.ts`: fuzzy filter, scope selection, badge placement, cost formatting, cancel/confirm

## 2. FallbackPickerComponent

- [x] 2.1 Create `src/tui/fallback-picker.ts` — implement `FallbackPickerComponent` with same factory signature
- [x] 2.2 TabBar for provider scoping (same as ModelPicker)
- [x] 2.3 Checkbox rendering: `[N]` (accent+bold) for checked, `[ ]` (muted) for unchecked; left-aligned in fixed column
- [x] 2.4 Ordering model: maintain `Map<modelRef, order>` (1-based). Toggle adds/removes; removal triggers re-compact: `[1,3] → [1,2]`
- [x] 2.5 Primary-model exclusion: filter out the primary model for the current tier; header says `(primary: <short-name>)` NOT `(primary: ..., excluded)`
- [x] 2.6 Key dispatch: TabBar (1) → cancel (2) → up/down (3) → enter (4) → ctrl+a clear (5) → space toggle (6) → search (7)
- [x] 2.7 Footer: `Selected: N fallbacks · short-name-1, short-name-2, …` (or `Selected: (none)` if empty)
- [x] 2.8 Invariant: `done(sortedModelRefs)` on enter, `done(undefined)` on cancel. Empty selection returns empty array, not undefined
- [x] 2.9 Render safety: same line wrapping as ModelPicker
- [x] 2.10 Write unit test `test/fallback-picker.test.ts`: toggle, ordering re-compact, primary exclusion, clear-all, cancel/confirm

## 3. ProfileEditorComponent

- [x] 3.1 Create `src/tui/profile-editor.ts` — implement `ProfileEditorComponent` with factory signature
- [x] 3.2 Layout: 3 tier sections (─── HIGH ───, ─── MEDIUM ───, ─── LOW ───) each with 3 rows: model, thinking, fallbacks
- [x] 3.3 Editable row format: `❯ model [value]` (cursor on selection), `thinking <value>` (static or cycle), `fallbacks N models: …`
- [x] 3.4 Changed field marker: `* model [openai/gpt-4-turbo]` when draft differs from original via `JSON.stringify` comparison
- [x] 3.5 Missing-fallbacks warning footer: if any tier has `fallbacks: undefined | []`, show `⚠ {TIER} has no fallbacks — requests fail without retries`
- [x] 3.6 Implement dirty_confirm state machine: Esc when dirty → hint line `"Unsaved: S save · y discard · n continue"`; y/n/S transition states
- [x] 3.7 Key dispatch (editing state): up/down (1) → enter/space on model/fallbacks opens submenu (2) → space cycles thinking (3) → S saves (4) → Esc checks dirty (5)
- [x] 3.8 Submenu wiring: model → ModelPickerComponent result → `done(modelRef)` → draft.{tier}.model = modelRef
- [x] 3.9 Submenu wiring: fallbacks → FallbackPickerComponent result → `done(modelRefs)` → draft.{tier}.fallbacks = modelRefs
- [x] 3.10 Save handler: `S` key → `done(draft)` in outer component; command caller handles `patchConfigFile + reloadConfig`
- [x] 3.11 Invariant: `done(updatedProfile)` on save, `done(undefined)` on cancel; no exit bypasses done()
- [x] 3.12 Render safety: wrap all lines
- [x] 3.13 Write unit test `test/profile-editor.test.ts`: dirty tracking, state transitions, missing-fallbacks warning, submenu dispatch

## 4. ProfileListComponent

- [x] 4.1 Create `src/tui/profile-list.ts` — implement `ProfileListComponent` with factory signature
- [x] 4.2 Layout: header "Router Profiles [* = active]", search input line `> {query}`, cursor-selected profile `❯ * {name}`, page counter `(N/M)`, footer detail
- [x] 4.3 Fuzzy filter on printable chars; backspace removes from filter. Filter matches against profile name + tier model summaries
- [x] 4.4 Display format per profile: `* auto [H: opus-4-7] [M: sonnet-4-6] [L: haiku-4-5]` (80-col), narrow mode: `[H: opus-4-7] [M: sonnet] [L: hk]` (60-col, truncated)
- [x] 4.5 Active profile marker: `*` in accent color, left of name
- [x] 4.6 Key dispatch: cancel (1) → ctrl+e edit (2) → ctrl+n create (3) → ctrl+d delete (4) → ctrl+r rename (5) → up/down (6) → enter activate (7) → search (8)
- [x] 4.7 Hint line format: `ENTER activate · ctrl+e edit · ctrl+n new · ctrl+d delete · ↑↓ browse · ESC` (or omit ctrl+d if only 1 profile)
- [x] 4.8 Edge states: no profiles → show `(no profiles configured)` + hint `ctrl+n new · ESC close`; no matches → show `(no matches)` + hint `← backspace · …`; single profile → hide ctrl+d, show `ONLY PROFILE — cannot delete` in footer detail
- [x] 4.9 Invariant: `done({ action, profile })` for all actions; `done(undefined)` on cancel
- [x] 4.10 Render safety: wrap all lines
- [x] 4.11 Write unit test `test/profile-list.test.ts`: fuzzy filter, action dispatch, edge states, narrow-mode truncation

## 5. Command Integration

- [x] 5.1 Update `handleProfile` in `src/commands.ts`: when args empty and `ctx.hasUI`, call ProfileListComponent via `ctx.ui.custom()`; on action result, dispatch to handler
- [x] 5.2 Action "activate" → `switchToRouterProfile(profileName)` → notify user
- [x] 5.3 Action "edit" → `ctx.ui.custom(() => new ProfileEditorComponent(...))` → on save, call `patchConfigFile + reloadConfig + notify`
- [x] 5.4 Action "create" → `ctx.ui.input("Profile name")` → new profile from active profile copy → open editor → save as above
- [x] 5.5 Action "rename" → `ctx.ui.input("New name")` → validate uniqueness → `patchConfigFile` with key renamed → reload + notify
- [x] 5.6 Action "delete" → confirm via `ctx.ui.confirm()` (with guard on last profile) → `patchConfigFile` → reload + notify
- [x] 5.7 Non-interactive fallback: when `ctx.hasUI === false` and no args, output existing text notification (preserve legacy behavior)
- [x] 5.8 Update `/router help` text: `"profile [name]  Switch profile or launch interactive profile manager (no args)."`
- [x] 5.9 Update completions for "profile" subcommand to suggest profile names (no action names; actions are UI-only)

## 6. Deletion

- [x] 6.1 Delete `src/tui/checkbox-list.ts` (replaced by FallbackPickerComponent)
- [x] 6.2 Delete `src/tui/searchable-select.ts` if it exists (replaced by ModelPickerComponent)
- [x] 6.3 Delete any old profile-editor scaffolding that is not re-used

## 7. Tests

- [x] 7.1 Run `bun test` and confirm all 334+ tests pass
- [x] 7.2 Manual TUI smoke test in OMP: `/router profile` → browse profiles → edit → save → verify config written
- [x] 7.3 Manual TUI smoke test: create new profile → name conflict error → retry with unique name → edit model/fallbacks → save → list shows new profile
- [x] 7.4 Manual TUI smoke test: rename profile → verify config key renamed → active profile redirects if needed → list updated
- [x] 7.5 Manual TUI smoke test: delete profile → confirm → verify last-profile guard prevents deletion → verify delete removes entry
