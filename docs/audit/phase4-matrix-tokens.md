# Phase 4 gate review — config-matrix / OpenPencil / tokens doc / gallery XSS / hash sync

Read-only independent gate, 2026-09-14. Scope: exactly five checks. Initial verdict: **PASS WITH FINDINGS** — 1 high, 1 medium, 2 low. All offline suites green on this run; trachtenberg doc claims all true; no XSS.

## Fix re-verification (round 2, 2026-09-14)

**Final verdict: PASS** — P4-1/P4-2/P4-3 fixes confirmed in code AND empirically; P4-4 (low) remains open by agreement, may ride next touch of config-matrix.js.

| id | fix claim | verified |
|---|---|---|
| P4-1 | per-kind flags | **closed** — `parseDisplaySetting` emits `sizeOverridden`/`densityOverridden` (config-matrix.js:35,41-50); `restoreConfig` branches size on `snapshot.sizeOverridden` (111), density on `snapshot.densityOverridden` (117); `runMatrix` snapshot is plain `{...before}`, no re-derivation (143-144). Regression assert in `test/config-matrix.mjs:39-41` proves merge keeps both flags (size overridden + physical density). |
| P4-2 | launch instead of bare spawn | **closed** — `runCli` = `DeviceBuild.launch(resolveExecutable(CLI) ?? CLI, args, …)` (openpencil.js:37); `launch` routes .cmd/.bat through `cmd.exe /d /s /c` with per-token quoting + `windowsVerbatimArguments`, plain spawn elsewhere (device-build.js:53-67). |
| P4-3 | lstat walk + realpath resolution | **closed** — confinePath `mustExist:false` loop lstatSyncs each missing-prefix component; symlink/junction resolved via `realpathSync`, broken link → refused (openpencil.js:70-87). Empirical probe (temp, junctions created + cleaned): broken-junction → REJECTED "(broken link)" (was ACCEPTED in round 1); live-junction escape → REJECTED; plain new dir → ACCEPTED; mustExist junction → REJECTED. |

Re-runs: `node --check lib\config-matrix.js` + `lib\openpencil.js` clean; `test/config-matrix.mjs` **12 passed**; `test/openpencil.mjs` **7 passed**; `test/selfcheck.mjs` **7 passed**. Mounted copy `~/.dsh/profiles/web/node_modules/dsh-mobilecode/lib` hash-matches workspace for `config-matrix.js`, `openpencil.js`, `index.js` (SHA256).

## Check 1 — config matrix (`lib/config-matrix.js`, `test/config-matrix.mjs`)

`node test/config-matrix.mjs` → **12 passed** (offline; imports mounted copy — hash-synced, see check 5).

| Claim | Verdict | Evidence |
|---|---|---|
| physical refusal BEFORE any adb mutation | **pass** | `runMatrix` first statement = `isEmulatorSerial` → `blocked` (config-matrix.js:133-135), before `readConfig`/any `wm`/`settings put`. Route order: refGuard→POST→body→`validateMatrixBody`→dedupe→`runMatrix` (index.js:1035-1044); tool path shares `validateMatrixBody` (index.js:3336). Offline test "run: physical device → blocked, NOT executed" green. |
| requested-vs-actual readback, no trust | **pass** | `setVerified` reads back after every apply, 3 bounded retries (config-matrix.js:66-75); each captured case re-reads `readConfig` and reports `requested` + `actual` separately (152-157); unverified settings → `needs_review` with `actual` (149). |
| adbRun argv arrays only | **pass** | every `DeviceBuild.adbRun(serial, [...])` call is an array; `adbRun` = `["-s", serial, ...args]` → direct spawn, no shell string (device-build.js:825-827); win32 cmd.exe branch only for .cmd/.bat shims, adb.exe unaffected. Mutated values are validated ints/number ranges (index.js:1105-1113). |
| restoreConfig REAPPLIES pre-existing overrides | **FAIL — finding P4-1** | branch exists (config-matrix.js:108-109/114-115) but the SIZE `overridden` flag is corrupted before it arrives; proven below. |

## Check 2 — OpenPencil (`lib/openpencil.js`, `test/openpencil.mjs`)

