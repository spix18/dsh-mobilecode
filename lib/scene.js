/**
 * The scene: what the screen LOOKS like, assembled from the only two things a
 * device will actually tell us about an app we do not own.
 *
 *   - the uiautomator tree says WHERE things are and WHAT they are called;
 *   - the pixels say what they LOOK like — colour, radius, contrast, depth.
 *
 * Neither answers a design question alone. The tree has no colours; the pixels
 * have no names. Joining them on bounds is the whole idea, and it is why this
 * module is a pure function of `{ roots, px, density }`: given the same tree and
 * the same buffer it always produces the same document, so the entire layer is
 * testable against a synthesised canvas with no device and no emulator.
 *
 * Every derived value carries its own uncertainty rather than being smoothed
 * over. A contrast ratio measured against a photo is a measurement of that photo,
 * not of a design token, and the document says so by reporting what it measured.
 *
 * `ponytail:` the ceiling is the same as the pixel layer's — sRGB, 8-bit, no
 * colour management, and one screen at a time. Two screens are two scenes.
 */

import {
  boxOf,
  borderOf,
  colorDistance,
  cornerRadius,
  dominantColor,
  elevationOf,
  sameColor,
  textMetrics,
  toHex,
} from "./pixels.js"
import { sameBounds } from "./uitree.js"

/** Android's density is the scale factor against 160dpi, which is 1dp. */
const DP_BASE = 160
/** Material's minimum touch target. Below this a control is hard to hit. */
const MIN_TOUCH_DP = 48
/** WCAG 2.x: normal text needs 4.5:1, large text 3:1. */
const CONTRAST_NORMAL = 4.5
const CONTRAST_LARGE = 3

/**
 * The keys that mean a node is more than a layout wrapper. A wrapper carrying
 * any of these is telling the designer something and must not be collapsed.
 * `checked` counts even when false: an unchecked switch is information.
 */
const SIGNAL_KEYS = [
  "text",
  "contentDesc",
  "resourceId",
  "clickable",
  "scrollable",
  "checked",
  "selected",
  "longClickable",
  "password",
  "focusable",
  "hintText",
  "tooltipText",
]

const hasSignal = (node) => SIGNAL_KEYS.some((key) => node[key] !== undefined)

/**
 * Flatten the tree to a list, collapsing pure wrappers.
 *
 * Android nests a FrameLayout around a LinearLayout around a FrameLayout with a
 * single child each, and a real screen is mostly these. A node is only collapsed
 * when it has exactly ONE child, carries no signal of its own, and occupies
 * exactly its child's bounds — so the collapse provably discards nothing. The
 * id stays the node's original index path, which is what makes two dumps of the
 * same screen comparable.
 */
const flatten = (roots, collapseWrappers) => {
  const entries = []
  let collapsed = 0
  let hidden = 0
  const walk = (node, depth, path, parentBounds) => {
    if (node.visible === false) {
      hidden += 1
      return
    }
    const all = node.children ?? []
    const children = all.filter((child) => child.visible !== false)
    // A hidden child is filtered out before the walk can ever see it, so it has
    // to be counted here. Otherwise the document quietly reports a smaller screen
    // than the one that was captured, and nothing says so.
    hidden += all.length - children.length
    if (
      collapseWrappers &&
      children.length === 1 &&
      !hasSignal(node) &&
      sameBounds(node.bounds, children[0].bounds)
    ) {
      collapsed += 1
      walk(children[0], depth, `${path}.0`, parentBounds)
      return
    }
    entries.push({ id: path, depth, node, parentBounds })
    for (let i = 0; i < children.length; i++) walk(children[i], depth + 1, `${path}.${i}`, node.bounds)
  }
  for (let i = 0; i < roots.length; i++) walk(roots[i], 0, String(i), null)
  return { entries, collapsed, hidden }
}

/** The largest text a node paints, in px, as a proxy for its type size. */
const glyphOf = (metrics) => (metrics === null ? null : metrics.maxGlyphHeight || metrics.glyphHeight || null)

