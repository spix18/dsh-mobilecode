/**
 * dsh-mobilecode — setup services (settings store, plugin doctor, PaddleOCR installer).
 *
 * Shared user-level state lives under ~/.dsh/mobilecode/ (same place as the OCR
 * venv), so it survives GUI restarts and is independent of the mounted copy.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as DeviceBuild from "./device-build.js"

export const HOME = path.join(os.homedir(), ".dsh", "mobilecode")
const SETTINGS_FILE = path.join(HOME, "settings.json")
const OCR_LOG_FILE = path.join(HOME, "ocr-install.log")
export const OCR_README = path.join(HOME, "OCR-INSTALL.md")

export function ensureHome() {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true })
}

// ── settings ──────────────────────────────────────────────────────────────────

export function readSettings() {
  ensureHome()
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))
  } catch {
    return {}
  }
}

export function writeSettings(patch) {
  ensureHome()
  const next = { ...readSettings(), ...patch }
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8")
  } catch {
    /* read-only home — settings degrade to in-memory */
  }
  return next
}

// ── OCR installer ──────────────────────────────────────────────────────────────

const OCR_PACKAGES = ["setuptools", "wheel", "numpy<2", "paddleocr==3.7.0", "paddlepaddle==3.3.1"]
const OCR_INSTALL_STATE = { state: "idle", log: [], done: false, failed: false } // in-memory + log file

function ocrLog(line) {
  OCR_INSTALL_STATE.log.push(line)
  if (OCR_INSTALL_STATE.log.length > 200) OCR_INSTALL_STATE.log.splice(0, OCR_INSTALL_STATE.log.length - 200)
  try { appendFileSync(OCR_LOG_FILE, line + "\n", "utf8") } catch { /* ignore */ }
}

/** True when the venv python exists AND imports paddleocr — the real "installed" test. */
export async function ocrWorking() {
  const python = DeviceBuild.ocrPython()
  if (!python) return false
  const probe = await DeviceBuild.capture(python, ["-c", "import paddleocr, paddle; print('ok')"]).catch(() => "")
  return probe.includes("ok")
}

/** Current OCR state for the UI: installed / working / install progress / failure. */
export async function ocrStatus() {
  const python = DeviceBuild.ocrPython()
  const working = await ocrWorking()
  const state = OCR_INSTALL_STATE.state
  const out = { installed: !!python, working, state: "idle", log: [] }
  if (OCR_INSTALL_STATE.failed) out.state = "failed"
  else if (state === "installing") out.state = "installing"
  else if (working) out.state = "done"
  out.log = OCR_INSTALL_STATE.log.slice(-60)
  if (out.state === "failed" && out.log.length === 0) {
    try {
      const tail = readFileSync(OCR_LOG_FILE, "utf8").split("\n").slice(-60)
      out.log = tail
    } catch { /* no log file yet */ }
  }
  return out
}

/**
 * Start a detached PaddleOCR install (venv + pip) that survives GUI restarts.
 * Writes an install script to disk and spawns it via cmd.exe, so the chain
 * keeps running even if dsh exits. The script appends to OCR_LOG_FILE so
 * status can always be recovered by a later GUI.
 */
