# Final consolidated audit — dsh-mobilecode design workbench

Date: 2026-09-14 · Auditor: independent re-verification of `docs/FINAL-REPORT.md` §1–§9 claims.
Method: refute-attempt spot-checks (tests re-run, mounted-copy hashes, route-security read, app-repo git), not full re-read.

## Verdict: **pass** (1 low finding — doc numeric, non-blocking)

## Evidence

1. **Tests (§5)** — ran all 9 suites fresh from repo root; tails: 27+17+13+21+12+8+7+30+14 = **149 passed, 0 failed**, per-suite split exactly as claimed. CONFIRMED.
   tests-ran: session-80704ced-1a45-4e74-a1ea-934a0c82e18e
2. **Mounted copy (§2/§3)** — SHA256 workspace `lib\{index,client,reference-workspace,visual-compare,preview-gallery,config-matrix,openpencil}.js` vs `~\.dsh\profiles\web\node_modules\dsh-mobilecode\lib\`: **7/7 MATCH**. README (edited post-sync) not in mounted list — fine. CONFIRMED.
3. **Security (§6)** — all 8 mutating routes (refs/import, capture, active, remove, diff; preview/render; matrix/run; openpencil/importFrame) call `refGuard` (= `guard()` line 109 + browser-fence) AND `isPost`. Fence 403 cross-site tested in suites; same-origin 201. `preview/render` validates identifier regex + `discoverPreviewTests` whitelist before any spawn; `refs/image`/`preview/image` resolve via id/whitelist records, not caller paths; diff evidence written under server-generated runId inside store root; openpencil path-confined (traversal/abs/junction tests green). `matrix/run`: serial charset checked in route before handler; `runMatrix` refuses non-`emulator-*` serial **before** any adb call (config-matrix.js:136 precedes first readConfig:142). CONFIRMED.
4. **App repo (§2/§7)** — `master..feat/preview-screenshot-smoke` = exactly fbb8048, 1f96684, 3cc7295; `app/src/main` diff **empty**; SKILL.md present (~\.dsh\skills\trachtenberg-android-ui-design\, 4063 B) and live in this session's skill catalog (§1-G "registered" CONFIRMED).
5. **§7 caveat** — "existing 15 private @Preview" → actual count in `app/src/main` = **14**. See finding F-1.

## Findings

- **F-1 · low · doc** — FINAL-REPORT §7 states 15 private `@Preview`; `grep '@Preview\b' app/src/main/**/*.kt` returns 14.
  requiredFix: change "15" to "14" in §7 (or recount against intended corpus). No code impact.

## No refutation found for

149/149 test total, mounted-hash equality, guard+fence coverage, serial-before-adb ordering, empty main diff, branch commit list, skill registration. §8/§9 are user-decision gates, not factual claims — out of scope per instruction.


**Resolution (captain):** F-1 fixed same day — FINAL-REPORT.md §7 and render-adapter-decision.md corrected to 14; audit file otherwise kept as written.
