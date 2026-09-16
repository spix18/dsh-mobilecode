# Phase 6 — Independent visual review: practice-screen mockups (rev-3)

Status: `needs_revision` (partial — parent requested wrap-up; A/B wrong-state checklist not fully applied).
Reviewer: delegated subagent of session-80704ced-1a45-4e74-a1ea-934a0c82e18e. Date 2026-09-14/15.

---

## A. Manifest + hash-bound image review

- `docs/design/mockups/manifest.json` read: revision 3, 11 files, status "DESIGN PROPOSALS … NOT native renders, NOT human-approved regression baselines".
- **SHA-256 verification: PERFORMED. 11/11 MATCH** (`Get-FileHash` vs manifest; read_image-returned hashes agree; byte sizes match too). No manifest drift.
- All 11 PNGs received via read_image and inspected. Detailed composition/contract review below focuses on C/H; A/B received hierarchy + footer inspection only.

### Hierarchy check (A/B/C — not palette swaps)
- A: problem-dominant, everything else recessed (hairline timer/streak), minimal layers.
- B: yellow rule strip + 3-step checklist cards dominate upper half; answer demoted to bottom.
- C: session ribbon (✓✓✗✓ + current dot) + stat-chip row frame the problem.
Three distinct architectures confirmed, consistent with rev-2.

### H hybrid = fourth composition (verified, not "stack everything")
- H-entry: C ribbon on top, stats collapsed to one inline text line ("COMBO 1 · ACC 75% · AVG 1.1s" — micro-stats, not chips), compact comparison row area, fixed keypad. Composition is ribbon + compact rows + restrained stats — **hybrid reads as its own architecture, not A+B+C summed**.

