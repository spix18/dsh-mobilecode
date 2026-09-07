/**
 * dsh-mobilecode — end-to-end Android run against a real device.
 * Exercises the full ported execute pipeline: detect → preflight → gradle
 * assembleDebug → aapt2 app id → adb install → am start, then quits the app.
 *
 * Run: node test/e2e-android.mjs [directory] [serial]
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { DevicePreviewEngine } from "../lib/device-preview.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const engine = new DevicePreviewEngine()
const BUSY = ["building", "installing", "launching"]

console.log(`e2e android run in ${target}`)
const start = Date.now()
const first = await engine.runApp({ directory: target, platform: "android" })
console.log("runApp returned:", JSON.stringify({ platforms: first.platforms, builds: first.builds.map((b) => ({ platform: b.platform, status: b.status, step: b.step })) }))

let info = first
const deadline = Date.now() + 15 * 60_000
while (Date.now() < deadline) {
  const busy = info.builds.some((b) => b.platform === "android" && BUSY.includes(b.status))
  if (!busy) break
  await new Promise((resolve) => setTimeout(resolve, 2000))
  info = await engine.info({ directory: target })
}

const build = info.builds.find((b) => b.platform === "android")
const seconds = Math.round((Date.now() - start) / 1000)
console.log(`\n— after ${seconds}s —`)
if (!build) {
  console.log("no android build state found")
} else {
  console.log(`status: ${build.status}`)
  if (build.step) console.log(`step: ${build.step}`)
  if (build.target) console.log(`target: ${build.target}`)
  if (build.appID) console.log(`appID: ${build.appID}`)
  if (build.error) console.log(`error: ${build.error}`)
  const tail = build.log.slice(-25)
  if (tail.length > 0) {
    console.log("\n— last log lines —")
    for (const line of tail) console.log("  | " + line)
  }
}

// Leave the device clean: quit the app we launched.
if (build?.status === "running") {
  await engine.stopApp({ directory: target, platform: "android" })
  console.log("\napp stopped")
}

await engine.dispose()
console.log(process.exitCode === 1 ? "\nE2E FAILED" : "\nE2E DONE")
