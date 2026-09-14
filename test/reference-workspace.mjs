/**
 * dsh-mobilecode — reference workspace store tests (Feature A slice).
 * Pure module tests: header-only dimension parsing, import validation,
 * malformed-meta recovery, persistence across reloads, project isolation,
 * capture association, remove. No devices, no network.
 *
 * Run: node test/reference-workspace.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import assert from "node:assert/strict"

const here = path.dirname(fileURLToPath(import.meta.url))
const { ReferenceWorkspace, imageDimensions, MAX_IMAGE_DIMENSION } = await import(pathToFileURL(path.join(here, "..", "lib", "reference-workspace.js")).href)

let passed = 0
function ok(cond, label) { assert.ok(cond, label); passed += 1; console.log("ok  " + label) }
function throws(fn, re, label) { assert.throws(fn, re, label); passed += 1; console.log("ok  " + label) }

// ── minimal deterministic image bytes ─────────────────────────────────────────
function pngBytes(w, h) {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "latin1")
  buf.writeUInt32BE(w, 16)
  buf.writeUInt32BE(h, 20)
  buf.writeUInt8(8, 24); buf.writeUInt8(6, 25)
  return buf
}
function jpegBytes(w, h) {
  const buf = Buffer.alloc(21)
  buf[0] = 0xff; buf[1] = 0xd8
  buf[2] = 0xff; buf[3] = 0xc0; buf[4] = 0x00; buf[5] = 0x11; buf[6] = 0x08
  buf.writeUInt16BE(h, 7); buf.writeUInt16BE(w, 9)
  buf[19] = 0xff; buf[20] = 0xd9
  return buf
}
function webpBytes(w, h) {
  const buf = Buffer.alloc(30)
  buf.write("RIFF", 0, "latin1"); buf.write("WEBP", 8, "latin1"); buf.write("VP8X", 12, "latin1")
  buf.writeUInt32LE(10, 16)
  buf.writeUIntLE(w - 1, 24, 3); buf.writeUIntLE(h - 1, 27, 3)
  return buf
}

// ── header-only dimension parsing ─────────────────────────────────────────────
ok(imageDimensions(pngBytes(320, 480))?.width === 320 && imageDimensions(pngBytes(320, 480))?.height === 480, "png header dims")
ok(imageDimensions(jpegBytes(640, 128))?.width === 640 && imageDimensions(jpegBytes(640, 128))?.height === 128, "jpeg header dims")
ok(imageDimensions(webpBytes(100, 200))?.width === 100 && imageDimensions(webpBytes(100, 200))?.height === 200, "webp VP8X header dims")
ok(imageDimensions(Buffer.from("not an image at all, just text bytes........")) === null, "garbage buffer → null")
ok(imageDimensions(Buffer.alloc(4)) === null, "tiny buffer → null")

// ── store lifecycle in a throwaway home ───────────────────────────────────────
const home = mkdtempSync(path.join(tmpdir(), "mc-ref-"))
const wsRoot = new ReferenceWorkspace(path.join(home, "store"))

const b64 = (w, h) => pngBytes(w, h).toString("base64")
const ref = wsRoot.import(
  { project: "trachtenberg", screen: "practice", stateId: "default", filename: "design.png", provenance: "figma-export v3", intendedUse: "compare" },
  `data:image/png;base64,${b64(360, 640)}`,
)
ok(ref.id.length === 16, "generated id")
ok(ref.kind === "reference" && ref.width === 360 && ref.height === 640, "record carries dims + kind")
ok(ref.approved === false && ref.transform === null, "unapproved, no transform baked")
ok(existsSync(ref.file), "image file persisted verbatim")

// validation at the trust boundary
throws(() => wsRoot.import({ project: "", screen: "practice", stateId: "default" }, `data:image/png;base64,${b64(1, 1)}`), /project/, "empty project rejected")
throws(() => wsRoot.import({ project: "p", screen: "s", stateId: "d", filename: "x.gif" }, b64(1, 1)), /unsupported image type/, "gif rejected")
throws(() => wsRoot.import({ project: "p", screen: "s", stateId: "d" }, "not-base64"), /data URL/, "non-data-url rejected")
throws(() => wsRoot.import({ project: "p", screen: "s", stateId: "d" }, `data:image/png;base64,${b64(MAX_IMAGE_DIMENSION + 1, 1)}`), /fence/, "decompression fence rejects oversized header")

// persistence across reload
const reloaded = new ReferenceWorkspace(path.join(home, "store"))
ok(reloaded.list({ project: "trachtenberg" }).length === 1, "record survives reload")
ok(reloaded.get(ref.id)?.source === "design.png", "reload keeps provenance")

// project isolation
wsRoot.import({ project: "other-app", screen: "home", stateId: "default" }, `data:image/png;base64,${b64(10, 10)}`)
ok(wsRoot.list({ project: "trachtenberg" }).length === 1, "project filter isolates")
ok(wsRoot.list().length === 2, "all projects visible without filter")

// active flag
const act = wsRoot.setActive(ref.id)
ok(act.active === true && wsRoot.active("trachtenberg")?.id === ref.id, "setActive + active()")
ok(wsRoot.active("other-app") === undefined, "active is per-project")

// malformed metadata recovery (original preserved, never crashes) — uses its own
// throwaway store so the quarantine cannot wipe records the compare checks need.
const corruptHome = mkdtempSync(path.join(tmpdir(), "mc-ref-corrupt-"))
const corruptWs = new ReferenceWorkspace(path.join(corruptHome, "store"))
corruptWs.import({ project: "p", screen: "s", stateId: "d" }, `data:image/png;base64,${b64(1, 1)}`)
const corruptMeta = path.join(corruptHome, "store", "reference", "meta.json")
writeFileSync(corruptMeta, "{ not json !!!", "utf8")
const recovered = new ReferenceWorkspace(path.join(corruptHome, "store"))
ok(recovered.list().length === 0, "malformed meta → empty store, no throw")
const storeFiles = readdirSync(path.join(corruptHome, "store", "reference"))
ok(storeFiles.some((f) => f.startsWith("meta.json.corrupt-")), "malformed meta quarantined to meta.json.corrupt-*")

// capture association from an existing PNG file
const capSrc = path.join(home, "shot.png")
writeFileSync(capSrc, pngBytes(1080, 2340))
const cap = wsRoot.capture({
  project: "trachtenberg", screen: "practice", stateId: "default", pngPath: capSrc,
  device: { serial: "emulator-5554", width: 1080, height: 2340, density: "420dpi" },
})
ok(cap.kind === "capture" && cap.device.serial === "emulator-5554", "capture record carries device config")
ok(wsRoot.latest("trachtenberg", "practice", "default", "capture")?.id === cap.id, "latest() finds newest capture per key")
ok(wsRoot.latest("trachtenberg", "practice", "default", "reference")?.id === ref.id, "latest() finds newest reference per key")

// remove deletes record + file
const victim = wsRoot.import({ project: "tmp", screen: "x", stateId: "y" }, `data:image/png;base64,${b64(2, 2)}`)
const victimFile = victim.file
ok(wsRoot.remove(victim.id) === true && !existsSync(victimFile), "remove deletes file + record")
ok(wsRoot.remove("no-such-id") === false, "remove of unknown id is a no-op")

// compare pair contracts
const pair = {
  reference: wsRoot.active("trachtenberg") ?? wsRoot.latest("trachtenberg", "practice", "default", "reference"),
  capture: wsRoot.latest("trachtenberg", "practice", "default", "capture"),
}
ok(pair.reference?.id === ref.id && pair.capture?.id === cap.id, "compare pair resolves reference + capture")

console.log(`\n${passed} checks passed`)
rmSync(home, { recursive: true, force: true })