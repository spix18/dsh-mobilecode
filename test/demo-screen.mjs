// Live demo: device_screen through the real mounted-copy loader.
// Prints UI items + OCR items with pixel boxes so we can tap deterministically.
import { pathToFileURL } from "node:url"

const pluginDir = "C:\\Users\\Administrator\\.dsh\\profiles\\web\\node_modules\\dsh-mobilecode"
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
const screen = registered.tools.find((t) => (t.name ?? t.definition?.name) === "device_screen")
const out = await (screen.execute ?? screen.definition?.execute)({ serial: "emulator-5554" })
console.log(`foreground: ${out.foreground}  size: ${out.width}x${out.height}`)
console.log("--- UI (text + bounds) ---")
for (const item of out.ui.slice(0, 25)) console.log(`  ${item.text}${item.resourceId ? ` [${item.resourceId}]` : ""} @${item.bounds.join(",")}`)
console.log("--- OCR (text + confidence + box) ---")
for (const item of out.ocr.slice(0, 25)) console.log(`  "${item.text}" ${Math.round(item.confidence * 100)}% box=${item.box.join(",")}`)
