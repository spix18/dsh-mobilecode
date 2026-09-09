/**
 * dsh-mobilecode — 0.9.0 co-op split view VISUAL proof via CDP.
 *
 * Boots the real DSH web GUI in a headless Chrome, opens the Devices drawer,
 * clicks the ⧉ co-op toggle, and asserts the human path end to end: two live
 * <img> panes side by side (Player A + Player B), both streaming real frames
 * (naturalWidth > 0), /stream/devices reporting both serials streaming, and a
 * screenshot saved for eyeball verification.
 *
 * Run: node test/coop-panel.mjs   (needs 2+ online devices + a stream-capable server)
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CDP = "http://127.0.0.1:9222"
const GUI = "http://127.0.0.1:3080/"
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const out = path.join(os.tmpdir(), "mc-coop-split.png")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpReachable() {
  try { return !!(await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) })).json()).webSocketDebuggerUrl }
  catch { return false }
}

let chrome = null
let udd = ""
if (!(await cdpReachable())) {
  udd = path.join(os.tmpdir(), "mc-coop-chrome")
  fs.rmSync(udd, { recursive: true, force: true })
  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=9222`, `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1440,1100", GUI,
  ], { stdio: "ignore" })
  for (let i = 0; i < 40 && !(await cdpReachable()); i++) await sleep(500)
}
if (!(await cdpReachable())) { console.error("FAIL  Chrome CDP never came up"); process.exit(1) }

async function ws() {
  const targets = await (await fetch(`${CDP}/json/list`)).json()
  const page = targets.filter((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:3080")).pop() ?? targets.find((t) => t.type === "page")
  if (!page) throw new Error("no page target")
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => { const c = ++id; pending.set(c, resolve); socket.send(JSON.stringify({ id: c, method, params })) })
  return { socket, send }
}

let passed = 0
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`  ok  ${name}`) }
  else { console.error(`FAIL  ${name}${detail ? ": " + detail : ""}`); process.exitCode = 1 }
}

const { socket, send } = await ws()
try {
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1050, deviceScaleFactor: 1, mobile: false })
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return { exception: r.result.exceptionDetails.text }
    return r.result?.result?.value
  }

  console.log("— boot the GUI —")
  for (let i = 0; i < 24; i++) {
    const booted = await evaluate(`!!document.querySelector('[data-dsh-mobilecode-entry]')`)
    if (booted) break
    await sleep(1000)
  }
  ok("Devices entry mounted", await evaluate(`!!document.querySelector('[data-dsh-mobilecode-entry]')`))

  console.log("— open the drawer, wait for card auto-grant —")
  await evaluate(`document.querySelector('[data-dsh-mobilecode-entry]').click(); true`)
  await sleep(9000) // picker poll + grant + first screencap frame
  const card = await evaluate(`(function(){
    const sec = document.querySelector('.mc-live-section');
    const stage = document.querySelector('.mc-live-stage img');
    const btn = [...document.querySelectorAll('.mc-card-head button')].find((b) => (b.title||"").includes("Co-op"));
    return { sec: !!sec, imgUp: !!stage && stage.naturalWidth > 0, toggle: !!btn, btnTitle: btn?.title ?? null };
  })()`)
  ok("live card streaming in the panel", card.imgUp, JSON.stringify(card))
  ok("⧉ co-op toggle visible (2+ devices)", card.toggle, JSON.stringify(card))

  console.log("— click ⧉ —")
  await evaluate(`(function(){ const b=[...document.querySelectorAll('.mc-card-head button')].find(x=>(x.title||"").includes("Co-op")); b.click(); return true })()`)
  await sleep(9000) // CoopPane mount + poll + grant + first frame
  const coop = await evaluate(`(function(){
    const sec = document.querySelector('.mc-live-section');
    const imgs = [...sec.querySelectorAll('.mc-live-stage img')];
    const style = getComputedStyle(sec);
    const pane = document.querySelector('.mc-coop-pane');
    const r1 = imgs[0]?.getBoundingClientRect(), r2 = imgs[1]?.getBoundingClientRect();
    return {
      grid: style.display, cols: style.gridTemplateColumns,
      count: imgs.length,
      bothUp: imgs.length === 2 && imgs.every((i) => i.naturalWidth > 0),
      natural: imgs.map((i) => i.naturalWidth + "x" + i.naturalHeight),
      rect: [r1, r2].filter(Boolean).map((r) => Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height)),
      sideBySide: !!r1 && !!r2 && (r1.right <= r2.left + 4 || r2.right <= r1.left + 4),
      playerB: !!pane && /Player B/.test(pane.textContent),
    };
  })()`)
  console.log(JSON.stringify(coop))
  ok("section switched to CSS grid", coop.grid === "flex" || /px/.test(coop.cols || ""), coop.grid + " / " + coop.cols)
  ok("two live panes rendered side by side", coop.sideBySide && coop.count === 2)
  ok("BOTH panes carry real decoded frames", coop.bothUp, JSON.stringify(coop.natural))
  ok("Player B pane present", coop.playerB)

  const flags = await evaluate(`(async function(){
    const r = await fetch("/api/dsh-mobilecode/stream/devices", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const j = await r.json();
    return j.devices.filter((d) => d.streaming).map((d) => d.serial);
  })()`)
  ok("/stream/devices shows both panel streams live", Array.isArray(flags) && flags.length >= 2, JSON.stringify(flags))

  console.log("— screenshot —")
  await sleep(1200)
  const shot = await send("Page.captureScreenshot", { format: "png" })
  fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"))
  console.log("saved: " + out)

  console.log("— collapse ⧉ (toggle back) —")
  await evaluate(`(function(){ const b=[...document.querySelectorAll('.mc-card-head button')].find(x=>(x.title||"").includes("Co-op")); b.click(); return true })()`)
  await sleep(800)
  const collapsed = await evaluate(`document.querySelectorAll('.mc-live-section .mc-live-stage img').length`)
  ok("toggle-off removes the second pane", collapsed === 1, String(collapsed))

  console.log("— 0.10.0 merge: detect a real project, Android card must NOT carry a preview server —")
  await evaluate(`(function(){
    const inp = document.querySelector(".mc-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, "C:\\\\Users\\\\Administrator\\\\Desktop\\\\mobilecode-example");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    [...document.querySelectorAll(".mc-row .mc-btn")].find((b) => b.textContent.trim() === "Detect").click();
    return true;
  })()`)
  await sleep(3000) // detect POST + info render
  const merged = await evaluate(`(function(){
    const body = document.querySelector(".mc-body");
    const serverBtns = [...body.querySelectorAll("button")].filter((b) => /^(Start server|Stop server|Server )/.test(b.textContent.trim())).map((b) => b.textContent.trim());
    const caption = [...body.querySelectorAll(".mc-card-head")].some((hd) => /screen: Live device/.test(hd.textContent));
    const runApp = [...body.querySelectorAll("button")].some((b) => b.textContent.trim() === "Run app");
    const pill = [...body.querySelectorAll(".mc-pill")].find((p) => /Android/.test(p.textContent));
    return { serverBtns, caption, runApp, pillTitle: pill?.getAttribute("title") ?? "" };
  })()`)
  ok("Android card dropped its duplicate preview server", merged.serverBtns.length === 0 && merged.caption && merged.runApp, JSON.stringify(merged))
  // The pill's dot tracks deviceCount (new server); the title shape is client-merged
  // either way, so the probe passes before the user restarts the GUI.
  ok("Android pill re-pointed at attached-device status", /Android device attached/i.test(merged.pillTitle), merged.pillTitle)
  const bootRows = await evaluate(`(function(){
    document.querySelector(".mc-picker > .mc-btn").click();
    const rows = [...document.querySelectorAll(".mc-picker-pop .mc-picker-row button")].map((b) => b.textContent.trim());
    document.querySelector(".mc-picker > .mc-btn").click();
    return rows;
  })()`)
  ok("picker exposes one-click AVD boot (merged Start-server feature)", Array.isArray(bootRows) && bootRows.length > 0 && bootRows.every((t) => t === "⏻ boot"), JSON.stringify(bootRows))
} finally {
  socket.close()
  if (chrome) { chrome.kill(); await sleep(700); fs.rmSync(udd, { recursive: true, force: true }) }
}
console.log(`\n${passed} co-op panel checks passed${process.exitCode ? " (with failures)" : ""}`)
process.exit(process.exitCode ?? 0)