/**
 * Does anything in this subtree give the node a name?
 *
 * A clickable container whose CHILD carries the text is still announced —
 * Android merges a row's descendants into one node — so testing only the node's
 * own fields reports an unlabelled control on every list row in every app, and a
 * report that cries wolf is a report nobody reads.
 */
const announces = (node) =>
  Boolean(node.text || node.contentDesc || node.hintText || node.tooltipText) ||
  (node.children ?? []).some((child) => child.visible !== false && announces(child))

/**
 * Everything the pixels can say about one node.
 *
 * Style is reported as a DIFF against the parent, because that is how a designer
 * reads it: a card that repeats its parent's background is not a design decision,
 * it is the absence of one. A node that only inherits produces an empty style,
 * which is itself the finding.
 */
const styleOf = (px, bounds, { hasText, parentBackground }) => {
  const b = boxOf(bounds, px)
  if (b.width < 2 || b.height < 2) return { style: {}, text: null }
  const style = {}
  const background = dominantColor(px, b)
  if (background !== null && background.share >= 0.5) {
    const differs = parentBackground === null || !sameColor(background.color, parentBackground, 8)
    if (differs) {
      style.background = toHex(background.color)
      style.backgroundShare = background.share
    }
  }
  const radius = cornerRadius(px, b, { fill: background?.color ?? null })
  if (radius !== null && radius.radius > 0) {
    style.radius = radius.radius
    style.radiusAliased = radius.aliased
  }
  const border = borderOf(px, b, { fill: background?.color ?? null })
  if (border !== null && border.width > 0) {
    style.border = border.width
    style.borderColor = border.hex
  }
  const elevation = elevationOf(px, b)
  if (elevation !== null && elevation.spread > 0) {
    style.elevation = elevation.spread
    style.elevationOffsetY = elevation.offsetY
  }
  let text = null
  if (hasText) {
    text = textMetrics(px, b, { background: background?.color ?? null })
    if (text !== null) {
      style.ink = text.hex
      style.contrast = Math.round(text.contrast * 100) / 100
    }
  }
  return { style, text, background: background?.color ?? null }
}

const addCount = (map, key) => {
  if (key === null || key === undefined) return
  map.set(key, (map.get(key) ?? 0) + 1)
}

const ranked = (map, limit) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)

/**
 * Analyse a screen. Pure: same tree plus same buffer gives the same document.
 */
