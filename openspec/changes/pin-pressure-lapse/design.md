## Context

The scoped pin system locks routing to a tier for up to `pinTimeout` ms (default 10 min). Pins are set by either the user (`/router pin <tier>`) or automatically by the system (heuristic Rule J, LLM classifier, custom rules, auto-upgrade). The wall-clock timeout works well for idle sessions but fails in active, fast-paced conversations where the task direction shifts (e.g. deep architecture → quick rename → summary → back to implementation). In those sessions, a single planning-phase response can pin "high" for 30+ turns, all routed to the expensive tier regardless of what every subsequent heuristic and classifier signal says.

The classifier and heuristic already emit the correct signal every turn — they are simply blocked by the active pin. The fix is to let those signals accumulate as *pressure* and short-circuit the pin when pressure is sustained enough to be unambiguous.

## Goals / Non-Goals

**Goals:**
- Allow system-set pins to lapse early when the heuristic disagrees for N consecutive turns.
- Keep user-set pins fully immune (explicit user intent must not be overridden automatically).
- Zero additional API/LLM calls — pressure signal uses the heuristic only (free regex matching).
- Consecutive requirement: isolated disagreements (one low, one high, one low) do not lapse the pin — only a sustained run does.
- Configurable threshold (`pinPressureThreshold`, default 3); `0` disables pressure lapse entirely.
- Debug log + `/router pin` status display of current pressure count.

**Non-Goals:**
- Pressure lapse for user pins (`source: "user"`).
- Running the LLM classifier as part of the shadow signal (cost + latency).
- Changing the wall-clock timeout mechanism — pressure is a second, independent lapse path.
- Persisting the pressure counter across sessions.

## Decisions

### D1 — Heuristic shadow only (no classifier shadow)

**Decision**: Compute what the heuristic *would have routed* (ignoring the active pin) as the disagreement signal. Do **not** run the LLM classifier in shadow mode.

**Rationale**: The heuristic is O(1) regex matching with no API call. The classifier costs tokens and latency. A sustained 3-turn heuristic disagreement is a strong enough signal — if the heuristic consistently says "low" across three separate user turns, the phase has clearly changed. Classifier shadow would add cost on every pinned turn with no material accuracy benefit given the consecutive-count requirement.

**Alternative considered**: Run classifier in shadow and only lapse on classifier disagreement. Rejected — adds ~$0.001–0.005 per turn overhead, every turn the pin is active.

### D2 — Counter lives on `ScopedPin`, not on `SessionScope`

**Decision**: Add `overridePressureCount: number` directly to the `ScopedPin` struct.

**Rationale**: The pressure is a property of *this specific pin instance*. When a pin is replaced (user re-pins, or a new system pin is set after lapse), the counter resets automatically because a new `ScopedPin` object is created. No explicit reset needed.

**Alternative considered**: Counter on `SessionScope`. Rejected — requires explicit reset on every pin change and is less cohesive.

### D3 — Shadow run in `resolveRouting` (compose.ts), after effective-pin resolution

**Decision**: When `input.pinnedTier` is set and `pin.source !== "user"`, call `decideRouting` a second time with `pinnedTier = undefined` to get the shadow tier. Compare shadow vs pin tier and call `incrementPinPressure` (a new helper in `pin.ts`). If that helper returns `true` (threshold reached), clear the pin, bust the classifier cache, and re-run routing freely for the current turn.

**Rationale**: `compose.ts` already has access to `input.scope`, `input.state`, `config.pinConfig`, and all inputs needed for `decideRouting`. Adding the shadow call there keeps the logic co-located with other pin-management code (context-trigger promotion, classifier gating). `pin.ts` stays focused on pure pin mutation; `compose.ts` orchestrates.

**Alternative considered**: Put pressure logic inside `resolveEffectivePin` in `pin.ts`. Rejected — `resolveEffectivePin` runs before `decideRouting` so the shadow tier isn't available there.

### D4 — Consecutive means strictly back-to-back; any agreement resets to zero

**Decision**: If turn N disagrees and turn N+1 agrees, counter resets to 0. Only unbroken runs count.

**Rationale**: A single "agree" turn is a clear signal the conversation briefly returned to the pinned phase. Resetting prevents stale partial pressure from accumulating across topic hops. An unbroken run of N disagrees is much stronger evidence of a genuine phase shift.

### D5 — Pressure lapse clears `lastDecision` (same as wall-clock expiry)

**Decision**: On pressure lapse, set `scope.scopedPin = undefined` and `scope.lastDecision = undefined` (mirrors `clearScopedPin` and wall-clock expiry).

**Rationale**: `lastDecision` carries phase bias into the heuristic. Clearing it gives the post-lapse turn a clean slate — the heuristic won't re-trigger Rule J immediately just because the previous routed tier was "high".

## Risks / Trade-offs

**[Oscillation risk]** → After pressure lapse, the heuristic runs freely and may immediately produce a "high" result (e.g. user message still looks like planning work). This immediately re-pins high. The next few turns could see repeated lapse-and-repin cycles.  
Mitigation: `lastDecision` is cleared on lapse, so Rule J (planning-phase bias sticky) won't fire immediately. The fresh heuristic run uses only the current message, which is correct. If the message genuinely scores "high", the re-pin is correct.

**[Shadow run cost]** → One extra `decideRouting` call per pinned turn. The heuristic is pure in-memory regex matching — benchmarks show < 0.1 ms. Negligible.

**[Threshold too low]** → `pinPressureThreshold: 3` may be too aggressive for some workflows (a 3-message Q&A detour shouldn't lapse a long architectural pin).  
Mitigation: Threshold is configurable. Users who want stickier pins can set `pinPressureThreshold: 6` or `0` (disable). The default of 3 matches the described use case (3–4 signals = lapse).

**[Classifier cache stale after lapse]** → After pressure lapse, the classifier cache key changes (new free routing run may have different userMsgIndex context). Busting the cache on lapse prevents serving a stale cached verdict from the pinned-phase classifier run.

## Migration Plan

- No breaking changes. `overridePressureCount` is optional on `ScopedPin` (backward compat with persisted state — pins are never persisted, but the type is used in memory).
- `pinPressureThreshold` defaults to `3` in `FALLBACK_CONFIG`; existing configs without it get the default automatically via spread-based `normalizeConfig`.
- Existing behavior unchanged when `pinPressureThreshold: 0` or when pin source is `"user"`.

## Open Questions

*(none — all design decisions resolved in exploration)*
