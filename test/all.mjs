// Runs the whole offline suite and prints one tally.
//
// Run: node test/all.mjs
//
// The allowlist is EXPLICIT on purpose. This repo also carries device-dependent
// tests — observability, agent-tools, smoke, tool-run — which hang for minutes
// waiting on an emulator that may not be attached. "Everything except those
// four" would silently stop covering a new test the day someone adds one, so a
// test file has to be listed here to run, and the day it is missing is the day
// someone asks why.
//
// DSH_MOBILECODE_DIR is forced to this repo: test/selfcheck.mjs otherwise
// defaults to the INSTALLED copy under the DSH profile and would happily verify
// a different build than the one in front of you.
import { spawnSync } from "node:child_process"
import path from "node:path"

const repo = path.resolve(import.meta.dirname, "..")

const OFFLINE = [
  "tokens",
  "client",
  "render",
  "routes",
  "mesh-routes",
  "reference-routes",
  "reference-diff",
  "reference-workspace",
  "preview-gallery",
  "config-matrix",
  "openpencil",
  "png-decode",
  "uitree",
  "list-rows",
  "mesh-hub",
  "input",
  "selfcheck",
  "setup",
  "pixels",
  "scene",
  "mutate",
]

let checks = 0
let failed = 0

for (const name of OFFLINE) {
  const file = path.join(repo, "test", `${name}.mjs`)
  const run = spawnSync(process.execPath, [file], {
    cwd: repo,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, DSH_MOBILECODE_DIR: repo },
  })
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`
  // Each file prints its own tally; the total is observed rather than assumed,
  // so a file that silently stops asserting shows up as a missing count.
  for (const match of output.matchAll(/(\d+)\s+checks?\s+passed/g)) checks += Number(match[1])
  const bad = run.status !== 0 || run.error
  if (bad) {
    failed += 1
    console.error(`FAIL  ${name}`)
    for (const line of output.split("\n").filter((l) => l.startsWith("FAIL") || l.includes("Error"))) {
      console.error(`      ${line.trim()}`)
    }
    if (run.error) console.error(`      ${run.error.message}`)
  } else {
    console.log(`  ok  ${name}`)
  }
}

console.log(`\n${OFFLINE.length - failed}/${OFFLINE.length} offline test files green · ${checks} checks`)
if (failed > 0) process.exitCode = 1