export function analyzeScene({ roots, px, density = null, options = {} } = {}) {
  const { collapseWrappers = true, style = true } = options
  const scale = density === null ? null : density / DP_BASE
  const { entries, collapsed, hidden } = flatten(roots ?? [], collapseWrappers)

  const backgrounds = new Map()
  const radii = new Map()
  const inks = new Map()
  const glyphs = new Map()
  const gaps = new Map()
  const issues = []

  const toDp = (value) => (scale === null ? null : Math.round((value / scale) * 10) / 10)
  const dpSize = (bounds) =>
    scale === null ? null : `${toDp(bounds.w)}×${toDp(bounds.h)}dp`

  const described = []
  for (const entry of entries) {
    const node = entry.node
    const hasText = typeof node.text === "string" && node.text.length > 0
    const parentBackground =
      entry.parentBounds === null
        ? null
        : dominantColor(px, boxOf(entry.parentBounds, px))?.color ?? null
    const analysed = style && px !== undefined ? styleOf(px, node.bounds, { hasText, parentBackground }) : { style: {}, text: null }
    described.push({ ...entry, ...analysed })

    // Tally the colour that is actually on screen, not the diff against the
    // parent. A palette by USAGE has to count a node that inherits the page
    // colour as using it — tallying the diff instead reports only the handful of
    // nodes that changed something, which is the opposite of a palette.
    addCount(backgrounds, analysed.background === null ? null : toHex(analysed.background))
    if (analysed.style.radius !== undefined) addCount(radii, analysed.style.radius)
    if (analysed.style.ink !== undefined) addCount(inks, `${analysed.style.ink} ${analysed.style.contrast}:1`)
    const glyph = glyphOf(analysed.text)
    if (glyph !== null) addCount(glyphs, glyph)

    // --- issues -------------------------------------------------------------
    const interactive = node.clickable === true || node.longClickable === true
    if (interactive && scale !== null && (toDp(node.bounds.w) < MIN_TOUCH_DP || toDp(node.bounds.h) < MIN_TOUCH_DP)) {
      issues.push({
        kind: "target",
        id: entry.id,
        detail: `${dpSize(node.bounds)} — Android's minimum touch target is ${MIN_TOUCH_DP}dp`,
      })
    }
    if (interactive && !announces(node)) {
      issues.push({ kind: "label", id: entry.id, detail: `${node.type} is clickable but nothing in it announces a label` })
    }
    if (analysed.style.contrast !== undefined) {
      // Glyph height is a PROXY for type size, never the font size itself, so the
      // threshold is deliberately generous: only a clearly large glyph buys the
      // 3:1 rule, and everything else is held to 4.5.
      const large = glyph !== null && glyph >= 24
      const needs = large ? CONTRAST_LARGE : CONTRAST_NORMAL
      if (analysed.style.contrast < needs) {
        issues.push({
          kind: "contrast",
          id: entry.id,
          // Report the colour that was MEASURED, not the diff: a node that
          // inherits the page colour still has a background the reader needs in
          // order to judge the ratio.
          detail: `${analysed.style.ink} on ${analysed.background === null ? "the surface" : toHex(analysed.background)} = ${analysed.style.contrast}:1 (needs ${needs}${large ? ", large text" : ""})`,
        })
      }
    }
    if (hasText && /…$/.test(node.text)) {
      issues.push({ kind: "clip", id: entry.id, detail: `"${node.text}" ends in an ellipsis — the text is truncated` })
    }

    // --- spacing rhythm -----------------------------------------------------
    const kids = (node.children ?? []).filter((child) => child.visible !== false && child.bounds.w > 0 && child.bounds.h > 0)
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].bounds
      const b = kids[i].bounds
      if (b.y >= a.y + a.h) addCount(gaps, b.y - (a.y + a.h))
      else if (b.x >= a.x + a.w) addCount(gaps, b.x - (a.x + a.w))
    }
  }

  const packages = [...new Set((roots ?? []).map((root) => root.package).filter(Boolean))]
  return {
    screen: { width: px?.width ?? null, height: px?.height ?? null, density, scale },
    counts: {
      nodes: described.length,
      interactive: described.filter((entry) => entry.node.clickable === true).length,
      // "with text" was a lie on a real screen: a Compose settings page carried 16
      // content descriptions and zero `text` attributes, so the header read
      // "0 with text" over a screen full of labels. Count what a screen reader
      // would actually announce, which is the same predicate the label issue uses.
      labelled: described.filter((entry) => announces(entry.node)).length,
      collapsed,
      hidden,
    },
    package: packages.length === 1 ? packages[0] : packages.length > 1 ? packages.join(", ") : null,
    entries: described,
    scales: { backgrounds, radii, inks, glyphs, gaps },
    issues,
  }
}

const boundsText = (bounds, scale) => {
  const px = `${bounds.x},${bounds.y} ${bounds.w}×${bounds.h}`
  if (scale === null) return px
  const dp = `${Math.round((bounds.x / scale) * 10) / 10},${Math.round((bounds.y / scale) * 10) / 10} ${Math.round((bounds.w / scale) * 10) / 10}×${Math.round((bounds.h / scale) * 10) / 10}`
  return `${px} | ${dp}dp`
}

const label = (node) => {
  if (typeof node.text === "string" && node.text.length > 0) return JSON.stringify(node.text)
  if (node.contentDesc) return `desc ${JSON.stringify(node.contentDesc)}`
  if (node.hintText) return `hint ${JSON.stringify(node.hintText)}`
  return ""
}

const flags = (node) => {
  const out = []
  if (node.clickable) out.push("click")
  if (node.scrollable) out.push("scroll")
  if (node.checked !== undefined) out.push(node.checked ? "checked" : "unchecked")
  if (node.selected) out.push("selected")
  if (node.longClickable) out.push("long-press")
  if (node.password) out.push("password")
  if (node.enabled === false) out.push("disabled")
  if (node.focusable === false) out.push("unreachable")
  return out.join(" ")
}

