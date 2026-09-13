import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"

const GUI = "http://127.0.0.1:3080"
const CDP = "http://127.0.0.1:9222"
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdpReachable = async () => { try { return !!(await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) })).json()).webSocketDebuggerUrl } catch { return false } }

let chrome
if (!(await cdpReachable())) {
  const udd = path.join(os.tmpdir(), "mc-debug-kill-" + Date.now())
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=9222`, `--user-data-dir=${udd}`, "--no-first-run", "--window-size=1440,1100", GUI], { stdio: "ignore" })
  for (let i = 0; i < 40 && !(await cdpReachable()); i++) await sleep(500)
}
if (!(await cdpReachable())) { console.error("no CDP"); process.exit(1) }

const credPath = path.join(os.homedir(), ".dsh", ".credentials.yaml")
const m = fs.readFileSync(credPath, "utf8").match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s*secret:\s*(\S+)/)
const secret = Buffer.from(m[1], "base64url")
const authority = "127.0.0.1:3080"
const now = Date.now()
const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600000 })).toString("base64url")
const sig = crypto.createHmac("sha256", secret).update(body).digest().toString("base64url")
const cname = "dsh-auth-" + crypto.createHash("sha256").update(authority).digest().toString("base64url")
const cookie = `v1.${body}.${sig}`

const targets = await (await fetch(`${CDP}/json/list`)).json()
const page = targets.filter((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:3080")).pop() ?? targets.find((t) => t.type === "page")
if (!page) { console.error("no page"); process.exit(1) }
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })
let id = 0; const pending = new Map()
socket.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } }
const send = (method, params = {}) => new Promise((resolve) => { const c = ++id; pending.set(c, resolve); socket.send(JSON.stringify({ id: c, method, params })) })
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return { exception: r.result.exceptionDetails.text }
  return r.result?.result?.value
}
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable")
await send("Network.setCookie", { name: cname, value: cookie, domain: "127.0.0.1", path: "/" })
await send("Page.navigate", { url: GUI })
await sleep(4000)

console.log("heads:", await evaluate(`[...document.querySelectorAll(".mc-live-section .mc-card-head")].map((h) => h.textContent.replace(/\\s+/g, " ").trim())`))
// mimic probe EXACTLY: boot-check opens+closes picker, then coop re-dock, pin, kill
console.log("boot-check open:", await evaluate(`(function(){ document.querySelector(".mc-picker > .mc-btn").click(); return true })()`))
await sleep(400)
console.log("boot rows:", await evaluate(`[...document.querySelectorAll(".mc-picker-pop .mc-picker-row button")].map((b) => b.textContent.trim())`))
console.log("boot-check close:", await evaluate(`(function(){ const t=document.querySelector(".mc-picker > .mc-btn"); if (t) t.click(); return true })()`))
console.log("pop after close:", await evaluate(`!!document.querySelector(".mc-picker-pop")`))
console.log("coop toggle:", await evaluate(`(function(){ const t=[...document.querySelectorAll(".mc-card-head button")].find((x)=>(x.title||"").includes("Co-op")); if(!t) return "no toggle"; t.click(); return "clicked" })()`))
await sleep(3000)
console.log("D2 select:", await evaluate(`document.querySelector(".mc-coop-pane select")?.value ?? "(none)"`))
const d2 = await evaluate(`document.querySelector(".mc-coop-pane select")?.value ?? ""`)
await evaluate(`(function(){ document.querySelector(".mc-live-section > .mc-card:first-child .mc-picker button").click(); return true })()`)
await sleep(400)
console.log("pin D1:", await evaluate(`(function(){
  const skip = ${JSON.stringify(d2)};
  const row = [...document.querySelectorAll(".mc-picker-row")].find((r) => /emulator-\\d+/.test(r.textContent) && !r.textContent.includes(skip));
  if (!row) return "NO PIN ROW";
  row.click();
  return "pinned";
})()`))
await sleep(8000)
console.log("D1 picker label:", await evaluate(`(document.querySelector(".mc-live-section > .mc-card:first-child .mc-picker button")?.textContent || "").replace(" ▾", "").trim()`))
console.log("D2 select:", await evaluate(`document.querySelector(".mc-coop-pane select")?.value ?? ""`))
// now kill D2 through D1's picker — with network interception
await send("Network.enable")
socket.onmessage = null
socket.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.method === "Network.responseReceived") { const u = msg.params.response.url; if (u.includes("/off") || u.includes("device-action")) console.log("NET:", msg.params.response.status, u) } if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } }
await evaluate(`(function(){ document.querySelector(".mc-live-section > .mc-card:first-child .mc-picker button").click(); return true })()`)
await sleep(400)
console.log("kill D2:", await evaluate(`(function(){
  const row = [...document.querySelectorAll(".mc-picker-row")].find((r) => r.textContent.includes(${JSON.stringify(d2)}));
  if (!row) return "NO ROW";
  const btn = [...row.querySelectorAll("button")].find((b) => b.textContent.includes("⏻ off"));
  if (!btn) return "NO OFF BTN";
  if (btn.disabled) return "DISABLED";
  btn.click();
  return "clicked off";
})()`))
await sleep(3000)
// direct /off fetch from the SAME page context, capture status+body
console.log("direct /off:", await evaluate(`(async () => {
  try {
    const r = await fetch(location.origin + "/api/dsh-mobilecode/off", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ serial: ${JSON.stringify(d2)} }) });
    const t = await r.text();
    return { status: r.status, body: t.slice(0, 200) };
  } catch (e) { return { threw: String(e) }; }
})()`))
await sleep(3000)
console.log("D2 after kill:", await evaluate(`({ badge: !!document.querySelector(".mc-coop-pane .mc-live-badge"), img: !!document.querySelector(".mc-coop-pane .mc-live-stage img"), sel: document.querySelector(".mc-coop-pane select")?.value ?? null, err: document.querySelector(".mc-coop-pane .mc-error")?.textContent ?? null, d1err: document.querySelector(".mc-live-section > .mc-card:first-child .mc-error")?.textContent ?? null })`))
if (chrome) chrome.kill()
process.exit(0)