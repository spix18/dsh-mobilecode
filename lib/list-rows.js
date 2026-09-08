/**
 * dsh-mobilecode — list/feed row detection for the semantic UI tools.
 *
 * Port of ZSeven-W/dsh-android (MIT) src/list-rows.ts: reads the flattened
 * uiautomator node tree and detects visible list/feed ROWS — runs of >=3
 * sibling subtrees of one parent that share a class and near-equal height —
 * then aggregates each row's distinct labels and parses generic counters
 * (e.g. "3万 粉丝", "1.2k likes") out of them.
 *
 * A row is only ever EVIDENCE of repetition: Android has no "Cell" type to
 * key off, so MIN_REPEATED_ROWS = 3 (one more than the iOS twin's 2) with a
 * height tolerance of max(8px, 15% of the shorter sibling). Rows shorter than
 * 16px are dividers, rows taller than 90% of the screen are pages.
 *
 * Everything here is pure (no adb, no DOM), so the offline suite drives the
 * clustering, the counter grammar and the tap planning with XML fixtures.
 */

import { isOffscreenBounds } from "./uitree.js"

/** A run must repeat at least this many times to be a row. */
export const MIN_REPEATED_ROWS = 3
/** Height tolerance floor (px) for "near-equal" siblings. */
export const HEIGHT_TOLERANCE_PX = 8
/** Height fraction of the shorter sibling added to the tolerance. */
export const HEIGHT_TOLERANCE_FRACTION = 0.15
/** Rows this short are dividers, not data. */
export const DIVIDER_MAX_HEIGHT_PX = 16
/** Rows taller than this fraction of the screen are pages. */
export const PAGE_MAX_HEIGHT_FRACTION = 0.9

/** Number → multiplier tokens the counter grammar accepts (中/EN units). */
const COUNTER_MULTIPLIERS = { 万: 1e4, 亿: 1e8, w: 1e4, W: 1e4, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }
/** Characters that end a counter classifier token. */
const COUNTER_TERMINATORS = "。；;！!？?：:…—–·•·。，,、【】「」『』()（）{}[]<>《》\"'“”‘’"

export function isRowLike(bounds) {
  if (bounds.w <= 0 || bounds.h <= 0) return false
  if (bounds.h < DIVIDER_MAX_HEIGHT_PX) return false
  return true
}

/** Near-equal height test with the 8px/15% tolerance (dsh-android rule). */
export function heightsAlike(a, b) {
  const tolerance = Math.max(HEIGHT_TOLERANCE_PX, Math.min(a, b) * HEIGHT_TOLERANCE_FRACTION)
  return Math.abs(a - b) <= tolerance
}

/**
 * Cluster sibling subtrees under one parent into repeated-row runs. Returns an
 * array of runs; each run is an array of node children that are consecutive
 * siblings sharing one type and near-equal height.
 */
export function clusterSiblings(children) {
  if (!Array.isArray(children) || children.length === 0) return []
  const byType = new Map()
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i]
    const key = node.type ?? "Node"
    const list = byType.get(key)
    if (list) list.push(node)
    else byType.set(key, [node])
  }
  const runs = []
  for (const sameType of byType.values()) {
    sameType.sort((l, r) => l.bounds.y - r.bounds.y || l.bounds.x - r.bounds.x)
    let run = [sameType[0]]
    for (let i = 1; i < sameType.length; i += 1) {
      const previous = run[run.length - 1]
      if (heightsAlike(previous.bounds.h, sameType[i].bounds.h)) {
        run.push(sameType[i])
      } else {
        if (run.length >= MIN_REPEATED_ROWS) runs.push(run)
        run = [sameType[i]]
      }
    }
    if (run.length >= MIN_REPEATED_ROWS) runs.push(run)
  }
  // Yield the largest runs first (stable): bigger rows are more likely the
  // list; the caller collapses nested runs to the outermost.
  return runs.sort((l, r) => r.length - l.length)
}

/** True when `outer` strictly contains `inner` (bounds-inside-bounds). */
export function strictlyContains(outer, inner) {
  return (
    outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.w >= inner.x + inner.w
    && outer.y + outer.h >= inner.y + inner.h
  )
}

