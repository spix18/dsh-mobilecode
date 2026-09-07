/**
 * dsh-mobilecode — offline uitree + skill tests. Pure functions, no device
 * and no DSH wiring: XML parsing, hierarchy shaping, selector resolution
 * (chains, gates, ambiguity), tree capping, and the bundled skill shape.
 *
 * Run: node test/uitree.mjs
 */

import assert from "node:assert/strict"
import * as UiTree from "../lib/uitree.js"
import { SKILL_NAME, SKILL_DESCRIPTION, SKILL_CONTENT, registerMobileSkill } from "../lib/skill.js"

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
const okAsync = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

console.log("dsh-mobilecode uitree offline tests\n")

console.log("— XML parsing —")
ok("decodeXmlEntities handles named, numeric and unknown refs", () => {
  assert.equal(UiTree.decodeXmlEntities("a&amp;b&lt;c&gt;"), "a&b<c>")
  assert.equal(UiTree.decodeXmlEntities("&#65;&#x42;"), "AB")
  assert.equal(UiTree.decodeXmlEntities("5 & 6 &unknown;"), "5 & 6 &unknown;")
  assert.equal(UiTree.decodeXmlEntities("plain"), "plain")
})
ok("scanStartTag is quote-aware: > inside an attribute value never ends the tag", () => {
  const source = `<node content-desc="a > b" text="x"/>`
  const elements = UiTree.parseXmlElements(source)
  assert.equal(elements.length, 1)
  assert.equal(elements[0].attributes["content-desc"], "a > b")
  assert.equal(elements[0].attributes.text, "x")
  assert.equal(elements[0].children.length, 0)
})
ok("parseBounds reads [l,t][r,b] into origin+size", () => {
  assert.deepEqual(UiTree.parseBounds("[100,150][500,250]"), { x: 100, y: 150, w: 400, h: 100 })
  assert.equal(UiTree.parseBounds("garbage"), undefined)
  assert.equal(UiTree.parseBounds(undefined), undefined)
})
ok("classTail takes the trailing segment; empty class is Node", () => {
  assert.equal(UiTree.classTail("android.widget.FrameLayout"), "FrameLayout")
  assert.equal(UiTree.classTail(""), "Node")
  assert.equal(UiTree.classTail(undefined), "Node")
})

console.log("— hierarchy shaping —")
const FIXTURE = [
  '<hierarchy rotation="0">',
  '  <node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">',
  '    <node class="android.widget.Button" text="Settings" resource-id="com.demo:id/btn_settings" clickable="true" bounds="[100,150][500,250]"/>',
  '    <node class="android.widget.TextView" text="Settings" bounds="[100,300][500,380]"/>',
  '    <node class="android.widget.Button" text="Disabled" enabled="false" clickable="true" bounds="[100,500][500,600]"/>',
  '    <node class="android.widget.Button" text="Hidden" bounds="[1200,500][1600,600]"/>',
  '    <node class="android.widget.EditText" text="Ctrl &amp; me" content-desc="search &gt; here" bounds="[0,700][1080,800]"/>',
  '  </node>',
  '</hierarchy>',
].join("\n")
const parsed = UiTree.parseUiTree(FIXTURE)
ok("parseUiTree unwraps <hierarchy> and reports rotation", () => {
  assert.equal(parsed.roots.length, 1)
  assert.equal(parsed.rotation, 0)
  assert.equal(parsed.roots[0].type, "FrameLayout")
})
ok("interesting-state booleans: enabled=false present, clickable=true present, absence means normal", () => {
  const flat = UiTree.flattenNodes(parsed.roots)
  const disabled = flat.find((n) => n.text === "Disabled")
  const enabled = flat.find((n) => n.text === "Settings" && n.resourceId)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.clickable, true)
  assert.equal(enabled.enabled, undefined)
  assert.equal(enabled.clickable, true)
  assert.equal(enabled.focused, undefined)
})
ok("entities in labels survive the round trip", () => {
  const flat = UiTree.flattenNodes(parsed.roots)
  const edit = flat.find((n) => n.type === "EditText")
  assert.equal(edit.text, "Ctrl & me")
  assert.equal(edit.contentDesc, "search > here")
})
ok("buildCompactTree filter keeps ancestors of matches", () => {
  const { tree } = UiTree.buildCompactTree(parsed.roots, undefined, "btn_settings")
  // The FrameLayout root survives because a descendant matches.
  assert.equal(tree.length, 1)
  assert.equal(tree[0].children.length, 1)
  assert.equal(tree[0].children[0].resourceId, "com.demo:id/btn_settings")
})
ok("buildCompactTree max_depth caps nesting", () => {
  const { tree } = UiTree.buildCompactTree(parsed.roots, 1)
  // max_depth=1 keeps the root and its direct children, no deeper.
  assert.equal(tree[0].children.length, 5)
  assert.equal(tree[0].children[0].children.length, 0)
})
ok("capTreeToBytes prunes deepest levels and sets truncated", () => {
  const { tree } = UiTree.buildCompactTree(parsed.roots)
  const before = JSON.stringify(tree).length
  const capped = UiTree.capTreeToBytes(tree, Math.max(64, Math.floor(before / 3)))
  assert.equal(capped.truncated, true)
  assert.ok(JSON.stringify(capped.tree).length < before)
})
ok("capTreeToBytes leaves small trees alone", () => {
  const { tree } = UiTree.buildCompactTree(parsed.roots)
  const capped = UiTree.capTreeToBytes(tree, 1024 * 1024)
  assert.equal(capped.truncated, false)
})

