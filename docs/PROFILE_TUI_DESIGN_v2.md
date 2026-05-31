# Profile Manager TUI — Design Specification v2

> **Status**: Final (post-review)  
> **Blockers resolved**: 4 architect, 1 designer  
> **Should-fix resolved**: 6 architect, 5 designer

---

## Component Contract (all screens)

Every component is created via the correct omp factory:

```ts
ctx.ui.custom<T>((tui, theme, keybindings, done) => {
  return new MyComponent(tui, theme, keybindings, done);
}, { overlay: false });
```

Invariants:
- `done(value)` called **exactly once** on every exit path.
- `render(width)` returns terminal-safe `string[]` — every line wrapped with `truncateToWidth(replaceTabs(line), width)`.
- `handleInput(data: string)` receives raw terminal data. Use `keybindings.matches(data, "tui.select.cancel")` or `matchesKey(data, "ctrl+e")`.
- No `dispose()` needed (no timers/sockets/watchers).
- Guard with `if (!ctx.hasUI) return;` before entering TUI.

Theme: `getSelectListTheme()` from `@oh-my-pi/pi-coding-agent`. No custom theme.

---

## Screen 1: Profile List

**Entry**: `/router profile` (no arguments, `ctx.hasUI === true`)  
**Mount**: Full-replace (no overlay)  
**Return type**: `ProfileListResult | undefined`

```ts
type ProfileListResult =
  | { action: "activate"; profile: string }
  | { action: "edit"; profile: string }
  | { action: "create" }
  | { action: "rename"; profile: string }
  | { action: "delete"; profile: string };
```

### Layout (80 columns)

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

### Layout (60 columns, narrow)

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

### Behavior

| Input | Action |
|-------|--------|
| Printable chars | Fuzzy-filter profile list (updates `>` line) |
| Backspace | Remove from filter |
| `↑`/`↓` | Move `❯` cursor (wraps) |
| `Enter` | Activate highlighted → `done({ action: "activate", profile })` |
| `Ctrl+E` | Edit highlighted → `done({ action: "edit", profile })` |
| `Ctrl+N` | Create new → `done({ action: "create" })` |
| `Ctrl+D` | Delete highlighted → `done({ action: "delete", profile })` |
| `Ctrl+R` | Rename highlighted → `done({ action: "rename", profile })` |
| `Esc` | Cancel → `done(undefined)` |

### Key dispatch order

```ts
handleInput(data: string): void {
  if (keybindings.matches(data, "tui.select.cancel")) { done(undefined); return; }
  if (matchesKey(data, "ctrl+e")) { done({ action: "edit", profile: highlighted() }); return; }
  if (matchesKey(data, "ctrl+n")) { done({ action: "create" }); return; }
  if (matchesKey(data, "ctrl+d")) { done({ action: "delete", profile: highlighted() }); return; }
  if (matchesKey(data, "ctrl+r")) { done({ action: "rename", profile: highlighted() }); return; }
  if (keybindings.matches(data, "tui.select.confirm")) { done({ action: "activate", profile: highlighted() }); return; }
  if (keybindings.matches(data, "tui.select.up")) { moveUp(); return; }
  if (keybindings.matches(data, "tui.select.down")) { moveDown(); return; }
  // Everything else → search input
  this.searchInput.handleInput(data);
  this.filterProfiles(this.searchInput.getValue());
}
```

Why Ctrl combos: `Input.handleInput()` consumes all printable chars. Single-letter `e`/`n`/`d`/`r` would go to the search field. Ctrl combos are NOT printable text — Input ignores them.

### Edge states

**No profiles (first launch):**
```
Router Profiles

> 

  (no profiles configured)

  📖 Create your first profile with ctrl+n

  ctrl+n new · ESC close
```

**Filter matches nothing:**
```
> xyz

  (no matches)

  ← backspace to clear filter

  ENTER activate · ctrl+e edit · ctrl+n new · ESC
```

**Single profile (delete disabled):**
- `Ctrl+D` is silently ignored.
- Footer shows: `auto: ONLY PROFILE — cannot delete`
- Hint line omits `ctrl+d delete`.

---

## Screen 2: Profile Editor

**Entry**: After Screen 1 returns `{ action: "edit", profile }`  
**Mount**: Full-replace  
**Return type**: `RouterProfile | undefined`

### Layout

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

### Changed field indicator

```
* model       [openai/gpt-4-turbo]
```

`*` prefix + brackets on changed value.

### Missing-fallbacks warning

If any tier has `fallbacks: undefined` or `[]`:

```
  fallbacks   (none configured) ⚠

  ⚠ HIGH has no fallbacks — requests fail without retries.
```

Footer shows 1-line warning. Save still permitted.

### Behavior

| Input | Action |
|-------|--------|
| `↑`/`↓` | Move cursor (skip separator rows) |
| `Enter`/`Space` | **model**: open Model Picker. **thinking**: cycle values. **fallbacks**: open Fallback Picker. |
| `S` (uppercase) | Save → `done(draft)` |
| `Esc` | If clean: `done(undefined)`. If dirty: enter `dirty_confirm` state. |

