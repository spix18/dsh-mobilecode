/**
 * dsh-mobilecode — live GUI e2e driver. Drives the REAL HTTP API served by
 * the mounted plugin inside the running dsh web GUI:
 *   detect → POST /run → poll GET info → verify running → POST /run/stop.
 * Usage: node test/live-run.mjs <directory> <platform> [--start-server]
 *        node test/live-run.mjs <directory> status
 */
const BASE = "http://127.0.0.1:3080/api/dsh-mobilecode"

async function api(path, opts = {}) {
  const url = BASE + path
  const response = await fetch(url, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
  return json
}

const [directory, platform, mode] = process.argv.slice(2)
if (!directory) { console.error("usage: node test/live-run.mjs <dir> <ios|android> [--start-server|status]"); process.exit(1) }

const enc = encodeURIComponent(directory)
const q = `?directory=${enc}`

if (mode === "status") {
  const info = await api(q)
  console.log(JSON.stringify(info, null, 2))
  process.exit(0)
}

if (mode === "--start-server") {
  const started = await api("/start", { method: "POST", body: { directory, platform } })
  console.log("start:", JSON.stringify(started.servers ?? []))
  const deadline = Date.now() + 5 * 60_000
  let info = started
  while (Date.now() < deadline) {
    const srv = info.servers?.find((s) => s.platform === platform)
    if (srv && srv.status !== "starting") break
    await new Promise((r) => setTimeout(r, 2000))
    info = await api(q)
  }
  const srv = info.servers?.find((s) => s.platform === platform)
  console.log("server:", JSON.stringify(srv ?? null))
  if (srv?.url) {
    try {
      const r = await fetch(srv.url, { signal: AbortSignal.timeout(5000) })
      console.log(`GET ${srv.url} → HTTP ${r.status}`)
    } catch (e) { console.log(`GET ${srv.url} → ${e.message}`) }
  }
  await api("/stop", { method: "POST", body: { directory, platform } })
  console.log("stopped")
  process.exit(0)
}

// Default: run the app and poll until it settles.
console.log(`run: ${platform} in ${directory}`)
const start = Date.now()
await api("/run", { method: "POST", body: { directory, platform } })
const BUSY = ["building", "installing", "launching"]
const deadline = Date.now() + 15 * 60_000
let info
while (Date.now() < deadline) {
  info = await api(q)
  const builds = info.builds ?? []
  const busy = builds.some((b) => b.platform === platform && BUSY.includes(b.status))
  if (!busy) break
  await new Promise((r) => setTimeout(r, 3000))
}
const seconds = Math.round((Date.now() - start) / 1000)
const build = (info.builds ?? []).find((b) => b.platform === platform)
console.log(`\n— after ${seconds}s —`)
console.log(JSON.stringify({ platforms: info.platforms, framework: info.framework, build }, null, 2))
if (build?.log?.length > 0) {
  console.log("\n— log tail —")
  for (const line of build.log.slice(-20)) console.log("  | " + line)
}
if (build?.status === "running") {
  await api("/run/stop", { method: "POST", body: { directory, platform } })
  console.log("\napp stopped")
}
