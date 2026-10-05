/**
 * dsh-mobilecode — pixel-analysis checks.
 *
 * Every extractor in lib/pixels.js is a pure function of an RGBA buffer, so its
 * ground truth is SYNTHESIZABLE: draw a shape whose geometry and colour are
 * known by construction, then assert the extractor recovers them. No device, no
 * emulator, no screencap — which is the only reason a pixel layer can be proven
 * rather than eyeballed.
 *
 * The canvas helpers below are part of the fixture, so they are validated first:
 * a wrong fixture would make every extractor test downstream meaningless.
 *
 * Run: node test/pixels.mjs
 */
import assert from "node:assert/strict"
import * as Px from "../lib/pixels.js"

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

// --- synthetic canvas ------------------------------------------------------

const setPx = (px, x, y, color) => {
  if (x < 0 || y < 0 || x >= px.width || y >= px.height) return
  const i = (y * px.width + x) * 4
  px.rgba[i] = color.r
  px.rgba[i + 1] = color.g
  px.rgba[i + 2] = color.b
  px.rgba[i + 3] = color.a ?? 255
}

const canvas = (width, height, fill) => {
  const px = { width, height, rgba: Buffer.alloc(width * height * 4) }
  if (fill) fillRect(px, { x: 0, y: 0, w: width, h: height }, fill)
  return px
}

const fillRect = (px, box, color) => {
  const b = Px.boxOf(box, px)
  for (let y = b.top; y < b.bottom; y++) for (let x = b.left; x < b.right; x++) setPx(px, x, y, color)
}

/**
 * Rounded rect by signed distance: clamp the point into the inner rect
 * `[left+r, right-r] × [top+r, bottom-r]`, and it is inside when it is within
 * `r` of that clamped point. `r = 0` degenerates to a plain rect.
 */
