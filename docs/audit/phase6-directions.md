# Phase 6 audit — practice-directions.md (independent design critic)

Reviewed: `docs/design/practice-directions.md` against TrainingScreen.kt (2283 lines),
DesignTokens.kt, Typography.kt, PracticeSetupScreen.kt, PracticeViewModel.kt,
MultiplierSolver.kt, ProblemGenerator.kt. All appendix line refs verified correct
(CockpitTopBar :824 … CastingOutNinesDisclosure :2225 — every anchor matches).

## Findings

**F1 · HIGH — Direction A's "SKIP keeps its confirm step" is false (doc :36).**
There is no confirm step today: `onSkip = viewModel::skip` is wired straight to the
top-bar SKIP slot (TrainingScreen.kt :685, :904). Only session **exit** confirms
(`showExitConfirm`, :359–:383, :447). Direction A must either state that skip
confirmation is *new behavior to add* (a scoring/persistence-adjacent UX change the
doc's constraints say are frozen) or drop the claim.

**F2 · MEDIUM — Direction B's rule strip prescribes a 9sp persistent read (doc :54).**
`TrachtenbergType.MicroLabel` is 9sp (Typography.kt :68–70). An always-visible rule
line at 9sp is below comfortable reading size for the exact Warmup/Standard
audience B targets; SeniorType.MicroLabel (12sp, :180) is the senior-mirror pass but
the doc names the base token. Recommend `PanelLabel`/`Body` (13sp) or an explicit
new token; flag as legibility defect before approval.

**F3 · MEDIUM — B's engine hedge is stale; the premise "engine may only yield the
final answer" is wrong (doc :58–:61).** `MultiplierSolver.solveMultiply` already
returns `VerifiedSolution` with a full `CalculationStep` list (stepNumber, carry
in/out, per-digit position — MultiplierSolver.kt :23, :33, :57, :83), and
ProblemGenerator already consumes `solution.steps` (:45). No engine rewrite needed
in either branch — but the doc should say the *real* gap is mapping solver digit
steps to instructional copy ("Step 2: add the neighbor"), which is per-problem
(variable step count incl. overflow step), not the static per-technique string B
proposes. The "2/3" fixed index conflicts with solver reality if ever wired.

**F4 · MEDIUM — Recommendation leaves two of seven modes unassigned (doc :118–:129).**
Mode list verified: WARMUP / STANDARD / SPEED_DRILL / ENDLESS / FLASH / AUDIO /
BOSS (PracticeSetupScreen.kt :227–:233). B-as-mode is assigned to Standard/Warmup,
A to Speed/Flash/Boss; **Endless and Audio have no direction**. Endless is
adaptive/untimed — arguably B's best home; Audio renders no digits (B's rule strip
would need a variant). Resolve before approval.

**F5 · LOW — Direction A's proposed verdict copy erases the FAST/SLOW distinction
(doc :41).** Live verdicts are `FAST // +N XP` and `SLOW // +N XP` (TrainingScreen.kt
:1270–:1276) — different XP bands. A's sample "Correct +12 XP" collapses them; if A
means a copy rewrite, say so explicitly (scoring-adjacent surface) rather than
"existing verdict occupies the answer row".

## Verified-consistent points (no action)

- IA soundness: B-as-mode fits existing architecture — TrainingScreen already
  branches per mode (FLASH/AUDIO custom prompt slots :1028–:1053, challenge prose
  :1006), so a layout variant per mode is additive, not a new dimension.
- Direction A "SKIP/How-to-solve in pause-affordance row" is a no-op: both already
  sit in the top-bar right row (:883–:895). Phrasing implies a move that isn't one.
- Tokens: `Motion.FastMs` (:130), `timerAccent` bands (:1091), tnum everywhere,
  48/64dp LocalTouchTarget floors (:834) — all real; C's ring-around-pause and
  triple-coded ribbon comply with non-color-only + reduced-motion constraints.
- 320dp risk ratings are credible: cockpit top bar is only 32*boardScale dp
  (:838) and ProblemBlock min 56dp (:999); B adds two rows where budget is real.
  One caveat: A's hairline timer bar sits adjacent to ProgressRow's identical
  4dp bar (:954–:968) — two same-weight horizontal bars risk misread; differentiate
  by placement or weight.
- Doc's self-labeling as unapproved proposals (:3, :133) is honest; no
  arithmetic/scoring changes are demanded by any direction once F1/F5 copy claims
  are corrected.

## Verdict

Sound direction doc with verified grounding; block approval on F1 (false claim),
F2 (9sp legibility), F4 (unassigned modes); F3/F5 are doc corrections. The
comparison-table recommendation (B-as-mode + A-for-timed-drills + C's ribbon)
is architecturally consistent with the codebase.