### State machine

```
State: "editing" | "dirty_confirm"

"editing" + Esc (dirty):
  → state = "dirty_confirm"
  → hint line becomes: "Unsaved: S save · y discard · n continue"

"dirty_confirm" + S:
  → done(draft)

"dirty_confirm" + y:
  → done(undefined)

"dirty_confirm" + n:
  → state = "editing"
  → hint line restored

"dirty_confirm" + other:
  → ignored
```

### Draft accumulation

```ts
let draft: RouterProfile = structuredClone(config.profiles[profileName]);

// SettingsList onChange callback:
onChange(id: string, newValue: string): void {
  const [tier, field] = id.split(".") as [RouterTier, "model" | "thinking" | "fallbacks"];
  if (field === "model") draft[tier].model = newValue;
  else if (field === "thinking") draft[tier].thinking = newValue as ThinkingLevel;
  else if (field === "fallbacks") draft[tier].fallbacks = newValue === "(none)" ? undefined : newValue.split(", ");
}
```

`isDirty()` compares `JSON.stringify(draft) !== JSON.stringify(original)`.

---

## Screen 3a: Model Picker (single-select)

**Entry**: SettingsList submenu for `model` field  
**Mount**: SettingsList delegates render/input to this component  
**Return type**: `string | undefined` (model ref)

### Layout

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

### Composition

```ts
class ModelPickerComponent implements Component {
  #tabBar: TabBar;
  #searchInput: Input;
  #selectList: SelectList;
  #allModels: ModelItem[];
  #filteredModels: ModelItem[];
  #scope: string = "all";
  #done: (value: string | undefined) => void;
}
```

### Behavior

| Input | Action |
|-------|--------|
| Printable chars | Fuzzy-filter (`fuzzyFilter` from pi-tui) |
| Backspace | Remove from filter |
| Tab | Cycle provider scope via TabBar |
| `↑`/`↓` | Move list cursor |
| Enter | Pick highlighted → `done(modelRef)` |
| Esc | Cancel → `done(undefined)` |

### Key dispatch order

```ts
handleInput(data: string): void {
  // 1. Tab → TabBar (returns true if consumed)
  if (this.#tabBar.handleInput(data)) return;
  // 2. Cancel
  if (keybindings.matches(data, "tui.select.cancel")) { this.#done(undefined); return; }
  // 3. Navigation
  if (keybindings.matches(data, "tui.select.up")) { this.moveUp(); return; }
  if (keybindings.matches(data, "tui.select.down")) { this.moveDown(); return; }
  // 4. Confirm
  if (keybindings.matches(data, "tui.select.confirm")) { this.#done(this.highlighted().value); return; }
  // 5. Everything else → search input
  this.#searchInput.handleInput(data);
  this.filter(this.#searchInput.getValue());
}
```

### Fuzzy filter

```ts
import { fuzzyFilter } from "@oh-my-pi/pi-tui";

filter(query: string): void {
  const scopeModels = this.#scope === "all"
    ? this.#allModels
    : this.#allModels.filter(m => m.provider === this.#scope);
  this.#filteredModels = query
    ? fuzzyFilter(scopeModels, query, (m) => `${m.provider}/${m.id} ${m.name}`)
    : scopeModels;
  this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#filteredModels.length - 1));
}
```

### Badges

| Badge | Meaning | Theme |
|-------|---------|-------|
| `★ H.primary` | This model is primary for the current tier | `theme.fg("accent")` + bold |
| `↓ H.fb-N` | This model is fallback #N for the current tier | `theme.fg("muted")` |
| (blank) | Not assigned | — |

Badges are left-aligned, before the cursor `❯`, occupying a fixed 12-char column.

### Footer detail

Shows for the highlighted model: `{name} · {provider} · {ctxWindow}k ctx · ${input}/${output} per M tokens`

---

## Screen 3b: Fallback Picker (multi-select)

**Entry**: SettingsList submenu for `fallbacks` field  
**Mount**: Same as 3a  
**Return type**: `string[] | undefined` (ordered model refs)

### Layout

```
Pick fallbacks for HIGH                      (primary: claude-opus-4-7, excluded)

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

### Ordering model (stable)

Fallback order is maintained in a `Map<string, number>`:

```ts
#selected: Map<string, number> = new Map(); // modelRef → order (1-based)

toggle(modelRef: string): void {
  if (this.#selected.has(modelRef)) {
    this.#selected.delete(modelRef);
    // Re-compact: [1,3] → [1,2]
    this.#recompact();
  } else {
    const nextOrder = this.#selected.size + 1;
    this.#selected.set(modelRef, nextOrder);
  }
}

