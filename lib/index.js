/**
 * dsh-mobilecode — host half. Runs in the dsh web GUI's server process.
 *
 * Hot-pluggable DSH plugin (same architecture as @windypro-rourou/dsh-logcat):
 *   - DevicePreviewEngine (lib/device-preview.js) owns preview servers
 *     (serve-sim / serve-avd), Metro bundlers, and build-install-launch runs.
 *   - HTTP routes under /api/dsh-mobilecode — the browser pane's read/write
 *     surface (the mobilecode `server.devicePreview` group, renamed so it
 *     cannot collide with other plugins).
 *   - Agent tools device_run + device_detect — the mobilecode
 *     `tool/device-run` contract, with an explicit `directory` parameter
 *     because DSH tools have no session-location concept.
 *   - A system-prompt guidance section telling the agent these tools exist.
 *
 * All routes are loopback-only (the pane lives in the same browser).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import * as DeviceBuild from './device-build.js'
import { DevicePreviewEngine } from './device-preview.js'
import * as Setup from './setup.js'

export const name = 'mobilecode'
export const inject = ['webServer', 'tools', 'systemPrompt']
export const provide = ['mobilecode']

const SECTION_ORDER = 150

const API_BASE = '/api/dsh-mobilecode'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_TIMEOUT_MS = 30 * 60_000
const POLL_MS = 2000
const LOG_TAIL = 60
const BUSY = ['building', 'installing', 'launching']

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const host = req.headers?.host ?? ''
  const okAddress = address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.') || address.startsWith('127.')
  if (!okAddress) return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (hostUrl.hostname !== 'localhost' && !hostUrl.hostname.startsWith('127.')) return false
  return true
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

async function readBody(req, res) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) { writeJson(res, 413, { error: 'body too large' }); return undefined }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

/** A directory the caller asked for, or the configured/working default. */
function resolveDirectory(body, config) {
  if (typeof body?.directory === 'string' && body.directory !== '') return body.directory
  if (typeof config?.defaultDirectory === 'string' && config.defaultDirectory !== '') return config.defaultDirectory
  return process.cwd()
}

