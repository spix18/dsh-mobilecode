/**
 * dsh-mobilecode — LIVE co-op mesh verification (v0.8.0).
 *
 * Proves the thing the whole mesh exists for: two real emulator GUESTS talking
 * JSON through the host hub at 10.0.2.2. Compiles test/fixtures/mesh-probe/Mesh.java
 * with javac + d8, pushes mesh.dex to every attached emulator, then runs
 * join (guest) → link (host) → send (guest A) → poll (guest B) → send back →
 * poll back, asserting the payloads land with the right senders.
 *
 * Prereqs: GUI restarted with 0.8.0 mounted (the /mesh/* routes must exist)
 * and TWO booted emulators. Run:  node test/mesh-live.mjs [--build-only]
 */

import path from "node:path"
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as DeviceBuild from "../lib/device-build.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const probeDir = path.join(here, "fixtures", "mesh-probe")
const buildDir = path.join(probeDir, "build")
const dexPath = path.join(buildDir, "mesh.dex")
const HOST_BASE = "http://127.0.0.1:3080/api/dsh-mobilecode"
const GUEST_BASE = "http://10.0.2.2:3080/api/dsh-mobilecode"
const buildOnly = process.argv.includes("--build-only")

function findTool(envName, fixed, globRoot, globName, required) {
  const env = process.env[envName]
  if (env && existsSync(env)) return env
  if (fixed && existsSync(fixed)) return fixed
  try {
    const versions = readdirSync(globRoot).sort().reverse()
    for (const v of versions) {
      for (const candidate of [path.join(globRoot, v, "bin", globName), path.join(globRoot, v, globName)]) {
        if (existsSync(candidate)) return candidate
      }
    }
  } catch { /* no scan root */ }
  if (required) throw new Error(`${globName} not found — set ${envName}.`)
  return undefined
}

const javac = findTool("DSH_JAVAC",
  "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot\\bin\\javac.exe",
  "C:\\Program Files\\Eclipse Adoptium", "javac.exe", true)
const d8 = findTool("DSH_D8", undefined,
  path.join(DeviceBuild.androidSdk() ?? "C:\\Android\\Sdk", "build-tools"),
  process.platform === "win32" ? "d8.bat" : "d8", true)
console.log(`javac: ${javac}\nd8:    ${d8}`)

mkdirSync(buildDir, { recursive: true })
{
  // org.json lives in the Android framework, not the JDK — compile against the
  // platform android.jar as the boot classpath (source/target 8: the classic
  // trio old Gradle used; --release would forbid overriding the boot classpath).
  const sdk = DeviceBuild.androidSdk() ?? "C:\\Android\\Sdk"
  const platformsDir = path.join(sdk, "platforms")
  const platform = readdirSync(platformsDir)
    .filter((d) => /^android-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0]
  const androidJar = path.join(platformsDir, platform, "android.jar")
  if (!existsSync(androidJar)) throw new Error(`android.jar missing at ${androidJar}`)
  const compiled = await DeviceBuild.captureFull(javac,
    ["-source", "8", "-target", "8", "-Xlint:-options", "-bootclasspath", androidJar, "-d", buildDir, path.join(probeDir, "Mesh.java")],
    { timeoutMs: 120_000 })
  if (compiled.code !== 0) throw new Error(`javac failed:\n${compiled.out}\n${compiled.err}`)
  const dexed = await DeviceBuild.captureFull(d8, ["--min-api", "21", "--output", buildDir, path.join(buildDir, "Mesh.class")], { timeoutMs: 120_000 })
  if (dexed.code !== 0) throw new Error(`d8 failed:\n${dexed.out}\n${dexed.err}`)
  copyFileSync(path.join(buildDir, "classes.dex"), dexPath)
  console.log(`built ${dexPath} (${(await import("node:fs")).statSync(dexPath).size} bytes)`)
}
if (buildOnly) { console.log("build-only done"); process.exit(0) }

