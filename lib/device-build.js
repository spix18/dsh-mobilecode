/**
 * dsh-mobilecode — device-build helpers.
 *
 * Faithful plain-JS port of `mobilecode/packages/core/src/device-build.ts`
 * (hsandhu/mobilecode), with the Effect/Schema types stripped and cross-spawn
 * replaced by a self-contained spawn helper: cross-spawn is not resolvable
 * from the profile node_modules tree this plugin loads in, so `launch()`
 * re-implements its two essential behaviors — PATHEXT lookup and spawning
 * .cmd/.bat through cmd.exe on Windows.
 *
 * All functions here are async/sync pure helpers; the engine that owns
 * long-running children lives in device-preview.js.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import net from "node:net"
import os from "node:os"
import path from "node:path"

/** Resolve a bare command name to an executable file, the way a shell would. */
export function resolveExecutable(command) {
  if (!command || command.includes("/") || command.includes("\\")) return command
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  // Prefer PATHEXT matches: npm ships an extensionless `npx` shim next to npx.cmd,
  // and the bare file is not directly spawnable.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = path.join(dir, command + ext)
      if (existsSync(file)) return file
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    if (existsSync(candidate)) return candidate
  }
  return command
}

/** Quote one argument for cmd.exe: wrap in quotes, escape embedded quotes. */
function cmdArg(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`
}

/**
 * Spawn `command` with cross-spawn semantics: on Windows, `npx`, `pod`, and
 * friends are .cmd/.bat shims that must run under cmd.exe; on POSIX this is
 * a plain `spawn`.
 */
export function launch(command, args, options) {
  if (process.platform !== "win32") return spawn(command, args, options)
  const resolved = resolveExecutable(command)
  if (/\.(cmd|bat)$/i.test(resolved)) {
    // cmd.exe /c strips the outer pair of quotes only; the inner ones survive,
    // so double-wrap the whole command line ("...") with each token quoted.
    const line = [cmdArg(resolved), ...args.map(cmdArg)].join(" ")
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
      shell: false,
    })
  }
  return spawn(resolved, args, options)
}

/** Spawn a command and stream combined output line by line. */
export function exec(command, args, options, onLine) {
  const child = launch(command, args, {
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream || !onLine) continue
    let rest = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      const parts = (rest + chunk).split(/\r?\n/)
      rest = parts.pop() ?? ""
      for (const part of parts) {
        const text = part.trimEnd()
        if (text) onLine(text)
      }
    })
    stream.on("end", () => {
      if (rest.trim()) onLine(rest.trim())
    })
  }
  const exit = new Promise((resolve) => {
    child.once("error", () => resolve(-1))
    child.once("close", (code) => resolve(code ?? -1))
  })
  return { child, exit }
}

/** Run a command, capturing stdout AND stderr. Resolves {code, out, err}. */
export async function captureFull(command, args, options = {}) {
  const out = []
  const err = []
  const running = launch(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  running.stdout?.setEncoding("utf8")
  running.stderr?.setEncoding("utf8")
  running.stdout?.on("data", (chunk) => out.push(chunk))
  running.stderr?.on("data", (chunk) => err.push(chunk))
  let timer
  if (options.timeoutMs) {
    timer = setTimeout(() => running.kill(), options.timeoutMs)
    timer.unref?.()
  }
  const code = await new Promise((resolve) => {
    running.once("error", () => resolve(-1))
    running.once("close", (value) => resolve(value ?? -1))
  })
  if (timer) clearTimeout(timer)
  const text = out.join("")
  return {
    code,
    out: options.maxBytes && Buffer.byteLength(text) > options.maxBytes ? text.slice(0, options.maxBytes) : text,
    err: err.join(""),
  }
}

/** Run a command purely for its stdout, e.g. a `-json` query. Empty string on failure. */
export async function capture(command, args, options = {}) {
  const result = await captureFull(command, args, options)
  return result.code === 0 ? result.out : ""
}

/** Direct child pids of `pid`. POSIX only; returns nothing when pgrep is unavailable. */
export function spawnPgrep(pid) {
  const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
  return (result.stdout ?? "")
    .split("\n")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
}

// ── project discovery ─────────────────────────────────────────────────────────

const SKIP = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  "out",
  "target",
  "Pods",
  "DerivedData",
  ".gradle",
  ".build",
  "vendor",
  "Carthage",
])
const MAX_DEPTH = 2
const EXPO_CONFIGS = ["app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs"]
const GRADLE_MARKERS = ["settings.gradle", "settings.gradle.kts", "gradlew", "build.gradle", "build.gradle.kts"]

/**
 * Find the native project root for each platform at or below `directory`.
 * Bounded walk: agents and templates routinely nest the app one or two levels
 * down, so a listing of just the session directory misses them.
 */
export function findProjects(directory) {
  const found = new Map()
  const walk = (current, depth) => {
    const entries = read(current)
    if (entries.length === 0) return
    const names = new Set(entries.map((entry) => entry.name))
    const framework = detectFramework(current, names)
    const expo = framework === "expo"
    const here = (platform, dir, needsPrebuild = false) => ({
      platform,
      directory: dir,
      root: current,
      framework,
      needsPrebuild,
    })

    if (!found.has("ios") && process.platform === "darwin") {
      const native = entries.some((e) => e.name.endsWith(".xcodeproj") || e.name.endsWith(".xcworkspace"))
      if (native || names.has("Podfile")) found.set("ios", here("ios", current))
      else if (names.has("ios") && hasXcodeProject(path.join(current, "ios")))
        found.set("ios", here("ios", path.join(current, "ios")))
      else if (expo) found.set("ios", here("ios", current, true))
    }

    if (!found.has("android")) {
      if (GRADLE_MARKERS.some((marker) => names.has(marker))) found.set("android", here("android", current))
      else if (names.has("android") && hasGradleProject(path.join(current, "android")))
        found.set("android", here("android", path.join(current, "android")))
      else if (expo) found.set("android", here("android", current, true))
    }

    if (depth >= MAX_DEPTH) return
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith(".")) continue
      if (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")) continue
      walk(path.join(current, entry.name), depth + 1)
    }
  }
  walk(directory, 0)
  // A real native project always wins over an Expo app still needing prebuild.
  return [...found.values()].sort((a, b) => Number(a.needsPrebuild) - Number(b.needsPrebuild))
}

function read(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

function hasXcodeProject(directory) {
  return read(directory).some((entry) => entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace"))
}

function hasGradleProject(directory) {
  const names = new Set(read(directory).map((entry) => entry.name))
  return GRADLE_MARKERS.some((marker) => names.has(marker))
}

function isExpoApp(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null && "expo" in parsed
  } catch {
    return false
  }
}

/** Expo when configured as one, React Native when package.json depends on it, else native. */
export function detectFramework(directory, names) {
  const expo = names.has("app.json")
    ? isExpoApp(path.join(directory, "app.json"))
    : EXPO_CONFIGS.some((name) => names.has(name))
  const pkg = names.has("package.json") ? readPackage(directory) : undefined
  if (expo || pkg?.dependencies?.["expo"]) return "expo"
  if (pkg?.dependencies?.["react-native"]) return "react-native"
  return "native"
}

function readPackage(directory) {
  return parseJson(readText(path.join(directory, "package.json")))
}

function readText(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

// ── long-running children ─────────────────────────────────────────────────────

// Runs the command, and when this process's stdin pipe closes (which happens even when the
// parent is SIGKILLed, as Electron does to its utility processes) tears the command's whole
// tree down. Without this every app restart leaves a preview server and Metro behind.
const GUARD = `
exec 3<&0
killtree() { for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c" "$2"; done; kill "-$2" "$1" 2>/dev/null; }
"$@" &
child=$!
# serve-avd stalls its graceful shutdown while a stream is connected, so escalate after a moment.
( cat <&3 >/dev/null; killtree "$child" TERM; sleep 2; killtree "$child" KILL ) &
watcher=$!
wait "$child"
code=$?
for c in $(pgrep -P "$watcher" 2>/dev/null); do kill "$c" 2>/dev/null; done
kill "$watcher" 2>/dev/null
exit "$code"
`

/** Wrap a long-running command so it dies with us. Spawn the result with stdin as a pipe. */
export function guarded(command, args) {
  if (process.platform === "win32") return { command, args }
  return { command: "/bin/sh", args: ["-c", GUARD, "guard", command, ...args] }
}

// ── prerequisites ─────────────────────────────────────────────────────────────

const METRO_PORT = 8081

/**
 * Whether `command` is on `searchPath`. Pass the login shell's PATH: the desktop app's own PATH
 * is the bare system one, without Homebrew, so `pod` and friends look missing from it.
 */
export function commandExists(command, searchPath = process.env["PATH"]) {
  if (whichIn(searchPath, command)) return true
  const probe = process.platform === "win32" ? "where" : "which"
  return (
    spawnSync(probe, [command], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PATH: searchPath ?? process.env["PATH"] ?? "" },
    }).status === 0
  )
}

/**
 * The tools a run needs before any build starts. Returns a one-line problem with the fix, so a
 * missing SDK fails in a second with something actionable instead of minutes into a build.
 */
export function preflight(project, env) {
  const searchPath = pathEnv(env)
  if (project.framework !== "native" && !existsSync(path.join(project.root, "node_modules")))
    return `Dependencies are not installed. Run \`npm install\` in ${project.root} and try again.`
  if (project.platform === "ios") {
    if (!commandExists("xcodebuild", searchPath))
      return "Xcode was not found. Install Xcode from the App Store, then run `xcode-select --install`."
    // Only a Podfile nobody has installed needs the tool; an installed one builds without it.
    const pods = project.needsPrebuild || !podsInstalled(project.directory)
    if (pods && !commandExists("pod", searchPath))
      return "CocoaPods is not installed. Run `brew install cocoapods` (or `sudo gem install cocoapods`) and try again."
    return undefined
  }
  if (!androidSdk())
    return "Android SDK was not found. Install Android Studio, or set ANDROID_HOME to your SDK directory."
  if (!commandExists("java", searchPath))
    return "Java was not found. Install a JDK 17, for example `brew install --cask zulu@17`."
  if (!project.needsPrebuild && !gradleWrapper(project.directory)) return "No Gradle wrapper found in this project."
  return undefined
}

/** Gradle and the React Native plugin read the SDK location from the environment when there is no local.properties. */
export function androidEnv() {
  const sdk = androidSdk()
  if (!sdk || process.env["ANDROID_HOME"]) return {}
  return { ANDROID_HOME: sdk }
}

// ── Expo ──────────────────────────────────────────────────────────────────────

/**
 * `expo prebuild` prompts for the bundle identifier and package name when app.json has none, and
 * refuses to continue without a TTY. Fill in the same defaults the prompt would suggest so a fresh
 * `create-expo-app` project runs without the user editing config first.
 */
export function ensureExpoAppIds(root, platform) {
  const file = path.join(root, "app.json")
  const text = readText(file)
  if (!text) return undefined
  const parsed = parseJson(text)
  const expo = parsed?.expo
  if (!expo) return undefined
  const key = platform === "ios" ? "ios" : "android"
  const field = platform === "ios" ? "bundleIdentifier" : "package"
  const section = typeof expo[key] === "object" && expo[key] !== null ? expo[key] : {}
  if (typeof section[field] === "string") return undefined
  const slug = typeof expo["slug"] === "string" ? expo["slug"] : typeof expo["name"] === "string" ? expo["name"] : "app"
  const cleaned = slug.replace(/[^A-Za-z0-9]+/g, "").toLowerCase() || "app"
  section[field] = `com.anonymous.${cleaned}`
  expo[key] = section
  const indent = /^\s*\{\r?\n(\s+)"/.exec(text)?.[1] ?? "  "
  writeFileSync(file, JSON.stringify(parsed, null, indent) + "\n")
  return `Set expo.${key}.${field} to ${String(section[field])} in app.json`
}

/** Native project directory produced by `expo prebuild` for one platform. */
export function prebuiltDirectory(root, platform) {
  const directory = path.join(root, platform)
  const ready = platform === "ios" ? hasXcodeProject(directory) : hasGradleProject(directory)
  return ready ? directory : undefined
}

/** True when there is no Podfile, or it has been installed at least once. */
export function podsInstalled(directory) {
  if (!existsSync(path.join(directory, "Podfile"))) return true
  return existsSync(path.join(directory, "Pods", "Manifest.lock"))
}

// ── ports ─────────────────────────────────────────────────────────────────────

/**
 * First port at or above `start` that nothing on loopback is listening on. Preview servers from
 * other tools, or orphaned from an earlier opencode process, routinely hold the defaults.
 */
export async function freePort(start, span = 50) {
  for (let port = start; port < start + span; port += 1) {
    if (await available(port)) return port
  }
  return undefined
}

function available(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", () => resolve(false))
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)))
  })
}

