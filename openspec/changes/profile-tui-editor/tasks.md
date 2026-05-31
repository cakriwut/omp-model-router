## 1. ModelPickerComponent

- [ ] 1.1 Create `src/tui/model-picker.ts` — implement `ModelPickerComponent` with factory signature `(tui, theme, keybindings, done) => Component`
- [ ] 1.2 Wire TabBar for provider scoping (ALL, AMAZON BEDROCK, ANTHROPIC, OPENAI, GOOGLE); support Tab to cycle and selected scope indicator
- [ ] 1.3 Implement fuzzy search via Input component and `fuzzyFilter(allModels, query, (m) => "...")`; apply scope filter on top of fuzzy results
- [ ] 1.4 Build SelectList of models formatted as: `"provider/id · Xk ctx · $in/$out per M"` (or `"cost unknown"` when pricing absent)
- [ ] 1.5 Badge system: left-aligned 12-char column showing `★ H.primary` (accent+bold) for current tier's model, `↓ H.fb-N` (muted) for fallback #N, blank otherwise
- [ ] 1.6 Key dispatch: TabBar (1) → cancel (2) → up/down (3) → enter (4) → search input (5)
- [ ] 1.7 Footer shows highlighted model detail: `{name} · {provider} · {ctxWindow}k ctx · ${input}/${output} per M`
- [ ] 1.8 Invariant: `done(selectedModelRef)` on enter, `done(undefined)` on cancel; no exit path bypasses `done()`
- [ ] 1.9 Render safety: wrap all lines via `truncateToWidth(replaceTabs(line), width)`
- [ ] 1.10 Write unit test `test/model-picker.test.ts`: fuzzy filter, scope selection, badge placement, cost formatting, cancel/confirm

## 2. FallbackPickerComponent

- [ ] 2.1 Create `src/tui/fallback-picker.ts` — implement `FallbackPickerComponent` with same factory signature
- [ ] 2.2 TabBar for provider scoping (same as ModelPicker)
- [ ] 2.3 Checkbox rendering: `[N]` (accent+bold) for checked, `[ ]` (muted) for unchecked; left-aligned in fixed column
- [ ] 2.4 Ordering model: maintain `Map<modelRef, order>` (1-based). Toggle adds/removes; removal triggers re-compact: `[1,3] → [1,2]`
- [ ] 2.5 Primary-model exclusion: filter out the primary model for the current tier; header says `(primary: <short-name>)` NOT `(primary: ..., excluded)`
- [ ] 2.6 Key dispatch: TabBar (1) → cancel (2) → up/down (3) → enter (4) → ctrl+a clear (5) → space toggle (6) → search (7)
- [ ] 2.7 Footer: `Selected: N fallbacks · short-name-1, short-name-2, …` (or `Selected: (none)` if empty)
- [ ] 2.8 Invariant: `done(sortedModelRefs)` on enter, `done(undefined)` on cancel. Empty selection returns empty array, not undefined
- [ ] 2.9 Render safety: same line wrapping as ModelPicker
- [ ] 2.10 Write unit test `test/fallback-picker.test.ts`: toggle, ordering re-compact, primary exclusion, clear-all, cancel/confirm

## 3. ProfileEditorComponent

- [ ] 3.1 Create `src/tui/profile-editor.ts` — implement `ProfileEditorComponent` with factory signature
- [ ] 3.2 Layout: 3 tier sections (─── HIGH ───, ─── MEDIUM ───, ─── LOW ───) each with 3 rows: model, thinking, fallbacks
- [ ] 3.3 Editable row format: `❯ model [value]` (cursor on selection), `thinking <value>` (static or cycle), `fallbacks N models: …`
- [ ] 3.4 Changed field marker: `* model [openai/gpt-4-turbo]` when draft differs from original via `JSON.stringify` comparison
- [ ] 3.5 Missing-fallbacks warning footer: if any tier has `fallbacks: undefined | []`, show `⚠ {TIER} has no fallbacks — requests fail without retries`
- [ ] 3.6 Implement dirty_confirm state machine: Esc when dirty → hint line `"Unsaved: S save · y discard · n continue"`; y/n/S transition states
- [ ] 3.7 Key dispatch (editing state): up/down (1) → enter/space on model/fallbacks opens submenu (2) → space cycles thinking (3) → S saves (4) → Esc checks dirty (5)
- [ ] 3.8 Submenu wiring: model → ModelPickerComponent result → `done(modelRef)` → draft.{tier}.model = modelRef
- [ ] 3.9 Submenu wiring: fallbacks → FallbackPickerComponent result → `done(modelRefs)` → draft.{tier}.fallbacks = modelRefs
- [ ] 3.10 Save handler: `S` key → `done(draft)` in outer component; command caller handles `patchConfigFile + reloadConfig`
- [ ] 3.11 Invariant: `done(updatedProfile)` on save, `done(undefined)` on cancel; no exit bypasses done()
- [ ] 3.12 Render safety: wrap all lines
- [ ] 3.13 Write unit test `test/profile-editor.test.ts`: dirty tracking, state transitions, missing-fallbacks warning, submenu dispatch

