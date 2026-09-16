/**
 * dsh-mobilecode — reference-comparison workspace (Feature A vertical slice).
 *
 * A project-scoped store of imported design references and device captures,
 * persisted under ~/.dsh/mobilecode/reference/ (Setup.HOME), surviving GUI
 * reloads. The store never trusts caller-supplied paths: images are written
 * under generated ids, records carry metadata only, and association happens
 * through the project/screen/stateId keys.
 *
 * Originals are preserved verbatim; alignment/crop transforms are recorded as
 * metadata on the record (applied at compare time), never baked into the image.
 *
 * Image imports are guarded before any decode: header-only dimension parsing
 * (PNG IHDR, JPEG SOF, WebP chunks) enforces a decompression limit — no pixel
 * buffer is ever materialized by this module.
 *
 * Compare rendering (side-by-side / opacity overlay / swipe slider) is a
 * client concern; this module serves the pair + metadata.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, renameSync } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024 // 25 MB raw body cap (base64 inside JSON)
export const MAX_IMAGE_DIMENSION = 8192 // header-only decompression fence
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"])
const META = "meta.json"
const IMAGES = "images"

/** Header-only dimension read. Returns {width,height} or null when undetectable. */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  // PNG: 8-byte signature, IHDR length+type, then width/height big-endian.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG: scan markers for SOF0..SOF15 (skip SOF1-style 0xC0..0xCF except DHT C4).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i += 1; continue }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if (len < 2 || i + 2 + len > buf.length) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
    return null
  }
  // WebP: RIFF....WEBP + chunk header.
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const four = buf.toString("latin1", 12, 16)
    if (four === "VP8X" && buf.length >= 30) {
      const w = 1 + buf.readUIntLE(24, 3)
      const h = 1 + buf.readUIntLE(27, 3)
      return { width: w, height: h }
    }
    if (four === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (four === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
  }
  return null
}

function nowIso() { return new Date().toISOString() }

/** Validate + normalize the caller-declared import metadata. Throws on bad shape. */
export function validateImportMeta({ project, screen, stateId, filename, provenance, intendedUse } = {}) {
  const clean = (value, label, max) => {
    if (typeof value !== "string" || value.trim() === "" || value.length > max) {
      throw new Error(`${label} is required and must be a non-empty string <= ${max} chars`)
    }
    return value.trim()
  }
  const opt = (value, max) => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined)
  return {
    project: clean(project, "project", 120),
    screen: clean(screen, "screen", 120),
    stateId: clean(stateId, "stateId", 120),
    filename: opt(filename, 200),
    provenance: opt(provenance, 1000),
    intendedUse: opt(intendedUse, 500),
  }
}

export class ReferenceWorkspace {
  constructor(home) {
    this.root = path.join(home, "reference")
    this.imagesDir = path.join(this.root, IMAGES)
    this.metaFile = path.join(this.root, META)
  }

  ensure() {
    if (!existsSync(this.imagesDir)) mkdirSync(this.imagesDir, { recursive: true })
  }

  /** Tolerant read: malformed meta is quarantined (original preserved), never crashes the store. */
  readMeta() {
    this.ensure()
    if (!existsSync(this.metaFile)) return []
    let raw
    try { raw = readFileSync(this.metaFile, "utf8") } catch { return [] }
    let parsed
    try { parsed = JSON.parse(raw) } catch {
      const corrupt = `${this.metaFile}.corrupt-${Date.now()}`
      try { copyFileSync(this.metaFile, corrupt); rmSync(this.metaFile) } catch { /* keep serving empty */ }
      return []
    }
    if (!Array.isArray(parsed)) return []
    // Drop records that no longer satisfy the shape (tolerate unknowns, keep knowns).
    return parsed.filter((r) => r && typeof r === "object" && typeof r.id === "string" && typeof r.project === "string")
  }

  writeMeta(records) {
    this.ensure()
    // atomic (audit F2): a torn meta.json would quarantine the whole store
    const tmp = this.metaFile + ".tmp"
    writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", "utf8")
    renameSync(tmp, this.metaFile)
  }

