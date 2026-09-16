/**
 * dsh-mobilecode — bounded PNG decoder for native-space regression.
 *
 * Runs ONLY on bytes already inside the store — but store ownership is NOT
 * trust: those bytes originated as user imports. So every input is treated as
 * hostile: per-chunk CRC verification, dimension fences re-enforced at decode
 * time (files can be swapped after import), a decompressed-size budget plus
 * zlib maxOutputLength (deflate bombs die), exact scanline-length validation
 * (truncated IDAT refused), unknown filter bytes refused, and every unsupported
 * format (palette, 16-bit, interlaced, non-PNG) rejected with an explicit
 * reason — NEVER silently approximated, and never falling back to caller
 * pixels while keeping a verified-native label.
 * Scope stays the smallest sufficient subset: 8-bit non-interlaced
 * gray/RGB/RGBA, five scanline filters, stdlib zlib only.
 * ponytail: ceiling = what device screencap + editor exports produce;
 * upgrade path = a real codec dependency IF a workflow needs palette/16-bit.
 */
import zlib from "node:zlib"

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_DIM = 8192 // re-enforced at DECODE time: stored bytes can be swapped
const MAX_RAW = 64_000_000 // decompressed scanline budget — bombs die here

export function decodePngToRgba(buf, { maxPixels = 24_000_000 } = {}) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG")
  let p = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, iend = false
  const idat = []
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p)
    if (len > buf.length) throw new Error(`truncated chunk (declared ${len} > file ${buf.length})`)
    const type = buf.toString("latin1", p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (p + 12 + len > buf.length) throw new Error(`truncated ${type} chunk body`)
    if ((zlib.crc32(buf.subarray(p + 4, p + 8 + len)) >>> 0) !== (buf.readUInt32BE(p + 8 + len) >>> 0)) throw new Error(`corrupt ${type} chunk (CRC mismatch)`)
    if (type === "IHDR") {
      if (len !== 13) throw new Error(`short/oversized IHDR (${len} bytes, spec says 13)`)
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
      if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) throw new Error(`dimension fence violated: ${width}x${height}`)
      if (width * height > maxPixels) throw new Error(`decode guard: ${width}x${height} exceeds ${maxPixels}px`)
    } else if (type === "IDAT") idat.push(Buffer.from(data))
    else if (type === "IEND") { iend = true; break }
    p += 12 + len
  }
  if (!iend) throw new Error("missing IEND — truncated stream")
  if (!width || !height) throw new Error("no IHDR")
  if (interlace !== 0) throw new Error("interlaced PNG not supported (no native claim — refuse, do not approximate)")
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported (8-bit only)`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (!channels) throw new Error(`color type ${colorType} not supported (grayscale/RGB/RGBA only — palette refused)`)
  const stride = width * channels
  const rawSize = (stride + 1) * height
  if (rawSize > MAX_RAW) throw new Error(`decompression budget: ${rawSize} raw bytes > ${MAX_RAW}`)
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_RAW })
  if (raw.length !== rawSize) throw new Error(`truncated IDAT: ${raw.length} decompressed bytes, scanlines need ${rawSize}`)
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  let off = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[off++]
    const line = raw.subarray(off, off + stride); off += stride
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      } else if (filter !== 0) throw new Error(`unknown filter ${filter}`)
      cur[x] = v & 0xff
    }
    cur.copy(prev)
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4
      if (channels === 4) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = cur[s + 3] }
      else if (channels === 3) { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255 }
      else { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255 }
    }
  }
  return { width, height, rgba: out }
}