// ── Node ──────────────────────────────────────────────────────────────────────

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

const formatVersion = (version) => `v${version.join(".")}`

/**
 * Enough of node-semver for `engines.node`: comparators, caret and tilde, x-ranges, and `||`.
 * Anything it cannot read is treated as satisfied rather than blocking a build.
 */
export function satisfies(version, range) {
  return range.split("||").some((alternative) =>
    alternative
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean)
      .every((part) => comparator(version, part)),
  )
}

function comparator(version, part) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(part)
  if (!match) return true
  const op = match[1] ?? ""
  const major = Number(match[2])
  const minor = match[3] === undefined || match[3] === "x" || match[3] === "*" ? undefined : Number(match[3])
  const patch = match[4] === undefined || match[4] === "x" || match[4] === "*" ? undefined : Number(match[4])
  const low = [major, minor ?? 0, patch ?? 0]
  // First version above everything the partial version covers: 20 → 21.0.0, 20.19 → 20.20.0.
  const next = minor === undefined ? [major + 1, 0, 0] : patch === undefined ? [major, minor + 1, 0] : low
  switch (op) {
    case ">=":
      return compare(version, low) >= 0
    case ">":
      return patch === undefined ? compare(version, next) >= 0 : compare(version, low) > 0
    case "<":
      return compare(version, low) < 0
    case "<=":
      return patch === undefined ? compare(version, next) < 0 : compare(version, low) <= 0
    case "^": {
      const upper =
        major > 0 ? [major + 1, 0, 0] : (minor ?? 0) > 0 ? [0, (minor ?? 0) + 1, 0] : [0, minor ?? 0, (patch ?? 0) + 1]
      return compare(version, low) >= 0 && compare(version, upper) < 0
    }
    case "~":
      return (
        compare(version, low) >= 0 &&
        compare(version, minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0]) < 0
      )
    default:
      return patch === undefined
        ? compare(version, low) >= 0 && compare(version, next) < 0
        : compare(version, low) === 0
  }
}

