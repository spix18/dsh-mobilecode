/**
 * dsh-mobilecode — visual-compare core + /refs/diff wire tests (Feature E).
 * Pure functions get synthetic RGBA fixtures (no-change, seeded defect, masks,
 * size mismatch, envelope honesty); the route is driven with a stub ctx and
 * refuses encoded images instead of approximating.
 *
 * Run: node test/reference-diff.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
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
// ── stored originals: REAL decodable PNGs — native space is server-decoded,
//    forged caller pixels must never influence it (audit §3) ─────────────────
const { ReferenceWorkspace } = await import(pathToFileURL(path.join(here, "..", "lib", "reference-workspace.js")).href)
const storeWs = new ReferenceWorkspace(process.env.DSH_MOBILECODE_REF_ROOT)
const zlibMod = await import("node:zlib")
function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) } return ~c >>> 0 }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function solidPng(size, value, defectAt = null) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x++) {
      const v = defectAt && defectAt[0] === x && defectAt[1] === y ? 250 : value
      row[1 + x * 3] = v; row[2 + x * 3] = v; row[3 + x * 3] = v
    }
    rows.push(row)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlibMod.deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))])
}
function pngOf(w, h) { // header-only stub: dimensions parse, decode MUST fail — provenance cannot be faked with it
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1")
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return b
}
const metaS = { project: "trachtenberg", screen: "s", stateId: "st" }
const cfg = { serial: "emulator-5554", widthPx: 8, heightPx: 8, densityDpi: 420, fontScale: 1 }
const capFile = (name, buf) => { const p = path.join(process.env.DSH_MOBILECODE_REF_ROOT, "..", name); writeFileSync(p, buf); return p }
// capture = records WITH device config (the baseline model needs it); import = no config
const recA = storeWs.capture({ ...metaS, pngPath: capFile("capA.png", solidPng(8, 9)), device: cfg }) // APPROVED baseline
const recB = storeWs.capture({ ...metaS, pngPath: capFile("capB.png", solidPng(8, 9)), device: cfg }) // identical candidate, NEVER approved
const recD = storeWs.capture({ ...metaS, pngPath: capFile("capD.png", solidPng(8, 9, [3, 3])), device: cfg }) // 1-px-defect candidate
const recE = storeWs.capture({ ...metaS, pngPath: capFile("capE.png", solidPng(8, 9)), device: cfg }) // candidate for UNAPPROVED-baseline test
const recG = storeWs.capture({ ...metaS, pngPath: capFile("capG.png", solidPng(8, 9)), device: { ...cfg, densityDpi: 260 } }) // config mismatch
const recF = storeWs.import(metaS, `data:image/png;base64,${solidPng(8, 9).toString("base64")}`) // imported: no config recorded
const recC = storeWs.import(metaS, `data:image/png;base64,${pngOf(8, 4).toString("base64")}`) // undecodable by design
storeWs.setApproved(recA.id) // the ONLY approved baseline; recE/recF test other negatives
storeWs.setApproved(recF.id)

await ok("approved baseline + UNAPPROVED identical candidate → native passed (candidate needs no approval)", async () => {
  const r = await call({ mode: "regression", referenceId: recA.id, captureId: recB.id, project: "trachtenberg", screen: "s", stateId: "st" })
  must(r.json.checkStatus === "passed" && r.json.comparisonSpace === "native", JSON.stringify(r.json).slice(0, 240))
  must(r.json.env.approval.candidateApprovalRequired === false && r.json.env.approval.approvalBindsBytes === true, JSON.stringify(r.json.env.approval))
  must(r.json.env.originals.b.id === recB.id && !("approved" in (r.json.env.originals.b ?? {})), "candidate approval must not even be consulted")
  must(typeof r.json.evidenceFile === "string" && existsSync(path.join(process.env.DSH_MOBILECODE_REF_ROOT, "reference", r.json.evidenceFile)), "evidence file missing")
})
await ok("FORGED identical pixels claiming valid ids CANNOT fake a pass — stored 1-px defect still FAILS", async () => {
  const fake = Buffer.alloc(8 * 8 * 4, 9).toString("base64")
  const r = await call({ a: { width: 8, height: 8, rgba: fake }, b: { width: 8, height: 8, rgba: fake }, mode: "regression", referenceId: recA.id, captureId: recD.id })
  must(r.json.comparisonSpace === "native" && r.json.checkStatus === "failed", JSON.stringify(r.json).slice(0, 200))
  must(r.json.diff.changedPixels === 1 && r.json.diff.clusters.length === 0 && r.json.diff.clusterFilter.droppedPixels === 1, JSON.stringify(r.json.diff))
  must(/^server-decoded-stored-originals/.test(r.json.provenance ?? ""), "provenance field missing")
})
await ok("changed candidate vs approved baseline (no forged frames) → failed", async () => {
  const r = await call({ mode: "regression", referenceId: recA.id, captureId: recD.id })
  must(r.json.checkStatus === "failed" && r.json.diff.changedPixels === 1, JSON.stringify(r.json).slice(0, 160))
})
await ok("UNAPPROVED reference baseline → test rejected (blocked, not needs_review)", async () => {
  const r = await call({ mode: "regression", referenceId: recE.id, captureId: recB.id })
  must(r.json.checkStatus === "blocked", JSON.stringify(r.json).slice(0, 240))
  must((r.json.limitations ?? []).some((l) => /no valid approval/i.test(l)), "rejection reason missing")
})
await ok("approval bound to BYTES: swapping stored baseline bytes after approval invalidates any pass", async () => {
  const approved = storeWs.readImage(recA)
  try {
    storeWs.writeFile(recA.id, ".png", solidPng(8, 9, [7, 7])) // different bytes, same dims
    const r = await call({ mode: "regression", referenceId: recA.id, captureId: recB.id })
    must(r.json.checkStatus === "blocked" && /bytes differ from the approved hash|no valid approval/i.test(JSON.stringify(r.json.limitations)), JSON.stringify(r.json).slice(0, 240))
  } finally {
    storeWs.writeFile(recA.id, ".png", approved) // ALWAYS restore — never poison later tests
  }
})
await ok("identical pixels but DIFFERENT capture config (density 420 vs 260) → never passed", async () => {
  const r = await call({ mode: "regression", referenceId: recA.id, captureId: recG.id })
  must(r.json.checkStatus === "needs_review" && /configurations differ/i.test(JSON.stringify(r.json.limitations)), JSON.stringify(r.json).slice(0, 240))
})
await ok("identical pixels but config NOT RECORDED (imported pair) → needs_review, no certified native pass", async () => {
  const r = await call({ mode: "regression", referenceId: recF.id, captureId: recB.id })
  must(r.json.comparisonSpace === "native" && r.json.checkStatus === "needs_review" && /not recorded/i.test(JSON.stringify(r.json.limitations)), JSON.stringify(r.json).slice(0, 240))
})
await ok("undecodable stored stub + no triage frames → 400 stating missing provenance (no silent fallback)", async () => {
  const r = await call({ mode: "regression", referenceId: recA.id, captureId: recC.id })
  must(r.status === 400 && /provenance/i.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 200))
})
await ok("zero-diff caller frames WITHOUT ids → downsampled triage, never passed", async () => {
  const f = Buffer.alloc(4 * 4 * 4, 9).toString("base64")
  const r = await call({ a: { width: 4, height: 4, rgba: f }, b: { width: 4, height: 4, rgba: f }, mode: "regression" })
  must(r.json.comparisonSpace === "downsampled" && r.json.checkStatus === "needs_review", JSON.stringify(r.json).slice(0, 160))
  must((r.json.limitations ?? []).some((l) => /CANNOT establish native pixel equality/.test(l)), "missing honesty limitation")
})
await ok("regression without stored ids → downsampled at best (no native claim)", async () => {
  const f = Buffer.alloc(16 * 16 * 4, 3).toString("base64")
  const r = await call({ a: { width: 16, height: 16, rgba: f }, b: { width: 16, height: 16, rgba: f }, mode: "regression" })
  must(r.json.comparisonSpace === "downsampled" && r.json.checkStatus === "needs_review", r.json.comparisonSpace + "/" + r.json.checkStatus)
})
await ok("aspect mismatch without transform → blocked (never implicit stretch)", async () => {
  const fa = Buffer.alloc(8 * 8 * 4, 5).toString("base64")
  const fb = Buffer.alloc(8 * 4 * 4, 5).toString("base64")
  const r = await call({ a: { width: 8, height: 8, rgba: fa }, b: { width: 8, height: 4, rgba: fb }, mode: "design-reference", referenceId: recA.id, captureId: recC.id })
  must(r.json.checkStatus === "blocked" && /aspect mismatch/.test(r.json.reason), JSON.stringify(r.json).slice(0, 160))
})
await ok("aspect mismatch WITH recorded transform → proceeds as triage, transform recorded", async () => {
  const fa = Buffer.alloc(8 * 4 * 4, 5).toString("base64")
  const r = await call({ a: { width: 8, height: 4, rgba: fa }, b: { width: 8, height: 4, rgba: fa }, mode: "design-reference", transform: { a: { scaleX: 1, scaleY: 0.5 }, b: {} }, referenceId: recA.id, captureId: recC.id })
  must(r.json.checkStatus === "needs_review" && r.json.transforms?.a?.scaleY === 0.5, JSON.stringify(r.json).slice(0, 160))
})
await ok("mask without reason → 400; mask with reason accepted + echoed", async () => {
  const f = Buffer.alloc(8 * 8 * 4, 9).toString("base64")
  const bad = await call({ a: { width: 8, height: 8, rgba: f }, b: { width: 8, height: 8, rgba: f }, masks: [{ x: 0, y: 0, width: 1, height: 1 }] })
  must(bad.status === 400 && /reason/.test(bad.json.error), JSON.stringify(bad.json))
  const good = await call({ a: { width: 8, height: 8, rgba: f }, b: { width: 8, height: 8, rgba: f }, referenceId: recA.id, captureId: recB.id, masks: [{ x: 0, y: 0, width: 8, height: 8, reason: "clock region changes every capture" }] })
  must(good.json.env?.masks?.[0]?.reason !== undefined, "mask reason not recorded")
})

// ── pure transform / downsample-proof units (audit §2/§3) ─────────────────────
const { applyAlign, mapRegionToFrame, boxAverage, validateMasks } = await import(pathToFileURL(path.join(here, "..", "lib", "visual-compare.js")).href)
await ok("applyAlign honors dx/dy and mapRegionToFrame inverts to original space", async () => {
  const src = frame(100, 100, 0); paint(src, 40, 20, 10, 10, 255)
  const t = { scaleX: 2, scaleY: 2, dx: 5, dy: 7 }
  const aligned = applyAlign(src, t)
  must(aligned.width === 205 && aligned.height === 207, `${aligned.width}x${aligned.height}`)
  // defect (40,20)-(50,30) original → aligned at (40*2+5, 20*2+7)
  const d = diffFrames(applyAlign(frame(100, 100, 0), t), aligned)
  must(d.clusters.length >= 1, "aligned defect must cluster")
  const back = mapRegionToFrame(d.clusters[0], t)
  must(Math.abs(back.x - 40) <= 1 && Math.abs(back.y - 20) <= 1 && back.width >= 10 && back.height >= 10, `mapped ${JSON.stringify(back)}`)
})
await ok("box-average downsample CAN erase a subtle change → reduced-res never passes", async () => {
  const mk = () => { const f = frame(16, 16, 100); for (let i = 3; i < f.rgba.length; i += 4) f.rgba[i] = 255; return f }
  const a = mk()
  const b = mk(); paint(b, 2, 2, 1, 1, 116) // per-channel delta 16 → L1 48 > threshold 24 at native
  must(diffFrames(a, b).changedPixels === 1, "caught at native resolution")
  const avg = diffFrames(boxAverage(a, 4), boxAverage(b, 4)) // 48/4 = 12 < threshold → erased
  must(avg.changedPixels === 0, `expected erasure at 4x box average, got ${avg.changedPixels}`)
})
await ok("validateMasks rejects missing/blank reason", async () => {
  let threw = false
  try { validateMasks([{ x: 0, y: 0, width: 1, height: 1 }]) } catch { threw = true }
  must(threw, "mask without reason accepted")
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