  #nextId(records) {
    let id
    do { id = crypto.randomBytes(8).toString("hex") } while (records.some((r) => r.id === id))
    return id
  }

  #resolveFile(record) {
    // Never accept caller input as a path: id + stored extension only.
    const ext = typeof record.ext === "string" && ALLOWED_EXT.has(record.ext.toLowerCase()) ? record.ext.toLowerCase() : ".png"
    return path.join(this.imagesDir, `${record.id}${ext}`)
  }

  list({ project } = {}) {
    const records = this.readMeta()
    const scoped = project === undefined ? records : records.filter((r) => r.project === project)
    return scoped.map((r) => ({ ...r, file: this.#resolveFile(r) }))
  }

  get(id) {
    const record = this.readMeta().find((r) => r.id === id)
    return record === undefined ? undefined : { ...record, file: this.#resolveFile(record) }
  }

  latest(project, screen, stateId, kind) {
    const records = this.readMeta()
    const matches = records.filter((r) =>
      r.project === project && r.screen === screen && r.stateId === stateId && r.kind === kind)
    if (matches.length === 0) return undefined
    matches.sort((a, b) => String(b.importedAt ?? "").localeCompare(String(a.importedAt ?? "")))
    const record = matches[0]
    return { ...record, file: this.#resolveFile(record) }
  }

  active(project) {
    const record = this.readMeta().find((r) => r.project === project && r.active === true)
    return record === undefined ? undefined : { ...record, file: this.#resolveFile(record) }
  }

  setActive(id) {
    const records = this.readMeta()
    const target = records.find((r) => r.id === id)
    if (target === undefined) throw new Error(`unknown reference id: ${id}`)
    for (const record of records) record.active = record.id === id
    this.writeMeta(records)
    return { ...target, active: true, file: this.#resolveFile(target) }
  }

  /** Baseline approval — bound to the stored BYTES and recorded capture config at
   *  approval time. A later byte change or config change silently invalidates it
   *  (the diff route re-verifies the binding); candidates never need approval. */
  setApproved(id, approved = true) {
    const records = this.readMeta()
    const target = records.find((r) => r.id === id)
    if (target === undefined) throw new Error(`unknown reference id: ${id}`)
    if (approved) {
      target.approved = true
      target.approval = {
        sha256: crypto.createHash("sha256").update(this.readImage(target)).digest("hex"),
        config: target.device ?? null,
        approvedAt: nowIso(),
      }
    } else {
      target.approved = false
      delete target.approval
    }
    this.writeMeta(records)
    return { ...target, file: this.#resolveFile(target) }
  }

  /**
   * Import a design reference from a base64 data URL (data:image/png;base64,..)
   * or a raw base64 string. Decode-free validation: extension whitelist, byte
   * cap, header-only dimension fence. Original bytes are stored verbatim.
   */
  import(meta, data) {
    const validated = validateImportMeta(meta)
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data ?? ""))
    const b64 = match ? match[2] : (() => {
      const cleaned = String(data ?? "").replace(/^data:image\/[a-z]+;base64,/, "")
      return /^[A-Za-z0-9+/=]+$/.test(cleaned) ? cleaned : ""
    })()
    if (b64 === "") throw new Error("image data must be a base64 data URL (data:image/png;base64,...)")
    const buf = Buffer.from(b64, "base64")
    if (buf.length === 0) throw new Error("image data is empty")
    if (buf.length > MAX_IMPORT_BYTES) throw new Error(`image exceeds ${MAX_IMPORT_BYTES} bytes`)
    const ext = match ? `.${match[1]}` : path.extname(validated.filename ?? "ref.png").toLowerCase()
    // Note: path.extname(".png") returns "" (dotfile semantics), so the matched
    // data-URL extension bypasses extname entirely.
    if (!ALLOWED_EXT.has(ext)) throw new Error(`unsupported image type "${ext}" (png/jpg/webp only)`)
    const dims = imageDimensions(buf)
    if (dims === null) throw new Error("unable to read image dimensions from header")
    if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
      throw new Error(`image is ${dims.width}x${dims.height} — exceeds ${MAX_IMAGE_DIMENSION}px fence`)
    }
    const records = this.readMeta()
    const id = this.#nextId(records)
    const record = {
      id, kind: "reference", project: validated.project, screen: validated.screen, stateId: validated.stateId,
      ext, width: dims.width, height: dims.height,
      source: validated.filename, provenance: validated.provenance, intendedUse: validated.intendedUse,
      importedAt: nowIso(), approved: false, active: false, transform: null,
    }
    this.writeFile(id, ext, buf)
    records.push(record)
    this.writeMeta(records)
    return { ...record, file: this.#resolveFile(record) }
  }

  /**
   * Associate an existing device capture (PNG path from DeviceBuild.screenCapture)
   * with a project/screen/state. The original capture file is copied into the
   * store verbatim; device configuration is recorded as metadata, never edited.
   */
  capture({ project, screen, stateId, pngPath, device }) {
    const validated = validateImportMeta({ project, screen, stateId })
    if (typeof pngPath !== "string" || !existsSync(pngPath)) throw new Error(`capture file not found: ${pngPath}`)
    const buf = readFileSync(pngPath)
    if (buf.length === 0) throw new Error("capture file is empty")
    const dims = imageDimensions(buf)
    if (dims === null) throw new Error("capture is not a readable PNG/JPEG/WebP")
    const records = this.readMeta()
    const id = this.#nextId(records)
    const record = {
      id, kind: "capture", project: validated.project, screen: validated.screen, stateId: validated.stateId,
      ext: ".png", width: dims.width, height: dims.height,
      source: path.basename(pngPath), provenance: "device-capture", intendedUse: "baseline-evidence",
      importedAt: nowIso(), approved: false, active: false, transform: null,
      device: device ?? {},
    }
    copyFileSync(pngPath, this.#resolveFile(record))
    records.push(record)
    this.writeMeta(records)
    return { ...record, file: this.#resolveFile(record) }
  }

  writeFile(id, ext, buf) {
    this.ensure()
    writeFileSync(path.join(this.imagesDir, `${id}${ext}`), buf)
  }

  readImage(record) {
    return readFileSync(this.#resolveFile(record))
  }

  remove(id) {
    const records = this.readMeta()
    const target = records.find((r) => r.id === id)
    if (target === undefined) return false
    const file = this.#resolveFile(target)
    try { rmSync(file, { force: true }) } catch { /* best-effort file removal */ }
    this.writeMeta(records.filter((r) => r.id !== id))
    return true
  }
}