const NODE_MANIFESTS = [
  "package.json",
  "node_modules/react-native/package.json",
  "node_modules/expo/package.json",
  "node_modules/@expo/cli/package.json",
]

/** Every `engines.node` range the project and its mobile toolchain declare. All must hold. */
export function nodeRequirement(root) {
  return NODE_MANIFESTS.flatMap((file) => {
    const range = parseJson(readText(path.join(root, file)))?.engines?.node
    return typeof range === "string" && range.trim() ? [range.trim()] : []
  })
}

/**
 * Read PATH from an env object regardless of key casing. `process.env` is a
 * case-insensitive proxy on Windows, but spreading it (`{ ...process.env }`)
 * yields a plain object whose PATH key keeps the real casing (`Path`), so
 * `env["PATH"]` silently reads undefined. Fall back to the proxy when the
 * object has no PATH-like key or env is missing entirely.
 */
export function pathEnv(env) {
  if (env) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") return env[key]
    }
  }
  return process.env["PATH"]
}

function whichIn(searchPath, command) {
  const name = process.platform === "win32" ? `${command}.exe` : command
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Bin directories of Node installs from the usual version managers and Homebrew, if present. */
export function nodeInstalls() {
  const home = os.homedir()
  const roots = [
    { dir: process.env["NVM_DIR"] ?? path.join(home, ".nvm"), sub: ["versions", "node"], bin: "bin" },
    {
      dir: process.env["FNM_DIR"] ?? path.join(home, ".local", "share", "fnm"),
      sub: ["node-versions"],
      bin: "installation/bin",
    },
    { dir: path.join(home, "Library", "Application Support", "fnm"), sub: ["node-versions"], bin: "installation/bin" },
    { dir: path.join(home, ".volta", "tools", "image", "node"), sub: [], bin: "bin" },
    { dir: process.env["ASDF_DATA_DIR"] ?? path.join(home, ".asdf"), sub: ["installs", "nodejs"], bin: "bin" },
  ]
  const found = []
  for (const root of roots) {
    const parent = path.join(root.dir, ...root.sub)
    for (const entry of read(parent)) {
      if (!entry.isDirectory()) continue
      const bin = path.join(parent, entry.name, root.bin)
      if (existsSync(path.join(bin, "node"))) found.push(bin)
    }
  }
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    for (const entry of read(prefix)) {
      if (!/^node(@\d+)?$/.test(entry.name)) continue
      const bin = path.join(prefix, entry.name, "bin")
      if (existsSync(path.join(bin, "node"))) found.push(bin)
    }
  }
  return found
}

/**
 * A Node that satisfies every range: the one already on PATH when it does, otherwise the newest
 * install a version manager or Homebrew has. `bin` is the directory to put first on PATH.
 */
export async function resolveNode(ranges, env) {
  const current = whichIn(pathEnv(env), "node")
  const currentVersion = current ? parseVersion(await capture(current, ["--version"])) : undefined
  const ok = (version) => ranges.every((range) => satisfies(version, range))
  if (currentVersion && ok(currentVersion)) return { version: currentVersion }

  const candidates = []
  for (const bin of nodeInstalls()) {
    const version =
      parseVersion(path.basename(path.dirname(bin.replace(/\/installation\/bin$/, "")))) ??
      parseVersion(await capture(path.join(bin, "node"), ["--version"]))
    if (version && ok(version)) candidates.push({ bin, version })
  }
  candidates.sort((a, b) => compare(b.version, a.version))
  const best = candidates[0]
  const needs = ranges.join(" and ")
  const have = currentVersion ? `Node ${formatVersion(currentVersion)} on PATH` : "no Node on PATH"
  if (best)
    return {
      bin: best.bin,
      version: best.version,
      note: `Using Node ${formatVersion(best.version)} from ${best.bin} (${have} does not satisfy ${needs})`,
    }
  return {
    problem: `This project needs Node ${needs}, but there is ${have} and no newer Node installed. Install one (for example \`nvm install 22\`) and try again.`,
  }
}