const insideRound = (x, y, b, r) => {
  const cx = Math.min(Math.max(x, b.left + r), b.right - r)
  const cy = Math.min(Math.max(y, b.top + r), b.bottom - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

const fillRoundedRect = (px, box, radius, color) => {
  const b = Px.boxOf(box, px)
  const r = Math.min(radius, b.width / 2, b.height / 2)
  for (let y = b.top; y < b.bottom; y++) {
    for (let x = b.left; x < b.right; x++) {
      if (insideRound(x + 0.5, y + 0.5, b, r)) setPx(px, x, y, color)
    }
  }
}

/**
 * The x-extent of the rounded rect at a given y, or null outside it. Exact in x,
 * which is the point: at a corner the shape is bounded by an arc, and a sliver
 * of coverage can be a hundredth of a pixel wide. A supersampling fixture misses
 * that unless it uses 32x32 sub-points (and then still only sometimes), while an
 * exact x-span catches it at any sampling density in y.
 */
const spanAt = (y, b, r) => {
  if (y < b.top || y > b.bottom) return null
  const dy = Math.min(Math.max(y, b.top + r), b.bottom - r)
  const dx = r > 0 ? Math.sqrt(Math.max(0, r * r - (y - dy) * (y - dy))) : 0
  return [b.left + r - dx, b.right - r + dx]
}

const coverageAt = (x, y0, y1, b, r, steps = 64) => {
  let covered = 0
  for (let s = 0; s < steps; s++) {
    const y = y0 + ((s + 0.5) * (y1 - y0)) / steps
    const span = spanAt(y, b, r)
    if (span === null) continue
    const lo = Math.max(x, span[0])
    const hi = Math.min(x + 1, span[1])
    if (hi > lo) covered += hi - lo
  }
  return covered / steps
}

/**
 * The same shape, anti-aliased: each pixel is blended with whatever was already
 * there by its true covered fraction. This is what a real Android screencap
 * looks like, and it is the only fixture that can exercise the sub-pixel path —
 * a hard-edged buffer would leave that code untested and silently report a
 * quantized answer.
 */
const fillRoundedRectAA = (px, box, radius, color) => {
  const b = Px.boxOf(box, px)
  const r = Math.min(radius, b.width / 2, b.height / 2)
  for (let y = b.top; y < b.bottom; y++) {
    for (let x = b.left; x < b.right; x++) {
      const coverage = coverageAt(x, y, y + 1, b, r)
      if (coverage <= 0) continue
      const base = Px.pxAt(px, x, y)
      setPx(px, x, y, {
        r: Math.round(color.r * coverage + base.r * (1 - coverage)),
        g: Math.round(color.g * coverage + base.g * (1 - coverage)),
        b: Math.round(color.b * coverage + base.b * (1 - coverage)),
        a: 255,
      })
    }
  }
}

const mix = (a, b, t) => ({
  r: Math.round(a.r * (1 - t) + b.r * t),
  g: Math.round(a.g * (1 - t) + b.g * t),
  b: Math.round(a.b * (1 - t) + b.b * t),
  a: 255,
})

/**
 * A line of glyph-like bars: `stroke` wide, `glyphHeight` tall, every `advance`
 * pixels. With `fringe` the columns either side are blended halfway toward the
 * ink, which is what a real renderer's anti-aliasing looks like from the side.
 */
const drawText = (px, box, { color, glyphHeight, advance = 8, stroke = 3, fringe = false }) => {
  const b = Px.boxOf(box, px)
  for (let x = b.left; x + stroke <= b.right; x += advance) {
    fillRect(px, { x, y: b.top, w: stroke, h: glyphHeight }, color)
    if (!fringe) continue
    for (let y = b.top; y < b.top + glyphHeight; y++) {
      const left = Px.pxAt(px, x - 1, y)
      const right = Px.pxAt(px, x + stroke, y)
      if (left !== null) setPx(px, x - 1, y, mix(left, color, 0.5))
      if (right !== null) setPx(px, x + stroke, y, mix(right, color, 0.5))
    }
  }
}

const rgb = (r, g, b, a = 255) => ({ r, g, b, a })
const BLACK = rgb(0, 0, 0)
const WHITE = rgb(255, 255, 255)

// --- the fixture proves itself ---------------------------------------------

ok("the canvas draws a plain rect edge to edge", () => {
  const px = canvas(20, 20, WHITE)
  fillRect(px, { x: 2, y: 3, w: 4, h: 5 }, BLACK)
  assert.deepEqual(Px.pxAt(px, 2, 3), BLACK, "top-left of the rect must be filled")
  assert.deepEqual(Px.pxAt(px, 5, 7), BLACK, "bottom-right of the rect must be filled")
  assert.deepEqual(Px.pxAt(px, 6, 3), WHITE, "one past the right edge must be untouched")
  assert.deepEqual(Px.pxAt(px, 2, 8), WHITE, "one past the bottom edge must be untouched")
  assert.deepEqual(Px.pxAt(px, 1, 2), WHITE, "one before the top-left must be untouched")
})

ok("a rounded rect with radius 0 fills its corners; a large radius empties them", () => {
  const square = canvas(40, 40, WHITE)
  fillRoundedRect(square, { x: 0, y: 0, w: 40, h: 40 }, 0, BLACK)
  assert.deepEqual(Px.pxAt(square, 0, 0), BLACK, "radius 0 must fill the very corner pixel")
  assert.deepEqual(Px.pxAt(square, 39, 39), BLACK, "radius 0 must fill the opposite corner")

  const round = canvas(40, 40, WHITE)
  fillRoundedRect(round, { x: 0, y: 0, w: 40, h: 40 }, 12, BLACK)
  assert.deepEqual(Px.pxAt(round, 0, 0), WHITE, "a 12px radius must leave the corner pixel empty")
  assert.deepEqual(Px.pxAt(round, 2, 2), WHITE, "and the near-corner pixel too")
  assert.deepEqual(Px.pxAt(round, 19, 19), BLACK, "while the centre stays filled")
  assert.deepEqual(Px.pxAt(round, 19, 0), BLACK, "and the top edge midpoint stays filled")
})

// --- colour maths ----------------------------------------------------------

ok("relative luminance spans 0 (black) to 1 (white)", () => {
  assert.equal(Px.relativeLuminance(BLACK), 0)
  assert.equal(Px.relativeLuminance(WHITE), 1)
  // Mid grey is NOT 0.5 — the sRGB transfer curve is the whole point of having
  // this function instead of averaging the channels.
  assert.ok(Math.abs(Px.relativeLuminance(rgb(128, 128, 128)) - 0.2159) < 0.001)
})

ok("contrast ratio hits 21 for black on white and 1 for a colour on itself", () => {
  assert.equal(Px.contrastRatio(BLACK, WHITE), 21)
  assert.equal(Px.contrastRatio(WHITE, BLACK), 21, "the ratio is order-independent")
  assert.equal(Px.contrastRatio(rgb(30, 90, 218), rgb(30, 90, 218)), 1)
})

ok("the 4.5 boundary sits exactly where WCAG says it does", () => {
  // These two greys are the canonical boundary pair: #767676 clears AA on white,
  // #777777 does not. If the transfer curve or the 0.05 offset were wrong, this
  // pair would move — which is why it is the assertion, not a round number.
  const pass = Px.contrastRatio(rgb(0x76, 0x76, 0x76), WHITE)
  const fail = Px.contrastRatio(rgb(0x77, 0x77, 0x77), WHITE)
  assert.ok(Math.abs(pass - 4.5426) < 0.001, `#767676 on white should be 4.5426, got ${pass}`)
  assert.ok(Math.abs(fail - 4.4781) < 0.001, `#777777 on white should be 4.4781, got ${fail}`)
  assert.ok(pass >= 4.5 && fail < 4.5, "the pair must straddle 4.5, not both land on one side")
})

ok("compositing a translucent colour resolves it against its backdrop", () => {
  assert.deepEqual(Px.composite(rgb(0, 0, 0, 128), WHITE), rgb(127, 127, 127))
  assert.deepEqual(Px.composite(rgb(255, 255, 255, 128), BLACK), rgb(128, 128, 128))
  assert.deepEqual(Px.composite(rgb(10, 20, 30, 255), WHITE), rgb(10, 20, 30), "an opaque colour passes through untouched")
})

ok("colour distance is perceptual, not plain Euclidean", () => {
  assert.equal(Px.colorDistance(BLACK, BLACK), 0)
  assert.ok(Px.colorDistance(BLACK, WHITE) > 700, "black to white is the far end of the scale")
  // The property that justifies the weighting: a pure-green step reads as a
  // LARGER change than a pure-blue step of the same numeric size, because the
  // eye resolves green far more finely.
  const blueStep = Px.colorDistance(BLACK, rgb(0, 0, 255))
  const greenStep = Px.colorDistance(BLACK, rgb(0, 255, 0))
  assert.ok(greenStep > blueStep, `green (${greenStep}) must outweigh blue (${blueStep})`)
})

ok("sameColor applies a tolerance instead of demanding equality", () => {
  assert.ok(Px.sameColor(rgb(100, 100, 100), rgb(104, 100, 100)))
  assert.ok(!Px.sameColor(rgb(100, 100, 100), rgb(160, 100, 100)))
  assert.ok(!Px.sameColor(null, rgb(0, 0, 0)), "a missing sample is never 'the same'")
  assert.ok(!Px.sameColor(rgb(0, 0, 0), undefined))
})

ok("toHex renders a colour for logs and reports", () => {
  assert.equal(Px.toHex(rgb(0, 0, 0)), "#000000")
  assert.equal(Px.toHex(rgb(255, 255, 255)), "#ffffff")
  assert.equal(Px.toHex(rgb(170, 87, 13)), "#aa570d")
  assert.equal(Px.toHex(rgb(300, -5, 7.6)), "#ff0008", "out-of-range channels clamp rather than wrap")
})

// --- geometry --------------------------------------------------------------

ok("boxOf accepts both box shapes and clamps to the image", () => {
  const px = canvas(100, 80, WHITE)
  assert.deepEqual(Px.boxOf({ x: 10, y: 20, w: 30, h: 40 }, px), { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 })
  assert.deepEqual(Px.boxOf({ left: 10, top: 20, right: 40, bottom: 60 }, px), { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 })
  // uiautomator reports bounds that hang off the screen; an unclamped read would
  // sample whatever the buffer holds next.
  assert.deepEqual(Px.boxOf({ x: -10, y: -10, w: 30, h: 30 }, px), { left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 })
  assert.deepEqual(Px.boxOf({ x: 90, y: 70, w: 50, h: 50 }, px), { left: 90, top: 70, right: 100, bottom: 80, width: 10, height: 10 })
  assert.deepEqual(Px.boxOf({ x: 500, y: 500, w: 10, h: 10 }, px), { left: 100, top: 80, right: 100, bottom: 80, width: 0, height: 0 }, "a fully off-screen box collapses rather than going negative")
})

ok("pxAt returns null outside the buffer instead of reading a neighbour", () => {
  const px = canvas(10, 10, WHITE)
  assert.deepEqual(Px.pxAt(px, 0, 0), WHITE)
  assert.deepEqual(Px.pxAt(px, 9, 9), WHITE)
  assert.equal(Px.pxAt(px, 10, 0), null)
  assert.equal(Px.pxAt(px, 0, 10), null)
  assert.equal(Px.pxAt(px, -1, 0), null)
  assert.equal(Px.pxAt(px, NaN, 0), null)
})

// --- region colour ---------------------------------------------------------

const TEXT = rgb(20, 20, 20)

ok("dominantColor returns the fill of a flat region", () => {
  const px = canvas(20, 20, WHITE)
  fillRect(px, { x: 5, y: 5, w: 10, h: 10 }, rgb(30, 90, 218))
  const card = Px.dominantColor(px, { x: 5, y: 5, w: 10, h: 10 })
  assert.equal(Px.toHex(card.color), "#1e5ada")
  assert.equal(card.count, 100)
  assert.equal(card.share, 1)
  assert.equal(card.distinct, 1, "a flat fill occupies exactly one bucket")
})

ok("the dominant colour of a text-bearing card is still its background", () => {
  // This is the whole reason for using a mode instead of a mean: glyph pixels
  // are a minority of any surface that carries text, and a mean would drag the
  // reported colour toward the text.
  const px = canvas(80, 40, WHITE)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 30; col++) {
      setPx(px, 12 + col * 2, 12 + row * 5, TEXT)
      setPx(px, 12 + col * 2, 13 + row * 5, TEXT)
    }
  }
  const card = Px.dominantColor(px, { x: 0, y: 0, w: 80, h: 40 })
  assert.equal(Px.toHex(card.color), "#ffffff", "240 glyph pixels must not outvote 2960 background pixels")
  assert.ok(card.share > 0.8, `background should dominate, got share ${card.share}`)
})

