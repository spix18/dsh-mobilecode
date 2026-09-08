/**
 * dsh-mobilecode — pure helpers test for v0.8.0: wm density/size parsing,
 * AVD config.ini merging (clone parity), and device_batch argv building.
 * No device, no adb — this runs anywhere.
 *
 * Run: node test/display-avd.mjs
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

import { parseWmDensity, parseWmSize, mergeAvdConfig } from "../lib/device-build.js"

const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
const { buildInputArgv } = plugin

let passed = 0
const ok = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

console.log("— wm parsing —")
ok("parseWmDensity physical only", () => {
  assert.deepEqual(parseWmDensity("Physical density: 420"), { physical: 420, override: null })
})
ok("parseWmDensity physical + override", () => {
  assert.deepEqual(parseWmDensity("Physical density: 420\nOverride density: 320"), { physical: 420, override: 320 })
})
ok("parseWmDensity override equal to physical reads as none", () => {
  assert.equal(parseWmDensity("Physical density: 420\nOverride density: 420").override, null)
})
ok("parseWmSize override", () => {
  const r = parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600")
  assert.deepEqual(r, { physical: { width: 1080, height: 2400 }, override: { width: 720, height: 1600 } })
})
ok("parseWmSize garbage", () => {
  assert.deepEqual(parseWmSize("error: undetermined"), { physical: undefined, override: null })
})

console.log("— AVD config merge (clone parity) —")
ok("identity keys stay the new AVD's; hardware + image come from the source", () => {
  const fresh = ["avd.id=p2", "avd.name=p2", "displayname=p2", "avd.target=android-35", "hw.ramSize=2048"].join("\n")
  const source = ["avd.id=p1", "avd.name=p1", "displayname=p1", "image.sysdir.1=system-images/android-35/google_apis/x86_64/", "hw.ramSize=4096", "hw.dpi=420"].join("\n")
  const merged = mergeAvdConfig(fresh, source)
  assert.match(merged, /^avd\.id=p2$/m)
  assert.match(merged, /^displayname=p2$/m)
  assert.match(merged, /^hw\.ramSize=4096$/m)
  assert.match(merged, /^hw\.dpi=420$/m)
  assert.match(merged, /^image\.sysdir\.1=system-images\/android-35\/google_apis\/x86_64\/$/m)
})

console.log("— device_batch argv —")
ok("tap", () => {
  assert.deepEqual(buildInputArgv({ action: "tap", x: 540.4, y: 1200 }).argv, ["shell", "input", "tap", "540", "1200"])
})
ok("swipe with duration", () => {
  assert.deepEqual(buildInputArgv({ action: "swipe", x: 1, y: 2, x2: 3, y2: 4, duration: 350 }).argv, ["shell", "input", "swipe", "1", "2", "3", "4", "350"])
})
ok("swipe defaults duration 200", () => {
  assert.deepEqual(buildInputArgv({ action: "swipe", x: 0, y: 0, x2: 10, y2: 10 }).argv.at(-1), "200")
})
ok("text escapes for the shell", () => {
  assert.deepEqual(buildInputArgv({ action: "text", text: "abc" }).argv, ["shell", "input", "text", "abc"])
  assert.deepEqual(buildInputArgv({ action: "text", text: "a b;c" }).argv, ["shell", "input", "text", "a%sb\\;c"])
})
ok("non-ASCII text is refused with the device_input hint", () => {
  assert.throws(() => buildInputArgv({ action: "text", text: "你好" }), /device_input/)
})
ok("key names and raw keycodes", () => {
  assert.deepEqual(buildInputArgv({ action: "key", key: "back" }).argv, ["shell", "input", "keyevent", "4"])
  assert.deepEqual(buildInputArgv({ action: "key", key: "187" }).argv, ["shell", "input", "keyevent", "187"])
  assert.throws(() => buildInputArgv({ action: "key", key: "nope" }), /unknown key/)
})
ok("unknown action / missing coords throw", () => {
  assert.throws(() => buildInputArgv({ action: "fly" }), /unknown step action/)
  assert.throws(() => buildInputArgv({ action: "tap", x: 5 }), /needs numeric x and y/)
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
