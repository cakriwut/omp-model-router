## Context

The router currently uses a flat `pinnedTierByProfile: Record<string, RouterTier>` on the shared `RouterState` object. This map is persisted to `~/.omp/agent/model-router/router-state.json` and restored on session start. The heuristic's Rule J ("kept planning-phase bias") creates an infinite feedback loop because `previousDecision.phase === "planning"` + no tool results + not a lookup = stays high forever.

The fix is architectural: replace the global persistent pin with a session-scoped, time-bounded pin that decays to a config-defined floor.

## Goals / Non-Goals

**Goals:**
- Pins are session-scoped (per `SessionScope`) and memory-only
- All pins decay after a configurable timeout (default 10 minutes)
- Decay returns to `config.defaultPin` (the "floor")
- User commands have priority P1 (can override any pin, reset timer)
- System sources (heuristic, classifier, rules) have priority P2 (can only set pin when none active)
- `/router pin auto` immediately clears pin + previousDecision (manual decay)
- Pin expiry also clears `previousDecision` to prevent Rule J re-trigger

**Non-Goals:**
- Removing Rule J from the heuristic entirely (it still runs, just can't self-perpetuate)
- Per-tier timeout values (single timeout for all pins)
- Partial decay (e.g., high→medium→low over time) — it's binary: active or decayed
- Changing how `thinkingByProfile` works (separate concern)

## Decisions

### 1. Pin lives on SessionScope, not RouterState

**Decision:** Add `scopedPin?: ScopedPin` to `SessionScope`.

**Rationale:** Session scoping prevents cross-contamination between parent and sub-agent sessions. Each agent gets its own pin lifecycle. The existing `SessionScope` already carries `lastDecision`, cost metrics, and other per-session state — pin belongs here.

**Alternative considered:** Keep on RouterState but add session filtering. Rejected because it adds complexity without real benefit, and the scope isolation pattern is already established.

### 2. Priority model: P1 (user) > P2 (system)

**Decision:** Two priority levels. User actions (`/router pin`, `/router fix`) always override and reset timer. System actions (heuristic Rule J, classifier, rule match, auto-upgrade) can only create a pin when `scopedPin` is absent or expired.

**Rationale:** Users should always have immediate control. System decisions should respect existing pins to prevent flapping (e.g., classifier overriding a user pin mid-session).

**Alternative considered:** Three levels (user > classifier > heuristic). Rejected as over-engineered — two levels cover all observed problems.

### 3. Clean break on decay (Option X2)

**Decision:** When a pin expires, clear both `scopedPin` AND `scope.lastDecision`.

**Rationale:** If only the pin is cleared but `lastDecision.phase` remains `"planning"`, Rule J fires immediately and sets a new pin — creating an oscillation pattern (10min high → 1 turn fresh → 10min high). Clearing `lastDecision` ensures the heuristic runs with no memory of the planning phase, giving a true fresh start.

**Alternative considered:** Only clear pin, let heuristic re-evaluate (Option X1). Rejected because it creates predictable oscillation that's confusing to users.

### 4. System pin creation: only when no active pin

**Decision:** When the heuristic produces a "sticky" result (Rule J fires, classifier overrides, rule matches), it checks if `scopedPin` is active. If yes, the system decision is recorded as `lastDecision` but does NOT update the pin. If no active pin, it creates one.

**Rationale:** This prevents system decisions from extending or changing pins set by the user or by earlier system decisions. The pin represents "hold this tier" and only decays via timeout or user override.

### 5. Config fields: `defaultPin` and `pinTimeout`

**Decision:**
- `defaultPin?: RouterTier | "auto"` — default `"auto"` (no pin, heuristic free)
- `pinTimeout?: number` — milliseconds, default `600_000` (10 minutes)

**Rationale:** `defaultPin` allows users who always want a specific tier to set it as permanent floor (e.g., `"high"` for power users). `pinTimeout` is tunable for different workflows (short sessions may want 5min, long sessions 15min).

### 6. What creates a system pin (P2)

**Decision:** These heuristic outcomes set a scoped pin:
- Rule J (sticky planning bias)
- Classifier override (adaptive mode)
- Custom rule match
- Auto-upgrade (tool failures)

These do NOT set a pin:
- Normal heuristic results (medium from implementation keywords, low from lookup)
- Budget downgrade
- Context capacity promotion

**Rationale:** A pin means "hold this tier across turns." Normal routing decisions are per-turn and should be re-evaluated each turn. Only "sticky" decisions that represent a multi-turn intent should create pins.

### 7. Remove persistence entirely

**Decision:** Do not persist pins to disk. Do not restore pins from session entries. Fresh session = config floor.

**Rationale:** The entire problem stems from pins surviving beyond their useful lifetime. Session-scoped + memory-only = pins naturally die with the session. The config `defaultPin` field provides the persistent baseline if needed.

## Risks / Trade-offs

- **[Risk] Users who relied on persistent pins will notice behavior change** → Mitigation: `defaultPin` in config provides equivalent functionality for "I always want high." Document in changelog.
- **[Risk] 10-minute default may be too short for long planning sessions** → Mitigation: Configurable via `pinTimeout`. Users can set higher values. Rule J will re-create the pin after decay if the conversation is still genuinely planning-oriented (but with a fresh `lastDecision`, it requires actual planning keywords to trigger).
- **[Risk] System pin never fires if user pin is always active** → Acceptable: user intent takes priority. After decay, system can set pins again.
- **[Trade-off] Clearing `lastDecision` on decay loses routing history for that session** → Acceptable: `debugHistory` still retains the log. Only the "previous decision" input to heuristic is cleared.
- **[Trade-off] Auto-upgrade (tool failures) might be overridden by user pin** → Acceptable: user explicitly chose a tier, they accept the consequence. Auto-upgrade will fire again after decay if failures persist.
