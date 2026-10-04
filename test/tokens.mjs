/**
 * dsh-mobilecode — design-token guard for lib/client.js.
 *
 * The stylesheet is one template literal and the theme is entirely token-driven
 * (the DSH host resolves light-dark() against its own color-scheme, and the
 * plugin overrides nothing). That makes the :root block load-bearing in a way
 * ordinary CSS is not, and it fails silently in two directions:
 *
 *   - a token referenced but never declared drops its whole declaration, so the
 *     element falls back to an inherited value. This is not hypothetical: a
 *     rename during typesetting left .mc-serial on a retired --mc-fs-sm and it
 *     quietly went to 16px, caught only by grepping for the old name.
 *   - a token declared but unused is either a rename leftover or a value that
 *     was meant to be wired up.
 *
 * It also pins the measured contrast floor, so recolouring has to re-measure
 * rather than eyeball. Every ratio below is asserted in BOTH themes.
 *
 *   1. the :root block exists, declares color-scheme, and holds the palette,
 *   2. no var(--mc-*) reference lacks a declaration,
 *   3. no declared token is unused,
 *   4. the retired px ladder (--mc-fs-2xs … --mc-fs-xl) is gone,
 *   5. no raw colour literal survives outside :root,
 *   6. no raw size literal survives in the inline JSX styles,
 *   7. the type scale is closed and the caption role stays micro-only,
 *   8. no at-rule query is declared in two places,
 *   9. every transition uses the duration/easing tokens,
 *  10. every text and UI pair clears its WCAG ratio in both themes.
 *  11. no token that paints text carries a sub-4.5 floor,
 *  12. every class the stylesheet targets is rendered somewhere.
 *
 * Run: node test/tokens.mjs
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = process.env["DSH_MOBILECODE_DIR"] ?? path.resolve(here, "..")
const clientPath = path.join(pluginDir, "lib", "client.js")

const src = fs.readFileSync(clientPath, "utf8")

const styleStart = src.indexOf("const STYLE = `")
const styleEnd = src.indexOf("`;", styleStart)
if (styleStart < 0 || styleEnd < 0) throw new Error("lib/client.js has no single STYLE template literal")
const css = src.slice(styleStart, styleEnd)
// the JS half: everything that is not the stylesheet
const js = src.slice(0, styleStart) + src.slice(styleEnd)

const rootStart = css.indexOf(":root {")
const rootEnd = css.indexOf("}", rootStart)
if (rootStart < 0 || rootEnd < 0) throw new Error("no :root token block")
const root = css.slice(rootStart, rootEnd)
// the stylesheet outside :root — where no colour literal may live
const cssOutsideRoot = css.slice(0, rootStart) + css.slice(rootEnd)
// The whole file outside :root — the JSX inline styles are in scope too.
// Comments are stripped first: the token block's own documentation quotes the
// failed values it replaced (#2a3340 as the dead --mc-border fallback, #8ab4f8
// as the dark accent), and quoting a colour is not using one.
const outsideRoot = (src.slice(0, styleStart) + cssOutsideRoot + src.slice(styleEnd))
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^[ \t]*\/\/.*$/gm, " ")

// ── colour parsing ───────────────────────────────────────────────────────────

const hex = (h) => {
  h = h.replace("#", "")
  if (h.length === 3) h = h.split("").map((c) => c + c).join("")
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
const rgba = (s) => {
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null
}
const parse = (s) => (s.startsWith("#") ? { rgb: hex(s), a: 1 } : rgba(s))
const over = (fg, bg) => fg.rgb.map((c, i) => fg.a * c + (1 - fg.a) * bg[i])
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// "light-dark(a, b)" holds commas of its own (rgba() arguments), so a naive
// non-greedy split cuts rgba(0,0,0,.13) at its first comma.
const splitTop = (s) => {
  const parts = []
  let depth = 0
  let cur = ""
  for (const ch of s) {
    if (ch === "(") depth += 1
    if (ch === ")") depth -= 1
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue }
    cur += ch
  }
  parts.push(cur)
  return parts
}

// ── the tokens ───────────────────────────────────────────────────────────────

const tok = {}
for (const m of root.matchAll(/--mc-([a-z0-9-]+):\s*([^;]+);/g)) {
  const v = m[2].trim()
  if (v.startsWith("light-dark(") && v.endsWith(")")) {
    const [l, d] = splitTop(v.slice(11, -1))
    tok[m[1]] = { light: l.trim(), dark: d.trim() }
  } else {
    tok[m[1]] = { light: v, dark: v }
  }
}

const declared = new Set(Object.keys(tok))

// Tokens written from JS at runtime (setProperty) are legitimately referenced
// without a :root declaration.
const RUNTIME = new Set(["ar-n"])

// ── the harness ──────────────────────────────────────────────────────────────

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

console.log(`tokens: ${declared.size} declared in :root of ${path.relative(pluginDir, clientPath)}`)

ok(":root declares color-scheme so light-dark() resolves", () => {
  if (!/color-scheme:\s*light dark/.test(root)) throw new Error(":root does not set `color-scheme: light dark`")
})

ok("every var(--mc-*) reference resolves to a declaration", () => {
  const bad = []
  const seen = new Set()
  for (const m of src.matchAll(/var\(--mc-([a-z0-9-]+)([^)]*)\)/g)) {
    const name = m[1]
    if (declared.has(name) || RUNTIME.has(name) || seen.has(name)) continue
    seen.add(name)
    bad.push(m[2].includes(",")
      ? `--mc-${name} (has a literal fallback, so it looks fine but is dead)`
      : `--mc-${name} (no fallback — the declaration is dropped entirely)`)
  }
  if (bad.length) throw new Error(`undeclared token(s): ${bad.join("; ")}`)
})

ok("no declared token is unused", () => {
  const referenced = new Set([...src.matchAll(/var\(--mc-([a-z0-9-]+)/g)].map((m) => m[1]))
  const orphans = [...declared].filter((n) => !referenced.has(n))
  if (orphans.length) throw new Error(`orphan token(s): ${orphans.map((n) => `--mc-${n}`).join(", ")}`)
})

ok("the retired px ladder is gone", () => {
  const dead = ["fs-2xs", "fs-xs", "fs-sm", "fs-md", "fs-base", "fs-lg", "fs-xl"].filter((d) => declared.has(d) || src.includes(`var(--mc-${d})`))
  if (dead.length) throw new Error(`retired type token(s) still referenced: ${dead.map((d) => `--mc-${d}`).join(", ")}`)
})

ok("no raw colour literal outside :root", () => {
  const hits = [...outsideRoot.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g)].map((m) => m[0])
  if (hits.length) throw new Error(`colour literal(s) outside the token block: ${[...new Set(hits)].join(", ")}`)
})

ok("no raw size literal in the inline JSX styles", () => {
  // Two forms, because the first pass over the inline styles only caught the
  // numeric one and left `padding: "12px 0 0"` behind — a string literal is
  // just as raw as a number. `height`/`width` are deliberately NOT listed:
  // component dimensions (the 150px preview placeholder, the 48px resize grip)
  // have no scale to belong to and are documented as sanctioned raw values.
  const PROPS = "fontSize|borderRadius|margin|marginTop|marginLeft|marginRight|marginBottom|padding|gap|rowGap|columnGap"
  const hits = [
    ...js.matchAll(new RegExp(`\\b(?:${PROPS}):\\s*\\d+`, "g")),
    ...js.matchAll(new RegExp(`\\b(?:${PROPS}):\\s*"[^"]*\\d+px`, "g")),
  ].map((m) => m[0])
  if (hits.length) throw new Error(`inline size literal(s): ${[...new Set(hits)].join(", ")}`)
})

ok("the type scale is closed and the caption role stays micro-only", () => {
  // Four semantic roles, not a value ladder. Caption is the ONLY sub-14px role
  // and it is reserved for labels that annotate a control. The 11px version of
  // it had crept onto .mc-hint, .mc-footer, .mc-live-cap and .mc-picker-hint —
  // all of which are text a user reads, and all of which sat under the 14px
  // floor the design passes set. Widening the scale is fine; widening what
  // caption is allowed to cover is not, so the whitelist below is the guard.
  const ROLES = { "fs-caption": "0.75rem", "fs-label": "0.875rem", "fs-body": "1rem", "fs-title": "1.25rem" }
  for (const [name, want] of Object.entries(ROLES)) {
    if (!tok[name]) throw new Error(`--mc-${name} is not declared`)
    if (tok[name].light !== want || tok[name].dark !== want) {
      throw new Error(`--mc-${name} is "${tok[name].light}" (want "${want}") — change the scale table and the stylesheet together`)
    }
  }
  // A negative lookahead after \s* is useless here — the greedy \s* backtracks
  // to zero width and the lookahead then tests the space, so match the value
  // and filter it instead.
  const raw = [...cssOutsideRoot.matchAll(/font-size:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.startsWith("var(--mc-fs-"))
  if (raw.length) throw new Error(`font-size(s) outside the scale: ${[...new Set(raw)].join(", ")}`)

  const MICRO = new Set([".mc-badge", ".mc-live-badge", ".mc-picker-label"])
  const users = new Set()
  for (const m of cssOutsideRoot.matchAll(/font-size:\s*var\(--mc-fs-caption\)/g)) {
    const open = cssOutsideRoot.lastIndexOf("{", m.index)
    const prev = Math.max(cssOutsideRoot.lastIndexOf("}", open), cssOutsideRoot.lastIndexOf("{", open - 1))
    // last non-empty line, so a rule nested in an at-rule still yields the selector
    users.add(cssOutsideRoot.slice(prev + 1, open).split("\n").map((l) => l.trim()).filter(Boolean).pop())
  }
  const wrong = [...users].filter((s) => !MICRO.has(s))
  if (wrong.length) throw new Error(`caption role used for reading text: ${wrong.join(", ")} — use --mc-fs-label`)
  const missing = [...MICRO].filter((s) => !users.has(s))
  if (missing.length) throw new Error(`micro label(s) dropped the caption role: ${missing.join(", ")}`)
  if (js.includes("var(--mc-fs-caption)")) {
    throw new Error("an inline JSX style uses the caption role — inline styles are reading text or control labels")
  }
})

ok("no at-rule query is declared in two places", () => {
  // One block per query. The narrow tier had drifted into two separate
  // @media (max-width: 380px) blocks — one for the panel, one for the resize
  // handle — because the handle's rule has to come last to outrank
  // pointer:coarse. If cascade order genuinely matters, put the rule in the
  // block that already exists and say why, rather than opening a second one.
  // Comments are stripped: several of them quote an @media prelude in prose.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ")
  const seen = new Map()
  for (const m of bare.matchAll(/@(media|container|supports)\s*([^{]+)\{/g)) {
    const key = `@${m[1]} ${m[2].trim()}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} (x${n})`)
  if (dupes.length) throw new Error(`at-rule declared more than once: ${dupes.join(", ")}`)
})

ok("every transition uses the duration and easing tokens", () => {
  const bad = [...css.matchAll(/transition:\s*([^;]+);/g)]
    .map((m) => m[1])
    .filter((v) => !v.includes("var(--mc-dur)") || !v.includes("var(--mc-ease)"))
  if (bad.length) throw new Error(`transition(s) bypassing the motion tokens: ${bad.join(" | ")}`)
})

// ── the contrast floor ───────────────────────────────────────────────────────
// 4.5 for anything that paints text, 3.0 for a UI boundary or a non-text
// indicator (WCAG 1.4.3 / 1.4.11). --mc-idle is a dot background
// only, and --mc-accent-line / --mc-ok-line / --mc-err-line are border-colors
// only — grep before moving any of them into a text rule. --mc-warn used to
// sit on that list too, and the grep the comment asks for is what disproved
// it: the preview-gallery freshness note paints it as TEXT, which made its
// 3.25:1 a 1.4.3 failure rather than a pass. Check 11 now enforces that grep.
const PAIRS = [
  ["text on bg", "text", "bg", 4.5],
  ["text-dim on bg", "text-dim", "bg", 4.5],
  ["text-mute on bg", "text-mute", "bg", 4.5],
  ["text-faint on bg", "text-faint", "bg", 4.5],
  ["accent on bg", "accent", "bg", 4.5],
  ["accent on accent-weak", "accent", "accent-weak", 4.5],
  ["accent-hover on bg", "accent-hover", "bg", 4.5],
  ["accent-hover on accent-weak", "accent-hover", "accent-weak", 4.5],
  ["on-accent on accent", "on-accent", "accent", 4.5],
  ["ok on bg", "ok", "bg", 4.5],
  ["ok on ok-weak", "ok", "ok-weak", 4.5],
  ["ok on ok-hover", "ok", "ok-hover", 4.5],
  ["err on bg", "err", "bg", 4.5],
  ["err on err-weak", "err", "err-weak", 4.5],
  ["warn on bg", "warn", "bg", 4.5],
  ["idle on bg", "idle", "bg", 3.0],
  ["focus on bg", "focus", "bg", 3.0],
  ["grip on bg", "grip", "bg", 3.0],
  ["grip-hover on bg", "grip-hover", "bg", 3.0],
  ["field-border on bg", "field-border", "bg", 3.0],
  ["field-border on bg-inset", "field-border", "bg-inset", 3.0],
  ["accent-line on bg", "accent-line", "bg", 3.0],
  ["ok-line on ok-weak", "ok-line", "ok-weak", 3.0],
  ["err-line on err-weak", "err-line", "err-weak", 3.0],
]

for (const [theme, key] of [["light", "light"], ["dark", "dark"]]) {
  ok(`${theme} theme: every pair clears its WCAG ratio`, () => {
    const page = hex(tok.bg[key])
    const bad = []
    for (const [label, fgTok, bgTok, threshold] of PAIRS) {
      if (!tok[fgTok]) throw new Error(`--mc-${fgTok} is not declared (pair "${label}")`)
      const bg = bgTok === "bg" ? page : over(parse(tok[bgTok][key]), page)
      const r = ratio(over(parse(tok[fgTok][key]), bg), bg)
      if (r < threshold) bad.push(`${label} ${r.toFixed(2)}:1 (need ${threshold})`)
    }
    if (bad.length) throw new Error(`${bad.length} pair(s) below threshold: ${bad.join("; ")}`)
  })
}

// ── the grep the contrast comment demands ────────────────────────────────────
// The table above is only as good as its claim about what each token PAINTS.
// That claim is grep-able, so grep it: a token that reaches a `color:` paints
// text and needs 4.5, whatever the table says. This is the check that would
// have caught --mc-warn sitting at 3.0 while the freshness note painted it.
ok("no token that paints text carries a sub-4.5 floor", () => {
  const floor = new Map(PAIRS.map(([, fg, , threshold]) => [fg, threshold]))
  const painting = new Set()
  for (const m of outsideRoot.matchAll(/[^-\w]color:\s*"?var\(--mc-([a-z0-9-]+)\)"?/g)) painting.add(m[1])
  const bad = [...painting].filter((t) => floor.has(t) && floor.get(t) < 4.5)
  if (bad.length) throw new Error(`token(s) painting text with a sub-4.5 floor: ${bad.join(", ")}`)
})

// ── the class sweep ──────────────────────────────────────────────────────────
// A rule whose class is never rendered is dead CSS: it survives renames and
// deletions because nothing fails when a selector matches nothing. This is the
// check that catches a class renamed in the JSX but not in the stylesheet.
//
// WHAT THIS CANNOT SEE — and it is not merely "weaker". It proves a CLASS is
// rendered; it never proves a SELECTOR matches. `.mc-picker-row .mc-log-toggle`
// passed this check (both names occur) and was dead in fact; it was found by
// hand. Deciding selector liveness needs the RENDERED tree, and a lexical
// nesting scan of the JSX does not produce one — two independent mechanisms
// defeat it, both measured against this file before this comment was written:
//
//   - a child COMPONENT breaks lexical nesting. `h(SettingsTabs, {})` sits
//     inside `.mc-section` (lib/client.js:2046) while the "mc-tabs" literal
//     lives in a different function (:1977), so `.mc-section .mc-tabs` (:258,
//     :399 — both live) reads as dead;
//   - a class composed by a HELPER has no className literal to find.
//     `stageClassFor` (:484) returns "mc-live-stage" + …, so the ancestor of
//     `.mc-live-stage .mc-live-off` (:263, :388, :407 — all live) is invisible.
//
// So do not "strengthen" this into a nesting check. Either drive the real tree
// (test/render.mjs mounts the panel through a miniature React) or leave it.
ok("every class the stylesheet targets is rendered somewhere", () => {
  const styled = new Set([...css.matchAll(/\.(mc-[a-z0-9-]+)/g)].map((m) => m[1]))
  // A class only reaches a DOM node through a string, so look in the JS half's
  // quoted strings. A bare mention — a comment, an identifier — renders
  // nothing. (`"[^"]*NAME` would not do: it also matches a name sitting in a
  // comment right after a closing quote, which is the case this rejects.)
  const strings = [...js.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]).join("\n")
  // NOT \b: a hyphen is a word boundary, so \bmc-log-toggle\b also matches the
  // renamed "mc-log-toggle-x" — and hyphens are how every one of these names is
  // built. The boundary has to exclude the class-name alphabet itself.
  const orphans = [...styled].filter((c) => !new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(strings))
  if (orphans.length) throw new Error(`styled but never rendered: ${orphans.join(", ")}`)
})

// The tally is the LAST thing in the file on purpose. It used to sit above the
// final check, so the run printed "11 checks passed" while executing twelve —
// a count that cannot see what was appended after it is not a tally.
console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`)