// ── Metro ─────────────────────────────────────────────────────────────────────

export function metroPort() {
  const value = Number(process.env["RCT_METRO_PORT"])
  return Number.isInteger(value) && value > 0 ? value : METRO_PORT
}

export function metroUrl(port = metroPort()) {
  return `http://localhost:${port}`
}

/** Metro (React Native CLI and Expo alike) answers /status with `packager-status:running` once ready. */
export async function metroRunning(port = metroPort()) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    return (await response.text()).includes("packager-status:running")
  } catch {
    return false
  }
}

/** Process listening on a loopback port and its working directory, via lsof (POSIX only). */
export async function portOwner(port) {
  if (process.platform === "win32") return undefined
  const pid = Number(
    (await capture("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"]))
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^\d+$/.test(line)),
  )
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const cwd = parseLsofCwd(await capture("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))
  return { pid, cwd }
}

/** `lsof -Fn` prints one field per line: `p<pid>`, `fcwd`, `n<path>`. */
export function parseLsofCwd(output) {
  return output
    .split("\n")
    .find((line) => line.startsWith("n/"))
    ?.slice(1)
}

export function bundlerCommand(framework, port = metroPort()) {
  if (framework === "expo") return { command: "npx", args: ["expo", "start", "--dev-client", "--port", String(port)] }
  return { command: "npx", args: ["react-native", "start", "--port", String(port)] }
}

// ── iOS ───────────────────────────────────────────────────────────────────────

/** Resolve the scheme, built product and bundle id for an Xcode project. */
export async function iosTarget(directory) {
  const entries = read(directory)
  const workspace = entries.find((entry) => entry.name.endsWith(".xcworkspace"))
  const project = entries.find((entry) => entry.name.endsWith(".xcodeproj"))
  const container = workspace
    ? ["-workspace", path.join(directory, workspace.name)]
    : project
      ? ["-project", path.join(directory, project.name)]
      : undefined
  if (!container) return "No Xcode project or workspace found."

  const listed = await capture("xcodebuild", [...container, "-list", "-json"], { cwd: directory })
  const schemes = parseJson(listed)
  const scheme = pickScheme(
    schemes?.project?.schemes ?? schemes?.workspace?.schemes ?? [],
    (workspace ?? project).name,
  )
  if (!scheme) return "No shared scheme found in the Xcode project."

  const settingsOutput = await capture(
    "xcodebuild",
    [
      ...container,
      "-scheme",
      scheme,
      "-sdk",
      "iphonesimulator",
      "-configuration",
      "Debug",
      "-showBuildSettings",
      "-json",
    ],
    { cwd: directory },
  )
  const settings = parseJson(settingsOutput)?.[0]?.buildSettings
  const bundleID = settings?.["PRODUCT_BUNDLE_IDENTIFIER"]
  const products = settings?.["BUILT_PRODUCTS_DIR"]
  const product = settings?.["FULL_PRODUCT_NAME"]
  if (!bundleID || !products || !product) return "Could not read the Xcode build settings for this scheme."
  return { container, scheme, bundleID, app: path.join(products, product) }
}

// CocoaPods workspaces list Pods-* schemes next to the app: prefer the one named like the container.
function pickScheme(schemes, container) {
  const name = container.replace(/\.(xcworkspace|xcodeproj)$/, "")
  return (
    schemes.find((scheme) => scheme === name) ??
    schemes.find((scheme) => !scheme.startsWith("Pods") && !scheme.includes("Tests")) ??
    schemes[0]
  )
}

export function iosBuildArgs(target, udid) {
  return [
    ...target.container,
    "-scheme",
    target.scheme,
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,id=${udid}`,
    "-sdk",
    "iphonesimulator",
    "build",
  ]
}

/** UDID of the booted simulator, if any. */
export async function bootedSimulator() {
  const output = await capture("xcrun", ["simctl", "list", "devices", "booted", "-j"])
  const parsed = parseJson(output)
  for (const devices of Object.values(parsed?.devices ?? {})) {
    const booted = devices.find((device) => device.state === "Booted")
    if (booted) return booted.udid
  }
  return undefined
}

// ── Android ───────────────────────────────────────────────────────────────────

export function androidSdk() {
  const home = os.homedir()
  const candidates = [
    process.env["ANDROID_HOME"],
    process.env["ANDROID_SDK_ROOT"],
    // Windows installs (Android Studio default, and the common C:\Android\Sdk).
    path.join(home, "AppData", "Local", "Android", "Sdk"),
    path.join(process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "Android", "Sdk"),
    "C:\\Android\\Sdk",
    // macOS installs.
    path.join(home, "Library", "Android", "sdk"),
    path.join(home, "Android", "Sdk"),
  ]
  return candidates.find((candidate) => !!candidate && existsSync(candidate))
}

export function adb() {
  const sdk = androidSdk()
  const bundled = sdk && path.join(sdk, "platform-tools", "adb")
  const exe = bundled && existsSync(bundled) ? bundled : bundled && existsSync(`${bundled}.exe`) ? `${bundled}.exe` : undefined
  return exe ?? "adb"
}

// ── classified adb boundary (Wi-Fi resilience; pattern credited to boheastill/phone-eye) ──

/** Wi-Fi adb serials end in `ip:port` (`192.168.1.23:5555`); USB/emulator serials never do. */
export function isWifiSerial(serial) {
  return /:\d+$/.test(serial)
}

const ADB_TRANSPORT_RE = /no devices|device (?:'.*?' )?not found|device offline|device unauthorized|device still connecting|error: closed|cannot connect to daemon|failed to start daemon/i

/** Why an adb command failed: 'multi-device', 'transport' (transient — a reconnect may fix it), or undefined (real command error). */
export function classifyAdbFailure(result) {
  const text = `${result.err}\n${result.out}`
  if (/more than one device/i.test(text)) return "multi-device"
  if (ADB_TRANSPORT_RE.test(text)) return "transport"
  return undefined
}

/**
 * Commands that may be auto-replayed after a reconnect: read-only probes only.
 * Anything else (input/am/pm-mutate/install/screencap-to-file) must never
 * replay — a replayed `input tap` could double-tap a payment button.
 */
export function replaySafeAdb(args) {
  return /^(exec-out (screencap|cat|uiautomator|logcat|getprop|dumpsys)|shell (screencap|uiautomator|dumpsys|getprop|wm|settings get|pm list|ime list|cat|df|dmesg|logcat|true)|logcat( |$)|emu avd name)/.test(args.join(" "))
}

function adbFailTail(result) {
  const text = `${result.err}\n${result.out}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")
  return text.slice(-300)
}

async function adbConnect(serial) {
  const result = await captureFull(adb(), ["connect", serial], { timeoutMs: 15_000 })
  return /connected|already connected/i.test(`${result.out}\n${result.err}`)
}

/** Attach a Wi-Fi device: `adb connect <ip>:<port>`; true on success. Never throws (returns false with no side effect). */
export async function adbConnectSerial(serial) {
  return adbConnect(serial)
}

/**
 * Pair a Wi-Fi device (Android 11+ requires pairing before the first connect):
 * `adb pair <ip>:<pair-port> <code>`. Resolves when pairing succeeded.
 */
export async function adbPair(serial, code) {
  const result = await captureFull(adb(), ["pair", serial, String(code)], { timeoutMs: 20_000 })
  if (/successfully paired/i.test(`${result.out}\n${result.err}`)) return true
  throw new Error(`adb pair ${serial} failed: ${adbFailTail(result) || "no output"}`)
}

/**
 * Parse `adb mdns services` output for the pairing service the device advertises
 * while its "pair using QR code" dialog is open. Returns the `ip:port` the
 * pairing broadcast listens on, or undefined.
 */
export function parseMdnsPairing(output) {
  const line = String(output).split(/\r?\n/).find((row) => row.includes("_adb-tls-pairing._tcp"))
  if (line === undefined) return undefined
  const address = /(\d{1,3}(?:\.\d{1,3}){3}:\d+)/.exec(line)?.[1] ?? /(\[[0-9a-f:]+\]:\d+)/.exec(line)?.[1]
  return address ?? undefined
}

/** A Wi-Fi QR code the device scanner accepts: `WIFI:T:ADB;S:<name>;P:<password>;;`. */
export function generateQrAdbWifi(name, password) {
  return `WIFI:T:ADB;S:${name};P:${password};;`
}

/**
 * Poll `adb mdns services` until the phone's pairing dialog advertises
 * `_adb-tls-pairing._tcp` (resolves to its `ip:port`), or undefined on timeout.
 * Requires adb with mdns support (>= 31). Non-serial, read-only.
 */
export async function waitForMdnsPairing(timeoutMs = 60_000, pollMs = 1_500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await captureFull(adb(), ["mdns", "services"], { timeoutMs: 5_000 }).catch(() => null)
    if (result && result.code === 0) {
      const address = parseMdnsPairing(result.out)
      if (address !== undefined) return address
    }
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

const QR_NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
/** Random ADB QR name (ADB_WIFI_xxxxxxxxxxxxxx-yyyyyy) + 21-char password, matching Android's own structure. */
export function randomQrCredentials(prefix = "ADB_WIFI") {
  const pick = (n) => Array.from({ length: n }, () => QR_NAME_CHARS[Math.floor(Math.random() * QR_NAME_CHARS.length)]).join("")
  return { name: `${prefix}_${pick(14)}-${pick(6)}`, password: pick(21) }
}

/**
 * The single classified boundary for every serial-targeted adb command.
 * On a transient transport failure with a Wi-Fi serial (ip:port) it attempts
 * exactly one `adb connect`; only read-only commands are then replayed, while
 * side-effectful ones raise "reconnected — call again". USB serials get a
 * classified, actionable message instead of an empty result.
 */
export async function adbRun(serial, args, options = {}) {
  const argv = ["-s", serial, ...args]
  let result = await captureFull(adb(), argv, options)
  if (result.code === 0) return result.out
  const kind = classifyAdbFailure(result)
  if (kind === "multi-device") throw new Error("adb: more than one device/emulator attached — pass an explicit serial (see adb devices)")
  if (kind !== "transport" || !isWifiSerial(serial)) {
    throw new Error(kind === "transport"
      ? `device ${serial} unreachable (${adbFailTail(result)}). For Wi-Fi adb run: adb connect <ip>:5555`
      : `adb ${String(args[0])} failed on ${serial} (exit ${result.code}): ${adbFailTail(result)}`)
  }
  if (!(await adbConnect(serial))) {
    throw new Error(`device ${serial} unreachable — adb connect failed; check the phone's Wi-Fi IP or replug USB once`)
  }
  if (!replaySafeAdb(args)) {
    throw new Error(`device ${serial} reconnected over Wi-Fi; command not auto-replayed (side effects) — call again`)
  }
  result = await captureFull(adb(), argv, options)
  if (result.code !== 0) throw new Error(`device ${serial} still failing after reconnect (exit ${result.code}): ${adbFailTail(result)}`)
  return result.out
}

/** Quote one value for the device shell (`adb shell` rejoins argv through sh -c): '…' with ' → '\''; control chars refused. */
export function shQuoteDevice(text) {
  if (/[\x00-\x1f]/.test(text)) throw new Error(`refusing control characters in adb shell argument: ${JSON.stringify(text.slice(0, 40))}`)
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Build the `am start` argv from intent parts; values are device-shell quoted so metacharacters stay inert. */
export function adbIntentArgs({ action, uri, component } = {}) {
  const parts = ["shell", "am", "start"]
  for (const [flag, value] of [["-a", action], ["-d", uri], ["-n", component]]) {
    if (value === undefined || String(value) === "") continue
    parts.push(flag, shQuoteDevice(String(value)))
  }
  return parts
}

// ── perf / app-info parsers (pattern credited to newborne/dsh-adb-ultimate) ──

/** Parse `cat /proc/meminfo` into {totalKb, availableKb, usedKb, usedPercent}. */
export function parseMeminfo(output) {
  const grab = (name) => {
    const match = new RegExp(`^${name}:\\s*(\\d+)`, "m").exec(String(output))
    return match ? Number(match[1]) : undefined
  }
  const totalKb = grab("MemTotal")
  const availableKb = grab("MemAvailable")
  if (totalKb === undefined) return undefined
  const usedKb = availableKb === undefined ? undefined : totalKb - availableKb
  return {
    totalKb,
    availableKb,
    usedKb,
    usedPercent: usedKb !== undefined && totalKb > 0 ? Math.round((usedKb / totalKb) * 1000) / 10 : undefined,
  }
}

/** Parse `dumpsys battery` into {level, temperatureC, status, health, powered}. */
export function parseBattery(output) {
  const grab = (name) => {
    const match = new RegExp(`^\\s*${name}:\\s*(.+)`, "m").exec(String(output))
    return match ? match[1].trim() : undefined
  }
  const levelRaw = grab("level")
  const tempRaw = grab("temperature")
  const level = levelRaw ? Number(levelRaw) : undefined
  const tempRawNum = tempRaw ? Number(tempRaw) : undefined
  return {
    level,
    temperatureC: tempRawNum !== undefined && Number.isFinite(tempRawNum) ? Math.round(tempRawNum) / 10 : undefined,
    status: grab("status"),
    health: grab("health"),
    powered: grab("AC powered") === "true" || grab("USB powered") === "true" || grab("Wireless powered") === "true",
  }
}

/** Parse `cat /proc/cpuinfo` into {cores, hardware}. */
export function parseCpuinfo(output) {
  const text = String(output)
  const cores = (text.match(/^processor\s*:/gm) ?? []).length
  const hardware = /^Hardware\s*:\s*(.+)$/m.exec(text)?.[1]?.trim()
  return { cores: cores > 0 ? cores : undefined, hardware }
}

/**
 * Deep-clean a parsed value for a DSH tool output: drop `undefined` keys (and
 * undefined array holes) and turn non-finite numbers into `null`, so the value
 * round-trips JSON losslessly (DSH rejects outputs that lose keys/values on
 * serialize). Leaves everything else untouched; primitives pass through.
 */
export function jsonSafe(value) {
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      if (item !== undefined) out.push(jsonSafe(item))
    }
    return out
  }
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = jsonSafe(item)
    }
    return out
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null
  return value
}

/**
 * Parse `dumpsys meminfo <pkg>` into {totalPssKb, totalRssKb, totalSwapPssKb,
 * appSummary, topCategories}. The dumpsys layout (Android 10+):
 *   - "TOTAL PSS:" / "TOTAL RSS:" / "TOTAL SWAP PSS:" summary line;
 *   - "App Summary" section with one line per heap bucket (Java/Native/Code/
 *     Stack/Graphics), first column = PSS total;
 *   - a category breakdown whose rows are `  Name  pss  privDirty  privClean  swapDirty`
 *     (heap rows add Heap Size/Alloc/Free columns). Rows are only EVIDENCE:
 *     the parser keeps the top PSS rows and drops header/dashed/TOTAL lines.
 * Returns undefined when the requested process is absent ("No process found").
 */
export function parsePackageMeminfo(output) {
  const text = String(output)
  const blockIndex = text.indexOf("** MEMINFO in pid")
  if (blockIndex < 0) return undefined
  const grab = (name) => {
    const match = new RegExp(`${name}:\\s*([\\d,]+)`, "m").exec(text)
    return match ? Number(match[1].replace(/,/g, "")) : undefined
  }
  const summary = {
    totalPssKb: grab("TOTAL PSS"),
    totalRssKb: grab("TOTAL RSS"),
    totalSwapPssKb: grab("TOTAL SWAP PSS"),
  }
  // App Summary: capture the PSS column of the five heap buckets.
  const appSummary = {}
  for (const [key, rowName] of [["javaHeapKb", "Java Heap"], ["nativeHeapKb", "Native Heap"], ["codeKb", "Code"], ["stackKb", "Stack"], ["graphicsKb", "Graphics"]]) {
    const line = text.split(/\r?\n/).find((item) => new RegExp(`^\\s+${rowName}:`).test(item) && /\d/.test(item))
    const match = line ? /:\s+([\d,]+)/.exec(line) : undefined
    if (match) appSummary[key] = Number(match[1].replace(/,/g, ""))
  }
  // Category breakdown: `  Name  pss  privDirty  privClean  swapDirty [+3 heap cols]`.
  const categories = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s{2,}([A-Za-z.][A-Za-z0-9. _()\/-]*?)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/.exec(line)
    if (!match) continue
    const name = match[1].trim()
    if (!name || name === "TOTAL" || /^[-\s]+$/.test(name) || /^(Pss|Private|Swap|Size|Alloc|Free)$/.test(name)) continue
    const pss = Number(match[2].replace(/,/g, ""))
    if (seen.has(name)) continue
    seen.add(name)
    categories.push({ name, pssKb: pss })
  }
  categories.sort((l, r) => r.pssKb - l.pssKb)
  return {
    ...summary,
    appSummary: Object.keys(appSummary).length > 0 ? appSummary : undefined,
    topCategories: categories.slice(0, 10),
  }
}

