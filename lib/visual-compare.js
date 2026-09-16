/**
 * dsh-mobilecode — visual comparison core (pure, dependency-free).
 *
 * Operates on decoded RGBA frames ({width, height, rgba:Uint8ClampedArray|Buffer}).
 * Decoding is the CALLER's boundary: the browser canvas for the GUI, test
 * fixtures for headless checks. The plugin server never pixel-decodes, so no
 * image library is added to the base plugin.
 *
 * Two modes, kept SEPARATE by design (they answer different questions and
 * must never share a single pass/fail threshold):
 *  - regression:        same environment, approved native baseline vs current.
 *                       Absolute pixel diff is meaningful here.
 *  - design-reference:  implementation vs design target image. Pixel equality
 *                       is NOT expected (different renderer, font stack,
 *                       typography metrics) — this reports structure and
 *                       regions, it does not grade a score.
 *
 * Findings are concrete (regions that changed, where, by how much); no
 * "UI quality 98/100" anywhere. OCR corroboration is passed IN as boxes by
 * the caller — disagreement between observers is reported, never averaged.
 */

/** RGBA L1 distance > per-channel threshold counts as a changed pixel. */
export function diffFrames(a, b, { threshold = 24, masks = [], skip = [] } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    // Frames of different sizes cannot be diffed as-is: the caller must align
    // (record explicit transform) or this is honestly blocked, not approximated.
    return { status: "blocked", reason: `frame size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height} — align first`, changedPixels: 0, totalPixels: 0 }
  }
  const w = a.width, h = a.height
  const skipAll = [...masks, ...skip]
  let changed = 0
  const marks = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0
    if (skipAll.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue
    const p = i * 4
    const d = Math.abs(a.rgba[p] - b.rgba[p]) + Math.abs(a.rgba[p + 1] - b.rgba[p + 1]) + Math.abs(a.rgba[p + 2] - b.rgba[p + 2]) + Math.abs(a.rgba[p + 3] - b.rgba[p + 3])
    if (d > threshold) { changed += 1; marks[i] = 1 }
  }
  const total = w * h - skipAll.reduce((acc, r) => acc + r.width * r.height, 0)
  const filterStats = { droppedClusters: 0, droppedPixels: 0 }
  const clusters = clusterMarks(marks, w, h, 40, filterStats)
  return {
    status: "ok",
    changedPixels: changed,
    totalPixels: Math.max(total, 1),
    changePct: Number(((changed / Math.max(total, 1)) * 100).toFixed(3)),
    threshold,
    clusters, // [{x,y,width,height,pixels}] — VISUALIZATION only
    // The verdict (changedPixels) is INDEPENDENT of cluster filtering: small
    // clusters dropped below minPixels never hide a change from regression.
    clusterFilter: { minPixels: 40, ...filterStats },
  }
}

/** Connected components (4-neighbour flood fill) over changed-pixel marks. */
export function clusterMarks(marks, w, h, minPixels = 40, stats = null) {
  const seen = new Uint8Array(w * h)
  const clusters = []
  const stack = new Int32Array(w * h)
  for (let start = 0; start < w * h; start++) {
    if (!marks[start] || seen[start]) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    let minX = w, minY = h, maxX = 0, maxY = 0, pixels = 0
    while (top > 0) {
      const i = stack[--top]
      const x = i % w, y = (i / w) | 0
      pixels += 1
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (x > 0 && marks[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1 }
      if (x < w - 1 && marks[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1 }
      if (y > 0 && marks[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w }
      if (y < h - 1 && marks[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w }
    }
    if (pixels >= minPixels) clusters.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels })
    else if (stats) { stats.droppedClusters += 1; stats.droppedPixels += pixels }
  }
  clusters.sort((p, q) => q.pixels - p.pixels)
  return clusters.slice(0, 50)
}

/**
 * Explicit alignment transform (recorded, never baked into stored images).
 * Output-space contract: out(x,y) samples in((x-dx)/scaleX,(y-dy)/scaleY).
 * dx/dy are output-space offsets — THE SAME transform the panel must render
 * (audit §3: displayed overlay and computed diff share one contract).
 */
export function applyAlign(frame, { scaleX = 1, scaleY = 1, dx = 0, dy = 0 } = {}) {
  if (scaleX === 1 && scaleY === 1 && dx === 0 && dy === 0) return frame
  const w = Math.max(1, Math.round(frame.width * scaleX) + Math.abs(dx))
  const h = Math.max(1, Math.round(frame.height * scaleY) + Math.abs(dy))
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y - dy) / scaleY)
    if (sy < 0 || sy >= frame.height) continue
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x - dx) / scaleX)
      if (sx < 0 || sx >= frame.width) continue
      const t = (y * w + x) * 4
      const s = (sy * frame.width + sx) * 4
      out[t] = frame.rgba[s]; out[t + 1] = frame.rgba[s + 1]; out[t + 2] = frame.rgba[s + 2]; out[t + 3] = frame.rgba[s + 3]
    }
  }
  return { width: w, height: h, rgba: out, align: { scaleX, scaleY, dx, dy } }
}

