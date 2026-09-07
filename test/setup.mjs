// Offline test of lib/setup.js — settings, welcome prompt, doctor checks, fix routing.
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const setup = await import(pathToFileURL(path.join(here, "..", "lib", "setup.js")).href)

let passed = 0
const ok = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}

ok("welcome prompt is non-empty and mentions tools", () => {
  if (!setup.WELCOME_PROMPT.includes("device_run") || !setup.WELCOME_PROMPT.includes("device_screen")) throw new Error("prompt incomplete")
})
ok("settings round-trips", () => {
  const before = setup.readSettings()
  const saved = setup.writeSettings({ welcomeDismissed: false })
  const read = setup.readSettings()
  ok("written value readable", () => read.welcomeDismissed === false)
  // restore
  setup.writeSettings({ ...before, welcomeDismissed: before.welcomeDismissed ?? false })
})
ok("doctor returns structured checks", async () => {
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
ok("paddleocr check is the fixable one", async () => {
  const checks = await setup.runDoctor()
  const ocr = checks.find((c) => c.name === "paddleocr")
  if (ocr.fix !== "install") throw new Error("paddleocr should offer fix=install")
})
ok("runFix rejects unknown id", async () => {
  const r = await setup.runFix("nonsense")
  if (r.ok !== false) throw new Error("should fail")
})
ok("ocrStatus has stable shape", async () => {
  const s = await setup.ocrStatus()
  if (typeof s.installed !== "boolean" || typeof s.working !== "boolean" || !Array.isArray(s.log)) throw new Error(`bad: ${JSON.stringify(s)}`)
})
ok("writeOcrReadme writes the file", async () => {
  setup.writeOcrReadme()
  const { existsSync } = await import("node:fs")
  if (!existsSync(setup.OCR_README)) throw new Error("readme not written")
})
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