function makeRoutes(engine, config) {
  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return false }
    return true
  }
  const platformOf = (value) => (value === 'ios' || value === 'android' ? value : undefined)
  const routes = [
    // GET /api/dsh-mobilecode?directory=... → current info (platforms, servers, builds, bundler).
    {
      kind: 'exact',
      path: API_BASE,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const directory = url.searchParams.get('directory') ?? resolveDirectory({}, config)
        try {
          writeJson(res, 200, await engine.info({ directory }))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/start {directory?, platform} — start the preview server.
    {
      kind: 'exact',
      path: API_BASE + '/start',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req, res)
        if (body === undefined) return
        const platform = platformOf(body.platform)
        if (!platform) { writeJson(res, 400, { error: 'platform is required (ios|android)' }); return }
        try {
          writeJson(res, 200, await engine.start({ directory: resolveDirectory(body, config), platform }))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/stop {directory?, platform} — stop the preview server.
    {
      kind: 'exact',
      path: API_BASE + '/stop',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req, res)
        if (body === undefined) return
        const platform = platformOf(body.platform)
        if (!platform) { writeJson(res, 400, { error: 'platform is required (ios|android)' }); return }
        try {
          writeJson(res, 200, await engine.stop({ directory: resolveDirectory(body, config), platform }))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/run {directory?, platform, relaunch?} — build, install, launch.
    {
      kind: 'exact',
      path: API_BASE + '/run',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req, res)
        if (body === undefined) return
        const platform = platformOf(body.platform)
        if (!platform) { writeJson(res, 400, { error: 'platform is required (ios|android)' }); return }
        try {
          const directory = resolveDirectory(body, config)
          const info = await engine.runApp({ directory, platform, relaunch: body.relaunch === true })
          writeJson(res, 200, info)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/run/stop {directory?, platform} — cancel the build or quit the app.
    {
      kind: 'exact',
      path: API_BASE + '/run/stop',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req, res)
        if (body === undefined) return
        const platform = platformOf(body.platform)
        if (!platform) { writeJson(res, 400, { error: 'platform is required (ios|android)' }); return }
        try {
          writeJson(res, 200, await engine.stopApp({ directory: resolveDirectory(body, config), platform }))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/focus {directory?} — user switched to this directory: park others.
    {
      kind: 'exact',
      path: API_BASE + '/focus',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req, res)
        if (body === undefined) return
        try {
          writeJson(res, 200, await engine.focus({ directory: resolveDirectory(body, config) }))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // GET /api/dsh-mobilecode/welcome → { show, prompt } — first-run flag + the copy-paste AI prompt.
    {
      kind: 'exact',
      path: API_BASE + '/welcome',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const settings = Setup.readSettings()
        writeJson(res, 200, { show: settings.welcomeDismissed !== true, prompt: Setup.WELCOME_PROMPT })
      },
    },
    // POST /api/dsh-mobilecode/welcome/dismiss — never show the welcome window again.
    {
      kind: 'exact',
      path: API_BASE + '/welcome/dismiss',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        await readBody(req, res)
        Setup.writeSettings({ welcomeDismissed: true })
        writeJson(res, 200, { ok: true })
      },
    },
    // GET /api/dsh-mobilecode/doctor → [{name, ok, detail, fix?}] — plugin health check.
    {
      kind: 'exact',
      path: API_BASE + '/doctor',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          const checks = await Setup.runDoctor()
          writeJson(res, 200, { checks })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/doctor/fix {id} — auto-fix one failing check (e.g. paddleocr).
    {
      kind: 'exact',
      path: API_BASE + '/doctor/fix',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req, res)
        if (body === undefined) return
        if (typeof body.id !== 'string' || body.id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        try {
          writeJson(res, 200, await Setup.runFix(body.id))
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // GET /api/dsh-mobilecode/ocr → {installed, working, state, log} — PaddleOCR install state.
    {
      kind: 'exact',
      path: API_BASE + '/ocr',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          writeJson(res, 200, await Setup.ocrStatus())
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/ocr/install — kick off the one-click PaddleOCR install.
    {
      kind: 'exact',
      path: API_BASE + '/ocr/install',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        await readBody(req, res)
        try {
          writeJson(res, 200, Setup.startOcrInstall())
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // GET/POST /api/dsh-mobilecode/settings — persisted plugin settings.
    {
      kind: 'exact',
      path: API_BASE + '/settings',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, Setup.readSettings())
          return
        }
        if (method === 'POST') {
          const body = await readBody(req, res)
          if (body === undefined) return
          const allowed = ['defaultDirectory']
          const patch = {}
          for (const key of allowed) if (typeof body?.[key] === 'string' && body[key] !== '') patch[key] = body[key]
          writeJson(res, 200, Setup.writeSettings(patch))
          return
        }
        writeJson(res, 405, { error: 'method not allowed' })
      },
    },
  ]
  return routes
}

// ── agent tools ───────────────────────────────────────────────────────────────

const label = (platform) => (platform === 'ios' ? 'iOS' : 'Android')

/** The mobilecode BuildSummary → the strict DSH output schema. */
function summarize(info, targets, complete = true) {
  const builds = targets.flatMap((platform) => {
    const build = info.builds.find((item) => item.platform === platform)
    if (!build) return []
    const failed = build.status === 'failed'
    const out = {
      platform,
      status: build.status,
      log: failed || !complete ? build.log.slice(-LOG_TAIL) : [],
    }
    if (build.step !== undefined) out.step = build.step
    if (build.target !== undefined) out.target = build.target
    if (build.appID !== undefined) out.appID = build.appID
    if (build.error !== undefined) out.error = build.error
    return [out]
  })
  const out = { platforms: info.platforms, builds, complete }
  if (info.framework !== undefined) out.framework = info.framework
  if (info.bundler) {
    out.bundler = {
      status: info.bundler.status,
      log: info.bundler.status === 'exited' || !complete ? info.bundler.log.slice(-LOG_TAIL) : [],
    }
    if (info.bundler.url !== undefined) out.bundler.url = info.bundler.url
  }
  return out
}

function toModelOutput(output) {
  const lines = []
  if (output.framework) lines.push(`Framework: ${output.framework}`)
  if (output.builds.length === 0) lines.push('No app has been run yet.')
  for (const build of output.builds) {
    const detail = [build.appID, build.target && `target ${build.target}`].filter(Boolean).join(', ')
    const head = `${label(build.platform)}: ${build.status}${build.step ? ` (${build.step})` : ''}${detail ? ` — ${detail}` : ''}`
    lines.push(build.error ? `${head}\n  ${build.error}` : head)
    if (build.log.length > 0) lines.push(build.log.map((line) => `  | ${line}`).join('\n'))
  }
  if (output.bundler) {
    lines.push(`Metro: ${output.bundler.status}${output.bundler.url ? ` at ${output.bundler.url}` : ''}`)
    if (output.bundler.log.length > 0) lines.push(output.bundler.log.map((line) => `  | ${line}`).join('\n'))
  }
  if (!output.complete)
    lines.push('Timed out waiting for the run to finish; it is still in progress. Call again with action "status" to check on it.')
  return lines.join('\n')
}

function deviceRunTool(engine, config) {
  return defineTool({
    name: 'device_run',
    description: 'Build, install and launch the mobile app in this project on the iOS Simulator and Android Emulator, ' +
      'the same way the Play button in the device pane does, and wait for the result. ' +
      'Works for Expo (prebuild runs automatically), React Native (Metro is started for you) and plain native projects. ' +
      'Use it after creating or changing a mobile app to check that it builds and launches; when a build fails, ' +
      'the reported error and log tail say why, so fix that and run again. The user sees the app running in the device pane.',
    parameters: {
      action: {
        type: 'string',
        enum: ['run', 'stop', 'status'],
        description: 'run: build, install and launch the app, then wait for the result. ' +
          'stop: terminate the running app or cancel its build. status: report the current state without changing anything.',
      },
      platform: {
        type: 'string',
        enum: ['ios', 'android', 'all'],
        description: 'Which device to target. Defaults to all detected platforms.',
      },
      directory: {
        type: 'string',
        description: 'Absolute path to the mobile project to operate on. Required when the working directory is not the project root.',
      },
      timeout: {
        type: 'integer',
        description: `How long to wait for a run to finish, in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          framework: { type: 'string', enum: ['expo', 'react-native', 'native'] },
          platforms: {
            type: 'array',
            required: true,
            items: { type: 'string', enum: ['ios', 'android'] },
          },
          builds: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string', enum: ['ios', 'android'], required: true },
                status: { type: 'string', enum: ['idle', 'building', 'installing', 'launching', 'running', 'failed'], required: true },
                step: { type: 'string' },
                target: { type: 'string' },
                appID: { type: 'string' },
                error: { type: 'string' },
                log: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          bundler: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['starting', 'running', 'exited'], required: true },
              url: { type: 'string' },
              log: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          complete: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: toModelOutput(value ?? { platforms: [], builds: [], complete: true }) }],
    },
    async execute(args) {
      const wanted = args.platform ?? 'all'
      const directory = typeof args.directory === 'string' && args.directory !== '' ? args.directory : resolveDirectory({}, config)
      const info = await engine.info({ directory })
      const targets = wanted === 'all' ? info.platforms : [wanted]
      if (info.platforms.length === 0) {
        throw new Error('No iOS or Android project was found at or below this directory.')
      }
      const missing = targets.filter((platform) => !info.platforms.includes(platform))
      if (missing.length > 0) {
        throw new Error(`No ${label(missing[0])} project was found. Detected: ${info.platforms.map(label).join(', ')}.`)
      }

      if (args.action === 'status') return summarize(info, targets)

      if (args.action === 'stop') {
        let latest = info
        for (const platform of targets) latest = await engine.stopApp({ directory, platform })
        return summarize(latest, targets)
      }

      let latest = info
      for (const platform of targets) latest = await engine.runApp({ directory, platform })
      const timeout = Math.min(Math.max(args.timeout ?? DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS)
      const deadline = Date.now() + timeout
      const busy = (current) =>
        targets.some((platform) => {
          const build = current.builds.find((item) => item.platform === platform)
          return !!build && BUSY.includes(build.status)
        })
      while (busy(latest)) {
        if (Date.now() >= deadline) return summarize(latest, targets, false)
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        latest = await engine.info({ directory })
      }
      return summarize(latest, targets)
    },
  })
}

function deviceDetectTool(engine, config) {
  return defineTool({
    name: 'device_detect',
    description: 'Detect the mobile platforms (iOS Simulator / Android Emulator) in a directory and report what is ' +
      'attached: which platforms the project supports, its framework, and the first attached Android device. ' +
      'Call this before device_run to learn whether the project has an iOS and/or Android target and what to expect.',
    parameters: {
      directory: {
        type: 'string',
        description: 'Absolute path to the mobile project to inspect. Required when the working directory is not the project root.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          directory: { type: 'string', required: true },
          platforms: {
            type: 'array',
            required: true,
            items: { type: 'string', enum: ['ios', 'android'] },
          },
          framework: { type: 'string', enum: ['expo', 'react-native', 'native'] },
          device: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { directory: '', platforms: [] }
        const lines = [`Directory: ${v.directory}`, `Platforms: ${v.platforms.length > 0 ? v.platforms.map(label).join(', ') : '(none detected)'}`]
        if (v.framework) lines.push(`Framework: ${v.framework}`)
        if (v.device) lines.push(`Android device: ${v.device}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const directory = typeof args.directory === 'string' && args.directory !== '' ? args.directory : resolveDirectory({}, config)
      const projects = DeviceBuild.findProjects(directory)
      const info = await engine.info({ directory })
      let device
      try { device = await DeviceBuild.androidDevice() } catch { /* no adb */ }
      const out = {
        directory,
        platforms: projects.map((project) => project.platform),
        framework: info.framework,
      }
      if (device) out.device = device
      return out
    },
  })
}

/** First attached (or explicit) Android device serial; throws a friendly error when none. */
async function requireAndroidDevice(serial) {
  const target = serial && serial !== '' ? serial : await DeviceBuild.androidDevice()
  if (!target) throw new Error('No Android device is attached. Boot one (device_run on an Android project does it automatically), or pass a serial.')
  return target
}

/** Common key names → Android keycode. Anything else can be passed as a raw keycode integer. */
const KEYCODES = {
  back: 4, home: 3, menu: 82, recents: 187, app_switch: 187, enter: 66, tab: 61, space: 62,
  delete: 67, backspace: 67, escape: 111, search: 84, camera: 27, power: 26, volume_up: 24,
  volume_down: 25, dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22, wakeup: 224,
  sleep: 223, dial: 5, endcall: 6, clear: 28,
}

function deviceInputTool() {
  return defineTool({
    name: 'device_input',
    description: 'Send input to an attached Android device: tap at pixel coordinates (from device_screen), swipe, type text, ' +
      'or press a hardware key. Coordinates are ABSOLUTE physical pixels — the same space device_screen returns, so take ' +
      'the center of an OCR/UI box ((x1+x2)/2, (y1+y2)/2). Works for native, Compose, React Native and Expo apps.',
    parameters: {
      serial: {
        type: 'string',
        description: 'Android device serial. Omit to use the first attached device.',
      },
      action: {
        type: 'string',
        enum: ['tap', 'swipe', 'text', 'key'],
        description: 'What to send: tap (x,y), swipe (x1,y1 → x2,y2, optional duration ms), text (ASCII, spaces ok), or key (named key or raw keycode).',
      },
      x: { type: 'integer', description: 'Pixel X for tap, or swipe start X.' },
      y: { type: 'integer', description: 'Pixel Y for tap, or swipe start Y.' },
      x2: { type: 'integer', description: 'Swipe end X (action=swipe only).' },
      y2: { type: 'integer', description: 'Swipe end Y (action=swipe only).' },
      duration: { type: 'integer', description: 'Swipe duration in ms (default 200).' },
      text: { type: 'string', description: 'Text to type (action=text; ASCII only, spaces supported).' },
      key: { type: 'string', description: 'Key name (back, home, enter, tab, delete, volume_up, …) or a raw keycode integer (action=key).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          action: { type: 'string', required: true },
          sent: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', action: '', sent: '' }
        return [{ type: 'text', text: `Sent ${v.action} (${v.sent}) to ${v.serial}` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const action = args.action ?? 'tap'
      const adbArgs = (shell) => ['-s', serial, 'shell', ...shell]
      switch (action) {
        case 'tap': {
          if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new Error('action=tap requires x and y (integer pixels).')
          await DeviceBuild.exec(DeviceBuild.adb(), adbArgs(['input', 'tap', String(args.x), String(args.y)])).exit
          return { serial, action, sent: `tap ${args.x},${args.y}` }
        }
        case 'swipe': {
          if (typeof args.x !== 'number' || typeof args.y !== 'number' || typeof args.x2 !== 'number' || typeof args.y2 !== 'number') {
            throw new Error('action=swipe requires x, y, x2, y2.')
          }
          const duration = args.duration ?? 200
          await DeviceBuild.exec(DeviceBuild.adb(), adbArgs(['input', 'swipe', String(args.x), String(args.y), String(args.x2), String(args.y2), String(duration)])).exit
          return { serial, action, sent: `swipe ${args.x},${args.y}→${args.x2},${args.y2} (${duration}ms)` }
        }
        case 'text': {
          if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('action=text requires a non-empty text string.')
          const escaped = args.text.replace(/\s/g, '%s')
          await DeviceBuild.exec(DeviceBuild.adb(), adbArgs(['input', 'text', escaped])).exit
          return { serial, action, sent: `text "${args.text}"` }
        }
        case 'key': {
          const raw = String(args.key ?? '')
          const code = /^\d+$/.test(raw) ? Number(raw) : KEYCODES[raw.toLowerCase()]
          if (!code) throw new Error(`unknown key "${raw}" — use a name from ${Object.keys(KEYCODES).join(', ')} or a raw keycode integer.`)
          await DeviceBuild.exec(DeviceBuild.adb(), adbArgs(['input', 'keyevent', String(code)])).exit
          return { serial, action, sent: `key ${raw} (${code})` }
        }
        default:
          throw new Error(`unknown action "${action}" — use tap, swipe, text or key.`)
      }
    },
  })
}

function deviceScreenTool(engine) {
  return defineTool({
    name: 'device_screen',
    description: 'See what is on an attached Android device right now: captures the screen as a PNG file, dumps the UI ' +
      'hierarchy (uiautomator) with pixel bounds, and OCRs the pixels with local PaddleOCR (text + coordinates). ' +
      'Use this after device_run to confirm the app rendered, to read what the app shows, and to drive UI flows by ' +
      'tapping the returned coordinates with device_input. Works for native, Compose, React Native and Expo apps; ' +
      'OCR also covers WebViews, games and other surfaces that expose no accessibility labels.',
    parameters: {
      serial: {
        type: 'string',
        description: 'Android device serial. Omit to use the first attached device.',
      },
      ocr: {
        type: 'boolean',
        description: 'Whether to run PaddleOCR over the screenshot (default true). Set false when OCR is not needed — it can take a few seconds.',
      },
      directory: {
        type: 'string',
        description: 'Where to store the screenshot PNG (default: a temp directory). The path is returned so a multimodal model can read it.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          screenshot: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          foreground: { type: 'string' },
          ui: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                resourceId: { type: 'string' },
                bounds: { type: 'array', items: { type: 'integer' } },
              },
            },
          },
          ocr: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                confidence: { type: 'number' },
                box: { type: 'array', items: { type: 'integer' } },
              },
            },
          },
          ocrError: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '' }
        const lines = [`Device: ${v.serial}${v.foreground ? ` — foreground: ${v.foreground}` : ''}`]
        if (v.screenshot) lines.push(`Screenshot: ${v.screenshot}${v.width ? ` (${v.width}x${v.height})` : ''}`)
        if (v.ocrError) lines.push(`OCR unavailable: ${v.ocrError}`)
        if (v.ui && v.ui.length > 0) {
          lines.push('UI hierarchy:')
          for (const item of v.ui.slice(0, 40)) {
            const where = item.bounds ? ` @${item.bounds.join(',')}` : ''
            lines.push(`  - ${item.text}${item.resourceId ? ` [${item.resourceId}]` : ''}${where}`)
          }
          if (v.ui.length > 40) lines.push(`  … and ${v.ui.length - 40} more`)
        }
        if (v.ocr && v.ocr.length > 0) {
          lines.push('OCR (local PaddleOCR):')
          for (const item of v.ocr.slice(0, 40)) {
            lines.push(`  - "${item.text}" (${Math.round(item.confidence * 100)}%) box=${item.box.join(',')}`)
          }
          if (v.ocr.length > 40) lines.push(`  … and ${v.ocr.length - 40} more`)
        }
        if (!v.ui?.length && !v.ocr?.length) lines.push('No text found on screen.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const png = await DeviceBuild.screenCapture(serial, args.directory)
      const [ui, foreground, size] = await Promise.all([
        DeviceBuild.uiDump(serial).catch(() => []),
        DeviceBuild.foregroundActivity(serial).catch(() => undefined),
        captureScreenSize(serial),
      ])
      const out = { serial, ui, ...(foreground ? { foreground } : {}) }
      if (png) {
        out.screenshot = png
        if (size) { out.width = size.width; out.height = size.height }
      }
      if (args.ocr !== false) {
        if (!png) {
          out.ocrError = 'screenshot failed'
        } else if (!DeviceBuild.ocrPython()) {
          out.ocrError = 'PaddleOCR venv not found (install with: py -3.12 -m venv ~/.dsh/mobilecode/ocr-venv; pip install paddleocr==3.7.0 paddlepaddle==3.3.1 numpy<2)'
        } else {
          const ocr = await DeviceBuild.ocrImage(png).catch(() => [])
          if (ocr.length > 0) out.ocr = ocr
          else out.ocrError = 'PaddleOCR returned no text (or failed silently)'
        }
      }
      return out
    },
  })
}

async function captureScreenSize(serial) {
  const output = await DeviceBuild.capture(DeviceBuild.adb(), ['-s', serial, 'shell', 'wm', 'size'])
  const match = /Physical size:\s*(\d+)x(\d+)/.exec(output)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined
}

function deviceLogTool(engine) {
  return defineTool({
    name: 'device_log',
    description: 'Read logs from an attached Android device: logcat (main buffer, or crash/events/kernel), optionally ' +
      'filtered to an app package, plus the kernel dmesg. Call it when a run fails or an app misbehaves to see crashes, ' +
      'exceptions and system messages. The crash buffer holds the last fatal exceptions; kernel (dmesg) needs adb root ' +
      '(available on emulators).',
    parameters: {
      serial: {
        type: 'string',
        description: 'Android device serial. Omit to use the first attached device.',
      },
      buffer: {
        type: 'string',
        enum: ['main', 'crash', 'events', 'kernel', 'all'],
        description: 'Which log buffer to read: main (default), crash (fatal exceptions/ANRs), events (activity lifecycle), kernel (dmesg), or all.',
      },
      filter: {
        type: 'string',
        description: 'Case-insensitive substring to keep only matching lines, e.g. an app package or an error tag.',
      },
      lines: {
        type: 'integer',
        description: 'How many log lines to read (default 200, maximum 2000).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          buffer: { type: 'string', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', buffer: 'main', lines: [] }
        const head = `Device ${v.serial} — ${v.buffer} buffer${v.lines.length > 0 ? ` (${v.lines.length} lines)` : ' (empty)'}`
        return [{ type: 'text', text: v.lines.length > 0 ? `${head}\n${v.lines.join('\n')}` : head }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const buffer = args.buffer ?? 'main'
      const lines = Math.min(Math.max(args.lines ?? 200, 1), 2000)
      let output
      if (buffer === 'kernel') {
        output = await DeviceBuild.dmesg(serial).catch(() => '')
      } else {
        output = await DeviceBuild.logcat(serial, { buffer, lines, filter: args.filter })
      }
      const all = output.split('\n').filter((line) => line !== '')
      const list = buffer === 'kernel' || !args.filter ? all : all.filter((line) => line.toLowerCase().includes(String(args.filter).toLowerCase()))
      return { serial, buffer, lines: list.slice(-lines), ...(all.length > lines ? { truncated: true } : {}) }
    },
  })
}

function deviceStatusTool(engine) {
  return defineTool({
    name: 'device_status',
    description: 'One normalized snapshot of the mobile environment: attached Android devices, configured AVDs, whether an ' +
      'emulator binary exists, and what this plugin currently runs (preview servers, Metro bundlers, builds per directory ' +
      'with status/app/activity). Call this when you need to know what is attached and what is running before acting.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          devices: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                serial: { type: 'string', required: true },
                state: { type: 'string', required: true },
              },
            },
          },
          avds: { type: 'array', items: { type: 'string' } },
          emulator: { type: 'string' },
          runs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                directory: { type: 'string', required: true },
                platform: { type: 'string', enum: ['ios', 'android'], required: true },
                status: { type: 'string', required: true },
                appID: { type: 'string' },
                step: { type: 'string' },
              },
            },
          },
          metro: {
            type: 'object',
            additionalProperties: false,
            properties: {
              directory: { type: 'string' },
              status: { type: 'string' },
              url: { type: 'string' },
            },
          },
          servers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string', enum: ['ios', 'android'], required: true },
                status: { type: 'string', required: true },
                url: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value ?? {}
        const lines = ['Devices:']
        if (!v.devices || v.devices.length === 0) lines.push('  (none attached)')
        for (const device of v.devices ?? []) lines.push(`  - ${device.serial} [${device.state}]`)
        lines.push(`AVDs: ${v.avds && v.avds.length > 0 ? v.avds.join(', ') : '(none)'}${v.emulator ? ` (emulator: ${v.emulator})` : ''}`)
        lines.push('Runs:')
        if (!v.runs || v.runs.length === 0) lines.push('  (nothing running)')
        for (const run of v.runs ?? []) lines.push(`  - ${run.directory} ${run.platform}: ${run.status}${run.step ? ` (${run.step})` : ''}${run.appID ? ` — ${run.appID}` : ''}`)
        if (v.metro) lines.push(`Metro: ${v.metro.status}${v.metro.url ? ` at ${v.metro.url}` : ''}${v.metro.directory ? ` (${v.metro.directory})` : ''}`)
        if (v.servers && v.servers.length > 0) {
          lines.push('Preview servers:')
          for (const server of v.servers) lines.push(`  - ${server.platform}: ${server.status}${server.url ? ` ${server.url}` : ''}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const info = await engine.info({ directory: resolveDirectory({}, {}) }).catch(() => undefined)
      const [devices, avds] = await Promise.all([
        DeviceBuild.devices().catch(() => []),
        DeviceBuild.androidAvds().catch(() => []),
      ])
      const emulator = DeviceBuild.emulatorBinary()
      const out = { devices, avds, ...(emulator ? { emulator } : {}) }
      if (info) {
        const runs = []
        for (const build of info.builds ?? []) {
          if (build.status === 'idle' || build.status === 'failed') continue
          const run = { directory: build.directory ?? '', platform: build.platform, status: build.status }
          if (build.appID) run.appID = build.appID
          if (build.step) run.step = build.step
          runs.push(run)
        }
        if (runs.length > 0) out.runs = runs
        if (info.bundler && info.bundler.status !== 'exited') {
          out.metro = { status: info.bundler.status }
          if (info.bundler.url) out.metro.url = info.bundler.url
          if (info.bundler.directory) out.metro.directory = info.bundler.directory
        }
        if (info.servers && info.servers.length > 0) out.servers = info.servers
      }
      return out
    },
  })
}

/** The system-prompt guidance section: what the agent can do and when to do it. */
function guidance() {
  return [
    'The dsh-mobilecode plugin is available: it can detect mobile projects, run preview servers (iOS Simulator / Android Emulator),',
    'and build-install-launch apps the way the device pane\'s Play button does.',
    '',
    'Tools:',
    '- device_detect: find which platforms (ios/android) a directory supports and what is attached. Use it first when a project may be mobile.',
    '- device_run: build, install and launch (action "run"), cancel/stop (action "stop"), or report state (action "status").',
    '  Pass directory when the project root is not the working directory. A run takes minutes; use a generous timeout.',
    '- device_screen: capture the attached Android screen as a PNG plus the UI hierarchy and OCR text, so you can see what',
    '  the app shows and tap by pixel coordinates. Call it after a run to confirm the app rendered, and to drive UI flows.',
    '- device_input: tap/swipe/type/press on the attached Android device at ABSOLUTE pixel coordinates (take the center of a',
    '  device_screen box: x=(x1+x2)/2, y=(y1+y2)/2). The control loop is device_screen → device_input → device_screen.',
    '- device_log: read device logs (logcat main/crash/events, kernel dmesg). Call it when a run fails or an app misbehaves.',
    '- device_status: one normalized snapshot of attached devices, AVDs, running/parked projects, Metro and preview servers.',
    '',
    'Expo and React Native projects are handled automatically: expo prebuild runs when needed, Metro starts for you,',
    'and the app is installed and launched on the booted simulator/emulator. Failed builds report the error and a log tail.',
  ].join('\n')
}

// ── mount ─────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  Setup.ensureHome()
  Setup.writeOcrReadme()

  const resolve = () => ({
    enabled: config?.enabled ?? true,
    announceToAgent: config?.announceToAgent ?? true,
  })

  const engine = new DevicePreviewEngine()
  const handle = {
    engine,
    status: () => ({
      directories: [...new Set([...engine.builds.keys()].map((key) => key.split('\0')[0]))],
      servers: [...engine.servers.keys()],
      bundlers: [...engine.bundlers.keys()],
      builds: [...engine.builds.keys()],
    }),
  }
  if (typeof ctx.provide === 'function') ctx.provide('mobilecode', handle)
  else ctx.mobilecode = handle

  const routes = makeRoutes(engine, config)
  let disposeRoutes
  let disposeTools
  let disposeSection

  const sync = () => {
    const value = resolve()
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-mobilecode',
        order: SECTION_ORDER,
        text: guidance,
      })
    }
    disposeRoutes = ctx.effect(() => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-mobilecode: routes')
    disposeTools = ctx.effect(() => {
      const disposers = [
        deviceRunTool(engine, config),
        deviceDetectTool(engine, config),
        deviceScreenTool(engine),
        deviceLogTool(engine),
        deviceStatusTool(engine),
        deviceInputTool(),
      ].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-mobilecode: tools')
  }

  ctx.effect(() => () => {
    void engine.dispose()
  }, 'dsh-mobilecode: engine')

  sync()
  return sync
}
