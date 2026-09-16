/**
 * dsh-mobilecode — practice-screen proposal mockups, REV 3.
 *
 * Grounded in actual code (TrainingScreen.kt / PracticeViewModel.kt, master):
 *  - slot count = expected-answer digit count (451 -> 3 underline slots,
 *    BoardDigitSlot :1146-1164), NOT boxes;
 *  - WRONG verdict today: banner "WRONG // 0 XP" (icon + text) in the fixed
 *    VerdictSlot strip (:1215-1283); ALL entered digits tint IncorrectRed
 *    together (:1152-1156) — per-digit marking is a PROPOSAL, noted;
 *  - keypad: digits inert while a verdict is active (:777); CHECK stays armed
 *    after a MANUAL verdict and IS the old NEXT (:1393-1400); after an
 *    auto-submitted timeout the session advances within ~700 ms and CHECK
 *    goes inert too (:177-182) — the rev-2 "NEXT IN 2s" copy was wrong;
 *  - correct-answer reveal exists today INSIDE the How-to-solve dialog
 *    (:2128-2133); an in-cockpit explanation panel is additive PROPOSAL and
 *    changes no timing/scoring;
 *  - arithmetic (verified solver, 41×11): units = copy last digit -> 1;
 *    tens = add neighbor -> 4+1 = 5; hundreds = write left digit -> 4.
 *    482 differs in TWO places (units 2≠1, tens 8≠5); hundreds matches.
 *    Explanations show BOTH mismatches; observed ≠ inferred cause.
 *
 * Output: docs/design/mockups/*.png + manifest.json (rev 3, per-file sha256).
 * Every image: "design proposal — not a native render". Mockups are NOT
 * regression baselines; visual inspection does NOT prove touch dimensions,
 * contrast, or real 320dp/font-scale behavior (device runs required for that).
 * Run: node scripts/design-mockups.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const sharp = require(path.join(process.env.USERPROFILE, ".dsh/profiles/web/node_modules/sharp"))

const W = 1080, H = 2400
const C = {
  bg: "#141416", surface: "#1C1C23", raised: "#2E2E38", line: "#3C3C4B",
  text: "#C8C8D2", dim: "#828291", brand: "#E63E3E", green: "#2ECC71",
  amber: "#FFB020", wrongFill: "rgba(230,62,62,0.12)", onRed: "#FFF0F0",
}
const MONO = "ui-monospace,Consolas,monospace"
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
const txt = (x, y, s, size, fill, { anchor = "start", weight = 400, family = MONO, spacing = 0, opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-family="${family}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${spacing}" opacity="${opacity}">${esc(s)}</text>`
const rect = (x, y, w, h, fill, r = 0, stroke = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${stroke ? `stroke="${stroke}" stroke-width="2"` : ""}/>`

/* ───── shared chrome ───── */
const topBar = (mode) => [
  txt(48, 196, "✕", 48, C.dim),
  txt(W / 2, 190, mode, 26, C.dim, { anchor: "middle", weight: 600, spacing: 4 }),
  txt(W - 240, 196, "?", 44, C.amber, { weight: 700 }),
  txt(W - 130, 196, "⏸", 44, C.dim),
  rect(48, 232, 984, 2, C.raised),
].join("")

/* real contract: 3 underline slots for a 3-digit answer (451) */
function answerSlots(y, entered, { wrongAll = false, markWrongPos = null, posLabels = true } = {}) {
  const sw = 110, gap = 46, n = 3
  const x0 = (W - (n * sw + (n - 1) * gap)) / 2
  const parts = [txt(x0, y - 24, "ANSWER", 24, C.dim, { weight: 600, spacing: 6 })]
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (sw + gap)
    const ch = entered[i]
    const red = wrongAll && ch
    parts.push(txt(x + sw / 2, y + 92, ch ?? "", 84, red ? C.brand : C.text, { anchor: "middle", weight: 700 }))
    parts.push(rect(x, y + 118, sw, 5, red ? C.brand : (ch ? C.text : C.line)))
    if (markWrongPos === i) parts.push(rect(x - 12, y + 4, sw + 24, 130, "transparent", 8, C.amber))
    if (posLabels) parts.push(txt(x + sw / 2, y + 152, ["HUNDREDS", "TENS", "UNITS"][i], 18, C.dim, { anchor: "middle", spacing: 2 }))
  }
  return parts.join("")
}