ok("a gradient reports a low share over many buckets", () => {
  const px = canvas(64, 16, WHITE)
  for (let x = 0; x < 64; x++) fillRect(px, { x, y: 0, w: 1, h: 16 }, rgb(x * 4, 40, 200))
  const ramp = Px.dominantColor(px, { x: 0, y: 0, w: 64, h: 16 })
  // share/distinct are the honesty channel: a caller that needs a definite fill
  // can see for itself that this region has none.
  assert.ok(ramp.distinct > 8, `a gradient must fill many buckets, got ${ramp.distinct}`)
  assert.ok(ramp.share < 0.1, `no single colour should dominate, got ${ramp.share}`)
})

ok("dominantColor can exclude a colour it already knows", () => {
  const px = canvas(20, 20, WHITE)
  fillRect(px, { x: 5, y: 5, w: 10, h: 10 }, BLACK)
  const all = Px.dominantColor(px, { x: 0, y: 0, w: 20, h: 20 })
  assert.equal(Px.toHex(all.color), "#ffffff")
  const shape = Px.dominantColor(px, { x: 0, y: 0, w: 20, h: 20 }, { skip: WHITE })
  assert.equal(Px.toHex(shape.color), "#000000", "skipping the page leaves the shape behind")
})

ok("surroundColor reads what a box is painted on", () => {
  const px = canvas(60, 60, rgb(253, 253, 255))
  fillRect(px, { x: 10, y: 10, w: 20, h: 20 }, rgb(30, 90, 218))
  const around = Px.surroundColor(px, { x: 10, y: 10, w: 20, h: 20 })
  assert.equal(Px.toHex(around.color), "#fdfdff", "the ring outside the card is the page")
  // The ring is sampled on all four sides, so it must not be dominated by the
  // card colour even though the card is only 3px away.
  assert.ok(around.share > 0.9, `the page should be uniform, got share ${around.share}`)
})

