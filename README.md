# dsh-mobilecode

MobileCode for the dsh web GUI — a hot-pluggable DSH plugin porting
[hsandhu/mobilecode](https://github.com/hsandhu/mobilecode) (the opencode fork
with embedded iOS Simulator / Android Emulator support) into
[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).

It detects the mobile project in a directory (iOS / Android, Expo / React
Native / native), builds, installs and launches the app on the booted
simulator or emulator — and exposes the same to the agent through tools. The
device screen has exactly **one** home in the panel: the **Device 1** live
stream (co-op adds a second pane, **Device 2**). (0.10.0 merged the old Android
"Start server" preview into it — `serve-avd` is retired for the panel;
`serve-sim` remains the iOS-only view.)

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
- platform pills — Android: attached-device status (its view is the Device 1
  card); iOS: preview-server status. The iOS pill and card only render when the
  host OS is macOS — on Windows/Linux there is no simulator to drive, so 0.11.0
  stopped showing that dead affordance.
- per platform: **Run app / Stop app**, build status/step/error and an
  expandable log tail. iOS additionally **Start/Stop server** with the
  embedded serve-sim iframe — Android's duplicated serve-avd preview was
  merged into the Device 1 card in 0.10.0
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
- `device_intent` — open anything by Android intent: an `action` (e.g.
  `android.settings.WIFI_SETTINGS`), a deep-link `uri` (`geo:`, `https://`,
  `file://`), or an explicit `component` (`pkg/.Activity`). Reaches screens no
  tap can address. Values are single-quoted for the device shell (apostrophes
  escaped, control characters refused), so metacharacters stay inert.
- `device_stream` — drive the live screen stream the panel shows: `start` an
  online device (returns a signed `streamUrl` **and** an `android-stream`
  `presentationMeta` that renders a compact conversation card and auto-opens the
  panel), `status`, or `stop`. Streams are **per-serial and independent** since
  0.9.0 — start both players of a co-op game and `status` lists every live
  stream (`serials`); `stop` ends one (with `serial`) or all of them. Agents
  that just need to see the screen should still prefer `device_screen` /
  `device_ui_tree`.

**Live device stream (the panel — Device 1 / Device 2)**

The Devices pane shows a real-time mirror of the attached device. The primary
card is **Device 1**; co-op docks a second, **Device 2**. It is produced
**in-process** — no inner loopback port, no external helper:

- ONE persistent `adb exec-out "while :; do screencap -p; done"` child **per
  streamed device** runs at ~8 fps with zero per-frame process cost (spawning
  adb per frame caps at ~5 fps and 100% churn). A quote-safe PNG splitter cuts
  the concatenated output into frames by walking chunk headers (no marker
  scanning, no false positives).
- The browser `<img>` reads a `multipart/x-mixed-replace` body served straight
  from the latest-frame buffer. Backpressure is **latest-wins**: a slow tab skips
  frames instead of building an unbounded queue or watching a growing delay.
- Each stream owns its consumer refcount + idle timeout (nobody watching that
  device → its child stops) and crash keep-alive. Since 0.9.0 starting device B
  **never** retires device A's child — co-op streams are fully independent, and
  a frame from one device can never leak into the other viewer's pipe.
- **Tap or drag directly on the screen** to drive the device: a short press is a
  tap, a long drag becomes a swipe carrying the real press duration (clamped
  0–5000 ms), coalesced into one control call. A floating **pill toolbar** of SVG
  icons (Back / Home / Recents / Screenshot / Rotate / Refresh) sits over the
  stage, and a ☰ **device menu** adds notifications / quick settings / collapse /
  lock / wake / assistant.
- The header **device picker** groups online devices (🖥 emulator / 📱 physical,
  streaming badge) — each online emulator row carries a **⏻ off** power button
  (`POST /off` → `adb emu kill`; physical devices are refused) — and lists
  *stopped* configured AVDs with a one-click **⏻ boot** button
  (`POST /boot`, the merged device-start action from the retired Start-server
  flow: validate → spawn detached → adopt if already running → wait boot
  complete → the card streams it immediately); a running AVD appears only as
  its online row, never a duplicate boot entry. A **Live** badge shows the
  streamed serial. Quick sizes (Fit / 100% / S·240 / M·320 presets + a select)
  and frame styles (none / bezel / device) reshape the stage — each stream pane
  carries its own copy of these controls (0.11.2). In **Fit** the stage locks
  to a shared height, so the two panes sit at identical heights even when the
  devices have different screen aspect ratios (0.11.3).
