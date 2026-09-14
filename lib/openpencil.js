/**
 * dsh-mobilecode — OpenPencil narrow adapter (T7/Feature D).
 *
 * OpenPencil is a design EDITOR whose CLI exports PNG/JPG/WEBP/SVG/JSX/HTML
 * (verified against openpencil.dev/reference/cli, 2026-09-14). Its exports are
 * web-oriented — this adapter NEVER claims native Compose export. Value here:
 * frame → PNG reference into the comparison workspace + design-token
 * inspection (`variables --json`).
 *
 * Safety:
 *  - optional: nothing in this module runs at plugin load; absence of the
 *    binary degrades to a status report (base plugin unaffected);
 *  - every path is confined to an explicitly allowed project root
 *    (realpath-based: no traversal through .. or symlinks);
 *  - CLI called with argument arrays only; no shell; no network calls;
 *  - output goes to a caller-invisible temp location inside the store, never
 *    next to the user's design file.
 */

import { existsSync, lstatSync, realpathSync, mkdirSync } from "node:fs"
import path from "node:path"
import * as DeviceBuild from "./device-build.js"

const CLI = "openpencil"
const DOC_TIMEOUT_MS = 60_000

export function probe() {
  const resolved = DeviceBuild.resolveExecutable(CLI)
  return { installed: resolved !== undefined && resolved !== null && resolved !== "", resolved: resolved ?? undefined }
}

/** Run the CLI with an argument array; bounded output + timeout.
 * Uses DeviceBuild.launch (audit P4-2): npm installs resolve to openpencil.cmd,
 * which bare spawn() refuses with EINVAL on Windows. */
function runCli(args, { timeoutMs = DOC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = DeviceBuild.launch(DeviceBuild.resolveExecutable(CLI) ?? CLI, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    let truncated = false
    const grab = (chunk, which) => {
      if (out.length + err.length > 2_000_000) { truncated = true; return }
      if (which === "out") out += chunk; else err += chunk
    }
    child.stdout.on("data", (c) => grab(c, "out"))
    child.stderr.on("data", (c) => grab(c, "err"))
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeoutMs)
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e), truncated }) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, truncated }) })
  })
}

/**
 * Confine a caller-supplied file path inside `root` (realpath-based).
 * Returns the resolved absolute path or throws with an actionable reason.
 */
export function confinePath(root, target, { mustExist = true } = {}) {
  if (typeof target !== "string" || target.trim() === "") throw new Error("path is required")
  const abs = path.resolve(root, target)
  let realRoot
  let realTarget
  try { realRoot = realpathSync(root) } catch { throw new Error(`allowed root not found: ${root}`) }
  if (mustExist) {
    try { realTarget = realpathSync(abs) } catch { throw new Error(`file not found: ${target}`) }
  } else {
    // for outputs the file may not exist yet: realpath the nearest existing ancestor.
    // audit P4-3: existsSync follows reparse points — a BROKEN junction returns false
    // and its name would be re-joined unresolved, escaping root. Resolve any
    // symlink/junction component through realpath instead of keeping its name.
    let cursor = abs
    const missing = []
    for (;;) {
      let st
      try { st = lstatSync(cursor) } catch { st = undefined }
      if (st !== undefined && st.isSymbolicLink()) {
        // a symlink/junction (incl. broken ones) must resolve inside root or be refused
        try { cursor = realpathSync(cursor); break } catch { throw new Error(`path escapes the allowed project root (broken link): ${target}`) }
      }
      if (st !== undefined) break // real existing entry
      missing.unshift(path.basename(cursor))
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    let base
    try { base = realpathSync(cursor) } catch { base = cursor }
    realTarget = path.join(base, ...missing)
  }
  const rel = path.relative(realRoot, realTarget)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the allowed project root: ${target}`)
  }
  return realTarget
}

/** Inspect a .fig document (pages + node tree, depth-bounded). */
export async function inspect(file, root) {
  const confined = confinePath(root, file)
  if (!/\.(fig)$/i.test(confined)) throw new Error("only .fig documents are inspected")
  const info = await runCli(["info", confined, "--json"])
  const pages = await runCli(["pages", confined, "--json"])
  return {
    status: info.code === 0 ? "passed" : "failed",
    info: safeJson(info.out),
    pages: safeJson(pages.out),
    exit: info.code,
    limitations: ["read-only inspection; the editor owns the document", "no remote/RPC mode used (file mode only)"],
  }
}

/** Export one frame/page of a .fig to PNG inside the store and return provenance. */
export async function exportFrame({ file, root, node, page, scale = 2, workspace }) {
  const confined = confinePath(root, file)
  if (!/\.(fig)$/i.test(confined)) throw new Error("only .fig documents are exported")
  if (node !== undefined && !/^[A-Za-z0-9:._-]{1,64}$/.test(String(node))) throw new Error("node id has an unexpected shape")
  const outDir = path.join(workspace.root, "openpencil")
  mkdirSync(outDir, { recursive: true })
  const outName = `${Date.now()}-${String(node ?? "page").replaceAll(/[^\w.-]/g, "_")}.png`
  const outPath = confinePath(workspace.root, path.join("openpencil", outName), { mustExist: false })
  const args = ["export", confined, "-f", "png", "-s", String(Math.min(Math.max(Number(scale) || 2, 1), 4)), "-o", outPath]
  if (node) args.push("--node", String(node))
  if (page) args.push("--page", String(page))
  const result = await runCli(args)
  if (result.code !== 0 || !existsSync(outPath)) {
    return { status: "failed", exit: result.code, stderrTail: String(result.err ?? "").split(/\r?\n/).slice(-6).join("\n") }
  }
  return { status: "passed", pngPath: outPath }
}

/** Design variables (tokens) from the document — returns them raw; mapping is a human step. */
export async function variables(file, root) {
  const confined = confinePath(root, file)
  const r = await runCli(["variables", confined, "--json"])
  return { status: r.code === 0 ? "passed" : "failed", variables: safeJson(r.out), exit: r.code }
}

function safeJson(text) {
  try { return JSON.parse(String(text ?? "").trim()) } catch { return undefined }
}