ok("surroundColor admits when there is no surround to measure", () => {
  const px = canvas(40, 40, BLACK)
  assert.equal(Px.surroundColor(px, { x: 0, y: 0, w: 40, h: 40 }), null, "a box filling the image has no outside")
})

ok("shapeEdges finds the painted edge rather than trusting the reported box", () => {
  const px = canvas(60, 60, WHITE)
  fillRect(px, { x: 12, y: 12, w: 20, h: 20 }, BLACK)
  // The reported box is 2px too wide on every side, as a layout-derived bound
  // carrying a margin would be.
  const edges = Px.shapeEdges(px, { x: 10, y: 10, w: 24, h: 24 })
  assert.deepEqual(edges, { left: 12, top: 12, right: 32, bottom: 32, width: 20, height: 20 })
})

ok("shapeEdges returns null when the shape is invisible against its surround", () => {
  const px = canvas(40, 40, WHITE)
  assert.equal(Px.shapeEdges(px, { x: 10, y: 10, w: 20, h: 20 }), null, "a white box on a white page has no edge to find")
})

// --- corner radius ---------------------------------------------------------

const CARD = rgb(30, 90, 218)

ok("cornerRadius recovers a synthesised radius from an anti-aliased render", () => {
  for (const radius of [0, 2, 4, 8, 12, 16, 24]) {
    const px = canvas(80, 80, WHITE)
    fillRoundedRectAA(px, { x: 10, y: 10, w: 60, h: 60 }, radius, CARD)
    const measured = Px.cornerRadius(px, { x: 10, y: 10, w: 60, h: 60 })
    assert.ok(measured !== null, `radius ${radius} must be measurable`)
    assert.ok(
      Math.abs(measured.radius - radius) <= 0.5,
      `radius ${radius} measured as ${measured.radius} (corners ${JSON.stringify(measured.perCorner)})`,
    )
    assert.ok(measured.uniform, `radius ${radius} must agree across corners: ${JSON.stringify(measured.perCorner)}`)
  }
})

