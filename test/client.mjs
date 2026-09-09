/**
 * dsh-mobilecode — client-bundle smoke test. Loads the real client.js factory
 * the way the web shell does (window.__ModuleLoader__.load with a require),
 * stubs a minimal DOM, and exercises apply(ctx):
 *   1. factory exports apply + inject,
 *   2. apply() mounts the sidebar entry button and the drawer container,
 *   3. ctx.effect disposes everything cleanly,
 *   4. entry click toggles the drawer hidden state.
 *
 * React rendering is swallowed (createRoot stub) — this tests the mount
 * wiring, not the panel components. Run: node test/client.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = process.env["DSH_MOBILECODE_DIR"]
  ? path.join(process.env["DSH_MOBILECODE_DIR"], "lib", "client.js")
  : path.resolve(here, "..", "lib", "client.js")

//#region stub DOM
function makeEl(tag) {
  const el = {
    tagName: (tag ?? "div").toUpperCase(),
    dataset: {},
    style: { cssText: "" },
    attributes: {},
    children: [],
    parentElement: null,
    isConnected: false,
    hidden: false,
    _listeners: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) {
      child.parentElement = this
      this.children.push(child)
      if (this === bodyEl || this.parentElement?.isConnected) child.isConnected = true
      return child
    },
    insertBefore(child, anchor) {
      child.parentElement = this
      const i = anchor === null ? this.children.length : this.children.indexOf(anchor)
      this.children.splice(i < 0 ? this.children.length : i, 0, child)
      return child
    },
    remove() {
      const parent = this.parentElement
      if (parent) {
        const i = parent.children.indexOf(this)
        if (i >= 0) parent.children.splice(i, 1)
      }
      this.parentElement = null
      this.isConnected = false
    },
    addEventListener(type, fn) { this._listeners[type] = fn },
    removeEventListener(type) { delete this._listeners[type] },
    click() { if (this._listeners["click"]) this._listeners["click"]({ clientX: 0, clientY: 0 }) },
    closest() { return null },
    matches() { return false },
    querySelector() { return null },
    getBoundingClientRect() { return { width: 560 } },
  }
  return el
}

const bodyEl = makeEl("body")
bodyEl.isConnected = true
const headEl = makeEl("head")
headEl.isConnected = true

const created = []
globalThis.window = {
  __ModuleLoader__: null,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
}
globalThis.document = {
  body: bodyEl,
  head: headEl,
  createElement(tag) {
    const el = makeEl(tag)
    created.push(el)
    return el
  },
  querySelector(sel) {
    if (sel === '[data-pane="sidebar"], [class*="sidebarCol"]') {
      // a fake sidebar column with a logo row + newSession button
      const column = makeEl("div")
      const logoRow = makeEl("div")
      const button = makeEl("button")
      button.className = "newSession"
      logoRow.appendChild(button)
      column.appendChild(logoRow)
      return column
    }
    if (sel === '[class*="logoRow"]') return makeEl("div")
    return null
  },
  querySelectorAll() { return [] },
  contains() { return true },
}
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb }
  observe() {}
  disconnect() {}
}
globalThis.localStorage = {
  getItem() { return null },
  setItem() {},
}
globalThis.fetch = async () => { throw new Error("fetch should not be called in mount smoke test") }
//#endregion

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

// Stub react / react-dom/client — the factory destructures these at load, and
// apply() only mounts DOM; render is swallowed via createRoot stub.
let factory
window.__ModuleLoader__ = {
  load({ id, factory: f }) {
    assert.equal(id, "dsh-mobilecode", "bundle id mismatch")
    factory = f
  },
}
const stubRequire = (name) => {
  if (name === "react") {
    return { createElement: () => ({}), useEffect() {}, useMemo() {}, useRef() {}, useState() { return [null, () => {}] }, useSyncExternalStore() {} }
  }
  if (name === "react-dom/client") {
    return { createRoot: () => ({ render() {}, unmount() {} }) }
  }
  throw new Error("unexpected require: " + name)
}

console.log("— factory load —")
const clientSrc = fs.readFileSync(clientPath, "utf8")
ok("bundle id and factory registration", () => {
  // evaluate in a scope where require/window exist
  const fn = new Function("require", "window", clientSrc)
  fn(stubRequire, window)
  if (typeof factory !== "function") throw new Error("factory not captured")
})
ok("0.9.0 co-op split view is wired into the bundle", () => {
  assert.match(clientSrc, /function useLiveStream\(/, "shared stream hook missing")
  assert.match(clientSrc, /function CoopPane\(/, "second co-op pane missing")
  assert.match(clientSrc, /function LiveStreamSection\(/, "section wrapper missing")
  assert.match(clientSrc, /h\(LiveStreamSection, null\)/, "panel still mounts the bare card")
  assert.match(clientSrc, /\.mc-live-section\.coop/, "co-op layout CSS missing")
})
ok("0.10.0 preview-server merge: Android card has no Start server; boot moved to the picker", () => {
  assert.match(clientSrc, /const preview = platform === "ios";/, "Android card still owns a preview server")
  assert.match(clientSrc, /screen: Device 1/, "Android→device pointer caption missing")
  assert.match(clientSrc, /streamPost\("\/boot"/, "picker boot action missing")
  assert.match(clientSrc, /⏻ boot/, "boot button label missing")
  assert.match(clientSrc, /deviceCount/, "pill no longer tracks attached devices")
})
ok("0.11.0 naming + power: Device 1/2, ⏻ off, mac-only iOS fallback", () => {
  assert.match(clientSrc, /null, "Device 1"/, "stream card header not renamed")
  assert.match(clientSrc, /null, "Device 2"/, "co-op pane not renamed")
  assert.match(clientSrc, /streamPost\("\/off", \{ serial/, "power-off action missing")
  assert.match(clientSrc, /⏻ off/, "off button label missing")
  assert.match(clientSrc, /style: stageSizeStyle\(sizeMode\)/, "Device 2 img not sized by the shared helper")
  assert.match(clientSrc, /mc-coop-pane[\s\S]+h\(StageControls/, "Device 2 has no Size/Frame row of its own")
  assert.doesNotMatch(clientSrc, /max-height: 48vh/, "coop CSS height cap survived (breaks Fit-mode parity)")
  assert.match(clientSrc, /runningAvds\.has/, "running AVDs still offer a boot button")
  assert.match(clientSrc, /fallbackPlatforms\(info\?\.os\)/, "iOS card not gated on host OS")
  assert.match(clientSrc, /"PaddleOCR 3\.x/, "OCR hint still claims the wrong major (installer pins 3.7.0)")
  assert.doesNotMatch(clientSrc, /PaddleOCR 2\.x/, "stale 2.x copy survived")
})

const moduleExports = factory(stubRequire)
ok("factory exports apply + inject", () => {
  assert.equal(typeof moduleExports.apply, "function")
  assert.ok(Array.isArray(moduleExports.inject))
})

console.log("— apply() mounts —")
const effectCb = []
const slotInjects = []
const ctx = {
  slots: {
    inject(key, callback) {
      slotInjects.push({ key, callback })
      // the runtime runs the callback once the slot declaration exists; simulate that
      const disposer = callback()
      return () => { if (typeof disposer === "function") disposer() }
    },
    register() { return () => {} }, // real runtime provides register; apply() should tolerate it
  },
  effect(fn, label) { effectCb.push(fn); return fn },
}
moduleExports.apply(ctx)
ok("apply() registered a ctx.effect disposer", () => {
  if (effectCb.length !== 1) throw new Error(`expected 1 disposer, got ${effectCb.length}`)
})
ok("settings.section registered for the DSH Settings page", () => {
  const inject = slotInjects.find((s) => s.key === "settings.section")
  if (!inject) throw new Error("no settings.section injection")
  let registered = null
  const fakeSlots = { register: (options, component) => { registered = { options, component }; return () => {} } }
  const oldRegister = ctx.slots.register
  ctx.slots.register = fakeSlots.register
  inject.callback()
  ctx.slots.register = oldRegister
  if (!registered) throw new Error("callback did not call ctx.slots.register")
  if (registered.options.name !== "settings.section") throw new Error(`bad slot name: ${JSON.stringify(registered.options)}`)
  if (registered.options.id !== "mobilecode") throw new Error("section id must be 'mobilecode'")
  if (typeof registered.options.label !== "string") throw new Error("label must be a plain string")
  if (typeof registered.component !== "function") throw new Error("section component must be a render function")
})
const entry = created.find((el) => el.dataset.dshMobilecodeEntry !== undefined)
const view = created.find((el) => el.dataset.dshMobilecodeView !== undefined)
ok("sidebar entry button created", () => {
  if (!entry) throw new Error("no [data-dsh-mobilecode-entry] element")
  if (!/Devices/.test(entry.innerHTML)) throw new Error("entry label missing")
})
ok("drawer container created and hidden initially", () => {
  if (!view) throw new Error("no [data-dsh-mobilecode-view] element")
  if (!view.hidden) throw new Error("drawer should start hidden")
})
ok("entry click opens the drawer", () => {
  entry.click()
  if (view.hidden) throw new Error("drawer should be visible after click")
  entry.click()
  if (!view.hidden) throw new Error("drawer should hide after second click")
})
ok("disposer tears everything down", () => {
  // ctx.effect(fn) convention: DSH calls fn() and keeps the returned cleanup.
  for (const fn of effectCb.splice(0)) fn()()
  const entryAfter = created.some((el) => el.dataset.dshMobilecodeEntry !== undefined && el.isConnected)
  if (entryAfter) throw new Error("entry still connected after dispose")
  if (bodyEl.children.some((el) => el.dataset?.dshMobilecodeView !== undefined)) throw new Error("drawer still in body after dispose")
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
