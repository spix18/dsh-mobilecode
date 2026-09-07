// Quick live check of the new observability helpers (screen/ui/log/ocr) — not part of the suite.
import * as DeviceBuild from '../lib/device-build.js'

const serial = process.argv[2] ?? 'emulator-5554'
const failures = []
const check = (name, cond, extra) => {
  console.log(`${cond ? 'ok ' : 'FAIL'}  ${name}${cond ? '' : ` — ${extra ?? ''}`}`)
  if (!cond) failures.push(name)
}

const devices = await DeviceBuild.devices(serial)
check('devices() finds the serial', devices.some((d) => d.serial === serial), JSON.stringify(devices))

const avds = await DeviceBuild.androidAvds()
check('androidAvds() non-empty', avds.length > 0, JSON.stringify(avds))

const emulator = DeviceBuild.emulatorBinary()
check('emulatorBinary() resolves', !!emulator, String(emulator))

const png = await DeviceBuild.screenCapture(serial)
check('screenCapture() writes a PNG', !!png, String(png))

const ui = await DeviceBuild.uiDump(serial)
check('uiDump() returns labeled nodes', ui.length > 0, `got ${ui.length}`)

const fg = await DeviceBuild.foregroundActivity(serial)
check('foregroundActivity() resolves', !!fg, String(fg))

const main = await DeviceBuild.logcat(serial, { buffer: 'main', lines: 50 })
check('logcat(main) non-empty', main.length > 0, `got ${main.length} chars`)

const kernel = await DeviceBuild.dmesg(serial)
check('dmesg() non-empty (adb root on emulator)', kernel.length > 0, `got ${kernel.length} chars`)

const ocr = await DeviceBuild.ocrImage(png)
check('ocrImage() returns text', ocr.length > 0, JSON.stringify(ocr.slice(0, 3)))
check('ocrItem has box + confidence', ocr.every((i) => Array.isArray(i.box) && typeof i.confidence === 'number'))

console.log(failures.length === 0 ? '\nALL PASSED' : `\n${failures.length} FAILURES: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
