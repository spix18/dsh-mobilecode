/**
 * dsh-mobilecode — pixel-truth analysis: what a screen actually LOOKS like.
 *
 * The UI tree says where things are; it cannot say what colour a card is, how
 * round its corners are, or whether the text on it is readable. Those live only
 * in the pixels, and an app we do not own cannot be asked — so they are MEASURED
 * here, from the RGBA buffer a screencap already produced.
 *
 * Every export is a pure function of that buffer: no device, no emulator, no
 * I/O. Ground truth is therefore SYNTHESIZABLE — a test draws a rounded rect of
 * a known radius and asserts the extractor recovers it — which is the only
 * reason this layer is worth having at all: it can be proven offline.
 *
 * Colour maths is WCAG 2.x exactly (relative luminance, alpha compositing), so a
 * reported contrast ratio is the number an auditor would compute rather than an
 * approximation of it.
 * ponytail: sRGB, 8-bit, no colour management. Upgrade path = a real colour
 * space IF a device ever reports a wide-gamut surface.
 */

/**
 * Normalise a box to `{left, top, right, bottom, width, height}` and CLAMP it to
 * the image. Boxes here are `{x, y, w, h}` (origin + size, what `parseBounds`
 * produces), but a caller holding corners can pass those instead. Clamping is
 * not politeness: uiautomator reports bounds that hang off the screen, and an
 * unclamped read would sample whatever the buffer happens to hold next.
 */
export function boxOf(box, px) {
  const left = box.left ?? box.x ?? 0
  const top = box.top ?? box.y ?? 0
  const right = box.right ?? left + (box.w ?? box.width ?? 0)
  const bottom = box.bottom ?? top + (box.h ?? box.height ?? 0)
  // Both edges clamp to the image, not just the far ones: a box entirely off
  // screen would otherwise come back with left > right, and every consumer that
  // loops `for (y = top; y < bottom)` would silently do nothing.
  const l = Math.min(px.width, Math.max(0, Math.floor(left)))
  const t = Math.min(px.height, Math.max(0, Math.floor(top)))
  const r = Math.min(px.width, Math.max(0, Math.ceil(right)))
  const b = Math.min(px.height, Math.max(0, Math.ceil(bottom)))
  return { left: l, top: t, right: r, bottom: b, width: Math.max(0, r - l), height: Math.max(0, b - t) }
}

/** The pixel at (x, y) as `{r, g, b, a}`, or null outside the buffer. */
export function pxAt(px, x, y) {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) return null
  if (xi < 0 || yi < 0 || xi >= px.width || yi >= px.height) return null
  const i = (yi * px.width + xi) * 4
  return { r: px.rgba[i], g: px.rgba[i + 1], b: px.rgba[i + 2], a: px.rgba[i + 3] }
}

