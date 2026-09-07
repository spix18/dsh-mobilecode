/**
 * dsh-mobilecode — live route lifecycle test. Drives the REAL route handlers
 * (the exact code the browser pane calls) through a full server lifecycle:
 *   POST /start  → serve-avd boots (real npx process)
 *   GET  /info   → server entry reaches "running" with a URL
 *   GET  the URL → HTTP 200
 *   POST /stop   → teardown, server entry gone
 * plus the run/run-stop handler pair against an idle engine (200, no crash).
 *
 * Run: node test/routes-live.mjs [directory]
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const registered = { routes: [] }
const ctx = {
  provide(name, handle) { this.provided = { name, handle } },
  webServer: {
    register(route) { registered.routes.push(route); return () => {} },
    registerUpgrade() { return () => {} },
  },
  tools: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}

const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: target })

async function call(route, { method = "GET", query = "", body, remoteAddress = "127.0.0.1", host = "localhost:3080" } = {}) {
  const req = {
    method,
    url: route.path + query,
    headers: { host },
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

const byPath = (p) => registered.routes.find((r) => r.path === p)
const q = "?directory=" + encodeURIComponent(target)
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

console.log("— POST /start (real serve-avd boot) —")
const started = await call(byPath("/api/dsh-mobilecode/start"), { method: "POST", body: { directory: target, platform: "android" } })
ok("POST /start → 200 with a starting server entry", () => {
  if (started.status !== 200) throw new Error(`status ${started.status}`)
  const srv = started.json.servers?.find((s) => s.platform === "android")
  if (!srv) throw new Error("no android server entry in response")
  if (srv.status !== "starting" && srv.status !== "running") throw new Error(`unexpected status ${srv.status}`)
})

console.log("— GET /info polls to running —")
let info = started
let url
const deadline = Date.now() + 5 * 60_000
while (Date.now() < deadline) {
  const srv = info.json?.servers?.find((s) => s.platform === "android")
  if (srv && srv.status !== "starting") { url = srv.url; break }
  await new Promise((resolve) => setTimeout(resolve, 2000))
  info = await call(byPath("/api/dsh-mobilecode"), { query: q })
}
ok("GET /info → server reaches running with URL", () => {
  if (!url) throw new Error("server never left starting state")
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/.test(url)) throw new Error(`bad url ${url}`)
})
ok("GET the preview URL → HTTP 200", async () => {
  if (!url) throw new Error("no url")
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
})

console.log("— POST /run + /run/stop (idle engine, 200) —")
const run = await call(byPath("/api/dsh-mobilecode/run"), { method: "POST", body: { directory: target, platform: "android" } })
ok("POST /run → 200 with platforms", () => {
  if (run.status !== 200) throw new Error(`status ${run.status}`)
  if (!run.json.platforms?.includes("android")) throw new Error("no android platform")
})
const runStop = await call(byPath("/api/dsh-mobilecode/run/stop"), { method: "POST", body: { directory: target, platform: "android" } })
ok("POST /run/stop → 200 with info shape", () => {
  if (runStop.status !== 200) throw new Error(`status ${runStop.status}`)
  if (!Array.isArray(runStop.json.servers) || !Array.isArray(runStop.json.builds)) throw new Error("bad info shape")
})

console.log("— POST /stop (teardown) —")
const stopped = await call(byPath("/api/dsh-mobilecode/stop"), { method: "POST", body: { directory: target, platform: "android" } })
ok("POST /stop → 200, server entry gone", () => {
  if (stopped.status !== 200) throw new Error(`status ${stopped.status}`)
  const srv = stopped.json.servers?.find((s) => s.platform === "android")
  if (srv) throw new Error("android server still listed after stop")
})

// Cleanup: dispose the engine via the provided handle.
if (ctx.provided?.handle?.engine) await ctx.provided.handle.engine.dispose()
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
