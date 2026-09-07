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

console.log("— ADBKeyboard base64 round trip —")
ok("CJK survives the base64 broadcast encoding", () => {
  const text = "你好世界"
  const encoded = Buffer.from(text, "utf8").toString("base64")
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), text)
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
if (process.exitCode) process.exit(1)