/* status-quo verdict strip (VerdictSlot): icon + label, 12% tint + border */
const wrongBanner = (y) => [
  rect(180, y, 720, 84, C.wrongFill, 6, C.brand),
  txt(216, y + 56, "✗", 40, C.brand),
  txt(270, y + 56, "WRONG // 0 XP", 34, C.brand, { weight: 700, spacing: 2 }),
].join("")
const solveIt = (y) => txt(W / 2, y, "SOLVE IT", 26, C.dim, { anchor: "middle", weight: 700, spacing: 4 })

/* keypad FIXED to the same bottom anchor in every state (rev-2 inconsistency
   called out by critic). Digits dim while a verdict is active; CHECK armed as
   the advance control after a manual verdict (:1393-1400 carve-out). */
const KP = { kw: 312, kh: 162, gap: 24, top: 1544 }
function keypad({ verdictWrong = false, autoSubmitted = false, glyph = null } = {}) {
  const keys = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["⌫", "0", "CHECK"]]
  const x0 = (W - (3 * KP.kw + 2 * KP.gap)) / 2
  const parts = []
  const digitsOn = !verdictWrong
  keys.forEach((row, r) => row.forEach((k, i) => {
    const x = x0 + i * (KP.kw + KP.gap), yy = KP.top + r * (KP.kh + KP.gap)
    const isCheck = k === "CHECK"
    const on = isCheck ? (verdictWrong ? !autoSubmitted : true) : digitsOn
    parts.push(rect(x, yy, KP.kw, KP.kh, isCheck && on ? C.brand : C.raised, 8))
    parts.push(txt(x + KP.kw / 2, yy + KP.kh / 2 + (isCheck ? 12 : 24), k, isCheck ? 38 : (glyph ?? 66),
      isCheck ? (on ? C.onRed : C.dim) : (on ? C.text : C.dim),
      { anchor: "middle", weight: isCheck ? 700 : 600, opacity: on ? 1 : 0.55 }))
  }))
  if (verdictWrong && !autoSubmitted) parts.push(txt(W / 2, KP.top - 26, "CHECK = CONTINUE (current: it advances after a manual verdict)", 20, C.dim, { anchor: "middle", spacing: 1 }))
  if (verdictWrong && autoSubmitted) parts.push(txt(W / 2, KP.top - 26, "AUTO-SUBMITTED VERDICT — KEYPAD INERT, ADVANCES ≤ 700 MS", 20, C.dim, { anchor: "middle", spacing: 1 }))
  return parts.join("")
}