/** Every label (text or content-desc) under a subtree, in document order. */
function subtreeLabels(node, out = []) {
  if (node.text !== undefined && node.text !== "") out.push(node.text)
  if (node.contentDesc !== undefined && node.contentDesc !== "") out.push(node.contentDesc)
  for (const child of node.children ?? []) subtreeLabels(child, out)
  return out
}

/** Distinct labels in first-seen order, joined with spaces (row title text). */
export function aggregateRowLabel(rowNode) {
  const seen = new Set()
  const parts = []
  for (const label of subtreeLabels(rowNode)) {
    if (!seen.has(label)) {
      seen.add(label)
      parts.push(label)
    }
  }
  return parts.join(" ")
}

/** Normalize a counter key the way verification compares them. */
export function normalizeCountKey(key) {
  return key
    .replace(/\u00a0/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Generic counter grammar over a label: "3万 粉丝" → {key:"粉丝", value:30000},
 * "1.2k likes" → {key:"likes", value:1200}, "42" (bare) → skipped. Also skips
 * digit-suffix serials like "1A215" (the trailing-digit guard).
 */
export function parseCounters(label) {
  const rule = new RegExp(
    `(\\d[\\d,]*(?:\\.\\d+)?)\\s*([万亿wmWkKmM]?)\\s*([^\\d${escapeRegExp(COUNTER_TERMINATORS)}]+)(?!\\d)`,
    "gu",
  )
  const counters = []
  const seen = new Set()
  for (const match of label.matchAll(rule)) {
    const number = Number.parseFloat(match[1].replace(/,/g, ""))
    if (!Number.isFinite(number)) continue
    const multiplier = COUNTER_MULTIPLIERS[match[2]] ?? 1
    const rawKey = match[3].trim()
    if (rawKey === "") continue
    const key = normalizeCountKey(rawKey)
    if (seen.has(key)) continue
    seen.add(key)
    counters.push({ key, value: number * multiplier, raw: match[0].trim() })
  }
  return counters
}

/** True when a subtree is fully outside the screen bounds. */
export function rowOffscreen(node, screen) {
  if (screen === undefined) return false
  return isOffscreenBounds(node.bounds, screen)
}

export function rowIsPage(rowNode, screen) {
  if (screen === undefined) return false
  return rowNode.bounds.h > screen.height * PAGE_MAX_HEIGHT_FRACTION
}

/**
 * Detect list/feed rows across the whole tree. Returns {rows, omittedOffscreen}
 * where each row is {index, group, frame, label, counters, node}:
 *   - index: 0-based, document order (y then x);
 *   - group: an id shared by isomorphic rows (parent bounds + type);
 *   - frame: the row's pixel box {x,y,w,h};
 *   - label: the aggregated distinct label text;
 *   - counters: parsed {key, value, raw} entries.
 * Nested runs collapse to the OUTERMOST candidate; same-frame duplicates
 * collapse; off-screen recycled views are counted, not emitted.
 */
export function detectRows(roots, screen) {
  // Collect candidate runs from every parent. Parents precede their children
  // in the walk, so nested candidates are found after their outer run.
  const candidates = []
  const walk = (node) => {
    if (Array.isArray(node.children) && node.children.length > 0) {
      for (const run of clusterSiblings(node.children)) {
        // The run's frame is the union of its items' boxes.
        const frame = run.reduce(
          (acc, item) => ({
            x: Math.min(acc.x, item.bounds.x),
            y: Math.min(acc.y, item.bounds.y),
            w: Math.max(acc.w, item.bounds.x + item.bounds.w - Math.min(acc.x, item.bounds.x)),
            h: Math.max(acc.h, item.bounds.y + item.bounds.h - Math.min(acc.y, item.bounds.y)),
          }),
          { x: Infinity, y: Infinity, w: 0, h: 0 },
        )
        candidates.push({ run, frame })
      }
      for (const child of node.children) walk(child)
    }
  }
  for (const root of roots) walk(root)

  // Collapse nested runs to the OUTERMOST candidate (a row inside a row is one
  // row); collapse same-frame duplicates; drop page-sized candidates. Runs are
  // sorted longest-first with parents before children, so an outer run is
  // already kept when its inner run is examined.
  const kept = []
  for (const candidate of candidates.sort((l, r) => r.run.length - l.run.length)) {
    if (kept.some((other) => strictlyContains(other.frame, candidate.frame))) continue
    if (kept.some((other) => other.frame.x === candidate.frame.x && other.frame.y === candidate.frame.y
      && other.frame.w === candidate.frame.w && other.frame.h === candidate.frame.h)) continue
    if (screen !== undefined && rowIsPage(candidate.run[0], screen)) continue
    kept.push(candidate)
  }

  // Order rows y-then-x, assign index/group/label/counters.
  const flattened = []
  for (const candidate of kept) {
    for (const node of candidate.run) flattened.push({ node })
  }
  flattened.sort((l, r) => l.node.bounds.y - r.node.bounds.y || l.node.bounds.x - r.node.bounds.x)
  const groupById = new Map()
  let nextGroup = 0
  const rowFrame = (node) => ({ x: node.bounds.x, y: node.bounds.y, w: node.bounds.w, h: node.bounds.h })
  const rows = []
  let omittedOffscreen = 0
  for (const entry of flattened) {
    if (screen !== undefined && rowOffscreen(entry.node, screen)) { omittedOffscreen += 1; continue }
    const node = entry.node
    const groupKey = `${node.type}|${node.bounds.w}x${node.bounds.h}`
    if (!groupById.has(groupKey)) groupById.set(groupKey, nextGroup++)
    const label = aggregateRowLabel(node)
    rows.push({
      index: rows.length,
      group: groupById.get(groupKey),
      frame: rowFrame(node),
      label,
      counters: parseCounters(label),
    })
  }
  return { rows, omittedOffscreen }
}

/**
 * Plan a pixel tap inside row `index` at relative (0..1) x/y of the row frame.
 * Out-of-range indices REFUSE (never clamp — a stale rows list must not tap
 * the wrong control). Returns absolute pixel coordinates for `input tap`.
 */
export function planRowTap(rows, index, fractionX, fractionY) {
  const row = rows[index]
  if (row === undefined) {
    throw new Error(
      `row ${index} does not exist — the list shows ${rows.length} row${rows.length === 1 ? "" : "s"} now. Re-run device_ui_rows for fresh indices.`,
    )
  }
  if (!(fractionX >= 0 && fractionX <= 1 && fractionY >= 0 && fractionY <= 1)) {
    throw new Error(`row-relative x,y must be in 0..1 (got ${fractionX},${fractionY})`)
  }
  return {
    x: Math.round(row.frame.x + fractionX * row.frame.w),
    y: Math.round(row.frame.y + fractionY * row.frame.h),
  }
}

/**
 * Expect-count verification: BEFORE a tap the key must already exist in the
 * row's counters ("never probe a control"). After the tap + settle, the row is
 * re-detected by index and the count must have changed by EXACTLY delta (1|-1),
 * guarded by a frame-drift check so a reordered list never validates.
 */
export function verifyCountChange(beforeRow, afterRow, key, delta) {
  if (beforeRow === undefined) return { verified: false, reason: "before-tap row is missing" }
  if (afterRow === undefined) return { verified: false, reason: "row not found after the tap (list may have changed)" }
  const before = beforeRow.counters.find((counter) => counter.key === key)
  const after = afterRow.counters.find((counter) => counter.key === key)
  if (before === undefined) return { verified: false, reason: `counter "${key}" absent from the row before the tap` }
  if (after === undefined) return { verified: false, reason: `counter "${key}" disappeared after the tap` }
  if (Math.abs(after.value - before.value) > Math.max(1, Math.abs(before.value) * 0.05)) {
    return { verified: false, reason: `counter "${key}" moved by ${after.value - before.value} (expected ${delta})` }
  }
  if (after.value !== before.value + delta) {
    return { verified: false, reason: `counter "${key}" moved by ${after.value - before.value} (expected ${delta})` }
  }
  return { verified: true, before: before.value, after: after.value }
}

/**
 * Drift guard for row-list verification: the row at the same index must sit at
 * the same screen position after the tap, or the list reordered and the
 * counters are no longer comparable. Tolerance: max(8px, 25% of the row height)
 * on the y offset — the dsh-android rows-stayed-put rule.
 */
export function rowsStayedPut(beforeRow, afterRow) {
  if (beforeRow === undefined || afterRow === undefined) return false
  const tolerance = Math.max(8, beforeRow.frame.h * 0.25)
  return Math.abs(afterRow.frame.y - beforeRow.frame.y) <= tolerance
    && Math.abs(afterRow.frame.x - beforeRow.frame.x) <= tolerance
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}