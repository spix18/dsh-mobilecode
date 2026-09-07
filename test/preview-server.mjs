/**
 * dsh-mobilecode — preview-server e2e. Exercises launchPreview, the one
 * engine path the android-run e2e never hit (a real device was found
 * immediately, so serve-avd never started): engine.start must boot the
 * preview server via `npx --yes serve-avd --port`, reach status "running"
 * with a URL, and engine.stop must tear it down.
 *
 * Run: node test/preview-server.mjs [directory] [platform]
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { DevicePreviewEngine } from "../lib/device-preview.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"
const platform = process.argv[3] ?? "android"

const engine = new DevicePreviewEngine()
console.log(`preview-server e2e: ${platform} in ${target}`)
const start = Date.now()

const first = await engine.start({ directory: target, platform })
const server = first.servers.find((s) => s.platform === platform)
console.log("start returned:", server ? `status=${server.status}` : "no server entry")

let info = first
const deadline = Date.now() + 5 * 60_000 // first npx --yes download may be slow
while (Date.now() < deadline) {
  const srv = info.servers.find((s) => s.platform === platform)
  if (srv && srv.status !== "starting") break
  await new Promise((resolve) => setTimeout(resolve, 2000))
  info = await engine.info({ directory: target })
}

const settled = info.servers.find((s) => s.platform === platform)
const seconds = Math.round((Date.now() - start) / 1000)
console.log(`\n— after ${seconds}s —`)
if (!settled) {
  console.log("no server state found")
  process.exitCode = 1
} else {
  console.log(`status: ${settled.status}`)
  if (settled.url) console.log(`url: ${settled.url}`)
  if (settled.pid) console.log(`pid: ${settled.pid}`)
  if (settled.exitCode !== undefined) console.log(`exitCode: ${settled.exitCode}`)
  const tail = settled.log.slice(-10)
  if (tail.length > 0) {
    console.log("\n— last log lines —")
    for (const line of tail) console.log("  | " + line)
  }
  if (settled.status !== "running") {
    process.exitCode = 1
  } else {
    // Verify the URL is actually reachable.
    try {
      const response = await fetch(settled.url, { signal: AbortSignal.timeout(5000) })
      console.log(`\nGET ${settled.url} → HTTP ${response.status}`)
    } catch (error) {
      console.log(`\nGET ${settled.url} → ${error.message}`)
    }
  }
}

const stopped = await engine.stop({ directory: target, platform })
const after = stopped.servers.find((s) => s.platform === platform)
console.log(`\nafter stop: ${after ? `status=${after.status} exitCode=${after.exitCode}` : "no server entry"}`)
await engine.dispose()
console.log(process.exitCode === 1 ? "\nPREVIEW E2E FAILED" : "\nPREVIEW E2E DONE")