ok("cornerRadius uses the sub-pixel path whenever the render carries one", () => {
  const px = canvas(80, 80, WHITE)
  fillRoundedRectAA(px, { x: 10, y: 10, w: 60, h: 60 }, 12, CARD)
  const measured = Px.cornerRadius(px, { x: 10, y: 10, w: 60, h: 60 })
  assert.ok(!measured.aliased, "a genuine blend must not be reported as a hard edge")
  assert.ok(measured.confidence > 0.5, `a sub-pixel estimate should be confident, got ${measured.confidence}`)
  // Why the loop above does not assert this for every radius: at r=24 the corner
  // sliver is 0.0017 of a pixel, so the blend ROUNDS back to the fill colour at
  // 8 bits and there is genuinely nothing left to measure. Reporting `aliased`
  // there is correct — an extractor that claimed sub-pixel precision from a
  // byte-identical pixel would be inventing it.
})

ok("cornerRadius admits when the render was hard-edged", () => {
  const px = canvas(80, 80, WHITE)
  fillRoundedRect(px, { x: 10, y: 10, w: 60, h: 60 }, 12, CARD)
  const measured = Px.cornerRadius(px, { x: 10, y: 10, w: 60, h: 60 })
  assert.ok(measured !== null)
  // Without partial pixels the boundary is only known to the pixel grid, so the
  // answer must carry the diagonal's quantization instead of pretending to a
  // precision it does not have.
  assert.ok(measured.aliased, "a hard edge must be reported as aliased")
  assert.ok(Math.abs(measured.radius - 12) <= 2, `hard-edged 12 measured as ${measured.radius}`)
  assert.ok(measured.confidence <= 0.5, `an aliased estimate must not claim confidence, got ${measured.confidence}`)
})