/** Parse `dumpsys package <pkg>` into {versionName, versionCode, minSdk, targetSdk, permissions, activities}. */
export function parseAppInfo(output, packageName) {
  const text = String(output)
  const grab = (name) => {
    const match = new RegExp(`${name}=(\\S+)`, "m").exec(text)
    return match ? match[1] : undefined
  }
  const permissions = []
  const textLines = text.split(/\r?\n/)
  const headerIndex = textLines.findIndex((line) => line.trim() === "requested permissions:")
  if (headerIndex >= 0) {
    for (let i = headerIndex + 1; i < textLines.length; i += 1) {
      const trimmed = textLines[i].trim()
      if (trimmed === "" || !/^(android\.permission\.|com\.[^\s]+\.permission\.)[A-Z0-9_.]+$/.test(trimmed)) break
      permissions.push(trimmed)
    }
  }
  const activities = []
  const resolverIndex = textLines.findIndex((line) => line.trim() === "Activity Resolver Table:")
  if (resolverIndex >= 0) {
    // Real resolver-table rows are `<hex> pkg/.Activity filter <hex>` (or `pkg/.Activity (hex)`):
    //  5f60459 com.android.settings/.Settings$ApnEditorActivity filter 4e9281e
    // MIME-type headers (vnd.android.cursor.item/telephony-carrier:) contain a `-` so the
    // component class [\w.$]+ cannot span it, keeping them out of the match.
    for (let i = resolverIndex + 1; i < textLines.length && activities.length < 20; i += 1) {
      const match = /([A-Za-z_][\w.$]*\/[\w.$]+)\s+(?:filter\s+[0-9a-f]+|\([0-9a-f]+\))/i.exec(textLines[i].trim())
      if (match && !activities.includes(match[1])) activities.push(match[1])
    }
  }
  return {
    package: packageName,
    versionName: grab("versionName"),
    versionCode: grab("versionCode"),
    minSdk: grab("minSdk"),
    targetSdk: grab("targetSdk"),
    permissions: [...new Set(permissions)].slice(0, 60),
    activities: activities.slice(0, 20),
  }
}