`node test/openpencil.mjs` → **7 passed** (binary not installed here; degrade path exercised).

confinePath hand-walk + empirical probe (junctions created in temp, probe deleted after):

| case | result |
|---|---|
| (a) target contains `..` | rejected — `rel.startsWith("..")` after resolve (openpencil.js:73-75). probe: rejected ✓ |
| (b) absolute path outside root | rejected — rel from realRoot escapes. probe: rejected ✓ |
| (c) `mustExist:false` output under a NONEXISTENT dir whose ANCESTOR is a junction outside root | **live junction → rejected** (loop walks to existing ancestor, `realpathSync` resolves it through the reparse point, `rel` catches escape; probe c1 rejected ✓). **Broken/dangling junction → ACCEPTED** — gap P4-3: `existsSync` (line 68) follows the reparse point and returns false, so the loop skips past the junction and re-joins its name unresolved; rel passes; write escapes later if the target reappears. |
| (d) plain missing file under new dir | accepted, stays inside root ✓ (correct behavior) |

Other sub-claims: probe-absent never spawns — `importFrame` route checks `OpenPencil.probe().installed` before `exportFrame` (index.js:1076); `design_bridge` tool same gate (3381-3384); status route only probes; no spawn on missing-binary paths. No shell strings — `runCli` = `spawn(resolved, argsArray)`, no `shell` option; but see P4-2 (.cmd shim spawn). CLI shapes vs real contract (openpencil.dev/reference/cli fetched 2026-09-14): `info|pages|variables [file] --json` ✓, `export -f png -s -o [--node --page]` ✓; file positional always passed → RPC mode never entered, matching the code's "no remote/RPC" limitation; node-id shape `1:23` consistent with the `--node` id regex (openpencil.js:99).

## Check 3 — `docs/design/trachtenberg-tokens-inspection.md` spot-check vs app repo

Repo `C:\Users\Administrator\Desktop\trachtenberg_method` @ `core/designsystem/`:

| claim | verdict |
|---|---|
| (a) `darkTheme` param truly ignored ("always dark") | **true** — TrachtenbergTheme.kt:80 declares it; body hardcodes `val colorScheme = EliteDark` (line 97), param read nowhere. |
| (b) EliteDark `onSecondary` 12% tint | **true** — line 24 `onSecondary = Colors.FastGreen.copy(alpha = 0.12f)`; doc's ⚠ review-flag ("fill tint, not foreground") is honest. |
| (c) LocalTouchTarget 48/64, ≥2 components consuming | **true** — 48.dp default (70), 64/48 provided by ageGroup (107); component/ consumers: `Chip.kt:30`, `Buttons.kt:75/141/184/227`, `TrainingComponents.kt:161` (3 files, plus many feature screens). |
| (d) SeniorType ScreenTitle 29/22 ≈1.318 in claimed 1.250–1.333 band | **true** — `SeniorType.ScreenTitle` 29.sp (Typography.kt:196) vs `TrachtenbergType.ScreenTitle` 22.sp (86); 29/22=1.318 ∈ band. Spot-checked this role only. |
| (e) git clean on master | **true** — branch `master`; `git status --short -- app/src/main` empty (0 lines); HEAD 654dbd1 "floor modules row min-height at touch target (48/64dp)" — itself corroborates the doc's "recent commits enforce floors". |

## Check 4 — PreviewGallerySection XSS (`lib/client.js`)

`function PreviewGallerySection` (client.js:490-546): **no XSS**.
- `h` is React `createElement` (client.js:24); every server string (previewName, warnings, failure tails, busy labels) renders as escaped text children.
- File-wide grep: zero `dangerouslySetInnerHTML`/`insertAdjacentHTML`/`outerHTML`/`document.write`; the single `innerHTML` (1537) is the sidebar entry with the static const `ICON` SVG literal (1513) — no external data.
- URLs: directory/class/method every interpolated query param wrapped in `encodeURIComponent` (502, 535); image src is same-origin `API_BASE` only, no `href` from server data.
- Host-rendered disclaimer line present in UI (543-544), matching doc honesty rules.

