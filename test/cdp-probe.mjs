/**
 * dsh-mobilecode — live client-bundle probe via Chrome DevTools Protocol.
 * Loads the real DSH web GUI headlessly, waits for the client-modules boot,
 * then checks whether the dsh-mobilecode bundle registered and its Devices
 * sidebar entry mounted in the live DOM.
 */
import { spawn } from "node:child_process"

const CDP = "http://127.0.0.1:9222"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ws() {
  const targets = await (await fetch(`${CDP}/json/list`)).json()
  const page = targets.find((t) => t.type === "page")
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
    new Promise((resolve) => {
      const callId = ++id
      pending.set(callId, resolve)
      socket.send(JSON.stringify({ id: callId, method, params }))
    })
  return { socket, send }
}

const { socket, send } = await ws()
try {
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Page.navigate", { url: "http://127.0.0.1:3080/" })
  // Let the module graph boot + bundle arrive + React mount.
  await sleep(12000)

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true })
    return r.result?.result?.value
  }

  const loaderState = await evaluate(`(function(){
    const l = window.__ModuleLoader__;
    return { mode: l && l.mode, hasLoader: !!l };
  })()`)
  console.log("loader:", JSON.stringify(loaderState))

  const bundleState = await evaluate(`(function(){
    try {
      const sys = window.__DSH_BOOT__;
      const names = Object.keys(window).filter(k => /mobilecode/i.test(k));
      return { bootKeys: names, hasDshBoot: !!sys };
    } catch (e) { return { error: String(e) } }
  })()`)
  console.log("boot:", JSON.stringify(bundleState))

  const domState = await evaluate(`(function(){
    const entry = document.querySelector('[data-dsh-mobilecode-entry]');
    const drawer = document.querySelector('.dsh-mobilecode-view');
    const labels = [];
    document.querySelectorAll('[class*="sidebar"] *, [data-pane="sidebar"] *').forEach((el) => {
      const t = el.textContent && el.textContent.trim();
      if (t && t.length < 40 && /Devices|mobilecode/i.test(t)) labels.push(t.slice(0, 40));
    });
    return { entry: !!entry, entryLabel: entry ? entry.textContent.trim() : null, drawer: !!drawer, labels: [...new Set(labels)].slice(0, 10) };
  })()`)
  console.log("dom:", JSON.stringify(domState, null, 2))

  const url = await evaluate("location.href")
  console.log("url:", url)
} finally {
  socket.close()
}
