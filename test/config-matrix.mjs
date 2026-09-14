/**
 * dsh-mobilecode — configuration matrix tests (T7m).
 * Pure validation + wire contract (stub ctx, mounted copy) run everywhere;
 * `--live` executes one REAL bounded matrix (2 cases) against emulator-5554
 * and proves snapshot→apply→confirm→capture→restore end to end.
 *
 * Run: node test/config-matrix.mjs [--live]
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.DSH_MOBILECODE_REF_ROOT = mkdtempSync(path.join(tmpdir(), "mc-matrix-"))
const pluginDir = process.env.DSH_MOBILECODE_DIR ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const { isEmulatorSerial, parseDisplaySetting, starterCases } = await import(pathToFileURL(path.join(here, "..", "lib", "config-matrix.js")).href)

let passed = 0
const ok = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ok  " + name) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }

// ── pure logic ────────────────────────────────────────────────────────────────
await ok("physical serial refused by emulator check", () => {
  must(isEmulatorSerial("1b05fbbf") === false, "physical accepted")
  must(isEmulatorSerial("emulator-5554") === true, "emulator refused")
})
await ok("override vs physical parsing (size + density)", () => {
  const s = parseDisplaySetting("Physical size: 1080x2400\nOverride size: 840x1869", "size")
  must(s.sizeOverridden === true && s.widthPx === 840 && s.heightPx === 1869, `got ${JSON.stringify(s)}`)
  const p = parseDisplaySetting("Physical size: 1080x2400", "size")
  must(p.sizeOverridden === false && p.widthPx === 1080, `got ${JSON.stringify(p)}`)
  const d = parseDisplaySetting("Override density: 420", "density")
  must(d.densityOverridden === true && d.densityDpi === 420, `got ${JSON.stringify(d)}`)
  // P4-1 regression: merging both parses must not clobber either override flag
  const merged = { ...parseDisplaySetting("Override size: 840x1869", "size"), ...parseDisplaySetting("Physical density: 420", "density") }
  must(merged.sizeOverridden === true && merged.densityOverridden === false, `merged ${JSON.stringify(merged)}`)
})
await ok("starterCases derives narrow px from ACTUAL density, aspect preserved", () => {
  const actual = { widthPx: 1080, heightPx: 2400, densityDpi: 420, fontScale: 1 }
  const cs = starterCases(actual)
  const narrow = cs.find((c) => c.id.includes("320"))
  must(narrow.dims[0] === Math.round(320 * 2.625), `narrow width ${narrow.dims[0]}`)
  must(narrow.dims[1] < actual.heightPx && narrow.dims[1] > 100, `narrow height ${narrow.dims[1]}`)
  must(cs.every((c) => c.fontScale > 0), "fontScale set")
})

// ── wire: validation + guards (no device spawn on these paths) ───────────────
const registered = { routes: [], tools: [] }
const ctx = {
  provide() {}, webServer: { register: (r) => registered.routes.push(r), registerUpgrade: () => () => {} },
  tools: { register: (t) => registered.tools.push(t) }, systemPrompt: { section: () => () => {} }, effect: (fn) => fn(), get: () => undefined,
}
const plugin = await import(pathToFileURL(path.join(pluginDir, "lib", "index.js")).href)
plugin.apply(ctx, { defaultDirectory: "C:\\Users\\Administrator\\Desktop\\mobilecode_dsh" })
await ok("config_matrix tool registered", () => must(registered.tools.some((t) => t.name === "config_matrix"), "missing"))
const runRoute = registered.routes.find((r) => r.path === "/api/dsh-mobilecode/matrix/run")
const capRoute = registered.routes.find((r) => r.path === "/api/dsh-mobilecode/matrix/capabilities")
await ok("matrix routes registered", () => must(runRoute && capRoute, "missing"))

async function call(route, { method = "GET", query = "", body, headers = {}, remoteAddress = "127.0.0.1", host = "localhost:3080" } = {}) {
  const req = { method, url: route.path + query, headers: { host, ...headers }, socket: { remoteAddress },
    [Symbol.asyncIterator]() { const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]; let i = 0; return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) } } }
  let status = 0; let payload
  await route.handler(req, { writeHead(c) { status = c }, end(t) { payload = t } })
  return { status, json: (() => { try { return JSON.parse(payload) } catch { return payload } })() }
}

await ok("run: serial path chars rejected", async () => {
  const r = await call(runRoute, { method: "POST", body: { serial: "evil/../x", project: "p", screen: "s", cases: [{ id: "a", fontScale: 1 }] } })
  must(r.status === 400, `status ${r.status}`)
})
await ok("run: 9 cases rejected (bounded matrix)", async () => {
  const cases = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, fontScale: 1 }))
  const r = await call(runRoute, { method: "POST", body: { serial: "emulator-5554", project: "p", screen: "s", cases } })
  must(r.status === 400 && /1\.\.8/.test(r.json.error), JSON.stringify(r.json))
})
await ok("run: dims out of range rejected", async () => {
  const r = await call(runRoute, { method: "POST", body: { serial: "emulator-5554", project: "p", screen: "s", cases: [{ id: "a", dims: [50, 50] }] } })
  must(r.status === 400, `status ${r.status}`)
})
await ok("run: case with no dimensions rejected", async () => {
  const r = await call(runRoute, { method: "POST", body: { serial: "emulator-5554", project: "p", screen: "s", cases: [{ id: "a" }] } })
  must(r.status === 400, `status ${r.status}`)
})
await ok("run: physical device → blocked, NOT executed", async () => {
  const r = await call(runRoute, { method: "POST", body: { serial: "1b05fbbf", project: "p", screen: "s", cases: [{ id: "a", fontScale: 1.5 }] } })
  must(r.status === 200 && r.json.status === "blocked" && /physical/i.test(r.json.reason), JSON.stringify(r.json))
})
await ok("run: browser cross-site POST → fence 403", async () => {
  const r = await call(runRoute, { method: "POST", body: { serial: "emulator-5554", project: "p", screen: "s", cases: [{ id: "a", fontScale: 1 }] }, headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } })
  must(r.status === 403, `status ${r.status}`)
})
await ok("capabilities GET loopback guard", async () => {
  const r = await call(capRoute, { remoteAddress: "203.0.113.5", host: "evil.example", query: "?serial=emulator-5554" })
  must(r.status === 403, `status ${r.status}`)
})

console.log(`\n${passed} checks passed`)

// ── live bounded run (real emulator, real restore) ───────────────────────────
if (process.argv.includes("--live")) {
  const { runMatrix } = await import(pathToFileURL(path.join(here, "..", "lib", "config-matrix.js")).href)
  const { ReferenceWorkspace } = await import(pathToFileURL(path.join(here, "..", "lib", "reference-workspace.js")).href)
  const ws = new ReferenceWorkspace(process.env.DSH_MOBILECODE_REF_ROOT)
  const serial = "emulator-5554"
  console.log("live: reading current device config…")
  const { readConfig } = await import(pathToFileURL(path.join(here, "..", "lib", "config-matrix.js")).href)
  const before = await readConfig(serial)
  console.log("live before:", JSON.stringify(before))
  const cases = [
    { id: "narrow-320dp", dims: [Math.round(320 * ((before.densityDpi ?? 420) / 160)), Math.round((before.heightPx ?? 2400) * 0.78)], density: before.densityDpi, fontScale: 1 },
    { id: "fontscale-2", fontScale: 2 },
  ]
  const result = await runMatrix({ serial, workspace: ws, project: "trachtenberg", screen: "home", cases })
  console.log("live status:", result.status)
  for (const r of result.reports ?? []) console.log(" case:", r.id, r.status, "evidence:", r.evidenceId ?? "—", "actual:", JSON.stringify(r.actual ?? r))
  const restore = result.restore // audit P4-4: real envelope field now, not array prop
  console.log("live restore:", JSON.stringify(restore?.ok), "after:", JSON.stringify(restore?.actualAfterRestore))
  const sizeOk = (restore?.actualAfterRestore?.widthPx ?? before.widthPx) === before.widthPx
  const fontOk = Math.abs((restore?.actualAfterRestore?.fontScale ?? before.fontScale) - before.fontScale) < 0.01
  ok("live: all cases captured evidence", async () => must((result.reports ?? []).every((r) => r.status === "captured" && r.evidenceId), JSON.stringify(result.reports)))
    .then(() => ok("live: device restored to found state", async () => must(restore?.ok === true && sizeOk && fontOk, `restore ${JSON.stringify(restore)}`)))
    .then(() => console.log(`${passed} checks passed (live)`))
}
