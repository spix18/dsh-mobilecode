/**
 * dsh-mobilecode — device_run tool e2e. Exercises the REAL agent-facing tool
 * (the defineTool wrapper: args validation → engine.runApp → poll loop →
 * summarize → strict output schema) for action "run" on android, then
 * action "stop", against a real device.
 *
 * Run: node test/tool-run.mjs [directory]
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const registered = { tools: [] }
const ctx = {
  provide(name, handle) { this.provided = { name, handle } },
  webServer: { register() { return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}

const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: target })

const deviceRun = registered.tools.find((t) => (t.name ?? t.definition?.name) === "device_run")
if (!deviceRun) throw new Error("device_run tool not registered")
const execute = deviceRun.execute ?? deviceRun.definition?.execute

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

console.log("— device_run action=run (real build/install/launch) —")
const out = await execute({ action: "run", platform: "android", directory: target, timeout: 600000 })
console.log(`  complete: ${out.complete}`)
for (const b of out.builds) {
  console.log(`  build[${b.platform}] status=${b.status}${b.step ? " step=" + b.step : ""}${b.appID ? " app=" + b.appID : ""}${b.error ? " error=" + b.error : ""}`)
}
ok("run returned platforms incl. android", () => {
  if (!out.platforms.includes("android")) throw new Error(`platforms: ${JSON.stringify(out.platforms)}`)
})
ok("run completed with a running build", () => {
  if (!out.complete) throw new Error("tool did not wait for completion")
  const b = out.builds.find((x) => x.platform === "android")
  if (!b || b.status !== "running") throw new Error(`expected running, got ${b?.status}`)
  if (!b.appID) throw new Error("missing appID")
})
ok("output shape obeys the strict schema", () => {
  if (typeof out.framework !== "string" && out.framework !== null && out.framework !== undefined) throw new Error("framework wrong type")
  for (const b of out.builds) {
    if (typeof b.platform !== "string") throw new Error("platform missing")
    if (!Array.isArray(b.log)) throw new Error("log not array")
  }
  if (out.bundler !== undefined && out.bundler !== null && typeof out.bundler.status !== "string") throw new Error("bundler malformed")
  if (typeof out.complete !== "boolean") throw new Error("complete missing")
})

console.log("— device_run action=status while running —")
const status = await execute({ action: "status", platform: "all", directory: target })
ok("status shows the running build", () => {
  const b = status.builds.find((x) => x.platform === "android")
  if (!b || b.status !== "running") throw new Error(`expected running, got ${b?.status}`)
})

console.log("— device_run action=stop —")
const stopped = await execute({ action: "stop", platform: "android", directory: target })
ok("stop reports the build no longer running", () => {
  const b = stopped.builds.find((x) => x.platform === "android")
  if (b && b.status === "running") throw new Error("still running after stop")
})

if (ctx.provided?.handle?.engine) await ctx.provided.handle.engine.dispose()
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
