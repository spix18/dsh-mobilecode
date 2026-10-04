/**
 * dsh-mobilecode — render-cost harness.
 *
 * Mounts the REAL MobileCodePanel through a miniature React and counts how many
 * component bodies re-execute per render pass. It exists because the design
 * audit's last open performance finding was that the panel's 2 s poll was
 * "bounded, not measured": the code provably skipped work when nothing had
 * changed, but nothing produced a NUMBER for what a tick costs when it had not.
 *
 * The miniature React is faithful ONLY for the property measured here — which
 * function-component bodies React re-executes after a state write. It implements
 * the four rules that decide that, and the self-checks below prove each rule
 * before any measurement is trusted:
 *   1. a function component re-renders when its parent renders, unless memo()'d,
 *   2. memo(C) skips the call entirely when its props are shallow-equal,
 *   3. setState with an Object.is-equal value bails out of the render,
 *   4. every setState in one task collapses into ONE render pass (React 18).
 * It is NOT a DOM: host elements become plain nodes and nothing is painted, so
 * these counts are component invocations and never frame time.
 *
 * Run: node test/render.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = process.env["DSH_MOBILECODE_DIR"]
  ? path.join(process.env["DSH_MOBILECODE_DIR"], "lib", "client.js")
  : path.resolve(here, "..", "lib", "client.js")

//#region miniature React
/**
 * Faithful for exactly the four rules listed in the header, and nothing else.
 * Host elements ("div") become plain nodes: no DOM, no attributes, no paint.
 */
const ELEMENT = Symbol("dsh-mobilecode element")

/** Component-invocation log, in render order. The measurement reads this. */
const RENDERS = []
/** Live instances by component name — lets a check ask "did THIS one re-run?". */
const instancesByName = new Map()

let current = null
let hookIndex = 0
let flushing = false

const dirty = new Set()
let effectQueue = []

const shallowEqual = (a, b) => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Object.is(a[k], b[k]))
}

const sameDeps = (a, b) => {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => Object.is(v, b[i]))
}

function flatten(children) {
  const out = []
  const push = (c) => {
    if (Array.isArray(c)) { c.forEach(push); return }
    if (c === null || c === undefined || c === false || c === true || c === "") return
    out.push(c)
  }
  children.forEach(push)
  return out
}

function createElement(type, config, ...children) {
  // React's own algorithm, and the difference MATTERS: with no children
  // `props.children` is left absent, so a parent that re-renders with the same
  // config still hands a memo child shallow-equal props. Inventing `children: []`
  // here would make every memo boundary miss and quietly fake the measurement.
  const props = {}
  let key = null
  if (config !== null && config !== undefined) {
    for (const name of Object.keys(config)) {
      if (name === "key") { key = config[name]; continue }
      props[name] = config[name]
    }
  }
  if (children.length === 1) props.children = children[0]
  else if (children.length > 1) props.children = children
  return { [ELEMENT]: true, type, key: key ?? null, props }
}

const memo = (component, compare) => ({ $$memo: true, component, compare })

function makeInstance(element, key) {
  return { element, key, hooks: [], slots: new Map(), children: [], rendered: false, lastProps: undefined, memoType: null }
}

function renderComponent(inst, component, props) {
  const outer = current
  const outerIndex = hookIndex
  current = inst
  hookIndex = 0
  const name = component.name || "Anonymous"
  RENDERS.push(name)
  instancesByName.set(name, inst)
  let out
  try {
    out = component(props)
  } finally {
    current = outer
    hookIndex = outerIndex
  }
  return out
}

function reconcile(parent, raw) {
  const list = []
  flatten([raw]).forEach((child, i) => {
    if (child === null || typeof child !== "object" || child[ELEMENT] !== true) return
    const key = child.key === null || child.key === undefined ? "#" + i : String(child.key)
    let inst = parent.slots.get(key)
    if (inst === undefined || inst.element.type !== child.type) {
      inst = makeInstance(child, key)
      parent.slots.set(key, inst)
    }
    list.push(inst)
    update(inst, child, false)
  })
  parent.children = list
}

