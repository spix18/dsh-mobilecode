/**
 * dsh-mobilecode — visual-compare core + /refs/diff wire tests (Feature E).
 * Pure functions get synthetic RGBA fixtures (no-change, seeded defect, masks,
 * size mismatch, envelope honesty); the route is driven with a stub ctx and
 * refuses encoded images instead of approximating.
 *
 * Run: node test/reference-diff.mjs
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.DSH_MOBILECODE_REF_ROOT = mkdtempSync(path.join(tmpdir(), "mc-diff-"))
const { diffFrames, clusterMarks, compareEnvelope, ocrCorroboration } = await import(pathToFileURL(path.join(here, "..", "lib", "visual-compare.js")).href)

let passed = 0
const ok = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ok  " + name) }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }

function frame(w, h, fill) {
  return { width: w, height: h, rgba: Buffer.alloc(w * h * 4, fill) }
}
function paint(frame, x, y, w, h, value) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const p = (yy * frame.width + xx) * 4
    frame.rgba[p] = value; frame.rgba[p + 1] = value; frame.rgba[p + 2] = value; frame.rgba[p + 3] = 255
  }
  return frame
}

await ok("no-change pair → 0.000% changed, no clusters", async () => {
  const d = diffFrames(frame(64, 64, 10), frame(64, 64, 10))
  must(d.status === "ok" && d.changedPixels === 0 && d.changePct === 0 && d.clusters.length === 0, JSON.stringify(d))
})
await ok("seeded defect (12x12 block) → one cluster with exact bounds", async () => {
  const a = frame(120, 80, 10); const b = frame(120, 80, 10)
  paint(b, 40, 20, 12, 12, 200)
  const d = diffFrames(a, b)
  must(d.changedPixels === 144, `changed ${d.changedPixels}`)
  must(d.clusters.length === 1 && d.clusters[0].x === 40 && d.clusters[0].y === 20 && d.clusters[0].width === 12 && d.clusters[0].height === 12, JSON.stringify(d.clusters))
})
await ok("mask suppresses the defect region", async () => {
  const a = frame(120, 80, 10); const b = frame(120, 80, 10)
  paint(b, 40, 20, 12, 12, 200)
  const d = diffFrames(a, b, { masks: [{ x: 35, y: 15, width: 22, height: 22 }] })
  must(d.changedPixels === 0 && d.clusters.length === 0, JSON.stringify(d))
})
await ok("size mismatch → blocked with actionable reason (never approximated)", async () => {
  const d = diffFrames(frame(64, 64, 1), frame(32, 32, 1))
  must(d.status === "blocked" && /align first/.test(d.reason), JSON.stringify(d))
})
await ok("clusterMarks skips specks below minPixels", async () => {
  const marks = new Uint8Array(30 * 30)
  marks[3 * 30 + 3] = 1 // 1px speck
  paint({ width: 30, height: 30, rgba: { set: () => {} } }, 0, 0, 0, 0, 0) // noop guard
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) marks[y * 30 + x] = 1 // 4x4 = 16 ≥ 40? no → filtered
  must(clusterMarks(marks, 30, 30, 40).length === 0, "16px cluster must be filtered by minPixels=40")
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) marks[y * 30 + x] = 1
  must(clusterMarks(marks, 30, 30, 40).length === 1, "100px cluster survives")
})
await ok("envelope: regression fails on any changed pixel; design-reference is needs_review", async () => {
  const a = frame(16, 16, 0); const b = frame(16, 16, 0); paint(b, 0, 0, 4, 4, 255)
  const reg = compareEnvelope({ runId: "r1", project: "p", screen: "s", stateId: "st", mode: "regression", diff: diffFrames(a, b) })
  must(reg.checkStatus === "failed", reg.checkStatus)
  const same = compareEnvelope({ runId: "r2", project: "p", screen: "s", stateId: "st", mode: "regression", diff: diffFrames(a, a) })
  must(same.checkStatus === "passed", same.checkStatus)
  const dr = compareEnvelope({ runId: "r3", project: "p", screen: "s", stateId: "st", mode: "design-reference", diff: diffFrames(a, b) })
  must(dr.checkStatus === "needs_review" && dr.limitations.length > 0, JSON.stringify(dr))
  must(!("score" in reg) && !("quality" in reg), "no quality scores in envelope")
})
await ok("ocrCorroboration reports disagreement, never merges", async () => {
  const clusters = [{ x: 0, y: 0, width: 10, height: 10, pixels: 100 }]
  const c = ocrCorroboration(clusters, [{ x: 2, y: 2, width: 4, height: 4, text: "41 × 11" }])
  must(c.textInChangedRegions.includes("41 × 11"), JSON.stringify(c))
  must(typeof c.changedRegionsWithoutText === "number", "shape")
})

// ── wire: /refs/diff via stub ctx against the mounted copy ───────────────────
const pluginDir = process.env.DSH_MOBILECODE_DIR ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const registered = { routes: [] }
const ctx = {
  provide() {}, webServer: { register: (r) => registered.routes.push(r), registerUpgrade: () => () => {} },
  tools: { register: () => {} }, systemPrompt: { section: () => () => {} }, effect: (fn) => fn(), get: () => undefined,
}
const plugin = await import(pathToFileURL(path.join(pluginDir, "lib", "index.js")).href)
plugin.apply(ctx, { defaultDirectory: "C:\\Users\\Administrator\\Desktop\\mobilecode_dsh" })
const diffRoute = registered.routes.find((r) => r.path === "/api/dsh-mobilecode/refs/diff")
await ok("refs/diff route registered", async () => must(diffRoute, "missing"))

async function call(body, headers = {}) {
  const req = { method: "POST", url: diffRoute.path, headers: { host: "localhost:3080", ...headers }, socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() { const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]; let i = 0; return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) } } }
  let status = 0; let payload
  await diffRoute.handler(req, { writeHead(c) { status = c }, end(t) { payload = t } })
  return { status, json: JSON.parse(payload) }
}

await ok("PNG magic bytes (encoded image) refused with decode guidance, not approximated", async () => {
  const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
  const r = await call({ a: { width: 2, height: 2, rgba: pngHead }, b: { width: 2, height: 2, rgba: pngHead } })
  must(r.status === 400 && /canvas/.test(r.json.error), JSON.stringify(r.json))
})
await ok("byte-count mismatch frame refused", async () => {
  const short = Buffer.alloc(2 * 2 * 4 - 1, 7).toString("base64")
  const r = await call({ a: { width: 2, height: 2, rgba: short }, b: { width: 2, height: 2, rgba: short } })
  must(r.status === 400, `status ${r.status}`)
})
await ok("happy path: identical frames → checkStatus passed + evidence file persisted", async () => {
  const f = Buffer.alloc(8 * 8 * 4, 9).toString("base64")
  const r = await call({ a: { width: 8, height: 8, rgba: f }, b: { width: 8, height: 8, rgba: f }, mode: "regression", project: "p", screen: "s", stateId: "st", referenceId: "ref1", captureId: "cap1" })
  must(r.status === 200 && r.json.checkStatus === "passed" && r.json.diff.changedPixels === 0, JSON.stringify(r.json).slice(0, 200))
  must(typeof r.json.evidenceFile === "string" && r.json.evidenceFile.startsWith("evidence/"), "evidenceFile missing")
  const store = path.join(process.env.DSH_MOBILECODE_REF_ROOT, "reference", r.json.evidenceFile)
  must(existsSync(store), `evidence file not persisted: ${store}`)
})
await ok("defect frames → regression failed with cluster", async () => {
  const a = Buffer.alloc(16 * 16 * 4, 3)
  const b = Buffer.alloc(16 * 16 * 4, 3); paint({ width: 16, height: 16, rgba: b }, 2, 2, 7, 7, 250) // 49px ≥ minPixels 40
  const r = await call({ a: { width: 16, height: 16, rgba: a.toString("base64") }, b: { width: 16, height: 16, rgba: b.toString("base64") }, mode: "regression" })
  must(r.json.checkStatus === "failed" && r.json.diff.clusters.length === 1, JSON.stringify(r.json.diff))
})
await ok("cross-site POST → fence 403", async () => {
  const f = Buffer.alloc(8 * 8 * 4, 1).toString("base64")
  const r = await call({ a: { width: 8, height: 8, rgba: f }, b: { width: 8, height: 8, rgba: f } }, { origin: "http://evil.example", "sec-fetch-site": "cross-site" })
  must(r.status === 403, `status ${r.status}`)
})

console.log(`\n${passed} checks passed`)
