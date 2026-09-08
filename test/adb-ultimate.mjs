/**
 * dsh-mobilecode — offline tests for the 0.6.0 ported helpers
 * (pattern credited to newborne/dsh-adb-ultimate): perf parsers, app-info
 * parser, mdns pairing parsing, and QR credential generation.
 * Pure functions in device-build.js (no device, no DSH wiring).
 *
 * Run: node test/adb-ultimate.mjs
 */

import assert from "node:assert/strict"
import * as DeviceBuild from "../lib/device-build.js"

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

console.log("dsh-mobilecode adb-ultimate-ported offline tests\n")

console.log("— parseMeminfo —")
ok("typical /proc/meminfo", () => {
  const mem = DeviceBuild.parseMeminfo("MemTotal:        8051268 kB\nMemFree:         3020200 kB\nMemAvailable:    4947924 kB\nBuffers:          335188 kB")
  assert.deepEqual(mem, { totalKb: 8051268, availableKb: 4947924, usedKb: 3103344, usedPercent: 38.5 })
})
ok("missing MemAvailable leaves used undefined", () => {
  const mem = DeviceBuild.parseMeminfo("MemTotal:        1000 kB")
  assert.deepEqual(mem, { totalKb: 1000, availableKb: undefined, usedKb: undefined, usedPercent: undefined })
})
ok("garbage returns undefined", () => assert.equal(DeviceBuild.parseMeminfo("no numbers here"), undefined))

console.log("— parseBattery —")
ok("typical dumpsys battery", () => {
  const bat = DeviceBuild.parseBattery("  AC powered: false\n  USB powered: true\n  status: 2\n  health: 2\n  level: 87\n  scale: 100\n  temperature: 310")
  assert.deepEqual(bat, { level: 87, temperatureC: 31, status: "2", health: "2", powered: true })
})
ok("missing fields stay undefined", () => {
  const bat = DeviceBuild.parseBattery("")
  assert.equal(bat.level, undefined)
  assert.equal(bat.temperatureC, undefined)
  assert.equal(bat.powered, false)
})

console.log("— parseCpuinfo —")
ok("counts cores and hardware", () => {
  const cpu = DeviceBuild.parseCpuinfo("processor\t: 0\nHardware\t: Qualcomm Technologies, Inc SM8550\nprocessor\t: 1\nprocessor\t: 2")
  assert.deepEqual(cpu, { cores: 3, hardware: "Qualcomm Technologies, Inc SM8550" })
})
ok("no processors → cores undefined", () => {
  const cpu = DeviceBuild.parseCpuinfo("Hardware\t: x86_64")
  assert.equal(cpu.cores, undefined)
})

console.log("— parseAppInfo —")
const SAMPLE_DUMPSYS = [
  "Packages:",
  "  Package [com.android.chrome] (abc):",
  "    versionName=119.0.6045.163",
  "    versionCode=604516301 minSdk=26 targetSdk=34",
  "    requested permissions:",
  "      android.permission.INTERNET",
  "      android.permission.ACCESS_NETWORK_STATE",
  "      android.permission.CAMERA",
  "    install permissions:",
  "      android.permission.INTERNET",
  "    Activity Resolver Table:",
  "      Full MIME Types:",
  "          vnd.android.cursor.item/telephony-carrier:",
  "            5f60459 com.android.chrome/.Settings$MainActivity filter 4e9281e",
  "      com.android.chrome/com.google.android.apps.chrome.Main (86d7cef)",
  "      com.android.chrome/.LauncherActivity (6af1)",
  "",
].join("\n")
ok("version + permissions + activities", () => {
  const info = DeviceBuild.parseAppInfo(SAMPLE_DUMPSYS, "com.android.chrome")
  assert.equal(info.versionName, "119.0.6045.163")
  assert.equal(info.versionCode, "604516301")
  assert.equal(info.minSdk, "26")
  assert.equal(info.targetSdk, "34")
  assert.deepEqual(info.permissions, ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", "android.permission.CAMERA"])
  assert.deepEqual(info.activities, ["com.android.chrome/.Settings$MainActivity", "com.android.chrome/com.google.android.apps.chrome.Main", "com.android.chrome/.LauncherActivity"])
})
ok("not installed → undefined version", () => {
  const info = DeviceBuild.parseAppInfo("", "com.missing.app")
  assert.equal(info.versionName, undefined)
  assert.equal(info.package, "com.missing.app")
})

console.log("— parseMdnsPairing —")
ok("finds _adb-tls-pairing._tcp and extracts ip:port", () => {
  const out = "List of discovered mdns services:\n_ADB/_tcp\tADB_WIFI_xxxxxxxxxxxxxx-yyyyyy\tlocal\t00000000-0000-0000-0000-000000000000\t192.168.1.23:37000\n" +
    "_adb-tls-pairing._tcp\tlocal\t00000000-0000-0000-0000-000000000000\t192.168.1.23:43403"
  assert.equal(DeviceBuild.parseMdnsPairing(out), "192.168.1.23:43403")
})
ok("no pairing service → undefined", () => {
  assert.equal(DeviceBuild.parseMdnsPairing("List of discovered mdns services:\n_ADB/_tcp ..."), undefined)
})

console.log("— generateQrAdbWifi / randomQrCredentials —")
ok("QR format matches Android's WIFI:T:ADB grammar", () => {
  const qr = DeviceBuild.generateQrAdbWifi("ADB_WIFI_abcdefghijklmn-ab12cd", "secret1234567890abc")
  assert.equal(qr, "WIFI:T:ADB;S:ADB_WIFI_abcdefghijklmn-ab12cd;P:secret1234567890abc;;")
})
ok("random credentials match the name/password structure", () => {
  const { name, password } = DeviceBuild.randomQrCredentials()
  assert.match(name, /^ADB_WIFI_[A-Za-z0-9]{14}-[A-Za-z0-9]{6}$/)
  assert.match(password, /^[A-Za-z0-9]{21}$/)
})

console.log("— jsonSafe (lossless DSH tool output) —")
ok("strips undefined keys and array holes, keeps numbers/strings", () => {
  const out = DeviceBuild.jsonSafe({ a: 1, b: undefined, c: { d: 'x', e: undefined }, f: [1, undefined, 2], g: NaN, h: Infinity, i: null, j: false })
  assert.deepEqual(out, { a: 1, c: { d: 'x' }, f: [1, 2], g: null, h: null, i: null, j: false })
  // round-trips losslessly
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out)
})
ok("parseCpuinfo undefined hardware survives jsonSafe", () => {
  const cpu = DeviceBuild.parseCpuinfo("processor\t: 0\nvendor_id\t: AuthenticAMD")
  const out = DeviceBuild.jsonSafe({ cpu })
  assert.deepEqual(out, { cpu: { cores: 1 } })
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out)
})

console.log(`\n${passed} passed`)
if (process.exitCode) console.error("some checks FAILED")

// Note: adbPair / adbConnectSerial / waitForMdnsPairing are live (real adb);
// they are exercised in the post-release verification, not in this offline file.