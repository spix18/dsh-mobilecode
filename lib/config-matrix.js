/**
 * dsh-mobilecode — bounded configuration matrix runner (T7m/Feature F).
 *
 * Drives REAL Android configuration (wm size/density overrides + font scale)
 * through the existing adb plumbing, captures evidence through the
 * reference-workspace capture store, and RESTORES the device to the state it
 * was FOUND in — including pre-existing overrides — on success, failure and
 * cancellation paths.
 *
 * Honesty rules:
 *  - requested config ≠ actual config: every case queries the device
 *    (wm size / wm density / settings get font_scale) and reports what it
 *    ACTUALLY ended up with;
 *  - scaling the browser pane is NOT an Android configuration change and is
 *    never represented here;
 *  - physical devices are refused without an explicit approval flag;
 *  - font behavior is read back from the platform — no linear px↔sp formula.
 */

import { tmpdir } from "node:os"
import * as DeviceBuild from "./device-build.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** emulator-* serials are safe to reconfigure; physical hardware is not, without approval. */
export function isEmulatorSerial(serial) {
  return typeof serial === "string" && serial.startsWith("emulator-")
}

/** Parse `wm size`/`wm density` output into effective value + whether an override was in place.
 * Keys are prefixed per-kind (sizeOverridden/densityOverridden) so spreading the two parses
 * cannot clobber each other's override flag (audit P4-1: both previously used `overridden`). */
export function parseDisplaySetting(out, kind) {
  const text = String(out ?? "")
  const flag = kind === "size" ? "sizeOverridden" : "densityOverridden"
  const override = kind === "size"
    ? /Override size:\s*(\d+)x(\d+)/.exec(text)
    : /Override density:\s*(\d+)/.exec(text)
  if (override) {
    return kind === "size"
      ? { [flag]: true, widthPx: Number(override[1]), heightPx: Number(override[2]) }
      : { [flag]: true, densityDpi: Number(override[1]) }
  }
  const physical = kind === "size"
    ? /Physical size:\s*(\d+)x(\d+)/.exec(text)
    : /Physical density:\s*(\d+)/.exec(text)
  if (!physical) return {}
  return kind === "size"
    ? { [flag]: false, widthPx: Number(physical[1]), heightPx: Number(physical[2]) }
    : { [flag]: false, densityDpi: Number(physical[1]) }
}

export async function readConfig(serial) {
  const [sizeOut, densityOut, fontOut] = await Promise.all([
    DeviceBuild.adbRun(serial, ["shell", "wm", "size"]).catch(() => ""),
    DeviceBuild.adbRun(serial, ["shell", "wm", "density"]).catch(() => ""),
    DeviceBuild.adbRun(serial, ["shell", "settings", "get", "system", "font_scale"]).catch(() => ""),
  ])
  const fontRaw = String(fontOut ?? "").trim()
  const fontScale = fontRaw === "" || fontRaw === "null" ? 1 : Number(fontRaw)
  return {
    ...parseDisplaySetting(sizeOut, "size"),
    ...parseDisplaySetting(densityOut, "density"),
    fontScale: Number.isFinite(fontScale) ? fontScale : 1,
  }
}

/** Put one device setting and VERIFY it took effect by reading back (bounded retries). */
async function setVerified(serial, apply, read, expect, approx = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await apply()
    await sleep(approx ? 600 : 300)
    const actual = await read()
    const ok = approx ? Math.abs(actual - expect) < 0.01 : actual === expect
    if (ok) return { ok: true, actual }
  }
  return { ok: false, actual: await read() }
}

async function applyCase(serial, c) {
  if (c.dims) {
    const r = await setVerified(serial,
      () => DeviceBuild.adbRun(serial, ["shell", "wm", "size", `${c.dims[0]}x${c.dims[1]}`]),
      async () => { const s = await readConfig(serial); return s.widthPx },
      c.dims[0])
    if (!r.ok) return { ok: false, step: "size", ...r }
  }
  if (c.density) {
    const r = await setVerified(serial,
      () => DeviceBuild.adbRun(serial, ["shell", "wm", "density", String(c.density)]),
      async () => { const s = await readConfig(serial); return s.densityDpi },
      c.density)
    if (!r.ok) return { ok: false, step: "density", ...r }
  }
  if (c.fontScale !== undefined) {
    const r = await setVerified(serial,
      () => DeviceBuild.adbRun(serial, ["shell", "settings", "put", "system", "font_scale", String(c.fontScale)]),
      async () => { const s = await readConfig(serial); return s.fontScale },
      c.fontScale, true)
    if (!r.ok) return { ok: false, step: "font_scale", ...r }
  }
  await sleep(700) // reflow settle before capture
  return { ok: true }
}

