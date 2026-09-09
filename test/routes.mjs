/**
 * dsh-mobilecode — HTTP wire-contract test. Loads the mounted plugin's
 * lib/index.js with a stub ctx, captures the registered route handlers, and
 * drives each one with a real-shaped req/res: GET info, POST start/stop,
 * run/run-stop, focus, plus the loopback guard. This is the exact contract
 * the browser pane and the client.js fetch calls rely on.
 *
 * Run: node test/routes.mjs [directory]
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const registered = { routes: [], tools: [], sections: [] }
const ctx = {
  provide(name, handle) { this.provided = { name, handle } },
  webServer: {
    register(route) { registered.routes.push(route); return () => {} },
    registerUpgrade(upgrade) { return () => {} },
  },
  tools: {
    register(tool) { registered.tools.push(tool); return () => {} },
  },
  systemPrompt: {
    section(section) { registered.sections.push(section); return () => {} },
  },
  effect(fn) { return fn() },
}

const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: target })

/** Drive one route handler with a request made of real-shaped objects. */
async function call(route, { method = "GET", query = "", body, remoteAddress = "127.0.0.1", host = "localhost:3080", extraHeaders = {} } = {}) {
  const req = {
    method,
    url: route.path + query,
    headers: { host, ...extraHeaders },
    socket: { remoteAddress },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]
      let i = 0
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      }
    },
  }
  let status = 0
  let json
  const res = {
    writeHead(code) { status = code },
    end(text) { try { json = JSON.parse(text) } catch { json = text } },
  }
  await route.handler(req, res)
  return { status, json }
}

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

const byPath = (p) => registered.routes.find((r) => r.path === p)

console.log("— GET info —")
{
  const r = await call(byPath("/api/dsh-mobilecode"), { query: "?directory=" + encodeURIComponent(target) })
  ok("GET info → 200 with platforms", () => {
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    if (!Array.isArray(r.json.platforms) || r.json.platforms.length === 0) throw new Error("no platforms")
    if (!Array.isArray(r.json.servers) || !Array.isArray(r.json.builds)) throw new Error("read model incomplete")
  })
  ok("GET info carries deviceCount (0.10.0 pill data source)", () => {
    // devices() is real adb in-process; undefined only when adb is absent entirely.
    if (r.json.deviceCount !== undefined && !Number.isInteger(r.json.deviceCount)) throw new Error(`deviceCount ${typeof r.json.deviceCount}`)
  })
}

console.log("— loopback guard —")
{
  const evil = await call(byPath("/api/dsh-mobilecode"), { remoteAddress: "203.0.113.5", host: "evil.example" })
  ok("non-loopback GET → 403", () => { if (evil.status !== 403) throw new Error(`status ${evil.status}`) })
  const spoof = await call(byPath("/api/dsh-mobilecode"), { remoteAddress: "127.0.0.1", host: "evil.example" })
  ok("loopback addr + foreign host → 403", () => { if (spoof.status !== 403) throw new Error(`status ${spoof.status}`) })
  const okHost = await call(byPath("/api/dsh-mobilecode"), { remoteAddress: "127.0.0.1", host: "localhost:3080" })
  ok("loopback addr + localhost host → 200", () => { if (okHost.status !== 200) throw new Error(`status ${okHost.status}`) })
}

console.log("— POST actions (no-op paths return current info) —")
{
  const stop = await call(byPath("/api/dsh-mobilecode/stop"), { method: "POST", body: { directory: target, platform: "android" } })
  ok("POST stop → 200 + info", () => { if (stop.status !== 200) throw new Error(`status ${stop.status}`) })
  const runStop = await call(byPath("/api/dsh-mobilecode/run/stop"), { method: "POST", body: { directory: target, platform: "android" } })
  ok("POST run/stop → 200 + info", () => { if (runStop.status !== 200) throw new Error(`status ${runStop.status}`) })
  const focus = await call(byPath("/api/dsh-mobilecode/focus"), { method: "POST", body: { directory: target } })
  ok("POST focus → 200 + info", () => { if (focus.status !== 200) throw new Error(`status ${focus.status}`) })
  const bad = await call(byPath("/api/dsh-mobilecode/run"), { method: "POST", body: { directory: target } })
  ok("POST run without platform → 400", () => { if (bad.status !== 400) throw new Error(`status ${bad.status}`) })
  const wrongMethod = await call(byPath("/api/dsh-mobilecode/start"), { method: "GET" })
  ok("GET on POST route → 405", () => { if (wrongMethod.status !== 405) throw new Error(`status ${wrongMethod.status}`) })
}