function update(inst, element, force) {
  inst.element = element
  const type = element.type
  const isMemo = type !== null && typeof type === "object" && type.$$memo === true
  const component = isMemo ? type.component : type

  if (typeof component !== "function") {
    reconcile(inst, element.props.children)
    return
  }
  // Rule 2: a memo boundary with shallow-equal props never enters the component.
  if (isMemo && !force && inst.rendered && (type.compare ?? shallowEqual)(inst.lastProps, element.props)) {
    inst.memoType = type
    return
  }
  inst.memoType = isMemo ? type : null
  inst.lastProps = element.props
  inst.rendered = true
  reconcile(inst, renderComponent(inst, component, element.props))
}

function flush() {
  if (dirty.size === 0) return 0
  const batch = [...dirty]
  dirty.clear()
  flushing = true
  try {
    // `force` — an instance dirty from its OWN state write re-renders even
    // across a memo boundary (props equality does not save it in React either).
    for (const inst of batch) update(inst, inst.element, true)
  } finally {
    flushing = false
  }
  return batch.length
}

function runEffects() {
  const queued = effectQueue
  effectQueue = []
  for (const run of queued) run()
  return queued.length
}

function useState(initial) {
  const inst = current
  const i = hookIndex++
  if (inst.hooks.length <= i) inst.hooks[i] = { value: typeof initial === "function" ? initial() : initial }
  const slot = inst.hooks[i]
  const set = (next) => {
    const value = typeof next === "function" ? next(slot.value) : next
    // Rule 3: React bails out of the whole render when the value is identical.
    if (Object.is(value, slot.value)) return
    slot.value = value
    dirty.add(inst)
  }
  return [slot.value, set]
}

function useRef(initial) {
  const inst = current
  const i = hookIndex++
  if (inst.hooks.length <= i) inst.hooks[i] = { current: initial }
  return inst.hooks[i]
}

function useMemo(fn, deps) {
  const inst = current
  const i = hookIndex++
  const slot = inst.hooks[i]
  if (slot === undefined || !sameDeps(slot.deps, deps)) inst.hooks[i] = { deps, value: fn() }
  return inst.hooks[i].value
}

const useCallback = (fn, deps) => useMemo(() => fn, deps)

function useEffect(fn, deps) {
  const inst = current
  const i = hookIndex++
  const slot = inst.hooks[i]
  if (slot !== undefined && sameDeps(slot.deps, deps)) return
  if (slot?.cleanup !== undefined) effectQueue.push(slot.cleanup)
  const holder = { deps, cleanup: undefined }
  inst.hooks[i] = holder
  effectQueue.push(() => {
    const out = fn()
    holder.cleanup = typeof out === "function" ? out : undefined
  })
}

const useSyncExternalStore = (subscribe, getSnapshot) => {
  const inst = current
  const i = hookIndex++
  if (inst.hooks.length <= i) {
    inst.hooks[i] = { subscribed: false, snapshot: undefined }
    const holder = inst.hooks[i]
    effectQueue.push(() => {
      if (holder.subscribed) return
      holder.subscribed = true
      subscribe(() => { dirty.add(inst) })
    })
  }
  // Re-read on every render: the store is the source of truth, not the slot.
  inst.hooks[i].snapshot = getSnapshot()
  return inst.hooks[i].snapshot
}

const react = { createElement, useState, useRef, useMemo, useCallback, useEffect, useSyncExternalStore, memo }

/** Mount an element as a root. */
function mount(element) {
  const inst = makeInstance(element, null)
  update(inst, element, false)
  return inst
}

/** Run queued effects and any state writes they trigger until the tree is quiet. */
async function settle() {
  for (let pass = 0; pass < 40; pass++) {
    runEffects()
    if (dirty.size > 0) { flush(); continue }
    await macrotask()
    if (dirty.size === 0 && effectQueue.length === 0) return
  }
  throw new Error("the tree did not settle — a state write keeps re-triggering an effect")
}
//#endregion