#recompact(): void {
  const entries = [...this.#selected.entries()].sort((a, b) => a[1] - b[1]);
  this.#selected.clear();
  entries.forEach(([ref], i) => this.#selected.set(ref, i + 1));
}

getResult(): string[] {
  return [...this.#selected.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([ref]) => ref);
}
```

This is stable regardless of filter state: filtering hides rows but does not alter the Map.

### Behavior

| Input | Action |
|-------|--------|
| Printable chars | Fuzzy-filter |
| Backspace | Remove from filter |
| Tab | Cycle provider scope |
| `↑`/`↓` | Move cursor |
| Space | Toggle check on highlighted model |
| `Ctrl+A` | Clear all checks |
| Enter | Confirm → `done(getResult())` |
| Esc | Cancel → `done(undefined)` |

### Key dispatch order

```ts
handleInput(data: string): void {
  if (this.#tabBar.handleInput(data)) return;
  if (keybindings.matches(data, "tui.select.cancel")) { this.#done(undefined); return; }
  if (keybindings.matches(data, "tui.select.up")) { this.moveUp(); return; }
  if (keybindings.matches(data, "tui.select.down")) { this.moveDown(); return; }
  if (keybindings.matches(data, "tui.select.confirm")) { this.#done(this.getResult()); return; }
  if (matchesKey(data, "ctrl+a")) { this.#selected.clear(); return; }
  if (data === " ") { this.toggle(this.highlighted().value); return; }
  this.#searchInput.handleInput(data);
  this.filter(this.#searchInput.getValue());
}
```

### Primary exclusion

The primary model for the current tier is filtered out of the candidate list. Header says: `(primary: <model-short-name>, excluded)`.

### Footer

`Selected: N fallbacks · short-name-1, short-name-2, short-name-3`

If no fallbacks selected: `Selected: (none)`

---

## Theme / Color Palette

Conservative 2-color + bold:

| Element | Theme call | Notes |
|---------|------------|-------|
| Active profile `*` | `theme.fg("accent")` | Eye-catching |
| `★ H.primary` badge | `theme.fg("accent")` + bold | Critical state |
| `[N]` checked fallback | `theme.fg("accent")` + bold | Active selection |
| `↓ H.fb-N` badge | `theme.fg("muted")` | Lower priority |
| `[ ]` unchecked | `theme.fg("muted")` | Faded |
| Tier headers `─── HIGH ───` | `theme.fg("accent")` | Section separator |
| Search input `>` | `theme.fg("muted")` | Low visual priority |
| Hint line | `theme.fg("muted")` | Meta, not actionable |
| Footer detail | `theme.fg("muted")` | Informational |
| Warning `⚠` | `theme.fg("warning")` | Alert |
| All other text | `theme.fg("default")` | Standard |

---

## Hint Line Standard

Format: `KEY action · KEY action · … · ESC`

Rules:
- Separator: ` · ` (space dot space), always.
- Key names: UPPERCASE for modifiers (`CTRL+E`, `TAB`, `SPACE`), lowercase for single keys (`e`, `n`), ENTER/ESC always caps.
- Verb order: dominant action first → secondary verbs → navigation → exit last.
- Dirty confirm: `Unsaved: S save · y discard · n continue`

---

## Architecture Diagram

```
handleProfile (commands.ts)
    ├── ctx.ui.custom → ProfileListComponent
    │     └── done(ProfileListResult)
    │
    ├── dispatch on result.action:
    │     ├── "activate" → switchToRouterProfile()
    │     ├── "edit" → ctx.ui.custom → ProfileEditorComponent
    │     │     ├── submenu "model" → ModelPickerComponent
    │     │     ├── submenu "fallbacks" → FallbackPickerComponent
    │     │     └── done(draft | undefined)
    │     │           └── if draft: patchConfigFile + reloadConfig
    │     ├── "create" → ctx.ui.input(name) → openProfileEditor(newProfile)
    │     ├── "rename" → ctx.ui.input(newName) → patchConfigFile
    │     └── "delete" → ctx.ui.confirm → patchConfigFile
```

---

## Implementation Order

| Step | Component | Lines est. | Deps |
|------|-----------|-----------|------|
| 1 | `ModelPickerComponent` | ~150 | `fuzzyFilter`, `Input`, `TabBar`, `SelectList` |
| 2 | `FallbackPickerComponent` | ~180 | Step 1 pattern + `Map` ordering |
| 3 | `ProfileEditorComponent` | ~120 | `SettingsList` + Steps 1,2 as submenus |
| 4 | `ProfileListComponent` | ~130 | `Input`, `SelectList`, `fuzzyFilter` |
| 5 | Command integration | ~80 | Steps 3,4 + existing `handleProfile` |
| 6 | Delete old code | — | `SearchableSelect`, placeholder `CheckboxList`, fabricated types |

---

## Files to create/modify

**New files:**
- `src/tui/model-picker.ts` — ModelPickerComponent
- `src/tui/fallback-picker.ts` — FallbackPickerComponent  
- `src/tui/profile-list.ts` — ProfileListComponent

**Modify:**
- `src/tui/profile-editor.ts` — Rewrite to use correct factory signature + SettingsList submenus
- `src/commands.ts` — Rewrite `handleProfile` dispatch loop

**Delete:**
- `src/tui/searchable-select.ts` — Replaced by ModelPickerComponent
- `src/tui/checkbox-list.ts` — Replaced by FallbackPickerComponent
