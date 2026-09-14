# Practice-screen design directions (T8) — three information architectures

Status: PROPOSALS (mockups/direction docs). Not native renders, not approved
designs. Production code untouched. Basis: live captures
(`docs/evidence/practice-baseline/`, store ids 710afc05 idle / 79270bda
feedback-timeout), code inventory of `TrainingScreen.kt` (regions listed in the
appendix), token inspection (`docs/design/trachtenberg-tokens-inspection.md`),
and the 6 host-rendered component references from the preview gallery.

Constraints honored by all three (non-negotiable):
- No changes to arithmetic, scoring, progression, persistence behavior.
- Digit alignment via `tnum` + DigitText; touch targets via `LocalTouchTarget`
  (48/64dp); feedback never color-only; reduced-motion respected
  (`LocalReducedMotion`); senior type is the non-uniform SeniorType mirror.
- All three keep the bottom-anchored keypad within thumb reach on 360dp width.

---

## Direction A — "Focused practice" (dominant arithmetic, minimal distraction)

**Thesis:** during a timed session the only thing that matters is the problem,
the answer, and the clock. Everything else leaves the screen until the session
ends.

- **Problem block grows**: `ProblemXl` moves up, gains the vertical space the
  stats card frees (target: problem occupies the top ~35% of the body).
- **StatsCard is removed mid-session** (COMBO/ACC/AVG move to `ResultsContent`
  only). A single quiet line under the answer shows streak *count* ("×3 streak")
  only when ≥2 — no percentages mid-flight.
- **Timer becomes a hairline progress bar** under the problem (elapsed vs
  target), colored by the existing `timerAccent` bands; the numeric seconds
  stay small in the top bar. At timeout the bar freezes and the existing
  `TIMEOUT // 0 XP` verdict occupies the answer row — no modal.
- **Top bar simplifies**: Exit (left), mode chip (center), Pause (right).
  SKIP and "How to solve" collapse into the pause-affordance row as compact
  icons with contentDescriptions. Note (critique F1): SKIP currently fires
  directly (`viewModel::skip`, TrainingScreen.kt:685/:904) with no confirm —
  this direction does NOT add a confirm step; keeping one-tap skip is the
  status quo.
- **Keypad gets the freed height**: keys grow to fill the body's lower half
  (hit-floor already enforces 48/64dp; this gives ~64-72dp keys at 360dp),
  CHECK keeps its distinct accent column.
- **VerdictSlot becomes the only feedback surface**: verdict icon + text
  ("Correct +12 XP" / "Not quite — 451" / "Timeout"), non-color-only, no
  mid-session stats churn.

Tradeoffs: fastest eyes-on-problem loop; loses in-session self-monitoring
(players who like watching accuracy climb lose that affordance); streak
notification is weaker than a stat row.

## Direction B — "Guided learning" (visible rule, step progression, worked reasoning)

**Thesis:** the cockpit should teach the ×11 rule while drilling it. The rule
and the current step are first-class screen citizens.

- **Rule strip** under the top bar: one line in the persistent-rule style —
  critique F2: `TrachtenbergType.MicroLabel` (9sp) is NOT legible for an
  always-visible line; use `PanelLabel` (10sp adult / 13sp senior) at minimum,
  or introduce a dedicated `RuleStrip` token. Sourced from the same strings
  `techniqueRule()` uses in `TechniqueHelpDialog`.
- **Step prompt row** above the answer: the method's per-step instruction
  ("Step 2: add the neighbor") replaces the bare ANSWER label. Critique F3
  correction: `MultiplierSolver.solveMultiply` ALREADY returns full
  `CalculationStep` lists (carry/per-digit, incl. overflow step) — no engine
  rewrite is needed. The real work is instructional copy mapping over
  variable-length step lists (steps ≠ fixed 2-3); the step index must be
  "step k of n" computed from the list, never a hardcoded "2/3".
- **Worked-reasoning after wrong answers**: the existing
  `CastingOutNinesDisclosure` pattern is promoted from a help-dialog footnote
  into the verdict area — after a wrong answer the cockpit shows the correct
  chain compactly ("41 × 11 → 1, then 4+1 → 451") with a "Show why" expandable
  (reduced-motion aware).
- **Progress = steps, not just questions**: ProgressRow keeps "01/10" but adds
  a per-problem step tick row; timer de-emphasized (seconds remain in top bar,
  target-band coloring removed in this direction — speed is not the lesson).
- **Keypad unchanged** in geometry; a persistent "?" key replaces nothing —
  help stays in the top bar.

Tradeoffs: highest teaching value; densest screen — on 320dp the rule strip +
step row cost vertical space the problem needs (senior mirror must be checked
against the 48/64dp floors); risks cognitive load during timed drills, so this
direction argues for being a *mode* (its natural home is Warmup/Standard, not
Speed drill).

## Direction C — "Progress-oriented practice" (session feedback without competing)

