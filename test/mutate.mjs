/**
 * Negative tests for the pixel and scene layers: 1) mutate a copy of the
 * library, 2) run that copy's test file, 3) require BOTH a non-zero exit AND the
 * assertion that was supposed to catch it, by name.
 *
 * Why this file exists at all: a guard that is green on the real source proves
 * nothing. Every check in test/pixels.mjs and test/scene.mjs was written to be
 * breakable, and this is the only thing that says so — remove one of these
 * mutations' targets and the harness reports MUTATION TARGET NOT FOUND rather
 * than quietly passing. A red for the wrong reason is not evidence either, which
 * is why the expected message is asserted and not just the exit code.
 *
 * Run: node test/mutate.mjs
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const repo = path.resolve(import.meta.dirname, "..")

const MUTATIONS = [
  // --- lib/pixels.js --------------------------------------------------------
  {
    file: "pixels.js",
    test: "pixels",
    name: "the corner diagonal loses its extra √2 (a plausible radius, off by 1.41)",
    from: `const DIAGONAL_PIXEL = 2 + Math.SQRT2`,
    to: `const DIAGONAL_PIXEL = Math.SQRT2 + 1`,
    expect: "cornerRadius recovers a synthesised radius from an anti-aliased render",
  },
  {
    file: "pixels.js",
    test: "pixels",
    name: "shapeEdges compares a colour against a histogram RESULT",
    from: `  const outside = (surround ?? surroundColor(px, b)?.color) ?? null`,
    to: `  const outside = (surround ?? surroundColor(px, b)) ?? null`,
    expect: "shapeEdges finds the painted edge rather than trusting the reported box",
  },
  {
    file: "pixels.js",
    test: "pixels",
    name: "boxOf clamps only the far edge, so an off-screen box inverts",
    from: `  const l = Math.min(px.width, Math.max(0, Math.floor(left)))`,
    to: `  const l = Math.floor(left)`,
    expect: "boxOf accepts both box shapes and clamps to the image",
  },
  {
    file: "pixels.js",
    test: "pixels",
    name: "borderOf accepts any run as a stroke, so every raised card gains a border",
    from: `    const flat = run.length > 0 && inner.every((color) => sameColor(color, inner[0], tolerance))`,
    to: `    const flat = run.length > 0`,
    expect: "borderOf does not read a shadow ramp as a stroke",
  },
  {
    file: "pixels.js",
    test: "pixels",
    name: "borderOf stops checking the blend line, so a soft fill edge is a stroke",
    from: `      if (blend === null || blend.off <= tolerance) break`,
    to: `      if (blend === null) break`,
    expect: "borderOf is not fooled by an anti-aliased edge",
  },
  {
    file: "pixels.js",
    test: "pixels",
    name: "borderOf reports the budget as a width when a flat region runs past it",
    from: `      if (continues) {`,
    to: `      if (false) {`,
    expect: "a flat band that runs past the budget is a region, not a border",
  },
  {
    file: "pixels.js",
    test: "pixels",
    name: "elevationOf measures from shapeEdges, which has already swallowed the shadow",
    from: `  const edges = boxOf(box, px)
  if (edges.width < 2 || edges.height < 2) return null
  const beyond = {`,
    to: `  const edges = shapeEdges(px, box) ?? boxOf(box, px)
  if (edges.width < 2 || edges.height < 2) return null
  const beyond = {`,
    expect: "elevationOf measures a shadow and its downward offset",
  },
  {
    file: "pixels.js",
    test: "pixels",
    name: "the elevation offset's sign flips, so a downward shadow reads upward",
    from: `    offsetY: Math.round(((perSide.bottom - perSide.top) / 2) * 10) / 10,`,
    to: `    offsetY: Math.round(((perSide.top - perSide.bottom) / 2) * 10) / 10,`,
    expect: "elevationOf measures a shadow and its downward offset",
  },
  {
    // NOT mutated: `elevationOf`'s fill check
    // (`inside === null || colorDistance(color, inside) > tolerance`). Removing
    // it leaves every check green, and that is a FACT about the code rather than
    // a hole in the tests: a flat fill's distance from the page never changes, so
    // the ramp test below rejects the run with or without it. It is kept as belt
    // and braces for a fill that is flat near the box and ramps further out.
    file: "pixels.js",
    test: "pixels",
    name: "the ramp threshold drops to zero, so a flat neighbour counts as a shadow",
    from: `    if (closer < Math.max(1, Math.floor((run.length - 1) * 0.6))) return 0`,
    to: `    if (closer < 0) return 0`,
    expect: "a flat fill is not read as depth, however far the walk crosses it",
  },

  // --- lib/scene.js ---------------------------------------------------------
  {
    file: "scene.js",
    test: "scene",
    name: "a row's label is read from the row alone, not its subtree",
    from: `  Boolean(node.text || node.contentDesc || node.hintText || node.tooltipText) ||
  (node.children ?? []).some((child) => child.visible !== false && announces(child))`,
    to: `  Boolean(node.text || node.contentDesc || node.hintText || node.tooltipText)`,
    expect: "a clickable row is not called unlabelled when its child carries the text",
  },
  {
    file: "scene.js",
    test: "scene",
    name: "hidden children are dropped without being counted",
    from: `    hidden += all.length - children.length`,
    to: `    hidden += 0`,
    expect: "a hidden node is excluded from the structure and still counted",
  },
  {
    file: "scene.js",
    test: "scene",
    name: "the palette tallies the diff against the parent instead of the colour on screen",
    from: `    addCount(backgrounds, analysed.background === null ? null : toHex(analysed.background))`,
    to: `    addCount(backgrounds, analysed.style.background)`,
    expect: "the palette is tallied by usage",
  },
  {
    file: "scene.js",
    test: "scene",
    name: "the contrast issue names the diffed background, not the measured one",
    from: `\${analysed.background === null ? "the surface" : toHex(analysed.background)}`,
    to: `\${analysed.style.background ?? "the surface"}`,
    expect: "a real contrast failure is found, with the ratio that was measured",
  },
  {
    file: "scene.js",
    test: "scene",
    name: "every glyph buys the large-text 3:1 rule",
    from: `      const large = glyph !== null && glyph >= 24`,
    to: `      const large = glyph !== null && glyph >= 0`,
    expect: "a real contrast failure is found, with the ratio that was measured",
  },
]

let passed = 0
for (const mutation of MUTATIONS) {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-mutate-"))
  try {
    cpSync(path.join(repo, "lib"), path.join(dir, "lib"), { recursive: true })
    cpSync(path.join(repo, "test"), path.join(dir, "test"), { recursive: true })
    cpSync(path.join(repo, "package.json"), path.join(dir, "package.json"))
    const file = path.join(dir, "lib", mutation.file)
    const source = readFileSync(file, "utf8")
    if (!source.includes(mutation.from)) {
      console.error(`FAIL  ${mutation.name}: MUTATION TARGET NOT FOUND — the test proves nothing`)
      process.exitCode = 1
      continue
    }
    writeFileSync(file, source.replace(mutation.from, mutation.to))
    const run = spawnSync(process.execPath, [path.join(dir, "test", `${mutation.test}.mjs`)], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DSH_MOBILECODE_DIR: dir },
    })
    const output = `${run.stdout}${run.stderr}`
    const died = run.status !== 0
    const named = output.includes(mutation.expect)
    if (died && named) {
      passed += 1
      console.log(`  ok  ${mutation.name}`)
    } else {
      // A red for the wrong reason is not evidence: say which half failed.
      console.error(`FAIL  ${mutation.name}: exited=${died} named-the-right-check=${named}`)
      const fails = output.split("\n").filter((line) => line.startsWith("FAIL"))
      if (fails.length > 0) console.error(`      caught instead by: ${fails.join(" | ")}`)
      process.exitCode = 1
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
console.log(`\n${passed} checks passed`)