console.log("— POST /boot — the merged Start-server action (0.10.0) —")
{
  const route = byPath("/api/dsh-mobilecode/boot")
  ok("boot route registered", () => { if (!route) throw new Error("/boot missing") })
  const BROWSER = { origin: "http://localhost:3080", "sec-fetch-site": "same-origin" }
  const missing = await call(route, { method: "POST", body: {}, extraHeaders: BROWSER })
  ok("POST /boot without avd → 400", () => { if (missing.status !== 400) throw new Error(`status ${missing.status}`) })
  const badName = await call(route, { method: "POST", body: { avd: "; rm -rf" }, extraHeaders: BROWSER })
  ok("POST /boot shell-ish avd name → 400 (never spawned)", () => { if (badName.status !== 400) throw new Error(`status ${badName.status}`) })
  const unknown = await call(route, { method: "POST", body: { avd: "no_such_avd_xyz" }, extraHeaders: BROWSER })
  ok("POST /boot unknown AVD → 400", () => { if (unknown.status !== 400) throw new Error(`status ${unknown.status}`) })
  const noFence = await call(route, { method: "POST", body: { avd: "x" } })
  ok("POST /boot without browser headers → 403", () => { if (noFence.status !== 403) throw new Error(`status ${noFence.status}`) })
  const wrongMethod = await call(route, { method: "GET", extraHeaders: BROWSER })
  ok("GET /boot → 405", () => { if (wrongMethod.status !== 405) throw new Error(`status ${wrongMethod.status}`) })
}

console.log("— setup routes (welcome / doctor / ocr / settings) —")
{
  const welcome = await call(byPath("/api/dsh-mobilecode/welcome"))
  ok("GET welcome → 200 with prompt + show flag", () => {
    if (welcome.status !== 200) throw new Error(`status ${welcome.status}`)
    if (typeof welcome.json.show !== "boolean") throw new Error("show flag missing")
    if (!/device_run/.test(welcome.json.prompt ?? "")) throw new Error("prompt missing tools")
  })
  const dismiss = await call(byPath("/api/dsh-mobilecode/welcome/dismiss"), { method: "POST", body: {} })
  ok("POST welcome/dismiss → 200 ok", () => {
    if (dismiss.status !== 200 || dismiss.json.ok !== true) throw new Error(`status ${dismiss.status}`)
  })
  const welcomeAfter = await call(byPath("/api/dsh-mobilecode/welcome"))
  ok("welcome show=false after dismiss", () => {
    if (welcomeAfter.json.show !== false) throw new Error("dismiss not persisted")
  })
  const doctor = await call(byPath("/api/dsh-mobilecode/doctor"))
  ok("GET doctor → 200 with checks array", () => {
    if (doctor.status !== 200) throw new Error(`status ${doctor.status}`)
    if (!Array.isArray(doctor.json.checks) || doctor.json.checks.length === 0) throw new Error("no checks")
    for (const c of doctor.json.checks) {
      if (typeof c.name !== "string" || typeof c.ok !== "boolean") throw new Error(`bad check: ${JSON.stringify(c)}`)
    }
  })
  const fixUnknown = await call(byPath("/api/dsh-mobilecode/doctor/fix"), { method: "POST", body: { id: "nope" } })
  ok("POST doctor/fix unknown id → ok:false", () => {
    if (fixUnknown.status !== 200 || fixUnknown.json.ok !== false) throw new Error(`status ${fixUnknown.status}`)
  })
  const ocr = await call(byPath("/api/dsh-mobilecode/ocr"))
  ok("GET ocr → 200 with state", () => {
    if (ocr.status !== 200) throw new Error(`status ${ocr.status}`)
    if (typeof ocr.json.installed !== "boolean" || typeof ocr.json.working !== "boolean") throw new Error("ocr shape wrong")
  })
  const settings = await call(byPath("/api/dsh-mobilecode/settings"))
  ok("GET settings → 200 object", () => {
    if (settings.status !== 200 || typeof settings.json !== "object") throw new Error(`status ${settings.status}`)
  })
  const settingsPost = await call(byPath("/api/dsh-mobilecode/settings"), { method: "POST", body: { defaultDirectory: target } })
  ok("POST settings persists defaultDirectory", () => {
    if (settingsPost.status !== 200 || settingsPost.json.defaultDirectory !== target) throw new Error(`status ${settingsPost.status}`)
  })
  const settingsRead = await call(byPath("/api/dsh-mobilecode/settings"))
  ok("settings round-trip", () => {
    if (settingsRead.json.defaultDirectory !== target) throw new Error("not persisted")
  })
}

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)

// Self-cleaning: remove the settings file written above so a real GUI still
// sees first-run state (welcome shown, no persisted default directory).
try {
  const { rmSync } = await import("node:fs")
  const { HOME } = await import(pathToFileURL(pluginDir + "/lib/setup.js").href)
  rmSync(path.join(HOME, "settings.json"), { force: true })
} catch { /* setup module unavailable — nothing to clean */ }