### WRONG-state coherence (C-wrong + H-wrong checked against contract)
- Exactly 3 answer slots (482 = 3 digits) ✓ — slot-count contract held (rev-2's 4-box error corrected).
- Submitted answer PRESERVED (4/8/2 remain visible in slots) ✓.
- All-entered-digits-red = today's behavior ✓; per-place amber box on tens labeled **PROPOSAL** in C-wrong ✓ (manifest perPlaceMarking says the same).
- Banner "✗ WRONG // 0 XP" ✓; digits dimmed ✓; CHECK armed with "CHECK = CONTINUE after manual verdict" note ✓; **no invented auto-advance timing** ✓ (auto-submit ~700 ms inert case only as documented).
- Explanation shows BOTH mismatches — "units 2≠1 · tens 8≠5" — with observed-only wording ("OBSERVED ONLY — no cause inferred"; H-wrong "two mismatches shown · cause not inferred") ✓. "482 vs 451" acknowledgment rows present ✓.
- ⚠️ H-wrong: amber per-place box NOT shown while C-wrong shows it — labeling inconsistency inside the H family; reconcile before approval.

### Data consistency (rev-2 finding)
- C/H ribbon ✓✓✗✓ + COMBO 1 + **ACC 75%** — internally consistent (3/4). **FIXED**.

### Footer "not native render" labels (rev-2: footers clipped)
- C-entry / C-wrong: full label inside canvas ✓.
- H-entry: inside ✓. **H-wrong: right edge clipped ("…scoring unchange…") — NOT fully fixed.**
- A-entry: inside ✓. A-wrong: label not visible at canvas bottom. B-entry: clipped both edges. B-wrong: not visible. (Quick inspection; the 22px guard did not hold on the taller wrong-state frames.)
- NOT-RUN: full-pixel measurement; observations are visual.

### H variants
- H-compact-320dp / H-fontscale-2 / H-audio-entry: received and displayed. At a glance the 320dp scaling keeps the composition coherent (uniformly scaled mockup per manifest note, not a real reflow); fontscale-2 shows enlarged type within frame; audio-entry shows a speaker affordance line. **Formal overlap/crop audit NOT-RUN** — these are mockup scalings, not device configurations; `config_matrix`/device runs remain the only real evidence.

---

## B. Code trail (self-reported claims verified)

1. **lib/index.js `/refs/diff` (BOTH AND zero-diff)** — VERIFIED at lines 945-1007: `native` requires recA AND recB resolved AND a/b frame dims equal stored originals (exact AND chain, :983-985); aspect mismatch without transform → blocked, "never downgraded into passes"; downsampled → cannot pass (via envelope rule). Honest.
2. **lib/visual-compare.js dx/dy** — VERIFIED (full 196 lines): output-space transform contract documented (:88-90), applyAlign + mapRegionToFrame share it, regression zero-diff passes only when comparisonSpace==="native", masks require documented reason.
3. **lib/preview-gallery.js** — VERIFIED (full 309 lines): `inputsFingerprint` walks every module `src/**` + build.gradle(.kts) + settings + gradle.properties + `gradle/libs.versions.toml` (:182-194); `renderPreviewTest` writes manifest on success (:279) AND failure marker on non-pass (:286, "invalidate immediately"); `renderState` precedence never_rendered → unknown (no manifest) → last_run_failed → stale_inputs_changed → fresh_tracked_inputs (:145-164). Claims hold.

---

## C. Tests — executed, tails

- `node test\reference-diff.mjs` → tail: "ok validateMasks rejects missing/blank reason / ok defect frames → regression failed cluster / ok cross-site POST → fence 403 — **22 checks passed**"
- `node test\preview-gallery.mjs` → tail: "…ok image serves PNG nosniff + freshness unknown header … ok image 404 without recorded reference — **27 checks passed**"
- `node test\selfcheck.mjs` → tail: "ok device_detect.execute works / ok device_run.execute('status') works / ok device_run.execute rejects missing platform — **7 checks passed**"

---

## Findings

| id | severity | problem | requiredFix |
|---|---|---|---|
| R3-1 **FIXED-CONFIRMED** (rev-5 recheck, 2026-09-15 — see section below) | medium | H-wrong (and A-wrong/B-wrong/B-entry) honesty footer clipped or missing at canvas edge — rev-2 clipping finding not fixed on tall wrong-state frames | shorten/reflow footer to guaranteed width; re-render affected images |
| R3-2 | medium | per-place amber marking shown on C-wrong as PROPOSAL but absent on H-wrong; H claims to inherit C's best marking — inconsistent within the proposal set | either carry the amber box into H-wrong (labeled PROPOSAL) or state the difference in the manifest |
| R3-3 | low | A/B wrong-state full checklist (slots preserved, dimming, CHECK note) not applied in this pass | complete on next round before visual gate |
| R3-4 | low | 320dp/fontscale/audio images are mockup scalings, not device configs — cannot discharge rev-2's device-scale question | keep open until config_matrix/device runs after approval |

## Verdict: needs_revision

- Mockups are **design proposals only — never native renders, never regression baselines** (manifest status line is correct and honest).
- **H hybrid composition itself is coherent and presentable in principle** (fourth architecture confirmed; contract-correct wrong state on C-wrong), **but NOT ready for user approval as-is**: fix R3-1 footer clipping and R3-2 H/C marking inconsistency first (cheap re-render; no layout rethink needed).
- Code trail: all three self-reported claims VERIFIED. Tests: 22+27+7 all pass.

---

# rev-4 re-check (same reviewer, narrow scope, 2026-09-15)

Manifest revision 4 read; revNote: footers auto-shrink inside canvas (R3-1), H-wrong gains PROPOSED amber box (R3-2).

## Hash — PERFORMED
**11/11 MATCH** `Get-FileHash` vs manifest.json rev-4 (sizes too). No drift.
**File-change forensics**: 8/11 re-rendered (A-entry, B-entry, C-entry, H-entry, H-wrong, H-fontscale-2, H-audio-entry, H-compact-320dp). **A-wrong, B-wrong, C-wrong are byte-identical to rev-3** (b7000c72…, 96015a51…, ee15259f…).

## R3-1 footers — PARTIALLY FIXED / still OPEN on A-wrong + B-wrong
- Verified FIXED in fresh rev-4 images: A-entry, B-entry, C-entry, H-entry, H-wrong — shrunk footer fully inside canvas, "not a native render" text readable, both edges clear.
- **A-wrong / B-wrong: NOT re-rendered** (identical bytes to rev-3, where this review flagged the footer clipped/missing). The "all 11" claim is unsupported for these two — visual state cannot have changed. C-wrong unchanged and already compliant.
- Required: re-render A-wrong + B-wrong with the auto-shrink footer, bump manifest hashes.

## R3-2 H-wrong amber box — FIXED
Fresh H-wrong (b90b50b0…): tens digit 8 carries the amber per-place box matching C-wrong, footer labels it PROPOSED; explanation "482 vs 451 · two mismatches shown · cause not inferred", units 2≠1 and tens 8≠5 both named, observed-only; banner WRONG // 0 XP; slots 4/8/2 preserved red; CHECK = CONTINUE after manual verdict note; no invented auto-advance. Consistent with C-wrong now.

## A/B WRONG checklist (R3-3, previously NOT-RUN) — applied (rev-3 bytes, unchanged)
- A-wrong: 3 underline slots show 4/8/2 preserved ✓; all-entered-digits-red = today ✓ (no amber box — today-faithful); banner "✗ WRONG // 0 XP" ✓; explanation names both mismatches (units 2≠1, tens 8≠5) observed-only ✓; keypad digits dimmed + CHECK armed with CHECK=CONTINUE note ✓; no auto-advance timing invented ✓.
- B-wrong: same contract points ✓; rule-steps panel annotates "step 2: 4+1=5 (not 8)", "1 2" copy-anchor acknowledgment visible ✓; observed-only wording ✓.
- **Only defect in both: footer visibility (R3-1 residual — files unchanged).**

## CHECK-as-CONTINUE usability (explicit answer)
Understandable from images alone? **Partially** — the small footer note "CHECK = CONTINUE (current: it advances after a manual verdict)" is what makes it legible; the CHECK label alone still reads "re-submit" to a first-time viewer, and a 9-pt note is a weak affordance. Recommendation: do NOT rename inside these fidelity mockups — CHECK→NEXT in verdict state is a **separate PROPOSAL decision (usability change), not a fidelity fix**; the current label faithfully depicts shipped behavior. Any usability claim needs a device test, which no mockup provides.

## rev-4 verdict: needs_revision (minimal)
Single blocking residual: A-wrong + B-wrong footer re-render (2 files, mechanical). Everything else passes: hash integrity 11/11, R3-2 fixed, A/B/C/H WRONG contracts hold, H hybrid presentable. After the 2-file re-render + manifest hash bump → **pass, ready for user presentation**. Mockups remain proposals; never regression baselines.

---

# rev-5 recheck (same reviewer, narrow scope, 2026-09-15)

Manifest rev 5 loaded via node; revNote: A/B/C-wrong footers restored (wrongBody template had none) — confirms the R3-1 residual flagged in rev-4 was real and targeted.

## Hash — PERFORMED
`Get-FileHash` vs manifest.json rev-5: **11/11 MATCH**, per-file: A-entry MATCH · A-wrong MATCH · B-entry MATCH · B-wrong MATCH · C-entry MATCH · C-wrong MATCH · H-entry MATCH · H-wrong MATCH · H-fontscale-2 MATCH · H-audio-entry MATCH · H-compact-320dp MATCH. No drift. A/B/C-wrong hashes differ from the rev-4 byte-identical set (d44170cf… / 32da57e2… / 941b16eb…) → the three were genuinely re-rendered.

## Footer status (read_image, all in-canvas single-line strips)
- **A-wrong: OK** — "A · wrong answer · rev-5 · design proposal — not a native render · amber box if shown = PROPOSED, all-red digits = current" fully inside bottom edge.
- **B-wrong: OK** — same pattern, "B · wrong answer · rev-5 …" all three phrases present, in-canvas.
- **C-wrong: OK** — same pattern, "C · wrong answer · rev-5 …", in-canvas; amber tens box visible and covered by the "amber box if shown = PROPOSED" note.
- **H-wrong: OK (spot-read)** — footer "H · hybrid · wrong · rev-5 · additive panel · amber box = PROPOSED · not a native render" still rev-5 after replacement; no content lost (banner, session ribbon, slots with amber tens box, both-mismatch explanation, CHECK note all present).

## Wrong-state contract (A/B/C) — HOLDS
- Exactly 3 underline slots showing 4 8 2, all-red = today's behavior ✓ (C adds the PROPOSED amber tens box, labeled).
- Banner "✗ WRONG // 0 XP" ✓. CHECK armed with "CHECK = CONTINUE (current: it advances after a manual verdict)" note ✓; no invented auto-advance timing ✓.
- Explanation names both mismatches, observed-only: A — "482 vs 451 — TWO digits differ (hundreds matches)" with the tens card explicit ("neighbor 4+1=5 · you entered 8", "units also differ" as second card; 2 vs 1 carried by the header comparison); B — "units: … → 1 (you entered 2)" + "tens: … = 5 (you entered 8)" ✓; C — "units 2≠1 · tens 8≠5 … OBSERVED ONLY — no cause inferred" ✓.

## R3-1 → FIXED-CONFIRMED
The missing-footer residual (A-wrong/B-wrong unchanged in rev-4) is now genuinely fixed: all three wrong frames re-rendered with rev-5 footers inside the canvas.

## rev-5 verdict: **pass**
Hash integrity 11/11, footers restored and honest, A/B/C/H wrong contracts intact. Mockups remain design proposals — never native renders, never regression baselines. R3-2 stays FIXED (rev-4), R3-3 closed by this pass; R3-4 remains open by nature (device/config_matrix evidence after approval, not mockup-dischargeable).
