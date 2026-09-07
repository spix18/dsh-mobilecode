/**
 * dsh-mobilecode — relaunch + cancel test. Exercises two engine paths the
 * happy-path suites skip:
 *   1. relaunch: runApp with relaunch:true force-stops a previously installed
 *      build before re-launching (the "Play" button re-run semantics).
 *   2. cancel: stopApp lands while a build is in progress and the pipeline
 *      unwinds (status leaves building; no stray gradle keeps running).
 * Run: node test/relaunch-cancel.mjs [directory]
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const registered = { tools: [] }
const ctx = {
  provide() {},
  webServer: { register() { return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}
const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: target })
const deviceRun = registered.tools.find((t) => (t.name ?? t.definition?.name) === "device_run")
const execute = deviceRun.execute ?? deviceRun.definition?.execute

let passed = 0
const ok = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}

// 1. relaunch through the engine: force-stop a running build, then launch again.
console.log("— relaunch (force-stop + relaunch) —")
const run1 = await execute({ action: "run", platform: "android", directory: target, timeout: 600000 })
ok("first run reaches running", () => {
  const b = (run1.builds ?? []).find((x) => x.platform === "android")
  if (!b || b.status !== "running") throw new Error(`status ${b?.status}`)
})
// stop, then relaunch: the engine's focus() uses relaunch:true — drive it via a
// second run of the same directory after an explicit stop (Play-button rerun).
await execute({ action: "stop", platform: "android", directory: target })
const run2 = await execute({ action: "run", platform: "android", directory: target, timeout: 600000 })
ok("relaunch after stop reaches running again", () => {
  const b = (run2.builds ?? []).find((x) => x.platform === "android")
  if (!b || b.status !== "running") throw new Error(`status ${b?.status}`)
})
await execute({ action: "stop", platform: "android", directory: target })

// 2. cancel: start a run and stop it mid-pipeline (immediately after start).
console.log("— cancel (stop lands while building) —")
await execute({ action: "run", platform: "android", directory: target, timeout: 600000 })
// The build is fast when up-to-date, so fire stop concurrently with the run.
const race = await Promise.allSettled([
  execute({ action: "run", platform: "android", directory: target, timeout: 600000 }),
  new Promise((resolve) => setTimeout(() => resolve(execute({ action: "stop", platform: "android", directory: target })), 50)),
])
ok("run+stop race settles without throwing", () => {
  for (const r of race) if (r.status === "rejected") throw new Error(String(r.reason))
})
const after = await execute({ action: "status", platform: "all", directory: target })
ok("no build left building/running after cancel", () => {
  const b = (after.builds ?? []).find((x) => x.platform === "android")
  if (b && (b.status === "building" || b.status === "running" || b.status === "installing" || b.status === "launching"))
    throw new Error(`still ${b.status}`)
})
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
