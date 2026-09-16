/**
 * dsh-mobilecode — preview gallery tests (T5).
 * Discovery/staleness/args are pure-fixture; the HTTP contract is driven
 * against the mounted plugin (stub ctx), tool registration asserted, and the
 * render route's guard/validation paths checked WITHOUT running Gradle
 * (unknown selectors reject before spawn; the one live Gradle render is an
 * explicit opt-in: node test/preview-gallery.mjs --live).
 *
 * Run: node test/preview-gallery.mjs [--live]
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import process from "node:process"

const here = path.dirname(fileURLToPath(import.meta.url))
const { discoverPreviewTests, renderState, buildRenderArgs, previewSupportStatus, inputsFingerprint, manifestPathFor, failurePathFor } =
  await import(pathToFileURL(path.join(here, "..", "lib", "preview-gallery.js")).href)

let passed = 0
const ok = (cond, name) => { if (cond) { passed += 1; console.log("  ok  " + name) } else { console.error(`FAIL  ${name}`); process.exitCode = 1 } }

// ── fixture app ───────────────────────────────────────────────────────────────
const app = mkdtempSync(path.join(tmpdir(), "mc-gallery-"))
writeFileSync(path.join(app, "settings.gradle.kts"), 'rootProject.name = "Demo"\ninclude(":app")\n', "utf8")
writeFileSync(path.join(app, "gradlew"), "", "utf8")
writeFileSync(path.join(app, "gradlew.bat"), "", "utf8")
const src = path.join(app, "app", "src", "screenshotTest", "kotlin", "com", "demo")
mkdirSync(src, { recursive: true })
writeFileSync(path.join(src, "GalleryTest.kt"), `package com.demo

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest

class GalleryTest {
    @PreviewTest
    @Preview(name = "Row A", showBackground = true, widthDp = 360)
    @Composable
    fun rowA() {}

    // NOT a preview test (no @PreviewTest) — must not be discovered
    @Composable
    fun helper() {}
}

class OtherTest {
    @PreviewTest
    @Preview(name = "Col B", widthDp = 200.0)
    @Composable
    fun colB() {}
}
`, "utf8")

const entries = discoverPreviewTests(app)
ok(entries.length === 2, `discovery finds exactly the 2 @PreviewTest methods (got ${entries.length})`)
const cleanWarnings = []
discoverPreviewTests(app, cleanWarnings)
ok(cleanWarnings.length === 0, "no warnings for supported single-line layout")

// unsupported shape must be SURFACED as a warning, never silently dropped (audit low)
const app2 = mkdtempSync(path.join(tmpdir(), "mc-gallery2-"))
writeFileSync(path.join(app2, "settings.gradle.kts"), 'rootProject.name = "D"\ninclude(":app")\n', "utf8")
writeFileSync(path.join(app2, "gradlew"), "", "utf8")
const src2 = path.join(app2, "app", "src", "screenshotTest", "kotlin")
mkdirSync(src2, { recursive: true })
writeFileSync(path.join(src2, "Multi.kt"), `package p

class MultiTest {
    @PreviewTest
    @Preview(
        name = "Wrapped",
        widthDp = 360
    )
    fun wrapped() {}
}
`, "utf8")
const w2 = []
const e2 = discoverPreviewTests(app2, w2)
ok(e2.length === 0 && w2.length === 1 && w2[0].includes("multi-line"), "multi-line @Preview( not discovered → surfaced as warning")
ok(entries[0]?.fqClass === "com.demo.GalleryTest" && entries[0]?.method === "rowA" && entries[0]?.previewName === "Row A" && entries[0]?.widthDp === 360, "entry shape: fqClass/method/previewName/widthDp")
ok(entries[1]?.className === "OtherTest" && entries[1]?.widthDp === 200, "second class discovered, float widthDp parses")
ok(buildRenderArgs(entries[0]).join("|") === ":app:updateDebugScreenshotTest|--tests|com.demo.GalleryTest.rowA|--console=plain", "render args array exact (no shell string)")
ok(previewSupportStatus(app).wrapper && previewSupportStatus(app).screenshotTest, "support status: wrapper + source")
ok(!previewSupportStatus(mkdtempSync(path.join(tmpdir(), "mc-nogeo-"))).wrapper, "non-gradle dir → wrapper false")

// ── render state / freshness (manifest-based; audit §4 — mtime alone is NOT currency) ─
const manifestDir = mkdtempSync(path.join(tmpdir(), "mc-manifest-"))
const noRender = renderState(app, entries[0], { manifestDir })
ok(noRender.rendered === false && noRender.freshness === "never_rendered", "no PNG → never_rendered, stale")
const refDir = path.join(app, "app", "src", "screenshotTestDebug", "reference", "com", "demo", "GalleryTest")
mkdirSync(refDir, { recursive: true })
const png = path.join(refDir, "rowA_Row A_deadbeef_0.png")
const srcFile = path.join(src, "GalleryTest.kt")
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
let st = renderState(app, discoverPreviewTests(app)[0], { fingerprint: inputsFingerprint(app), manifestDir })
ok(st.rendered === true && st.freshness === "unknown" && st.stale === true, "PNG without manifest → freshness unknown (never claims current)")

// fingerprint must cover SHARED sources and build config, not just the preview file
const tokDir = path.join(app, "app", "src", "main", "kotlin")
mkdirSync(tokDir, { recursive: true })
const tokFile = path.join(tokDir, "DesignTokens.kt")
writeFileSync(tokFile, "val Brand = E63E3E\n", "utf8")
const fp0 = inputsFingerprint(app)
ok(inputsFingerprint(app) === fp0, "fingerprint stable between edits")
writeFileSync(tokFile, "val Brand = changed\n", "utf8")
ok(inputsFingerprint(app) !== fp0, "shared-token change moves fingerprint")
const fp1 = inputsFingerprint(app)
writeFileSync(path.join(app, "app", "build.gradle.kts"), "// build changed\n", "utf8")
ok(inputsFingerprint(app) !== fp1, "build-config change moves fingerprint")
const resDir = path.join(app, "app", "src", "main", "res", "font")
mkdirSync(resDir, { recursive: true })
const fp2 = inputsFingerprint(app)
writeFileSync(path.join(resDir, "chakra.ttf"), "font-bytes\n", "utf8")
ok(inputsFingerprint(app) !== fp2, "resource change moves fingerprint")

const e0 = discoverPreviewTests(app)[0]
const fpNow = inputsFingerprint(app)
writeFileSync(manifestPathFor(app, e0, manifestDir), JSON.stringify({ runId: "r1", at: new Date().toISOString(), inputsFingerprint: fpNow, renderer: "test" }), "utf8")
st = renderState(app, discoverPreviewTests(app)[0], { fingerprint: fpNow, manifestDir })
ok(st.freshness === "fresh_tracked_inputs" && st.stale === false, "manifest + matching fingerprint → fresh_tracked_inputs")
writeFileSync(tokFile, "val Brand = later\n", "utf8")
st = renderState(app, discoverPreviewTests(app)[0], { fingerprint: inputsFingerprint(app), manifestDir })
ok(st.freshness === "stale_inputs_changed" && st.stale === true, "token change after success → stale (PNG kept, labeled)")
writeFileSync(failurePathFor(app, discoverPreviewTests(app)[0], manifestDir), JSON.stringify({ at: new Date(Date.now() + 5000).toISOString(), exitCode: 124, failureKind: "timeout" }), "utf8")
st = renderState(app, discoverPreviewTests(app)[0], { fingerprint: inputsFingerprint(app), manifestDir })
ok(st.freshness === "last_run_failed", "failed/cancelled render invalidates success immediately (older PNG stays visible, labeled)")

// ── HTTP contract + tool registration (stub ctx against mounted copy) ────────
const pluginDir = process.env.DSH_MOBILECODE_DIR ?? "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const registered = { routes: [], tools: [] }
const ctx = {
  provide() {}, webServer: { register: (r) => registered.routes.push(r), registerUpgrade: () => () => {} },
  tools: { register: (t) => registered.tools.push(t) }, systemPrompt: { section: () => () => {} }, effect: (fn) => fn(),
  get: () => undefined,
}
const plugin = await import(pathToFileURL(path.join(pluginDir, "lib", "index.js")).href)
plugin.apply(ctx, { defaultDirectory: app })
ok(registered.tools.some((t) => t.name === "preview_gallery"), "tool preview_gallery registered")
const listRoute = registered.routes.find((r) => r.path === "/api/dsh-mobilecode/preview/list")
const renderRoute = registered.routes.find((r) => r.path === "/api/dsh-mobilecode/preview/render")
const imgRoute = registered.routes.find((r) => r.path === "/api/dsh-mobilecode/preview/image")
ok(!!listRoute && !!renderRoute && !!imgRoute, "preview routes registered")

async function call(route, { method = "GET", query = "", body, headers = {}, remoteAddress = "127.0.0.1", host = "localhost:3080" } = {}) {
  const req = { method, url: route.path + query, headers: { host, ...headers }, socket: { remoteAddress },
    [Symbol.asyncIterator]() { const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]; let i = 0; return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) } } }
  let status = 0; const hdrs = {}; let payload
  await route.handler(req, { writeHead(c, h = {}) { status = c; Object.assign(hdrs, h) }, end(t) { payload = t } })
  return { status, hdrs, payload }
}
const q = encodeURIComponent

{
  const r = await call(listRoute, { query: "?directory=" + q(app) })
  ok(r.status === 200 && JSON.parse(r.payload).entries.length === 2, "GET /preview/list → 2 entries")
  const r2 = await call(listRoute, { remoteAddress: "203.0.113.5", host: "evil.example", query: "?directory=" + q(app) })
  ok(r2.status === 403, "list loopback guard")
  const r3 = await call(renderRoute, { method: "POST", body: { directory: app, class: "com.evil.Runtime", method: "exec" } })
  ok(r3.status === 400, "render rejects non-discovered selector (whitelist) before any spawn")
  const r4 = await call(renderRoute, { method: "POST", body: { directory: app, class: "com.demo.GalleryTest", method: "rowA; rm -rf" } })
  ok(r4.status === 400, "render rejects identifier-shaped method (shell chars)")
  const r5 = await call(renderRoute, { method: "GET" })
  ok(r5.status === 405, "render GET → 405")
  const r6 = await call(renderRoute, { method: "POST", body: { directory: app, class: "com.demo.GalleryTest", method: "rowA" }, headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } })
  ok(r6.status === 403, "render browser cross-site → fence 403")
  const r7 = await call(imgRoute, { query: "?directory=" + q(app) + "&class=com.demo.GalleryTest&method=rowA" })
  ok(r7.status === 200 && r7.hdrs["content-type"] === "image/png" && r7.hdrs["x-content-type-options"] === "nosniff" && r7.hdrs["x-preview-freshness"] === "unknown" && r7.hdrs["x-preview-stale"] === "true", "image serves PNG with nosniff + freshness unknown header (no manifest → never claims current)")
  const r8 = await call(imgRoute, { query: "?directory=" + q(app) + "&class=com.demo.OtherTest&method=colB" })
  ok(r8.status === 404, "image 404 without recorded reference")
}

console.log(`\n${passed} checks passed`)

// ── opt-in live render: BLOCKED by scope (2026-09-15) ──────────────────────────
if (process.argv.includes("--live")) {
  console.log("--live: BLOCKED by scope — the live Gradle render requires the external reference app project and its build/device environment, which is off-limits. The offline discovery/staleness/manifest/wire coverage above is fully self-contained (synthetic fixture app).")
  process.exit(2)
}
