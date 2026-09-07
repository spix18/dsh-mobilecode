/**
 * dsh-mobilecode — device-preview engine.
 *
 * Plain-JS port of `mobilecode/packages/core/src/device-preview.ts`
 * (hsandhu/mobilecode). The Effect runtime is dropped entirely: the
 * orchestration is a plain async class with the same state maps, the same
 * lifecycle (park / halt / settle / execute), and the same process hooks.
 *
 * Lifecycle of one "run":
 *   runApp → park(other directories) → builds.set(key, active)
 *         → active.done = execute(...)  (detached)
 *   execute → findProjects → preflight → resolveNode → prebuild (expo)
 *           → ensureBundler (Metro) → ensureDevice (sim/emulator boot)
 *           → pods (ios) → runIos / runAndroid → finish
 *
 * `info(directory)` is the read model the pane polls (~2s) and the agent
 * tools summarize.
 */

import os from "node:os"
import path from "node:path"
import * as DeviceBuild from "./device-build.js"

// serve-sim (iOS Simulator) and serve-avd (Android Emulator) both serve a browser preview UI and
// print its origin to stdout once the port is bound. Both default to 3200 and exit when it is
// taken, so each gets the first free port in its own range and the two can run side by side.
const COMMANDS = {
  ios: { command: "npx", args: (port) => ["--yes", "serve-sim", "--port", String(port)] },
  android: { command: "npx", args: (port) => ["--yes", "serve-avd", "--port", String(port)] },
}
const PORTS = { ios: 3200, android: 3250 }
const LOG_LIMIT = 200
const STOP_TIMEOUT_MS = 3000
const DEVICE_WAIT_MS = 180_000
const BUNDLER_WAIT_MS = 90_000
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]
const PREVIEW_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

const BUSY = ["building", "installing", "launching"]
const buildPrefix = (directory) => `${directory}\0`
const buildKey = (input) => `${buildPrefix(input.directory)}${input.platform}`

export class DevicePreviewEngine {
  constructor() {
    this.servers = new Map()
    this.builds = new Map()
    // One Metro per JavaScript root, shared by the iOS and Android apps built from it.
    this.bundlers = new Map()
    this.hooked = false
  }

  // ── process hooks ──────────────────────────────────────────────────────────

  // Nothing reaps the children when this process dies without unwinding the engine (a signal,
  // or process.exit from the CLI entrypoint), so ask them to stop from the process hooks too.
  onExit = () => {
    for (const active of this.servers.values()) terminate(active.process, active.state.status === "exited")
    for (const bundler of this.bundlers.values()) terminate(bundler.process, bundler.state.status === "exited")
    for (const build of this.builds.values()) terminate(build.process, false)
  }

  onSignal = (signal) => {
    this.onExit()
    // Keep the default termination when nothing else handles the signal (signal-exit pattern).
    if (process.listenerCount(signal) > 1) return
    this.unhook()
    process.kill(process.pid, signal)
  }

  hook() {
    if (this.hooked) return
    this.hooked = true
    process.on("exit", this.onExit)
    if (process.platform === "win32") return
    for (const signal of SIGNALS) process.on(signal, this.onSignal)
  }

  unhook() {
    if (!this.hooked) return
    this.hooked = false
    process.off("exit", this.onExit)
    for (const signal of SIGNALS) process.off(signal, this.onSignal)
  }

  /** Shut everything down. Safe to call on dispose and from the finalizer. */
  async dispose() {
    this.unhook()
    for (const build of this.builds.values()) terminate(build.process, false)
    this.builds.clear()
    await Promise.all([...this.servers.values(), ...this.bundlers.values()].map(kill))
    this.servers.clear()
    this.bundlers.clear()
  }

  // ── read model ─────────────────────────────────────────────────────────────

  async detect(input) {
    return DeviceBuild.findProjects(input.directory).map((project) => project.platform)
  }

