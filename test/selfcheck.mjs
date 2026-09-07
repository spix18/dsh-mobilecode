/**
 * dsh-mobilecode — host self-check. Loads the mounted plugin's lib/index.js
 * with a plain-object cordis ctx stub (the same trick dsh-logcat's selfcheck
 * uses) and proves the full mount contract:
 *   1. apply() runs, ctx.provide publishes the handle,
 *   2. routes register through ctx.webServer.register,
 *   3. agent tools register through ctx.tools.register,
 *   4. device_run.execute('status') + device_detect.execute work against a
 *      real directory through the strict output schema.
 *
 * Run: node test/selfcheck.mjs [directory]
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const registered = { routes: [], tools: [], sections: [] }
const disposers = []

const ctx = {
  provide(name, handle) { this.provided = { name, handle } },
  webServer: {
    register(route) {
      registered.routes.push(route)
      const dispose = () => { registered.routes = registered.routes.filter((r) => r !== route) }
      disposers.push(dispose)
      return dispose
    },
    registerUpgrade(upgrade) { registered.upgrade = upgrade; const dispose = () => { registered.upgrade = undefined }; disposers.push(dispose); return dispose },
  },
  tools: {
    register(tool) {
      registered.tools.push(tool)
      const dispose = () => { registered.tools = registered.tools.filter((t) => t !== tool) }
      disposers.push(dispose)
      return dispose
    },
  },
  systemPrompt: {
    section(section) {
      registered.sections.push(section)
      const dispose = () => { registered.sections = registered.sections.filter((s) => s !== section) }
      disposers.push(dispose)
      return dispose
    },
  },
  effect(fn, label) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
}

const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
console.log(`plugin name: ${plugin.name}`)
console.log(`inject: ${JSON.stringify(plugin.inject)}`)
console.log(`provide: ${JSON.stringify(plugin.provide)}`)

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

plugin.apply(ctx, { defaultDirectory: target })

ok("apply() published the mobilecode handle", () => {
  if (!ctx.provided || ctx.provided.name !== "mobilecode") throw new Error("no mobilecode handle")
  if (!ctx.provided.handle.engine) throw new Error("handle has no engine")
})
ok("routes registered", () => {
  const paths = registered.routes.map((r) => r.path)
  for (const expected of ["/api/dsh-mobilecode", "/api/dsh-mobilecode/start", "/api/dsh-mobilecode/stop", "/api/dsh-mobilecode/run", "/api/dsh-mobilecode/run/stop", "/api/dsh-mobilecode/focus"]) {
    if (!paths.includes(expected)) throw new Error(`missing route ${expected}; have ${paths.join(", ")}`)
  }
})
ok("tools registered", () => {
  const names = registered.tools.map((t) => t.name ?? t.definition?.name)
  for (const expected of ["device_run", "device_detect"]) {
    if (!names.includes(expected)) throw new Error(`missing tool ${expected}; have ${names.join(", ")}`)
  }
})
ok("system prompt section registered", () => {
  if (registered.sections.length === 0) throw new Error("no prompt section")
})

// Exercise the two tools' execute through their strict output schemas.
const deviceRun = registered.tools.find((t) => (t.name ?? t.definition?.name) === "device_run")
const deviceDetect = registered.tools.find((t) => (t.name ?? t.definition?.name) === "device_detect")

const toolExecute = (tool) => {
  // defineTool wraps execute into options.execute (userExecute); the returned
  // tool exposes it. Prefer the wrapper's own execute if present.
  return tool.execute ?? tool.definition?.execute
}

ok("device_detect.execute works", async () => {
  const execute = toolExecute(deviceDetect)
  if (typeof execute !== "function") throw new Error("device_detect has no execute")
  const out = await execute({ directory: target })
  if (!out.platforms.includes("android")) throw new Error(`expected android; got ${JSON.stringify(out)}`)
  if (!out.directory) throw new Error("no directory in output")
})

ok("device_run.execute('status') works", async () => {
  const execute = toolExecute(deviceRun)
  if (typeof execute !== "function") throw new Error("device_run has no execute")
  const out = await execute({ action: "status", platform: "all", directory: target })
  if (!Array.isArray(out.builds)) throw new Error(`builds not an array: ${JSON.stringify(out)}`)
  if (out.platforms.length === 0) throw new Error("no platforms detected")
  if (typeof out.complete !== "boolean") throw new Error("complete missing")
})

ok("device_run.execute rejects a missing platform", async () => {
  const execute = toolExecute(deviceRun)
  let threw = false
  try {
    await execute({ action: "run", platform: "ios", directory: target })
  } catch (error) {
    threw = true
    if (!/No iOS project/.test(error.message)) throw new Error(`unexpected error: ${error.message}`)
  }
  if (!threw) throw new Error("expected an error for missing ios platform")
})

// Cleanup: run all disposers (routes/tools/section/engine).
for (const dispose of disposers.splice(0).reverse()) { try { dispose() } catch { /* ignore */ } }
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
