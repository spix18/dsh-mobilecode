/**
 * dsh-mobilecode — OpenPencil adapter tests (T7).
 * Runs WITHOUT the binary installed: the adapter must degrade, never break.
 * Focus: path confinement (traversal/symlink/absolute escape) and honest
 * status. If openpencil IS installed, one extra inspect round-trip runs.
 *
 * Run: node test/openpencil.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"

const here = path.dirname(fileURLToPath(import.meta.url))
const { probe, confinePath, inspect } = await import(pathToFileURL(path.join(here, "..", "lib", "openpencil.js")).href)

let passed = 0
let skipped = 0
const SKIP = "SKIP"
const ok = async (name, fn) => {
  try {
    if (await fn() === SKIP) { skipped += 1; console.log("  skip " + name); return }
    passed += 1; console.log("  ok  " + name)
  }
  catch (error) { console.error(`FAIL  ${name}: ${error.message}`); process.exitCode = 1 }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg) }

await ok("probe returns a boolean shape without throwing", async () => {
  const p = probe()
  must(typeof p.installed === "boolean", JSON.stringify(p))
})

const root = mkdtempSync(path.join(tmpdir(), "op-root-"))
const outside = mkdtempSync(path.join(tmpdir(), "op-outside-"))
const docPath = path.join(root, "designs", "app.fig")
mkdirSync(path.dirname(docPath), { recursive: true })
writeFileSync(docPath, "FIG")
const secret = path.join(outside, "secret.fig")
writeFileSync(secret, "SECRET")

await ok("inside-root file resolves", async () => {
  const r = confinePath(root, path.join(root, "designs", "app.fig"))
  must(r === realpathSync(docPath), r)
})
await ok("relative traversal rejected", async () => {
  try { confinePath(root, "../../Windows/win.ini"); } catch { return }
  throw new Error("traversal accepted")
})
await ok("absolute escape outside root rejected", async () => {
  try { confinePath(root, secret); } catch (e) { must(/escapes/.test(String(e.message)), e.message); return }
  throw new Error("escape accepted")
})
await ok("output confinement: new file inside root allowed, outside rejected", async () => {
  const inside = confinePath(root, path.join(root, "out", "frame.png"), { mustExist: false })
  must(inside.startsWith(realpathSync(root)), inside)
  try { confinePath(root, path.join(outside, "x.png"), { mustExist: false }); } catch { return }
  throw new Error("outside output accepted")
})
await ok("junction escape rejected for existing and output paths (audit P4-3)", async () => {
  // live junction: root/link -> outside/real — existsSync follows it, realpath resolves OUTSIDE
  const { execSync } = await import("node:child_process")
  const outsideReal = path.join(outside, "real-target")
  mkdirSync(outsideReal, { recursive: true })
  const link = path.join(root, "link")
  try { execSync(`cmd /c mklink /J "${link}" "${outsideReal}"`, { stdio: "ignore" }) } catch { return SKIP } // no junction rights → SKIPPED, not passed
  try {
    confinePath(root, link)
    throw new Error("existing-path junction escape ACCEPTED")
  } catch (e) { must(/escapes/.test(String(e.message)), e.message) }
  try {
    confinePath(root, path.join(link, "deeper", "out.png"), { mustExist: false })
    throw new Error("output-path-through-junction escape ACCEPTED")
  } catch (e) { must(/escapes/.test(String(e.message)), e.message) }
  // broken junction: link2 -> outside/nonexistent (mklink /J allows missing targets)
  const brokenLink = path.join(root, "link2")
  try { execSync(`cmd /c mklink /J "${brokenLink}" "${path.join(outside, "gone-target")}"`, { stdio: "ignore" }) } catch { return SKIP }
  let rejected = false
  try { confinePath(root, brokenLink) } catch (e) { rejected = true }
  must(rejected, "broken junction accepted for existing path")
  let rejectedOut = false
  try { confinePath(root, path.join(brokenLink, "out.png"), { mustExist: false }) } catch { rejectedOut = true }
  must(rejectedOut, "broken junction accepted for output path")
})
await ok("inspect rejects non-.fig", async () => {
  const png = path.join(root, "a.png")
  writeFileSync(png, "x")
  try { await inspect(png, root) } catch (e) { must(/\.fig/.test(e.message), e.message); return }
  throw new Error("accepted non-fig")
})
await ok("inspect on missing binary fails gracefully or works (never throws uncaught)", async () => {
  const r = await inspect(docPath, root)
  must(r.status === "passed" || r.status === "failed", r.status)
})

console.log(`\n${passed} passed, ${skipped} skipped`)
if (skipped > 0) console.log("NOTE: skipped junction checks are NOT counted as verified")