ok("cornerRadius measures a plain rectangle as zero", () => {
  const px = canvas(60, 60, WHITE)
  fillRect(px, { x: 10, y: 10, w: 40, h: 40 }, CARD)
  const measured = Px.cornerRadius(px, { x: 10, y: 10, w: 40, h: 40 })
  assert.ok(measured !== null)
  assert.equal(measured.radius, 0, "a square corner has no radius to find")
  assert.deepEqual(measured.perCorner, { tl: 0, tr: 0, br: 0, bl: 0 })
})

ok("cornerRadius returns null rather than guessing on an invisible shape", () => {
  const px = canvas(60, 60, WHITE)
  assert.equal(Px.cornerRadius(px, { x: 10, y: 10, w: 40, h: 40 }), null)
})

// --- text ------------------------------------------------------------------

const INK = rgb(60, 60, 60)
const textBox = { x: 10, y: 20, w: 100, h: 20 }

ok("textMetrics reports the ink, the surface and the contrast between them", () => {
  const px = canvas(120, 60, WHITE)
  drawText(px, textBox, { color: INK, glyphHeight: 10 })
  const metrics = Px.textMetrics(px, textBox)
  assert.equal(metrics.hex, "#3c3c3c", "the ink is the text colour")
  assert.equal(metrics.backgroundHex, "#ffffff", "the surface behind it is the background")
  assert.equal(metrics.contrast, Math.round(Px.contrastRatio(INK, WHITE) * 100) / 100, "contrast is WCAG, computed not estimated")
  assert.ok(metrics.contrast > 4.5, "and this pair clears AA")
})

ok("textMetrics reads the solid ink, not the anti-aliased fringe", () => {
  // The whole reason the colour is taken from the extreme cluster: half the
  // glyph-edge pixels here are a 50% blend, and a mean would land in the middle
  // of them — reporting a colour the text never actually is.
  const px = canvas(120, 60, WHITE)
  drawText(px, textBox, { color: INK, glyphHeight: 10, fringe: true })
  const metrics = Px.textMetrics(px, textBox)
  const blend = mix(WHITE, INK, 0.5)
  assert.equal(metrics.hex, "#3c3c3c", "the fringe must not drag the reported colour")
  assert.ok(
    metrics.contrast > Px.contrastRatio(blend, WHITE),
    `contrast must be the ink's, not the fringe's (got ${metrics.contrast})`,
  )
})

ok("textMetrics measures glyph height from the strokes themselves", () => {
  const px = canvas(120, 60, WHITE)
  drawText(px, textBox, { color: INK, glyphHeight: 10 })
  const metrics = Px.textMetrics(px, textBox)
  assert.equal(metrics.glyphHeight, 10, "every stroke is 10 tall, so that is the modal run")
  assert.equal(metrics.maxGlyphHeight, 10)
  assert.equal(metrics.lineCount, 1)
  assert.deepEqual(metrics.bands, [{ top: 20, bottom: 30, height: 10 }])
})

