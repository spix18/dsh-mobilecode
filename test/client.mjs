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
    // `memo` is part of the real react surface and the bundle imports it, so the
    // stub has to carry it or the factory throws at load. Identity is enough
    // here: this file swallows rendering, so only the call has to not crash.
    // test/render.mjs is where memo's actual skip behavior is exercised.
    return { createElement: () => ({}), memo: (component) => component, useCallback: (fn) => fn, useEffect() {}, useMemo: (fn) => fn(), useRef() {}, useState() { return [null, () => {}] }, useSyncExternalStore() {} }
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
  // The panel must render through LiveStreamSection — the wrapper that owns the
  // co-op toggle and the shared Size/Frame knobs — never the bare card. Assert
  // the wiring, not the exact argument list: pinning `null` here broke on a prop
  // addition (`active`, which gates the device poll on pane visibility) that
  // changed nothing about the wiring.
  assert.match(clientSrc, /h\(LiveStreamSection,/, "panel still mounts the bare card")
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
ok("0.11.5 responsive fit stages + shared controls", () => {
  assert.match(clientSrc, /\.mc-live-section\.coop \{[^}]*auto-fit/, "coop grid must wrap on narrow panes")
  assert.match(clientSrc, /aspect-ratio: var\(--mc-ar-n/, "stage must hug device aspect ratio (no letterbox)")
  assert.match(clientSrc, /device offline/, "presence watcher missing")
  assert.equal(clientSrc.split("const autoPicked = useRef(false);").length, 3, "both panes need a one-shot auto-pick guard")
  assert.match(clientSrc, /setSerial\(""\); live\.reset\(\);/, "CoopPane does not drop its stream when its device dies")
  assert.equal(clientSrc.split('h(DeviceMenu, { serial, onError: setError })').length, 3, "DeviceMenu on both panes")
  assert.match(clientSrc, /h\(ToolbarRow, \{ items: toolbar \}\)/, "Device 1 uses shared ToolbarRow")
  assert.match(clientSrc, /h\(ToolbarRow, \{ items: navToolbar\(live\.control/, "CoopPane has nav toolbar")
  const chip = clientSrc.match(/const MC_VERSION = "([\d.]+)"/)
  assert.ok(chip, "version chip missing")
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(chip[1], pkg.version, "MC_VERSION chip drifts from package.json")
})
ok("0.11.6 co-op head never wraps (stage tops would misalign ~38px)", () => {
  assert.match(clientSrc, /\.mc-live-section\.coop \.mc-card-head \{ flex-wrap: nowrap/, "coop head lost nowrap — pane stages will sit at different tops again")
  assert.match(clientSrc, /\.mc-card-head \.mc-picker \{[^}]*min-width: 0/, "picker cannot shrink inside the nowrap head")
})
ok("0.11.7 picker button tracks its shrinking container (no ☰ overlap)", () => {
  assert.match(clientSrc, /\.mc-card-head \.mc-picker > \.mc-btn \{ width: 100%; min-width: 0; \}/, "picker button can still overflow under the ☰/⧉ buttons when the head shrinks")
})
ok("live stage is keyboard-operable (WCAG 2.1.1)", () => {
  // The stage carries tabIndex 0 and paints a focus ring, so it has to DO
  // something when focused. It was pointer-only: a keyboard user could reach
  // it and nothing happened — a focus ring promising an interaction the
  // control could not deliver. Assert the keyboard path exists AND reaches the
  // same control() calls the pointer gestures use, so the two cannot drift.
  assert.match(clientSrc, /const KEY_STEP = 0\.25;/, "keyboard swipe step missing")
  assert.match(clientSrc, /const onKeyDown = (?:useCallback\()?\(e\) => \{/, "no keydown handler on the stage")
  assert.match(clientSrc, /e\.key === "ArrowRight" \? KEY_STEP/, "arrows are not wired to the swipe step")
  assert.match(clientSrc, /kind: "drag", fromX: 0\.5, fromY: 0\.5, toX: 0\.5 \+ dx, toY: 0\.5 \+ dy/, "an arrow key does not dispatch a drag")
  assert.match(clientSrc, /kind: "tap", x: 0\.5, y: 0\.5/, "Enter/Space does not dispatch a tap")
  assert.match(
    clientSrc,
    /onKeyDown,\s*\n\s*"aria-label": "Live screen of " \+ \(serial \|\| "the device"\)/,
    "imgProps exposes neither the keyboard handler nor an accessible name for it",
  )
  // One wiring, both panes: Device 1 and the co-op pane spread the same
  // imgProps, so neither can regress to pointer-only on its own.
  assert.equal(clientSrc.split("...live.imgProps").length, 3, "both stages must share the hook's imgProps")
})
ok("hot paths skip work they do not need to redo", () => {
  // React re-renders only the component whose state changed, so the 5 s poll
  // never reached the panel subtree — the earlier claim that it did was wrong.
  // The real cost was narrower: the stage got a fresh props object every
  // render, and every tick wrote a fresh array that rendered identically.
  assert.match(clientSrc, /imgProps: useMemo\(\(\) => \(\{/, "imgProps is a fresh object every render — React re-attaches the <img> listeners")
  assert.match(clientSrc, /\}\), \[onDown, onUp, onKeyDown, serial\]\)/, "the imgProps memo must depend on serial, or its accessible name goes stale")
  assert.match(clientSrc, /const control = useCallback\(async \(action\) => \{/, "control changes identity every render")
  assert.match(clientSrc, /const norm = useCallback\(\(clientX, clientY\) => \{/, "norm changes identity every render")
  // Three repeat-poll sites now carry the guard, so the count is 4 (n+1 for
  // split). It is counted rather than grepped site-by-site on purpose: deleting
  // a guard anywhere has to fail here. Update this number deliberately when a
  // fourth poll appears — do not widen it to >=, which would let one be dropped.
  assert.equal(clientSrc.split("if (payload !== lastPayload.current)").length, 4, "a repeat poll still writes state when its payload is byte-identical (expected 3: panel /info, Device 1, co-op pane)")
  assert.match(clientSrc, /setStatus\(\(prev\) => \(prev\?\.serial === r\.serial \? prev : r\)\)/, "the capsule still re-renders on every tick")
})
ok("the drawer's narrow-pane rules key on the pane, not the viewport", () => {
  // The drawer is dragged between 320px and innerWidth-40, so a 1600px window
  // can hold a 340px pane. Every narrow rule used to be @media, so that pane
  // got the desktop layout while a 560px pane in a 700px window got the narrow
  // one: the breakpoint was measuring the wrong box.
  assert.match(clientSrc, /\.mc-panel-col \{ container-type: inline-size;/, "no query container for the drawer")
  assert.match(clientSrc, /h\("div", \{ className: "mc-panel-col" \},/, "the panel column is not wrapped in the container")
  // The modal must stay OUTSIDE the container. container-type implies layout
  // containment, which would make .mc-panel-col the containing block for the
  // fixed-position .mc-overlay and trap the dialog inside the drawer.
  assert.match(
    clientSrc,
    /\n\t\t\t\t\),\n\t\t\tsettingsOpen && h\(SettingsDialog,/,
    "the settings dialog must be a sibling of the container, not a descendant",
  )
  assert.match(clientSrc, /@container \(max-width: 640px\) \{/, "no pane-width tier at 640px")
  assert.match(clientSrc, /@container \(max-width: 380px\) \{/, "no pane-width tier at 380px")
  // Checked in both directions: a pane-scoped rule left in a viewport media
  // query and a viewport-scoped rule moved into a container query are the same
  // mistake pointing opposite ways.
  const widthMedia = [...clientSrc.matchAll(/@media \(max-width: \d+px\) \{[\s\S]*?\n\}/g)].map((m) => m[0])
  assert.ok(widthMedia.length >= 2, `expected the width media queries, found ${widthMedia.length}`)
  for (const block of widthMedia) {
    for (const sel of [".mc-panel-col", ".mc-live-off", ".mc-toolbar button", ".mc-body"]) {
      assert.ok(!block.includes(sel), `${sel} is pane-scoped but sits in a viewport media query`)
    }
  }
  const containers = [...clientSrc.matchAll(/@container \(max-width: \d+px\) \{[\s\S]*?\n\}/g)].map((m) => m[0])
  assert.equal(containers.length, 2, `expected 2 pane-width tiers, found ${containers.length}`)
  for (const block of containers) {
    for (const sel of [".mc-modal", ".mc-overlay", ".mc-tabs"]) {
      assert.ok(!block.includes(sel), `${sel} is viewport-scoped but sits in a container query`)
    }
  }
})

ok("the palette is this project's own, and the scrollable logs are reachable", () => {
  // /colorize fixed the CONTRAST of the accent quartet; it did not fix where the
  // values came from. #0b57d0/#8ab4f8/#0842a0/#a8c7fa/#b3261e/#ff8a80/#ffb74d
  // were Material 3 primary40/primary80/primary30/primary90/error40/red-A100/
  // orange-300 lookups, and the Google quartet they replaced before that was
  // #4285f4/#4caf50/#ef5350/#ff9800. None of them may come back: the hues are
  // now chosen for this palette and each role's lightness is solved against the
  // pair table in test/tokens.mjs.
  for (const borrowed of [
    "#0b57d0", "#8ab4f8", "#0842a0", "#a8c7fa", "#b3261e", "#ff8a80", "#ffb74d",
    "#0b6b2d", "#5dd47a", "#b26a00", "#4285f4", "#4caf50", "#ef5350", "#ff9800",
  ]) {
    assert.ok(!clientSrc.includes(borrowed), `${borrowed} is a borrowed tonal-ramp value`)
  }
  // A log box is max-height:180px with overflow:auto, and Safari does not make
  // an overflow box focusable on its own — a keyboard-only user cannot scroll
  // what they cannot focus (WCAG 2.1.1). All three log surfaces must carry both
  // the tab stop and a name, since their content is unlabelled text.
  const logs = [...clientSrc.matchAll(/h\("pre", \{[^}]*className: "mc-log(?:line)?[^}]*\}/g)].map((m) => m[0])
  assert.equal(logs.length, 3, `expected 3 log surfaces, found ${logs.length}`)
  for (const tag of logs) {
    assert.match(tag, /tabIndex: 0/, `a log box is not focusable: ${tag}`)
    assert.match(tag, /"aria-label": "[^"]/, `a log box has no accessible name: ${tag}`)
  }
  // role="log" was weighed and REJECTED, not overlooked: the lines are re-joined
  // and re-rendered whole on every 2s poll, so a polite live region would
  // re-announce the entire log each tick. The rejection is recorded in a comment.
  assert.ok(!/role: "log"/.test(clientSrc), "role=log would re-announce the whole log every poll")
  assert.match(clientSrc, /Deliberately NOT role="log"/, "the role=log rejection is undocumented")
  assert.match(
    clientSrc,
    /\.mc-log:focus-visible, \.mc-logline:focus-visible \{ outline: 2px solid var\(--mc-focus\)/,
    "the logs are focusable but the global ring only covers button/select",
  )
})

ok("the controls that start async work answer a press", () => {
  // /polish's state matrix wants Default/Hover/Focus/Active/Disabled. Hover,
  // focus and disabled were covered; :active was missing on every control. It
  // matters most exactly here, because Connect / Pair / boot stay hovered for a
  // whole round trip and the click otherwise looks unregistered.
  const press = clientSrc.match(/\.mc-btn:active:not\(:disabled\), \.mc-toolbar button:active:not\(:disabled\) \{([^}]*)\}/)
  assert.ok(press, "the async controls have no press state")
  // A transform, not a colour: one rule has to read correctly on a primary
  // button, a quiet one and a transparent icon button.
  assert.match(press[1], /transform: translateY\(1px\)/, "the press state must be a transform")
  assert.ok(!/background/.test(press[1]), "a colour press state would fight the primary/accent tokens")
  // Selection controls are deliberately excluded: [data-on] already lands on the
  // same frame, so a press state would be a second answer to the same question.
  assert.ok(!/\.mc-tab:active|\.mc-seg button:active/.test(clientSrc), "a selection control got a press state")
})

ok("every image carries alt text", () => {
  // WCAG 1.1.1 Level A, and the one place a sweep misses it: the capture that
  // is overlaid on the reference sits inside a multi-line h("img", { … }) with a
  // comment where the alt would go, so a per-line grep for alt: under-counts and
  // a per-line grep for the tag looks satisfied. Window each tag instead.
  const imgs = [...clientSrc.matchAll(/h\("img"/g)]
  assert.ok(imgs.length >= 5, `expected the image sites, found ${imgs.length}`)
  for (const [i, m] of imgs.entries()) {
    // The window stops at the NEXT image. Without that bound a short tag's window
    // runs into its neighbour's alt and the guard stays green on a real miss —
    // which is exactly what the still-capture mutation did.
    const end = Math.min(m.index + 300, imgs[i + 1]?.index ?? Infinity)
    const window = clientSrc.slice(m.index, end)
    // A literal or an expression: the preview gallery names its image from the
    // entry it came from, so requiring a quote here would be a false positive.
    assert.match(window, /\balt: (?:"|[A-Za-z_$])/, `an image has no alt text: ${window.slice(0, 90)}`)
  }
})

ok("the drawer is a named landmark, and the micro role clears the touch floor", () => {
  // A landmark needs a NAME to be one — `complementary` with no accessible name
  // is announced as bare "complementary" and is no easier to jump to than the
  // plain div was. The name must be the drawer's own heading, so the heading and
  // the label are both READ and compared, rather than each asserted against its
  // own copy of the same string (which would pass even if they disagreed).
  const heading = clientSrc.match(/h\("h2", \{ className: "mc-title" \}, "([^"]+)"\)/)
  assert.ok(heading, "the drawer has no h2 title to name the landmark after")
  assert.match(clientSrc, /container\.setAttribute\("role", "complementary"\)/, "the drawer is not a landmark")
  const label = clientSrc.match(/container\.setAttribute\("aria-label", "([^"]+)"\)/)
  assert.ok(label, "the drawer landmark has no accessible name")
  assert.equal(label[1], heading[1], "the landmark name and the heading it labels disagree")
  // The touch floor: the micro role is promoted inside the ONE coarse block. The
  // slice asserts the promotion is IN that block, not merely somewhere in the
  // file — and a literal value would reopen the scale the token layer closed.
  const coarse = clientSrc.slice(clientSrc.indexOf("@media (pointer: coarse) {"))
  const block = coarse.slice(0, coarse.indexOf("\n}"))
  assert.match(block, /--mc-fs-caption: var\(--mc-fs-label\)/, "the micro role is not promoted on a coarse pointer")
  assert.ok(!/--mc-fs-caption:\s*[.\d]/.test(block), "the touch promotion must reference the label role, not a fresh literal")
})

ok("the picker row's action is a real button, and its off control is a sibling", () => {
  // role="button" makes its children presentational, so the ⏻ off button
  // nested inside the row was flattened out of the accessibility tree and its
  // action was unreachable (axe nested-interactive, WCAG 4.1.2). The row is
  // inert now and the ACTION is a real button; ⏻ off is its SIBLING.
  assert.ok(!/\.\.\.activatable\(\(\) => pick\(/.test(clientSrc), "the picker row is still a role=button container")
  assert.match(clientSrc, /className: "mc-pick", type: "button",/, "the picker row has no real button to act on")
  const pick = clientSrc.indexOf('className: "mc-pick", type: "button",')
  assert.ok(pick > 0, "the picker row has no real button to act on")
  // Slice the pick button's OWN element by balanced parens and assert the off
  // button is not inside it. Matching "), before the off button" is NOT enough:
  // the mc-badge line just above it also ends in ), and satisfies that pattern
  // while the off button is genuinely nested (found by negative testing).
  const open = clientSrc.lastIndexOf('h("button", {', pick)
  let depth = 0
  let end = -1
  for (let i = clientSrc.indexOf("(", open); i < clientSrc.length; i += 1) {
    if (clientSrc[i] === "(") depth += 1
    else if (clientSrc[i] === ")" && --depth === 0) { end = i; break }
  }
  assert.ok(end > open, "the pick button element is unbalanced")
  assert.ok(!clientSrc.slice(open, end + 1).includes("⏻ off"),
    "the ⏻ off button is nested inside the pick button, not a sibling")
  // an inert row must not promise a click, and a focus rule may not survive for
  // a row that can no longer take focus
  assert.ok(!/\.mc-picker-row \{[^}]*cursor: pointer/.test(clientSrc), "the inert picker row still shows a pointer cursor")
  assert.ok(!/\.mc-picker-row:focus-visible/.test(clientSrc), "a focus rule survives for a row that is no longer focusable")
  // `.mc-picker .mc-btn` also matched every ⏻ off button inside the popover, at
  // a specificity that beat `.mc-picker-row .mc-btn`
  assert.ok(!/\.mc-card-head \.mc-picker \.mc-btn \{/.test(clientSrc), "the picker trigger rule still reaches the popover's row buttons")
  assert.match(clientSrc, /\.mc-card-head \.mc-picker > \.mc-btn \{ width: 100%; min-width: 0; \}/, "the picker trigger no longer tracks its shrinking container")
  // a long AVD name plus its serial is ~250px of 14px mono in a 240-320px popover
  assert.match(clientSrc, /\.mc-picker-row \.mc-serial \{[^}]*text-overflow: ellipsis/, "a long device name still widens the picker popover")
  // The action moved off the row onto .mc-pick, so the pick button has to
  // carry the row's height itself: stretching is what keeps the target the
  // whole row rather than just the text sitting in it.
  assert.match(clientSrc, /\.mc-pick \{[^}]*align-self: stretch/, "the pick button no longer fills its row, so its touch target shrank to the text")
  // The 32px controls keep their painted box but gain a 44px hit area on
  // touch. inset -6px 0 lands exactly on the row's bounds: the row's padding
  // is 6px and the rows sit only 2px apart, so an overshoot would overlap.
  const coarse = clientSrc.slice(clientSrc.indexOf("@media (pointer: coarse) {"))
  const block = coarse.slice(0, coarse.indexOf("\n}"))
  assert.match(block, /\.mc-picker-row \.mc-btn, \.mc-pick \{ position: relative; \}/, "a 32px picker control cannot carry a pseudo-element hit area")
  assert.match(block, /\.mc-picker-row \.mc-btn::after, \.mc-pick::after \{[^}]*inset: -6px 0/, "the 32px picker controls have no 44px hit area on touch")
  // .mc-log-toggle never renders inside a picker row, so that half of the
  // rule matched nothing at all.
  assert.ok(!/\.mc-picker-row \.mc-log-toggle/.test(clientSrc), "the dead picker-row log-toggle selector is back")
})

ok("the two deliberate :focus rules stay deliberate, and say why", () => {
  // Everything else in this file uses :focus-visible, so a sweep that
  // "normalizes" these two breaks real behaviour: a text field shows a caret
  // the moment it is clicked, so its ring has to appear then too, and the
  // dialog takes focus for the Tab trap without being activatable, so a ring
  // around the whole panel would be noise. Pinning them keeps the decision.
  const reason = (selector) => {
    const at = clientSrc.indexOf(selector)
    assert.ok(at > 0, `${selector} is gone`)
    return clientSrc.slice(Math.max(0, at - 700), at)
  }
  assert.match(clientSrc, /\.mc-input:focus \{ outline: 2px solid var\(--mc-focus\); outline-offset: 1px; border-color: var\(--mc-focus\); \}/,
    "the text field lost its click-time focus ring")
  assert.match(reason(".mc-input:focus"), /:focus, not :focus-visible, and deliberately/,
    "the text field's :focus no longer says why it is not :focus-visible")
  assert.match(clientSrc, /\.mc-modal:focus \{ outline: none; \}/, "the dialog lost the focus it needs for the Tab trap")
  assert.match(reason(".mc-modal:focus"), /Tab trap/, "the dialog's :focus no longer says why it has no ring")
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