/** SDK emulator binary (emulator.exe on Windows), or undefined. */
export function emulatorBinary() {
  const sdk = androidSdk()
  if (!sdk) return undefined
  const candidate = path.join(sdk, "emulator", process.platform === "win32" ? "emulator.exe" : "emulator")
  return existsSync(candidate) ? candidate : undefined
}

/** Names of configured AVDs (`emulator -list-avds`), empty on any failure. */
export async function androidAvds() {
  const emulator = emulatorBinary()
  if (!emulator) return []
  const output = await capture(emulator, ["-list-avds"])
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^INFO|^WARN/i.test(line))
}

/** True once the serial has finished booting (sys.boot_completed == 1). */
export async function androidBooted(serial) {
  const output = await adbRun(serial, ["shell", "getprop", "sys.boot_completed"]).catch(() => "")
  return output.trim() === "1"
}

/** AVD name of an emulator serial (`adb emu avd name`); undefined for physical/offline. */
export async function avdName(serial) {
  const output = await adbRun(serial, ["emu", "avd", "name"]).catch(() => "")
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !/^OK$/i.test(item) && !/^KO:/i.test(item))
  return line && /^[A-Za-z0-9._-]+$/.test(line) ? line : undefined
}

/** Poll until sys.boot_completed == 1 or the timeout; true when booted. */
export async function waitForBoot(serial, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await androidBooted(serial)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** Launch an AVD detached (survives this process); undefined when no emulator binary. */
export function bootEmulator(avd) {
  const emulator = emulatorBinary()
  if (!emulator || !/^[A-Za-z0-9._-]+$/.test(avd)) return undefined
  const child = launch(emulator, ["-avd", avd], { stdio: "ignore", detached: true })
  child.unref?.()
  return child
}

/** True when the ADBKeyboard IME is installed (the only way to type non-ASCII over adb). */
export async function adbKeyboardReady(serial) {
  const output = await adbRun(serial, ["shell", "ime", "list", "-s"]).catch(() => "")
  return /com\.android\.adbkeyboard/i.test(output)
}

/** Type one string via the ADBKeyboard broadcast (base64, so any codepoint survives the shell). */
export async function typeViaAdbKeyboard(serial, text) {
  const msg = Buffer.from(text, "utf8").toString("base64")
  await adbRun(serial, ["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", msg])
}

/** True when every codepoint is safe for `adb shell input text` (printable ASCII, no shell metachars). */
export function isAsciiInput(text) {
  return [...text].every((ch) => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) <= 0x7e)
}

