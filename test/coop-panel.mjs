/**
 * dsh-mobilecode — 0.9.0 co-op split view VISUAL proof via CDP.
 *
 * Boots the real DSH web GUI in a headless Chrome, opens the Devices drawer,
 * clicks the ⧉ co-op toggle, and asserts the human path end to end: two live
 * <img> panes side by side (Device 1 + Device 2), both streaming real frames
 * (naturalWidth > 0), /stream/devices reporting both serials streaming, and a
 * screenshot saved for eyeball verification.
 *
 * Run: node test/coop-panel.mjs   (needs 2+ online devices + a stream-capable server)
 */
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CDP = "http://127.0.0.1:9222"
const GUI = "http://127.0.0.1:3080/"
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const out = path.join(os.tmpdir(), "mc-coop-split.png")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** DSH >=0.9 gates the GUI behind an authority-bound cookie; the launch token
 *  only exists in `dsh web` stdout (never on disk). The probe replicates the
 *  cookie mint locally from the same stored HMAC secret — it produces the
 *  exact bytes a browser gets after visiting the printed launch URL, which
 *  is what the user's own browser does on every page load. */
function mintSessionCookie() {
  const credPath = path.join(os.homedir(), ".dsh", ".credentials.yaml")
  const m = fs.readFileSync(credPath, "utf8").match(/client-connection\/browser-session:\s*\n(?:.*\n)*?\s*secret:\s*(\S+)/)
  if (!m) throw new Error("browser-session secret not found in " + credPath)
  const secret = Buffer.from(m[1], "base64url")
  const authority = "127.0.0.1:3080"
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3600000 }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = crypto.createHmac("sha256", secret).update(body).digest().toString("base64url")
  const name = "dsh-auth-" + crypto.createHash("sha256").update(authority).digest().toString("base64url")
  return { name, value: `v1.${body}.${sig}` }
}

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
  // Authenticate the headless browser: the launch-token cookie (see
  // mintSessionCookie above) must be set before the shell will serve the app.
  await send("Network.enable")
  const cookie = mintSessionCookie()
  await send("Network.setCookie", { url: GUI, name: cookie.name, value: cookie.value, path: "/", httpOnly: true, sameSite: "Strict" })
  await send("Page.navigate", { url: GUI })
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
      playerB: !!pane && /Device 2/.test(pane.textContent),
    };
  })()`)
  console.log(JSON.stringify(coop))
  ok("section switched to CSS grid", coop.grid === "flex" || /px/.test(coop.cols || ""), coop.grid + " / " + coop.cols)
  ok("two live panes rendered side by side", coop.sideBySide && coop.count === 2)
  ok("BOTH panes carry real decoded frames", coop.bothUp, JSON.stringify(coop.natural))
  ok("Device 2 pane present", coop.playerB)

  const flags = await evaluate(`(async function(){
    const r = await fetch("/api/dsh-mobilecode/stream/devices", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const j = await r.json();
    return j.devices.filter((d) => d.streaming).map((d) => d.serial);
  })()`)
  ok("/stream/devices shows both panel streams live", Array.isArray(flags) && flags.length >= 2, JSON.stringify(flags))

  console.log("— 0.11.2/3/5 parity: fit stages hug device AR, per-pane rows, shared controls —")
  const fitParity = await evaluate(`(() => {
    const stages = [...document.querySelectorAll(".mc-live-section .mc-live-stage")];
    const sh = stages.map((s) => Math.round(s.getBoundingClientRect().height));
    const fit = stages.filter((s) => s.classList.contains("fit")).length;
    const arVars = stages.map((s) => s.style.getPropertyValue("--mc-ar-n"));
    return { sh, fit, arVars, equal: sh.length === 2 && fit === 2 && Math.abs(sh[0] - sh[1]) <= 2 };
  })()`)
  ok("both Fit stages carry .fit and share one locked height", fitParity.equal, JSON.stringify(fitParity))
  ok("Fit stages carry --mc-ar-n from real frames", fitParity.arVars.every((v) => parseFloat(v) > 0 && parseFloat(v) < 1), JSON.stringify(fitParity.arVars))
  // 0.11.6: the wrapped co-op head offset Device 1's stage ~38px below
  // Device 2's — heads must stay single-row and stage tops must align.
  const vAlign = await evaluate(`(() => {
    const cards = [...document.querySelectorAll(".mc-live-section .mc-card")];
    const heads = cards.map((c) => { const el = c.querySelector(".mc-card-head"); return el ? Math.round(el.getBoundingClientRect().height) : -1; });
    const tops = [...document.querySelectorAll(".mc-live-section .mc-live-stage")].map((s) => Math.round(s.getBoundingClientRect().top));
    return { heads, tops, ok: heads.length === 2 && tops.length === 2 && Math.abs(heads[0] - heads[1]) <= 2 && Math.abs(tops[0] - tops[1]) <= 6 };
  })()`)
  ok("co-op heads stay single-row; stage tops align (0.11.6)", vAlign.ok, JSON.stringify(vAlign))
  const knobs = await evaluate(`({
    d1segs: document.querySelectorAll(".mc-live-section > .mc-card:first-child .mc-live-size .mc-seg").length,
    d2segs: document.querySelectorAll(".mc-coop-pane .mc-live-size .mc-seg").length,
    d2sel: document.querySelectorAll(".mc-coop-pane .mc-live-sizesel").length,
    d1tools: document.querySelectorAll(".mc-live-section > .mc-card:first-child .mc-toolbar button").length,
    d2tools: document.querySelectorAll(".mc-coop-pane .mc-toolbar button").length,
    menus: document.querySelectorAll(".mc-live-section .mc-menu button").length,
  })`)
  ok("both panes carry their own Size/Frame controls", knobs.d1segs === 2 && knobs.d2segs === 2 && knobs.d2sel === 1, JSON.stringify(knobs))
  ok("both panes carry nav toolbar + device menu (0.11.5)", knobs.d1tools === 6 && knobs.d2tools === 5 && knobs.menus === 2, JSON.stringify(knobs))
  // Responsive wrap (0.11.5): narrow the resizable DRAWER → panes stack.
  const wideTop = await evaluate(`({ tops: [...document.querySelectorAll(".mc-live-section .mc-card")].map((c) => Math.round(c.getBoundingClientRect().top)) })`)
  await evaluate(`(function(){ const v = document.querySelector(".dsh-mobilecode-view"); v.__w = v.style.width; v.style.width = "400px"; return true; })()`)
  await sleep(600)
  const narrowTop = await evaluate(`({
    cols: getComputedStyle(document.querySelector(".mc-live-section.coop")).gridTemplateColumns.split(" ").length,
    tops: [...document.querySelectorAll(".mc-live-section .mc-card")].map((c) => Math.round(c.getBoundingClientRect().top)),
  })`)
  await evaluate(`(function(){ const v = document.querySelector(".dsh-mobilecode-view"); v.style.width = v.__w; return true; })()`)
  await sleep(600)
  const backTop = await evaluate(`({ tops: [...document.querySelectorAll(".mc-live-section .mc-card")].map((c) => Math.round(c.getBoundingClientRect().top)) })`)
  ok("narrow window wraps the panes vertically (auto-fit)", narrowTop.cols === 1 && Math.abs(narrowTop.tops[1] - narrowTop.tops[0]) > 100, JSON.stringify(narrowTop))
  ok("wide window restores side-by-side", backTop.tops.length === 2 && Math.abs(backTop.tops[0] - backTop.tops[1]) < 10, JSON.stringify({ wideTop: wideTop.tops, backTop: backTop.tops }))

  await evaluate(`(function(){
    for (const card of document.querySelectorAll(".mc-live-section > .mc-card")) {
      [...card.querySelectorAll(".mc-live-size .mc-seg button")].find((b) => b.textContent.trim() === "M · 320").click();
    }
    return true;
  })()`)
  await sleep(700)
  const parity = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll(".mc-live-section img")];
    const h = imgs.map((i) => Math.round(i.getBoundingClientRect().height));
    return { h, equal: h.length === 2 && Math.abs(h[0] - h[1]) <= 2 };
  })()`)
  ok("equal height at M·320 set independently on both panes", parity.equal, JSON.stringify(parity))

  console.log("— screenshot —")
  await sleep(1200)
  const shot = await send("Page.captureScreenshot", { format: "png" })
  fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"))
  console.log("saved: " + out)

  console.log("— collapse ⧉ (toggle back) —")
  await evaluate(`(function(){ const b=[...document.querySelectorAll('.mc-card-head button')].find(x=>(x.title||"").includes("Co-op")); b.click(); return true })()`)
  await sleep(800)
  const collapsed = await evaluate(`document.querySelectorAll('.mc-live-section .mc-live-stage').length`)
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
    const caption = [...body.querySelectorAll(".mc-card-head")].some((hd) => /screen: Device 1/.test(hd.textContent));
    const runApp = [...body.querySelectorAll("button")].some((b) => b.textContent.trim() === "Run app");
    const pill = [...body.querySelectorAll(".mc-pill")].find((p) => /Android/.test(p.textContent));
    return { serverBtns, caption, runApp, pillTitle: pill?.getAttribute("title") ?? "" };
  })()`)
  ok("Android card dropped its duplicate preview server", merged.serverBtns.length === 0 && merged.caption && merged.runApp, JSON.stringify(merged))
  // The pill's dot tracks deviceCount (new server); the title shape is client-merged
  // either way, so the probe passes before the user restarts the GUI.
  ok("Android pill re-pointed at attached-device status", /Android device attached/i.test(merged.pillTitle), merged.pillTitle)
  // DSH's React root flushes a programmatic click() one tick later — query
  // synchronously and you race the popover into nonexistence.
  await evaluate(`(function(){ document.querySelector(".mc-picker > .mc-btn").click(); return true })()`)
  await sleep(400)
  const bootRows = await evaluate(`[...document.querySelectorAll(".mc-picker-pop .mc-picker-row button")].map((b) => b.textContent.trim())`)
  ok("picker exposes one-click AVD boot + emulator power-off", Array.isArray(bootRows) && bootRows.includes("⏻ boot") && bootRows.includes("⏻ off") && bootRows.every((t) => t === "⏻ boot" || t === "⏻ off"), JSON.stringify(bootRows))
  const shot2 = await send("Page.captureScreenshot", { format: "png" })
  const out2 = path.join(os.tmpdir(), "mc-merged-boot.png")
  fs.writeFileSync(out2, Buffer.from(shot2.result.data, "base64"))
  console.log("saved: " + out2)
  await evaluate(`(function(){ const t=document.querySelector(".mc-picker > .mc-btn"); if (t) t.click(); return true })()`)

  if (process.env.MC_TEST_OFF === "1") {
    console.log("— 0.11.4 shutdown: ⏻ off must clear Live + frozen frame, and neither pane may re-grab —")
    // Runs last: it takes both emulators offline. Re-dock first — the earlier
    // collapse step left the second pane unmounted.
    await evaluate(`(function(){
      const t = [...document.querySelectorAll(".mc-card-head button")].find((x) => (x.title || "").includes("Co-op"));
      if (t) t.click();
      return true;
    })()`)
    await sleep(3000) // re-dock + refresh + grant + first frame
    // Pin Device 1 to an emulator row that ISN'T Device 2's current pick: an
    // attached physical device sorts first in adb order, and pinning D1 onto
    // D2's device would clear D2 (the co-op guard rejects the conflict).
    const d2Before = await evaluate(`document.querySelector(".mc-coop-pane select")?.value ?? ""`)
    await evaluate(`(function(){
      document.querySelector(".mc-live-section > .mc-card:first-child .mc-picker button").click();
      return true;
    })()`)
    await sleep(400)
    await evaluate(`(function(){
      const skip = ${JSON.stringify(d2Before)};
      const row = [...document.querySelectorAll(".mc-picker-row")].find((r) => /emulator-\\d+/.test(r.textContent) && !r.textContent.includes(skip));
      if (row) row.click();
      return true;
    })()`)
    await sleep(8000) // pick + grant, plus CoopPane's refresh tick + grant
    const d1 = await evaluate(`(document.querySelector(".mc-live-section > .mc-card:first-child .mc-picker button")?.textContent || "").replace(" ▾", "").trim()`)
    const d2 = await evaluate(`document.querySelector(".mc-coop-pane select")?.value ?? ""`)
    ok("panes stream two distinct emulators before the kill", /^emulator-\d+$/.test(d1) && /^emulator-\d+$/.test(d2) && d1 !== d2, `${d1} / ${d2}`)
    // Kill Device 2's serial through Device 1's picker row. The pane must drop
    // its frozen frame AND its select must clear — silently switching to a
    // third device reads as "Live never goes away".
    await evaluate(`(function(){
      document.querySelector(".mc-live-section > .mc-card:first-child .mc-picker button").click();
      return true;
    })()`)
    await sleep(400)
    await evaluate(`(function(){
      const row = [...document.querySelectorAll(".mc-picker-row")].find((r) => r.textContent.includes(${JSON.stringify(d2)}));
      [...row.querySelectorAll("button")].find((b) => b.textContent.includes("⏻ off")).click();
      return true;
    })()`)
    await sleep(16000) // /off (~1s) + two watcher/refresh cycles covering any phase
    const d2state = await evaluate(`(function(){
      const sel = document.querySelector(".mc-coop-pane select");
      const err = document.querySelector(".mc-coop-pane .mc-error");
      return {
        badge: !!document.querySelector(".mc-coop-pane .mc-live-badge"),
        img: !!document.querySelector(".mc-coop-pane .mc-live-stage img"),
        sel: sel?.value ?? null,
        off: document.querySelector(".mc-coop-pane .mc-live-off")?.textContent ?? null,
        err: err?.textContent ?? null,
      };
    })()`)
    ok("⏻ off clears Device 2's Live badge, frame and pick (no third-device re-grab)",
      !d2state.badge && !d2state.img && d2state.sel === "", JSON.stringify(d2state))
    await evaluate(`(function(){
      const row = [...document.querySelectorAll(".mc-picker-row")].find((r) => r.textContent.includes(${JSON.stringify(d1)}));
      [...row.querySelectorAll("button")].find((b) => b.textContent.includes("⏻ off")).click();
      return true;
    })()`)
    await sleep(7000) // must NOT auto-refill: card stays idle after its device dies
    const d1dead = await evaluate(`(function(){
      const card = document.querySelector(".mc-live-section > .mc-card:first-child");
      return !card.querySelector(".mc-live-badge") && !card.querySelector(".mc-live-stage img");
    })()`)
    ok("Device 1 stays idle after ⏻ off (no silent re-grab of a partner)", d1dead === true)
  }
} finally {
  socket.close()
  if (chrome) { chrome.kill(); await sleep(700); fs.rmSync(udd, { recursive: true, force: true }) }
}
console.log(`\n${passed} co-op panel checks passed${process.exitCode ? " (with failures)" : ""}`)
process.exit(process.exitCode ?? 0)