/** WCAG relative luminance, sRGB → linearised, exactly as the spec defines it. */
export function relativeLuminance(color) {
  const linear = (value) => {
    const s = value / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/**
 * WCAG contrast ratio, 1 (identical) to 21 (black on white). Order-independent
 * by construction: the lighter colour is always the numerator.
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Alpha-composite `fg` over `bg` into an opaque colour. */
export function composite(fg, bg) {
  if (fg.a >= 255) return { r: fg.r, g: fg.g, b: fg.b, a: 255 }
  const alpha = fg.a / 255
  return {
    r: Math.round(fg.r * alpha + bg.r * (1 - alpha)),
    g: Math.round(fg.g * alpha + bg.g * (1 - alpha)),
    b: Math.round(fg.b * alpha + bg.b * (1 - alpha)),
    a: 255,
  }
}

/**
 * Perceptual-ish distance between two colours (the "redmean" approximation).
 * Plain sRGB Euclidean distance calls two greens far apart and two blues close
 * together; this weights the channels by how the eye actually splits them, which
 * is what "is this the same colour?" needs.
 */
export function colorDistance(a, b) {
  const rmean = (a.r + b.r) / 2
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt((((512 + rmean) * dr * dr) / 256) + 4 * dg * dg + (((767 - rmean) * db * db) / 256))
}

/** True when two colours are within `tolerance` of each other. */
export function sameColor(a, b, tolerance = 12) {
  if (a === null || b === null || a === undefined || b === undefined) return false
  return colorDistance(a, b) <= tolerance
}

/** `#rrggbb` for logs, reports and test messages. Alpha is dropped, not merged. */
export function toHex(color) {
  const hex = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
}

// --- region colour ---------------------------------------------------------

const bucketKey = (color, quantize) =>
  (((color.r / quantize) | 0) << 12) | (((color.g / quantize) | 0) << 6) | ((color.b / quantize) | 0)

const histogramAdd = (buckets, color, quantize) => {
  const key = bucketKey(color, quantize)
  let bucket = buckets.get(key)
  if (bucket === undefined) {
    bucket = { count: 0, r: 0, g: 0, b: 0 }
    buckets.set(key, bucket)
  }
  bucket.count += 1
  bucket.r += color.r
  bucket.g += color.g
  bucket.b += color.b
}

const histogramBest = (buckets, total) => {
  let best = null
  for (const bucket of buckets.values()) if (best === null || bucket.count > best.count) best = bucket
  if (best === null) return null
  return {
    color: { r: Math.round(best.r / best.count), g: Math.round(best.g / best.count), b: Math.round(best.b / best.count), a: 255 },
    count: best.count,
    total,
    share: best.count / Math.max(1, total),
    distinct: buckets.size,
  }
}

/**
 * The most common colour in a box. For a card that IS its background: glyph
 * pixels are a minority of any text-bearing surface, so the mode survives text,
 * icons and a stray gradient without needing to know where they are.
 *
 * `share` and `distinct` are the honesty channel — a flat fill returns a high
 * share over few buckets, a photo returns a low share over many, and a caller
 * that needs certainty can require both.
 */
export function dominantColor(px, box, { quantize = 8, skip = null, tolerance = 12 } = {}) {
  const b = boxOf(box, px)
  const buckets = new Map()
  let total = 0
  for (let y = b.top; y < b.bottom; y++) {
    for (let x = b.left; x < b.right; x++) {
      const color = pxAt(px, x, y)
      if (color === null || color.a === 0) continue
      if (skip !== null && sameColor(color, skip, tolerance)) continue
      histogramAdd(buckets, color, quantize)
      total += 1
    }
  }
  return histogramBest(buckets, total)
}

/**
 * The colour immediately OUTSIDE a box, sampled as a ring `depth` pixels deep on
 * every side that exists. This is what the box is painted ON, which is the only
 * way to tell a card's fill from the page behind it — and it is also the
 * backdrop a translucent surface has to be composited against.
 *
 * Returns null when the box touches every image edge: there is then no surround
 * to measure, and inventing one would be a guess.
 */
export function surroundColor(px, box, { depth = 3, quantize = 8 } = {}) {
  const b = boxOf(box, px)
  const buckets = new Map()
  let total = 0
  const take = (x, y) => {
    const color = pxAt(px, x, y)
    if (color === null || color.a === 0) return
    histogramAdd(buckets, color, quantize)
    total += 1
  }
  for (let d = 1; d <= depth; d++) {
    for (let x = b.left - d; x < b.right + d; x++) {
      take(x, b.top - d)
      take(x, b.bottom + d - 1)
    }
    for (let y = b.top - d; y < b.bottom + d; y++) {
      take(b.left - d, y)
      take(b.right + d - 1, y)
    }
  }
  return histogramBest(buckets, total)
}

/**
 * Where the painted shape ACTUALLY begins, found by scanning inward from outside
 * the reported box. uiautomator bounds come from the layout, so they can carry a
 * shadow, a margin or a half-pixel offset; a corner radius measured from a box
 * one pixel too wide is wrong by 3.4px, because the diagonal amplifies it.
 *
 * The scan runs along the box's midlines, where the shape is at its widest and
 * text is least likely to reach the edge. Returns null if no edge is found in
 * either direction — the shape is invisible against its surround.
 */
export function shapeEdges(px, box, { surround = null, tolerance = 12, probe = 4 } = {}) {
  const b = boxOf(box, px)
  if (b.width < 2 || b.height < 2) return null
  // `surround` arrives as a COLOUR; the sampler returns a histogram result. Both
  // paths have to end up as a colour, or every comparison is NaN > tolerance.
  const outside = (surround ?? surroundColor(px, b)?.color) ?? null
  if (outside === null) return null
  const painted = (x, y) => {
    const color = pxAt(px, x, y)
    return color !== null && colorDistance(color, outside) > tolerance
  }
  const midY = Math.floor((b.top + b.bottom) / 2)
  const midX = Math.floor((b.left + b.right) / 2)
  const x0 = Math.max(0, b.left - probe)
  const x1 = Math.min(px.width, b.right + probe)
  const y0 = Math.max(0, b.top - probe)
  const y1 = Math.min(px.height, b.bottom + probe)
  let left = null
  let right = null
  let top = null
  let bottom = null
  for (let x = x0; x < x1 && left === null; x++) if (painted(x, midY)) left = x
  for (let x = x1 - 1; x >= x0 && right === null; x--) if (painted(x, midY)) right = x
  for (let y = y0; y < y1 && top === null; y++) if (painted(midX, y)) top = y
  for (let y = y1 - 1; y >= y0 && bottom === null; y--) if (painted(midX, y)) bottom = y
  if (left === null || right === null || top === null || bottom === null) return null
  if (right < left || bottom < top) return null
  return { left, top, right: right + 1, bottom: bottom + 1, width: right - left + 1, height: bottom - top + 1 }
}

// --- corner radius ---------------------------------------------------------

/**
 * How far along the diagonal the arc boundary sits, for a corner of radius r.
 *
 * The arc is centred at (r, r) from the corner and has radius r, so a point at
 * distance t along the diagonal is on the boundary when |(t,t) − (r,r)| = r:
 *
 *     (t − r)² · 2 = r²   →   t = r(√2 − 1) ≈ 0.41421 r
 *
 * so r = t / (√2 − 1) = t(√2 + 1). That factor 2.41421 is why the diagonal is
 * the right place to measure and also why a one-pixel error in the origin costs
 * 3.4px in the answer — the corner is a magnifying glass pointed at the box.
 */
const DIAGONAL = Math.SQRT2 + 1

/**
 * The same factor for a PIXEL INDEX rather than a distance. Pixel i along the
 * diagonal covers the stretch `[i√2, (i+1)√2]` of distance from the corner, so
 * converting an index needs one more √2: √2(√2+1) = 2 + √2. Mixing the two up
 * costs exactly a factor of √2 — which looks like a plausible radius, so it is
 * the kind of error only a synthesised ground truth catches.
 */
const DIAGONAL_PIXEL = 2 + Math.SQRT2

/**
 * Decompose a sample into "how much of the fill is in it" and "how far off the
 * surround→fill line it sits". A true anti-aliased edge pixel is a blend of
 * exactly those two colours, so it lands ON the line (`off` ≈ 0) and its
 * position along the line IS its coverage. A third colour — a border stroke, a
 * shadow, a neighbouring element bleeding in — lands off the line, which is how
 * this function reports that the pixel is not evidence about the radius.
 */
const blendOf = (sample, outside, inside) => {
  const dr = inside.r - outside.r
  const dg = inside.g - outside.g
  const db = inside.b - outside.b
  const denom = dr * dr + dg * dg + db * db
  if (denom === 0) return null
  const pr = sample.r - outside.r
  const pg = sample.g - outside.g
  const pb = sample.b - outside.b
  const along = (pr * dr + pg * dg + pb * db) / denom
  const er = pr - along * dr
  const eg = pg - along * dg
  const eb = pb - along * db
  return { coverage: Math.max(0, Math.min(1, along)), off: Math.sqrt(er * er + eg * eg + eb * eb) }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The corner radius of the shape inside a box, measured from pixels alone.
 *
 * Walks the diagonal of each corner from the outside in, finds the first pixel
 * that carries any of the fill, and reads the radius straight out of its
 * coverage. The walk is exact rather than approximate because anti-aliasing
 * hands over the sub-pixel position for free: a pixel that is 40% fill means the
 * boundary crosses 40% of the way into it, and the diagonal turns that into r
 * with no fitting and no search.
 *
 * A hard-edged render (a screenshot with anti-aliasing disabled, or a synthetic
 * buffer) has no partial pixels, so the answer falls back to the pixel grid and
 * carries ±1.7px of quantization. That case is REPORTED (`aliased`) rather than
 * smoothed over, because a number that is confident and wrong is worse than one
 * that says how sure it is.
 *
 * Measured against synthesised ground truth: within 0.45px across radii 0–48 on
 * an anti-aliased render (the residual is the arc's curvature, which the
 * straight-line diagonal model does not carry), and within 1.7px on a hard-edged
 * one, where that is exactly what the pixel grid allows and `aliased` says so.
 * A hard edge cannot resolve a radius below about 2px at all — the rounding
 * removes no pixel centre — so such a corner reads as 0, which is what the
 * pixels actually show.
 *
 * Returns null when the shape cannot be distinguished from its surround at all.
 * A border stroke between the two colours is not yet modelled: it lands off the
 * blend line, the corner is skipped, and the radius is reported from the corners
 * that remain (or null if none do).
 */
export function cornerRadius(px, box, { surround = null, fill = null, tolerance = 12, maxSteps = null } = {}) {
  const edges = shapeEdges(px, box, { surround, tolerance })
  if (edges === null) return null
  const outside = (surround ?? surroundColor(px, edges)?.color) ?? null
  if (outside === null) return null
  const inside = fill ?? dominantColor(px, edges)?.color ?? null
  if (inside === null) return null
  if (sameColor(inside, outside, tolerance)) return null

  const limit = Math.max(2, maxSteps ?? Math.floor(Math.min(edges.width, edges.height) / 2) + 2)
  const corners = [
    { name: "tl", x: edges.left, y: edges.top, dx: 1, dy: 1 },
    { name: "tr", x: edges.right - 1, y: edges.top, dx: -1, dy: 1 },
    { name: "br", x: edges.right - 1, y: edges.bottom - 1, dx: -1, dy: -1 },
    { name: "bl", x: edges.left, y: edges.bottom - 1, dx: 1, dy: -1 },
  ]
  const perCorner = {}
  const estimates = []
  let blended = false
  for (const corner of corners) {
    let estimate = null
    for (let i = 0; i < limit; i++) {
      const sample = pxAt(px, corner.x + corner.dx * i, corner.y + corner.dy * i)
      if (sample === null) break
      const blend = blendOf(sample, outside, inside)
      if (blend === null || blend.coverage <= 0.02) continue
      // Off the surround→fill line means this pixel is not a blend of the two,
      // so it says nothing about where the arc is. Skip the corner rather than
      // turn a border stroke into a radius.
      if (blend.off > tolerance) break
      if (blend.coverage < 0.98) blended = true
      estimate = DIAGONAL_PIXEL * (i + 1 - blend.coverage)
      break
    }
    perCorner[corner.name] = estimate === null ? null : Math.round(estimate * 100) / 100
    if (estimate !== null) estimates.push(estimate)
  }
  if (estimates.length === 0) return null

  const radius = Math.round(median(estimates) * 100) / 100
  const spread = Math.round((Math.max(...estimates) - Math.min(...estimates)) * 100) / 100
  let confidence = estimates.length >= 2 ? Math.max(0.1, Math.min(1, 1 - spread / 8)) : 0.4
  // No corner produced a partial pixel, so the boundary is only known to the
  // pixel and the estimate carries the diagonal's ±1.7px quantization — unless
  // the radius is zero, where the boundary IS the box edge and needs no
  // sub-pixel information to be exact.
  const aliased = !blended && radius > 0.5
  if (aliased) confidence = Math.min(confidence, 0.5)
  return {
    radius,
    perCorner,
    measured: estimates.length,
    spread,
    uniform: spread <= 1.5,
    aliased,
    confidence: Math.round(confidence * 100) / 100,
  }
}

// --- text ------------------------------------------------------------------

/**
 * What the text inside a box looks like: its colour, the surface behind it, the
 * WCAG contrast between the two, and how tall its glyphs actually are.
 *
 * The colour comes from the SOLID CORE of the glyphs, never their average.
 * Anti-aliasing turns every edge pixel into a blend of text and background, so a
 * mean reports a colour the text never is; the answer is the most extreme colour
 * that still recurs, because a fringe is a blend that by definition does not.
 *
 * Glyph height is a PROXY. It is the modal height of the vertical runs of glyph
 * pixels — the x-height for mixed-case text, the cap height for all-caps. It is
 * not a font size: converting needs the font's own metrics, which a release
 * build of an app we do not own does not expose. But it is the same number on
 * two screens, which is exactly what comparing them requires.
 */
export function textMetrics(px, box, { background = null, tolerance = 40 } = {}) {
  const b = boxOf(box, px)
  if (b.width < 2 || b.height < 2) return null
  const bg = background ?? dominantColor(px, b)?.color ?? null
  if (bg === null) return null

  const glyphAt = (x, y) => {
    const color = pxAt(px, x, y)
    if (color === null) return null
    const distance = colorDistance(color, bg)
    return distance > tolerance ? distance : null
  }

  const rowCounts = new Array(b.height).fill(0)
  let glyphs = 0
  let maxDistance = 0
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const distance = glyphAt(b.left + x, b.top + y)
      if (distance === null) continue
      rowCounts[y] += 1
      glyphs += 1
      if (distance > maxDistance) maxDistance = distance
    }
  }
  if (glyphs === 0) return null

  // A row counts as part of a line when it carries a real share of it, not the
  // anti-aliased fringe of the line above. The threshold follows the densest row
  // so a short label and a full paragraph both segment correctly.
  const floor = Math.max(1, Math.max(...rowCounts) * 0.05)
  const bands = []
  let start = -1
  for (let y = 0; y <= b.height; y++) {
    const inBand = y < b.height && rowCounts[y] >= floor
    if (inBand && start < 0) start = y
    else if (!inBand && start >= 0) {
      bands.push({ top: b.top + start, bottom: b.top + y, height: y - start })
      start = -1
    }
  }

  // The solid core: only the most extreme colours that recur are the text.
  const buckets = new Map()
  const extreme = maxDistance * 0.8
  let core = 0
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const color = pxAt(px, b.left + x, b.top + y)
      if (color === null || colorDistance(color, bg) < extreme) continue
      histogramAdd(buckets, color, 8)
      core += 1
    }
  }
  const solid = histogramBest(buckets, core)?.color ?? null
  if (solid === null) return null

  // Vertical run lengths per column: the modal run is the height most strokes
  // share, the longest is the ascender.
  const runs = new Map()
  for (let x = 0; x < b.width; x++) {
    let run = 0
    for (let y = 0; y <= b.height; y++) {
      const on = y < b.height && glyphAt(b.left + x, b.top + y) !== null
      if (on) run += 1
      else if (run > 0) {
        runs.set(run, (runs.get(run) ?? 0) + 1)
        run = 0
      }
    }
  }
  let glyphHeight = null
  let maxGlyphHeight = 0
  let bestCount = 0
  for (const [length, count] of runs) {
    if (length > maxGlyphHeight) maxGlyphHeight = length
    if (count > bestCount) {
      bestCount = count
      glyphHeight = length
    }
  }

  return {
    color: solid,
    hex: toHex(solid),
    background: bg,
    backgroundHex: toHex(bg),
    contrast: Math.round(contrastRatio(solid, bg) * 100) / 100,
    glyphHeight,
    maxGlyphHeight,
    bands,
    lineCount: bands.length,
    coverage: Math.round((glyphs / (b.width * b.height)) * 1000) / 1000,
  }
}