- **Screenshot** captures a still via `POST /stream/still` (a real `screencap`,
  embedded as a data URL up to 4 MB) and flips the stage to a still view with a
  "back to Live" link.
- **Co-op split view (⧉, v0.9.0)**: with two or more online devices the card
  header grows a ⧉ toggle that docks a second **Device 2** pane beside it —
  its own device select, live `<img>`, tap/drag control, and (since 0.11.2) its
  own Size/Frame row mirroring Device 1's; both panes default to Fit, which
  locks to one stage height, so the pair starts identical and can be styled
  independently. Each pane grants its own HMAC capability; closing one pane
  never stalls or disturbs the other stream. A presence watcher polls device
  liveness while streaming: if a device is powered off (⏻ off, crash, unplug)
  its pane drops the frozen frame and the Live badge within ~5 s, and stays
  idle instead of silently grabbing another device — both panes guard against
  the re-grab (0.11.3–4). Both stream
  captions carry the running client version (`· v0.11.x`) so a page refresh is
  visibly proven.
- **Security**: every stream route sits behind a loopback + trusted-browser
  transport fence (peer address, loopback `Host`, `Sec-Fetch-Site` / `Origin` —
  so a LAN client cannot spoof localhost and a DNS-rebinding `Host` is rejected),
  and the stream URL is an **HMAC-SHA256 capability** signed with a per-install
  key (`~/.dsh/mobilecode/stream-access.key`, `0600`), expiring within 10 minutes
  and re-minted automatically. Coordinates are normalized 0..1 of the streamed
  frame, so one mapping serves every rotation.

**Multimodal screenshots**

When the routed model declares image input, `device_screen` delivers the
screenshot **as an image block** — the model literally sees the screen instead of
reading a file path. This mirrors the in-tree `read_image` tool: the PNG is
committed to DSH's durable attachment store (`ctx.get('attachments').saveImage`)
and returned as a `{type:'image', attachment}` content block, gated on
`llm.resolveModelInfo(...).inputModalities`. It **degrades, never refuses**: a
text-only route, a headless profile, or a host without the attachment store keeps
the plain JSON summary (path + UI tree + OCR) with no new error.
- `device_log` — device logs: logcat `main`/`crash`/`events`/`kernel` buffers
  (kernel = dmesg, needs adb root — works on emulators) with an optional
  case-insensitive substring filter, capped line count.
- `device_status` — one normalized snapshot: attached devices, configured AVDs,
  emulator binary, and what the plugin currently runs (preview servers, Metro,
  builds per directory).

