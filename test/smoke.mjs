/**
 * dsh-mobilecode — standalone smoke test. Verifies the ported engine against
 * the real environment without any DSH wiring:
 *   1. project detection on a known Android project,
 *   2. adb/device discovery,
 *   3. engine.detect + engine.info read model,
 *   4. preflight + gradle wrapper/module/apk-path resolution,
 *   5. launch() win32 .cmd/.bat resolution (npx shim).
 *
 * Run: node test/smoke.mjs [directory]
 */

import assert from "node:assert/strict"
import path from "node:path"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as DeviceBuild from "../lib/device-build.js"
import { DevicePreviewEngine } from "../lib/device-preview.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

let passed = 0
const ok = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

console.log(`dsh-mobilecode smoke test (node ${process.version}, ${process.platform})\n`)

console.log("— project detection —")
const projects = DeviceBuild.findProjects(target)
ok("finds the Android project", () => {
  assert.ok(projects.some((p) => p.platform === "android"), `expected android in ${JSON.stringify(projects.map((p) => p.platform))}`)
})
const android = projects.find((p) => p.platform === "android")
ok("android project has a directory", () => assert.ok(android?.directory))
ok("detectFramework is sane", () => assert.ok(["expo", "react-native", "native"].includes(android?.framework)))

console.log("— android toolchain —")
const sdk = DeviceBuild.androidSdk()
ok("androidSdk() finds a real SDK", () => assert.ok(sdk, "no ANDROID_HOME/Android SDK found"))
ok("adb resolves", () => assert.ok(DeviceBuild.adb()))
const device = await DeviceBuild.androidDevice()
ok("an attached device is visible", () => assert.ok(device, "adb devices shows nothing; is a device plugged in?"))
if (device) console.log(`      device: ${device}`)

console.log("— preflight —")
ok("preflight passes for the android project", () => {
  const problem = DeviceBuild.preflight(android)
  if (problem) throw new Error(problem)
})

console.log("— gradle helpers —")
const wrapper = DeviceBuild.gradleWrapper(android.directory)
ok("gradle wrapper resolves", () => assert.ok(wrapper, "gradlew/gradlew.bat missing"))
const module = DeviceBuild.androidModule(android.directory)
ok("android module resolves", () => assert.ok(module))
ok("androidApk finds no apk before a build (or returns undefined)", () => {
  // Either fine: no build has run yet, so undefined is expected.
  const apk = DeviceBuild.androidApk(android.directory, module)
  if (apk) assert.ok(path.isAbsolute(apk))
})

console.log("— engine read model —")
const engine = new DevicePreviewEngine()
const detected = await engine.detect({ directory: target })
ok("engine.detect returns the platforms", () => assert.deepEqual(detected, projects.map((p) => p.platform)))
const info = await engine.info({ directory: target })
ok("engine.info has platforms", () => assert.ok(info.platforms.length > 0))
ok("engine.info read model shape", () => {
  assert.ok(Array.isArray(info.servers))
  assert.ok(Array.isArray(info.builds))
  assert.ok(info.bundler === undefined || typeof info.bundler === "object")
})
ok("engine.info returns copies, not live state", async () => {
  info.builds.push({ platform: "ios", status: "idle", log: [] })
  const again = await engine.info({ directory: target })
  assert.equal(again.builds.length, 0)
})
await engine.dispose()

console.log("— launch() command resolution —")
await ok("launch() spawns npx and exits 0", async () => {
  const run = DeviceBuild.exec("npx", ["--version"], {})
  const code = await run.exit
  assert.equal(code, 0)
})

console.log("— AVD creation toolchain (v0.8.0) —")
ok("avdmanager resolves in this SDK", () => assert.ok(DeviceBuild.avdmanagerBinary(), "avdmanager.bat not found under cmdline-tools"))
await ok("installedSystemImages lists at least one image", async () => {
  const images = await DeviceBuild.installedSystemImages()
  assert.ok(images.length > 0, "no system images installed")
  assert.match(images[0], /^system-images;android-\d+;[\w-]+;[\w-]+$/)
})
await ok("a real AVD config.ini parses through the clone derivation", async () => {
  const avds = await DeviceBuild.androidAvds()
  if (avds.length === 0) { console.log("      (no AVDs on this host — skipping)"); return }
  const text = readFileSync(DeviceBuild.avdConfigPath(avds[0]), "utf8")
  const sysdir = /^\s*image\.sysdir\.1\s*=\s*(.+)$/m.exec(text)?.[1]?.trim()
  assert.ok(sysdir, `no image.sysdir.1 in ${avds[0]}'s config.ini`)
  const id = sysdir.replace(/\\/g, "/").replace(/\/+$/, "").split("/").join(";")
  assert.match(id, /^system-images;android-\d+;/)
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
