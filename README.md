# dsh-mobilecode

MobileCode for the dsh web GUI — a hot-pluggable DSH plugin porting
[hsandhu/mobilecode](https://github.com/hsandhu/mobilecode) (the opencode fork
with embedded iOS Simulator / Android Emulator support) into
[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).

It detects the mobile project in a directory (iOS / Android, Expo / React
Native / native), starts the `serve-sim` / `serve-avd` preview servers, builds,
installs and launches the app on the booted simulator or emulator — and exposes
the same to the agent through tools.

## Installation

```bash
dsh plugin --profile web add dsh-mobilecode
```

(For a fresh profile or when the plugin was added while DSH was running, restart
the web GUI — host modules bind at startup and the client bundle is served from
the installed package.)

## Support

If you find this useful, you can support development at [ko-fi.com/spix18](https://ko-fi.com/spix18).

## What the plugin provides

**Device pane (web GUI)** — a sidebar entry ("Devices") opening a right-hand
drawer:

- project directory input (persisted in localStorage) + Detect
- platform pills (iOS / Android) with live server status
- per platform: **Start/Stop server**, **Run app / Stop app**, an embedded
  iframe of the serve-sim / serve-avd stream, build status/step/error and an
  expandable log tail
- a Metro (bundler) status card
- polls `GET /api/dsh-mobilecode` every 2 s while open

**Agent tools**

- `device_run` — action `run` (build+install+launch, then waits with a
  configurable timeout), `stop` (cancel/terminate), or `status`. Platform
  `ios` | `android` | `all`. Returns framework, platforms, per-platform build
  summaries (status, step, target, appID, error, log tail — logs only when
  failed or incomplete), the Metro state, and `complete`.
- `device_detect` — which platforms a directory supports, the framework, and
  the first attached Android device.
- A bundled **`device-ui-automation` playbook skill** (registered through
  `ctx.skills.register()`, defensively — hosts without the skill service just
  skip it): the observe-once → act-with-an-assertion → observe-again workflow,
  which observer to reach for first, how to confirm an action landed via
  `expect_text`/`expect_gone`, and the real-device safety rules.
- `device_screen` — see what is on an attached Android device: a PNG screenshot
  plus the uiautomator UI hierarchy (text + pixel bounds) and **local PaddleOCR**
  text recognition (text + confidence + box), so an agent can read the screen
  and tap by coordinates. Also returns the foreground activity and screen size.
- `device_ui_tree` — the default screen observer: the uiautomator hierarchy as a
  typed node tree (`type`/`text`/`contentDesc`/`resourceId`/`bounds`, with
  `enabled`/`focused`/`clickable`/`scrollable` emitted only in their interesting
  state), case-insensitive `filter` that keeps ancestors of matches, `max_depth`,
  and a 40 KB cap that prunes the deepest levels first. Resource-ids are the most
  stable tap handles.
- `device_tap_element` — tap a control by identity: `resource_id` matches the
  node's resource-id, `text` matches its text or content-desc; exact match wins
  over substring, nested duplicates collapse to the outermost control, ambiguity
  lists up to 8 candidates instead of guessing, and disabled / off-screen nodes
  are refused with the fix. `expect_text` / `expect_gone` verify the tap in the
  same call — one round trip, no separate screenshot.
- `device_wait_for` — wait for text to appear or disappear: polls the UI tree
  every ~600 ms and falls back to local PaddleOCR on textless surfaces (WebView /
  Compose / canvas). A timeout is a normal `matched: false` result, never an
  error — one call replaces an agent-side poll loop.
- `device_input` — act on the device: tap / swipe / type / press a key at
  **absolute pixel coordinates** (the same space `device_screen` returns — take
  the box center `x=(x1+x2)/2, y=(y1+y2)/2`). The deterministic control loop is
  `device_ui_tree → device_tap_element`, falling back to
  `device_screen → device_input` when a surface exposes no accessibility tree.
  Typing is ASCII over plain adb; non-ASCII (CJK, emoji) is routed through the
  ADBKeyboard IME when installed and refused with the install hint otherwise.
- `device_action` — device-level verbs beyond touches: `notifications`,
  `quick_settings`, `collapse`, `lock`, `wake`, `assistant`, `rotate` (cycles
  0→90→180→270 and pins auto-rotate off).
- `device_boot` / `device_shutdown` — boot an AVD by name and wait until it
  finishes booting (adopts a running emulator for the same AVD) / shut an
  emulator down (`adb emu kill`; refuses physical devices).
- `device_apps` / `device_launch_app` — list installed packages (third-party by
  default) so a package name is never guessed / launch one by package or a
  unique substring, with `relaunch` for a cold start.
- `device_stream` — drive the live screen stream the panel shows: `start` an
  online device (returns a signed `streamUrl`), `status`, or `stop`. Agents that
  just need to see the screen should prefer `device_screen` / `device_ui_tree`.

**Live device stream (the panel)**

The Devices pane shows a real-time mirror of the attached device. It is produced
**in-process** — no inner loopback port, no external helper:

- ONE persistent `adb exec-out "while :; do screencap -p; done"` child streams
  ~8 fps with zero per-frame process cost (spawning adb per frame caps at ~5 fps
  and 100% churn). A quote-safe PNG splitter cuts the concatenated output into
  frames by walking chunk headers (no marker scanning, no false positives).
- The browser `<img>` reads a `multipart/x-mixed-replace` body served straight
  from the latest-frame buffer. Backpressure is **latest-wins**: a slow tab skips
  frames instead of building an unbounded queue or watching a growing delay.
- A consumer refcount + idle timeout stops the loop when nobody is watching; a
  keep-alive restarts a crashed loop; switching devices retires the old child.
- **Tap or drag directly on the screen** to drive the device; a Back / Home /
  Recents / Rotate / Power bar sits below it, and a device picker switches which
  online device streams (it never boots one — use `device_boot` for that).
- **Security**: every stream route sits behind a loopback + trusted-browser
  transport fence (peer address, loopback `Host`, `Sec-Fetch-Site` / `Origin` —
  so a LAN client cannot spoof localhost and a DNS-rebinding `Host` is rejected),
  and the stream URL is an **HMAC-SHA256 capability** signed with a per-install
  key (`~/.dsh/mobilecode/stream-access.key`, `0600`), expiring within 10 minutes
  and re-minted automatically. Coordinates are normalized 0..1 of the streamed
  frame, so one mapping serves every rotation.
- `device_log` — device logs: logcat `main`/`crash`/`events`/`kernel` buffers
  (kernel = dmesg, needs adb root — works on emulators) with an optional
  case-insensitive substring filter, capped line count.
- `device_status` — one normalized snapshot: attached devices, configured AVDs,
  emulator binary, and what the plugin currently runs (preview servers, Metro,
  builds per directory).

**First-run experience & settings**

- On first start after installation, a **welcome window** explains how to use the
  plugin, shows a **copy-paste prompt for any AI model** (tells it about
  `device_detect` / `device_run` / `device_screen` / `device_input` /
  `device_log` / `device_status` and the recommended control loop), and offers a
  **one-click PaddleOCR install** — `device_screen` reads on-screen text with
  fully local OCR. The plugin works without it, just without OCR text.
- A **⚙ Settings** button in the Devices pane header opens the settings dialog
  with three tabs:
  - **Doctor** — runs every health check (node, Android SDK, emulator binary,
    AVDs, attached device, PaddleOCR, OCR script) with ✓/✗ + details, and a
    Fix button for auto-fixable checks (PaddleOCR install).
  - **PaddleOCR** — install status, progress log, and the install button.
  - **AI Prompt** — the copyable agent prompt.
- The same settings appear as a **`MobileCode` page in the DSH Settings**
  (registered as a `settings.section` slot, like the other installed plugins),
  so they are reachable from Settings even when the Devices pane is closed.
- State lives in `~/.dsh/mobilecode/` (settings.json, ocr-venv, install log,
  OCR-INSTALL.md).

**HTTP API** (loopback-only, consumed by the pane) — `GET /api/dsh-mobilecode`
(info) and `POST /api/dsh-mobilecode/{start,stop,run,run/stop,focus}` with a
`directory` + `platform` body, mirroring mobilecode's `server.devicePreview`
group — plus setup endpoints: `GET /welcome`, `POST /welcome/dismiss`,
`GET /doctor`, `POST /doctor/fix {id}`, `GET /ocr`, `POST /ocr/install`,
`GET/POST /settings`.

## How it works

- `lib/device-build.js` — port of `mobilecode/packages/core/src/device-build.ts`:
  bounded project discovery (2-level walk, SKIP set), framework detection,
  preflight (xcodebuild / pod / Android SDK / Java / gradle wrapper), Expo
  `app.json` id injection and `prebuild`, Metro port/status helpers, iOS
  target/build-arg resolution, Android SDK/adb/aapt2/gradle helpers.
- `lib/device-preview.js` — port of `mobilecode/packages/core/src/device-preview.ts`
  with the **Effect runtime dropped**: a plain async `DevicePreviewEngine`
  class holding the same `servers` / `builds` / `bundlers` maps and the same
  lifecycle (park → halt → settle → execute; one project at a time; process
  exit/signal hooks; win32 taskkill tree-kill).
- `lib/index.js` — host half: engine, `/api/dsh-mobilecode/*` routes (run
  controls + welcome / doctor / ocr / settings), agent tools, system-prompt
  guidance section, `ctx.provide('mobilecode', handle)`.
- `lib/setup.js` — settings store (~/.dsh/mobilecode/settings.json), the plugin
  doctor (health checks + auto-fix), and the detached PaddleOCR installer
  (writes an install script to disk and spawns it via cmd.exe, so the install
  survives GUI restarts and its progress is pollable through `/ocr`).
- `lib/client.js` — browser half: `window.__ModuleLoader__.load({id, factory})`
  bundle (the only client bundle format the web shell materializes) mounting
  the sidebar entry, the drawer with DOM-level self-healing, the first-run
  welcome modal, and the settings dialog (doctor / PaddleOCR / AI prompt), like
  dsh-logcat.
- `cordis.patch.yml` + `package.json` (`dsh.bundle.patch`, `dsh.client.inject`)
  make it a hot-pluggable profile bundle.

**No runtime dependencies** — the port replaces `cross-spawn` (not resolvable
from the profile node_modules tree) with a ~40-line `launch()` helper that does
PATHEXT lookup and spawns `.cmd`/`.bat` through `cmd.exe /d /s /c` with
double-wrapped quoting, and replaces the Effect/Schema types with plain JS.

## Install / mount

```bash
dsh plugin --profile web add dsh-mobilecode
```

The package ships with `cordis.patch.yml` + `package.json` (`dsh.bundle.patch`,
`dsh.client.inject`) so it mounts as a hot-pluggable profile bundle with no
manual file copying. Restart the GUI to load the host half; refresh the browser
to load the client bundle (`/plugins/dsh-mobilecode/client.js` — the URL id is
the package name, not the patch row id).

## Verify

```powershell
node test/smoke.mjs                 # engine unit smoke test (15 checks)
node test/e2e-android.mjs <dir>     # full build+install+launch on a real device
```

The e2e run performs a Gradle `assembleDebug`, reads the app id with aapt2,
`adb install -r -g`, and `am start` on the first attached device, then quits
the app.

## Notes

- **PaddleOCR (optional, powers `device_screen`'s OCR)** — fully local, no
  network at inference time. One-time install into the shared venv the plugin
  looks for (`DSH_MOBILECODE_OCR_PY` env override wins, then
  `~/.dsh/mobilecode/ocr-venv`):

  ```powershell
  py -3.12 -m venv $env:USERPROFILE\.dsh\mobilecode\ocr-venv
  & $env:USERPROFILE\.dsh\mobilecode\ocr-venv\Scripts\python.exe -m pip install setuptools wheel "numpy<2" "paddleocr==3.7.0" "paddlepaddle==3.3.1"
  ```

  Paddle 3.x on Windows crashes in the oneDNN PIR executor, so `ocr.py` always
  constructs PaddleOCR with `enable_mkldnn=False` — with that, 3.7.0 works and
  its PP-OCRv6 models read text more accurately than the old 2.7.3 pin.
  Without the venv, `device_screen` still returns the UI
  hierarchy and screenshot; only OCR is skipped with a clear note.
- iOS support (xcodebuild / simctl / serve-sim) is darwin-gated exactly like
  mobilecode: `findProjects` only walks for iOS on macOS, and the run pipeline
  resolves Xcode targets on demand. On Windows the pane shows Android only.
- The engine keeps **one project at a time**: switching to another directory
  parks the previous project's live apps (and its Metro), and switching back
  revives them (`focus`).
- Agent tools take an explicit `directory` (default: plugin `defaultDirectory`
  config or the host cwd) because DSH tools have no session-location concept.
- Preview URLs are embedded in an iframe; serve-* must not send an
  `X-Frame-Options: DENY` header for the stream to render inside the pane.
