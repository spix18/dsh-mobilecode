/**
 * The scene layer joins two sources that were never meant to meet: a uiautomator
 * tree, which knows where things are but not what they look like, and a pixel
 * buffer, which knows the reverse. The fixture below draws a screen AND describes
 * it, so every assertion compares the extractor against ground truth rather than
 * against whatever the extractor happened to produce.
 *
 * Run: node test/scene.mjs
 */

import assert from "node:assert/strict"
import * as Px from "../lib/pixels.js"
import { analyzeScene, renderScene } from "../lib/scene.js"

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

// --- a canvas to draw on (the pixel layer's fixture, minimal copy) -----------

const setPx = (px, x, y, color) => {
  if (x < 0 || y < 0 || x >= px.width || y >= px.height) return
  const at = (y * px.width + x) * 4
  px.rgba[at] = color.r
  px.rgba[at + 1] = color.g
  px.rgba[at + 2] = color.b
  px.rgba[at + 3] = color.a ?? 255
}

const canvas = (width, height, fill) => {
  const px = { width, height, rgba: Buffer.alloc(width * height * 4) }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) setPx(px, x, y, fill)
  return px
}

const fillRect = (px, box, color) => {
  const b = Px.boxOf(box, px)
  for (let y = b.top; y < b.bottom; y++) for (let x = b.left; x < b.right; x++) setPx(px, x, y, color)
}

/** Vertical strokes, which is enough for a colour and a glyph height. */
const drawText = (px, box, { color, glyphHeight, advance = 8, stroke = 3 }) => {
  const b = Px.boxOf(box, px)
  for (let x = b.left; x + stroke <= b.right; x += advance) {
    fillRect(px, { x, y: b.top, w: stroke, h: glyphHeight }, color)
  }
}

const rgb = (r, g, b, a = 255) => ({ r, g, b, a })
const PAGE = rgb(255, 255, 255)
const BAR = rgb(36, 90, 218) // #245ada
const SURFACE = rgb(244, 245, 247) // #f4f5f7
const INK = rgb(16, 21, 28) // #10151c
const MUTED = rgb(154, 163, 176) // #9aa3b0 — 2.34:1 on SURFACE, a real failure

// --- the screen, drawn and described ----------------------------------------

const drawScreen = () => {
  const px = canvas(200, 300, PAGE)
  fillRect(px, { x: 0, y: 0, w: 200, h: 80 }, BAR)
  fillRect(px, { x: 0, y: 100, w: 200, h: 200 }, SURFACE)
  drawText(px, { x: 16, y: 28, w: 120, h: 24 }, { color: PAGE, glyphHeight: 16 })
  drawText(px, { x: 16, y: 116, w: 168, h: 16 }, { color: INK, glyphHeight: 12 })
  drawText(px, { x: 16, y: 148, w: 40, h: 20 }, { color: MUTED, glyphHeight: 12 })
  fillRect(px, { x: 16, y: 180, w: 24, h: 24 }, BAR)
  return px
}

const ROOTS = [
  {
    type: "FrameLayout",
    bounds: { x: 0, y: 0, w: 200, h: 300 },
    children: [
      {
        type: "LinearLayout",
        bounds: { x: 0, y: 0, w: 200, h: 80 },
        children: [{ type: "TextView", bounds: { x: 16, y: 28, w: 120, h: 24 }, text: "Sign in", children: [] }],
      },
      {
        type: "LinearLayout",
        bounds: { x: 0, y: 100, w: 200, h: 200 },
        children: [
          // A pure wrapper: one child, no signal, identical bounds. Collapsible.
          {
            type: "FrameLayout",
            bounds: { x: 16, y: 116, w: 168, h: 16 },
            children: [{ type: "TextView", bounds: { x: 16, y: 116, w: 168, h: 16 }, text: "Email", children: [] }],
          },
          { type: "TextView", bounds: { x: 16, y: 148, w: 40, h: 20 }, text: "Continue", children: [] },
          { type: "Button", bounds: { x: 16, y: 180, w: 24, h: 24 }, clickable: true, children: [] },
          { type: "View", bounds: { x: 0, y: 290, w: 200, h: 10 }, visible: false, children: [] },
        ],
      },
    ],
  },
]

