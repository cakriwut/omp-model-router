# Profile TUI Manual Smoke Test Checklist

**Version**: v0.7.2  
**Date**: 2026-05-31  
**Status**: Ready for testing

## Prerequisites

1. Deploy extension: `bun run deploy:dev`
2. Reload OMP: `/reload`
3. Verify version: `/router` shows v0.7.2

## Test 1: Profile List Screen

**Launch**: `/router profile` (no arguments)

### Expected Layout

```
Router Profiles                                            [* = active]

> 

❯ * auto         [H: opus-4-7]   [M: sonnet-4-6]   [L: haiku-4-5]
    cheap        [H: kimi-k2.5]  [M: gpt-4.1-mini] [L: gpt-4.1-nano]
    deep         [H: opus-4-7]   [M: opus-4-6]     [L: sonnet-4-6]
    hybrid       [H: opus-4-7]   [M: deepseek-v3]  [L: gemini-flash]
    opus-lean    [H: opus-4-7]   [M: sonnet-4-6]   [L: gemini-flash]
    oss          [H: kimi-k2.5]  [M: devstral]     [L: gemini-flash]
  (1/6)

  auto: 3 tiers, 9 fallbacks

  ENTER activate · ctrl+e edit · ctrl+n new · ctrl+d delete · ↑↓ browse · ESC
```

### Checklist

- [ ] Active profile marked with `*` in accent color
- [ ] Cursor `❯` on first profile
- [ ] Search input line `>` visible at top
- [ ] Tier summaries show model short names
- [ ] Footer shows profile detail
- [ ] Hint line matches spec format (` · ` separator)

### Actions to Test

- [ ] **Type characters** → filters list (case-insensitive fuzzy match)
- [ ] **Backspace** → removes from filter
- [ ] **↑/↓** → moves cursor (wraps at edges)
- [ ] **Enter** → activates highlighted profile (shows notification)
- [ ] **Ctrl+E** → opens profile editor for highlighted profile
- [ ] **Ctrl+N** → prompts for new profile name
- [ ] **Ctrl+D** → prompts to select + confirm delete (omitted if only 1 profile)
- [ ] **Ctrl+R** → prompts to select + rename
- [ ] **Esc** → cancels and returns to OMP

### Edge Cases

- [ ] **Filter matches nothing** → shows `(no matches)` + hint `← backspace · …`
- [ ] **Single profile** → hint omits `ctrl+d delete`, footer shows `ONLY PROFILE — cannot delete`

---

## Test 2: Profile Editor Screen

**Launch**: From profile list, press **Ctrl+E** on a profile (e.g., `auto`)

### Expected Layout

```
Editing: auto                                          [S save · ESC cancel]

─── HIGH ───────────────────────────────────────────────────────────────────
❯ model       amazon-bedrock/global.anthropic.claude-opus-4-7
  thinking    medium
  fallbacks   3 models: opus-4-6, kimi-k2.5, sonnet-4-6

─── MEDIUM ─────────────────────────────────────────────────────────────────
  model       amazon-bedrock/global.anthropic.claude-sonnet-4-5
  thinking    medium
  fallbacks   3 models: sonnet-4-6, o4-mini, glm-5

─── LOW ────────────────────────────────────────────────────────────────────
  model       amazon-bedrock/global.anthropic.claude-haiku-4-5
  thinking    low
  fallbacks   3 models: nova-micro, nova-lite, gpt-4.1-nano
  (1/9)

  ENTER/SPACE edit field · S save · ESC cancel
```

### Checklist

- [ ] Three tier headers (HIGH, MEDIUM, LOW) in accent color
- [ ] 9 rows total (3 tiers × 3 fields)
- [ ] Cursor `❯` on first row (high.model)
- [ ] Footer shows row counter `(N/9)`
- [ ] Hint line correct

### Actions to Test

- [ ] **↑/↓** → moves cursor (skips tier headers)
- [ ] **Enter/Space on model row** → opens ModelPickerComponent
- [ ] **Enter/Space on fallbacks row** → opens FallbackPickerComponent
- [ ] **Space on thinking row** → cycles `low → medium → high → low`
- [ ] **S** (uppercase) → saves draft, shows notification, returns to profile list
- [ ] **Esc (clean)** → returns without save
- [ ] **Esc (dirty)** → transitions to dirty_confirm state

### Dirty Confirm State Machine

After editing a field, press **Esc**:

