> HISTORICAL — reviewed rev-1/rev-2 images; superseded phase6-visuals-rev3.md

# Phase 6 — Independent visual review: practice-screen mockups (A / B / C)

Status: `needs_review` (subjective design judgment; user picks at the visual gate).
Evidence: 6 design mockups, 1080×2400 PNG, read via read_image. Observations are
"what I SEE in the image" only. No pixel measurements, no contrast ratios, no
native renders involved — these are mockups, and checks NOT run are listed at the end.

Same exercise in all six: 41 × 11; user entry 482, correct 451 (step 2: 4+1=5).

---

## Global observations (all six images)

- **Keypad is identical in all six**: 3×4 grid, large keys with wide gaps, red
  filled CHECK bottom-right (thumb corner), backspace bottom-left, 0 middle.
  No per-direction geometry differences.
- **Honesty label — PARTIALLY CLIPPED (all six)**: every footer contains
  "…mockup, NOT a native …" but the string is cut off at both canvas edges
  (left edge loses the "DIRECTI" of "DIRECTION"; right edge ends at "NOT a
  native", the word "render" is off-canvas). Label present, full sentence not
  legible. [MED]
- **Wrong-state verdicts are non-color-only everywhere**: each wrong state
  carries a "✗" glyph plus explicit text. Passes the feedback-not-color-only
  floor. Digit-position mapping differs per direction (see below).
- **Contrast/appearance**: light-gray monospace on near-black, large digits,
  tabular feel (digits sit in fixed slots) — legible to the eye in these
  images. Not measured; `not_run`.
- **Mode coverage gap**: none of the six mockups shows an AUDIO mode affordance.

---

## Q1 — Are A/B/C genuinely different hierarchies (not palette swaps)?

Yes — different screen responsibilities, visibly:

| Direction | 1st glance | 2nd glance | 3rd glance |
|---|---|---|---|
| A (focused practice) | problem "41 × 11" (largest element) | answer slots + keypad | hairline timer + streak chip + "01 / 10" (recessed); lower ~40% of screen empty |
| B (guided learning) | yellow rule strip "×11 RULE: ADD THE NEIGHBOR" + problem | 3-step checklist cards (entry) / red diagnostic box (wrong) | answer slots + keypad (demoted to bottom) |
| C (progress-oriented) | session ribbon (colored segments + ✓✗ labels) competing with problem | stat chips COMBO / ACC / AVG | answer + keypad |

A suppresses everything but input; B gives the upper half to teaching content;
C frames the problem with session state. That is three architectures, not one skin.

---

## Per-direction verdicts

### Direction A — focused practice

Wrong-state learning clarity: **weakest**. A-wrong shows a red "✗ WRONG" banner
with the correct answer 451 (green) and the line "the neighbor step gave 8 —
you added 4+1 wrong", then "NEXT IN 2s". It never displays the user's entered
482 — no digit-by-digit comparison is possible, and the cause line is
self-contradictory as written ("the neighbor step gave 8" — the step gives 5; 8
is what the user typed; compare C-wrong's precise "STEP 2 WAS: 4 + 1 = 5 — you
entered 8").

Findings:
1. [HIGH] A-wrong omits the user's answer 482 entirely (banner shows only 451).
   Learner cannot locate the wrong digit position. Fix: show "your 482 vs 451".
2. [MED] Cause line "the neighbor step gave 8" contradicts the arithmetic it
   cites; rewrite to "step 2 was 4+1=5, you entered 8".
3. [MED] 320dp risk: lowest of the three — stacked regions are just timer line,
   problem, ANSWER + slots, streak chip, keypad; large empty lower half is
   headroom, not collision risk.
4. [LOW] Non-color verdict passes (✗ + text) but with no digit mapping it is
   "marks wrong + shows right answer", not "explains".

Verdict / mode assignment: best fit **SPEED, FLASH, WARMUP, ENDLESS** — fastest
loop, least reading. Unsuitable for STANDARD learning sessions or BOSS (no
teaching, no tension). Not suited to AUDIO.

### Direction B — guided learning

Wrong-state learning clarity: **best**. B-wrong shows "✗ YOUR 482 — WHERE IT
WENT WRONG", a "you 4 8 2" row vs a green "rule 4 5 1" row with a box drawn
around the error digit 5, the line "step 2: neighbor-add 4 + 1 = 5 — the entry
shows 8", plus an expandable "WHY THE NEIGHBOR? TAP TO EXPAND". It explains
where (middle digit) and why (neighbor-add). Missing: explicit digit-position ↔
step mapping (the box on 5 does not name its place / which of the four slots it
occupies), and steps 1/3 values (1, 4) are not tied to slots either.

Findings:
1. [HIGH] B-wrong clears the ANSWER slots (four empty boxes) while the
   diagnostic still says "YOUR 482" — narrative and input state disagree, and
   the live keypad + red CHECK invite re-typing into a blanked row. Fix: keep
   482 in the slots during the wrong state.
2. [HIGH] Vertical budget is the tallest of the three (count of stacked
   blocks): rule strip → problem → "STEP 2 OF 3" → large empty gap → 3
   checklist cards → ANSWER → slots → 4-row keypad. At 320dp the checklist
   stack is the likely collision zone with ANSWER; in this 1080×2400 image the
   ANSWER label already sits flush against the step-3 card's bottom edge.
3. [MED] B-entry has a conspicuous empty gap between "STEP 2 OF 3" and the
   checklist (~1/5 of the screen) — checklist floats low; at entry state the
   hierarchy reads gappy top-heavy-then-cramped.
4. [MED] B-entry shows slot 1 "4" with a tiny green ✓ and slot 2 already "8"
   while the active step 2 requires 5 — a learner can misread "8" as endorsed.
   Active-step indication itself is fine (yellow numbered circle vs plain
   circle vs ✓ — shape/number, not color alone).
5. [LOW] Rule strip + step count read well; rule content is constant per
   problem family, so B's 1st glance is stable across a session (good for
   learning, redundant in long runs).

Verdict / mode assignment: best fit **STANDARD** (lesson-adjacent practice) and
**BOSS** (teach-then-test). Too much reading/height for SPEED, FLASH, WARMUP,
ENDLESS. Not suited to AUDIO.

### Direction C — progress-oriented

Wrong-state learning clarity: middle. C-wrong has the best *combined marking*:
banner states both numbers ("✗ 482 — correct 451 · check the neighbor step",
"+0 XP"), the wrong digit's slot (8) is filled red among the kept answer slots,
and a yellow line gives the one-step cause "STEP 2 WAS: 4 + 1 = 5 — you
entered 8", with "NEXT IN 3s · TAP TO CONTINUE NOW". Missing: full worked chain
(steps 1/3, carry/neighbor rationale) — one cause line only; no drill-down.

Findings:
1. [MED] C-entry mock data is internally inconsistent: ribbon shows 3 ✓ + 1 ✗
   (4 answered) while the ACC chip reads 67% (would be 2/3, not 3/4). Visible
   mismatch; fix mock numbers before stakeholder review.
2. [MED] Most simultaneous regions in entry state: ribbon with per-segment
   ✓✗ labels + current-dot, problem, "0.9s", ANSWER + slots, 3 stat chips,
   keypad; wrong state adds the top banner. At 320dp ribbon + chips + banner
   stacking above the keypad is the crowding risk to test (with B the two
   tallest directions).
3. [LOW] Current-position dot (small dot under segment 5) is tiny and faint —
   active-position cue is the weakest mark on the screen; ✓/✗ glyphs on past
   segments are fine (non-color).
4. [LOW] Answer slots retained in wrong state with the bad digit highlighted —
   best digit-position mapping of the three; combine with B's you-vs-rule rows
   for a complete teaching wrong state.

Verdict / mode assignment: best fit **ENDLESS** and **BOSS** (combo/ACC/XP
pressure), viable **STANDARD** default. Ribbon+chips are overhead for SPEED /
FLASH. Not suited to AUDIO.

---

## Recommendation (for the user's visual gate — not a decision)

- If one direction must be picked for all modes: **C** marks wrong digits best
  and keeps A's compactness, but it needs the ACC/ribbon data fix and a 320dp
  check of ribbon+chips+banner.
- **B** is the only true learning surface; consider it as the wrong-answer /
  lesson overlay on top of A or C rather than a full-screen mode.
- Hybrid hint: A's/C's wrong banner + C's red slot highlight + B's
  you-vs-rule comparison row would be the strongest learning wrong state.

## Checks not run

`not_run` — no native/device render comparison, no preview_gallery layoutlib
render, no 320dp config_matrix run, no measured contrast ratios. All statements
above are image observations on 1080×2400 mockups only.