**Thesis:** keep the current cockpit geometry (it works) but make session
progress legible at a glance, with micro-feedback that never steals focus from
the calculation.

- **Session ribbon** replaces the bare "01 / 10": a segmented tick row
  (10 segments; correct = green + check icon, wrong = red + cross, current =
  pulsing outline) above the problem. Color + icon + position = triple-coded.
- **Compact stat strip**: COMBO/ACC/AVG collapse into a single row of small
  StatValue chips directly under the ribbon (current `StatsCard` cells at
  reduced height); no data leaves the screen (unlike A).
- **Micro-feedback inline**: VerdictSlot keeps its slot but gains a one-second
  XP delta chip ("+12") and streak flame at ≥3 — animation via
  `Motion.FastMs`, disabled under reduced motion.
- **Timer**: unchanged bands but rendered as a thin ring around the pause
  button (space-neutral).
- **Keypad**: identical to today (proven layout, recent 48/64dp fixes kept).

Tradeoffs: smallest change from today (lowest implementation risk, easiest
senior-mirror verification); progress ribbon adds one more top-zone element —
at 320dp the ribbon + stat strip + problem must share the vertical budget, and
the direction's value drops for users who never look at stats.

---

## Comparison

| | A Focused | B Guided | C Progress |
|---|---|---|---|
| Cognitive load mid-drill | lowest | highest | medium |
| Teaching value per session | low | highest | low |
| Change from today | large | large | small |
| 320dp risk | low (frees space) | high (adds rows) | medium |
| Senior mirror effort | low (fewer elements) | high (new rows) | medium |
| Feedback richness | minimal | explanatory | ambient |

## Recommendation

**Recommend B as a mode, with A's cockpit as the drilling surface — i.e.
separate the two concerns rather than forcing one layout to serve both.**
Concretely: Standard/Warmup sessions default to B (rule strip + step prompt +
worked reasoning after wrong answers, timer de-emphasized); Speed drill, Flash,
Boss fight keep A (stats off-screen, hairline timer, maximal problem focus).
C's ribbon is worth stealing into both as the session-progress element.

Rationale: the app already branches modes heavily (verified mode list:
WARMUP / STANDARD / SPEED / ENDLESS / FLASH / AUDIO / BOSS —
PracticeSetupScreen.kt:227-233) — the learning flow genuinely differs per
mode, and the strongest critique of B alone is its cognitive load during timed
drills; the strongest critique of A alone is that it teaches nothing. Separating
them matches the existing mode architecture instead of adding a new dimension.

**Mode assignment (critique F4 — all seven modes, no orphans):**
- B (guided): WARMUP, STANDARD, ENDLESS — Endless is B's best home (adaptive
  pacing leaves room for step teaching).
- A (focused): SPEED, FLASH, BOSS — timed/adrenaline surfaces; stats leave the
  screen, hairline timer stays.
- AUDIO: A's layout with a no-digits variant (audioPhrase prompt + keypad);
  the step-prompt row is spoken, not shown (no new screen).
- C's ribbon is stolen into BOTH A and B as the session-progress element.
C alone is not recommended as a direction: it optimizes feedback for players
who are already motivated, which the current screen already half-serves.

**Verdict-copy guard (critique F5):** Direction A's sample verdict text
("Correct +12 XP") is illustrative only — actual verdict copy MUST come from
the existing scoring-adjacent strings (FAST/SLOW XP bands, TrainingScreen.kt
:1270-1276) unchanged; directions may reposition the verdict surface but never
reword score semantics. Similarly, FLASH/AUDIO modes keep their existing
SKIP/help behaviors (:883-895) — A's top-bar simplification applies only where
those affordances actually exist.

This recommendation is a design judgment, not a verified finding — it is
exactly the decision that needs your visual approval before any production
implementation.

---

## Appendix — current cockpit region inventory (TrainingScreen.kt, master)

- `CockpitTopBar` (:824) — Exit / mode / How-to-solve / SKIP / Pause
- `ProgressRow` (:937) — "01 / 10"
- `ProblemBlock` (:988) — hero problem + timer block (`timerAccent` :1091)
- `AnswerBlock` (:1102) — ANSWER label, `BoardDigitSlot` (:1168) slots,
  `VerdictSlot` (:1215, `cockpitVerdict` :1260)
- `StatsCard` (:1290) — COMBO / ACC / AVG cells
- `CockpitKeypad` (:1385) + `CockpitKey` (:1501) — 3×4 digits/Del/CHECK
- `ResultsContent` (:1616) — session completion
- `TechniqueHelpDialog` (:2117, `techniqueRule` :2175) — rule explanation
- `CastingOutNinesDisclosure` (:2225) — sanity-check disclosure
- States observed at runtime: idle, entered-digits, TIMEOUT verdict
  ("TIMEOUT // 0 XP"), plus code branches for correct/wrong/paused/finished.