console.log("— extractHierarchyXml —")
ok("strips CRLF and the upstream confirmation line", () => {
  const raw = 'UI hierchary dumped to: /dev/tty\r\n<hierarchy rotation="0">\r\n  <node bounds="[0,0][1,1]"/>\r\n</hierarchy>\r\n'
  const xml = UiTree.extractHierarchyXml(raw)
  assert.ok(xml.startsWith("<hierarchy"))
  assert.ok(xml.endsWith("</hierarchy>"))
  assert.ok(!xml.includes("dumped to"))
})
ok("self-closed empty hierarchy is valid", () => {
  assert.equal(UiTree.extractHierarchyXml('<hierarchy rotation="0"/>'), '<hierarchy rotation="0"/>')
})
ok("non-XML garbage throws with a snippet", () => {
  assert.throws(() => UiTree.extractHierarchyXml("ERROR: could not get idle state."), /hierarchy/)
})

console.log("— selector resolution —")
ok("ambiguous matches list candidates instead of guessing", () => {
  assert.throws(() => UiTree.resolveTapTarget(parsed.roots, { label: "Settings" }), (error) => {
    const message = error.message
    return /2 nodes match/.test(message) && /resource-id/.test(message) && /more specific/.test(message)
  })
})
ok("resource_id exact match taps the button", () => {
  const { node, matchedBy } = UiTree.resolveTapTarget(parsed.roots, { identifier: "com.demo:id/btn_settings" })
  assert.equal(matchedBy, "exact")
  assert.equal(node.type, "Button")
  assert.deepEqual(UiTree.boundsCenter(node.bounds), { x: 300, y: 200 })
})
ok("nested duplicates collapse to the outermost control", () => {
  const nested = UiTree.parseUiTree([
    '<hierarchy>',
    '  <node class="android.view.ViewGroup" content-desc="Item one" clickable="true" bounds="[100,150][500,250]">',
    '    <node class="android.widget.TextView" text="Item one" bounds="[110,160][490,240]"/>',
    '  </node>',
    '</hierarchy>',
  ].join("\n"))
  const { node } = UiTree.resolveTapTarget(nested.roots, { label: "Item one" })
  assert.equal(node.type, "ViewGroup")
  assert.equal(node.clickable, true)
})
ok("disabled nodes are refused with actionable copy", () => {
  assert.throws(() => UiTree.resolveTapTarget(parsed.roots, { label: "Disabled" }), /disabled/)
})
ok("off-screen nodes are refused; allow_offscreen bypasses only that gate", () => {
  assert.throws(() => UiTree.resolveTapTarget(parsed.roots, { label: "Hidden" }), /off-screen/)
  const { node } = UiTree.resolveTapTarget(parsed.roots, { label: "Hidden" }, { allowOffscreen: true })
  assert.equal(node.text, "Hidden")
})
ok("no selector at all throws", () => {
  assert.throws(() => UiTree.resolveTapTarget(parsed.roots, {}), /requires an element selector/)
})
ok("no match suggests device_ui_tree / OCR", () => {
  assert.throws(() => UiTree.resolveTapTarget(parsed.roots, { label: "Nonexistent" }), (error) => {
    return /device_ui_tree/.test(error.message) && /device_screen/.test(error.message)
  })
})
ok("boundsCenter rounds to integer pixels", () => {
  assert.deepEqual(UiTree.boundsCenter({ x: 100, y: 150, w: 400, h: 100 }), { x: 300, y: 200 })
  assert.deepEqual(UiTree.boundsCenter({ x: 0, y: 0, w: 3, h: 3 }), { x: 2, y: 2 })
})
ok("collectLabels gathers text and content-desc", () => {
  const labels = UiTree.collectLabels(parsed.roots)
  assert.ok(labels.includes("Settings"))
  assert.ok(labels.includes("search > here"))
})

console.log("— bundled skill —")
ok("skill name is kebab-case and content is substantial", () => {
  assert.match(SKILL_NAME, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.ok(SKILL_DESCRIPTION.length > 40)
  assert.ok(SKILL_CONTENT.length > 1000)
  assert.ok(SKILL_CONTENT.includes("device_ui_tree"))
  assert.ok(SKILL_CONTENT.includes("device_tap_element"))
  assert.ok(SKILL_CONTENT.includes("expect_text"))
})
ok("registerMobileSkill registers via scoped inject when present", async () => {
  const registered = []
  const effect = (factory) => { factory() }
  const inject = (services, callback) => {
    assert.deepEqual(services, ["skills"])
    callback({ skills: { register: (skill) => registered.push(skill) }, effect })
    return { dispose() { registered.length = 0 } }
  }
  const dispose = registerMobileSkill({ inject })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, SKILL_NAME)
  assert.equal(registered[0].source, "bundled")
  dispose()
  assert.equal(registered.length, 0)
})
ok("registerMobileSkill degrades without the skill service", () => {
  assert.equal(registerMobileSkill({}), undefined)
  assert.equal(registerMobileSkill({ inject: "not-a-function", skills: undefined }), undefined)
})
ok("registerMobileSkill falls back to direct ctx.skills.register", () => {
  const seen = []
  const disposer = registerMobileSkill({ skills: { register: (skill) => { seen.push(skill); return () => {} } } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, SKILL_NAME)
  assert.equal(typeof disposer, "function")
})

await okAsync("dumpUiTreeXml error copy is honest when adb fails", async () => {
  // A serial that cannot exist: adb returns nothing → the dump throws with guidance.
  await assert.rejects(() => UiTree.dumpUiTreeXml("emulator-99999-nonexistent"), /uiautomator could not dump/)
})

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
if (process.exitCode) process.exit(1)