ok("textMetrics separates two lines and measures each", () => {
  const px = canvas(120, 60, WHITE)
  drawText(px, { x: 10, y: 12, w: 100, h: 8 }, { color: INK, glyphHeight: 8 })
  drawText(px, { x: 10, y: 28, w: 100, h: 8 }, { color: INK, glyphHeight: 8 })
  const metrics = Px.textMetrics(px, { x: 10, y: 10, w: 100, h: 40 })
  assert.equal(metrics.lineCount, 2, "an 8px gap between the lines must split them")
  assert.deepEqual(metrics.bands, [
    { top: 12, bottom: 20, height: 8 },
    { top: 28, bottom: 36, height: 8 },
  ])
  assert.equal(metrics.glyphHeight, 8)
})

ok("textMetrics returns null on a surface with no text", () => {
  const px = canvas(120, 60, WHITE)
  assert.equal(Px.textMetrics(px, textBox), null, "a blank surface has no ink to report")
})

// --- border and elevation --------------------------------------------------

const STROKE = rgb(150, 150, 150)
const cardBox = { x: 20, y: 20, w: 60, h: 60 }

ok("borderOf measures a stroke, and its colour", () => {
  const px = canvas(100, 100, WHITE)
  fillRect(px, cardBox, STROKE)
  fillRect(px, { x: 22, y: 22, w: 56, h: 56 }, CARD)
  const border = Px.borderOf(px, cardBox)
  assert.equal(border.width, 2, "the stroke is two pixels on every side")
  assert.deepEqual(border.perSide, { top: 2, bottom: 2, left: 2, right: 2 })
  assert.equal(border.hex, "#969696")
  assert.equal(border.uniform, true)
})

ok("borderOf reports no stroke on a plain filled card", () => {
  const px = canvas(100, 100, WHITE)
  fillRect(px, cardBox, CARD)
  const border = Px.borderOf(px, cardBox)
  assert.equal(border.width, 0, "a hard fill edge is not a stroke")
  assert.equal(border.hex, null)
})

ok("borderOf is not fooled by an anti-aliased edge", () => {
  const px = canvas(100, 100, WHITE)
  fillRect(px, cardBox, CARD)
  // Where a shape lands mid-pixel the outermost ring is a true blend of page and
  // fill. It differs from the fill, so width alone would call it a stroke.
  const soft = mix(WHITE, CARD, 0.5)
  fillRect(px, { x: 20, y: 20, w: 60, h: 1 }, soft)
  fillRect(px, { x: 20, y: 79, w: 60, h: 1 }, soft)
  fillRect(px, { x: 20, y: 20, w: 1, h: 60 }, soft)
  fillRect(px, { x: 79, y: 20, w: 1, h: 60 }, soft)
  const border = Px.borderOf(px, cardBox)
  assert.equal(border.width, 0, "a blend of page and fill lies on their line, so it is an edge")
  assert.equal(border.hex, null)
})

ok("borderOf does not read a shadow ramp as a stroke", () => {
  const px = canvas(140, 140, WHITE)
  const dark = rgb(90, 90, 90)
  // The reported bounds INCLUDE the shadow, which is what a node's bounds look
  // like when the app draws its elevation inside them. Walking in from that edge
  // crosses the ramp before it reaches the card — and a ramp is not a stroke.
  for (let i = 1; i <= 6; i++) fillRect(px, { x: 34, y: 100 + i - 1, w: 72, h: 1 }, mix(dark, WHITE, i / 7))
  fillRect(px, { x: 40, y: 40, w: 60, h: 60 }, CARD)
  const border = Px.borderOf(px, { x: 34, y: 34, w: 72, h: 72 })
  assert.equal(border.width, 0, "a gradient is a shadow, not a border")
})