// --- border and elevation --------------------------------------------------

/**
 * The stroke around a shape, if it has one.
 *
 * A stroke and an anti-aliased fill edge both put "a colour that is not the
 * fill" against the shape's boundary, so width alone cannot tell them apart.
 * What separates them is the same test the radius uses: a fill edge is a BLEND
 * of the surround and the fill and therefore lies on the line between them,
 * while a stroke is a third colour that lies off it. That is why a bordered card
 * and an unbordered one are distinguishable at all.
 *
 * Returns `{ width: 0 }` when there is no stroke, so a caller never has to
 * distinguish "no border" from "could not tell" — `shapeEdges` returning null
 * already covers the latter.
 *
 * A run that reaches `maxWidth` is refused rather than reported: a stroke has a
 * width, so a run still going at the budget's end is a region, not a stroke.
 */
export function borderOf(px, box, { surround = null, fill = null, tolerance = 12, maxWidth = 8 } = {}) {
  // The reference is the element's own bounds, not `shapeEdges`: a drop shadow
  // differs from the page by more than any useful tolerance, so `shapeEdges`
  // hands back the shadow's outer edge and then every sample is shadow.
  const edges = boxOf(box, px)
  if (edges.width < 2 || edges.height < 2) return null
  const outside = (surround ?? surroundColor(px, edges)?.color) ?? null
  if (outside === null) return null
  const inside = fill ?? dominantColor(px, edges)?.color ?? null
  if (inside === null) return null

  const midY = Math.floor((edges.top + edges.bottom) / 2)
  const midX = Math.floor((edges.left + edges.right) / 2)
  const sides = [
    { name: "top", x: midX, y: edges.top, dx: 0, dy: 1 },
    { name: "bottom", x: midX, y: edges.bottom - 1, dx: 0, dy: -1 },
    { name: "left", x: edges.left, y: midY, dx: 1, dy: 0 },
    { name: "right", x: edges.right - 1, y: midY, dx: -1, dy: 0 },
  ]
  const perSide = {}
  const widths = []
  const buckets = new Map()
  let samples = 0
  for (const side of sides) {
    const run = []
    for (let i = 0; i < maxWidth + 4 && run.length < maxWidth; i++) {
      const sample = pxAt(px, side.x + side.dx * i, side.y + side.dy * i)
      if (sample === null) break
      // A box a pixel or two loose is not a stroke — walk in until the shape starts.
      if (run.length === 0 && sameColor(sample, outside, tolerance)) continue
      const blend = blendOf(sample, outside, inside)
      // On the line: this is the fill's own soft edge, so the shape has no stroke.
      if (blend === null || blend.off <= tolerance) break
      run.push(sample)
    }
    // A stroke has a WIDTH, so a run that fills the entire budget is not one —
    // it is a flat region that happens to sit against the shape. The real case:
    // a nav bar's selected-tab highlight is a large flat block, and a node whose
    // bounds start just below it reported an 8px border that did not exist. Look
    // one pixel past the budget and, if the run simply keeps going, refuse the
    // side rather than reporting the budget as if it were a measurement.
    if (run.length === maxWidth) {
      const beyond = pxAt(px, side.x + side.dx * maxWidth, side.y + side.dy * maxWidth)
      const blend = beyond === null ? null : blendOf(beyond, outside, inside)
      const continues = beyond !== null && blend !== null && blend.off > tolerance &&
        sameColor(beyond, run[run.length - 1], tolerance)
      if (continues) {
        perSide[side.name] = 0
        continue
      }
    }
    // A stroke is one flat colour. A ramp just outside the shape is a shadow, and
    // counting it as a stroke would put a border on every raised card. The
    // outermost pixel is excluded because it may be the stroke's own soft edge.
    const inner = run.slice(1)
    const flat = run.length > 0 && inner.every((color) => sameColor(color, inner[0], tolerance))
    perSide[side.name] = flat ? run.length : 0
    if (flat) {
      widths.push(run.length)
      for (const color of run) histogramAdd(buckets, color, 8)
      samples += run.length
    }
  }
  if (widths.length === 0) return { width: 0, color: null, hex: null, perSide, uniform: true }
  const width = Math.round(median(widths))
  const best = histogramBest(buckets, samples)
  return {
    width,
    color: best?.color ?? null,
    hex: best === null ? null : toHex(best.color),
    perSide,
    uniform: widths.every((value) => value === widths[0]),
  }
}

