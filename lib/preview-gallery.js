/**
 * dsh-mobilecode — Compose preview gallery (Feature B/T5, primary path per
 * docs/design/render-adapter-decision.md: official com.android.compose.screenshot
 * 0.0.1-alpha16, host-rendered via layoutlib).
 *
 * Discovery reads the app's screenshotTest source; rendering runs the Gradle
 * task with ARGUMENT ARRAYS through the existing safe launcher; every result
 * carries provenance (renderer, command, exit, timestamps, source-vs-output
 * mtimes). A stale/failed render is never labeled current.
 *
 * Host-rendered previews do NOT prove real-device behavior.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import * as DeviceBuild from "./device-build.js"

/**
 * Kill the whole process tree (audit phase-3 low (b)): child.kill() on the
 * cmd.exe shim would orphan the Gradle JVM; taskkill /T takes the tree.
 */
function killTree(child) {
  if (child?.pid === undefined) return
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }) } catch { /* already gone */ }
  } else {
    try { child.kill("SIGKILL") } catch { /* already gone */ }
  }
}

export const RENDER_TIMEOUT_MS = 10 * 60_000
export const MAX_RENDER_TIMEOUT_MS = 30 * 60_000
const MAX_TAIL_LINES = 200

/** Adapter availability for a project (drives the capability report). */
export function previewSupportStatus(appDir) {
  const wrapper = !!DeviceBuild.gradleWrapper(appDir)
  const screenshotTest = wrapper && moduleNames(appDir).some((m) => existsSync(path.join(appDir, m, "src", "screenshotTest")))
  return { wrapper, screenshotTest }
}

/** Recursively list .kt files under dir. */
function ktFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...ktFiles(p))
    else if (entry.isFile() && entry.name.endsWith(".kt")) out.push(p)
  }
  return out
}

/**
 * Discover @PreviewTest entries in one app dir. Returns [] when the module has
 * no screenshotTest source (adapter not set up — caller reports that honestly).
 * Entry: {module, package, className, fqClass, method, previewName, widthDp, sourceFile, sourceMtime}
 *
 * `warnings` (optional array): parse limitations are SURFACED, not hidden —
 * line-based parsing covers the common one-line-annotation form; any
 * @PreviewTest marker that produced no entry (multi-line annotations,
 * `private fun`, annotation on the same line as `fun`, …) adds a warning
 * (audit phase-3 low: single-line assumption must be visible to users/agents).
 */
export function discoverPreviewTests(appDir, warnings = []) {
  const entries = []
  for (const moduleName of moduleNames(appDir)) {
    const srcDir = path.join(appDir, moduleName, "src", "screenshotTest")
    for (const file of ktFiles(srcDir)) {
      let text
      try { text = readFileSync(file, "utf8") } catch { continue }
      const pkg = /package\s+([\w.]+)/.exec(text)?.[1] ?? ""
      const lines = text.split(/\r?\n/)
      let currentClass = ""
      let pending = []
      let markerLines = 0
      for (const line of lines) {
        const t = line.trim()
        if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue
        if (t.startsWith("@")) { pending.push(t); if (t.startsWith("@PreviewTest")) markerLines += 1; continue }
        const cm = /^class\s+(\w+)/.exec(t)
        if (cm) { currentClass = cm[1]; pending = []; continue }
        const fm = /^(?:public\s+|internal\s+)?fun\s+(\w+)\s*[<(]/.exec(t)
        if (fm) {
          if (pending.some((p) => p.startsWith("@PreviewTest"))) {
            // single-line @Preview(...) only; "@Preview(" guard matters —
            // plain startsWith("@Preview") would match @PreviewTest first
            const previewAnn = pending.find((p) => p.startsWith("@Preview("))
            entries.push({
              module: moduleName,
              package: pkg,
              className: currentClass,
              fqClass: pkg ? `${pkg}.${currentClass}` : currentClass,
              method: fm[1],
              previewName: previewAnn ? /name\s*=\s*"([^"]*)"/.exec(previewAnn)?.[1] ?? fm[1] : fm[1],
              widthDp: previewAnn ? Number(/widthDp\s*=\s*([\d.]+)/.exec(previewAnn)?.[1]) || undefined : undefined,
              sourceFile: file,
              sourceMtime: safeMtime(file),
            })
          }
          pending = []
          continue
        }
        pending = []
      }
      const found = entries.filter((e) => e.sourceFile === file).length
      if (markerLines > found) {
        warnings.push(`${path.relative(appDir, file).replaceAll("\\", "/")}: ${markerLines} @PreviewTest marker(s) but ${found} parsed — unsupported shapes (multi-line @Preview(, annotations on the fun line, private fun) are NOT discovered; keep the common layout: each annotation alone on its line, @Preview(...) on one line`)
      }
    }
  }
  return entries
}

function safeMtime(p) { try { return statSync(p).mtimeMs } catch { return 0 } }