ok("a flat band that runs past the budget is a region, not a border", () => {
  // The exact colours from a live 1080x2400 emulator. They matter: a nav bar's
  // highlight is only off the blend line because the page and the fill are BOTH
  // near-white and the highlight is not. Against a saturated card it would sit
  // close enough to the line to be dismissed as a soft edge, and the budget
  // would never be reached at all.
  const page = rgb(254, 251, 255)
  const fill = rgb(251, 248, 252)
  const hilite = rgb(228, 234, 252)
  const px = canvas(140, 140, page)
  fillRect(px, { x: 30, y: 60, w: 80, h: 60 }, fill)
  fillRect(px, { x: 30, y: 60, w: 80, h: 20 }, hilite)
  const border = Px.borderOf(px, { x: 30, y: 60, w: 80, h: 60 })
  assert.equal(border.width, 0, "the budget is not a measurement")
})

ok("elevationOf measures a shadow and its downward offset", () => {
  const px = canvas(140, 140, WHITE)
  const card = { x: 40, y: 40, w: 60, h: 60 }
  const dark = rgb(120, 120, 120)
  // A shadow reaching 8px below and 2px above: the asymmetry IS the offset.
  for (let i = 1; i <= 8; i++) fillRect(px, { x: 34, y: 100 + i - 1, w: 72, h: 1 }, mix(dark, WHITE, i / 9))
  for (let i = 1; i <= 2; i++) fillRect(px, { x: 34, y: 40 - i, w: 72, h: 1 }, mix(dark, WHITE, i / 3))
  fillRect(px, card, CARD)
  const elevation = Px.elevationOf(px, card)
  assert.deepEqual(elevation.perSide, { top: 2, bottom: 8, left: 0, right: 0 })
  assert.equal(elevation.spread, 8)
  assert.equal(elevation.offsetY, 3, "(8 below - 2 above) / 2")
  assert.equal(elevation.offsetX, 0)
})

ok("elevationOf reports a flat card as flat", () => {
  const px = canvas(140, 140, WHITE)
  const card = { x: 40, y: 40, w: 60, h: 60 }
  fillRect(px, card, CARD)
  const elevation = Px.elevationOf(px, card)
  assert.equal(elevation.spread, 0)
  assert.equal(elevation.offsetY, 0)
})

ok("a flat fill is not read as depth, however far the walk crosses it", () => {
  const px = canvas(140, 140, WHITE)
  fillRect(px, { x: 40, y: 40, w: 60, h: 60 }, CARD)
  // A box well inside the card. Walking out from it crosses the card's own fill
  // before it ever reaches the page, and fill is not shadow. The RAMP test is
  // what rejects the run here — a flat fill's distance from the page never
  // changes — not the fill check beside it, which is belt and braces.
  const elevation = Px.elevationOf(px, { x: 50, y: 50, w: 20, h: 20 })
  assert.equal(elevation.spread, 0)
})

// KNOWN LIMIT, pinned so it cannot move unnoticed. A gradient fill IS a ramp,
// and a ramp is exactly what a shadow is; no local pixel rule separates the two,
// because both are "the colour slides smoothly from the element to the page".
// This asserts the LIMITATION, not a feature — fix the extractor and invert it.
ok("a gradient fill still reads as a shadow, and this check records that limit", () => {
  const px = canvas(140, 140, WHITE)
  const card = { x: 40, y: 20, w: 60, h: 80 }
  for (let y = card.y; y < card.y + card.h; y++) {
    fillRect(px, { x: card.x, y, w: card.w, h: 1 }, mix(WHITE, CARD, (y - card.y) / (card.h - 1)))
  }
  const elevation = Px.elevationOf(px, { x: 50, y: 41, w: 20, h: 20 })
  assert.equal(elevation.spread, 20, "the gradient limit is narrower or wider than recorded")
})

console.log(`\n${passed} checks passed`)
