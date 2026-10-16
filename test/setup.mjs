// Offline test of lib/setup.js — settings, welcome prompt, doctor checks, fix routing.
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const setup = await import(pathToFileURL(path.join(here, "..", "lib", "setup.js")).href)

let passed = 0
const ok = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}

await ok("welcome prompt is non-empty and mentions tools", () => {
  if (!setup.WELCOME_PROMPT.includes("device_run") || !setup.WELCOME_PROMPT.includes("device_screen")) throw new Error("prompt incomplete")
})
await ok("settings round-trips", async () => {
  const before = setup.readSettings()
  const saved = setup.writeSettings({ welcomeDismissed: false })
  const read = setup.readSettings()
  await ok("written value readable", () => {
    if (read.welcomeDismissed !== false) throw new Error("welcomeDismissed not false")
  })
  // restore
  setup.writeSettings({ ...before, welcomeDismissed: before.welcomeDismissed ?? false })
})
await ok("doctor returns structured checks", async () => {
  const checks = await setup.runDoctor()
  if (!Array.isArray(checks) || checks.length === 0) throw new Error("no checks")
  for (const c of checks) {
    if (typeof c.name !== "string" || typeof c.ok !== "boolean" || typeof c.detail !== "string") throw new Error(`bad check: ${JSON.stringify(c)}`)
  }
  const ids = checks.map((c) => c.name)
  for (const expected of ["runtime", "android-sdk", "paddleocr"]) {
    if (!ids.includes(expected)) throw new Error(`missing check ${expected}: ${ids.join(",")}`)
  }
})
await ok("paddleocr check is the fixable one", async () => {
  const checks = await setup.runDoctor()
  const ocr = checks.find((c) => c.name === "paddleocr")
  if (ocr.fix !== "install") throw new Error("paddleocr should offer fix=install")
})
await ok("every actionable doctor check offers a fix that runFix recognizes", async () => {
  const checks = await setup.runDoctor()
  for (const name of ["android-sdk", "emulator", "avds", "device", "paddleocr"]) {
    const check = checks.find((c) => c.name === name)
    if (!check || typeof check.fix !== "string" || !check.fix) {
      throw new Error(`check ${name} missing fix action: ${JSON.stringify(check)}`)
    }
    const byFix = await setup.runFix(check.fix, { dryRun: true })
    if (!byFix.ok) throw new Error(`runFix rejected check.fix="${check.fix}" for ${name}: ${byFix.message}`)
    const byName = await setup.runFix(check.name, { dryRun: true })
    if (!byName.ok) throw new Error(`runFix rejected check.name="${check.name}": ${byName.message}`)
  }
  const fixAll = await setup.runFix("all", { dryRun: true })
  if (!fixAll.ok) throw new Error(`runFix rejected "all": ${fixAll.message}`)
})
await ok("ocr python version gate accepts 3.10-3.12 and rejects 3.13+/3.15", () => {
  if (typeof setup.isCompatibleOcrPythonVersion !== "function") throw new Error("isCompatibleOcrPythonVersion missing")
  if (!setup.isCompatibleOcrPythonVersion("3.12.10")) throw new Error("3.12.10 should be compatible")
  if (!setup.isCompatibleOcrPythonVersion("3.11.8")) throw new Error("3.11.8 should be compatible")
  if (!setup.isCompatibleOcrPythonVersion("3.10.11")) throw new Error("3.10.11 should be compatible")
  if (setup.isCompatibleOcrPythonVersion("3.15.0")) throw new Error("3.15.0 has no paddlepaddle/numpy<2 wheels and must be rejected")
  if (setup.isCompatibleOcrPythonVersion("3.13.2")) throw new Error("3.13.2 must be rejected for numpy<2/paddlepaddle==3.3.1")
})
await ok("inspectVenvConfig flags migrated missing home or unsupported python version", () => {
  if (typeof setup.inspectVenvConfig !== "function") throw new Error("inspectVenvConfig missing")
  const badVer = setup.inspectVenvConfig(`home = ${process.cwd()}\nversion = 3.15.0\n`)
  if (badVer.ok || !/3\.15\.0/.test(badVer.reason)) throw new Error(`expected bad version rejection, got ${JSON.stringify(badVer)}`)
  const missingHome = setup.inspectVenvConfig("home = C:\\Users\\NonExistentOldWindowsUser_99999\\Python312\nversion = 3.12.4\n")
  if (missingHome.ok || !/missing|not found/i.test(missingHome.reason)) throw new Error(`expected missing home rejection, got ${JSON.stringify(missingHome)}`)
  const validCfg = setup.inspectVenvConfig(`home = ${process.cwd()}\nversion = 3.12.8\n`)
  if (!validCfg.ok) throw new Error(`expected valid config, got ${JSON.stringify(validCfg)}`)
})
await ok("runFix rejects unknown id", async () => {
  const r = await setup.runFix("nonsense")
  if (r.ok !== false) throw new Error("should fail")
})
await ok("ocrStatus has stable shape", async () => {
  const s = await setup.ocrStatus()
  if (typeof s.installed !== "boolean" || typeof s.working !== "boolean" || !Array.isArray(s.log)) throw new Error(`bad: ${JSON.stringify(s)}`)
})
await ok("writeOcrReadme writes the file", async () => {
  setup.writeOcrReadme()
  const { existsSync } = await import("node:fs")
  if (!existsSync(setup.OCR_README)) throw new Error("readme not written")
})
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