**Device-ultimate port (v0.6.0)** — tools ported from
[dsh-adb-ultimate](https://github.com/newborne/dsh-adb-ultimate), rebuilt on the
classified adb boundary (argv-based, quoted, replay-safe):

- `device_scroll_to` — scroll until an element (`resource_id` or `text`/
  content-desc, exact then substring) comes into view, then report it with its
  center tap point. Completes the control loop for long lists: `device_wait_for`
  waits without scrolling, this brings the element on-screen so a follow-up
  `device_tap_element` can hit it. Defaults to 8 swipes, swipe direction
  `up`/`left`.
- `device_connect` — attach a Wi-Fi device: `adb connect <host>:<port>`
  (default port 5555); pass `pairing_code` + `pairing_port` (default 37000) for
  the first-time Android 11+ "Pair device" flow. Reattaching a known device
  needs no code.
- `device_pair_qr` — the full pairing journey in one call: generates a
  `WIFI:T:ADB;S:...;P:...;;` QR string (render it with any QR generator and scan
  with Settings → Connected devices → Pair by QR), polls `adb mdns services`
  (adb ≥ 31) for `_adb-tls-pairing._tcp`, then auto-pairs and connects.
- `device_perf` — one-shot RAM / battery / CPU snapshot (meminfo +
  `dumpsys battery` + cpuinfo → used %, level/temp/status/health, cores).
- `device_app_info` — per-app detail from `dumpsys package`: versionName/
  versionCode, minSdk/targetSdk, requested permissions, exported activities.
- `device_install` / `device_uninstall` — sideload a local APK
  (`-r -g`: replace + grant runtime permissions) / remove an app (optionally
  `-k` keep data). Uninstall is destructive.
- `device_reboot` — reboot into `normal` / `recovery` / `bootloader`
  (the device drops offline and comes back in a minute or two).

**Row & memory tools (v0.7.0)** — ported from
[ZSeven-W/dsh-android](https://github.com/ZSeven-W/dsh-android):

- `device_ui_rows` — read a list as **rows, not a tree**: clusters repeated
  sibling nodes of similar height (≥3 rows; page-sized containers and off-screen
  nodes excluded), aggregates each row's label, and parses counters (`3万`,
  `1.2k`, `42 items`) into `{key, value, raw}`. Returns
  `{rows: [{index, group, frame, label, counters}], omittedOffscreen}` — the
  compact handle for "tap row 7 of this list" without reading a 40 KB UI tree.
  Optional `filter` keeps rows whose label contains a substring.
- `device_tap_row` — tap row `index` (from `device_ui_rows`) at row-relative
  fractions `x`/`y` (default 0.5,0.5 = center). `expect_count {key, delta}` turns
  the tap into **one verified round trip**: the counter must already be visible
  in the row before the tap (refused otherwise — never probe an unknown control),
  and after an 800 ms settle the same row must show the count moved by exactly
  `delta` (default +1) with the row not having scrolled.
- `device_meminfo` — a running app's memory profile from `dumpsys meminfo`:
  TOTAL PSS/RSS/Swap-PSS, the App Summary heap breakdown
  (Java/Native/Code/Stack/Graphics) and the top PSS categories. Throws when the
  package has no running process.
- `device_backtrace` — a thread/crash dump without a debugger: sends SIGQUIT
  (`kill -3`), waits for ART to write the trace, reads the newest `/data/anr`
  entry, and falls back to the logcat crash buffer when `/data/anr` is unreadable
  (`engine: "anr-trace" | "logcat-crash"`). SIGQUIT refusal (system-uid or
  non-debuggable process) degrades to the crash buffer with an explanatory note
  instead of failing. Pass `package_name` or `pid`.
- `device_display` — read or change a device's **DPI and resolution**
  (`wm density` / `wm size`): `get` reports physical + override values, `set`
  overrides density and/or `width`x`height`, `reset` restores. Layouts reflow
  instantly — re-observe with `device_screen` after a change.
- `device_avd_create` — create a **second virtual device** via `avdmanager`;
  `clone_from` copies an existing AVD's full hardware config (same image, DPI,
  RAM) so both players behave identically. Boot the new AVD with `device_boot`
  (a running emulator holds 5554, so device #2 lands on `emulator-5556`).
- `device_batch` — fire 1..16 input actions **concurrently across devices**
  (each step carries its own serial + the same fields `device_input` takes).
  The co-op primitive for "both players press attack on the same frame"; a
  failing step never blocks the others, and per-step results say what landed.
- `device_pair_capture` — capture **both devices at the same instant**: one
  call, parallel screenshots + UI digests, both attached as real image blocks
  so a vision model watches both players at once. `ocr: true` adds PaddleOCR.

**Co-op mesh (v0.8.0)** — two emulators cannot multicast-discover each other
(each sits behind its own slirp NAT), but every one of them reaches the host at
`10.0.2.2`. So the plugin hosts a LocalSend-style JSON pub/sub **hub**: games
join it and talk through it, and the AI model reads and steers the same wire.

- **Identity**: `POST /mesh/join {serial?, name?, role?}` — the serial pins a
  stable, random, LocalSend-style callsign (`amber-fox`, `brisk-owl`…); the
  join returns a per-process token that authorizes every later call.
- **Sessions**: `POST /mesh/link {with: [names…]}` (2–8 members), then
  `POST /mesh/send {session, body}` and `GET /mesh/poll?id&token&after&wait`
  (long-polls up to 30 s). `GET /mesh/peers` shows the roster; `POST /mesh/leave`
  departs. Everything is JSON, 64 KiB per message.
- **Network conditions**: each session carries a policy — `latencyMs`,
  `jitterMs`, `dropPct`, `dupPct`, `throttleKbps` (size-proportional delay) —
  enforced per recipient by the hub. This is desync testing without touching
  app code: make player B lag 400 ms with 100 ms jitter and watch the pair cope.
- **Agent side**: `mesh_status` (who joined, sessions, policies, undelivered
  mail), `mesh_send` (ghost a message as any peer — the other game receives it
  as if its partner sent it), `mesh_log` (every join/link/send/drop/dup/tune
  event, timestamped), `mesh_tune` (set the policy), `mesh_reset`.
- **Security**: the routes are loopback-only (emulators reach the host loopback
  via slirp); a request presenting browser headers (`Origin`/`Sec-Fetch-*`)
  must additionally pass the trusted-browser stream fence, so a random web page
  can never join a game or read its messages.
- **Client SDK**: `sdk/mesh-client.mjs` — a ~90-line dependency-free `fetch`
  client (`join/link/send/inbox`) for Node/Deno/Bun/WebView/React-Native game
  code; plain HTTP works from any other engine (Unity, Godot, Kotlin).

Typical loop: `device_avd_create` + `device_boot` a clone → both apps
`join` → `mesh_link` → `device_batch` inputs at both → `device_pair_capture`
to watch → `mesh_log` to see the traffic → `mesh_tune` to inject real-world
network pain. For the human at the keyboard: open the panel and hit ⧉ — the
Devices pane mirrors **both** devices live, side by side, tappable (v0.9.0).

**Conversation surface (v0.7.0)** — the transcript integration ported from
dsh-android's UI/UX:

- A settled `device_stream` / `device_boot` call renders a **compact card** in
  the conversation (kind, serial, streaming/failed badge, "⤢ open in panel")
  instead of a raw JSON blob, and **auto-opens the Devices panel once** when a
  stream first settles. The card hydrates from the host-projected
  `presentationMeta` on top-level calls and falls back to parsing the serial out
  of the durable result text for nested calls; it never crashes on a shape it
  does not recognize.
- A **composer capsule** — a green `● <serial>` pill in the input dock — shows
  while a device streams and the panel is closed; clicking it opens the panel.

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
  - **Connection** — the resolved adb binary path and every device `adb` sees
    (serial, state dot, model, USB / Wi-Fi badge), straight from
    `GET /connection`. A **connect form** (device IP + port, optional pairing
    code + pair port → `POST /connect`) and a **Pair by QR** button
    (`POST /pair-qr`, one blocking call that generates the `WIFI:T:ADB` QR,
    waits for the mDNS scan and auto-pairs + connects) plus an in-line refresh.
    Explains the Wi-Fi reconnect policy.
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
`GET/POST /settings`, `GET /connection` — plus the Wi-Fi actions
`POST /connect` (host/port/pairing code) and `POST /pair-qr` (mDNS QR flow) —
plus the live-stream routes `GET /stream/status`, `POST /stream/grant`,
`POST /stream/control` (tap / swipe / key / long-press, coalesced),
`POST /stream/devices` (online devices **and** configured AVDs),
`POST /boot {avd}` (the panel's merged one-click AVD boot — validated name,
adopt-if-running, detached spawn, resolves once boot-completed),
`POST /stream/still` (one `screencap` as a data URL up to 4 MB),
`POST /stream/device-action` (the `device_action` verbs over the panel fence)
and `GET /stream/{token}` (the multipart frame body) — plus the co-op mesh
routes `POST /mesh/join`, `GET /mesh/peers`, `POST /mesh/{link,send,leave}`,
`GET /mesh/poll` (see **Co-op mesh** above). Every stream error carries
a machine-readable `code` next to the HTTP status — `token_invalid`,
`stream_not_running`, `stream_start_failed`, `devices_unavailable`,
`device_not_found`, `device_offline`, `unknown_action`, `bad_request`,
`control_failed`, `capture_failed`, `device_action_failed` — so the panel can
say *why* instead of "something failed".

**One classified adb boundary** — every serial-targeted adb command runs through
`adbRun()` in `lib/device-build.js`:

- A transport failure (`device not found` / `offline` / `unauthorized` /
  `closed` / `no devices`) on a **Wi-Fi serial** (`ip:port`) gets exactly ONE
  `adb connect` retry. Read-only commands (the `replaySafeAdb` allowlist:
  `exec-out`/`screencap`/`uiautomator`/`dumpsys`/`getprop`/`logcat`/`cat`/…)
  then replay automatically; **side-effectful ones never do** — a replayed tap
  could double-tap — they raise "reconnected — call again" instead.
- USB serials and non-transport failures (a real `am start` error, a
  `SecurityException`) surface as classified, actionable errors — the old
  silent `capture()` → `""` swallowing is gone on agent-facing paths.
- Tolerant internal callers (boot polling, IME checks) opt back into
  best-effort with an explicit `.catch(() => "")`.

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
  controls + welcome / doctor / ocr / settings + mesh), agent tools, system-prompt
  guidance section, `ctx.provide('mobilecode', handle)`.
- `lib/mesh-hub.js` — the co-op mesh core: peer identity (serial-pinned
  callsigns + HMAC tokens), sessions, per-session network policy
  (latency/jitter/drop/dup/throttle), a long-poll inbox, and an event log.
  Pure + injectable clock/RNG, so `test/mesh-hub.mjs` covers it offline.
- `sdk/mesh-client.mjs` — dependency-free `fetch` client (join/link/send/
  poll/inbox/leave) for game code running inside the emulators.
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
