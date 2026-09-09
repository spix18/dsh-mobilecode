/**
 * One-off 0.10.0 E2E: drive the real POST /boot route against real emulators.
 * Boots mobilecode_test and mobilecode_p2 through the handler (spawn is a
 * side effect — this script exists to verify it exactly once), then re-calls
 * with an already-running AVD to prove the adopt path. Reuses routes.mjs's
 * stub-ctx pattern, pointed at the MOUNT.
 */
import path from "node:path"
import { pathToFileURL } from "node:url"

const pluginDir = "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const registered = { routes: [] }
const ctx = {
  provide() {},
  webServer: { register(r) { registered.routes.push(r); return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}
const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, { defaultDirectory: "C:\\Users\\Administrator\\Desktop\\mobilecode_dsh" })
const route = registered.routes.find((r) => r.path === "/api/dsh-mobilecode/boot")
if (!route) { console.error("FAIL  /boot not registered in mount"); process.exit(1) }

function call(body) {
  const req = {
    method: "POST",
    url: route.path,
    headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" },
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      const chunks = [Buffer.from(JSON.stringify(body), "utf8")]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  let status = 0, json
  const res = { writeHead(c) { status = c }, end(t) { try { json = JSON.parse(t) } catch { json = t } } }
  return route.handler(req, res).then(() => ({ status, json }))
}

console.log("— booting both AVDs through POST /boot (concurrent) —")
const t0 = Date.now()
const [a, b] = await Promise.all([call({ avd: "mobilecode_test" }), call({ avd: "mobilecode_p2" })])
const secs = ((Date.now() - t0) / 1000).toFixed(0)
console.log("mobilecode_test:", JSON.stringify(a), `(${secs}s)`)
console.log("mobilecode_p2:  ", JSON.stringify(b), `(${secs}s)`)
let fails = 0
const fresh = (r) => r.status === 200 && (r.json?.booted || r.json?.alreadyRunning)
if (!fresh(a)) { console.error("FAIL  mobilecode_test boot"); fails++ }
if (!fresh(b)) { console.error("FAIL  mobilecode_p2 boot"); fails++ }
if (a.json?.alreadyRunning || b.json?.alreadyRunning) console.log("note  an AVD was already online — fresh-boot path not fully exercised this run")
if (a.json?.serial && a.json.serial !== b.json?.serial) console.log("ok    distinct serials:", a.json.serial, b.json.serial)
else { console.error("FAIL  serials not distinct"); fails++ }

console.log("— re-call with a running AVD → adopt, no wait —")
const t1 = Date.now()
const adopt = await call({ avd: "mobilecode_test" })
const ms = Date.now() - t1
console.log("adopt:", JSON.stringify(adopt), `(${ms}ms)`)
if (adopt.status !== 200 || adopt.json?.alreadyRunning !== true) { console.error("FAIL  adopt path"); fails++ }
if (ms > 5000) { console.error("FAIL  adopt waited too long (should be instant)"); fails++ }

console.log(fails === 0 ? "\nboot E2E: all checks passed" : `\nboot E2E: ${fails} failures`)
process.exit(fails ? 1 : 0)