//#region stub DOM + fake clock
function makeEl(tag) {
  return {
    tagName: String(tag ?? "div").toUpperCase(),
    dataset: {},
    style: { cssText: "" },
    attributes: {},
    children: [],
    parentElement: null,
    isConnected: false,
    hidden: false,
    className: "",
    textContent: "",
    _listeners: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) { child.parentElement = this; this.children.push(child); if (this === bodyEl) child.isConnected = true; return child },
    insertBefore(child) { return this.appendChild(child) },
    remove() {
      const parent = this.parentElement
      if (parent !== null) {
        const i = parent.children.indexOf(this)
        if (i >= 0) parent.children.splice(i, 1)
      }
      this.parentElement = null
      this.isConnected = false
    },
    addEventListener(type, fn) { this._listeners[type] = fn },
    removeEventListener(type) { delete this._listeners[type] },
    closest() { return null },
    matches() { return false },
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { width: 560, height: 900, left: 0, top: 0 } },
  }
}

const bodyEl = makeEl("body")
bodyEl.isConnected = true
const headEl = makeEl("head")
headEl.isConnected = true

const realSetImmediate = globalThis.setImmediate
const macrotask = () => new Promise((resolve) => realSetImmediate(resolve))

let now = 0
let nextTimerId = 1
const timers = new Set()

globalThis.setTimeout = (fn, ms) => { const id = nextTimerId++; timers.add({ id, fn, at: now + (ms ?? 0), every: undefined }); return id }
globalThis.setInterval = (fn, ms) => { const id = nextTimerId++; timers.add({ id, fn, at: now + (ms ?? 0), every: ms ?? 0 }); return id }
globalThis.clearTimeout = (id) => { for (const t of timers) if (t.id === id) timers.delete(t) }
globalThis.clearInterval = globalThis.clearTimeout

globalThis.window = {
  __ModuleLoader__: null,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  location: { origin: "http://127.0.0.1:3080" },
}
globalThis.location = globalThis.window.location
globalThis.document = {
  body: bodyEl,
  head: headEl,
  activeElement: null,
  createElement(tag) { return makeEl(tag) },
  querySelector(sel) {
    if (sel === '[data-pane="sidebar"], [class*="sidebarCol"]') {
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
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.localStorage = { getItem() { return null }, setItem() {} }
globalThis.requestAnimationFrame = (fn) => { const id = nextTimerId++; timers.add({ id, fn, at: now, every: undefined }); return id }
globalThis.cancelAnimationFrame = globalThis.clearTimeout
// Node ships a getter-only `navigator`; the client only wants clipboard + userAgent.
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: async () => {} }, userAgent: "node" },
})
globalThis.Image = class { constructor() { this.naturalWidth = 1; this.naturalHeight = 1 } set src(_) {} }
globalThis.FileReader = class { readAsDataURL() {} }
//#endregion

//#region canned host API
const INFO = {
  os: "win32",
  platforms: ["android"],
  directory: "C:\\work\\app",
  servers: [],
  builds: [],
}

/** Identical bytes on every call — the "nothing changed" case under test. */
function cannedResponse(url) {
  const pathname = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0]
  const body = pathname === "/api/dsh-mobilecode" ? INFO
    : pathname === "/api/dsh-mobilecode/welcome" ? { show: false }
    : pathname === "/api/dsh-mobilecode/stream/devices" ? { devices: [], avds: [] }
    : pathname === "/api/dsh-mobilecode/stream/status" ? { devices: [] }
    : pathname === "/api/dsh-mobilecode/ocr/status" ? { state: "idle" }
    : pathname === "/api/dsh-mobilecode/preview/list" ? { entries: [] }
    : pathname === "/api/dsh-mobilecode/refs" ? { refs: [] }
    : {}
  const text = JSON.stringify(body)
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text }
}

let fetchCount = 0
globalThis.fetch = async (url) => { fetchCount += 1; return cannedResponse(url) }
//#endregion

//#region load the real bundle
let factory
globalThis.window.__ModuleLoader__ = {
  load({ id, factory: f }) {
    assert.equal(id, "dsh-mobilecode", "bundle id mismatch")
    factory = f
  },
}

const roots = []
const stubRequire = (name) => {
  if (name === "react") return react
  if (name === "react-dom/client") {
    return {
      createRoot: (container) => ({
        render(element) { roots.push({ container, element }) },
        unmount() {},
      }),
    }
  }
  throw new Error("unexpected require: " + name)
}

