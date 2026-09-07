/**
 * dsh-mobilecode — agent observability tools e2e (device_screen / device_log /
 * device_status). Exercises the REAL defineTool wrappers from the mounted copy
 * against the live emulator, including the strict output schema.
 *
 * Run: node test/agent-tools.mjs [serial]
 */

import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const serial = process.argv[2] ?? "emulator-5554"

const registered = { tools: [] }
const ctx = {
  provide(name, handle) { this.provided = { name, handle } },
  webServer: { register() { return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}

const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, {})

const names = ["device_screen", "device_log", "device_status", "device_input"]
let passed = 0
const ok = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}
const tool = (name) => {
  const t = registered.tools.find((x) => (x.name ?? x.definition?.name) === name)
  if (!t) throw new Error(`${name} tool not registered`)
  return t.execute ?? t.definition?.execute
}

console.log("— device_screen —")
const screen = await tool("device_screen")({ serial })
ok("serial + screenshot path returned", () => {
  if (screen.serial !== serial) throw new Error(`serial ${screen.serial}`)
  if (typeof screen.screenshot !== "string") throw new Error(`no screenshot path: ${JSON.stringify(screen)}`)
})
ok("ui hierarchy has labeled nodes", () => Array.isArray(screen.ui) && screen.ui.length > 0)
ok("paddleocr returned text with boxes", () => {
  if (!Array.isArray(screen.ocr) || screen.ocr.length === 0) throw new Error(`ocr: ${JSON.stringify(screen.ocrError ?? screen.ocr)}`)
  const item = screen.ocr[0]
  if (typeof item.text !== "string" || typeof item.confidence !== "number" || !Array.isArray(item.box)) throw new Error(`bad item: ${JSON.stringify(item)}`)
})
ok("screen dimensions present", () => typeof screen.width === "number" && typeof screen.height === "number")

console.log("— device_log —")
const log = await tool("device_log")({ serial, buffer: "crash", lines: 100 })
ok("crash buffer returns array", () => Array.isArray(log.lines) && log.buffer === "crash")
const kernel = await tool("device_log")({ serial, buffer: "kernel", lines: 50 })
ok("kernel (dmesg) non-empty", () => kernel.lines.length > 0)
const filtered = await tool("device_log")({ serial, buffer: "main", filter: "ActivityManager", lines: 50 })
ok("filter narrows results", () => filtered.lines.every((line) => line.toLowerCase().includes("activitymanager")) || filtered.lines.length === 0)

console.log("— device_status —")
const status = await tool("device_status")({})
ok("status lists the device", () => status.devices.some((d) => d.serial === serial))
ok("status lists AVDs", () => Array.isArray(status.avds) && status.avds.length > 0)

console.log("— device_input —")
const key = await tool("device_input")({ serial, action: "key", key: "home" })
ok("key action returns receipt", () => key.serial === serial && key.action === "key" && typeof key.sent === "string")
const keycode = await tool("device_input")({ serial, action: "key", key: "3" })
ok("raw keycode integer accepted", () => keycode.sent.includes("3"))
const tap = await tool("device_input")({ serial, action: "tap", x: 50, y: 50 })
ok("tap action returns receipt", () => tap.sent.includes("50") && tap.sent.includes("50"))
let threw = null
try { await tool("device_input")({ serial, action: "bogus" }) } catch (error) { threw = error }
ok("unknown action throws friendly error", () => threw !== null && /unknown action/.test(threw.message))
threw = null
try { await tool("device_input")({ serial, action: "key", key: "frobnicate" }) } catch (error) { threw = error }
ok("unknown key throws friendly error", () => threw !== null && /unknown key/.test(threw.message))

if (ctx.provided?.handle?.engine) await ctx.provided.handle.engine.dispose()
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