/**
 * The drop shadow around a shape: how far it reaches, and how far it is pushed
 * off centre. A shadow is normally offset downward, so the vertical asymmetry
 * between the extent above and below the shape IS the offset — which is enough
 * to say "this is an elevated card" without knowing the elevation in dp.
 *
 * The surround is sampled BEYOND the shadow's reach rather than just outside the
 * shape. A ring drawn next to a shadowed card lands inside the shadow, and the
 * extractor would then measure the shadow against itself and find nothing.
 *
 * Returns `{ spread: 0 }` for a flat shape. Very soft shadows (a few levels of
 * difference, spread over many pixels) fall under the tolerance and are missed —
 * reported as flat rather than guessed at.
 *
 * KNOWN LIMIT, measured not assumed: a shape whose FILL ramps toward the page —
 * a gradient card — is indistinguishable from a shadow here, and reports one. A
 * gradient is a ramp, which is exactly what the test below looks for, and no
 * local pixel rule separates the two: both are "the colour slides smoothly from
 * the element to the page". A box inside such a shape measured 20px of shadow
 * that was not there. Telling them apart needs the shape's own boundary, which
 * is the thing `shapeEdges` cannot supply once a shadow is present.
 */
export function elevationOf(px, box, { surround = null, tolerance = 4, maxSpread = 32 } = {}) {
  // Measured from the element's OWN bounds. `shapeEdges` would fold the shadow
  // into the shape (it differs from the page by more than the tolerance) and
  // then find nothing beyond it — a shadowed card would report as flat.
  const edges = boxOf(box, px)
  if (edges.width < 2 || edges.height < 2) return null
  const beyond = {
    left: edges.left - maxSpread,
    top: edges.top - maxSpread,
    right: edges.right + maxSpread,
    bottom: edges.bottom + maxSpread,
  }
  const outside = (surround ?? surroundColor(px, beyond, { depth: 3 })?.color) ?? null
  if (outside === null) return null
  const inside = dominantColor(px, edges)?.color ?? null
  // A pixel matching the shape's own fill is not depth, whatever the box says.
  // Belt and braces: for a FLAT fill the ramp test below already rejects the run
  // (its distance from the page never changes), so removing this clause changes
  // no answer — `test/mutate.mjs` proved that by removing it and watching every
  // check stay green. It earns its place only for a fill that is flat near the
  // box and ramps further out, which the ramp test would let through.
  const shadowed = (color) =>
    colorDistance(color, outside) > tolerance && (inside === null || colorDistance(color, inside) > tolerance)

  const reach = (x, y, dx, dy) => {
    const run = []
    for (let i = 1; i <= maxSpread; i++) {
      const sample = pxAt(px, x + dx * i, y + dy * i)
      if (sample === null) break
      // The shadow ends at the first pixel that is the page again — or that is
      // something else entirely, which is why the walk stops rather than
      // remembering the furthest dark pixel it ever saw.
      if (!shadowed(sample)) break
      run.push(sample)
    }
    if (run.length < 2) return 0
    // A shadow is a RAMP: the farther from the shape, the closer to the page. A
    // neighbouring element also differs from the page, but it is FLAT, so without
    // this test every element that happens to sit near a differently-coloured one
    // reports a shadow it does not have.
    let closer = 0
    for (let i = 1; i < run.length; i++) {
      if (colorDistance(run[i], outside) < colorDistance(run[i - 1], outside)) closer += 1
    }
    if (closer < Math.max(1, Math.floor((run.length - 1) * 0.6))) return 0
    return run.length
  }
  const midX = Math.floor((edges.left + edges.right) / 2)
  const midY = Math.floor((edges.top + edges.bottom) / 2)
  const perSide = {
    top: reach(midX, edges.top, 0, -1),
    bottom: reach(midX, edges.bottom - 1, 0, 1),
    left: reach(edges.left, midY, -1, 0),
    right: reach(edges.right - 1, midY, 1, 0),
  }
  const spread = Math.max(...Object.values(perSide))
  if (spread === 0) return { spread: 0, offsetX: 0, offsetY: 0, perSide }
  return {
    spread,
    offsetX: Math.round(((perSide.right - perSide.left) / 2) * 10) / 10,
    offsetY: Math.round(((perSide.bottom - perSide.top) / 2) * 10) / 10,
    perSide,
  }
}

