// Full deterministic loop with ONLY the plugin's own tools:
// device_run is skipped (app already installed); device_screen → device_input → device_screen.
import { pathToFileURL } from "node:url"

const pluginDir = "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
const serial = "emulator-5554"
const registered = { tools: [] }
const ctx = {
  provide() {},
  webServer: { register() { return () => {} }, registerUpgrade() { return () => {} } },
  tools: { register(tool) { registered.tools.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  effect(fn) { return fn() },
}
const plugin = await import(pathToFileURL(pluginDir + "/lib/index.js").href)
plugin.apply(ctx, {})
const byName = (n) => {
  const t = registered.tools.find((x) => (x.name ?? x.definition?.name) === n)
  return t.execute ?? t.definition?.execute
}

// 1. Launch the app (adb monkey through the plugin's own adb helper is overkill; use the plugin's key home first, then launch)
await byName("device_input")({ serial, action: "key", key: "home" })
await new Promise((r) => setTimeout(r, 800))

// 2. SEE: capture the launcher screen
const s1 = await byName("device_screen")({ serial, ocr: true })
const trach = s1.ocr.find((i) => /trachtenberg/i.test(i.text)) ?? s1.ui.find((i) => /trachtenberg/i.test(i.text))
if (!trach) { console.log("FAIL: Trachtenberg icon not found on launcher. OCR:", JSON.stringify(s1.ocr.map((i) => i.text))); process.exit(1) }
console.log(`SEE  : "Trachtenberg" @ ${JSON.stringify(trach.box ?? trach.bounds)}`)

// 3. ACT: tap its center via the plugin's own device_input
const box = trach.box ?? trach.bounds
const cx = Math.round((box[0] + box[2]) / 2)
const cy = Math.round((box[1] + box[3]) / 2)
const receipt = await byName("device_input")({ serial, action: "tap", x: cx, y: cy })
console.log(`ACT  : ${receipt.sent}`)
await new Promise((r) => setTimeout(r, 2500))

// 4. VERIFY: re-read the screen
const s2 = await byName("device_screen")({ serial, ocr: true })
console.log(`VERIFY: foreground=${s2.foreground}`)
const texts = (s2.ocr ?? []).map((i) => i.text).join(" | ")
console.log(`       OCR: ${texts}`)
const changed = /BEGIN|TRAIN FASTER|MENTAL MATH|WHAT SHOULD|CONTINUE/i.test(texts)
console.log(changed ? "PASS: app screen rendered (deterministic see→act→verify loop)" : "WARN: launcher still — app may take longer")
