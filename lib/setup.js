/**
 * dsh-mobilecode — setup services (settings store, plugin doctor, PaddleOCR & Android SDK auto-installer).
 *
 * Shared user-level state lives under ~/.dsh/mobilecode/ (same place as the OCR
 * venv), so it survives GUI restarts and is independent of the mounted copy.
 */

import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  readdirSync,
  renameSync,
  createWriteStream,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import * as DeviceBuild from "./device-build.js"

export const HOME = path.join(os.homedir(), ".dsh", "mobilecode")
const SETTINGS_FILE = path.join(HOME, "settings.json")
const OCR_LOG_FILE = path.join(HOME, "ocr-install.log")
const DOCTOR_LOG_FILE = path.join(HOME, "doctor-fix.log")
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

// ── Python & venv validation for PaddleOCR ────────────────────────────────────

const OCR_PACKAGES = ["setuptools", "wheel", "numpy<2", "paddleocr==3.7.0", "paddlepaddle==3.3.1"]
const OCR_ENV = {
  FLAGS_use_mkldnn: "0",
  PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
  PYTHONUTF8: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
}

/**
 * PaddlePaddle 3.3.1 + numpy<2 (1.26.4) ship prebuilt binary wheels for Python
 * 3.10, 3.11, and 3.12. Python 3.13+ (including 3.14/3.15) has no prebuilt wheels
 * for numpy<2 or paddlepaddle==3.3.1 and fails trying to compile from source.
 */
export function isCompatibleOcrPythonVersion(versionText) {
  const match = /(\d+)\.(\d+)/.exec(String(versionText ?? ""))
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major === 3 && (minor === 10 || minor === 11 || minor === 12)
}

/**
 * Inspect an existing ocr-venv/pyvenv.cfg to detect moved `.dsh` folders
 * (whose `home = ...` points to an old Windows user/installation) or unsupported
 * Python versions (such as Python 3.15).
 */
export function inspectVenvConfig(cfgText) {
  const text = String(cfgText ?? "")
  const grab = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "mi").exec(text)
    return m ? m[1].trim() : undefined
  }
  const home = grab("home")
  const version = grab("version") ?? grab("version_info")
  if (!home) {
    return { ok: false, home, version, reason: "pyvenv.cfg is missing the home entry" }
  }
  if (!existsSync(home)) {
    return {
      ok: false,
      home,
      version,
      reason: `venv base Python home not found (${home}) — moved from another Windows installation`,
    }
  }
  if (version && !isCompatibleOcrPythonVersion(version)) {
    return {
      ok: false,
      home,
      version,
      reason: `venv uses Python ${version}, which lacks prebuilt wheels for PaddleOCR 3.7.0 / numpy<2 (requires Python 3.10–3.12)`,
    }
  }
  return { ok: true, home, version, reason: "ok" }
}

function inspectInstalledVenv() {
  const cfgPath = path.join(HOME, "ocr-venv", "pyvenv.cfg")
  if (!existsSync(cfgPath)) return undefined
  try {
    return inspectVenvConfig(readFileSync(cfgPath, "utf8"))
  } catch {
    return undefined
  }
}

/** Find an installed Python 3.12 / 3.11 / 3.10 interpreter suitable for building ocr-venv. */
export async function findCompatibleOcrPython() {
  const probeCandidate = async (cmd, prefixArgs = []) => {
    const res = await DeviceBuild.captureFull(
      cmd,
      [...prefixArgs, "-c", "import sys; print(sys.executable + '|' + sys.version.split()[0])"],
      { timeoutMs: 10_000 },
    ).catch(() => ({ code: -1, out: "" }))
    if (res.code !== 0) return undefined
    const line = res.out.trim().split(/\r?\n/).pop() ?? ""
    const [exe, ver] = line.split("|").map((s) => s?.trim())
    if (!exe || !ver || !existsSync(exe)) return undefined
    if (/WindowsApps/i.test(exe)) return undefined
    if (!isCompatibleOcrPythonVersion(ver)) return undefined
    return { executable: exe, version: ver }
  }

  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local")
    const progFiles = process.env["ProgramFiles"] ?? "C:\\Program Files"
    const directCandidates = [
      path.join(HOME, "python312", "tools", "python.exe"),
      path.join(HOME, "python312", "python.exe"),
      path.join(localAppData, "Programs", "Python", "Python312", "python.exe"),
      path.join(localAppData, "Programs", "Python", "Python311", "python.exe"),
      path.join(localAppData, "Programs", "Python", "Python310", "python.exe"),
      path.join(progFiles, "Python312", "python.exe"),
      path.join(progFiles, "Python311", "python.exe"),
      path.join(progFiles, "Python310", "python.exe"),
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
    ]
    for (const candidate of directCandidates) {
      if (existsSync(candidate)) {
        const found = await probeCandidate(candidate)
        if (found) return found
      }
    }
    for (const tag of ["-3.12", "-3.11", "-3.10"]) {
      const found = await probeCandidate("py", [tag])
      if (found) return found
    }
  } else {
    for (const bin of [
      "python3.12",
      "python3.11",
      "python3.10",
      "/opt/homebrew/bin/python3.12",
      "/opt/homebrew/bin/python3.11",
      "/usr/local/bin/python3.12",
      "python3",
      "python",
    ]) {
      const found = await probeCandidate(bin)
      if (found) return found
    }
  }

  for (const fallback of ["python3", "python"]) {
    const found = await probeCandidate(fallback)
    if (found) return found
  }
  return undefined
}

