/**
 * dsh-mobilecode — mesh wire-contract + agent-tool test (v0.8.0).
 * Drives the six /mesh/* routes through the same fake-req harness routes.mjs
 * uses (emulator-shaped: loopback peer, Host 10.0.2.2), verifies the mesh
 * guard's three trust zones, and exercises the five mesh_* tools against the
 * same hub instance the routes mutate.
 *
 * Run: node test/mesh-routes.mjs   (needs the mount synced; see DSH_MOBILECODE_DIR)
 */

import path from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const target = "C:\\Users\\Administrator\\Desktop\\trachtenberg_method"

const registered = { routes: [], tools: [] }
const ctx = {
  provide() {},
  webServer: { register(route) { registered.routes.push(route); return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}

const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: target })

async function call(route, { method = "GET", query = "", body, headers = {}, remoteAddress = "127.0.0.1", host = "10.0.2.2:3080" } = {}) {
  const req = {
    method,
    url: route.path + query,
    headers: { host, ...headers },
    socket: { remoteAddress },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  let status = 0
  let json
  const res = { writeHead(code) { status = code }, end(text) { try { json = JSON.parse(text) } catch { json = text } } }
  await route.handler(req, res)
  return { status, json }
}

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
const byPath = (p) => registered.routes.find((r) => r.path === p)
const JOIN = byPath("/api/dsh-mobilecode/mesh/join")
const PEERS = byPath("/api/dsh-mobilecode/mesh/peers")
const LINK = byPath("/api/dsh-mobilecode/mesh/link")
const SEND = byPath("/api/dsh-mobilecode/mesh/send")
const POLL = byPath("/api/dsh-mobilecode/mesh/poll")
const LEAVE = byPath("/api/dsh-mobilecode/mesh/leave")
for (const [name, route] of Object.entries({ JOIN, PEERS, LINK, SEND, POLL, LEAVE })) {
  if (!route) { console.error(`FAIL  route ${name} not registered`); process.exitCode = 1 }
}
if (process.exitCode) process.exit(1)

console.log("— join: two emulators, serial-pinned callsigns —")
const p1 = await call(JOIN, { method: "POST", body: { serial: "emulator-5554" } })
const p2 = await call(JOIN, { method: "POST", body: { serial: "emulator-5556" } })
ok("join → 200 with peer + token", () => {
  if (p1.status !== 200 || !p1.json.peer?.id || !p1.json.token) throw new Error(JSON.stringify(p1.json))
  if (!/^[a-z]+-[a-z]+$/.test(p1.json.peer.name)) throw new Error(`callsign shape: ${p1.json.peer.name}`)
})
ok("same serial re-join is idempotent (same id + token)", async () => {
  const again = await call(JOIN, { method: "POST", body: { serial: "emulator-5554" } })
  if (again.json.peer.id !== p1.json.peer.id || again.json.token !== p1.json.token) throw new Error("identity churned")
})
const id1 = p1.json.peer.id, token1 = p1.json.token, name1 = p1.json.peer.name
const id2 = p2.json.peer.id, token2 = p2.json.token, name2 = p2.json.peer.name

console.log("— guard trust zones —")
{
  const evilAddr = await call(PEERS, { remoteAddress: "203.0.113.5", query: `?id=${id1}&token=${token1}` })
  ok("remote (non-loopback) client → 403", () => { if (evilAddr.status !== 403) throw new Error(`status ${evilAddr.status}`) })
  const evilHost = await call(PEERS, { host: "evil.example", query: `?id=${id1}&token=${token1}` })
  ok("loopback addr + foreign Host → 403", () => { if (evilHost.status !== 403) throw new Error(`status ${evilHost.status}`) })
  const browserGood = await call(PEERS, {
    host: "127.0.0.1:3080",
    headers: { origin: "http://127.0.0.1:3080", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
    query: `?id=${id1}&token=${token1}`,
  })
  ok("trusted browser request → 200", () => { if (browserGood.status !== 200) throw new Error(`status ${browserGood.status}`) })
  const browserEvil = await call(PEERS, {
    headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
    query: `?id=${id1}&token=${token1}`,
  })
  ok("cross-site browser request → 403", () => { if (browserEvil.status !== 403) throw new Error(`status ${browserEvil.status}`) })
  const badToken = await call(PEERS, { query: `?id=${id1}&token=nope` })
  ok("bad token → 401", () => { if (badToken.status !== 401) throw new Error(`status ${badToken.status}`) })
}

console.log("— link → send → poll round trip —")
const linked = await call(LINK, { method: "POST", body: { id: id1, token: token1, with: [name2] } })
let session
ok("link → 200 session with both members", () => {
  if (linked.status !== 200) throw new Error(JSON.stringify(linked.json))
  session = linked.json.session
  if (JSON.stringify(session.members.slice().sort()) !== JSON.stringify([name1, name2].sort())) throw new Error(`members ${session.members}`)
})
const sent = await call(SEND, { method: "POST", body: { id: id1, token: token1, session: session.id, body: { type: "attack", dmg: 12 } } })
ok("send → delivered 1 to the other member", () => {
  if (sent.status !== 200 || sent.json.delivered !== 1) throw new Error(JSON.stringify(sent.json))
})
const polled = await call(POLL, { query: `?id=${id2}&token=${token2}&after=0` })
ok("poll recipient → the message, cursor advanced", () => {
  const m = polled.json.messages?.[0]
  if (!m || m.from !== name1 || m.body?.dmg !== 12) throw new Error(JSON.stringify(polled.json))
  if (polled.json.cursor !== m.seq) throw new Error("cursor did not advance")
})
const drained = await call(POLL, { query: `?id=${id2}&token=${token2}&after=${polled.json.cursor}` })
ok("poll after cursor → empty", () => {
  if (drained.json.messages.length !== 0) throw new Error("inbox not drained")
})

console.log("— agent tools on the same hub —")
const toolsByName = Object.fromEntries(registered.tools.map((t) => [t.name ?? t.definition?.name, t]))
const exec = (name, args) => (toolsByName[name]?.execute ?? toolsByName[name]?.definition?.execute)(args)
ok("37 tools registered incl. the nine new ones", () => {
  const names = registered.tools.map((t) => t.name ?? t.definition?.name)
  if (names.length !== 37) throw new Error(`have ${names.length}`)
  for (const n of ["device_display", "device_avd_create", "device_batch", "device_pair_capture", "mesh_status", "mesh_send", "mesh_log", "mesh_tune", "mesh_reset"]) {
    if (!names.includes(n)) throw new Error(`missing ${n}`)
  }
})
{
  const status = await exec("mesh_status", {})
  ok("mesh_status sees both peers + the session", () => {
    if (status.peers.length !== 2 || status.sessions.length !== 1) throw new Error(JSON.stringify(status))
    if (status.sessions[0].policy.latencyMs !== 0) throw new Error("policy should start clean")
  })
  const tuned = await exec("mesh_tune", { session: session.id, latencyMs: 250, dropPct: 50.5 })
  ok("mesh_tune clamps + reports", () => {
    if (tuned.policy.latencyMs !== 250 || tuned.policy.dropPct !== 50.5) throw new Error(JSON.stringify(tuned.policy))
  })
  await exec("mesh_tune", { session: session.id, latencyMs: 0, dropPct: 0 })
  const ghost = await exec("mesh_send", { session: session.id, from: name1, body: { hi: true } })
  ok("mesh_send as a peer works", () => { if (ghost.delivered !== 1) throw new Error(JSON.stringify(ghost)) })
  const log = await exec("mesh_log", { session: session.id })
  ok("mesh_log records send events", () => {
    if (!log.entries.some((e) => e.kind === "send" && e.via === "agent")) throw new Error("no agent send in log")
  })
  await exec("mesh_tune", { session: session.id, latencyMs: 0, dropPct: 0 })
  const left = await call(LEAVE, { method: "POST", body: { id: id2, token: token2 } })
  ok("leave → 200 and the session dissolved", async () => {
    if (left.status !== 200) throw new Error(`status ${left.status}`)
    const after = await exec("mesh_status", {})
    if (after.sessions.length !== 0 || after.peers.length !== 1) throw new Error(JSON.stringify(after))
  })
  const wiped = await exec("mesh_reset", {})
  ok("mesh_reset wipes everything", () => {
    if (wiped.cleared.indexOf("everything") < 0) throw new Error(JSON.stringify(wiped))
  })
}

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
