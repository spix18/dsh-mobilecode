# dsh-mobilecode Design Workbench — final consolidated report

Date: 2026-09-14. Every claim below is tagged: **verified** (command run, output
seen), **proposal** (document, not built), **not_run** (deliberate gap), or
**blocked** (needs user input). Tests re-run fresh for this report:
**149/149** across nine suites + live device matrix earlier (14/14 with `--live`).

## 1. What was implemented vs proposed

Implemented (plugin workspace `C:\Users\Administrator\Desktop\mobilecode_dsh`, uncommitted):

| Feature | Delivered | Gate |
|---|---|---|
| A — Reference workspace | `lib/reference-workspace.js`; routes `/refs/{list,import,capture,active,remove,compare,image,diff}`; panel card **Reference compare** (import file, capture screen, side-by-side, opacity overlay, swipe slider, active/remove chips); persisted under `~/.dsh/mobilecode/reference/`; header-only image fences; malformed-meta quarantine; originals verbatim, transforms as metadata | critic **pass** (`docs/audit/phase2-slice.md`) |
| B — Preview gallery | `lib/preview-gallery.js`; `preview_gallery` agent tool; panel card **Preview gallery**; renderer: **official com.android.compose.screenshot 0.0.1-alpha16** chosen by evidence on unchanged toolchain; compose-ai-tools **blocked** (needs AGP 8.13/Gradle 8.13 — setup path documented, not performed) | critic **pass** (`phase3-previews.md`; 2 low findings fixed: taskkill tree-kill, discovery-warning surfacing) |
| C — Tokens | `docs/design/trachtenberg-tokens-inspection.md` — **inspection-only** per your amendment: Compose code stays canonical, guarded writes deferred; unresolved mappings listed, not approximated | critic spot-check **pass** |
| D — OpenPencil | `lib/openpencil.js` narrow adapter + `design_bridge` tool; CLI contract verified from openpencil.dev; **not installed here → honest `not_run`** with setup hint; no Compose-export claim (PNG/JSX/HTML only); path-confined (realpath + junction probe) | critic **pass** (P4-2/P4-3 fixed) |
| E — Visual comparison | `lib/visual-compare.js` wired via `/refs/diff`: regression (any changed pixel → failed) vs design-reference (structure → needs_review) — separate modes, no shared threshold, no quality scores; client downsamples, server refuses encoded input; evidence JSON persisted | 13/13 (`test/reference-diff.mjs`) |
| F — Config matrix | `lib/config-matrix.js` + `config_matrix` tool: 1..8 bounded cases, ACTUAL readback per case, evidence into store, restore-to-found-state incl. pre-existing overrides on success/failure/cancel; physical devices refused | critic **pass** after P4-1 high fix; live run restored 1080x2400@420/fs1 exactly |
| G — Design skill | `~/.dsh/skills/trachtenberg-android-ui-design/SKILL.md` — **verified registered** (appears in live skill catalog) | — |

Proposed, **not implemented** (by design, per your approval boundary):
- Practice-screen production changes → `docs/design/practice-directions.md` (3 IA
  directions + independent critique (5 findings, all folded) + recommendation).
  **Awaiting your visual choice. Production practice screen untouched.**

## 2. Files changed

- Plugin (git): `M lib/index.js lib/client.js README.md`; new `lib/{reference-workspace,visual-compare,preview-gallery,config-matrix,openpencil}.js`; new `test/{reference-workspace,reference-routes,reference-diff,preview-gallery,config-matrix,openpencil}.mjs`; `docs/{OWNERSHIP.md,design/{render-adapter-decision,trachtenberg-tokens-inspection,practice-directions}.md,audit/{phase2-slice,phase3-previews,phase4-matrix-tokens}.md}`. Mounted profile copy hash-verified equal.
- App repo (your existing uncommitted user changes preserved; nothing committed to master): throwaway branch `feat/preview-screenshot-smoke` (fbb8048, 1f96684, 3cc7295) = build config + `screenshotTest` fixtures + 6 rendered PNGs; `app/src/main` diff vs master **empty** (verified twice by critic); new untracked `docs/evidence/practice-baseline/*.png` + `docs/design/practice-directions/README.md`.
- User memory: English-only directive saved cross-project.

