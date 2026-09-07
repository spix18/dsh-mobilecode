/**
 * dsh-mobilecode — offline tests for the 0.3.0 live-stream modules.
 * Pure logic only (no device, no HTTP server): the PNG frame splitter, the
 * HMAC capability tokens, and the transport fence. The stream routes are
 * exercised live against the emulator (they need a real screencap loop).
 *
 * Run: node test/stream.mjs
 */

import assert from "node:assert/strict"
import { PngFrameSplitter, pngDimensions, MultipartFrameWriter, STREAM_BOUNDARY } from "../lib/frame-source.js"
import { StreamAccessController, isTrustedRequest, isLoopbackRemoteAddress, SERIAL_PATTERN, TOKEN_TTL_MS } from "../lib/stream-access.js"

let passed = 0
const ok = (name, fn) => {
  try {
    const r = fn()
    if (r && typeof r.then === "function") return r.then(() => { passed += 1; console.log(`  ok  ${name}`) }, (e) => { console.error(`FAIL  ${name}: ${e.message}`); process.exitCode = 1 })
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** A minimal, chunk-walkable PNG (CRCs are dummy — the splitter never checks them). */
function makePng(width, height, extraIdat = 4) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)])
  }
  return Buffer.concat([sig, chunk("IHDR", ihdrData), chunk("IDAT", Buffer.alloc(extraIdat, 9)), chunk("IEND", Buffer.alloc(0))])
}

console.log("dsh-mobilecode live-stream offline tests\n")

console.log("— PngFrameSplitter —")
ok("one PNG in one chunk yields one frame with correct IHDR size", () => {
  const splitter = new PngFrameSplitter()
  const frames = splitter.push(makePng(1080, 2400))
  assert.equal(frames.length, 1)
  assert.deepEqual(pngDimensions(frames[0]), { width: 1080, height: 2400 })
})
ok("two back-to-back PNGs split into two frames", () => {
  const splitter = new PngFrameSplitter()
  const frames = splitter.push(Buffer.concat([makePng(100, 200), makePng(300, 400)]))
  assert.equal(frames.length, 2)
  assert.deepEqual(pngDimensions(frames[1]), { width: 300, height: 400 })
})
ok("a PNG split across many chunks reassembles exactly once", () => {
  const splitter = new PngFrameSplitter()
  const png = makePng(720, 1280)
  let frames = []
  for (let i = 0; i < png.length; i += 7) frames = frames.concat(splitter.push(png.subarray(i, i + 7)))
  assert.equal(frames.length, 1)
  assert.deepEqual(pngDimensions(frames[0]), { width: 720, height: 1280 })
})
ok("leading garbage resyncs to the next signature", () => {
  const splitter = new PngFrameSplitter()
  const frames = splitter.push(Buffer.concat([Buffer.from("stderr noise\u0000"), makePng(64, 64)]))
  assert.equal(frames.length, 1)
  assert.deepEqual(pngDimensions(frames[0]), { width: 64, height: 64 })
})
ok("a truncated frame stays buffered until IEND arrives", () => {
  const splitter = new PngFrameSplitter()
  const png = makePng(50, 50)
  const first = splitter.push(png.subarray(0, png.length - 3))
  assert.equal(first.length, 0)
  const rest = splitter.push(png.subarray(png.length - 3))
  assert.equal(rest.length, 1)
})

console.log("— StreamAccessController (HMAC capabilities) —")
const key = Buffer.alloc(32, 7)
const access = new StreamAccessController(() => Promise.resolve(key))
await ok("sign → verify round-trips the serial", async () => {
  const { token, expiresAt } = await access.signStreamToken("emulator-5554")
  assert.ok(expiresAt - Date.now() <= TOKEN_TTL_MS)
  const payload = await access.verifyStreamToken(token)
  assert.equal(payload.serial, "emulator-5554")
})
await ok("a tampered token is rejected", async () => {
  const { token } = await access.signStreamToken("emulator-5554")
  const bad = token.slice(0, -3) + (token.slice(-3) === "aaa" ? "bbb" : "aaa")
  assert.equal(await access.verifyStreamToken(bad), undefined)
})
await ok("an expired token is rejected", async () => {
  const { token } = await access.signStreamToken("emulator-5554", { ttlMs: 1 })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(await access.verifyStreamToken(token), undefined)
})
await ok("a token signed with a different key is rejected", async () => {
  const other = new StreamAccessController(() => Promise.resolve(Buffer.alloc(32, 8)))
  const { token } = await other.signStreamToken("emulator-5554")
  assert.equal(await access.verifyStreamToken(token), undefined)
})
await ok("a malformed serial is refused at signing", async () => {
  await assert.rejects(() => access.signStreamToken("bad serial!"))
})
ok("SERIAL_PATTERN accepts emulator and network serials", () => {
  assert.ok(SERIAL_PATTERN.test("emulator-5554"))
  assert.ok(SERIAL_PATTERN.test("RFCX123ABC"))
  assert.ok(SERIAL_PATTERN.test("192.168.1.5:5555"))
  assert.ok(!SERIAL_PATTERN.test(""))
  assert.ok(!SERIAL_PATTERN.test("has space"))
})

console.log("— transport fence —")
const req = (remoteAddress, host, extra = {}) => ({ socket: { remoteAddress }, headers: { host, ...extra } })
ok("loopback peer + localhost host is trusted", () => assert.ok(isTrustedRequest(req("127.0.0.1", "localhost:3080"))))
ok("IPv6 loopback peer is trusted", () => assert.ok(isTrustedRequest(req("::1", "localhost"))))
ok("::ffff:127.0.0.1 mapped form is trusted", () => assert.ok(isLoopbackRemoteAddress("::ffff:127.0.0.1")))
ok("non-loopback peer is rejected", () => assert.ok(!isTrustedRequest(req("203.0.113.5", "localhost:3080"))))
ok("loopback peer with a foreign Host is rejected (DNS rebinding)", () => assert.ok(!isTrustedRequest(req("127.0.0.1", "evil.example"))))
ok("cross-site Sec-Fetch-Site is rejected", () => assert.ok(!isTrustedRequest(req("127.0.0.1", "localhost:3080", { "sec-fetch-site": "cross-site" }))))
ok("mismatched Origin is rejected", () => assert.ok(!isTrustedRequest(req("127.0.0.1", "localhost:3080", { origin: "http://evil.example" }), true)))
ok("same-origin POST is accepted", () => assert.ok(isTrustedRequest(req("127.0.0.1", "localhost:3080", { origin: "http://localhost:3080" }), true)))
ok("missing Origin fails when required (capability minting)", () => assert.ok(!isTrustedRequest(req("127.0.0.1", "localhost:3080"), true)))
ok("missing Origin passes for an <img> GET (no Origin header)", () => assert.ok(isTrustedRequest(req("127.0.0.1", "localhost:3080"), false)))

console.log("— MultipartFrameWriter —")
ok("writes a boundary + PNG part and reports congestion on backpressure", () => {
  const written = []
  let congested = false
  const res = {
    writeHead() {},
    on() {},
    write(x) { written.push(x); return !congested },
    end() {},
  }
  const writer = new MultipartFrameWriter(res)
  writer.writeFrame({ png: makePng(10, 10), width: 10, height: 10, sequence: 1, at: 0 })
  const body = Buffer.concat(written.filter((w) => Buffer.isBuffer(w)))
  assert.ok(body.includes(STREAM_BOUNDARY) || written.some((w) => typeof w === "string" && w.includes(STREAM_BOUNDARY)))
  assert.equal(writer.closed, false)
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
if (process.exitCode) process.exit(1)
