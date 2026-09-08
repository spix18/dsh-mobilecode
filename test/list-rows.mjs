/**
 * dsh-mobilecode — offline tests for the 0.7.0 ported helpers: list/feed row
 * detection (lib/list-rows.js, port of ZSeven-W/dsh-android list-rows.ts) and
 * the dumpsys meminfo package parser (pattern credited to dsh-adb-ultimate).
 * Pure functions — no device, no DSH wiring.
 *
 * Run: node test/list-rows.mjs
 */

import assert from "node:assert/strict"
import * as RowList from "../lib/list-rows.js"
import * as DeviceBuild from "../lib/device-build.js"

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

/** Fixture node in our uitree shape: {type, bounds:{x,y,w,h}, text?, children?}. */
const node = (type, x, y, w, h, text, children = []) => ({
  type,
  bounds: { x, y, w, h },
  ...(text !== undefined ? { text } : {}),
  children,
})

const row = (index, title) => node("row", 0, index * 100, 360, 96, undefined, [
  node("label", 8, index * 100 + 12, 200, 40, title),
  node("counter", 8, index * 100 + 56, 200, 32, "3万 粉丝"),
])

console.log("dsh-mobilecode list-rows + meminfo offline tests\n")

console.log("— clusterSiblings —")
ok("five same-type siblings of equal height form one run", () => {
  const run = RowList.clusterSiblings([row(0, "a"), row(1, "b"), row(2, "c"), row(3, "d"), row(4, "e")])
  assert.equal(run.length, 1)
  assert.equal(run[0].length, 5)
})
ok("two same-height siblings are NOT a row (needs >=3)", () => {
  assert.equal(RowList.clusterSiblings([row(0, "a"), row(1, "b")]).length, 0)
})
ok("heights differ by more than the tolerance → split", () => {
  const short = node("row", 0, 0, 360, 60)
  const tall = node("row", 0, 100, 360, 200)
  const short2 = node("row", 0, 300, 360, 61)
  assert.equal(RowList.clusterSiblings([short, tall, short2]).length, 0)
})
ok("heights within tolerance (10% of 96 ≈ 9.6px) stay one run", () => {
  const a = node("row", 0, 0, 360, 96)
  const b = node("row", 0, 100, 360, 100)
  const c = node("row", 0, 204, 360, 97)
  assert.equal(RowList.clusterSiblings([a, b, c]).length, 1)
})

console.log("— parseCounters —")
ok('"3万 粉丝" → 粉丝=30000', () => {
  const counters = RowList.parseCounters("3万 粉丝")
  assert.deepEqual(counters, [{ key: "粉丝", value: 30000, raw: "3万 粉丝" }])
})
ok('"1.2k likes" → likes=1200', () => {
  const counters = RowList.parseCounters("1.2k likes")
  assert.deepEqual(counters, [{ key: "likes", value: 1200, raw: "1.2k likes" }])
})
ok('"4亿 播放" → 播放=400000000', () => {
  assert.deepEqual(RowList.parseCounters("4亿 播放"), [{ key: "播放", value: 400000000, raw: "4亿 播放" }])
})
ok("bare number is skipped (no classifier)", () => {
  assert.deepEqual(RowList.parseCounters("42"), [])
})
ok("digit-suffix serial like 1A215 is skipped (trailing-digit guard)", () => {
  assert.deepEqual(RowList.parseCounters("sn-1A215"), [])
})
ok("punctuation-only key from serial-like model string is skipped", () => {
  assert.deepEqual(RowList.parseCounters("About emulated device sdk_gphone64_x86_64"), [])
})
ok("commas parse: \"12,345 followers\" → 12345", () => {
  assert.deepEqual(RowList.parseCounters("12,345 followers"), [{ key: "followers", value: 12345, raw: "12,345 followers" }])
})
ok("multiple counters in one label", () => {
  const counters = RowList.parseCounters("3万 粉丝 · 128 关注")
  assert.deepEqual(counters, [
    { key: "粉丝", value: 30000, raw: "3万 粉丝" },
    { key: "关注", value: 128, raw: "128 关注" },
  ])
})
ok("normalizeCountKey lowercases and trims", () => {
  assert.equal(RowList.normalizeCountKey("  Likes "), "likes")
  assert.equal(RowList.normalizeCountKey("粉丝"), "粉丝")
})