export function startOcrInstall() {
  ensureHome()
  if (OCR_INSTALL_STATE.state === "installing") return { started: false, message: "install already in progress" }
  OCR_INSTALL_STATE.state = "installing"
  OCR_INSTALL_STATE.done = false
  OCR_INSTALL_STATE.failed = false
  OCR_INSTALL_STATE.log = []

  const venv = path.join(HOME, "ocr-venv")
  const python = path.join(venv, "Scripts", "python.exe")
  const scriptFile = path.join(HOME, "ocr-install.cmd")
  const lines = [
    "@echo off",
    "setlocal",
    `echo [dsh-mobilecode] OCR install started %date% %time% >> "${OCR_LOG_FILE}"`,
    `echo venv: ${venv} >> "${OCR_LOG_FILE}"`,
    `py -3.12 -m venv "${venv}" >> "${OCR_LOG_FILE}" 2>&1 || py -3 -m venv "${venv}" >> "${OCR_LOG_FILE}" 2>&1 || python -m venv "${venv}" >> "${OCR_LOG_FILE}" 2>&1`,
    `"${python}" -m pip install --disable-pip-version-check ${OCR_PACKAGES.map((p) => `"${p}"`).join(" ")} >> "${OCR_LOG_FILE}" 2>&1`,
    `echo INSTALL_EXIT=%ERRORLEVEL% >> "${OCR_LOG_FILE}"`,
  ]
  try {
    writeFileSync(scriptFile, lines.join("\r\n"), "utf8")
  } catch (error) {
    OCR_INSTALL_STATE.state = "failed"
    OCR_INSTALL_STATE.failed = true
    return { started: false, message: `cannot write install script: ${error.message}` }
  }

  const child = spawn("cmd.exe", ["/c", scriptFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()

  ocrLog(`install started (script ${scriptFile})`)
  OCR_INSTALL_STATE.state = "installing"

  // The detached child writes INSTALL_EXIT=<code> to the log; poll for it.
  const poll = setInterval(async () => {
    try {
      const log = readFileSync(OCR_LOG_FILE, "utf8")
      if (/INSTALL_EXIT=0/.test(log)) {
        clearInterval(poll)
        OCR_INSTALL_STATE.state = "done"
        OCR_INSTALL_STATE.done = true
        ocrLog("install completed")
      } else if (/INSTALL_EXIT=[1-9]/.test(log)) {
        clearInterval(poll)
        OCR_INSTALL_STATE.state = "failed"
        OCR_INSTALL_STATE.failed = true
        ocrLog("install failed (see log above)")
      }
    } catch { /* log not written yet */ }
  }, 2000)
  poll.unref?.()

  return { started: true, log: OCR_INSTALL_STATE.log.slice(-10) }
}

// ── plugin doctor ──────────────────────────────────────────────────────────────

const SYSTEM_CHECK = (name, ok, detail, fix) => ({ name, ok, detail, ...(fix ? { fix } : {}) })

/** Run every health check. Each entry: {id, name, ok, detail, fix?}. */
export async function runDoctor() {
  const checks = []

  // 1. Runtime: node + npm/npx reachable.
  const nodeOk = typeof process.version === "string"
  checks.push(SYSTEM_CHECK("runtime", nodeOk, `node ${process.version ?? "?"} (dsh host)`))

  // 2. Android SDK: adb + emulator binaries.
  const adbPath = DeviceBuild.adb()
  const sdkOk = !!adbPath && existsSync(adbPath)
  checks.push(SYSTEM_CHECK("android-sdk", sdkOk, sdkOk ? `adb at ${adbPath}` : "Android SDK not found (adb missing). Install Android Studio or set ANDROID_HOME."))

  // 3. Emulator binary.
  const emulatorPath = DeviceBuild.emulatorBinary()
  checks.push(SYSTEM_CHECK("emulator", !!emulatorPath, emulatorPath ? `emulator at ${emulatorPath}` : "Emulator binary not found under the Android SDK."))

  // 4. AVDs configured.
  const avds = await DeviceBuild.androidAvds().catch(() => [])
  checks.push(SYSTEM_CHECK("avds", avds.length > 0, avds.length > 0 ? `AVDs: ${avds.join(", ")}` : "No AVDs configured. Create one in Android Studio (Device Manager)."))

  // 5. Attached device (live runs need one).
  const devices = await DeviceBuild.devices().catch(() => [])
  const attached = devices.filter((d) => d.state === "device")
  checks.push(SYSTEM_CHECK("device", attached.length > 0, attached.length > 0 ? `attached: ${attached.map((d) => d.serial).join(", ")}` : "No Android device attached. device_run auto-boots an AVD when one is configured."))

  // 6. PaddleOCR (device_screen OCR) — the only auto-fixable check.
  const python = DeviceBuild.ocrPython()
  const working = await ocrWorking()
  checks.push(SYSTEM_CHECK("paddleocr", working,
    working ? `PaddleOCR ready at ${python}` : python ? "PaddleOCR venv exists but imports failed (broken install)." : "PaddleOCR not installed — device_screen OCR is disabled. Fix installs it automatically.",
    "install"))

  // 7. OCR script reachable (part of the package).
  const scriptOk = existsSync(fileURLToPath(new URL("../scripts/ocr.py", import.meta.url)))
  checks.push(SYSTEM_CHECK("ocr-script", scriptOk, scriptOk ? "ocr.py present in the plugin package" : "ocr.py missing — reinstall the plugin."))

  return checks
}

/** Try to auto-fix one check by id. Returns {ok, message}. */
export async function runFix(id) {
  if (id === "paddleocr") {
    const started = startOcrInstall()
    if (!started.started) return { ok: false, message: started.message ?? "unknown" }
    return { ok: true, message: "PaddleOCR install started in the background. Check OCR status in a minute." }
  }
  return { ok: false, message: `no automatic fix for "${id}"` }
}

// ── welcome / ai prompt ────────────────────────────────────────────────────────

/** The straight-to-the-point prompt shown on first run; copy-paste into any AI. */
export const WELCOME_PROMPT = [
  "You have the dsh-mobilecode plugin, which controls the iOS Simulator / Android Emulator on this machine — the same as the device pane's Play button.",
  "",
  "Tools:",
  "- device_detect <directory>: which platforms (ios/android) a project supports and what is attached. Use first when a project may be mobile.",
  "- device_run {action: run|stop|status, platform: ios|android|all, directory}: build, install and launch the app (auto-boots the emulator; minutes).",
  "- device_screen: screenshot PNG + UI hierarchy + local PaddleOCR text, each with ABSOLUTE pixel boxes (e.g. 1080x2400). See what is on screen.",
  "- device_input {action: tap|swipe|text|key, x, y, ...}: act at absolute pixel coordinates — take the center of a device_screen box: x=(x1+x2)/2, y=(y1+y2)/2.",
  "- device_log {buffer: main|crash|events|kernel, filter}: logcat + kernel dmesg. Use when a run fails or the app misbehaves.",
  "- device_status: one snapshot of attached devices, AVDs, running builds, Metro and preview servers.",
  "",
  "Recommended loop: device_detect → device_run → device_screen → device_input → device_screen (verify the change).",
  "When something breaks, device_log (crash buffer, or filter by the app package) tells you why.",
  "Coordinates are deterministic physical pixels; always re-read the screen right before acting.",
].join("\n")

export const OCR_SETUP_README = [
  "# PaddleOCR — dsh-mobilecode",
  "",
  "`device_screen` OCR is powered by a fully local PaddleOCR venv at:",
  "",
  "    " + path.join(HOME, "ocr-venv"),
  "",
  "Installed automatically via the Settings → Doctor / PaddleOCR page (one click), or manually:",
  "",
  "    py -3.12 -m venv " + path.join(HOME, "ocr-venv"),
  "    " + path.join(HOME, "ocr-venv", "Scripts", "python.exe") + " -m pip install setuptools wheel \"numpy<2\" \"paddleocr==3.7.0\" \"paddlepaddle==3.3.1\"",
  "",
  "Paddle 3.x on Windows needs oneDNN disabled (ocr.py passes enable_mkldnn=False);",
  "with that, 3.7.0 works and reads text better than the old 2.7.3 pin (PP-OCRv6 models).",
  "Set DSH_MOBILECODE_OCR_PY to override the venv location.",
].join("\n")

export function writeOcrReadme() {
  ensureHome()
  try { writeFileSync(OCR_README, OCR_SETUP_README, "utf8") } catch { /* ignore */ }
}