## 4. ProfileListComponent

- [ ] 4.1 Create `src/tui/profile-list.ts` — implement `ProfileListComponent` with factory signature
- [ ] 4.2 Layout: header "Router Profiles [* = active]", search input line `> {query}`, cursor-selected profile `❯ * {name}`, page counter `(N/M)`, footer detail
- [ ] 4.3 Fuzzy filter on printable chars; backspace removes from filter. Filter matches against profile name + tier model summaries
- [ ] 4.4 Display format per profile: `* auto [H: opus-4-7] [M: sonnet-4-6] [L: haiku-4-5]` (80-col), narrow mode: `[H: opus-4-7] [M: sonnet] [L: hk]` (60-col, truncated)
- [ ] 4.5 Active profile marker: `*` in accent color, left of name
- [ ] 4.6 Key dispatch: cancel (1) → ctrl+e edit (2) → ctrl+n create (3) → ctrl+d delete (4) → ctrl+r rename (5) → up/down (6) → enter activate (7) → search (8)
- [ ] 4.7 Hint line format: `ENTER activate · ctrl+e edit · ctrl+n new · ctrl+d delete · ↑↓ browse · ESC` (or omit ctrl+d if only 1 profile)
- [ ] 4.8 Edge states: no profiles → show `(no profiles configured)` + hint `ctrl+n new · ESC close`; no matches → show `(no matches)` + hint `← backspace · …`; single profile → hide ctrl+d, show `ONLY PROFILE — cannot delete` in footer detail
- [ ] 4.9 Invariant: `done({ action, profile })` for all actions; `done(undefined)` on cancel
- [ ] 4.10 Render safety: wrap all lines
- [ ] 4.11 Write unit test `test/profile-list.test.ts`: fuzzy filter, action dispatch, edge states, narrow-mode truncation

## 5. Command Integration

- [ ] 5.1 Update `handleProfile` in `src/commands.ts`: when args empty and `ctx.hasUI`, call ProfileListComponent via `ctx.ui.custom()`; on action result, dispatch to handler
- [ ] 5.2 Action "activate" → `switchToRouterProfile(profileName)` → notify user
- [ ] 5.3 Action "edit" → `ctx.ui.custom(() => new ProfileEditorComponent(...))` → on save, call `patchConfigFile + reloadConfig + notify`
- [ ] 5.4 Action "create" → `ctx.ui.input("Profile name")` → new profile from active profile copy → open editor → save as above
- [ ] 5.5 Action "rename" → `ctx.ui.input("New name")` → validate uniqueness → `patchConfigFile` with key renamed → reload + notify
- [ ] 5.6 Action "delete" → confirm via `ctx.ui.confirm()` (with guard on last profile) → `patchConfigFile` → reload + notify
- [ ] 5.7 Non-interactive fallback: when `ctx.hasUI === false` and no args, output existing text notification (preserve legacy behavior)
- [ ] 5.8 Update `/router help` text: `"profile [name]  Switch profile or launch interactive profile manager (no args)."`
- [ ] 5.9 Update completions for "profile" subcommand to suggest profile names (no action names; actions are UI-only)

## 6. Deletion

- [ ] 6.1 Delete `src/tui/checkbox-list.ts` (replaced by FallbackPickerComponent)
- [ ] 6.2 Delete `src/tui/searchable-select.ts` if it exists (replaced by ModelPickerComponent)
- [ ] 6.3 Delete any old profile-editor scaffolding that is not re-used

## 7. Tests

- [ ] 7.1 Run `bun test` and confirm all 334+ tests pass
- [ ] 7.2 Manual TUI smoke test in OMP: `/router profile` → browse profiles → edit → save → verify config written
- [ ] 7.3 Manual TUI smoke test: create new profile → name conflict error → retry with unique name → edit model/fallbacks → save → list shows new profile
- [ ] 7.4 Manual TUI smoke test: rename profile → verify config key renamed → active profile redirects if needed → list updated
- [ ] 7.5 Manual TUI smoke test: delete profile → confirm → verify last-profile guard prevents deletion → verify delete removes entry