console.log("— aggregateRowLabel —")
ok("distinct labels in document order, joined by space", () => {
  const n = node("row", 0, 0, 360, 96, undefined, [
    node("label", 0, 0, 100, 20, "Alice"),
    node("label", 0, 20, 100, 20, "Alice"),
    node("label", 0, 40, 100, 20, "3万 粉丝"),
  ])
  assert.equal(RowList.aggregateRowLabel(n), "Alice 3万 粉丝")
})

console.log("— detectRows —")
ok("five stacked rows → 5 rows, one group, frame/label/counters per row", () => {
  const root = node("screen", 0, 0, 360, 800, undefined, [
    row(0, "Settings general"),
    row(1, "Settings display"),
    row(2, "Settings sound"),
    row(3, "Settings storage"),
    row(4, "Settings battery"),
  ])
  const screen = { width: 360, height: 800 }
  const { rows, omittedOffscreen } = RowList.detectRows([root], screen)
  assert.equal(rows.length, 5)
  assert.equal(omittedOffscreen, 0)
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2, 3, 4])
  assert.equal(new Set(rows.map((r) => r.group)).size, 1)
  assert.deepEqual(rows[0].frame, { x: 0, y: 0, w: 360, h: 96 })
  assert.ok(rows[0].label.includes("Settings general"))
  assert.deepEqual(rows[0].counters, [{ key: "粉丝", value: 30000, raw: "3万 粉丝" }])
})
ok("off-screen rows are counted, not emitted", () => {
  const root = node("screen", 0, 0, 360, 800, undefined, [
    row(0, "visible"),
    node("row", 0, 900, 360, 96, undefined, [node("label", 8, 912, 200, 40, "below fold")]),
    row(2, "also visible"),
  ])
  const { rows, omittedOffscreen } = RowList.detectRows([root], { width: 360, height: 800 })
  assert.equal(rows.length, 2)
  assert.equal(omittedOffscreen, 1)
})
ok("nested runs collapse to the outermost", () => {
  // Parent list of 3 rows; each row contains 3 equal sub-rows (nested run).
  const makeNested = (i) => node("row", 0, i * 200, 360, 180, undefined, [
    node("subrow", 0, i * 200, 360, 50, `sub ${i}-0`),
    node("subrow", 0, i * 200 + 60, 360, 50, `sub ${i}-1`),
    node("subrow", 0, i * 200 + 120, 360, 50, `sub ${i}-2`),
  ])
  const root = node("screen", 0, 0, 360, 700, undefined, [makeNested(0), makeNested(1), makeNested(2)])
  const { rows } = RowList.detectRows([root], { width: 360, height: 700 })
  // The outer 3 rows win; subrows are contained inside them → collapsed.
  assert.equal(rows.length, 3)
  assert.ok(rows[0].label.includes("sub 0-0"))
})
ok("a page-height candidate (>=90% of screen) is dropped", () => {
  const root = node("screen", 0, 0, 360, 800, undefined, [node("page", 0, 0, 360, 760, "full page")])
  const { rows } = RowList.detectRows([root], { width: 360, height: 800 })
  assert.equal(rows.length, 0)
})

console.log("— planRowTap —")
ok("center fraction hits the row middle", () => {
  const rows = [{ index: 0, group: 0, frame: { x: 10, y: 20, w: 200, h: 100 }, label: "r", counters: [] }]
  assert.deepEqual(RowList.planRowTap(rows, 0, 0.5, 0.5), { x: 110, y: 70 })
})
ok("out-of-range index refuses (never clamps)", () => {
  const rows = [{ index: 0, group: 0, frame: { x: 0, y: 0, w: 10, h: 10 }, label: "r", counters: [] }]
  assert.throws(() => RowList.planRowTap(rows, 1, 0.5, 0.5), /does not exist/)
})
ok("fractions outside 0..1 refuse", () => {
  const rows = [{ index: 0, group: 0, frame: { x: 0, y: 0, w: 10, h: 10 }, label: "r", counters: [] }]
  assert.throws(() => RowList.planRowTap(rows, 0, 1.2, 0.5), /0\.\.1/)
})

