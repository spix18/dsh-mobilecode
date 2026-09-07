/**
 * dsh-mobilecode — live client interaction probe via CDP: click the Devices
 * sidebar entry, verify the drawer opens, poll the API through the pane's own
 * fetch path, type a directory, hit Detect, and confirm the pane renders the
 * platform pills + controls. Then close the drawer (dispose check).
 */
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
  await send("Runtime.enable")
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return { exception: r.result.exceptionDetails.text }
    return r.result?.result?.value
  }

  console.log("— click the Devices entry —")
  const clicked = await evaluate(`(function(){
    const entry = document.querySelector('[data-dsh-mobilecode-entry]');
    if (!entry) return { ok: false, why: "no entry" };
    entry.click();
    return { ok: true };
  })()`)
  console.log(JSON.stringify(clicked))
  await sleep(1500)

  console.log("— drawer after click —")
  const open = await evaluate(`(function(){
    const drawer = document.querySelector('.dsh-mobilecode-view');
    const style = drawer ? getComputedStyle(drawer) : null;
    return {
      drawer: !!drawer,
      display: style ? style.display : null,
      visibility: style ? style.visibility : null,
      transform: style ? style.transform : null,
      width: style ? style.width : null,
      text: drawer ? drawer.textContent.slice(0, 400) : null,
    };
  })()`)
  console.log(JSON.stringify(open, null, 2))

  console.log("— set directory + click Detect —")
  const detect = await evaluate(`(async function(){
    const input = document.querySelector('.dsh-mobilecode-view input, .dsh-mobilecode-view [type="text"]');
    if (!input) return { ok: false, why: "no input" };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "C:\\\\Users\\\\Administrator\\\\Desktop\\\\mobilecode-example");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const btn = [...document.querySelectorAll('.dsh-mobilecode-view button')].find((b) => /detect/i.test(b.textContent));
    if (!btn) return { ok: false, why: "no detect button", buttons: [...document.querySelectorAll('.dsh-mobilecode-view button')].map((b) => b.textContent) };
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    const pill = [...document.querySelectorAll('.dsh-mobilecode-view *')].find((el) => /android/i.test(el.textContent) && el.children.length === 0);
    const text = document.querySelector('.dsh-mobilecode-view').textContent;
    return { ok: true, hasAndroidPill: !!pill, hasRunButton: /run/i.test(text), hasStartButton: /start/i.test(text), sample: text.slice(0, 300) };
  })()`)
  console.log(JSON.stringify(detect, null, 2))

  console.log("— close the drawer (dispose path) —")
  const closed = await evaluate(`(function(){
    const entry = document.querySelector('[data-dsh-mobilecode-entry]');
    if (entry) entry.click();
    return { ok: true };
  })()`)
  console.log(JSON.stringify(closed))
  await sleep(800)
  const afterClose = await evaluate(`(function(){
    const drawer = document.querySelector('.dsh-mobilecode-view');
    return { drawerStillInDom: !!drawer, style: drawer ? getComputedStyle(drawer).display : null };
  })()`)
  console.log("after close:", JSON.stringify(afterClose))
} finally {
  socket.close()
}