let passed = 0
const ok = (name, condition, detail) => {
  if (condition) { passed++; console.log(`  ok  ${name}`) }
  else { console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`); process.exitCode = 1 }
}

// 0. routes exist? (a 404 here means the GUI has not restarted onto 0.8.0 yet)
const probe = await fetch(`${HOST_BASE}/mesh/peers`).then((r) => r.status).catch(() => 0)
if (probe !== 401 && probe !== 200) {
  console.error(`FAIL  host /mesh/peers → ${probe}; restart the DSH GUI onto the 0.8.0 mount first.`)
  process.exit(1)
}

// 1. two guests (emulators preferred — a physical device may also be attached)
const rows = (await DeviceBuild.devices())
  .filter((r) => r.state === "device")
  .sort((a, b) => (b.serial.startsWith("emulator-") ? 1 : 0) - (a.serial.startsWith("emulator-") ? 1 : 0))
if (rows.length < 2) { console.error(`need two booted emulators, found ${rows.length}`); process.exit(1) }
const [s1, s2] = rows.map((r) => r.serial)
console.log(`guests: ${s1} + ${s2}`)
for (const serial of [s1, s2]) await DeviceBuild.adbRun(serial, ["push", dexPath, "/data/local/tmp/mesh.dex"])

/** Run one probe command inside a guest; returns the parsed JSON line.
 *  app_process: <start-dir> <start-class> are SEPARATE args ("/" + "Mesh");
 *  a glued "/Mesh" makes the runtime read the URL as the class name.
 *  Retries transient slirp SYN drops (observed on a busy host loopback); safe
 *  because /mesh/poll is cursor-based, so a replayed attempt sees same mail. */
async function guest(serial, mode, ...modeArgs) {
  // adb joins argv with spaces and the GUEST /system/bin/sh re-parses it, so
  // JSON bodies must arrive single-quoted (its double quotes would be eaten:
  // {"hello":true} -> {hello:true} -> JSONException inside the probe).
  const remoteArgs = modeArgs.map((a) => (a.startsWith("{") || a.startsWith("[") ? `'${a}'` : a))
  const backoffs = [0, 1000, 3000, 6000, 12000]
  let lastError = ""
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await new Promise((r) => setTimeout(r, backoffs[attempt]))
    try {
      const out = await DeviceBuild.adbRun(serial, [
        "shell", "CLASSPATH=/data/local/tmp/mesh.dex", "app_process", "/", "Mesh", GUEST_BASE, mode, ...remoteArgs,
      ])
      const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("{"))
      if (line) return JSON.parse(line)
      lastError = out.slice(0, 200)
    } catch (error) {
      lastError = String(error.message).slice(0, 200)
    }
    console.log(`      (${mode} on ${serial} attempt ${attempt + 1}/5 failed: ${lastError})`)
  }
  throw new Error(`probe ${mode} on ${serial} failed after ${backoffs.length} attempts: ${lastError}`)
}

// 2. join from inside both guests (serials pinned by the emulator itself)
const j1 = await guest(s1, "join", s1)
const j2 = await guest(s2, "join", s2)
ok("guest→host join works (both, real HTTP via 10.0.2.2)", j1.ok && j2.ok && j1.peer?.id && j2.peer?.id, JSON.stringify(j1).slice(0, 200))
console.log(`      ${j1.peer.name} (${s1}) ↔ ${j2.peer.name} (${s2})`)

// 3. link (host admin side)
const linked = await fetch(`${HOST_BASE}/mesh/link`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: j1.peer.id, token: j1.token, with: [j2.peer.name] }),
}).then((r) => r.json())
ok("link forms a session", linked.ok === true && linked.session?.id, JSON.stringify(linked))
const session = linked.session?.id

// 4. guest A sends → guest B polls
const stamp = Date.now()
const sent = await guest(s1, "send", j1.peer.id, j1.token, session, `{"hello":"from-${s1}","stamp":${stamp}}`)
ok("guest send → delivered 1", sent.ok === true && sent.delivered === 1, JSON.stringify(sent))
const gotB = await guest(s2, "poll", j2.peer.id, j2.token, "4000", "0")
const msgB = gotB.messages?.[0]
ok("guest poll receives the payload + sender", msgB?.from === j1.peer.name && msgB?.body?.stamp === stamp, JSON.stringify(gotB).slice(0, 250))

// 5. reverse direction
await guest(s2, "send", j2.peer.id, j2.token, session, `{"pong":true,"stamp":${stamp}}`)
const gotA = await guest(s1, "poll", j1.peer.id, j1.token, "4000", "0")
ok("reverse payload lands", gotA.messages?.[0]?.body?.pong === true, JSON.stringify(gotA).slice(0, 250))

console.log(`\n${passed}/5 mesh-live checks passed${process.exitCode ? " (WITH FAILURES)" : " — guest↔guest transport verified"}`)
