/**
 * lib/png-decode.js bounds tests (audit item 2). Run: node test/png-decode.mjs
 * Stored bytes came from user imports → they are CHECKED, not trusted:
 * CRC, truncated chunks, scanline truncation, filter bytes, unsupported
 * formats, dimension arithmetic, decompression budget.
 */
import assert from "node:assert/strict"
import zlib from "node:zlib"
import { decodePngToRgba } from "../lib/png-decode.js"

const crc32n = (b) => zlib.crc32(b) >>> 0
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32n(td))
  return Buffer.concat([len, td, crc])
}
function build({ size = 4, value = 7, colorType = 2, bitDepth = 8, interlace = 0, filter = 0, rawRows = null, badCrc = false, truncateIdat = 0 } = {}) {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 3
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = interlace
  const stride = size * channels
  const rows = rawRows ?? Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([filter]), Buffer.alloc(stride, value)])))
  let idat = zlib.deflateSync(rows)
  if (truncateIdat > 0) idat = idat.subarray(0, Math.max(0, idat.length - truncateIdat))
  const iend = chunk("IEND", Buffer.alloc(0))
  if (badCrc) { iend.writeUInt32BE(0xdeadbeef, iend.length - 4) }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), iend])
}

let passed = 0
const throws = (name, fn, re) => {
  try { fn(); console.error(`FAIL  ${name}: no throw`); process.exitCode = 1 }
  catch (e) {
    if (re && !re.test(String(e.message))) { console.error(`FAIL  ${name}: wrong reason "${e.message}"`); process.exitCode = 1; return }
    passed += 1; console.log(`  ok  ${name} → ${e.message.slice(0, 60)}`)
  }
}

const good = decodePngToRgba(build())
assert.equal(good.width, 4); assert.equal(good.rgba[0], 7); assert.equal(good.rgba[3], 255) // RGB→RGBA alpha fill
passed += 1; console.log("  ok  valid RGB decodes with alpha=255")

throws("palette color type rejected", () => decodePngToRgba(build({ colorType: 3 })), /color type 3/)
throws("16-bit rejected", () => decodePngToRgba(build({ bitDepth: 16 })), /bit depth 16/)
throws("interlaced rejected", () => decodePngToRgba(build({ interlace: 1 })), /interlaced/)
throws("unknown filter byte rejected", () => decodePngToRgba(build({ filter: 5 })), /filter 5/)
throws("truncated IDAT (short scanlines) rejected", () => decodePngToRgba(build({ truncateIdat: 8 })), /truncated IDAT|invalid|unexpected/)
throws("corrupt chunk CRC rejected", () => decodePngToRgba(build({ badCrc: true })), /CRC mismatch/)
throws("non-PNG rejected", () => decodePngToRgba(Buffer.alloc(40, 1)), /not a PNG/)
throws("huge dimensions rejected", () => decodePngToRgba(build({ size: 9000 })), /dimension fence/)
throws("decompression budget rejected", () => decodePngToRgba(build({ size: 5000 }), { maxPixels: 1e9 }), /budget|guard/)
throws("declared chunk length beyond file rejected", () => {
  const b = build()
  b.writeUInt32BE(10_000, 8) // IHDR length lies
  decodePngToRgba(b)
}, /truncated chunk/)
// filter 1-4 round-trip: encode each scanline with the true predictor, decode, compare
function encodeRows(size, value, f) {
  const stride = size * 3
  const rows = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < size; y++) {
    const cur = Buffer.alloc(stride, value)
    const out = [f]
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? cur[x - 3] : 0, b = prev[x], c = x >= 3 ? prev[x - 3] : 0
      let pred = 0
      if (f === 1) pred = a
      else if (f === 2) pred = b
      else if (f === 3) pred = (a + b) >> 1
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c) }
      out.push((cur[x] - pred) & 0xff)
    }
    rows.push(Buffer.from(out)); prev = cur
  }
  return Buffer.concat(rows)
}
for (const f of [1, 2, 3, 4]) {
  const frames = decodePngToRgba(build({ size: 5, value: 11, filter: f, rawRows: encodeRows(5, 11, f) }))
  assert.equal(frames.rgba[0], 11); assert.equal(frames.rgba[24 * 4], 11)
  passed += 1; console.log(`  ok  filter ${f} round-trip`)
}
throws("short IHDR (12 bytes, VALID CRC) rejected cleanly", () => {
  decodePngToRgba(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", Buffer.alloc(12)), chunk("IDAT", zlib.deflateSync(Buffer.alloc(1))), chunk("IEND", Buffer.alloc(0))]))
}, /short\/oversized IHDR/)
throws("missing IEND rejected", () => {
  const b = build()
  decodePngToRgba(b.subarray(0, b.length - 12)) // drop IEND chunk
}, /missing IEND/)
// RGBA + gray happy paths
assert.equal(decodePngToRgba(build({ colorType: 0 })).rgba[0], 7)
assert.equal(decodePngToRgba(build({ colorType: 6, value: 9 })).rgba[3], 9)
passed += 3; console.log("  ok  gray + RGBA happy paths")

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES ABOVE" : ""}`)