async function downloadFile(url, destPath, logFn, label = "download") {
  logFn(`[${label}] downloading ${url}`)
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} downloading ${url}`)
  }
  const total = Number(res.headers.get("content-length") || 0)
  let received = 0
  let lastPct = -10
  const fileStream = createWriteStream(destPath)
  const reader = Readable.fromWeb(res.body)
  reader.on("data", (chunk) => {
    received += chunk.length
    if (total > 0) {
      const pct = Math.floor((received / total) * 100)
      if (pct >= lastPct + 20) {
        lastPct = pct
        logFn(`[${label}] ${pct}% (${Math.round(received / 1048576)}/${Math.round(total / 1048576)} MB)`)
      }
    }
  })
  await pipeline(reader, fileStream)
  logFn(`[${label}] saved to ${destPath}`)
}

async function extractZip(zipPath, destDir, logFn) {
  mkdirSync(destDir, { recursive: true })
  if (process.platform === "win32") {
    const tarExe = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
    if (existsSync(tarExe)) {
      const { exit } = DeviceBuild.exec(tarExe, ["-xf", zipPath, "-C", destDir], {}, logFn)
      const code = await exit
      if (code === 0) return
    }
    const { exit } = DeviceBuild.exec(
      "powershell.exe",
      [
        "-WindowStyle",
        "Hidden",
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      {},
      logFn,
    )
    const code = await exit
    if (code !== 0) throw new Error(`Failed to extract ${zipPath} (exit ${code})`)
    return
  }
  const { exit } = DeviceBuild.exec("unzip", ["-q", "-o", zipPath, "-d", destDir], {}, logFn)
  const code = await exit
  if (code !== 0) throw new Error(`unzip failed on ${zipPath} (exit ${code})`)
}

/**
 * Ensure Python 3.12 is available when no compatible Python (3.10–3.12) is present.
 * Uses the official PSF NuGet portable zip archive on Windows so no .exe/.msi
 * installer window or UAC prompt ever appears.
 */
async function ensureCompatibleOcrPython(logFn) {
  const existing = await findCompatibleOcrPython()
  if (existing) {
    logFn(`Using compatible Python ${existing.version} at ${existing.executable}`)
    return existing
  }

  if (process.platform === "win32") {
    logFn("No Python 3.10–3.12 found; downloading portable Python 3.12.10 (silent user-space archive)...")
    const nugetUrl = "https://www.nuget.org/api/v2/package/python/3.12.10"
    const zipPath = path.join(os.tmpdir(), `python-3.12.10-portable-${Date.now()}.zip`)
    const pyDest = path.join(HOME, "python312")
    try {
      await downloadFile(nugetUrl, zipPath, logFn, "python-3.12")
      rmSync(pyDest, { recursive: true, force: true })
      logFn(`Extracting portable Python 3.12.10 to ${pyDest}...`)
      await extractZip(zipPath, pyDest, logFn)
    } finally {
      try { rmSync(zipPath, { force: true }) } catch { /* ignore */ }
    }

    const afterPortable = await findCompatibleOcrPython()
    if (afterPortable) {
      logFn(`Portable Python ${afterPortable.version} ready at ${afterPortable.executable}`)
      return afterPortable
    }
  } else if (process.platform === "darwin" && DeviceBuild.commandExists("brew")) {
    logFn("Installing python@3.12 via Homebrew...")
    const { exit } = DeviceBuild.exec("brew", ["install", "python@3.12"], {}, logFn)
    await exit
    const afterBrew = await findCompatibleOcrPython()
    if (afterBrew) return afterBrew
  }

  throw new Error(
    "Could not find or auto-install Python 3.12 (required for PaddleOCR 3.7.0 / PaddlePaddle 3.3.1 wheels). Install Python 3.12 from python.org and retry.",
  )
}

// ── OCR installer ──────────────────────────────────────────────────────────────

const OCR_INSTALL_STATE = { state: "idle", log: [], done: false, failed: false, lastError: "" }

function resetOcrLog() {
  ensureHome()
  OCR_INSTALL_STATE.log = []
  try { writeFileSync(OCR_LOG_FILE, "", "utf8") } catch { /* ignore */ }
}

function ocrLog(line) {
  const clean = String(line ?? "").trimEnd()
  if (!clean) return
  OCR_INSTALL_STATE.log.push(clean)
  if (OCR_INSTALL_STATE.log.length > 200) OCR_INSTALL_STATE.log.splice(0, OCR_INSTALL_STATE.log.length - 200)
  try { appendFileSync(OCR_LOG_FILE, clean + "\n", "utf8") } catch { /* ignore */ }
}

/** True when the venv python exists AND imports paddleocr — the real "installed" test. */
export async function ocrWorking() {
  const python = DeviceBuild.ocrPython()
  if (!python) return false
  const cfgCheck = inspectInstalledVenv()
  if (cfgCheck && !cfgCheck.ok) {
    OCR_INSTALL_STATE.lastError = cfgCheck.reason
    return false
  }
  const probe = await DeviceBuild.captureFull(
    python,
    ["-c", "import paddleocr, paddle; print('ok')"],
    { timeoutMs: 30_000, env: OCR_ENV },
  ).catch((err) => ({ code: -1, out: "", err: err?.message ?? String(err) }))
  const ok = probe.code === 0 && probe.out.includes("ok")
  if (ok) {
    OCR_INSTALL_STATE.lastError = ""
  } else {
    const errTail = `${probe.err}\n${probe.out}`.trim().split(/\r?\n/).filter(Boolean).slice(-4).join(" | ")
    OCR_INSTALL_STATE.lastError = errTail || "import paddleocr, paddle failed"
  }
  return ok
}

/** Current OCR state for the UI: installed / working / install progress / failure. */
export async function ocrStatus() {
  const python = DeviceBuild.ocrPython()
  const cfgCheck = inspectInstalledVenv()
  const installing = OCR_INSTALL_STATE.state === "installing"
  const working = installing ? false : await ocrWorking()
  const brokenVenv = Boolean((python || cfgCheck) && !working && !installing)
  const out = {
    installed: Boolean(python || cfgCheck),
    working,
    state: "idle",
    log: [],
  }
  if (installing) out.state = "installing"
  else if (working) out.state = "done"
  else if (OCR_INSTALL_STATE.failed || brokenVenv) out.state = "failed"

  out.log = OCR_INSTALL_STATE.log.slice(-60)
  if (out.state === "failed" && out.log.length === 0) {
    try {
      const tail = readFileSync(OCR_LOG_FILE, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .slice(-50)
      out.log = tail
    } catch { /* no log file yet */ }
    if (cfgCheck && !cfgCheck.ok) {
      out.log.push(`[diagnostic] ${cfgCheck.reason}`)
    } else if (OCR_INSTALL_STATE.lastError) {
      out.log.push(`[diagnostic] ${OCR_INSTALL_STATE.lastError}`)
    }
  }
  return out
}

async function runOcrInstallPipeline() {
  const venv = path.join(HOME, "ocr-venv")
  ocrLog(`[dsh-mobilecode] Starting PaddleOCR setup at ${new Date().toISOString()}`)
  ocrLog(`Target venv: ${venv}`)

  const py = await ensureCompatibleOcrPython(ocrLog)

  if (existsSync(venv)) {
    ocrLog("Removing previous/broken ocr-venv for a clean rebuild...")
    try {
      rmSync(venv, { recursive: true, force: true })
    } catch (err) {
      ocrLog(`Warning removing old venv (${err.message}), falling back to --clear`)
    }
  }

  ocrLog(`Creating virtual environment with Python ${py.version}...`)
  const { exit: venvExit } = DeviceBuild.exec(py.executable, ["-m", "venv", "--clear", venv], { env: OCR_ENV }, ocrLog)
  const venvCode = await venvExit
  if (venvCode !== 0) {
    throw new Error(`venv creation exited with code ${venvCode}`)
  }

  const venvPython = process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python")
  if (!existsSync(venvPython)) {
    throw new Error(`venv python binary missing at ${venvPython}`)
  }

  ocrLog(`Installing packages: ${OCR_PACKAGES.join(" ")}...`)
  const { exit: pipExit } = DeviceBuild.exec(
    venvPython,
    ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", ...OCR_PACKAGES],
    { env: OCR_ENV },
    ocrLog,
  )
  const pipCode = await pipExit
  if (pipCode !== 0) {
    throw new Error(`pip install exited with code ${pipCode}`)
  }

  ocrLog("Verifying PaddleOCR and Paddle imports...")
  const verified = await ocrWorking()
  if (!verified) {
    throw new Error(`PaddleOCR import verification failed: ${OCR_INSTALL_STATE.lastError || "unknown import error"}`)
  }
  ocrLog("INST" + "ALL_EXIT=0")
  ocrLog("PaddleOCR installation completed and verified.")
}

/**
 * Start a background PaddleOCR install (Python 3.12 + clean venv + pip + import check).
 */
export function startOcrInstall() {
  ensureHome()
  if (OCR_INSTALL_STATE.state === "installing") return { started: false, message: "install already in progress" }
  resetOcrLog()
  OCR_INSTALL_STATE.state = "installing"
  OCR_INSTALL_STATE.done = false
  OCR_INSTALL_STATE.failed = false

  // Also write ocr-install.cmd for users who inspect ~/.dsh/mobilecode manually.
  const venv = path.join(HOME, "ocr-venv")
  const python = path.join(venv, "Scripts", "python.exe")
  const scriptFile = path.join(HOME, "ocr-install.cmd")
  const lines = [
    "@echo off",
    "setlocal",
    `py -3.12 -m venv --clear "${venv}" || (winget install -e --id Python.Python.3.12 --scope user --accept-source-agreements --accept-package-agreements --disable-interactivity && py -3.12 -m venv --clear "${venv}")`,
    `"${python}" -m pip install --disable-pip-version-check ${OCR_PACKAGES.map((p) => `"${p}"`).join(" ")}`,
  ]
  try { writeFileSync(scriptFile, lines.join("\r\n") + "\r\n", "utf8") } catch { /* ignore */ }

  ocrLog(`install started (${venv})`)

  runOcrInstallPipeline()
    .then(() => {
      OCR_INSTALL_STATE.state = "done"
      OCR_INSTALL_STATE.done = true
      OCR_INSTALL_STATE.failed = false
    })
    .catch((err) => {
      ocrLog(`ERROR: ${err instanceof Error ? err.message : String(err)}`)
      ocrLog("INST" + "ALL_EXIT=1")
      OCR_INSTALL_STATE.state = "failed"
      OCR_INSTALL_STATE.done = false
      OCR_INSTALL_STATE.failed = true
    })

  return { started: true, log: OCR_INSTALL_STATE.log.slice(-10) }
}

// ── Android SDK / Emulator / AVD auto-installer ────────────────────────────────

const DOCTOR_FIX_STATE = { state: "idle", activeFix: null, log: [], done: false, failed: false }

function resetDoctorLog() {
  ensureHome()
  DOCTOR_FIX_STATE.log = []
  try { writeFileSync(DOCTOR_LOG_FILE, "", "utf8") } catch { /* ignore */ }
}

function doctorLog(line) {
  const clean = String(line ?? "").trim()
  if (!clean) return
  // Collapse repetitive sdkmanager ASCII progress bars ([===   ] 42% Unzipping...)
  const isProgress = /^\[[=\s]+\]\s*\d+%/.test(clean)
  const prev = DOCTOR_FIX_STATE.log[DOCTOR_FIX_STATE.log.length - 1] ?? ""
  if (isProgress && /^\[[=\s]+\]\s*\d+%/.test(prev)) {
    const pctMatch = /\]\s*(\d+)%/.exec(clean)
    const prevPctMatch = /\]\s*(\d+)%/.exec(prev)
    if (pctMatch && prevPctMatch && Math.floor(Number(pctMatch[1]) / 10) === Math.floor(Number(prevPctMatch[1]) / 10)) {
      DOCTOR_FIX_STATE.log[DOCTOR_FIX_STATE.log.length - 1] = clean
      return
    }
  }
  DOCTOR_FIX_STATE.log.push(clean)
  if (DOCTOR_FIX_STATE.log.length > 250) DOCTOR_FIX_STATE.log.splice(0, DOCTOR_FIX_STATE.log.length - 250)
  try { appendFileSync(DOCTOR_LOG_FILE, clean + "\n", "utf8") } catch { /* ignore */ }
}

export function doctorFixStatus() {
  return {
    state: DOCTOR_FIX_STATE.state,
    activeFix: DOCTOR_FIX_STATE.activeFix,
    done: DOCTOR_FIX_STATE.done,
    failed: DOCTOR_FIX_STATE.failed,
    log: DOCTOR_FIX_STATE.log.slice(-60),
  }
}

function writeAndroidSdkLicenses(sdkRoot) {
  const licenseDir = path.join(sdkRoot, "licenses")
  mkdirSync(licenseDir, { recursive: true })
  const licenses = {
    "android-sdk-license": [
      "8933bad161af4178b1185d1a37fbf41ea5269c55",
      "d56f5187479451eabf01fb78af6dfcb131a6481e",
      "24333f8a63b6825ea9c5514f83c2829b004d1fee",
      "85435445a95c234340d05367a999a69d7b46701c",
    ],
    "android-sdk-preview-license": [
      "84831b9409646a918e30573bab4c9c91346d8abd",
      "504667f4c0de7af1a06de9f4b1727b84351f2910",
    ],
    "android-sdk-arm-dbt-license": ["859f317696f67ef3d7f30a50a5560e7834b43903"],
  }
  for (const [name, hashes] of Object.entries(licenses)) {
    try {
      writeFileSync(path.join(licenseDir, name), "\n" + hashes.join("\n") + "\n", "utf8")
    } catch { /* ignore */ }
  }
}

async function ensureJava17(logFn) {
  const existing = DeviceBuild.findJavaHome()
  if (existing) {
    logFn(`Found JDK at ${existing}`)
    return existing
  }

  if (process.platform === "win32") {
    const jdkZipUrl = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse"
    const zipPath = path.join(os.tmpdir(), `temurin-jdk17-${Date.now()}.zip`)
    const jdkDest = path.join(HOME, "jdk")
    try {
      await downloadFile(jdkZipUrl, zipPath, logFn, "openjdk-17")
      logFn(`Extracting portable OpenJDK 17 to ${jdkDest}...`)
      await extractZip(zipPath, jdkDest, logFn)
    } finally {
      try { rmSync(zipPath, { force: true }) } catch { /* ignore */ }
    }
    const afterPortable = DeviceBuild.findJavaHome()
    if (afterPortable) {
      logFn(`Portable JDK ready at ${afterPortable}`)
      return afterPortable
    }
  } else if (process.platform === "darwin" && DeviceBuild.commandExists("brew")) {
    logFn("Installing openjdk@17 via Homebrew...")
    const { exit } = DeviceBuild.exec("brew", ["install", "openjdk@17"], {}, logFn)
    await exit
    const afterBrew = DeviceBuild.findJavaHome()
    if (afterBrew) return afterBrew
  }

  throw new Error("Java (JDK 17+) could not be found or installed automatically.")
}

async function ensureAndroidSdkBase(logFn) {
  const sdkRoot = DeviceBuild.androidSdk() ?? DeviceBuild.defaultAndroidSdkPath()
  mkdirSync(sdkRoot, { recursive: true })
  writeAndroidSdkLicenses(sdkRoot)

  const adbExe = path.join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb")
  if (!existsSync(adbExe)) {
    const platOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
    const url = `https://dl.google.com/android/repository/platform-tools-latest-${platOs}.zip`
    const zipPath = path.join(os.tmpdir(), `platform-tools-${Date.now()}.zip`)
    try {
      await downloadFile(url, zipPath, logFn, "platform-tools")
      logFn(`Extracting platform-tools into ${sdkRoot}...`)
      await extractZip(zipPath, sdkRoot, logFn)
    } finally {
      try { rmSync(zipPath, { force: true }) } catch { /* ignore */ }
    }
  } else {
    logFn(`adb already present at ${adbExe}`)
  }

  if (!DeviceBuild.sdkmanagerBinary()) {
    await ensureJava17(logFn)
    const cmdOs = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"
    const url = `https://dl.google.com/android/repository/commandlinetools-${cmdOs}-11076708_latest.zip`
    const zipPath = path.join(os.tmpdir(), `cmdline-tools-${Date.now()}.zip`)
    const staging = path.join(os.tmpdir(), `cmdline-tools-stage-${Date.now()}`)
    try {
      await downloadFile(url, zipPath, logFn, "cmdline-tools")
      await extractZip(zipPath, staging, logFn)
      const latestDir = path.join(sdkRoot, "cmdline-tools", "latest")
      rmSync(latestDir, { recursive: true, force: true })
      mkdirSync(path.join(sdkRoot, "cmdline-tools"), { recursive: true })
      const inner = path.join(staging, "cmdline-tools")
      renameSync(existsSync(inner) ? inner : staging, latestDir)
      logFn(`Android cmdline-tools installed at ${latestDir}`)
    } finally {
      try { rmSync(zipPath, { force: true }) } catch { /* ignore */ }
      try { rmSync(staging, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  writeAndroidSdkLicenses(sdkRoot)
  return sdkRoot
}

async function runSdkManager(packages, logFn) {
  const sdkRoot = await ensureAndroidSdkBase(logFn)
  const javaHome = await ensureJava17(logFn)
  process.env["ANDROID_HOME"] = sdkRoot
  process.env["ANDROID_SDK_ROOT"] = sdkRoot
  if (javaHome) process.env["JAVA_HOME"] = javaHome

  const sdkmanager = DeviceBuild.sdkmanagerBinary()
  if (!sdkmanager) throw new Error("sdkmanager binary not found after cmdline-tools install")
  writeAndroidSdkLicenses(sdkRoot)

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    logFn(`Running sdkmanager (attempt ${attempt}/3) for: ${packages.join(", ")}...`)
    const { exit } = DeviceBuild.exec(
      sdkmanager,
      [`--sdk_root=${sdkRoot}`, ...packages],
      { env: DeviceBuild.javaEnv() },
      logFn,
    )
    const code = await exit
    if (code === 0) return
    logFn(`sdkmanager exited with code ${code} on attempt ${attempt}; cleaning partial .temp archives before retry...`)
    try { rmSync(path.join(sdkRoot, ".temp"), { recursive: true, force: true }) } catch { /* ignore */ }
    if (packages.includes("emulator") && !DeviceBuild.emulatorBinary()) {
      try { rmSync(path.join(sdkRoot, "emulator"), { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  throw new Error(`sdkmanager failed after 3 attempts for: ${packages.join(", ")}`)
}

async function ensureAndroidEmulator(logFn) {
  await ensureAndroidSdkBase(logFn)
  if (!DeviceBuild.emulatorBinary()) {
    await runSdkManager(["platform-tools", "emulator", "platforms;android-34", "build-tools;34.0.0"], logFn)
  }
  const emulator = DeviceBuild.emulatorBinary()
  if (!emulator) {
    throw new Error("Emulator binary still missing after sdkmanager install")
  }
  logFn(`Emulator ready at ${emulator}`)
}

async function ensureAndroidAvd(logFn) {
  await ensureAndroidEmulator(logFn)
  const existingAvds = await DeviceBuild.androidAvds().catch(() => [])
  if (existingAvds.length > 0) {
    logFn(`AVD already configured: ${existingAvds.join(", ")}`)
    return existingAvds[0]
  }
  let images = await DeviceBuild.installedSystemImages().catch(() => [])
  const defaultAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64"
  const targetImage = images[images.length - 1] ?? `system-images;android-34;google_apis;${defaultAbi}`
  if (!images.includes(targetImage)) {
    logFn(`Installing system image ${targetImage}...`)
    await runSdkManager([targetImage], logFn)
  }
  const avdName = "Pixel_API_34"
  logFn(`Creating default AVD "${avdName}" with ${targetImage}...`)
  try {
    await DeviceBuild.createAvd({ name: avdName, imageId: targetImage, deviceProfile: "pixel_6" })
  } catch {
    await DeviceBuild.createAvd({ name: avdName, imageId: targetImage })
  }
  logFn(`AVD "${avdName}" created.`)
  return avdName
}

async function ensureAttachedDevice(logFn) {
  await ensureAndroidSdkBase(logFn)
  const existing = (await DeviceBuild.devices().catch(() => [])).filter((d) => d.state === "device")
  if (existing.length > 0) {
    logFn(`Device already attached: ${existing.map((d) => d.serial).join(", ")}`)
    return
  }
  let avds = await DeviceBuild.androidAvds().catch(() => [])
  if (avds.length === 0) {
    const created = await ensureAndroidAvd(logFn)
    avds = [created]
  }
  const avd = avds[0]
  logFn(`Booting AVD "${avd}"...`)
  DeviceBuild.bootEmulator(avd)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const devs = (await DeviceBuild.devices().catch(() => [])).filter((d) => d.state === "device")
    if (devs.length > 0) {
      logFn(`Emulator attached as ${devs[0].serial}`)
      return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  logFn(`AVD "${avd}" launched (still completing cold boot in the background).`)
}

// ── plugin doctor ──────────────────────────────────────────────────────────────

const SYSTEM_CHECK = (name, ok, detail, fix) => ({ name, ok, detail, ...(fix ? { fix } : {}) })

/** Run every health check. Each entry: {name, ok, detail, fix?}. */
export async function runDoctor() {
  const checks = []

  // 1. Runtime: node + npm/npx reachable.
  const nodeOk = typeof process.version === "string"
  checks.push(SYSTEM_CHECK("runtime", nodeOk, `node ${process.version ?? "?"} (dsh host)`))

  // 2. Android SDK: adb + emulator binaries.
  const adbPath = DeviceBuild.adb()
  const sdkOk = !!adbPath && existsSync(adbPath)
  checks.push(
    SYSTEM_CHECK(
      "android-sdk",
      sdkOk,
      sdkOk
        ? `adb at ${adbPath}`
        : "Android SDK not found (adb missing). Click Fix to install Android SDK platform-tools & cmdline-tools automatically.",
      "android-sdk",
    ),
  )

  // 3. Emulator binary.
  const emulatorPath = DeviceBuild.emulatorBinary()
  checks.push(
    SYSTEM_CHECK(
      "emulator",
      !!emulatorPath,
      emulatorPath
        ? `emulator at ${emulatorPath}`
        : "Emulator binary not found under the Android SDK. Click Fix to install the Android Emulator automatically.",
      "emulator",
    ),
  )

  // 4. AVDs configured.
  const avds = await DeviceBuild.androidAvds().catch(() => [])
  checks.push(
    SYSTEM_CHECK(
      "avds",
      avds.length > 0,
      avds.length > 0
        ? `AVDs: ${avds.join(", ")}`
        : "No AVDs configured. Click Fix to install a system image and create a default Pixel AVD automatically.",
      "avds",
    ),
  )

  // 5. Attached device (or configured AVD ready to auto-boot on device_run).
  const devices = await DeviceBuild.devices().catch(() => [])
  const attached = devices.filter((d) => d.state === "device")
  const standbyAvdReady = sdkOk && !!emulatorPath && avds.length > 0
  checks.push(
    SYSTEM_CHECK(
      "device",
      attached.length > 0 || standbyAvdReady,
      attached.length > 0
        ? `attached: ${attached.map((d) => d.serial).join(", ")}`
        : standbyAvdReady
          ? `ready — AVD "${avds[0]}" configured (auto-boots on device_run)`
          : "No Android device attached and no AVD configured. Click Fix to set up a default Pixel AVD.",
      "device",
    ),
  )

  // 6. PaddleOCR (device_screen OCR).
  const python = DeviceBuild.ocrPython()
  const cfgCheck = inspectInstalledVenv()
  const working = await ocrWorking()
  const brokenReason = cfgCheck && !cfgCheck.ok ? cfgCheck.reason : OCR_INSTALL_STATE.lastError
  checks.push(
    SYSTEM_CHECK(
      "paddleocr",
      working,
      working
        ? `PaddleOCR ready at ${python}`
        : python || cfgCheck
          ? `PaddleOCR venv exists but imports failed (${brokenReason || "broken install"}). Click Fix to rebuild with Python 3.12.`
          : "PaddleOCR not installed — device_screen OCR is disabled. Fix installs Python 3.12 + PaddleOCR automatically.",
      "install",
    ),
  )

  // 7. OCR script reachable (part of the package).
  const scriptOk = existsSync(fileURLToPath(new URL("../scripts/ocr.py", import.meta.url)))
  checks.push(
    SYSTEM_CHECK(
      "ocr-script",
      scriptOk,
      scriptOk ? "ocr.py present in the plugin package" : "ocr.py missing — reinstall the plugin.",
    ),
  )

  return checks
}

export function resolveFixTarget(id) {
  if (id === "paddleocr" || id === "install") return "paddleocr"
  if (id === "android-sdk" || id === "emulator" || id === "avds" || id === "device" || id === "all") return id
  return undefined
}

function startDoctorBackgroundFix(target, taskFn, startMessage) {
  if (DOCTOR_FIX_STATE.state === "installing") {
    return { ok: false, message: `Doctor fix (${DOCTOR_FIX_STATE.activeFix}) is already in progress.` }
  }
  resetDoctorLog()
  DOCTOR_FIX_STATE.state = "installing"
  DOCTOR_FIX_STATE.activeFix = target
  DOCTOR_FIX_STATE.done = false
  DOCTOR_FIX_STATE.failed = false
  doctorLog(`[doctor] starting auto-fix for "${target}" at ${new Date().toISOString()}`)

  taskFn(doctorLog)
    .then(() => {
      doctorLog(`[doctor] auto-fix for "${target}" completed successfully.`)
      DOCTOR_FIX_STATE.state = "done"
      DOCTOR_FIX_STATE.done = true
      DOCTOR_FIX_STATE.failed = false
      DOCTOR_FIX_STATE.activeFix = null
    })
    .catch((err) => {
      doctorLog(`[doctor] ERROR in "${target}": ${err instanceof Error ? err.message : String(err)}`)
      DOCTOR_FIX_STATE.state = "failed"
      DOCTOR_FIX_STATE.done = false
      DOCTOR_FIX_STATE.failed = true
      DOCTOR_FIX_STATE.activeFix = null
    })

  return { ok: true, target, message: startMessage }
}

/** Try to auto-fix one check (or "all") by id. Returns {ok, target?, message}. */
export async function runFix(id, options = {}) {
  const target = resolveFixTarget(id)
  if (!target) {
    return { ok: false, message: `no automatic fix for "${id}"` }
  }
  if (options?.dryRun === true) {
    return { ok: true, target, message: `dry-run: would fix ${target}` }
  }

  if (target === "paddleocr") {
    const started = startOcrInstall()
    if (!started.started) return { ok: false, message: started.message ?? "unknown" }
    return { ok: true, target, message: "PaddleOCR install started in the background (Python 3.12 + PaddleOCR 3.7.0)." }
  }
  if (target === "android-sdk") {
    return startDoctorBackgroundFix(
      "android-sdk",
      ensureAndroidSdkBase,
      "Android SDK (platform-tools + cmdline-tools + JDK 17) installation started in the background.",
    )
  }
  if (target === "emulator") {
    return startDoctorBackgroundFix(
      "emulator",
      ensureAndroidEmulator,
      "Android Emulator installation started in the background.",
    )
  }
  if (target === "avds") {
    return startDoctorBackgroundFix(
      "avds",
      ensureAndroidAvd,
      "Android system image download & default Pixel AVD creation started in the background.",
    )
  }
  if (target === "device") {
    return startDoctorBackgroundFix(
      "device",
      async (log) => {
        const avds = await DeviceBuild.androidAvds().catch(() => [])
        if (avds.length === 0) {
          await ensureAndroidAvd(log)
          return
        }
        await ensureAttachedDevice(log)
      },
      "Ensuring Android Emulator / AVD is ready in the background.",
    )
  }
  if (target === "all") {
    if (OCR_INSTALL_STATE.state !== "installing") {
      ocrWorking().then((ok) => { if (!ok) startOcrInstall() }).catch(() => {})
    }
    return startDoctorBackgroundFix(
      "all",
      async (log) => {
        if (!(await ocrWorking())) {
          log("Ensuring PaddleOCR is installing...")
          startOcrInstall()
        }
        await ensureAndroidSdkBase(log)
        await ensureAndroidEmulator(log)
        await ensureAndroidAvd(log)
      },
      "Full silent environment setup started in the background (PaddleOCR + Android SDK + Emulator + AVD).",
    )
  }
  return { ok: false, message: `no automatic fix for "${id}"` }
}

let initialSetupTriggered = false

/**
 * Automatically and silently provision missing/broken PaddleOCR or Android SDK
 * prerequisites in the background when the plugin first loads on a machine.
 * Skipped during offline unit tests (`test/*.mjs` or `DSH_MOBILECODE_SKIP_AUTO_SETUP=1`).
 */
export function ensureInitialSetup() {
  if (initialSetupTriggered) return
  if (process.env["DSH_MOBILECODE_SKIP_AUTO_SETUP"] === "1") return
  if (/[\\/]test[\\/][^\\/]+\.mjs$/i.test(process.argv[1] ?? "")) return
  initialSetupTriggered = true

  setTimeout(async () => {
    try {
      const ocrOk = await ocrWorking()
      if (!ocrOk && OCR_INSTALL_STATE.state !== "installing") {
        startOcrInstall()
      }
      const adbPath = DeviceBuild.adb()
      const sdkOk = !!adbPath && existsSync(adbPath)
      const emulatorOk = !!DeviceBuild.emulatorBinary()
      const avds = await DeviceBuild.androidAvds().catch(() => [])
      if ((!sdkOk || !emulatorOk || avds.length === 0) && DOCTOR_FIX_STATE.state !== "installing") {
        await runFix("all")
      }
    } catch { /* background best-effort */ }
  }, 500).unref?.()
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
  "    py -3.12 -m venv --clear " + path.join(HOME, "ocr-venv"),
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