const DENSITY = 320 // scale 2.0, so 24px is 12dp
const scene = () => analyzeScene({ roots: ROOTS, px: drawScreen(), density: DENSITY })
const entryFor = (analysis, text) => analysis.entries.find((entry) => entry.node.text === text)

// --- the join ---------------------------------------------------------------

ok("a node's text colour comes from the pixels, not the tree", () => {
  const analysis = scene()
  const signIn = entryFor(analysis, "Sign in")
  assert.equal(signIn.style.ink, "#ffffff", "white text on the app bar")
  assert.equal(signIn.style.contrast, 5.92, "white on #245ada")
  assert.equal(signIn.text.maxGlyphHeight, 16, "measured from the strokes themselves")
})

ok("style is reported as a diff against the parent", () => {
  const analysis = scene()
  const signIn = entryFor(analysis, "Sign in")
  assert.equal(signIn.style.background, undefined, "it repeats the app bar's colour, which is not a decision")
  const button = analysis.entries.find((entry) => entry.node.type === "Button")
  assert.equal(button.style.background, "#245ada", "this one departs from the surface behind it")
})

ok("a pure wrapper is collapsed and counted", () => {
  const analysis = scene()
  assert.equal(analysis.counts.collapsed, 1)
  const email = entryFor(analysis, "Email")
  assert.equal(email.id, "0.1.0.0", "the id stays the node's original path, so dumps stay comparable")
  assert.equal(analysis.entries.filter((entry) => entry.node.type === "FrameLayout").length, 1, "only the root remains")
})

ok("a hidden node is excluded from the structure and still counted", () => {
  const analysis = scene()
  assert.equal(analysis.counts.hidden, 1)
  assert.equal(analysis.entries.length, 7)
  assert.ok(!analysis.entries.some((entry) => entry.node.type === "View"), "visible=false is not part of the screen")
})

// --- issues -----------------------------------------------------------------