## 3. Install / usage (verified on this host)

1. Code lives in the plugin repo; mounted copy synced via `Copy-Item lib\* →
   ~/.dsh/profiles/web/node_modules/dsh-mobilecode\lib\` (hash-checked).
   Server-side changes (new routes/tools) need a **web-GUI restart**; client panel
   changes need only a browser F5.
2. Panel: Devices drawer → **Reference compare**, **Preview gallery** cards.
3. Agent: `preview_gallery`, `config_matrix`, `design_bridge` (all loopback-guarded;
   browser-origin requests additionally fence-guarded).
4. Emulator pilot: AVD `trachtenberg_api35`, `device_run` from the app dir.

## 4. Toolchain & adapter versions (verified)

DSH 0.1.5-rc.1 · plugin 0.11.9 (version bump NOT done — publish/push is outside
approval) · Node 26.5.0 · Java 21 Temurin · app: AGP 8.7.3 / Kotlin 2.1.0 /
Compose BOM 2024.12.01 / M3 1.3.1 / Gradle 8.11.1 / minSdk 26. Renderer pinned
`com.android.compose.screenshot:0.0.1-alpha16` (layoutlib 16.1.0-jdk17).

## 5. Tests run (fresh, this report)

`reference-workspace 27 · reference-routes 17 · reference-diff 13 ·
preview-gallery 21 · config-matrix 12 · openpencil 8 · selfcheck 7 · routes 30 ·
client 14 = 149 passed, 0 failed`. Live proofs: real design-board import +
real device capture persisted across store reloads; Gradle render of app
`DigitText`/button states (host PNGs); matrix 320dp + fontScale-2 with exact
restore. Evidence: store `~/.dsh/mobilecode/reference/` (+`evidence/*.json`),
app `docs/evidence/`, preview refs on the smoke branch.
**Baseline distinction:** app `shots/` corpus predates this work (stale, not used
as baselines); the two 2026-09-14 cockpit captures are current-commit evidence.
App unit/instrumented suites: **not_run** this session (no production code touched).

## 6. Security & regression findings (all closed unless noted)

Loopback+origin fence on mutating routes (meshGuard precedent); CSRF browser-path
403-tested; argv-array subprocesses everywhere (no shell interpolation); image
fences before any decode (server never decodes); realpath+junction path
containment; bounded output/timeout + Windows process-tree kill; per-device
matrix lock + restore; evidence isolation by project key; optional adapters
degrade without breaking plugin load (openpencil absent → not_run verified).
Process finding: one delegated "fix" was a **false completion** — caught by
line-by-line re-read; policy now: delegated fixes re-verified in code.
**Open:** P4-4 noted fixed; low note: broken-junction probe needs dev-mode
junction rights (skips silently where unavailable).

## 7. Remaining limitations / blocked checks

- Host-rendered previews & diff clusters ≠ device behavior; device evidence is
  separate (`device_screen`, matrix captures).
- Existing 14 private `@Preview`s don't render — public `@PreviewTest` wrappers
  in `screenshotTest` are the contract (single-line annotations; multi-line
  shapes surfaced as discovery warnings).
- Design-reference diff runs on client-downsampled frames (rects in downsampled
  space) — recorded limitation, not hidden.
- OpenPencil: not installed (manual import path fully works).
- **Blocked on user:** visual direction choice → then implementation + device
  verification; npm publish / git push / version bump; GUI restart (user action).

## 8. Shortest workflow tomorrow

1. Restart `dsh web` (new server routes).
2. GUI F5 → Devices drawer: set app directory → **Preview gallery** → Render.
3. **Reference compare**: Import your design PNG → Capture screen → overlay/slider → **Diff**.
4. Chat: `config_matrix run` for 320dp/font-scale evidence when needed.
5. Reply with your direction choice (A / B / C / recommended combo) —
   implementation proceeds natively from there.

## 9. Decisions still requiring you

1. **Visual approval** of a practice-screen direction (gate held; nothing shipped to production).
2. Endorse merging the throwaway adapter (build config + screenshotTest) into master, or keep it experimental.
3. Plugin version bump + publish + push (explicitly outside current approval).
4. Optional: install OpenPencil to activate `design_bridge` frame export.