// auto-shrink so the honesty label NEVER clips the canvas edge (rev-4, R3-1):
// mono advance ≈0.6em → size ≤ 1040/(0.6*len)
const footer = (label) => { const size = Math.min(22, Math.floor(1040 / (0.6 * label.length))); return [rect(0, H - 96, W, 96, C.surface), txt(W / 2, H - 40, label, size, C.dim, { anchor: "middle" })].join("") }
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${rect(0, 0, W, H, C.bg)}${body}</svg>`

/* aligned place-labeled rows: YOUR 482 vs RULE 451; BOTH mismatches; observed
   only — never a claimed cause; single-step highlight says "1 of 2". */
function explanation(y, { style }) {
  if (style === "A") return [
    rect(48, y, 984, 128, C.surface, 8),
    txt(76, y + 52, "482 vs 451 — TWO digits differ (hundreds matches)", 27, C.text, { weight: 600 }),
    txt(76, y + 98, "tens: neighbor 4 + 1 = 5 · you entered 8   — showing 1 of 2 · ▸ units also differs", 24, C.dim),
  ].join("")
  if (style === "B") return [
    rect(48, y, 984, 224, C.surface, 8, C.amber),
    txt(76, y + 44, "WHERE 482 LEFT THE RULE", 22, C.amber, { weight: 700, spacing: 3 }),
    txt(76, y + 100, "your   4  8  2", 32, C.text, { weight: 600 }),
    txt(560, y + 100, "rule    4  5  1", 32, C.green, { weight: 600 }),
    txt(76, y + 152, "units: ×11 copies 41's last digit → 1   (you entered 2)", 25, C.text),
    txt(76, y + 194, "tens:  add the neighbor 4 + 1 = 5   (you entered 8)", 25, C.text),
  ].join("")
  if (style === "C") return [
    rect(48, y, 984, 158, C.surface, 8),
    txt(76, y + 46, "✗ 2 OF 3 PLACES DIFFER — 482 vs 451", 26, C.brand, { weight: 700 }),
    txt(76, y + 92, "units 2≠1: copy last digit · tens 8≠5: neighbor 4+1=5", 24, C.text),
    txt(76, y + 134, "OBSERVED ONLY — no cause inferred", 20, C.dim, { spacing: 2 }),
  ].join("")
  return [
    rect(48, y, 984, 168, C.surface, 8),
    txt(76, y + 44, "482 vs RULE 451", 24, C.dim, { weight: 600, spacing: 2 }),
    txt(76, y + 92, "tens: 4 + 1 = 5 → entered 8  ·  units: copy 41's last = 1 → entered 2", 24, C.text),
    txt(76, y + 136, "two mismatches shown · cause not inferred", 20, C.amber, { spacing: 1 }),
  ].join("")
}

/* session ribbon — triple-coded and data-consistent: attempts 1-4 done
   (✓ ✓ ✗ ✓), current = attempt 5, ACC 75%, COMBO 1 */
function ribbon() {
  const states = ["ok", "ok", "bad", "ok", "cur", "", "", "", "", ""]
  const parts = [txt(48, 322, "SESSION 05 / 10", 28, C.dim, { weight: 600, spacing: 3 })]
  const w = 84, gap = 16
  states.forEach((s, i) => {
    const x = 48 + i * (w + gap)
    parts.push(rect(x, 340, w, 18, s === "ok" ? C.green : s === "bad" ? C.brand : C.raised, 9))
    if (s === "ok") parts.push(txt(x + w / 2, 396, "✓", 26, C.green, { anchor: "middle", weight: 700 }))
    if (s === "bad") parts.push(txt(x + w / 2, 396, "✗", 26, C.brand, { anchor: "middle", weight: 700 }))
    if (s === "cur") parts.push(txt(x + w / 2, 396, "●", 26, C.text, { anchor: "middle" }))
  })
  return parts.join("")
}

const microStats = (y) => txt(48, y, "COMBO 1 · ACC 75% · AVG 1.1s", 22, C.dim, { weight: 600, spacing: 2 })
const statChips = (y) => [
  ["COMBO", "1", C.green], ["ACC", "75%", C.text], ["AVG", "1.1s", C.text],
].map(([k, v, col], i) => {
  const x = 48 + i * 336
  return rect(x, y, 312, 110, C.surface, 8) + txt(x + 24, y + 42, k, 24, C.dim, { weight: 600, spacing: 3 }) + txt(x + 24, y + 92, v, 44, col, { weight: 700 })
}).join("")

const problem = (y, size = 112, opacity = 1) => txt(W / 2, y, "41 × 11", size, C.text, { anchor: "middle", weight: 700, opacity })
const hairTimer = (y, frac, accent) => rect(48, y, 984, 6, C.raised) + rect(48, y, Math.round(984 * frac), 6, accent)

/* ───── entry screens ───── */
const Aentry = () => doc([
  topBar("STANDARD"), hairTimer(262, 0.75, C.amber),
  txt(W - 48, 318, "0.9 / target 1.2 s", 22, C.dim, { anchor: "end" }),
  txt(48, 470, "01 / 10", 28, C.dim, { weight: 600 }),
  problem(680, 128),
  answerSlots(880, "48", {}),
  solveIt(1150),
  keypad(),
  footer("A · focused practice · answer entry · rev-5 · design proposal, not a native render"),
].join(""))

const Bentry = () => doc([
  topBar("STANDARD"),
  txt(64, 316, "×11 RULE: ADD THE NEIGHBOR", 32, C.amber, { weight: 700, spacing: 2 }),
  txt(W - 48, 316, "01 / 10", 26, C.dim, { anchor: "end" }),
  problem(460, 100),
  txt(48, 556, "STEP 2 OF 3", 28, C.amber, { weight: 700, spacing: 3 }),
  ...[["✓", "units: copy 41's last digit", "1", C.green], ["2", "tens: add the neighbor", "4 + 1 = 5", C.amber], ["3", "hundreds: write the left digit", "4", C.dim]]
    .map(([n, label, val, col], i) => {
      const y = 590 + i * 118
      return rect(48, y, 984, 102, i === 1 ? C.surface : "transparent", 8, i === 1 ? C.amber : C.raised) +
        txt(80, y + 62, n, 30, col, { weight: 700 }) + txt(128, y + 44, label, 24, C.dim) + txt(128, y + 84, val, 30, C.text, { weight: 600 })
    }),
  answerSlots(1000, "48", {}),
  solveIt(1250),
  keypad(),
  footer("B · guided learning · answer entry · rev-5 · slots = answer digits (3), underline style per :1146-1164"),
].join(""))

const Center = () => doc([
  topBar("STANDARD"), ribbon(),
  problem(580, 120), txt(W - 48, 640, "0.9s", 22, C.dim, { anchor: "end" }),
  answerSlots(800, "48", {}),
  solveIt(1080),
  statChips(1160),
  keypad(),
  footer("C · progress-oriented · answer entry · rev-5 · data consistent: 4 attempts, 3 ✓, combo 1, ACC 75%"),
].join(""))

/* ───── wrong-answer screens — real verdict mechanics ───── */
function wrongBody(explainStyle, { ribbonTop = false, stats = null }) {
  const parts = [
    topBar("STANDARD"), hairTimer(262, 1, C.brand),
    ...(ribbonTop ? [ribbon()] : [txt(48, 322, "01 / 10", 28, C.dim, { weight: 600 })]),
    problem(ribbonTop ? 560 : 500, 96, 0.85),
    answerSlots(ribbonTop ? 700 : 640, "482", { wrongAll: true, markWrongPos: explainStyle === "C" ? 1 : null }),
    wrongBanner(ribbonTop ? 930 : 880),
    explanation(ribbonTop ? 1080 : 1020, { style: explainStyle }),
    ...(stats === "chips" ? [statChips(1330)] : []),
    ...(stats === "micro" ? [microStats(1330)] : []),
    keypad({ verdictWrong: true }),
    footer(`${explainStyle} · wrong answer · rev-5 · design proposal — not a native render · amber box if shown = PROPOSED, all-red digits = current`),
  ]
  return doc(parts.join(""))
}
const Awrong = () => wrongBody("A", {})
const Bwrong = () => wrongBody("B", {})
const Cwrong = () => wrongBody("C", { ribbonTop: true, stats: "chips" })

/* ───── HYBRID H — C's structure, B's compact comparison, A's restraint ───── */
const Hentry = () => doc([
  topBar("STANDARD"), ribbon(),
  problem(580, 124), txt(W - 48, 640, "0.9s", 22, C.dim, { anchor: "end" }),
  answerSlots(820, "48", {}),
  solveIt(1100),
  microStats(1180),
  keypad(),
  footer("H · hybrid: C ribbon + micro-stats + fixed keypad · answer entry · rev-5 · proposal"),
].join(""))
const Hewrong = () => doc([
  topBar("STANDARD"), hairTimer(262, 1, C.brand), ribbon(),
  problem(540, 96, 0.85),
  answerSlots(680, "482", { wrongAll: true, markWrongPos: 1 }),
  wrongBanner(910),
  explanation(1040, { style: "H" }),
  microStats(1290),
  keypad({ verdictWrong: true }),
  footer("H · hybrid · wrong · rev-5 · additive panel · amber box = PROPOSED · not native"),
].join(""))
/* 320dp: same composition rendered into an 840x1869 viewport below */
const HcompactSVG = () => doc([
  topBar("STANDARD"), ribbon(),
  problem(560, 112),
  answerSlots(780, "48", {}),
  solveIt(1060),
  microStats(1140),
  keypad(),
  footer("H · 320dp composition · rev-5 · scaled mockup, NOT a device render"),
].join(""))
const Hlarge = () => doc([
  topBar("STANDARD"),
  txt(48, 360, "SESSION 05/10", 34, C.dim, { weight: 700, spacing: 2 }),
  problem(600, 150),
  answerSlots(820, "48", {}),
  solveIt(1140),
  microStats(1230),
  (() => {
    const keys = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["⌫", "0", "CHECK"]]
    const x0 = (W - (3 * 312 + 2 * 24)) / 2
    const p = []
    keys.forEach((row, r) => row.forEach((k, i) => {
      const x = x0 + i * 336, yy = 1544 + r * 186
      p.push(rect(x, yy, 312, 162, k === "CHECK" ? C.brand : C.raised, 8))
      p.push(txt(x + 156, yy + 112, k, k === "CHECK" ? 46 : 88, k === "CHECK" ? C.onRed : C.text, { anchor: "middle", weight: 700 }))
    }))
    return p.join("")
  })(),
  footer("H · enlarged-text composition (≈fontScale 2.0 mockup) · rev-5 · NOT device evidence"),
].join(""))
const Haudio = () => doc([
  topBar("AUDIO"),
  rect(48, 430, 984, 190, C.surface, 12),
  txt(76, 512, "▶", 64, C.amber, { weight: 700 }),
  txt(176, 500, "PROBLEM IS SPOKEN, NOT SHOWN", 26, C.dim, { weight: 600, spacing: 2 }),
  txt(176, 560, "“forty-one times eleven”  ·  TAP TO REPLAY", 34, C.text, { weight: 700 }),
  answerSlots(860, "48", {}),
  solveIt(1120),
  microStats(1190),
  keypad(),
  footer("H · AUDIO variant — phrase replaces the problem line · rev-5 · proposal, not native"),
].join(""))

/* ───── render + manifest with per-file sha256 ───── */
const OUT = path.join("docs", "design", "mockups")
mkdirSync(OUT, { recursive: true })
const items = {
  "A-entry.png": Aentry(), "A-wrong.png": Awrong(),
  "B-entry.png": Bentry(), "B-wrong.png": Bwrong(),
  "C-entry.png": Center(), "C-wrong.png": Cwrong(),
  "H-entry.png": Hentry(), "H-wrong.png": Hewrong(),
  "H-fontscale-2.png": Hlarge(), "H-audio-entry.png": Haudio(),
}
const manifest = {
  revision: 5, generatedAt: new Date().toISOString(),
  revNote: "rev-5: A/B/C-wrong footers restored (wrongBody template had none — critic R3-1 residual confirmed real); rev-4: footers auto-shrink inside canvas; H-wrong amber PROPOSED box (R3-2)",
  status: "DESIGN PROPOSALS (SVG mockups; system-mono approximates Chakra Petch/JetBrains Mono; tabular digits simulated) — NOT native renders, NOT human-approved regression baselines",
  groundedBehavior: {
    slots: "3 underline slots for 451 — count = answer digits (TrainingScreen:1116-1124, :1146-1164)",
    wrongToday: "banner 'WRONG // 0 XP'; ALL entered digits tint IncorrectRed together (:1152-1156, :1266-1267)",
    keypadOnVerdict: "digits inert; CHECK armed after MANUAL verdict and advances; auto-submitted verdict inert ~700 ms (:777, :1393-1400, :177-182)",
    reveal: "correct answer currently shown only inside the How-to-solve dialog (:2128-2133); cockpit explanation panel = additive proposal, no timing/scoring change",
    solver: "41×11 verified steps: units copy 1 · tens 4+1=5 · hundreds 4 — 482 differs in TWO places; mockups name both; causes not inferred",
    perPlaceMarking: "amber box on TENS (C-wrong) = PROPOSAL, not current behavior",
  },
  limitations: ["visual composition only — touch dimensions, contrast and 320dp/font-scale behavior require device/matrix runs after approval", "H-compact-320dp.png generated separately (resize step below)"],
  files: [],
}
for (const [name, svg] of Object.entries(items)) {
  const buf = await sharp(Buffer.from(svg)).png().toBuffer()
  writeFileSync(path.join(OUT, name), buf)
  manifest.files.push({ name, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") })
  console.log("wrote", name, buf.length)
}
const compactBuf = await sharp(Buffer.from(HcompactSVG())).png({ }).resize({ width: 840 }).toBuffer()
writeFileSync(path.join(OUT, "H-compact-320dp.png"), compactBuf)
manifest.files.push({ name: "H-compact-320dp.png", bytes: compactBuf.length, sha256: crypto.createHash("sha256").update(compactBuf).digest("hex"), note: "1080-wide composition uniformly scaled to 840px viewport — mockup only" })
console.log("wrote H-compact-320dp.png", compactBuf.length)
writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
console.log("manifest written; rev-4", manifest.files.length, "files")
