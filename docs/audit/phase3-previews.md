# Phase 3 (T4 renderer selection + T5 preview gallery) — Independent Security/Design Review

- **Auditor:** independent critic/security reviewer (read-only; no source files edited)
- **Date:** 2026-09-14
- **Scope:**
  - `docs/design/render-adapter-decision.md` (T4 decision, evidence claims)
  - `lib/preview-gallery.js` (discovery, renderState/staleness, buildRenderArgs, renderPreviewTest + liveRenders lock)
  - `/preview/{list,render,image}` routes in `lib/index.js` + `preview_gallery` agent tool
  - `test/preview-gallery.mjs` (19 + optional --live)
  - App repo `C:\Users\Administrator\Desktop\trachtenberg_method` branch `feat/preview-screenshot-smoke` (commits fbb8048, 1f96684, 3cc7295)
- **Audience:** user / implementation team

## Verdict: pass

No open security findings. All audit focus points verified in actual code/evidence. Two **low** follow-ups (one platform limitation that must be reported per the gate's instruction, one discovery-robustness gap) — neither blocks the slice.

---

## Audit focus results

### (a) Command construction — CLEAN
- `buildRenderArgs` (`preview-gallery.js:125-127`) returns an argument array only: `[":<module>:updateDebugScreenshotTest", "--tests", "<fqClass>.<method>", "--console=plain"]`. No shell string anywhere.
- Route (`index.js:979-987`) validates `className` against `/^[A-Za-z0-9_.]+$/` and `method` against `/^[A-Za-z0-9_]+$/` **and** requires an exact match against a **discovered** entry (`discoverPreviewTests` result) before `renderPreviewTest` is called → caller can never inject a fresh string into the Gradle invocation; only source-parsed identifiers (`\w+` class, method from `fun\s+(\w+)`) reach `--tests`.
- Tool (`index.js:3167`) does the same whitelist (`entries.find(e.fqClass === args.class && e.method === args.method)`).
- `renderPreviewTest` → `DeviceBuild.exec(wrapper, args, {cwd}, onLine)` → `launch()` spawns argv directly (POSIX) or via quoted cmd.exe tokens for `.bat` shims (`device-build.js:53-67`, each arg `cmdArg`-quoted). No interpolation.
- Tests prove the boundary: `render rejects non-discovered selector → 400`, `render rejects identifier-shaped method (shell chars) → 400`, `render GET → 405`, `render browser cross-site → 403` (all green in the 19/19 run).

### (b) Timeout/cancellation — report as LIMITATION (low)
- Cap logic is honest and clamped: `Math.min(Math.max(timeoutMs || RENDER_TIMEOUT_MS, 10_000), MAX_RENDER_TIMEOUT_MS)` (10 s..30 min; default 10 min). On timeout: `child.kill()` + exit code 124; status reported `failed`/`timeout`, never passed. Live-render proof shows normal path works (6.6 s, exit 0).
- **LIMITATION (report as instructed):** on Windows the wrapper is `gradlew.bat` → `launch()` runs it via `cmd.exe` (`/d /s /c "<line>"`, `device-build.js:56-64`). `child.kill()` kills the **cmd.exe shim process only** — Windows `kill()` does not terminate the child process tree, so the spawned Gradle/JVM build can keep running after the timeout is reported. Consequences: (1) the reported timeout is the wrapper's death, not proof the build stopped; (2) the `liveRenders` lock is released in `finally`, so a second render can start while the orphaned Gradle build is still writing the same task output → two concurrent `updateDebugScreenshotTest` invocations racing.
- **Required fix (follow-up, low):** kill the process tree on Windows, e.g. spawn the wrapper with `windowsHide` + `taskkill /pid <pid> /T /F` (or use `detached` + tree kill) instead of a bare `child.kill()`. Not a slice blocker.

### (c) Stale labeling — HONEST, verified
- `renderState` (`preview-gallery.js:118-122`): no PNG → `{rendered:false, stale:true}` (never masquerades); PNG present → `stale: found.mtime < entry.sourceMtime` (source-mtime comparison, not wall-clock).
- `/preview/image` (`index.js:1007`) serves `x-preview-stale: true|false` + `x-content-type-options: nosniff` + `cache-control: no-store`. Wire test asserts the header (`image serves fresh PNG with stale header + nosniff`).
- `renderPreviewTest` (`:172-173`): `passed` only when `exitCode === 0 && state.rendered && !state.stale`; a stale-after-successful-exit is labeled `failureKind: "stale-after-render"` and status `failed`. Failed renders never claim current.
- Tool envelope (`index.js:3130-3131`) documents "A stale render is labeled stale; failures never masquerade as current"; tool `list` carries `rendered`/`stale` per entry; render result carries `provenance.stale` + `limitations` "host-rendered (layoutlib) — not device behavior".

### (d) liveRenders lock races — SOUND (one-process), with the (b) caveat
- `liveRenders` is an in-memory `Map` keyed by appDir; check-then-set is synchronous (`:158-161`, no `await` between `has` and `set`), so two concurrent calls in one event-loop tick cannot both pass. First render takes the lock; a second **different-method** render for the same directory gets `{status:"blocked", reason:"another preview render is already running for this directory"}` — one proceeds, one blocked, by design. Different directories render concurrently (separate keys). Lock released in `finally` (`:187-189`).
- Only hole is (b): after a Windows timeout the lock releases while the orphaned Gradle build still runs — the *next* render is not blocked against a build that is no longer tracked by the lock. Covered by the (b) fix.

### (e) Decision doc claims vs verifiable evidence — ALL VERIFIED
| Claim | Verification |
|---|---|
| compose-ai-tools requires Gradle 8.13+, AGP 8.13.0+, Kotlin 2.0.21+ → blocked on AGP 8.7.3/Gradle 8.11.1 | **Confirmed by fetching** https://raw.githubusercontent.com/yschimke/compose-ai-tools/main/README.md: "full requirements (Java 17+, Gradle 8.13+, AGP 8.13.0+, Kotlin 2.0.21+)" — decision doc statement accurate |
| Official plugin `com.android.compose.screenshot` latest = 0.0.1-alpha16, published 2026-07-27 | **Confirmed** via Google Maven maven-metadata.xml (`dl.google.com/dl/android/maven2/com/android/compose/screenshot/com.android.compose.screenshot.gradle.plugin/maven-metadata.xml`): `<latest>0.0.1-alpha16</latest>`, `<lastUpdated>20260727064138</lastUpdated>` |
| Smoke PNG 945x124, 3436 bytes, sha256 4b0ec3b3… | **Confirmed** on the branch file `smokeAppDigits_Smoke App Digits_8aaf38e3_0.png`: IHDR w=945 h=124, size 3436, sha256 `4B0EC3B3ACB2C2C56745BAA9954CE20BFB556DE070524D04CBFFE329BA7B6EB1` |
| Roborazzi/Paparazzi "not pursued (YAGNI)" | Documented deferral with a named fallback path; no evidence obligation. Reasonable. |
| Unchanged toolchain (AGP 8.7.3/Gradle 8.11.1) compiles + renders | **Confirmed live**: `node test/preview-gallery.mjs --live` ran a real `gradlew.bat :app:updateDebugScreenshotTest --tests com.trachtenberg.math.PreviewSmokeTest.smokeAppDigits` → exit 0, status `passed`, `stale:false`, PNG path returned, in 6.6 s. |

### (f) Gallery discovery parser robustness — one LOW gap (silent omission on multi-line annotations)
- Robust for the supported shape: annotations collected line-by-line into `pending`; entry emitted only when a `fun` line follows a `@PreviewTest` **and** a single-line `@Preview(...)` (guard `startsWith("@Preview(")` correctly avoids matching `@PreviewTest`; `widthDp`/`name` regexes parse float/int; `@PreviewTest()` (parens) still matches `startsWith("@PreviewTest")`).
- **Gap (low):** a **multi-line** `@Preview(` (args split across lines) silently drops the entry — the annotation lines are not recognized and `pending` is cleared before the `fun` line, so the method is never discovered, with no warning. Same for annotations on the same line as `fun`. The single-line assumption is noted in a code comment (`preview-gallery.js:66-67`) but **not surfaced to users/agents** (tool description and `list` output don't warn about possibly-missed entries). Decision doc's discovery contract (`:25-29`) documents the annotation/method contract but not the single-line parse limitation.
- **Required fix (follow-up, low):** report a `skipped`/`warned` count (or parse annotation blocks across lines) so a user whose `@PreviewTest` method is silently missing gets a signal. Not a slice blocker — the gallery only ever shows real discovered entries, and the six committed refs all came from single-line fixtures.

### (g) Mounted profile copy = workspace — VERIFIED
- `Get-FileHash` workspace vs `~/.dsh/profiles/web/node_modules/dsh-mobilecode/lib/preview-gallery.js` → **identical**. `lib/index.js` was hash-verified identical in the Phase 2 re-review and unchanged since. Test suites load the mounted copy = exact reviewed code.

### (h) Six rendered refs exist in the branch commit — VERIFIED
- `git ls-tree -r --name-only feat/preview-screenshot-smoke -- app/src/screenshotTest app/src/screenshotTestDebug` shows exactly the two fixture files plus **six** reference PNGs under `app/src/screenshotTestDebug/reference/...` (answerInputState, buttonsStates, digitsStates, progressStatus, smokeAppDigits, smokeDigitRow) — tracked despite gitignore ("force-added" per task).
- **CRITICAL BOUNDARY:** `git diff master..feat/preview-screenshot-smoke --stat -- app/src/main` → **empty, exit 0** — production sources untouched. Full diff touches only `app/build.gradle.kts` (+7: plugin line, `experimentalProperties[...enableScreenshotTest]`, `screenshotTestImplementation` — all marked `// THROWAWAY`), `gradle.properties` (+3: `android.experimental.enableScreenshotTest=true`), and the screenshotTest sources/refs. Commits fbb8048, 1f96684, 3cc7295 present in the branch history.

---

## Loopback/trusted-origin (consistency check)

- `/preview/list` → `guard` (GET, read-only) — consistent with all read-only plugin routes.
- `/preview/render` → `refGuard` (POST, side-effecting: spawns Gradle) — same browser-aware fence as Phase 2 F1: bare loopback clients pass, browser-like requests (Origin/Sec-Fetch-*) must pass the trusted-origin fence; cross-site → 403 (wire-tested).
- `/preview/image` → `guard` (GET, read-only PNG serving; path is server-derived from discovered entries + real directory listing, never a caller string; `nosniff` present).
- No route skips a guard. `/preview/render`'s `directory` accepts any path — same trust model as the plugin's existing `device_run`/`resolveDirectory` (loopback-only, user's own tooling); not a new boundary.

## Checks actually run (exact commands + outcomes)

| Command | Outcome |
|---|---|
| `node test/preview-gallery.mjs` | **19 checks passed**, exit 0 |
| `node test/preview-gallery.mjs --live` | **20 checks passed** (19 + live), live Gradle render `smokeAppDigits` → `status=passed exit=0` in 6.6 s, PNG confirmed, `stale:false` |
| `node test/reference-workspace.mjs` | 27 checks passed, exit 0 (regression) |
| `node test/reference-routes.mjs` | 17 checks passed, exit 0 (regression) |
| `node test/selfcheck.mjs` | 7 checks passed, exit 0 (regression) |
| `node test/routes.mjs` | 30 checks passed, exit 0 (regression) |
| `Get-FileHash lib/preview-gallery.js` workspace vs mounted | identical |
| `git diff master..feat/preview-screenshot-smoke --stat -- app/src/main` | empty, exit 0 — production untouched |
| `git ls-tree -r --name-only feat/preview-screenshot-smoke -- app/src/screenshotTest*` | 2 fixture files + 6 reference PNGs |
| `git log --oneline -5` | 3cc7295 / 1f96684 / fbb8048 present |
| PNG IHDR/size/sha256 of `smokeAppDigits_...8aaf38e3_0.png` | 945x124, 3436 B, sha256 4B0EC3B3… (matches decision doc) |
| web_fetch compose-ai-tools README + Google Maven metadata | requirements Gradle 8.13+/AGP 8.13.0+/Kotlin 2.0.21+ confirmed; latest alpha16, lastUpdated 2026-07-27 confirmed |

## Summary for the user

- **Verdict: pass.** The renderer decision is evidence-backed and every claim checks out (compose-ai-tools blocked on this toolchain confirmed from its own README; alpha16 latest/published-date confirmed from Google Maven; the smoke PNG hash/size/dims confirmed; a live render through the real unchanged-toolchain Gradle build passed).
- Security posture on the plugin side is clean: argument-array-only Gradle invocations behind a discovery whitelist, honest stale/failed labeling with the `x-preview-stale` header, sound single-process render lock, correct loopback/fence guards on all three routes, no shell interpolation, no traversal (paths derived from source-parsed identifiers and real directory listings only).
- App boundary respected: `app/src/main` diff vs master is empty; only throwaway-marked build files + screenshotTest sources/refs on the branch.
- **Two low follow-ups, neither blocking:** (1) Windows timeout kills only the cmd.exe shim, not the Gradle tree — orphaned builds can outlive the reported timeout and race the next render; switch to tree-kill (`taskkill /T /F`). (2) Discovery silently drops `@PreviewTest` methods whose `@Preview(...)` spans multiple lines (or shares the `fun` line); surface a warning/count or parse multi-line annotations so users see the miss.
- Provenance limitations are honestly labeled throughout: host-rendered (layoutlib), not device-verified; recorded refs are human-reviewable committable baselines.