/** Escape one `input text` argument for the device shell: backslash the metachars, spaces to %s. */
export function escapeInputText(text) {
  return text.replace(/[\\()<>|;&*~"'`$#!{}[\]]/g, "\\$&").replace(/ /g, "%s")
}

function aapt2() {
  const sdk = androidSdk()
  if (!sdk) return undefined
  const root = path.join(sdk, "build-tools")
  const versions = read(root)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const version of versions) {
    const candidate = path.join(root, version, process.platform === "win32" ? "aapt2.exe" : "aapt2")
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Serial of the first attached device, if any. */
export async function androidDevice() {
  const output = await capture(adb(), ["devices"])
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .find((parts) => parts[1]?.trim() === "device")?.[0]
}

/** Primary CPU ABI of a device, e.g. `arm64-v8a`. */
export async function androidAbi(serial) {
  const output = await adbRun(serial, ["shell", "getprop", "ro.product.cpu.abi"]).catch(() => "")
  const abi = output.trim()
  return /^[a-z0-9_-]+$/i.test(abi) ? abi : undefined
}

/** Free space on the device's data partition in megabytes, when `df` reports it. */
export async function androidFreeMb(serial) {
  return parseFreeMb(await adbRun(serial, ["shell", "df", "-k", "/data"]).catch(() => ""))
}

/** Second line of `df -k`: Filesystem 1K-blocks Used Available Use% Mounted. */
export function parseFreeMb(output) {
  const row = output.trim().split("\n")[1]?.trim().split(/\s+/)
  const available = Number(row?.[3])
  return Number.isFinite(available) && available >= 0 ? Math.round(available / 1024) : undefined
}

/** The reason adb gives for a failed install, e.g. `INSTALL_FAILED_INSUFFICIENT_STORAGE`. */
export function installFailure(log) {
  for (const line of [...log].reverse()) {
    const match = /Failure \[([^\]]+)\]/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

/**
 * React Native's Gradle plugin builds every ABI listed in `reactNativeArchitectures`. A debug
 * build for one known device only needs its own, which cuts build time and the APK by about 3x.
 */
export function reactNativeArchitectureArgs(abi) {
  return abi ? [`-PreactNativeArchitectures=${abi}`] : []
}

export function gradleWrapper(directory) {
  const wrapper = path.join(directory, process.platform === "win32" ? "gradlew.bat" : "gradlew")
  return existsSync(wrapper) ? wrapper : undefined
}

/** Application module name from settings.gradle, defaulting to `app`. */
export function androidModule(directory) {
  for (const name of ["settings.gradle", "settings.gradle.kts"]) {
    const file = path.join(directory, name)
    if (!existsSync(file)) continue
    const includes = [...readFileSync(file, "utf8").matchAll(/include\s*\(?\s*["']:?([A-Za-z0-9_\-.]+)["']/g)].map(
      (match) => match[1],
    )
    if (includes.includes("app")) return "app"
    const first = includes[0]
    if (first) return first
  }
  return "app"
}

export function androidApk(directory, module) {
  const outputs = path.join(directory, module, "build", "outputs", "apk", "debug")
  const apk = read(outputs)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".apk"))
    .sort((a, b) => a.name.length - b.name.length)[0]
  return apk ? path.join(outputs, apk.name) : undefined
}

/** Package name and launch activity, read from the built APK when possible. */
export async function androidApp(apk, directory, module) {
  const tool = aapt2()
  if (tool) {
    const badging = await capture(tool, ["dump", "badging", apk])
    const id = /package: name='([^']+)'/.exec(badging)?.[1]
    const activity = /launchable-activity: name='([^']+)'/.exec(badging)?.[1]
    if (id) return { id, activity }
  }
  // Fallback for SDKs without build-tools: read the Gradle config directly.
  for (const name of ["build.gradle", "build.gradle.kts"]) {
    const file = path.join(directory, module, name)
    if (!existsSync(file)) continue
    const source = readFileSync(file, "utf8")
    const id = /applicationId\s*=?\s*["']([^"']+)["']/.exec(source)?.[1]
    if (!id) continue
    const suffix = /applicationIdSuffix\s*=?\s*["']([^"']+)["']/.exec(source)?.[1] ?? ""
    return { id: id + suffix }
  }
  return undefined
}

function parseJson(value) {
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

// ── agent observability (screen / logs / ocr) ────────────────────────────────

/** Serial of the first attached device, or undefined. Same as androidDevice() but exported for tools. */

/** Attached devices as [{serial, state}], state filtering optional. */
export async function devices(serial) {
  const output = await capture(adb(), ["devices"])
  const rows = output
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((parts) => parts[0] && parts[0] !== "List")
    .map((parts) => ({ serial: parts[0], state: (parts[1] ?? "").trim() || "unknown" }))
  return serial ? rows.filter((row) => row.serial === serial) : rows
}

/** Local path of a fresh screenshot of the serial. undefined on failure. */
export async function screenCapture(serial, outDir) {
  const remote = "/sdcard/dsh-mobilecode-shot.png"
  await adbRun(serial, ["shell", "screencap", "-p", remote])
  const name = `screen-${serial}-${Date.now()}.png`
  const local = path.join(outDir ?? os.tmpdir(), name)
  const pulled = await new Promise((resolve) => {
    const child = launch(adb(), ["-s", serial, "pull", remote, local], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    })
    child.once("error", () => resolve(false))
    child.once("close", (code) => resolve(code === 0))
  })
  return pulled && existsSync(local) ? local : undefined
}

/**
 * The current view hierarchy as a compact list: [{text, resourceId, bounds}],
 * skipping empty containers. Uses uiautomator dump (works on any app that
 * exposes accessibility — the same data the logcat plugin's ui_dump reads).
 */
export async function uiDump(serial) {
  const remote = "/sdcard/dsh-mobilecode-ui.xml"
  await adbRun(serial, ["shell", "uiautomator", "dump", remote])
  const xml = await adbRun(serial, ["shell", "cat", remote])
  const items = []
  const node = /<node[^>]*>/g
  for (const match of xml.match(node) ?? []) {
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(match)?.[1] ?? ""
    const text = attr("text").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    const desc = attr("content-desc").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    const label = text || desc
    if (!label) continue
    const resourceId = attr("resource-id")
    const bounds = attr("bounds")
    const item = { text: label }
    if (resourceId && resourceId !== "") item.resourceId = resourceId
    const box = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds)
    if (box) item.bounds = [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])]
    items.push(item)
  }
  return items
}