Suites: `test/preview-gallery.mjs` **21 passed**; `test/selfcheck.mjs` **7 passed**; `test/routes.mjs` **30 passed**.

## Check 5 — hash sync repo ↔ mounted copy

SHA256 repo == `~/.dsh/profiles/web/node_modules/dsh-mobilecode`:
`client.js 604DC9B2…D866FB` match; `config-matrix.js`, `openpencil.js`, `index.js`, `preview-gallery.js`, `device-build.js` all match → the suites above executed exactly the code reviewed here.

## Findings

| id | severity | file:line | problem | requiredFix |
|---|---|---|---|---|
| P4-1 | **high** | lib/config-matrix.js:58-62,140,108 | `readConfig` spreads size- then density-`parseDisplaySetting` results → both carry key `overridden`, density silently wins. `restoreConfig` branches size on `snapshot.overridden` = the DENSITY flag. Pre-existing `wm size` override + physical density → restore runs `wm size reset` → destroys the state the module promises to restore (empirically proven: merged `{overridden:false,widthPx:840,heightPx:1869}` → RESET branch). Mirror case (density override, physical size) re-applies `wm size 1080x2400` → creates an override that didn't exist, and the restore ok-readback (121-124) compares pixel values only → reports `ok:true` despite flag drift. Offline suite never merges the two parses → green while broken; live test only on default state. | `readConfig` return distinct `sizeOverridden`/`densityOverridden` (no key collision); snapshot/restore use the per-dimension flag; restore verification also compares override-state, not just values; add offline stub-adb `restoreConfig` tests for both mixed-override cases. |
| P4-2 | **medium** | lib/openpencil.js:36 | `runCli` = bare `spawn(resolveExecutable("openpencil"), args)`. On Windows the adapter's own status hint recommends npm install; npm ships `openpencil.cmd`, PATHEXT resolution returns the `.cmd`, and hardened Node (≥CVE-2024-27980) refuses spawning .bat/.cmd without `shell:true` → child `error` → every call fails with code -1 even when installed: the feature can never work on the documented Windows path. Not reproducible locally (binary absent); reasoning is code-level. | Call `DeviceBuild.launch(CLI, args)` — the repo's existing cross-spawn helper already solves exactly this; delete the raw `resolveExecutable`+`spawn` pair. |
| P4-3 | **low** | lib/openpencil.js:66-71 | confinePath `mustExist:false` ancestor loop uses `existsSync`, which follows reparse points: a BROKEN junction under root reads as "missing", its name re-joins unresolved, rel-check passes (probe: `…/broken/out.png` ACCEPTED). Later materialization of the junction target turns the confined output path into an escape (needs a pre-positioned dangling junction inside the user-declared root — defense-in-depth gap, not directly reachable via CLI args). | Use `lstatSync` existence (reparse points "exist") so the walk stops at the junction and `realpathSync` resolves (→rejected) or fails (→rejected); add a broken-junction case to test/openpencil.mjs. |
| P4-4 | **low** | lib/config-matrix.js:170 | `reports.restore = restore` hangs the structured restore result on an ARRAY; every JSON boundary (route `writeJson`, tool serialization) drops it — HTTP/agent clients see only the `warnings` string, never `actualAfterRestore`/`snapshotWas`. In-process live test keeps it, masking the loss. | `return { …, restore }` as a result-object field; update consumers (client/live test line 119). |

## Tests ran (offline, this review)

`node test/config-matrix.mjs` → 12 passed · `node test/openpencil.mjs` → 7 passed · `node test/preview-gallery.mjs` → 21 passed · `node test/selfcheck.mjs` → 7 passed · `node test/routes.mjs` → 30 passed. Plus read-only probes: confinePath junction walk (temp, cleaned), merged-snapshot flag repro, `git -C trachtenberg_method branch/status/log`, repo↔mount SHA256 comparisons, openpencil.dev/reference/cli fetch (external, data only). No writes to the app repo; no device mutation performed by this review.

Gate recommendation: P4-1 must close before any matrix run is executed against a device that carries user overrides (currently the workbench's own default posture); P4-2 before claiming OpenPencil support on Windows/npm; P4-3/P4-4 may ride the next touch of their files.