  async info(input) {
    const projects = DeviceBuild.findProjects(input.directory)
    const bundler = [...this.bundlers.values()].find((active) => within(active.state.directory, input.directory))
    return {
      platforms: projects.map((project) => project.platform),
      framework: projects[0]?.framework,
      bundler: bundler ? { ...bundler.state, log: [...bundler.state.log] } : undefined,
      servers: [...this.servers.values()].map((active) => ({ ...active.state, log: [...active.state.log] })),
      builds: [...this.builds.entries()]
        .filter(([key]) => key.startsWith(buildPrefix(input.directory)))
        .map(([, build]) => ({ ...build.state, log: [...build.state.log] })),
    }
  }

  // ── preview servers ────────────────────────────────────────────────────────

  async launchPreview(input) {
    const current = this.servers.get(input.platform)
    if (current && current.state.status !== "exited") return
    const spec = COMMANDS[input.platform]
    const state = {
      platform: input.platform,
      status: "starting",
      command: [spec.command, ...spec.args(PORTS[input.platform])].join(" "),
      log: [],
    }
    // Claim the slot before the first await so a second caller cannot start a duplicate.
    const active = { state }
    this.servers.set(input.platform, active)
    const port = await DeviceBuild.freePort(PORTS[input.platform])
    // A stop that landed during the lookup already removed the slot; spawning now would orphan.
    if (this.servers.get(input.platform) !== active) {
      state.status = "exited"
      return
    }
    if (!port) {
      push(state.log, `No free port found from ${PORTS[input.platform]} upward.`)
      state.status = "exited"
      return
    }
    const args = spec.args(port)
    state.command = [spec.command, ...args].join(" ")
    // Same process group as the server so a terminal Ctrl+C reaches npx and serve-* as well.
    // stdin is the guard's lifeline: it closes when this process dies, however it dies.
    const wrapped = DeviceBuild.guarded(spec.command, args)
    const child = DeviceBuild.launch(wrapped.command, wrapped.args, {
      cwd: input.directory,
      env: { ...process.env, ...input.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    state.pid = child.pid
    active.process = child
    this.hook()
    const append = (line) => {
      const text = clean(line)
      if (!text) return
      push(state.log, text)
      if (state.status !== "starting") return
      const match = PREVIEW_URL.exec(text)
      if (!match) return
      state.url = match[0]
      state.status = "running"
    }
    lines(child.stdout, append)
    lines(child.stderr, append)
    child.once("error", (error) => {
      append(error.message)
      state.status = "exited"
      state.url = undefined
    })
    child.once("exit", (code) => {
      state.status = "exited"
      state.exitCode = code ?? undefined
      state.url = undefined
    })
  }

  async start(input) {
    await this.launchPreview(input)
    return this.info(input)
  }

  async stop(input) {
    const active = this.servers.get(input.platform)
    if (active) {
      this.servers.delete(input.platform)
      await kill(active)
    }
    return this.info(input)
  }

  // ── devices and bundlers ───────────────────────────────────────────────────

  // Pressing play with nothing booted should boot something, the way Xcode's Run does.
  // serve-avd/serve-sim is what owns devices on macOS; on Windows serve-avd cannot find the
  // SDK (it probes `emulator`/`adb` without the .exe extension), so boot the emulator directly.
  async ensureDevice(platform, directory, env, active, report) {
    const find = () => (platform === "ios" ? DeviceBuild.bootedSimulator() : DeviceBuild.androidDevice())
    const existing = await find()
    if (existing) return existing
    report.step(platform === "ios" ? "Starting simulator" : "Starting emulator")
    if (platform === "android") {
      const serial = await this.bootEmulator(active)
      if (serial) return serial
      // No SDK emulator/AVDs: fall through to serve-avd (its own boot path may work on macOS).
    }
    await this.launchPreview({ directory, platform, env })
    const deadline = Date.now() + DEVICE_WAIT_MS
    while (Date.now() < deadline && !active.cancelled) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const found = await find()
      if (found) return found
      // Stopped from the pane, or died: nothing is going to boot a device any more.
      const server = this.servers.get(platform)
      if (!server || server.state.status === "exited") return undefined
    }
    return undefined
  }

  /** Boot the first configured AVD and wait for it to come online. undefined when none can boot. */
  async bootEmulator(active) {
    const binary = DeviceBuild.emulatorBinary()
    if (!binary) return undefined
    const avds = await DeviceBuild.androidAvds()
    const preferred = process.env["DSH_MOBILECODE_AVD"]
    const avd = (preferred && avds.includes(preferred) ? preferred : avds[0])
    if (!avd) return undefined
    // Detached daemon, exactly like serve-avd boots it: the emulator outlives us and the user
    // closes it when they are done (the way Xcode's Run leaves the Simulator open).
    const child = DeviceBuild.launch(
      binary,
      ["-avd", avd, "-no-snapshot", "-no-boot-anim", "-no-audio", "-gpu", "swiftshader_indirect"],
      { stdio: "ignore", detached: true, windowsHide: true },
    )
    child.unref?.()
    const deadline = Date.now() + DEVICE_WAIT_MS
    while (Date.now() < deadline && !active.cancelled) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const serial = await DeviceBuild.androidDevice()
      // The serial appears while Android is still booting; launching before
      // sys.boot_completed=1 fails. Wait for a fully booted device (serve-avd
      // does the same in its waitForBoot).
      if (serial && (await DeviceBuild.androidBooted(serial))) return serial
    }
    return undefined
  }

  // Debug builds load their JavaScript from Metro at launch, so it must be up before the app is.
  // Start it as early as possible and let the build overlap with its warm-up.
  ensureBundler(root, framework, env) {
    const current = this.bundlers.get(root)
    if (current && current.state.status !== "exited") return current
    const port = DeviceBuild.metroPort()
    const spec = DeviceBuild.bundlerCommand(framework, port)
    const state = {
      framework,
      directory: root,
      status: "starting",
      command: [spec.command, ...spec.args].join(" "),
      log: [],
    }
    const active = { state }
    active.ready = (async () => {
      // Something (a terminal, an earlier session) may already be serving this port. Reuse it
      // rather than have Expo offer to pick another port that the app would not know about.
      if (await DeviceBuild.metroRunning(port)) {
        const owner = await DeviceBuild.portOwner(port)
        // Unknown owner (no lsof) is assumed to be ours, as before. A Metro serving another
        // project would hand this app the wrong bundle, so replace it.
        // Ours when started inside the project, or from a workspace root above it (not from
        // somewhere as broad as the home directory).
        const ours =
          !owner?.cwd ||
          within(owner.cwd, root) ||
          (within(root, owner.cwd) && owner.cwd !== "/" && owner.cwd !== os.homedir())
        if (ours) {
          state.command = `Metro already running on port ${port}`
          state.url = DeviceBuild.metroUrl(port)
          state.status = "running"
          return
        }
        push(state.log, `Stopping Metro for ${owner.cwd} (pid ${owner.pid}) to serve this project instead`)
        try {
          process.kill(owner.pid, "SIGTERM")
        } catch {
          /* process already gone */
        }
        const gone = Date.now() + STOP_TIMEOUT_MS
        while (Date.now() < gone && (await DeviceBuild.metroRunning(port)))
          await new Promise((resolve) => setTimeout(resolve, 200))
      }
      const wrapped = DeviceBuild.guarded(spec.command, spec.args)
      const child = DeviceBuild.launch(wrapped.command, wrapped.args, {
        cwd: root,
        // Not CI mode: Expo disables file watching and reloads under CI=1.
        env: { ...process.env, ...env, EXPO_NO_TELEMETRY: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      active.process = child
      state.pid = child.pid
      this.hook()
      const append = (line) => {
        const text = clean(line)
        if (text) push(state.log, text)
      }
      lines(child.stdout, append)
      lines(child.stderr, append)
      child.once("error", (error) => {
        append(error.message)
        state.status = "exited"
        state.url = undefined
      })
      child.once("exit", (code) => {
        state.status = "exited"
        state.exitCode = code ?? undefined
        state.url = undefined
      })
      const deadline = Date.now() + BUNDLER_WAIT_MS
      while (Date.now() < deadline && state.status === "starting") {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (state.status !== "starting") break
        if (await DeviceBuild.metroRunning(port)) {
          state.url = DeviceBuild.metroUrl(port)
          state.status = "running"
        }
      }
    })()
    this.bundlers.set(root, active)
    return active
  }

  // Only the last app to leave turns Metro off.
  async releaseBundler(root) {
    if (!root) return
    const others = [...this.builds.values()].some(
      (build) => build.root === root && (BUSY.includes(build.state.status) || build.state.status === "running"),
    )
    if (others) return
    const active = this.bundlers.get(root)
    if (!active) return
    this.bundlers.delete(root)
    await kill(active)
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  async runApp(input) {
    const key = buildKey(input)
    const existing = this.builds.get(key)
    if (existing && BUSY.includes(existing.state.status)) return this.info(input)
    // One project at a time: the devices and the Metro port are shared.
    await this.park(input.directory)
    const active = {
      state: {
        platform: input.platform,
        status: "building",
        step: "Preparing",
        log: [],
        startedAt: Date.now(),
      },
      cancelled: false,
    }
    this.builds.set(key, active)
    this.hook()
    // Detached from the request: the UI polls `info` for progress.
    active.done = execute(this, active, input.directory, input.platform, input.env, {
      previous: input.relaunch ? existing : undefined,
    })
    return this.info(input)
  }

  // Cancel a build or terminate the app, then wait for the pipeline to unwind so a following
  // play cannot start another xcodebuild or Gradle on the same project.
  async halt(active) {
    active.cancelled = true
    const proc = active.process
    active.process = undefined
    if (proc) terminate(proc, false)
    await quit(active)
    active.state.status = "idle"
    active.state.step = undefined
    active.state.finishedAt = Date.now()
    await this.releaseBundler(active.root)
    await settle(active, proc)
  }

  live(build) {
    return BUSY.includes(build.state.status) || build.state.status === "running"
  }

  ofDirectory(directory) {
    return [...this.builds.entries()].filter(([key]) => key.startsWith(buildPrefix(directory))).map(([, build]) => build)
  }

  /** Stop every other location's apps, remembering that a switch back should revive them. */
  async park(directory) {
    for (const [key, build] of this.builds) {
      if (key.startsWith(buildPrefix(directory)) || !this.live(build)) continue
      await this.halt(build)
      build.parked = true
    }
  }

  async stopApp(input) {
    const active = this.builds.get(buildKey(input))
    if (!active) return this.info(input)
    active.parked = false
    await this.halt(active)
    return this.info(input)
  }

  async focus(input) {
    const mine = this.ofDirectory(input.directory)
    const others = [...this.builds.entries()].some(
      ([key, build]) => !key.startsWith(buildPrefix(input.directory)) && this.live(build),
    )
    const parked = mine.some((build) => build.parked)
    // Merely opening a tab must not start a build; only a switch away from a running project,
    // or back to one that a switch put away, changes what is on the devices.
    if (!others && !parked) return this.info(input)
    if (mine.some(this.live)) return this.info(input)
    for (const platform of DeviceBuild.findProjects(input.directory).map((project) => project.platform))
      await this.runApp({ directory: input.directory, platform, env: input.env, relaunch: true })
    return this.info(input)
  }
}

// ── module-level helpers ──────────────────────────────────────────────────────

/** Wait for a cancelled pipeline to unwind, killing its child outright if it does not. */
async function settle(active, proc) {
  if (!active.done) return
  const finished = await Promise.race([
    active.done.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
  ])
  if (finished || !proc) return
  for (const pid of [...descendants(proc.pid), ...(proc.pid ? [proc.pid] : [])]) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
  await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))])
}

/** Build, install and launch. Runs detached from the request that started it. */
async function execute(engine, active, directory, platform, env, runtime) {
  const log = (line) => {
    const text = clean(line)
    if (text) push(active.state.log, text)
  }
  const fail = (message) => {
    if (active.cancelled) return
    active.state.status = "failed"
    active.state.step = undefined
    active.state.error = message
    active.state.finishedAt = Date.now()
  }
  const step = (value, status) => {
    active.state.step = value
    if (status) active.state.status = status
  }

  try {
    let project = DeviceBuild.findProjects(directory).find((candidate) => candidate.platform === platform)
    if (!project) return fail(`No ${platform === "ios" ? "iOS" : "Android"} project found in this directory.`)
    const problem = DeviceBuild.preflight(project, env)
    if (problem) return fail(problem)
    active.state.framework = project.framework
    active.root = project.root
    if (platform === "android") env = { ...DeviceBuild.androidEnv(), ...env }
    const report = { log, fail, step }

    // Expo and React Native pin a Node range; the login shell's default is often older. Find one
    // that fits and put it first on PATH for every step below, or stop before wasting a build.
    if (project.framework !== "native") {
      const ranges = DeviceBuild.nodeRequirement(project.root)
      if (ranges.length > 0) {
        const node = await DeviceBuild.resolveNode(ranges, { ...process.env, ...env })
        if (active.cancelled) return
        if (node.problem) return fail(node.problem)
        if (node.bin) {
          env = { ...env, PATH: `${node.bin}${path.delimiter}${DeviceBuild.pathEnv(env)}` }
          if (node.note) log(node.note)
        }
      }
    }

    if (project.needsPrebuild) {
      const generated = await prebuild(engine, active, project, env, report)
      if (active.cancelled || !generated) return
      project = generated
    }
    active.state.directory = project.directory

    // Metro next: its warm-up overlaps with the device boot and the native build, and the app
    // needs it at launch. After prebuild, so it never watches folders being rewritten underneath it.
    const bundler =
      project.framework === "native" ? undefined : engine.ensureBundler(project.root, project.framework, env)

    const device = await engine.ensureDevice(platform, project.directory, env, active, report)
    if (active.cancelled) return
    if (!device)
      return fail(
        platform === "ios"
          ? "Could not start a simulator. Open the device pane and start one."
          : "Could not start an emulator. Open the device pane and start one, or create an AVD in Android Studio.",
      )
    active.device = device

    // Same device, app still installed from last time: bring it back without a build. Anything
    // wrong with that (uninstalled, wiped emulator) falls through to the full pipeline.
    const previous = runtime.previous
    if (previous?.installed && previous.device === device) {
      active.state.target = previous.state.target
      active.state.appID = previous.installed.appID
      const launched = await relaunch(active, platform, device, previous.installed, report, bundler)
      if (active.cancelled || launched) return
      report.log("Relaunch failed; rebuilding")
    }

    // Bare React Native ships a Podfile that nothing has installed yet on a fresh checkout.
    if (platform === "ios" && !DeviceBuild.podsInstalled(project.directory)) {
      report.step("Installing pods")
      const pods = DeviceBuild.exec("pod", ["install"], { cwd: project.directory, env }, report.log)
      active.process = pods.child
      const code = await pods.exit
      active.process = undefined
      if (active.cancelled) return
      if (code !== 0) return fail("`pod install` failed. Open the log for details.")
    }

    const beforeLaunch = bundler ? () => awaitBundler(bundler, report) : undefined
    if (platform === "ios") return await runIos(active, project.directory, env, report, device, beforeLaunch)
    return await runAndroid(
      active,
      project.directory,
      env,
      report,
      device,
      project.framework !== "native",
      beforeLaunch,
    )
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

/** Generate the native project for an Expo app in place. Returns the project to build from. */
async function prebuild(engine, active, project, env, report) {
  const note = DeviceBuild.ensureExpoAppIds(project.root, project.platform)
  if (note) report.log(note)
  report.step("Generating native project")
  const run = DeviceBuild.exec(
    "npx",
    ["expo", "prebuild", "--platform", project.platform],
    { cwd: project.root, env: { ...env, CI: "1", EXPO_NO_TELEMETRY: "1" } },
    report.log,
  )
  active.process = run.child
  const code = await run.exit
  active.process = undefined
  if (active.cancelled) return
  if (code !== 0) {
    report.fail(buildError(active.state.log) ?? "`expo prebuild` failed. Open the log for details.")
    return
  }
  const directory = DeviceBuild.prebuiltDirectory(project.root, project.platform)
  if (!directory) {
    report.fail(`\`expo prebuild\` finished but produced no ${project.platform} project.`)
    return
  }
  return { ...project, directory, needsPrebuild: false }
}

async function awaitBundler(bundler, report) {
  if (bundler.state.status === "starting") report.step("Waiting for Metro")
  await bundler.ready
  if (bundler.state.status === "running") return true
  const last = [...bundler.state.log].reverse().find((line) => /error|failed|EADDRINUSE|cannot/i.test(line))
  report.fail(last ? `Metro did not start: ${last.slice(0, 250)}` : "Metro did not start. Open the log for details.")
  return false
}

/** Launch the app a previous run installed. True on success, false to fall back to a build. */
async function relaunch(active, platform, device, installed, report, bundler) {
  if (bundler && !(await awaitBundler(bundler, report))) return false
  if (active.cancelled) return false
  if (platform === "android" && bundler) {
    const reversed = await reverseMetro(active, device, report)
    if (active.cancelled || !reversed) return false
  }
  const ok =
    platform === "ios"
      ? await launchIos(active, device, installed.appID, report)
      : await launchAndroid(active, device, installed, report)
  if (!ok || active.cancelled) return false
  finish(active, installed)
  return true
}

async function launchIos(active, udid, bundleID, report) {
  report.step("Launching", "launching")
  // A previous run may still be on screen; launching over it is not a restart, so end it first.
  await DeviceBuild.exec("xcrun", ["simctl", "terminate", udid, bundleID], {}).exit
  if (active.cancelled) return false
  const launched = DeviceBuild.exec("xcrun", ["simctl", "launch", udid, bundleID], {}, report.log)
  active.process = launched.child
  const code = await launched.exit
  active.process = undefined
  return code === 0
}

async function launchAndroid(active, serial, app, report) {
  report.step("Launching", "launching")
  const args = app.activity
    ? ["-s", serial, "shell", "am", "start", "-n", `${app.appID}/${app.activity}`]
    : ["-s", serial, "shell", "monkey", "-p", app.appID, "-c", "android.intent.category.LAUNCHER", "1"]
  // `am start` reports a missing activity as "Error type 3" without a failing exit code.
  let errored = false
  const launched = DeviceBuild.exec(DeviceBuild.adb(), args, {}, (line) => {
    if (/^Error/.test(line.trim())) errored = true
    report.log(line)
  })
  active.process = launched.child
  const code = await launched.exit
  active.process = undefined
  return code === 0 && !errored
}

/** The emulator cannot see the host's localhost; route the Metro port through adb. */
async function reverseMetro(active, serial, report) {
  const port = String(DeviceBuild.metroPort())
  const reverse = DeviceBuild.exec(DeviceBuild.adb(), ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], {}, report.log)
  active.process = reverse.child
  const code = await reverse.exit
  active.process = undefined
  if (code !== 0) report.log(`adb reverse failed; the app may not reach Metro on port ${port}.`)
  return true
}

function finish(active, installed) {
  active.installed = installed
  active.parked = false
  active.state.status = "running"
  active.state.step = undefined
  active.state.error = undefined
  active.state.finishedAt = Date.now()
}

async function runIos(active, directory, env, report, udid, beforeLaunch) {
  report.step("Reading project")
  const target = await DeviceBuild.iosTarget(directory)
  if (active.cancelled) return
  if (typeof target === "string") return report.fail(target)
  active.state.target = target.scheme
  active.state.appID = target.bundleID

  report.step(`Building ${target.scheme}`)
  const build = DeviceBuild.exec("xcodebuild", DeviceBuild.iosBuildArgs(target, udid), { cwd: directory, env }, report.log)
  active.process = build.child
  const code = await build.exit
  active.process = undefined
  if (active.cancelled) return
  if (code !== 0) return report.fail(buildError(active.state.log) ?? "Build failed.")

  report.step("Installing", "installing")
  const install = DeviceBuild.exec("xcrun", ["simctl", "install", udid, target.app], { cwd: directory }, report.log)
  active.process = install.child
  const installed = await install.exit
  active.process = undefined
  if (active.cancelled) return
  if (installed !== 0) return report.fail("Could not install the app on the simulator.")

  if (beforeLaunch && !(await beforeLaunch())) return
  if (active.cancelled) return
  const launched = await launchIos(active, udid, target.bundleID, report)
  if (active.cancelled) return
  if (!launched) return report.fail("Could not launch the app on the simulator.")
  finish(active, { appID: target.bundleID })
}

async function runAndroid(active, directory, env, report, serial, reactNative, beforeLaunch) {
  const wrapper = DeviceBuild.gradleWrapper(directory)
  if (!wrapper) return report.fail("No Gradle wrapper found in this project.")
  const module = DeviceBuild.androidModule(directory)
  active.state.target = module

  // Only the device's own ABI for React Native: a universal debug APK is ~250 MB and routinely
  // fails to install on an emulator with a stock 6 GB data partition.
  const abi = reactNative ? await DeviceBuild.androidAbi(serial) : undefined
  if (active.cancelled) return
  if (abi) report.log(`Building for ${abi} only`)

  report.step(`Building ${module}`)
  const build = DeviceBuild.exec(
    wrapper,
    [`:${module}:assembleDebug`, ...DeviceBuild.reactNativeArchitectureArgs(abi)],
    { cwd: directory, env },
    report.log,
  )
  active.process = build.child
  const code = await build.exit
  active.process = undefined
  if (active.cancelled) return
  if (code !== 0) return report.fail(buildError(active.state.log) ?? "Build failed.")

  const apk = DeviceBuild.androidApk(directory, module)
  if (!apk) return report.fail("Build finished but no debug APK was produced.")
  const app = await DeviceBuild.androidApp(apk, directory, module)
  if (active.cancelled) return
  if (!app) return report.fail("Could not determine the application id for this project.")
  active.state.appID = app.id

  report.step("Installing", "installing")
  const install = DeviceBuild.exec(DeviceBuild.adb(), ["-s", serial, "install", "-r", "-g", apk], { cwd: directory }, report.log)
  active.process = install.child
  const installed = await install.exit
  active.process = undefined
  if (active.cancelled) return
  if (installed !== 0) return report.fail(await installError(active.state.log, serial))

  if (beforeLaunch) {
    await reverseMetro(active, serial, report)
    if (active.cancelled) return
    if (!(await beforeLaunch())) return
    if (active.cancelled) return
  }
  const installedApp = { appID: app.id, ...(app.activity ? { activity: app.activity } : {}) }
  const launched = await launchAndroid(active, serial, installedApp, report)
  if (active.cancelled) return
  if (!launched) return report.fail("Could not launch the app on the device.")
  finish(active, installedApp)
}

/** Turn adb's install failure into something the user can act on. */
async function installError(log, serial) {
  const reason = DeviceBuild.installFailure(log)
  if (!reason) return "Could not install the APK on the device."
  if (reason.startsWith("INSTALL_FAILED_INSUFFICIENT_STORAGE")) {
    const free = await DeviceBuild.androidFreeMb(serial)
    const space = free === undefined ? "" : ` (${free} MB free)`
    return `The device is out of storage${space}. Uninstall apps or give the AVD a larger internal storage in Android Studio's Device Manager, then run again.`
  }
  return `Could not install the APK: ${reason}`
}

/** Ask the device to terminate the app that this build launched. */
async function quit(active) {
  const appID = active.state.appID
  const device = active.device
  if (!appID || !device) return
  if (active.state.platform === "ios") {
    await DeviceBuild.exec("xcrun", ["simctl", "terminate", device, appID], {}).exit
    return
  }
  await DeviceBuild.exec(DeviceBuild.adb(), ["-s", device, "shell", "am", "force-stop", appID], {}).exit
}

/** The most useful line from a failed build, for the status text and the toast. */
function buildError(log) {
  const lines = log.map((line) => line.trim())
  // Gradle prints the real cause under "* What went wrong:", usually prefixed with ">".
  const wrong = lines.findIndex((line) => line.includes("What went wrong"))
  if (wrong !== -1) {
    const detail = lines.slice(wrong + 1, wrong + 6).find((line) => line && !line.startsWith("*"))
    if (detail) return detail.replace(/^>\s*/, "").slice(0, 300)
  }
  const compiler = [...lines].reverse().find((line) => /(^|\s)error:/i.test(line))
  if (compiler) return compiler.slice(0, 300)
  return [...lines]
    .reverse()
    .find((line) => /FAILURE: Build failed/i.test(line))
    ?.slice(0, 300)
}

async function kill(active) {
  const proc = active.process
  if (!proc || active.state.status === "exited") return
  const exited = () => active.state.status === "exited"
  if (process.platform === "win32") return killTree(proc, { exited })
  // npm forwards SIGTERM to the serve-* process it launched, which shuts the stream down cleanly.
  // Capture the tree first so stragglers (simctl, adb) can still be force-killed afterwards.
  const tree = [...descendants(proc.pid), ...(proc.pid ? [proc.pid] : [])]
  proc.kill("SIGTERM")
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (!exited() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
}

/** Windows: taskkill the whole tree, the way `Shell.killTree` does in mobilecode. */
function killTree(proc, opts) {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return Promise.resolve()
  return new Promise((resolve) => {
    const killer = DeviceBuild.launch("taskkill", ["/pid", String(pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("exit", () => resolve())
    killer.once("error", () => resolve())
  })
}

/**
 * Synchronous best-effort stop, safe to call from the process `exit` event. npx does not always
 * forward the signal to the server it launched, and an orphaned serve-* keeps its port for days,
 * so signal the descendants as well.
 */
function terminate(proc, exited) {
  if (!proc || exited) return
  if (process.platform === "win32") {
    proc.kill()
    return
  }
  for (const pid of descendants(proc.pid)) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  proc.kill("SIGTERM")
}

// Direct and indirect child pids, deepest first. Only used on POSIX where pgrep is standard.
function descendants(pid) {
  if (!pid) return []
  const result = DeviceBuild.spawnPgrep(pid)
  return result.flatMap((child) => [...descendants(child), child])
}

function within(child, parent) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function clean(line) {
  return line.replace(ANSI, "").trimEnd()
}

function push(log, line) {
  log.push(line)
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
}

function lines(stream, onLine) {
  if (!stream) return
  let rest = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    const parts = (rest + chunk).split(/\r?\n/)
    rest = parts.pop() ?? ""
    for (const part of parts) onLine(part)
  })
  stream.on("end", () => {
    if (rest) onLine(rest)
  })
}