/**
 * Map a region from ALIGNED comparison space back to the ORIGINAL frame's
 * pixel space, so reported findings are reviewable on stored originals.
 */
export function mapRegionToFrame(region, { scaleX = 1, scaleY = 1, dx = 0, dy = 0 } = {}) {
  const r = (v) => Math.max(0, Math.round(v))
  return {
    x: r((region.x - dx) / scaleX), y: r((region.y - dy) / scaleY),
    width: Math.max(1, r(region.width / scaleX)), height: Math.max(1, r(region.height / scaleY)),
  }
}

/** Integer box-average downsample — simulates a canvas reduction; used by tests to PROVE reduced-resolution diffs can lose real changes. */
export function boxAverage(frame, factor) {
  const f = Math.max(1, Math.round(factor))
  const w = Math.max(1, Math.floor(frame.width / f))
  const h = Math.max(1, Math.floor(frame.height / f))
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0
    for (let yy = y * f; yy < Math.min((y + 1) * f, frame.height); yy++) for (let xx = x * f; xx < Math.min((x + 1) * f, frame.width); xx++, n++) {
      const p = (yy * frame.width + xx) * 4
      r += frame.rgba[p]; g += frame.rgba[p + 1]; b += frame.rgba[p + 2]; a += frame.rgba[p + 3]
    }
    const t = (y * w + x) * 4
    out[t] = r / n; out[t + 1] = g / n; out[t + 2] = b / n; out[t + 3] = a / n
  }
  return { width: w, height: h, rgba: out }
}

/** Masks are opt-in exclusions with a REQUIRED documented reason — no silent masking (audit §2). */
export function validateMasks(masks) {
  return (masks ?? []).map((m, i) => {
    if (!m || typeof m !== "object") throw new Error(`mask ${i}: must be an object`)
    if (typeof m.reason !== "string" || m.reason.trim() === "") throw new Error(`mask ${i}: a documented reason is required (masks hide defects — never adjust them to make a comparison pass)`)
    for (const k of ["x", "y", "width", "height"]) if (typeof m[k] !== "number" || !Number.isFinite(m[k]) || m[k] < 0) throw new Error(`mask ${i}: ${k} must be a non-negative number`)
    return { x: m.x | 0, y: m.y | 0, width: m.width | 0, height: m.height | 0, reason: m.reason.trim().slice(0, 500) }
  })
}

/**
 * Corroborate clusters against OCR text boxes passed in by the caller.
 * Reports DISAGREEMENT explicitly: changed pixels with no text, text with no
 * change — evidence to look at, not averaged truth.
 */
export function ocrCorroboration(clusters, ocrBoxes = []) {
  const inCluster = (box) => clusters.some((c) =>
    box.x < c.x + c.width && box.x + box.width > c.x && box.y < c.y + c.height && box.y + box.height > c.y)
  return {
    textInChangedRegions: ocrBoxes.filter(inCluster).map((b) => b.text ?? "(unlabeled)"),
    changedRegionsWithoutText: clusters.filter((c) => !ocrBoxes.some((b) => inCluster([{ ...b }]) &&
      b.x < c.x + c.width && b.x + b.width > c.x && b.y < c.y + c.height && b.y + b.height > c.y)).length,
    note: "disagreements listed; never averaged into a single score",
  }
}

/** Unified result envelope — status is about the OPERATION, never a verdict on UI quality. */
export function compareEnvelope({ runId, project, screen, stateId, mode, diff, observations = [], evidenceRefs = [], env = {}, comparisonSpace = "native", transforms = null, limitations = [] }) {
  if (mode !== "regression" && mode !== "design-reference") throw new Error('mode must be "regression" | "design-reference"')
  if (comparisonSpace !== "native" && comparisonSpace !== "downsampled") throw new Error('comparisonSpace must be "native" | "downsampled"')
  let checkStatus
  if (diff.status === "blocked") checkStatus = "blocked"
  else if (mode === "regression") {
    // A REDUCED-resolution comparison can never prove native pixel equality
    // (downsampling can erase small changes) — it is triage, needs_review at best.
    if (diff.changedPixels > 0) checkStatus = "failed"
    else checkStatus = comparisonSpace === "native" ? "passed" : "needs_review"
  } else checkStatus = "needs_review"
  return {
    runId, project, screen, stateId, mode,
    operation: diff.status === "blocked" ? "blocked" : "completed",
    checkStatus,
    comparisonSpace,
    transforms: transforms ?? undefined,
    diff,
    observations, // [{source, finding}] — concrete observations only
    evidenceRefs,
    env,
    limitations: [
      ...(mode === "design-reference" ? ["design-reference mode compares structure, not pixels; renderer and typography differ by nature"] : []),
      ...(comparisonSpace === "downsampled" ? ["reduced-resolution comparison is triage only — it CANNOT establish native pixel equality (small changes may be erased); run full-resolution regression for a passed verdict"] : []),
      ...limitations,
    ],
    note: "tool ran; this is NOT a visual pass. regression (native): any changed pixel fails; masks require documented reasons and are shown in review, never adjusted to hide defects. design-reference: human/critic review required.",
  }
}