- [ ] Hint line changes to: `Unsaved: S save · y discard · n continue`
- [ ] **S** → saves and exits
- [ ] **y** → discards and exits
- [ ] **n** → returns to editing mode (hint line restored)
- [ ] All other keys ignored

### Changed Field Markers

- [ ] After editing, row shows: `* model [new-value]` (asterisk + brackets)

### Missing Fallbacks Warning

If a tier has no fallbacks:

- [ ] Footer shows: `⚠ {TIER} has no fallbacks — requests fail without retries`
- [ ] Save still permitted

---

## Test 3: Model Picker Submenu

**Launch**: From profile editor, cursor on model row, press **Enter/Space**

### Expected Layout

```
Pick model for HIGH                           (current: claude-opus-4-7)

  ALL · AMAZON BEDROCK · ANTHROPIC · OPENAI · GOOGLE   (tab to cycle)

> opus

★ H.primary ❯ claude-opus-4-7 · 200k · $5/$15
↓ H.fb-1      claude-opus-4-6 · 200k · $5/$15
              claude-opus-4-8 · 200k · $5/$15
              anthropic/claude-opus-4-0 · 200k · $15/$75
  (1/12)

  Claude Opus 4.7 · amazon-bedrock · 200k ctx · $5/$15 per M tokens

  type filter · TAB scope · ↑↓ navigate · ENTER pick · ESC cancel
```

### Checklist

- [ ] TabBar shows provider scopes
- [ ] Search input `>` at top
- [ ] Models formatted: `provider/id · Xk ctx · $in/$out per M`
- [ ] Badge column (12 chars): `★ H.primary` (accent+bold), `↓ H.fb-N` (muted), or blank
- [ ] Footer shows highlighted model detail
- [ ] Hint line correct

### Actions to Test

- [ ] **Type characters** → fuzzy filters models (match provider/id/name)
- [ ] **Backspace** → removes from filter
- [ ] **Tab** → cycles provider scope (ALL → BEDROCK → ANTHROPIC → … → ALL)
- [ ] **↑/↓** → moves cursor
- [ ] **Enter** → selects model, returns to editor (row updated)
- [ ] **Esc** → cancels, returns to editor (no change)

### Provider Scope Filtering

- [ ] Select scope (e.g., **ANTHROPIC**) → list shows only Anthropic models
- [ ] Switch to **ALL** → full list restored

---

## Test 4: Fallback Picker Submenu

**Launch**: From profile editor, cursor on fallbacks row, press **Enter/Space**

### Expected Layout

```
Pick fallbacks for HIGH                    (primary: claude-opus-4-7)

  ALL · AMAZON BEDROCK · ANTHROPIC · OPENAI · GOOGLE   (tab to cycle)

> claude

  [1] claude-opus-4-6 · 200k · $5/$15
❯ [2] claude-sonnet-4-6 · 200k · $3/$15
  [ ] claude-3-5-haiku · 200k · $0.80/$4
  [3] moonshotai/kimi-k2.5 · 128k · cost unknown
  [ ] anthropic/claude-opus-4-0 · 200k · $15/$75
  (2/12)

  Selected: 3 fallbacks · opus-4-6, sonnet-4-6, kimi-k2.5

  type filter · TAB scope · SPACE toggle · ↑↓ navigate · ENTER save · ESC cancel
```

### Checklist

- [ ] Header shows primary model (excluded from list)
- [ ] TabBar shows provider scopes
- [ ] Search input `>` at top
- [ ] Checkboxes: `[N]` (accent+bold) for checked, `[ ]` (muted) for unchecked
- [ ] Checked items show order number (1, 2, 3, …)
- [ ] Footer shows selected count + short names
- [ ] Hint line correct

### Actions to Test

- [ ] **Type characters** → fuzzy filters models
- [ ] **Backspace** → removes from filter
- [ ] **Tab** → cycles provider scope
- [ ] **↑/↓** → moves cursor
- [ ] **Space** → toggles check (adds next order number or removes + re-compacts)
- [ ] **Ctrl+A** → clears all checks
- [ ] **Enter** → confirms selection, returns to editor (row updated)
- [ ] **Esc** → cancels, returns to editor (no change)

### Ordering Test

1. Check models in order: A, B, C → `[1] A`, `[2] B`, `[3] C`
2. Uncheck B → `[1] A`, `[2] C` (re-compacted)
3. Check D → `[1] A`, `[2] C`, `[3] D`

### Primary Exclusion