ok("a real contrast failure is found, with the ratio that was measured", () => {
  const analysis = scene()
  const contrast = analysis.issues.filter((issue) => issue.kind === "contrast")
  assert.equal(contrast.length, 1, "only the muted label fails; the other two pass")
  assert.equal(contrast[0].id, "0.1.1")
  assert.match(contrast[0].detail, /#9aa3b0 on #f4f5f7 = 2\.34:1 \(needs 4\.5\)/)
})

ok("touch targets are judged in dp, not pixels", () => {
  const analysis = scene()
  const target = analysis.issues.filter((issue) => issue.kind === "target")
  assert.equal(target.length, 1)
  assert.match(target[0].detail, /12×12dp/, "24px at density 320 is 12dp, well under 48")
})

ok("a clickable node with nothing to announce is flagged", () => {
  const analysis = scene()
  const label = analysis.issues.filter((issue) => issue.kind === "label")
  assert.equal(label.length, 1)
  assert.equal(label[0].id, "0.1.2")
  assert.match(label[0].detail, /clickable but nothing in it announces a label/)
})

ok("a clickable row is not called unlabelled when its child carries the text", () => {
  // Android merges a row's descendants into one node, so a row whose child holds
  // the label IS announced. Testing only the row's own fields flagged every list
  // row in every app — and a report that cries wolf is a report nobody reads.
  const roots = [
    {
      type: "LinearLayout",
      bounds: { x: 0, y: 0, w: 200, h: 56 },
      clickable: true,
      children: [{ type: "TextView", bounds: { x: 16, y: 18, w: 100, h: 20 }, text: "Settings" }],
    },
  ]
  const analysis = analyzeScene({ roots, px: canvas(200, 56, PAGE), density: 160 })
  assert.deepEqual(analysis.issues.filter((issue) => issue.kind === "label"), [])
})

ok("a clickable row whose child is itself empty IS still flagged", () => {
  // The other half of the same rule: silence must not become a free pass.
  const roots = [
    {
      type: "LinearLayout",
      bounds: { x: 0, y: 0, w: 200, h: 56 },
      clickable: true,
      children: [{ type: "ImageView", bounds: { x: 16, y: 18, w: 20, h: 20 } }],
    },
  ]
  const analysis = analyzeScene({ roots, px: canvas(200, 56, PAGE), density: 160 })
  assert.equal(analysis.issues.filter((issue) => issue.kind === "label").length, 1)
})

ok("a truncated label is flagged from the ellipsis the app itself drew", () => {
  const roots = [
    { type: "TextView", bounds: { x: 0, y: 0, w: 100, h: 20 }, text: "A headline that ru…", children: [] },
  ]
  const analysis = analyzeScene({ roots, px: canvas(100, 20, PAGE), density: DENSITY })
  assert.equal(analysis.issues.filter((issue) => issue.kind === "clip").length, 1)
})

// --- scales -----------------------------------------------------------------

ok("the spacing rhythm is measured between stacked siblings", () => {
  const analysis = scene()
  assert.equal(analysis.scales.gaps.get(20), 1, "the gap between the app bar and the content")
  assert.equal(analysis.scales.gaps.get(16), 1, "between the email field and the label under it")
  assert.equal(analysis.scales.gaps.get(12), 1, "between the label and the button")
})

ok("the palette is tallied by usage", () => {
  const analysis = scene()
  const top = [...analysis.scales.backgrounds.entries()].sort((a, b) => b[1] - a[1])
  assert.equal(top[0][0], "#f4f5f7", "the surface is what most of the screen is")
  assert.ok(top.some(([hex]) => hex === "#245ada"), "and the accent is in the palette")
})

// --- the document -----------------------------------------------------------

ok("renderScene emits the three sections a reader needs", () => {
  const text = renderScene(scene())
  assert.match(text, /^scene 200×300 px · density 320 · 1dp = 2px$/m)
  // 6, not 3: the count is what a screen reader would ANNOUNCE, so a node whose
  // label lives in its content description counts too. Counting `text` alone read
  // "0 with text" over a live Compose settings screen carrying 16 descriptions.
  assert.match(text, /7 nodes · 1 interactive · 6 labelled · 1 wrappers collapsed · 1 hidden/)
  assert.match(text, /^STRUCTURE$/m)
  assert.match(text, /^SCALES \(measured, not declared\)$/m)
  assert.match(text, /^ISSUES$/m)
  assert.match(text, /#0\.1\.1 TextView \[16,148 40×20 \| 8,74 20×10dp\] "Continue" ink #9aa3b0 2\.34:1/)
})

ok("a truncated structure says how much it left out", () => {
  const text = renderScene(scene(), { maxNodes: 3 })
  assert.match(text, /… 4 more nodes not shown/, "a silent truncation reads as a complete screen")
})

ok("the same tree and the same buffer give the same document", () => {
  const px = drawScreen()
  const first = renderScene(analyzeScene({ roots: ROOTS, px, density: DENSITY }))
  const second = renderScene(analyzeScene({ roots: ROOTS, px, density: DENSITY }))
  assert.equal(first, second)
})

ok("an unknown density reports pixels and invents no dp", () => {
  const analysis = analyzeScene({ roots: ROOTS, px: drawScreen(), density: null })
  const text = renderScene(analysis)
  assert.match(text, /density unknown/)
  assert.ok(!text.includes("dp"), "without a density there is no honest way to say dp")
  assert.equal(analysis.issues.filter((issue) => issue.kind === "target").length, 0, "and no target can be judged")
})

console.log(`\n${passed} checks passed`)
