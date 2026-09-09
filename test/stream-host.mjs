/**
 * dsh-mobilecode — offline tests for AndroidStreamHost (0.9.0 co-op streams).
 * No device, no HTTP: the host runs against a fake frame-loop factory and a
 * fake adb device list (both are constructor seams), so the per-serial stream
 * map — concurrent streams, frame isolation, refcounts, idle stop, crash
 * keep-alive — is fully testable without an emulator.
 *
 * Run: node test/stream-host.mjs
 */

import assert from "node:assert/strict"
import { AndroidStreamHost } from "../lib/android-stream.js"

let passed = 0
const ok = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.stack?.split("\n").slice(0, 3).join(" | ")}`)
    process.exitCode = 1
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fake AdbFrameLoop: start() publishes one frame; emit/exit drive handlers. */
class FakeLoop {
  static created = []
  constructor(serial, handlers) {
    this.serial = serial
    this.handlers = handlers
    this.running = false
    this.stopCount = 0
    this.latestFrame = undefined
    this.stderrLines = ["fake stderr"]
    FakeLoop.created.push(this)
  }
  reset() {}
  start() {
    this.running = true
    this.emit({ width: 1080, height: 2400, sequence: 1, at: Date.now() })
  }
  emit(frame) {
    this.latestFrame = { ...frame, serial: this.serial }
    this.handlers.onFrame(this.latestFrame)
  }
  exit(detail = "boom") {
    this.running = false
    this.handlers.onExit(detail)
  }
  waitForFrame(timeoutMs) {
    if (this.latestFrame !== undefined) return Promise.resolve(this.latestFrame)
    return new Promise((resolve) => setTimeout(() => resolve(this.latestFrame), timeoutMs))
  }
  stop() {
    this.stopCount += 1
    this.running = false
  }
}

/** Build a host over fake loops + a fake adb device list. */
function makeHost2(overrides = {}) {
  FakeLoop.created.length = 0
  return new AndroidStreamHost({
    idleTimeoutMs: 0,
    restartDelayMs: 0,
    firstFrameTimeoutMs: 50,
    loopFactory: (serial, handlers) => new FakeLoop(serial, handlers),
    devicesFn: async () => [
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "device" },
      { serial: "emulator-5557", state: "offline" },
    ],
    ...overrides,
  })
}

console.log("dsh-mobilecode stream-host offline tests\n")

console.log("— single stream —")
await ok("ensureStreaming starts a loop and reports the frame size", async () => {
  const host = makeHost2()
  const info = await host.ensureStreaming({ serial: "emulator-5554" })
  assert.equal(info.serial, "emulator-5554")
  assert.deepEqual({ width: info.width, height: info.height }, { width: 1080, height: 2400 })
  assert.equal(host.running, true)
  assert.deepEqual(host.runningSerials(), ["emulator-5554"])
  host.dispose()
})

await ok("concurrent ensures of one serial share a single launch", async () => {
  const host = makeHost2()
  const [a, b] = await Promise.all([
    host.ensureStreaming({ serial: "emulator-5554" }),
    host.ensureStreaming({ serial: "emulator-5554" }),
  ])
  assert.equal(a.serial, b.serial)
  assert.equal(FakeLoop.created.filter((l) => l.serial === "emulator-5554").length, 1)
  host.dispose()
})

await ok("a device that never produces a first frame fails the launch", async () => {
  FakeLoop.created.length = 0
  const host = new AndroidStreamHost({
    idleTimeoutMs: 0, restartDelayMs: 0, firstFrameTimeoutMs: 30,
    loopFactory: (serial, handlers) => {
      const loop = new FakeLoop(serial, handlers)
      loop.start = () => { loop.running = true } // silent: no frame, ever
      return loop
    },
    devicesFn: async () => [{ serial: "emulator-5554", state: "device" }],
  })
  await assert.rejects(() => host.ensureStreaming({ serial: "emulator-5554" }), /no frame arrived/)
  assert.equal(host.running, false)
  host.dispose()
})

await ok("an offline or unknown serial is refused", async () => {
  const host = makeHost2()
  await assert.rejects(() => host.ensureStreaming({ serial: "emulator-5557" }), /is offline, not ready to stream/)
  await assert.rejects(() => host.ensureStreaming({ serial: "nexus-9" }), /no connected device has the serial nexus-9/)
  host.dispose()
})

console.log("— co-op: concurrent independent streams —")
await ok("starting a second device never retires the first", async () => {
  const host = makeHost2()
  await host.ensureStreaming({ serial: "emulator-5554" })
  await host.ensureStreaming({ serial: "emulator-5556" })
  assert.deepEqual(host.runningSerials(), ["emulator-5554", "emulator-5556"])
  assert.equal(host.streamedSerial, "emulator-5554") // primary = first live
  assert.equal(host.isStreaming("emulator-5556"), true)
  host.dispose()
})

await ok("frame subscribers are serial-scoped (no cross-device leaks)", async () => {
  const host = makeHost2()
  await host.ensureStreaming({ serial: "emulator-5554" })
  await host.ensureStreaming({ serial: "emulator-5556" })
  const a = [], b = []
  const unA = host.subscribeFrames("emulator-5554", (f) => a.push(f))
  host.subscribeFrames("emulator-5556", (f) => b.push(f))
  FakeLoop.created.filter((l) => l.running).find((l) => l.serial === "emulator-5554").emit({ width: 1, height: 1, sequence: 2, at: 0 })
  FakeLoop.created.filter((l) => l.running).find((l) => l.serial === "emulator-5556").emit({ width: 2, height: 2, sequence: 2, at: 0 })
  assert.equal(a.length, 1)
  assert.equal(a[0].serial, "emulator-5554")
  assert.equal(b.length, 1)
  assert.equal(b[0].serial, "emulator-5556")
  unA()
  FakeLoop.created.filter((l) => l.running).find((l) => l.serial === "emulator-5554").emit({ width: 3, height: 3, sequence: 3, at: 0 })
  assert.equal(a.length, 1) // unsubscribed got nothing more
  assert.equal(host.latestFrame("emulator-5554").width, 3)
  host.dispose()
})

await ok("stop(serial) leaves the other stream running", async () => {
  const host = makeHost2()
  await host.ensureStreaming({ serial: "emulator-5554" })
  await host.ensureStreaming({ serial: "emulator-5556" })
  await host.stop("emulator-5554")
  assert.deepEqual(host.runningSerials(), ["emulator-5556"])
  assert.equal(host.status("emulator-5554").running, false)
  assert.equal(FakeLoop.created.find((l) => l.serial === "emulator-5554").stopCount, 1)
  await host.stopAll()
  assert.deepEqual(host.runningSerials(), [])
})

console.log("— refcount, idle, keep-alive —")
await ok("idle timeout stops an unconsumed stream but not a held one", async () => {
  const host = makeHost2({ idleTimeoutMs: 120 })
  const release = host.acquire("emulator-5554")
  await host.ensureStreaming({ serial: "emulator-5554" })
  await host.ensureStreaming({ serial: "emulator-5556" }) // nobody holds 5556
  await sleep(400)
  assert.equal(host.isStreaming("emulator-5554"), true) // timer re-armed while held
  assert.equal(host.isStreaming("emulator-5556"), false) // idle-stopped
  release()
  await sleep(400)
  assert.equal(host.isStreaming("emulator-5554"), false) // stopped after release
  host.dispose()
})

await ok("keep-alive restarts a crashed loop (and only the crashed one)", async () => {
  const host = makeHost2({ restartDelayMs: 0 })
  await host.ensureStreaming({ serial: "emulator-5554" })
  await host.ensureStreaming({ serial: "emulator-5556" })
  const loopsBefore = FakeLoop.created.length
  host.startKeepAlive()
  FakeLoop.created.find((l) => l.serial === "emulator-5554" && l.running).exit("screencap died")
  assert.equal(host.isStreaming("emulator-5554"), false)
  assert.equal(host.isStreaming("emulator-5556"), true)
  await sleep(1600) // > one 1s tick
  assert.equal(host.isStreaming("emulator-5554"), true)
  assert.ok(host.status("emulator-5554").restarts >= 1)
  assert.equal(FakeLoop.created.filter((l) => l.serial === "emulator-5556").length, 1) // untouched
  assert.equal(FakeLoop.created.length, loopsBefore + 1)
  host.dispose()
})

await ok("an intentional stop is never resurrected by keep-alive", async () => {
  const host = makeHost2({ restartDelayMs: 0 })
  host.startKeepAlive()
  await host.ensureStreaming({ serial: "emulator-5554" })
  const before = FakeLoop.created.length
  await host.stop("emulator-5554")
  await sleep(1600)
  assert.equal(FakeLoop.created.length, before)
  host.dispose()
})

console.log("— status / lifecycle —")
await ok("status() follows the primary; status(serial) is explicit", async () => {
  const host = makeHost2()
  assert.equal(host.status().running, false)
  await host.ensureStreaming({ serial: "emulator-5556" })
  const s = host.status()
  assert.equal(s.serial, "emulator-5556")
  assert.equal(s.width, 1080)
  assert.equal(s.stderr.length, 1)
  const held = host.acquire("emulator-5556")
  assert.equal(host.status("emulator-5556").consumers, 1)
  held()
  assert.equal(host.status("emulator-5556").consumers, 0)
  host.dispose()
})

await ok("acquire→release runs exactly once per holder", () => {
  const host = makeHost2()
  const release = host.acquire("emulator-5554")
  assert.equal(host.status("emulator-5554").consumers, 1)
  release()
  release()
  assert.equal(host.status("emulator-5554").consumers, 0)
  host.dispose()
})

await ok("dispose stops every loop and rejects new ensures", async () => {
  const host = makeHost2()
  await host.ensureStreaming({ serial: "emulator-5554" })
  await host.ensureStreaming({ serial: "emulator-5556" })
  host.dispose()
  assert.equal(host.running, false)
  await assert.rejects(() => host.ensureStreaming({ serial: "emulator-5554" }), /disposed/)
})

console.log(`\n${passed} stream-host checks passed${process.exitCode ? " (with failures)" : ""}`)
if (process.exitCode) process.exit(1)
