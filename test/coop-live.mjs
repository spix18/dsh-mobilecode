/**
 * dsh-mobilecode — live co-op split-view battery (0.9.0).
 *
 * Drives the REAL stream path against two booted emulators, exactly as the
 * panel does: two device_stream starts → one /stream/devices with two
 * streaming flags → two concurrent GET /stream?token=… responses that must
 * EACH receive their own device's PNG frames (multipart parts) at the same
 * time → stop one, keep the other → stop all. Uses the fake-ctx harness (like
 * mesh-routes) but real AdbFrameLoops — the seams stay at their defaults.
 *
 * Run: node test/coop-live.mjs [serialA serialB]
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"

const pluginDir = process.env["DSH_MOBILECODE_DIR"]
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"
const serialA = process.argv[2] ?? "emulator-5554"
const serialB = process.argv[3] ?? "emulator-5556"

const registered = { routes: [], tools: [] }
const ctx = {
  provide() {},
  webServer: { register(route) { registered.routes.push(route); return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}
const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: target })

const byPath = (p) => registered.routes.find((r) => r.path === p)
const API = "/api/dsh-mobilecode"
const exec = async (name, args) => {
  const t = registered.tools.find((tool) => tool.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return (t.execute ?? t.definition?.execute)?.(args)
}

/** JSON-shaped route call (same recipe as mesh-routes). */
async function call(route, { method = "GET", query = "", body, headers = {}, host = "localhost:3080" } = {}) {
  const req = {
    method,
    url: route.path + query,
    headers: { host, ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  let status = 0
  let json
  const res = { writeHead(code) { status = code }, end(text) { try { json = JSON.parse(text) } catch { json = text } } }
  await route.handler(req, res)
  return { status, json }
}

/** Long-lived multipart response collector: the live-stream GET never ends. */
function makeStreamRes() {
  const parts = []
  const listeners = {}
  return {
    parts,
    closed: false,
    frameCount: () => parts.filter((p) => p.subarray(0, 8).equals(PNG_SIG)).length,
    writeHead() {},
    on(event, fn) { (listeners[event] ??= []).push(fn) },
    write(chunk) { parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "binary")); return true },
    end() { this.closed = true },
    fireClose() { for (const fn of listeners.close ?? []) fn() },
  }
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const STREAM = byPath(API + "/stream")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
async function ok(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.stack?.split("\n").slice(0, 3).join(" | ")}`)
    process.exitCode = 1
  }
}

console.log(`dsh-mobilecode live co-op battery (${serialA} + ${serialB})\n`)
if (!STREAM) { console.error("FAIL  /stream route not registered"); process.exit(1) }

let tokenA, tokenB, resA, resB
await ok(`device_stream start ${serialA}`, async () => {
  const r = await exec("device_stream", { action: "start", serial: serialA })
  if (!r.running || r.serial !== serialA || !r.streamUrl) throw new Error(JSON.stringify(r))
  tokenA = new URL(r.streamUrl, "http://localhost").searchParams.get("token")
})
await ok(`device_stream start ${serialB} keeps ${serialA} streaming (no handover)`, async () => {
  const r = await exec("device_stream", { action: "start", serial: serialB })
  if (!r.running || r.serial !== serialB) throw new Error(JSON.stringify(r))
  tokenB = new URL(r.streamUrl, "http://localhost").searchParams.get("token")
  const st = await exec("device_stream", { action: "status" })
  if (!st.running || !Array.isArray(st.serials) || !st.serials.includes(serialA) || !st.serials.includes(serialB)) {
    throw new Error(`status must list both streams: ${JSON.stringify(st)}`)
  }
})

const DEV = byPath(API + "/stream/devices")
await ok("/stream/devices flags BOTH devices streaming", async () => {
  // Browser-shaped POST: stream fences minting/reading state require Origin.
  const r = await call(DEV, { method: "POST", body: {}, headers: { origin: "http://localhost:3080", "sec-fetch-site": "same-origin" } })
  if (r.status !== 200) throw new Error(`devices route ${r.status}: ${JSON.stringify(r.json)}`)
  const flagged = (r.json.devices ?? []).filter((d) => d.streaming).map((d) => d.serial).sort()
  const want = [serialA, serialB].sort()
  if (JSON.stringify(flagged) !== JSON.stringify(want)) throw new Error(`streaming flags ${JSON.stringify(flagged)} != ${JSON.stringify(want)}`)
})

await ok("two concurrent live GETs each receive their own PNG frames", async () => {
  resA = makeStreamRes()
  resB = makeStreamRes()
  const reqFor = (token) => ({
    method: "GET",
    url: `${API}/stream?token=${encodeURIComponent(token)}`,
    headers: { host: "localhost:3080" },
    socket: { remoteAddress: "127.0.0.1" },
  })
  const pA = STREAM.handler(reqFor(tokenA), resA)
  const pB = STREAM.handler(reqFor(tokenB), resB)
  await Promise.all([pA, pB]) // each awaited ensure (≤15s first frame) before subscribing
  await sleep(4000) // ~8 fps per loop on emulators → several frames
  if (resA.frameCount() < 3) throw new Error(`writer A got only ${resA.frameCount()} frames`)
  if (resB.frameCount() < 3) throw new Error(`writer B got only ${resB.frameCount()} frames`)
})

await ok("closing one viewer never disturbs the other", async () => {
  resA.fireClose() // panel A closed → route teardown releases its consumer
  await sleep(500)
  const bBefore = resB.frameCount()
  await sleep(2000)
  if (resB.frameCount() <= bBefore) throw new Error(`writer B stalled after A closed (${bBefore})`)
})

await ok(`device_stream stop ${serialA} leaves ${serialB} running`, async () => {
  await exec("device_stream", { action: "stop", serial: serialA })
  const st = await exec("device_stream", { action: "status" })
  if (st.serial !== serialB) throw new Error(`primary after stop(A) should be ${serialB}: ${JSON.stringify(st)}`)
  if (st.serials !== undefined) throw new Error(`serials array should vanish with one stream: ${JSON.stringify(st)}`)
  resB.fireClose()
})

await ok("device_stream stop without serial tears everything down", async () => {
  await exec("device_stream", { action: "stop" })
  const st = await exec("device_stream", { action: "status" })
  if (st.running) throw new Error(`streams survived: ${JSON.stringify(st)}`)
})

console.log(`\n${passed}/7 live co-op checks passed${process.exitCode ? " (with failures)" : ""}`)
process.exit(process.exitCode ?? 0)