/** Foreground activity, e.g. "com.foo/.MainActivity", or undefined. */
export async function foregroundActivity(serial) {
  const output = await adbRun(serial, ["shell", "dumpsys", "activity", "activities"]).catch(() => "")
  const line = output.split("\n").find((item) => /topResumedActivity|mResumedActivity/.test(item))
  const match = /ActivityRecord\{[^}]*\s([^\s}]+)\}/.exec(line ?? "")
  return match?.[1] ?? undefined
}

/** Kernel log (dmesg). Requires adb root — works on emulators, usually not on real devices. */
export async function dmesg(serial) {
  return adbRun(serial, ["shell", "dmesg"])
}

/** logcat snapshot, filtered by buffer/level/package-like substring. */
export async function logcat(serial, { buffer = "main", lines = 200, filter } = {}) {
  const args = ["logcat", "-d", "-t", String(lines)]
  if (buffer && buffer !== "all") args.push("-b", buffer)
  let output = await adbRun(serial, args)
  if (filter) output = output.split("\n").filter((line) => line.toLowerCase().includes(filter.toLowerCase())).join("\n")
  return output
}

/** Path to the PaddleOCR venv python, or undefined. Env override wins, then the shared ~/.dsh location. */
export function ocrPython() {
  const override = process.env["DSH_MOBILECODE_OCR_PY"]
  if (override && existsSync(override)) return override
  const home = path.join(os.homedir(), ".dsh", "mobilecode", "ocr-venv", "Scripts", "python.exe")
  return existsSync(home) ? home : undefined
}

/** OCR one image with PaddleOCR: [{text, confidence, box:[x1,y1,x2,y2]}]. Empty on failure. */
export async function ocrImage(pngPath, lang = "ch") {
  const python = ocrPython()
  if (!python) return []
  const script = fileURLToPath(new URL("../scripts/ocr.py", import.meta.url))
  if (!existsSync(script)) return []
  const output = await capture(python, [script, pngPath, lang])
  // PaddleOCR may interleave progress bars with the JSON on stdout; take the last JSON line.
  const lines = output.split(/\r?\n/).reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    const parsed = parseJson(trimmed)
    if (Array.isArray(parsed?.items)) return parsed.items
    break
  }
  return []
}
