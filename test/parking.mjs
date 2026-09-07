/**
 * dsh-mobilecode — parking/focus test. Runs the native project, then the Expo
 * project (which must park the native one — one project at a time), then
 * focuses the native project back. Verifies Metro bundler state transitions.
 * Run: node test/parking.mjs
 */
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const native = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"
const expo = process.argv[3] ?? "C:\\Users\\Administrator\\Desktop\\mobilecode-example"

import { pathToFileURL } from "node:url"
const registered = { tools: [] }
const ctx = {
  provide() {},
  webServer: { register() { return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}
const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: native })
const deviceRun = registered.tools.find((t) => t.name === "device_run" || t.definition?.name === "device_run")
const execute = deviceRun.execute ?? deviceRun.definition?.execute

let passed = 0
const ok = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}
const buildFor = (out, platform) => (out.builds ?? []).find((b) => b.platform === platform)

console.log("— run native (parks nothing) —")
const nativeRun = await execute({ action: "run", platform: "android", directory: native, timeout: 600000 })
ok("native running", () => {
  const b = buildFor(nativeRun, "android")
  if (!b || b.status !== "running") throw new Error(`status ${b?.status}`)
})

console.log("— run Expo (must park native) —")
const expoRun = await execute({ action: "run", platform: "android", directory: expo, timeout: 900000 })
ok("expo running after parking native", () => {
  const b = buildFor(expoRun, "android")
  if (!b || b.status !== "running") throw new Error(`status ${b?.status}`)
})

console.log("— status: exactly one project active —")
const status = await execute({ action: "status", platform: "all", directory: expo })
ok("only expo active after parking", () => {
  const running = (status.builds ?? []).filter((b) => b.status === "running" || b.status === "building")
  if (running.length !== 1) throw new Error(`expected 1 active build, got ${running.length}`)
  if (running[0].platform !== "android") throw new Error(`active build platform ${running[0].platform}`)
})
const nativeStatus = await execute({ action: "status", platform: "all", directory: native })
ok("native parked (not running) after expo took over", () => {
  const parked = (nativeStatus.builds ?? []).find((b) => b.platform === "android")
  if (!parked) throw new Error("no native build record")
  if (parked.status === "running" || parked.status === "building") throw new Error(`native still ${parked.status}`)
})

console.log("— focus native back —")
const focused = await execute({ action: "run", platform: "android", directory: native, timeout: 600000 })
ok("native running again after focus", () => {
  const b = buildFor(focused, "android")
  if (!b || b.status !== "running") throw new Error(`status ${b?.status}`)
})
const status2 = await execute({ action: "status", platform: "all", directory: native })
ok("native is the single active build again", () => {
  const running = (status2.builds ?? []).filter((b) => b.status === "running" || b.status === "building")
  if (running.length !== 1) throw new Error(`expected 1 active build, got ${running.length}`)
  if (running[0].platform !== "android") throw new Error(`active build platform ${running[0].platform}`)
})
const expoStatus = await execute({ action: "status", platform: "all", directory: expo })
ok("expo parked after native focus", () => {
  const parked = (expoStatus.builds ?? []).find((b) => b.platform === "android")
  if (!parked) throw new Error("no expo build record")
  if (parked.status === "running" || parked.status === "building") throw new Error(`expo still ${parked.status}`)
})

console.log("— stop everything —")
await execute({ action: "stop", platform: "all", directory: native })
const status3 = await execute({ action: "status", platform: "all", directory: native })
ok("nothing running after stop", () => {
  const running = (status3.builds ?? []).filter((b) => b.status === "running")
  if (running.length !== 0) throw new Error(`${running.length} still running`)
})
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
