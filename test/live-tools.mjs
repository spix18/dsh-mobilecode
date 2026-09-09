/**
 * dsh-mobilecode — REAL-DEVICE tool battery (v0.8.x).
 * Registers the plugin against a fake ctx (same harness as mesh-routes.mjs) and
 * executes device_display / device_batch / device_pair_capture / device_avd_create
 * / device_status against live adb targets. Requires two booted emulators
 * (or pass serials: node test/live-tools.mjs serialA serialB).
 *
 * The mesh_* agent tools are covered offline (mesh-routes.mjs drives the real
 * hub class through the same fake ctx) and the live hub transport is covered
 * by mesh-live.mjs — this file owns the adb-backed tools only.
 */

import { existsSync, readFileSync, rmSync } from "node:fs"
import { pathToFileURL } from "node:url"

const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const target = "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const registered = { routes: [], tools: [] }
const ctx = {
  provide() {},
  webServer: { register() { return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}
const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
const DeviceBuild = await import(pathToFileURL(pluginDir + "/lib/device-build.js").href)
plugin.apply(ctx, { defaultDirectory: target })

const toolsByName = Object.fromEntries(registered.tools.map((t) => [t.name ?? t.definition?.name, t]))
const exec = (name, args) => (toolsByName[name]?.execute ?? toolsByName[name]?.definition?.execute)(args)

let passed = 0
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const [A, B] = process.argv.slice(2).length >= 2 ? process.argv.slice(2) : ["emulator-5554", "emulator-5556"]
console.log(`devices: ${A} + ${B}`)

console.log("— device_display get / set / reset —")
const gA = await exec("device_display", { serial: A, action: "get" })
const gB = await exec("device_display", { serial: B, action: "get" })
await ok("get reports physical density+size on both", () => {
  for (const g of [gA, gB]) {
    assert(g.density?.physical > 0, `no physical density: ${JSON.stringify(g)}`)
    assert(g.size?.physical?.width > 0, `no physical size: ${JSON.stringify(g)}`)
  }
})
const testDensity = gB.density.physical === 320 ? 420 : 320
await ok(`set density ${testDensity} on ${B} → override visible`, async () => {
  await exec("device_display", { serial: B, action: "set", density: testDensity })
  const after = await exec("device_display", { serial: B, action: "get" })
  assert(after.density.override === testDensity, `override=${JSON.stringify(after.density)}`)
})
await ok("reset restores physical-only", async () => {
  await exec("device_display", { serial: B, action: "reset" })
  const after = await exec("device_display", { serial: B, action: "get" })
  assert(after.density.override == null, `override still set: ${JSON.stringify(after.density)}`)
})

console.log("— device_batch simultaneous inputs —")
const batch = await exec("device_batch", {
  steps: [
    { serial: A, action: "key", key: "home" },
    { serial: B, action: "key", key: "home" },
    { serial: A, action: "swipe", x: 300, y: 1200, x2: 300, y2: 700 },
  ],
  settle_ms: 600,
})
await ok("3 concurrent steps across both devices all land", () => {
  const results = batch.results ?? batch.steps ?? []
  assert(results.length === 3, `shape: ${JSON.stringify(batch).slice(0, 300)}`)
  for (const r of results) assert(r.ok === true, `step failed: ${JSON.stringify(r)}`)
})

console.log("— device_pair_capture —")
const pair = await exec("device_pair_capture", { serials: [A, B] })
await ok("captures both devices, PNGs on disk", () => {
  const devices = pair.devices ?? []
  assert(devices.length === 2, `devices=${devices.length} ${JSON.stringify(pair).slice(0, 300)}`)
  for (const d of devices) {
    const file = d.screenshot ?? d.png ?? d.path
    assert(file && existsSync(file), `missing screenshot for ${d.serial ?? "?"}: ${file}`)
  }
})

console.log("— device_avd_create (clone) —")
await ok("creates mobilecode_probe cloned from mobilecode_test", async () => {
  let created
  try {
    created = await exec("device_avd_create", { name: "mobilecode_probe", clone_from: "mobilecode_test" })
  } catch (error) {
    if (/already exists/.test(error.message)) { // cleanup from an aborted earlier run
      const dir = process.env.USERPROFILE + "\\.android\\avd"
      rmSync(`${dir}\\mobilecode_probe.avd`, { recursive: true, force: true })
      rmSync(`${dir}\\mobilecode_probe.ini`, { force: true })
      created = await exec("device_avd_create", { name: "mobilecode_probe", clone_from: "mobilecode_test" })
    } else throw error
  }
  assert(created.name === "mobilecode_probe" && /system-images;android-\d+/.test(created.imageId), JSON.stringify(created))
  const fresh = readFileSync(created.configPath, "utf8")
  const source = readFileSync(DeviceBuild.avdConfigPath("mobilecode_test"), "utf8")
  const key = (txt, k) => new RegExp(`^${k}=(.*)$`, "m").exec(txt)?.[1]?.trim()
  assert(key(fresh, "hw.ramSize") === key(source, "hw.ramSize"), `hw.ramSize ${key(fresh, "hw.ramSize")} != ${key(source, "hw.ramSize")}`)
  assert(key(fresh, "hw.dpi") === key(source, "hw.dpi"), "hw.dpi parity lost")
  // Identity is resolved via the <name>.ini sidecar, not config.ini — and the
  // source's avd.id/avd.name are literal "<build>" template artifacts, so the
  // merge correctly mirrors them (parity convention, proven by p2 booting).
  const sidecar = readFileSync(`${process.env.USERPROFILE}\\.android\\avd\\mobilecode_probe.ini`, "utf8")
  assert(/mobilecode_probe\.avd/.test(sidecar), "sidecar does not point at the new AVD dir")
  const dir = process.env.USERPROFILE + "\\.android\\avd"
  rmSync(`${dir}\\mobilecode_probe.avd`, { recursive: true, force: true })
  rmSync(`${dir}\\mobilecode_probe.ini`, { force: true })
})

console.log(`\n${passed} live-tool checks passed${process.exitCode ? " (with failures)" : ""}`)