console.log("— verifyCountChange / rowsStayedPut —")
const counterRow = (value) => ({
  index: 0,
  group: 0,
  frame: { x: 0, y: 0, w: 360, h: 96 },
  label: "l",
  counters: [{ key: "粉丝", value }],
})
ok("exact +1 delta verifies", () => {
  const r = RowList.verifyCountChange(counterRow(30000), counterRow(30001), "粉丝", 1)
  assert.deepEqual(r, { verified: true, before: 30000, after: 30001 })
})
ok("exact -1 delta verifies", () => {
  const r = RowList.verifyCountChange(counterRow(128), counterRow(127), "粉丝", -1)
  assert.ok(r.verified)
})
ok("wrong delta fails with reason", () => {
  const r = RowList.verifyCountChange(counterRow(30000), counterRow(30005), "粉丝", 1)
  assert.equal(r.verified, false)
  assert.match(r.reason, /expected 1/)
})
ok("missing counter before the tap fails", () => {
  const noCounter = { index: 0, group: 0, frame: { x: 0, y: 0, w: 360, h: 96 }, label: "l", counters: [] }
  const r = RowList.verifyCountChange(noCounter, counterRow(30001), "粉丝", 1)
  assert.equal(r.verified, false)
  assert.match(r.reason, /absent from the row before/)
})
ok("rowsStayedPut tolerates small drift, rejects big moves", () => {
  const before = { frame: { x: 0, y: 100, w: 360, h: 96 } }
  assert.ok(RowList.rowsStayedPut(before, { frame: { x: 0, y: 104, w: 360, h: 96 } }))
  assert.equal(RowList.rowsStayedPut(before, { frame: { x: 0, y: 240, w: 360, h: 96 } }), false)
})

console.log("— parsePackageMeminfo —")
const meminfoFixture = `Applications Memory Usage (in Kilobytes):
Uptime: 123456 Realtime: 123456

** MEMINFO in pid 2301 [com.simspoof.app] **
                   Pss  Private  Private  Swap      Heap     Heap     Heap
                 Total    Dirty    Clean    Dirty     Size    Alloc     Free
                ------  ------  ------  ------  ------  ------  ------
  Native Heap    23456   20000    1000     500    32768    25000     7768
  Dalvik Heap     3456    3000       0     200     8192     5000     3192
        Stack      450     400       0      50
     Other Dev     890     700       0     100
       .so mmap   7890    7000      50     400
      .jar mmap   1234    1000       0     100
               ------  ------  ------  ------  ------  ------  ------
                   TOTAL    37476   32100    1050    1350    40960   30000   10960

 App Summary
                       Pss(KB)  Private(KB)  Swap(KB)  Heap(KB)  Heap(KB)
                     Total     Clean     Dirty     Dirty     Size    Alloc
    -------        ------     ------     ------     ------    ------    ------
    Java Heap:         3456     3000        0       200      8192      5000
      Native Heap:    23456    20000     1000       500     32768     25000
          Code:        1234     1000        0       100
        Stack:          450      400        0        50
     Graphics:         2000     1800        0       300

   TOTAL    37476     32100     1050     1350

 TOTAL PSS:    37476     TOTAL RSS:    45678     TOTAL SWAP PSS:    1350
`
ok("parses totals, app summary and top categories", () => {
  const parsed = DeviceBuild.parsePackageMeminfo(meminfoFixture)
  assert.equal(parsed.totalPssKb, 37476)
  assert.equal(parsed.totalRssKb, 45678)
  assert.equal(parsed.totalSwapPssKb, 1350)
  assert.deepEqual(parsed.appSummary, {
    javaHeapKb: 3456,
    nativeHeapKb: 23456,
    codeKb: 1234,
    stackKb: 450,
    graphicsKb: 2000,
  })
  const top = parsed.topCategories.slice(0, 3)
  assert.deepEqual(top, [
    { name: "Native Heap", pssKb: 23456 },
    { name: ".so mmap", pssKb: 7890 },
    { name: "Dalvik Heap", pssKb: 3456 },
  ])
})
ok("no process block → undefined", () => {
  assert.equal(DeviceBuild.parsePackageMeminfo("no process found for: com.ghost"), undefined)
})

console.log(`\n${passed} checks passed`)
if (process.exitCode) {
  console.error("\nFAILURES — see above")
  process.exitCode = 1
} else {
  console.log("ALL PASS")
}