/** Restore to the FOUND state: re-apply pre-existing overrides, else reset. */
export async function restoreConfig(serial, snapshot) {
  const problems = []
  if (snapshot.widthPx !== undefined) {
    try {
      if (snapshot.sizeOverridden) await DeviceBuild.adbRun(serial, ["shell", "wm", "size", `${snapshot.widthPx}x${snapshot.heightPx}`])
      else await DeviceBuild.adbRun(serial, ["shell", "wm", "size", "reset"])
    } catch (e) { problems.push(`size restore failed: ${e}`) }
  }
  if (snapshot.densityDpi !== undefined) {
    try {
      if (snapshot.densityOverridden) await DeviceBuild.adbRun(serial, ["shell", "wm", "density", String(snapshot.densityDpi)])
      else await DeviceBuild.adbRun(serial, ["shell", "wm", "density", "reset"])
    } catch (e) { problems.push(`density restore failed: ${e}`) }
  }
  try { await DeviceBuild.adbRun(serial, ["shell", "settings", "put", "system", "font_scale", String(snapshot.fontScale ?? 1)]) } catch (e) { problems.push(`font_scale restore failed: ${e}`) }
  await sleep(700)
  const after = await readConfig(serial)
  const ok = problems.length === 0 &&
    (snapshot.widthPx === undefined || (after.widthPx === snapshot.widthPx && after.heightPx === snapshot.heightPx)) &&
    (snapshot.densityDpi === undefined || after.densityDpi === snapshot.densityDpi) &&
    Math.abs((after.fontScale ?? 1) - (snapshot.fontScale ?? 1)) < 0.01
  return { ok, problems, actualAfterRestore: after, snapshotWas: snapshot }
}

/**
 * Run a bounded matrix (1..8 cases — explicit expansion is the user's call,
 * no uncontrolled Cartesian product). Evidence goes through the capture store.
 */
export async function runMatrix({ serial, workspace, project, screen, cases, signal }) {
  if (!isEmulatorSerial(serial)) {
    return { status: "blocked", reason: "physical-device reconfiguration requires explicit approval; refusing", serial, reports: [] }
  }
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > 8) {
    return { status: "blocked", reason: "matrix must declare 1..8 risk-based cases", reports: [] }
  }
  const before = await readConfig(serial)
  // parse keys are already per-kind (sizeOverridden/densityOverridden) — no re-derivation
  const snapshot = { ...before }
  const reports = []
  const warnings = []
  let restoreResult = { ok: false, problems: ["not run"], actualAfterRestore: {} }
  try {
    for (const c of cases) {
      if (signal?.aborted) { reports.push({ id: c.id, status: "not_run", reason: "cancelled before case" }); continue }
      try {
        const applied = await applyCase(serial, c)
        if (!applied.ok) {
          reports.push({ id: c.id, status: "needs_review", step: applied.step, requested: c, actual: await readConfig(serial), warning: "setting did not verify — device reports a different actual configuration" })
          continue
        }
        const actual = await readConfig(serial)
        const png = await DeviceBuild.screenCapture(serial, tmpdir())
        const evidence = png ? workspace.capture({ project, screen, stateId: c.id, pngPath: png, device: { serial, ...actual } }) : undefined
        reports.push({
          id: c.id,
          requested: { dims: c.dims, density: c.density, fontScale: c.fontScale },
          actual,
          evidenceId: evidence?.id,
          evidenceFile: evidence?.file,
          status: evidence ? "captured" : "failed",
          ...(evidence ? {} : { error: "no screenshot produced" }),
        })
      } catch (error) {
        reports.push({ id: c.id, status: "failed", error: String(error instanceof Error ? error.message : error) })
      }
    }
  } finally {
    restoreResult = await restoreConfig(serial, snapshot)
    if (!restoreResult.ok) warnings.push(`device settings NOT fully restored — actual after restore: ${JSON.stringify(restoreResult.actualAfterRestore)} problems: ${restoreResult.problems.join("; ")}`)
  }
  return {
    status: signal?.aborted ? "blocked" : "completed",
    serial,
    snapshotBefore: snapshot,
    reports,
    // audit P4-4: restore travels as a real envelope field, not an array property
    // (reports.restore was dropped by JSON serialization)
    restore: restoreResult,
    warnings,
    limitations: ["theme light/dark and orientation rows are app-owned capabilities — this runner covers size/density/font-scale only", "font scale read back from the platform; no px↔sp formula applied"],
  }
}

/** Risk-based starter matrix for a phone app from the device's actual state. */
export function starterCases(actual) {
  const density = actual.densityDpi ?? 420
  const d = density / 160
  const heightPx = actual.heightPx ?? 2400
  const widthPx = actual.widthPx ?? Math.round(411 * d)
  const narrowW = Math.round(320 * d)
  const narrowH = Math.round((heightPx * narrowW) / widthPx)
  return [
    { id: "narrow-320dp-fs1.0", dims: [narrowW, narrowH], density, fontScale: 1 },
    { id: "base-fs2.0", dims: [widthPx, heightPx], density, fontScale: 2 },
  ]
}