const clientSrc = fs.readFileSync(clientPath, "utf8")
new Function("require", "window", clientSrc)(stubRequire, globalThis.window)
const client = factory(stubRequire)
client.apply({
  slots: { inject: () => () => {}, register: () => {} },
  effect: () => {},
})

/** The element mountPanel handed to its root — the real MobileCodePanel. */
const panelElement = roots.map((r) => r.element).find((el) => el?.type?.name === "MobileCodePanel")
if (panelElement === undefined) throw new Error("apply() never rendered MobileCodePanel — the harness lost the entry point")
//#endregion

//#region checks
let passed = 0
const ok = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const invocations = () => RENDERS.length
const since = (mark) => RENDERS.slice(mark)
const countOf = (names, wanted) => names.filter((n) => n === wanted).length

/** Every element in a mounted subtree — the handle for firing a real handler. */
function collectElements(inst, out = []) {
  if (inst.element?.props !== undefined) out.push(inst.element)
  for (const child of inst.children) collectElements(child, out)
  return out
}

/**
 * One keystroke in the panel's own directory field: a state write that the live
 * subtree does not depend on. This is the case a memo boundary is FOR — the 2 s
 * tick is fixed by not writing at all when nothing changed, but a keystroke is a
 * write that has to happen.
 */
async function keystroke(value) {
  const input = collectElements(panel).find((el) => el.type === "input" && el.props.value !== undefined && typeof el.props.onChange === "function")
  if (input === undefined) throw new Error("no controlled input in the panel — the keystroke probe lost its handle")
  const mark = invocations()
  input.props.onChange({ target: { value } })
  flush()
  await settle()
  return since(mark)
}

/** One 2 s poll window on a panel that is open, with an unchanged payload. */
async function pollWindow() {
  const mark = invocations()
  await advance(2000)
  return since(mark)
}

async function advance(ms) {
  const target = now + ms
  for (;;) {
    let due
    for (const t of timers) if (t.at <= target && (due === undefined || t.at < due.at)) due = t
    if (due === undefined) break
    now = due.at
    if (due.every === undefined) timers.delete(due)
    else due.at += due.every
    due.fn()
    await settle()
  }
  now = target
  await settle()
}

// ── the harness must be provably faithful before its numbers mean anything ──
console.log("— miniature React fidelity —")

await ok("rule 1: an unmemoized child re-renders with its parent", async () => {
  let childRuns = 0
  const Child = () => { childRuns += 1; return null }
  const Parent = () => { const [n, setN] = useState(0); Parent.bump = () => setN(n + 1); return createElement(Child, {}) }
  mount(createElement(Parent, {}))
  assert.equal(childRuns, 1, "first render should call the child once")
  Parent.bump()
  flush()
  assert.equal(childRuns, 2, "a plain child must re-render with its parent")
})

await ok("rule 2: a memo child with equal props is never entered", async () => {
  let childRuns = 0
  const Child = memo(() => { childRuns += 1; return null })
  const Parent = () => { const [n, setN] = useState(0); Parent.bump = () => setN(n + 1); return createElement(Child, { label: "fixed" }) }
  mount(createElement(Parent, {}))
  Parent.bump()
  flush()
  assert.equal(childRuns, 1, "memo must skip a child whose props are shallow-equal")
})

await ok("rule 2b: a memo child with changed props IS entered", async () => {
  let childRuns = 0
  const Child = memo(() => { childRuns += 1; return null })
  const Parent = () => { const [n, setN] = useState(0); Parent.bump = () => setN(n + 1); return createElement(Child, { label: String(n) }) }
  mount(createElement(Parent, {}))
  Parent.bump()
  flush()
  assert.equal(childRuns, 2, "memo must re-render when a prop changes")
})

await ok("rule 3: setState with an identical value bails out entirely", async () => {
  let runs = 0
  const Comp = () => { const [n, setN] = useState(0); runs += 1; Comp.rewrite = () => setN(0); return null }
  mount(createElement(Comp, {}))
  const before = runs
  Comp.rewrite()
  assert.equal(flush(), 0, "an Object.is-equal write must not schedule a render")
  assert.equal(runs, before, "the component body must not re-run")
})

