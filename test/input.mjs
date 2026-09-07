/**
 * dsh-mobilecode — offline tests for the 0.2.1 input helpers.
 * Pure functions in device-build.js (no device, no DSH wiring).
 *
 * Run: node test/input.mjs
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

console.log("dsh-mobilecode input-helper offline tests\n")

console.log("— escapeInputText —")
ok("spaces become %s", () => assert.equal(DeviceBuild.escapeInputText("hello world"), "hello%sworld"))
ok("shell metacharacters are backslash-escaped", () => {
  assert.equal(DeviceBuild.escapeInputText("a(b)c"), "a\\(b\\)c")
  assert.equal(DeviceBuild.escapeInputText("$HOME"), "\\$HOME")
  assert.equal(DeviceBuild.escapeInputText("x;y|z"), "x\\;y\\|z")
  assert.equal(DeviceBuild.escapeInputText("back\\slash"), "back\\\\slash")
})
ok("plain alphanumerics pass through", () => assert.equal(DeviceBuild.escapeInputText("abc123"), "abc123"))

console.log("— isAsciiInput —")
ok("printable ASCII is safe", () => {
  assert.equal(DeviceBuild.isAsciiInput("hello world 123!@#"), true)
})
ok("non-ASCII is refused", () => {
  assert.equal(DeviceBuild.isAsciiInput("héllo"), false)
  assert.equal(DeviceBuild.isAsciiInput("中文"), false)
  assert.equal(DeviceBuild.isAsciiInput("emoji \u{1F600}"), false)
})
ok("control characters are not safe for input text", () => {
  assert.equal(DeviceBuild.isAsciiInput("tab\there"), false)
})

console.log("— transmission failure classification (0.5.0) —")
ok("detects Wi-Fi serials by trailing :port", () => {
  assert.equal(DeviceBuild.isWifiSerial("192.168.1.23:5555"), true)
  assert.equal(DeviceBuild.isWifiSerial("[::1]:5555"), true)
  assert.equal(DeviceBuild.isWifiSerial("emulator-5554"), false)
  assert.equal(DeviceBuild.isWifiSerial("1b05fbbf"), false)
})
ok("classifies missing/offline/closed devices as transport", () => {
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "error: device '10.0.0.5:5555' not found" }), "transport")
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "adb: no devices/emulators found" }), "transport")
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "error: device offline" }), "transport")
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "error: closed" }), "transport")
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set" }), "transport")
})
ok("multiple attached devices are their own kind", () => {
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "adb: more than one device/emulator" }), "multi-device")
})
ok("real command errors are NOT transport (never trigger a reconnect)", () => {
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "Starting: Intent { ... }\nError type 3", err: "" }), undefined)
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "java.lang.SecurityException: Injecting to another application" }), undefined)
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "", err: "adb: unknown command foo" }), undefined)
  assert.equal(DeviceBuild.classifyAdbFailure({ out: "ok", err: "" }), undefined)
})

console.log("— replay allowlist (reads replay, inputs never do) —")
ok("read-only probes replay after a reconnect", () => {
  for (const argv of [
    ["exec-out", "screencap", "-p"],
    ["exec-out", "uiautomator", "dump", "/dev/tty"],
    ["exec-out", "cat", "/sdcard/window_dump.xml"],
    ["shell", "uiautomator", "dump", "/sdcard/x"],
    ["shell", "dumpsys", "activity", "activities"],
    ["shell", "getprop", "sys.boot_completed"],
    ["shell", "wm", "size"],
    ["shell", "settings", "get", "system", "user_rotation"],
    ["shell", "pm", "list", "packages"],
    ["shell", "ime", "list", "-s"],
    ["shell", "cat", "/sdcard/x"],
    ["shell", "df", "-k", "/data"],
    ["shell", "dmesg"],
    ["logcat", "-d", "-t", "200", "-b", "main"],
    ["emu", "avd", "name"],
    ["shell", "screencap", "-p", "/sdcard/x.png"],
  ]) assert.equal(DeviceBuild.replaySafeAdb(argv), true, JSON.stringify(argv))
})
ok("side-effectful commands never auto-replay", () => {
  for (const argv of [
    ["shell", "input", "tap", "540", "1200"],
    ["shell", "input", "swipe", "0", "0", "0", "0", "200"],
    ["shell", "input", "text", "x"],
    ["shell", "input", "keyevent", "3"],
    ["shell", "am", "start", "-a", "'android.settings.WIFI_SETTINGS'"],
    ["shell", "am", "broadcast", "-a", "ADB_INPUT_B64"],
    ["shell", "am", "force-stop", "com.x"],
    ["shell", "monkey", "-p", "com.x"],
    ["shell", "settings", "put", "system", "user_rotation", "1"],
    ["shell", "ime", "set", "com.x/.Y"],
    ["install", "-r", "-g", "app.apk"],
    ["shell", "rm", "-f", "/sdcard/x"],
    ["emu", "kill"],
  ]) assert.equal(DeviceBuild.replaySafeAdb(argv), false, JSON.stringify(argv))
})

console.log("— ADBKeyboard base64 round trip —")
ok("CJK survives the base64 broadcast encoding", () => {
  const text = "你好世界"
  const encoded = Buffer.from(text, "utf8").toString("base64")
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), text)
})

console.log("— device-shell quoting + intent argv (0.5.0) —")
ok("plain intent values are single-quoted for the device shell", () => {
  assert.deepEqual(
    DeviceBuild.adbIntentArgs({ action: "android.settings.WIFI_SETTINGS" }),
    ["shell", "am", "start", "-a", "'android.settings.WIFI_SETTINGS'"],
  )
})
ok("uri and component map to -d and -n", () => {
  assert.deepEqual(
    DeviceBuild.adbIntentArgs({ uri: "geo:0,0?q=Berlin", component: "com.example/.Main" }),
    ["shell", "am", "start", "-d", "'geo:0,0?q=Berlin'", "-n", "'com.example/.Main'"],
  )
})
ok("an apostrophe cannot break out of the quoting", () => {
  assert.equal(DeviceBuild.shQuoteDevice("it's"), `'it'\\''s'`)
})
ok("semicolons and command substitution stay inside the quotes", () => {
  const quoted = DeviceBuild.shQuoteDevice("a;$(reboot)")
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'") && quoted.includes("a;$(reboot)"))
})
ok("control characters are refused, not stripped", () => {
  assert.throws(() => DeviceBuild.shQuoteDevice("a\nb"), /control characters/)
  assert.throws(() => DeviceBuild.adbIntentArgs({ action: "ok\r\nreboot" }), /control characters/)
})
ok("empty intent parts are skipped", () => {
  assert.deepEqual(DeviceBuild.adbIntentArgs({ action: "", uri: undefined, component: "" }), ["shell", "am", "start"])
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
if (process.exitCode) process.exit(1)