- [ ] Primary model (e.g., `claude-opus-4-7` for HIGH tier) is NOT in the list

---

## Test 5: Create Profile Flow

**Launch**: From profile list, press **Ctrl+N**

### Expected Flow

1. Input dialog: `Enter new profile name:`
   - [ ] Enter unique name (e.g., `test-profile`) → opens editor pre-filled with active profile copy
   - [ ] Press Esc or enter empty name → cancels
2. Profile editor opens with name `test-profile`
   - [ ] All fields match active profile
3. Edit fields, press **S** → saves
4. Profile list now shows `test-profile`

### Name Conflict Test

1. Press **Ctrl+N**
2. Enter existing profile name (e.g., `auto`)
3. [ ] Error notification: `Profile "auto" already exists.`
4. [ ] Returns to profile list (no editor opened)

---

## Test 6: Rename Profile Flow

**Launch**: From profile list, press **Ctrl+R**

### Expected Flow

1. Select profile dialog: `Select profile to rename:`
   - [ ] Shows all profile names
   - [ ] Select one (e.g., `test-profile`) → input dialog
2. Input dialog: `Enter new name:` (pre-filled with current name)
   - [ ] Enter new name (e.g., `test-renamed`) → renames
   - [ ] Esc or empty → cancels
3. Notification: `Renamed "test-profile" to "test-renamed".`
4. Profile list updated

### Name Conflict Test

1. Rename to existing name (e.g., `auto`)
2. [ ] Error notification: `Profile "auto" already exists.`

---

## Test 7: Delete Profile Flow

**Launch**: From profile list, press **Ctrl+D** (if more than 1 profile)

### Expected Flow

1. Select profile dialog: `Select profile to delete:`
   - [ ] Shows all profile names
   - [ ] Select one (e.g., `test-renamed`) → confirm dialog
2. Confirm dialog: `Delete profile "test-renamed"?`
   - [ ] Confirm → deletes
   - [ ] Cancel → returns to list
3. Notification: `Deleted profile "test-renamed".`
4. Profile list updated

### Last Profile Guard

1. Delete all profiles except one
2. [ ] **Ctrl+D** is omitted from hint line
3. [ ] Pressing Ctrl+D silently ignored
4. [ ] Footer shows: `ONLY PROFILE — cannot delete`

---

## Test 8: Profile Activation

**Launch**: From profile list, highlight a profile, press **Enter**

### Expected Flow

1. [ ] Notification: `Switched to router profile: {profile-name}`
2. [ ] Returns to OMP (not to profile list)
3. [ ] `/router status` shows new active profile

---

## Test 9: Non-Interactive Fallback

**Test in non-interactive mode** (e.g., RPC, print mode):

1. Run `/router profile` with no args
2. [ ] Shows text notification: `Current profile: auto. Available: auto, cheap, deep, hybrid, opus-lean, oss`
3. [ ] No TUI launched

---

## Test 10: Narrow Mode (60-column terminal)

**Test in terminal with width < 80 columns**:

### Profile List (narrow)

```
Profiles                             [* = active]

> 

❯ * auto    [H: opus-4-7] [M: sonnet] [L: hk]
    cheap   [H: kimi-k2…] [M: gpt-m…] [L: ..]
    deep    [H: opus-4-7] [M: opus-46] [L: ..]
  (1/6)

  auto: 3 tiers, 9 fallbacks

  ENTER · ctrl+e edit · ctrl+n new · ESC
```

### Checklist

- [ ] Title shortened to `Profiles`
- [ ] Model names abbreviated (8 chars max + `…`)
- [ ] Hint line drops `ctrl+d delete`, `ctrl+r rename`, `↑↓ browse`

---

## Regression Checks

After all manual tests:

1. [ ] Run `/router status` → shows correct state
2. [ ] Run `/router usage` → displays correctly
3. [ ] Run `bun test` → all 363 tests pass
4. [ ] Check `~/.omp/agent/model-router.json` → profile changes persisted correctly

---

## Known Limitations (Expected Behavior)

- TypeScript errors about private fields (`TS18028`) are environment-wide (tsconfig target), not logic errors
- Models without cost data show `cost unknown` (correct)
- Router virtual provider models (`router/*`) are excluded from pickers (correct)

---

## Sign-Off

**Tester**: _____________  
**Date**: _____________  
**Result**: ☐ Pass  ☐ Fail (describe issues below)

**Issues Found**:

---

**Notes**:
