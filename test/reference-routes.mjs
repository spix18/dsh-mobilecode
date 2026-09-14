/**
 * dsh-mobilecode — reference-comparison workspace HTTP wire-contract test.
 * Loads the workspace's lib/index.js with a stub ctx, captures registered
 * route handlers, drives the /refs/* handlers with real-shaped req/res.
 * The store root is redirected to a throwaway temp dir via
 * DSH_MOBILECODE_REF_ROOT so no user data is touched.
 *
 * Run: node test/reference-routes.mjs
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.DSH_MOBILECODE_REF_ROOT = mkdtempSync(path.join(tmpdir(), "mc-ref-routes-"))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"

const registered = { routes: [], tools: [], sections: [] }
const ctx = {
  provide(name, handle) { this.provided = { name, handle } },
  webServer: { register(route) { registered.routes.push(route); return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section(section) { registered.sections.push(section); return () => {} } },
  effect(fn) { return fn() },
}
const plugin = await import(pathToFileURL(path.join(pluginDir, "lib", "index.js")).href)
plugin.apply(ctx, { defaultDirectory: "C:\\Users\\Administrator\\Desktop\\trachtenberg_method" })

async function call(route, { method = "GET", query = "", body, remoteAddress = "127.0.0.1", host = "localhost:3080", extraHeaders = {} } = {}) {
  const req = {
    method,
    url: route.path + query,
    headers: { host, ...extraHeaders },
    socket: { remoteAddress },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  let status = 0
  let headers = {}
  let payload
  const res = {
    writeHead(code, h = {}) { status = code; headers = h },
    end(text) { payload = text },
  }
  await route.handler(req, res)
  return { status, headers, payload }
}

let passed = 0
const ok = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}
const byPath = (p) => registered.routes.find((r) => r.path === p)
const API = "/api/dsh-mobilecode"
const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x00, 0x06, 0x00, 0x05, 0x57, 0xbf, 0xab, 0xd4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
const DATA_URL = "data:image/png;base64," + tinyPng.toString("base64")

console.log("— refs: loopback + method guards —")
await ok("non-loopback GET /refs → 403", async () => {
  const r = await call(byPath(API + "/refs"), { remoteAddress: "203.0.113.5", host: "evil.example" })
  if (r.status !== 403) throw new Error(`status ${r.status}`)
})
await ok("GET /refs/import → 405", async () => {
  const r = await call(byPath(API + "/refs/import"), { method: "GET" })
  if (r.status !== 405) throw new Error(`status ${r.status}`)
})
await ok("browser-like cross-site POST /refs/import → 403 (fence)", async () => {
  const r = await call(byPath(API + "/refs/import"), { method: "POST", body: { project: "p", screen: "s", stateId: "d", data: DATA_URL }, extraHeaders: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } })
  if (r.status !== 403) throw new Error(`status ${r.status}`)
})
await ok("browser-like cross-site POST /refs/capture → 403 (fence)", async () => {
  const r = await call(byPath(API + "/refs/capture"), { method: "POST", body: { project: "p", screen: "s", stateId: "d", serial: "no-such" }, extraHeaders: { "sec-fetch-site": "cross-site" } })
  if (r.status !== 403) throw new Error(`status ${r.status}`)
})
await ok("same-origin browser POST /refs/import passes fence (201)", async () => {
  const r = await call(byPath(API + "/refs/import"), { method: "POST", body: { project: "same-origin", screen: "x", stateId: "y", filename: "a.png", data: DATA_URL }, extraHeaders: { origin: "http://localhost:3080", "sec-fetch-site": "same-origin" } })
  if (r.status !== 201) throw new Error(`status ${r.status}`)
})

console.log("— refs: empty list → import → list —")
let imported
await ok("GET /refs?project= → 200 empty", async () => {
  const r = await call(byPath(API + "/refs"), { query: "?project=trachtenberg" })
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  const body = JSON.parse(r.payload)
  if (!Array.isArray(body.records) || body.records.length !== 0) throw new Error("expected empty")
})
await ok("POST /refs/import (bad data) → 400", async () => {
  const r = await call(byPath(API + "/refs/import"), { method: "POST", body: { project: "p", screen: "s", stateId: "d", data: "not-an-image" } })
  if (r.status !== 400) throw new Error(`status ${r.status}`)
})
await ok("POST /refs/import (valid) → 201", async () => {
  const r = await call(byPath(API + "/refs/import"), {
    method: "POST",
    body: { project: "trachtenberg", screen: "practice", stateId: "default", filename: "design.png", data: DATA_URL, provenance: "wire-test", intendedUse: "compare" },
  })
  if (r.status !== 201) throw new Error(`status ${r.status}`)
  imported = JSON.parse(r.payload).record
  if (!imported?.id || imported.width !== 1 || imported.height !== 1) throw new Error("record incomplete")
})
await ok("GET /refs/image?id=<id> → 200 image/png bytes", async () => {
  const r = await call(byPath(API + "/refs/image"), { query: "?id=" + imported.id })
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  if ((r.headers["content-type"] ?? "") !== "image/png") throw new Error(`content-type ${r.headers["content-type"]}`)
  if (r.headers["x-content-type-options"] !== "nosniff") throw new Error("missing nosniff (audit F3)")
  if (!Buffer.isBuffer(r.payload) || r.payload.length < 20) throw new Error("payload not image bytes")
})
await ok("GET /refs/image?id=unknown → 404", async () => {
  const r = await call(byPath(API + "/refs/image"), { query: "?id=deadbeef" })
  if (r.status !== 404) throw new Error(`status ${r.status}`)
})

console.log("— refs: active, compare, capture error, remove —")
await ok("POST /refs/active → 200 active", async () => {
  const r = await call(byPath(API + "/refs/active"), { method: "POST", body: { id: imported.id } })
  if (r.status !== 200) throw new Error(`status ${r.status}`)
})
await ok("POST /refs/active (unknown id) → 400", async () => {
  const r = await call(byPath(API + "/refs/active"), { method: "POST", body: { id: "nope" } })
  if (r.status !== 400) throw new Error(`status ${r.status}`)
})
await ok("GET /refs/compare without project → 400", async () => {
  const r = await call(byPath(API + "/refs/compare"), {})
  if (r.status !== 400) throw new Error(`status ${r.status}`)
})
await ok("GET /refs/compare → reference present, capture null", async () => {
  const r = await call(byPath(API + "/refs/compare"), { query: "?project=trachtenberg&screen=practice&stateId=default" })
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  const body = JSON.parse(r.payload)
  if (body.reference?.id !== imported.id) throw new Error("reference not resolved")
  if (body.capture !== undefined) throw new Error("unexpected capture")
})
await ok("POST /refs/capture (invalid serial) → 400", async () => {
  const r = await call(byPath(API + "/refs/capture"), { method: "POST", body: { project: "trachtenberg", screen: "practice", stateId: "default", serial: "no-such-device-xyz" } })
  if (r.status !== 400) throw new Error(`status ${r.status}`)
})
await ok("POST /refs/remove → 200 removed", async () => {
  const r = await call(byPath(API + "/refs/remove"), { method: "POST", body: { id: imported.id } })
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  if (JSON.parse(r.payload).removed !== true) throw new Error("removed !== true")
})
await ok("POST /refs/remove (unknown) → removed false", async () => {
  const r = await call(byPath(API + "/refs/remove"), { method: "POST", body: { id: "nope" } })
  if (JSON.parse(r.payload).removed !== false) throw new Error("removed !== false")
})

console.log(`\n${passed} checks passed`)