const styleText = (style) => {
  const out = []
  if (style.background !== undefined) out.push(`bg ${style.background}`)
  if (style.ink !== undefined) out.push(`ink ${style.ink} ${style.contrast}:1`)
  if (style.radius !== undefined) out.push(`r${style.radius}${style.radiusAliased ? "?" : ""}`)
  if (style.border !== undefined) out.push(`border ${style.border}px ${style.borderColor}`)
  if (style.elevation !== undefined) out.push(`elev ${style.elevation}px${style.elevationOffsetY ? ` down ${style.elevationOffsetY}` : ""}`)
  return out.join(" ")
}

/**
 * Render the analysis as text. Text is the point: a text-only model has to be
 * able to see the screen through this, and a vision model gets the pixels too.
 *
 * The structure section is capped because a long list is a screen nobody reads.
 * When the cap bites, the document says how many nodes it left out — a silent
 * truncation reads as a complete screen.
 */
export function renderScene(analysis, { maxNodes = 120, maxScaleEntries = 6, issues = true } = {}) {
  const { screen, counts, scales } = analysis
  const scale = screen.scale
  const lines = []

  const density = screen.density === null ? "density unknown" : `density ${screen.density}`
  const conversion = scale === null ? "" : ` · 1dp = ${Math.round(scale * 100) / 100}px`
  lines.push(`scene ${screen.width}×${screen.height} px · ${density}${conversion}`)
  lines.push(
    `${counts.nodes} nodes · ${counts.interactive} interactive · ${counts.labelled} labelled` +
      (counts.collapsed > 0 ? ` · ${counts.collapsed} wrappers collapsed` : "") +
      (counts.hidden > 0 ? ` · ${counts.hidden} hidden` : ""),
  )
  if (analysis.package !== null) lines.push(`package ${analysis.package}`)

  lines.push("")
  lines.push("STRUCTURE")
  const shown = analysis.entries.slice(0, maxNodes)
  for (const entry of shown) {
    const node = entry.node
    const parts = [`${"  ".repeat(entry.depth)}#${entry.id}`, node.type, `[${boundsText(node.bounds, scale)}]`]
    const text = label(node)
    if (text) parts.push(text)
    const style = styleText(entry.style)
    if (style) parts.push(style)
    const state = flags(node)
    if (state) parts.push(state)
    lines.push(parts.join(" "))
  }
  if (analysis.entries.length > shown.length) {
    lines.push(`… ${analysis.entries.length - shown.length} more nodes not shown`)
  }

  const scaleSections = [
    ["bg", scales.backgrounds],
    ["radius", scales.radii],
    ["text", scales.inks],
    ["glyph", scales.glyphs],
    ["gap", scales.gaps],
  ].filter(([, map]) => map.size > 0)
  if (scaleSections.length > 0) {
    lines.push("")
    lines.push("SCALES (measured, not declared)")
    for (const [name, map] of scaleSections) {
      const top = ranked(map, maxScaleEntries)
        .map(([value, count]) => `${value}${name === "glyph" || name === "gap" ? "px" : ""} ×${count}`)
        .join("  ")
      lines.push(`${name.padEnd(7)} ${top}${map.size > maxScaleEntries ? `  (+${map.size - maxScaleEntries} more)` : ""}`)
    }
    // A mark the reader cannot decode is noise, and the difference between a
    // measurement and an estimate is exactly what this document exists to convey.
    if (analysis.entries.some((entry) => entry.style?.radiusAliased)) {
      lines.push("radius marked ? came from a hard-edged render and is good to about ±2px")
    }
  }

  if (issues && analysis.issues.length > 0) {
    lines.push("")
    lines.push("ISSUES")
    for (const issue of analysis.issues) lines.push(`${issue.kind.padEnd(9)} #${issue.id} ${issue.detail}`)
  }
  return lines.join("\n")
}