/** Modules declared in settings.gradle(.kts) (fallback: app). */
function moduleNames(appDir) {
  for (const name of ["settings.gradle", "settings.gradle.kts"]) {
    const file = path.join(appDir, name)
    if (!existsSync(file)) continue
    const includes = [...readFileSync(file, "utf8").matchAll(/include\s*\(?\s*["']:?([\w:.\-]+)["']/g)].map((m) => m[1].replaceAll(/[.:]/g, path.sep))
    if (includes.length > 0) return [...new Set(includes)]
  }
  return ["app"]
}

/** Locate the recorded reference PNG for an entry (engine names <method>_<PreviewName>_<hash>_0.png). */
export function referencePng(appDir, entry) {
  const pkgPath = entry.package.replaceAll(".", path.sep)
  const dir = path.join(appDir, entry.module, "src", `screenshotTestDebug${path.sep}reference${path.sep}${pkgPath}${path.sep}${entry.className}`)
  if (!existsSync(dir)) return undefined
  try {
    const hit = readdirSync(dir).find((f) => f.startsWith(`${entry.method}_`) && f.endsWith(".png"))
    if (!hit) return undefined
    const p = path.join(dir, hit)
    return { pngPath: p, mtime: safeMtime(p) }
  } catch { return undefined }
}

/** Honest render state: PNG existence + manifest-based freshness (never timestamp-only). */
export function renderState(appDir, entry, { fingerprint = null, manifestDir = defaultManifestDir() } = {}) {
  const found = referencePng(appDir, entry)
  if (!found) return { rendered: false, stale: true, freshness: "never_rendered" }
  const m = readManifest(manifestDir, appDir, entry)
  const f = readFailure(manifestDir, appDir, entry)
  let freshness
  if (m === undefined) freshness = "unknown" // legacy/external render — no manifest, no claim
  else if (f !== undefined && f.at > (m.at ?? 0)) freshness = "last_run_failed"
  else if (fingerprint === null) freshness = "unknown"
  else freshness = fingerprint === m.inputsFingerprint ? "fresh_tracked_inputs" : "stale_inputs_changed"
  return {
    rendered: true, pngPath: found.pngPath, renderedAt: found.mtime,
    stale: freshness !== "fresh_tracked_inputs",
    freshness,
    manifest: m,
    limitations: freshness === "fresh_tracked_inputs"
      ? ["fresh only for TRACKED inputs (module sources, build files, version catalog); external deps, JDK/layoutlib and fonts are NOT covered"]
      : [],
  }
}

// ── render manifest (audit §4: timestamp-only freshness is not a currency proof) ──

export function defaultManifestDir() {
  return path.join(os.homedir(), ".dsh", "mobilecode", "preview-manifests")
}

function keyFor(appDir, entry) {
  return crypto.createHash("sha256").update(String(appDir)).digest("hex").slice(0, 16) + "--" + `${entry.fqClass}.${entry.method}`.replaceAll(/[^A-Za-z0-9_.]/g, "_")
}

/**
 * Fingerprint of the render's relevant inputs: every file under the scanned
 * module(s)' src trees (path+size+mtime), the module build files, settings
 * files, gradle.properties and the version catalog. Shared-token / resource /
 * build-config edits change it even when the preview's own file does not.
 */
export function inputsFingerprint(appDir) {
  const hash = crypto.createHash("sha256")
  const add = (file) => {
    try { const st = statSync(file); hash.update(`${path.relative(appDir, file)}|${st.size}|${Math.round(st.mtimeMs)}\n`) } catch { /* missing file contributes nothing */ }
  }
  for (const moduleName of moduleNames(appDir)) {
    const srcRoot = path.join(appDir, moduleName, "src")
    if (existsSync(srcRoot)) for (const f of walkFiles(srcRoot)) add(f)
    add(path.join(appDir, moduleName, "build.gradle.kts"))
    add(path.join(appDir, moduleName, "build.gradle"))
  }
  for (const f of ["settings.gradle.kts", "settings.gradle", "gradle.properties", path.join("gradle", "libs.versions.toml")]) add(path.join(appDir, f))
  return hash.digest("hex")
}

function walkFiles(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkFiles(p))
    else if (e.isFile()) out.push(p)
  }
  return out.sort()
}

function manifestFile(dir, appDir, entry) { return path.join(dir, keyFor(appDir, entry) + ".json") }
function failureFile(dir, appDir, entry) { return path.join(dir, keyFor(appDir, entry) + ".failure.json") }
/** Exported so tools/tests can read or seed manifest state without reimplementing the key. */
export function manifestPathFor(appDir, entry, dir = defaultManifestDir()) { return manifestFile(dir, appDir, entry) }
export function failurePathFor(appDir, entry, dir = defaultManifestDir()) { return failureFile(dir, appDir, entry) }

function readManifest(dir, appDir, entry) {
  try { return JSON.parse(readFileSync(manifestFile(dir, appDir, entry), "utf8")) } catch { return undefined }
}
function readFailure(dir, appDir, entry) {
  try { return JSON.parse(readFileSync(failureFile(dir, appDir, entry), "utf8")) } catch { return undefined }
}
function writeJsonFile(dir, appDir, entry, fileFn, payload) {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(fileFn(dir, appDir, entry), JSON.stringify(payload, null, 2) + "\n", "utf8") } catch { /* marker best-effort; missing manifest → unknown freshness */ }
}

/** Argument array for one-method render (no shell string anywhere). */
export function buildRenderArgs(entry) {
  return [`:${entry.module}:updateDebugScreenshotTest`, "--tests", `${entry.fqClass}.${entry.method}`, "--console=plain"]
}

function classifyFailure(lines, exitCode) {
  const text = lines.join("\n")
  if (exitCode === 124) return "timeout"
  if (/No tests found for given includes|did not match any tests/i.test(text)) return "discovery"
  if (/Compilation error|e: file:\/\//i.test(text)) return "compilation"
  if (/There were failing tests|FAILED/i.test(text)) return "render"
  return exitCode === 0 ? "none" : "unknown"
}

// one live gradle render per directory (a second concurrent invocation would
// race the same task); ponytail: in-memory only — single-process server by design
const liveRenders = new Map()

/**
 * Render one discovered preview. Resolves an envelope:
 * {status: passed|failed|blocked, failureKind, tail, provenance}
 * Never throws for operational failures; missing prerequisites → "blocked".
 * A successful run records a manifest (inputs fingerprint + renderer + runId);
 * a failed/cancelled run records a failure marker that IMMEDIATELY invalidates
 * the previous success state (audit §4) while the older PNG stays visible,
 * labeled.
 */
export async function renderPreviewTest(appDir, entry, { timeoutMs = RENDER_TIMEOUT_MS, onLine, manifestDir = defaultManifestDir() } = {}) {
  const wrapper = DeviceBuild.gradleWrapper(appDir)
  if (!wrapper) return { status: "blocked", reason: "no gradlew wrapper in directory — not a Gradle project", provenance: { directory: appDir } }
  if (!existsSync(path.join(appDir, entry.module, "src", "screenshotTest"))) {
    return { status: "blocked", reason: `module ${entry.module} has no screenshotTest source — apply the adapter first (docs/design/render-adapter-decision.md)`, provenance: { directory: appDir } }
  }
  const capped = Math.min(Math.max(timeoutMs || RENDER_TIMEOUT_MS, 10_000), MAX_RENDER_TIMEOUT_MS)
  const args = buildRenderArgs(entry)
  const startedAt = new Date().toISOString()
  const tail = []
  const push = (line) => { tail.push(line.slice(0, 300)); if (tail.length > MAX_TAIL_LINES) tail.shift(); onLine?.(line) }
  if (liveRenders.has(appDir)) {
    return { status: "blocked", reason: "another preview render is already running for this directory", provenance: { directory: appDir } }
  }
  liveRenders.set(appDir, args.join("\0"))
  try {
    const { child, exit } = DeviceBuild.exec(wrapper, args, { cwd: appDir }, push)
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { killTree(child); resolve(124) }, capped)
      exit.then((code) => { clearTimeout(timer); resolve(code) })
    })
    const finishedAt = new Date().toISOString()
    const state = renderState(appDir, entry, { manifestDir })
    const failureKind = classifyFailure(tail, exitCode)
    const passed = exitCode === 0 && state.rendered && !state.stale
    const runId = crypto.randomBytes(8).toString("hex")
    if (passed) {
      writeJsonFile(manifestDir, appDir, entry, manifestFile, {
        runId, at: finishedAt, exitCode,
        inputsFingerprint: inputsFingerprint(appDir),
        renderer: "com.android.compose.screenshot 0.0.1-alpha16 (layoutlib, host-rendered)",
        command: args.join(" "),
      })
    } else {
      // invalidate immediately — even a cancelled/timed-out run marks state untrusted
      writeJsonFile(manifestDir, appDir, entry, failureFile, { at: finishedAt, exitCode, failureKind, runId })
    }
    return {
      status: passed ? "passed" : "failed",
      failureKind: exitCode === 0 ? (state.rendered ? (state.stale ? "stale-after-render" : "none") : "discovery") : failureKind,
      exitCode,
      tail: tail.slice(-40),
      provenance: {
        renderer: "compose-preview-screenshot-testing (layoutlib, host-rendered) — NOT device-verified",
        command: `${path.basename(wrapper)} ${args.join(" ")}`,
        argumentArray: args,
        directory: appDir,
        startedAt, finishedAt, runId: passed ? runId : undefined,
        pngPath: state.pngPath,
        renderedAt: state.renderedAt ? new Date(state.renderedAt).toISOString() : undefined,
        freshness: state.freshness,
        stale: state.stale,
      },
    }
  } finally {
    liveRenders.delete(appDir)
  }
}