await ok("rule 4: two writes in one task collapse into one render pass", async () => {
  let runs = 0
  const Comp = () => { const [a, setA] = useState(0); const [b, setB] = useState(0); runs += 1; Comp.write = () => { setA(a + 1); setB(b + 1) }; return null }
  mount(createElement(Comp, {}))
  const before = runs
  Comp.write()
  assert.equal(flush(), 1, "React 18 batches both writes into a single pass")
  assert.equal(runs, before + 1, "the body runs once, not twice")
})

await ok("rule 5: useRef and useMemo keep identity across renders", async () => {
  const seen = []
  const Comp = () => {
    const [n, setN] = useState(0)
    const ref = useRef({ tag: "stable" })
    const memoValue = useMemo(() => ({ tag: "memo" }), [])
    seen.push([ref, memoValue])
    Comp.bump = () => setN(n + 1)
    return null
  }
  mount(createElement(Comp, {}))
  Comp.bump()
  flush()
  assert.equal(seen.length, 2, "expected two renders")
  assert.equal(seen[0][0], seen[1][0], "useRef must return the same object")
  assert.equal(seen[0][1], seen[1][1], "useMemo with [] deps must not recompute")
})

// ── the measurement ──
console.log("— real panel —")

const panel = mount(panelElement)
const controller = panelElement.props.controller
await settle()

const mountCost = invocations()
const tally = (names) => {
  const out = {}
  for (const name of names) out[name] = (out[name] ?? 0) + 1
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(" · ")
}
console.log(`  mount: ${mountCost} component invocations`)
console.log(`    ${tally(RENDERS)}`)

controller.setOpen(true)
await settle()
console.log(`  open:  ${invocations() - mountCost} component invocations to open the drawer`)

const idle = await pollWindow()
console.log(`  2 s tick, payload unchanged: ${idle.length} component invocations`)
if (idle.length > 0) {
  const tally = {}
  for (const name of idle) tally[name] = (tally[name] ?? 0) + 1
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8)
  console.log(`    ${top.map(([n, c]) => `${n}×${c}`).join(" · ")}`)
}

const second = await pollWindow()
console.log(`  next 2 s tick: ${second.length} component invocations`)

const typed = await keystroke("C:\\work\\app2")
console.log(`  one keystroke in the directory field: ${typed.length} component invocations`)
console.log(`    ${tally(typed)}`)

await ok("the panel mounts and its live subtree is present", async () => {
  assert.ok(mountCost > 20, `expected a substantial subtree, got ${mountCost} invocations`)
  for (const name of ["MobileCodePanel", "LiveStreamSection", "LiveDeviceCard", "RefCompareSection", "PreviewGallerySection"]) {
    assert.ok(instancesByName.has(name), `${name} never rendered — the harness is not mounting the real tree`)
  }
})

await ok("an unchanged 2 s poll costs no component invocations", async () => {
  assert.equal(idle.length, 0, `a poll tick with identical bytes re-rendered ${idle.length} components: ${[...new Set(idle)].join(", ")}`)
  assert.equal(second.length, 0, `the next tick re-rendered ${second.length} components`)
})

await ok("a panel-level state write stops at the live subtree's memo boundary", async () => {
  assert.equal(typed.length, 1, `a keystroke re-rendered ${typed.length} components: ${[...new Set(typed)].join(", ")}`)
  assert.equal(typed[0], "MobileCodePanel", "only the component that owns the state should re-run")
  for (const name of ["LiveStreamSection", "LiveDeviceCard", "DeviceMenu", "StageControls", "RefCompareSection", "PreviewGallerySection"]) {
    assert.ok(!typed.includes(name), `${name} re-rendered on a write it does not depend on`)
  }
})

await ok("opening the drawer still reaches the live subtree", async () => {
  // The boundary must not be a wall: `active` is a prop, so the panes that own
  // the streams have to re-render when the drawer opens.
  const before = invocations()
  controller.setOpen(false)
  await settle()
  controller.setOpen(true)
  await settle()
  const opened = since(before)
  for (const name of ["MobileCodePanel", "LiveStreamSection", "LiveDeviceCard"]) {
    assert.ok(opened.includes(name), `${name} did not re-render when the drawer opened`)
  }
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
if (process.exitCode) process.exit(1)
