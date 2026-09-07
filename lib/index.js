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
import * as UiTree from './uitree.js'
import * as FrameSource from './frame-source.js'
import * as StreamAccess from './stream-access.js'
import { AndroidStreamHost, ROTATION_CYCLE } from './android-stream.js'
import { DevicePreviewEngine } from './device-preview.js'
import * as Setup from './setup.js'
import { registerMobileSkill } from './skill.js'

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

function makeRoutes(engine, config, stream) {
  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return false }
    return true
  }
  // Stronger fence for the stream routes: loopback peer + loopback Host +
  // Sec-Fetch-Site/Origin. POSTs (which mint capabilities) also require Origin.
  const fence = (req, res, requireOrigin) => {
    if (!StreamAccess.isTrustedRequest(req, requireOrigin)) { writeJson(res, 403, { error: 'forbidden: loopback trusted-browser only' }); return false }
    return true
  }
  const isPost = (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return false }
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
    // ── live device stream (panel) ──────────────────────────────────────────
    // GET /api/dsh-mobilecode/stream?token=… — live multipart/x-mixed-replace PNG
    // stream from the in-process frame loop. The <img> GET carries no Origin, so
    // the fence here is loopback-only (requireOrigin false).
    {
      kind: 'exact',
      path: API_BASE + '/stream',
      handler: async (req, res) => {
        if (!fence(req, res, false)) return
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''
        const payload = await stream.access.verifyStreamToken(token)
        if (payload === undefined) { writeJson(res, 403, { error: 'the stream token is invalid or expired' }); return }
        if (stream.host.streamedSerial !== payload.serial) { writeJson(res, 503, { error: 'the device stream is not running; request a fresh grant' }); return }
        const release = stream.host.acquire()
        try {
          await stream.host.ensureStreaming({ serial: payload.serial })
        } catch (error) {
          release()
          writeJson(res, 502, { error: `the device stream failed to start: ${error instanceof Error ? error.message : String(error)}` })
          return
        }
        const writer = new FrameSource.MultipartFrameWriter(res)
        let finished = false
        const teardown = () => {
          if (finished) return
          finished = true
          unsubscribe()
          writer.close()
          release()
        }
        const unsubscribe = stream.host.subscribeFrames((frame) => {
          // Frames for a different serial (after a device switch) must not leak
          // into a capability minted for the old device.
          if (stream.host.streamedSerial === payload.serial) writer.writeFrame(frame)
          else teardown()
        })
        res.on('error', teardown)
        res.on('close', teardown)
        const latest = stream.host.latestFrame
        if (latest !== undefined) writer.writeFrame(latest)
      },
    },
    // POST /api/dsh-mobilecode/stream/grant {device?} — mint a fresh stream URL.
    // Only starts the loop for an ONLINE device; never boots an emulator, never
    // yanks the stream from a different streaming device.
    {
      kind: 'exact',
      path: API_BASE + '/stream/grant',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        try {
          const serial = typeof body.device === 'string' && body.device !== '' ? body.device : stream.host.streamedSerial
          if (!serial) { writeJson(res, 409, { error: 'no device is streaming; pass a serial' }); return }
          if (!StreamAccess.SERIAL_PATTERN.test(serial)) { writeJson(res, 400, { error: 'device must be an adb device serial' }); return }
          if (stream.host.streamedSerial !== serial) {
            const online = await stream.host.listDevices()
            if (!online.some((device) => device.serial === serial)) { writeJson(res, 409, { error: `device ${serial} is not online` }); return }
          }
          await stream.host.ensureStreaming({ serial })
          const signed = await stream.access.signStreamToken(serial)
          writeJson(res, 200, { ok: true, streamUrl: `${API_BASE}/stream?token=${encodeURIComponent(signed.token)}`, expiresAt: signed.expiresAt, device: serial })
        } catch (error) {
          writeJson(res, 502, { error: `the device stream failed to start: ${error instanceof Error ? error.message : String(error)}` })
        }
      },
    },
    // POST /api/dsh-mobilecode/stream/status {device?} — read-only snapshot;
    // never starts a stream and never mints tokens.
    {
      kind: 'exact',
      path: API_BASE + '/stream/status',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        const status = stream.host.status()
        const filter = body.device
        const running = status.running && status.serial !== undefined && (filter === undefined || filter === '' || status.serial === filter)
        if (!running) { writeJson(res, 200, { ok: true, running: false }); return }
        writeJson(res, 200, { ok: true, running: true, serial: status.serial, width: status.width, height: status.height })
      },
    },
    // POST /api/dsh-mobilecode/stream/devices — online device list for the picker.
    {
      kind: 'exact',
      path: API_BASE + '/stream/devices',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        await readBody(req, res)
        try {
          const devices = await stream.host.listDevices()
          const streamed = stream.host.streamedSerial
          writeJson(res, 200, { ok: true, devices: devices.map((device) => ({ ...device, ...(device.serial === streamed ? { streaming: true } : {}) })) })
        } catch (error) {
          writeJson(res, 503, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/stream/control {device, action} — one control op.
    // tap/drag coordinates are NORMALIZED 0..1 of the streamed frame.
    {
      kind: 'exact',
      path: API_BASE + '/stream/control',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        const serial = body.device
        if (typeof serial !== 'string' || !StreamAccess.SERIAL_PATTERN.test(serial)) { writeJson(res, 400, { error: 'device must be an adb device serial' }); return }
        const action = body.action
        if (typeof action !== 'object' || action === null || typeof action.kind !== 'string') { writeJson(res, 400, { error: 'action must be an object with a kind' }); return }
        const point = (x, y) => typeof x === 'number' && typeof y === 'number' && x >= 0 && x <= 1 && y >= 0 && y <= 1
        if (action.kind === 'tap' && !point(action.x, action.y)) { writeJson(res, 400, { error: 'tap needs normalized x,y in 0..1' }); return }
        if (action.kind === 'drag' && !(point(action.fromX, action.fromY) && point(action.toX, action.toY))) { writeJson(res, 400, { error: 'drag needs normalized fromX,fromY,toX,toY in 0..1' }); return }
        if (action.kind === 'button' && (typeof action.name !== 'string' || action.name === '')) { writeJson(res, 400, { error: 'button requires a non-empty name' }); return }
        if (action.kind === 'type' && (typeof action.text !== 'string' || action.text === '')) { writeJson(res, 400, { error: 'type requires a non-empty text' }); return }
        if (stream.host.streamedSerial !== serial) {
          const online = await stream.host.listDevices()
          if (!online.some((device) => device.serial === serial)) { writeJson(res, 409, { error: `device ${serial} is not online` }); return }
        }
        const release = stream.host.acquire()
        try {
          let result = { ok: true }
          switch (action.kind) {
            case 'tap': await stream.host.tap(serial, action.x, action.y); break
            case 'drag': await stream.host.drag(serial, { fromX: action.fromX, fromY: action.fromY, toX: action.toX, toY: action.toY, ...(typeof action.durationMs === 'number' ? { duration: Math.min(5, action.durationMs / 1000) } : {}) }); break
            case 'button': await stream.host.button(serial, action.name); break
            case 'type': await stream.host.type(serial, action.text); break
            case 'rotate': {
              const current = await stream.host.getRotation(serial)
              const next = ROTATION_CYCLE[(ROTATION_CYCLE.indexOf(current) + 1) % ROTATION_CYCLE.length]
              await stream.host.rotate(serial, next)
              result = { ok: true, rotation: next }
              break
            }
            default: writeJson(res, 400, { error: `unknown control action ${JSON.stringify(action.kind)}` }); return
          }
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 502, { error: `the device control failed: ${error instanceof Error ? error.message : String(error)}` })
        } finally {
          release()
        }
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
          if (DeviceBuild.isAsciiInput(args.text)) {
            await DeviceBuild.exec(DeviceBuild.adb(), adbArgs(['input', 'text', DeviceBuild.escapeInputText(args.text)])).exit
            return { serial, action, sent: `text "${args.text}"` }
          }
          // Non-ASCII (CJK, emoji, accented) cannot go through `input text`; the
          // ADBKeyboard IME is the only adb path. Refuse with the fix, never mangle.
          if (!(await DeviceBuild.adbKeyboardReady(serial))) {
            throw new Error(
              `device_input cannot type non-ASCII text ("${args.text}") over plain adb. Install ADBKeyboard `
              + 'on the device (https://github.com/senzhk/ADBKeyBoard), enable it (ime enable/set '
              + 'com.android.adbkeyboard/.AdbIME), then retry — this tool then types via its base64 broadcast.',
            )
          }
          await DeviceBuild.typeViaAdbKeyboard(serial, args.text)
          return { serial, action, sent: `text "${args.text}" (ADBKeyboard)` }
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

/** OCR the current screen and report whether `wantedLower` appears; undefined when OCR is unavailable. */
async function ocrHasText(serial, wantedLower) {
  if (!DeviceBuild.ocrPython()) return undefined
  const png = await DeviceBuild.screenCapture(serial)
  if (!png) return undefined
  const ocr = await DeviceBuild.ocrImage(png).catch(() => [])
  return ocr.some((item) => String(item.text).toLowerCase().includes(wantedLower))
}

function deviceWaitForTool() {
  return defineTool({
    name: 'device_wait_for',
    description: 'Wait for on-screen text to appear or disappear. Polls the uiautomator tree every ~600 ms; when the tree ' +
      'carries no labels (WebView/Compose/canvas) it falls back to local PaddleOCR. A timeout is a normal matched:false ' +
      'result, never an error — one call replaces an agent-side poll loop.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      text: { type: 'string', description: 'Text to wait for (case-insensitive substring).' },
      mode: { type: 'string', enum: ['appear', 'disappear'], description: 'appear (default) waits for the text; disappear waits for it to go away.' },
      timeout_ms: { type: 'integer', description: 'Max wait in ms (default 10000, max 60000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          text: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          matched: { type: 'boolean', required: true },
          waited_ms: { type: 'integer', required: true },
          source: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', text: '', mode: 'appear', matched: false, waited_ms: 0, source: 'ui_tree' }
        return [{ type: 'text', text: `${v.matched ? 'MATCHED' : 'TIMEOUT'}: "${v.text}" ${v.mode} (${v.source}) after ${v.waited_ms}ms on ${v.serial}` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const text = String(args.text ?? '').trim()
      if (text === '') throw new Error('device_wait_for requires a non-empty text.')
      const mode = args.mode === 'disappear' ? 'disappear' : 'appear'
      const timeout = Math.min(Math.max(args.timeout_ms ?? 10_000, 500), 60_000)
      const wanted = text.toLowerCase()
      const start = Date.now()
      const deadline = start + timeout
      let source = 'ui_tree'
      for (;;) {
        let labels
        try {
          labels = UiTree.collectLabels((await UiTree.readUiTree(serial)).roots)
        } catch {
          labels = undefined
        }
        let present
        if (labels !== undefined && labels.length > 0) {
          source = 'ui_tree'
          present = labels.some((label) => label.toLowerCase().includes(wanted))
        } else {
          const ocr = await ocrHasText(serial, wanted)
          if (ocr === undefined) { source = 'ui_tree'; present = false }
          else { source = 'ocr'; present = ocr }
        }
        const matched = mode === 'appear' ? present : !present
        const waited = Math.min(timeout, Date.now() - start)
        if (matched) return { serial, text, mode, matched: true, waited_ms: waited, source }
        if (Date.now() >= deadline) return { serial, text, mode, matched: false, waited_ms: timeout, source }
        await new Promise((resolve) => setTimeout(resolve, source === 'ocr' ? 2000 : 600))
      }
    },
  })
}

function deviceBootTool() {
  return defineTool({
    name: 'device_boot',
    description: 'Boot an Android emulator AVD by name (from device_status.avds) and wait until it finishes booting. ' +
      'If an emulator for that AVD is already running it is adopted. This is the device-centric boot — device_run is the ' +
      'project-centric build+install+launch.',
    parameters: {
      avd: { type: 'string', description: 'AVD name to boot.' },
      timeout_ms: { type: 'integer', description: 'Max wait for boot in ms (default 180000, max 600000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          avd: { type: 'string', required: true },
          booted: { type: 'boolean', required: true },
          alreadyRunning: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', avd: '', booted: false, alreadyRunning: false }
        return [{ type: 'text', text: `${v.alreadyRunning ? 'Adopted running' : 'Booted'} emulator ${v.serial} (AVD ${v.avd}), boot completed: ${v.booted}` }]
      },
    },
    async execute(args) {
      const avd = String(args.avd ?? '').trim()
      if (avd === '') throw new Error('device_boot requires an avd name (see device_status.avds).')
      const timeout = Math.min(Math.max(args.timeout_ms ?? 180_000, 5_000), 600_000)
      const rows = await DeviceBuild.devices()
      for (const row of rows.filter((item) => item.state === 'device' && item.serial.startsWith('emulator-'))) {
        const name = await DeviceBuild.avdName(row.serial).catch(() => undefined)
        if (name === avd) {
          const booted = await DeviceBuild.waitForBoot(row.serial, timeout)
          return { serial: row.serial, avd, booted, alreadyRunning: true }
        }
      }
      if (!DeviceBuild.emulatorBinary()) throw new Error('No SDK emulator binary found; cannot boot an AVD.')
      const before = new Set(rows.map((item) => item.serial))
      if (!DeviceBuild.bootEmulator(avd)) throw new Error(`Could not launch the emulator for AVD "${avd}".`)
      const deadline = Date.now() + timeout
      let serial
      while (Date.now() < deadline) {
        const now = await DeviceBuild.devices()
        const fresh = now.find((item) => item.serial.startsWith('emulator-') && !before.has(item.serial))
        if (fresh) { serial = fresh.serial; break }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      if (!serial) throw new Error(`No emulator serial appeared for "${avd}" within ${timeout} ms.`)
      const booted = await DeviceBuild.waitForBoot(serial, Math.max(1000, deadline - Date.now()))
      if (!booted) throw new Error(`Emulator ${serial} ("${avd}") did not finish booting within ${timeout} ms.`)
      return { serial, avd, booted: true, alreadyRunning: false }
    },
  })
}

function deviceShutdownTool() {
  return defineTool({
    name: 'device_shutdown',
    description: 'Shut down an emulator (`adb emu kill`). Refuses physical devices — adb has no power-off verb for phones.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          shutdown: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Shut down emulator ${value?.serial}` }],
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const isEmulator = serial.startsWith('emulator-') || (await DeviceBuild.avdName(serial).catch(() => undefined)) !== undefined
      if (!isEmulator) {
        throw new Error(`device_shutdown refuses ${serial}: it is a physical device and adb has no power-off verb for phones — use its own power button.`)
      }
      await DeviceBuild.exec(DeviceBuild.adb(), ['-s', serial, 'emu', 'kill']).exit
      return { serial, shutdown: true }
    },
  })
}

const DEVICE_ACTIONS = {
  notifications: ['cmd', 'statusbar', 'expand-notifications'],
  quick_settings: ['cmd', 'statusbar', 'expand-settings'],
  collapse: ['cmd', 'statusbar', 'collapse'],
  lock: ['input', 'keyevent', '223'],
  wake: ['input', 'keyevent', '224'],
  assistant: ['am', 'start', '-a', 'android.intent.action.ASSIST'],
}

function deviceActionTool() {
  return defineTool({
    name: 'device_action',
    description: 'Device-level actions beyond touches: open the notification shade or quick settings, collapse the shade, ' +
      'lock or wake the screen, launch the assistant, or rotate the display (cycles 0→90→180→270 and pins auto-rotate off).',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      action: { type: 'string', enum: [...Object.keys(DEVICE_ACTIONS), 'rotate'], description: 'Which device action to perform.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          action: { type: 'string', required: true },
          rotation: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value?.rotation !== undefined ? `${value.action} on ${value.serial} → rotation ${value.rotation * 90}°` : `${value?.action} on ${value?.serial}` }],
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const action = String(args.action ?? '')
      if (action === 'rotate') {
        const current = Number(await DeviceBuild.capture(DeviceBuild.adb(), ['-s', serial, 'shell', 'settings', 'get', 'system', 'user_rotation']))
        const next = ((Number.isFinite(current) ? current : 0) + 1) % 4
        await DeviceBuild.exec(DeviceBuild.adb(), ['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']).exit
        await DeviceBuild.exec(DeviceBuild.adb(), ['-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', String(next)]).exit
        return { serial, action, rotation: next }
      }
      const shell = DEVICE_ACTIONS[action]
      if (!shell) throw new Error(`unknown action "${action}" — use ${[...Object.keys(DEVICE_ACTIONS), 'rotate'].join(', ')}.`)
      await DeviceBuild.exec(DeviceBuild.adb(), ['-s', serial, 'shell', ...shell]).exit
      return { serial, action }
    },
  })
}

function deviceAppsTool() {
  return defineTool({
    name: 'device_apps',
    description: 'List installed Android packages (third-party by default; include_system=true adds platform apps). ' +
      'Use it to find the real package name before device_launch_app — never guess one.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      include_system: { type: 'boolean', description: 'Include system/platform packages (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          packages: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', count: 0, packages: [] }
        const shown = v.packages.slice(0, 60).join('\n  ')
        return [{ type: 'text', text: `${v.serial}: ${v.count} packages\n  ${shown}${v.count > 60 ? `\n  … and ${v.count - 60} more` : ''}` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const output = await DeviceBuild.capture(DeviceBuild.adb(), ['-s', serial, 'shell', 'pm', 'list', 'packages', ...(args.include_system ? [] : ['-3'])])
      const packages = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length).trim())
      return { serial, count: packages.length, packages: packages.slice(0, 200) }
    },
  })
}

function deviceLaunchAppTool() {
  return defineTool({
    name: 'device_launch_app',
    description: 'Launch an installed app by package name (or a unique substring of it). relaunch=true force-stops it first ' +
      'for a cold start. Resolves the exact package via `pm list packages` so a wrong guess fails loudly instead of ' +
      'opening the wrong app.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      package: { type: 'string', description: 'Package name or a unique substring of it.' },
      relaunch: { type: 'boolean', description: 'Force-stop the app first (cold start).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          package: { type: 'string', required: true },
          launched: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Launched ${value?.package} on ${value?.serial}` }],
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      let pkg = String(args.package ?? '').trim()
      if (pkg === '') throw new Error('device_launch_app requires a package name (or a unique substring).')
      const listOut = await DeviceBuild.capture(DeviceBuild.adb(), ['-s', serial, 'shell', 'pm', 'list', 'packages'])
      const all = listOut
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('package:'))
        .map((line) => line.slice('package:'.length).trim())
      if (!all.includes(pkg)) {
        const matches = all.filter((item) => item.toLowerCase().includes(pkg.toLowerCase()))
        if (matches.length === 0) throw new Error(`No installed package matches "${pkg}". Run device_apps to list them.`)
        if (matches.length > 1) throw new Error(`"${pkg}" matches ${matches.length} packages (${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ', …' : ''}) — be more specific.`)
        pkg = matches[0]
      }
      if (args.relaunch) await DeviceBuild.exec(DeviceBuild.adb(), ['-s', serial, 'shell', 'am', 'force-stop', pkg]).exit
      const code = await DeviceBuild.exec(DeviceBuild.adb(), ['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']).exit
      if (code !== 0) throw new Error(`Could not launch ${pkg} (no launcher activity, or monkey failed with exit ${code}).`)
      return { serial, package: pkg, launched: true }
    },
  })
}

function deviceStreamTool(host, access) {
  return defineTool({
    name: 'device_stream',
    description: 'Drive the live device screen stream the Devices panel shows. action=start begins the frame loop for an ' +
      'online device and returns a signed streamUrl; status reports whether it is running; stop tears it down. This is a ' +
      'human-panel feature — agents that just need to see the screen should use device_screen or device_ui_tree instead.',
    parameters: {
      action: { type: 'string', enum: ['status', 'start', 'stop'], description: 'What to do (default status).' },
      serial: { type: 'string', description: 'Device serial (start needs an online device; omit to use the first attached one).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          running: { type: 'boolean', required: true },
          serial: { type: 'string' },
          streamUrl: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { action: 'status', running: false }
        const text = v.action === 'start' && v.streamUrl
          ? `Streaming ${v.serial} (${v.width}x${v.height}) — ${v.streamUrl}`
          : `Stream ${v.action}: running=${v.running}${v.serial ? ` (${v.serial})` : ''}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args) {
      const action = args.action ?? 'status'
      if (action === 'stop') {
        await host.stop()
        return { action, running: false }
      }
      if (action === 'status') {
        const s = host.status()
        return { action, running: s.running, ...(s.serial !== undefined ? { serial: s.serial } : {}), ...(s.width !== undefined ? { width: s.width, height: s.height } : {}) }
      }
      const serial = await requireAndroidDevice(args.serial)
      const online = await host.listDevices()
      if (!online.some((device) => device.serial === serial)) throw new Error(`device ${serial} is not online; cannot stream it`)
      const info = await host.ensureStreaming({ serial })
      const signed = await access.signStreamToken(serial)
      return { action, running: true, serial: info.serial, width: info.width, height: info.height, streamUrl: `${API_BASE}/stream?token=${encodeURIComponent(signed.token)}` }
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
  // An `wm size` override wins over the physical panel — the input space is the override.
  const override = /Override size:\s*(\d+)x(\d+)/.exec(output)
  const match = override ?? /Physical size:\s*(\d+)x(\d+)/.exec(output)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined
}

/** Recursive node schema is not expressible here; tree children stay open objects. */
const UI_TREE_ITEM_SCHEMA = { type: 'object', additionalProperties: true }

function deviceUiTreeTool() {
  return defineTool({
    name: 'device_ui_tree',
    description: 'Dump the foreground Android app\'s uiautomator hierarchy as a compact node tree — type, text, ' +
      'contentDesc, resourceId, pixel bounds, enabled/focused/clickable flags. The default observer for UI automation: ' +
      'resource-ids are the most stable tap handles. Use device_tap_element to tap by identity instead of guessing ' +
      'pixel coordinates. When the tree comes back shallow or empty on a WebView/Compose/canvas, fall back to ' +
      'device_screen (OCR reads pixels and needs no idle).',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      max_depth: { type: 'integer', description: 'Maximum hierarchy depth to include (omit for the full tree).' },
      filter: { type: 'string', description: 'Case-insensitive substring over text/content-desc/resource-id/type; matching nodes and their ancestors are kept.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          rotation: { type: 'integer' },
          nodes: { type: 'integer', required: true },
          tree: { type: 'array', required: true, items: UI_TREE_ITEM_SCHEMA },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', nodes: 0, tree: [] }
        const lines = [`Device ${v.serial}: ${v.nodes} nodes${v.truncated ? ' (truncated at 40 KB — narrow with max_depth or filter)' : ''}${v.rotation !== undefined ? `, rotation=${v.rotation}` : ''}`]
        const walk = (nodes, indent) => {
          for (const node of nodes) {
            const label = [node.text, node.contentDesc].find(Boolean) ?? ''
            const id = node.resourceId ? ` [${node.resourceId}]` : ''
            const flags = []
            if (node.enabled === false) flags.push('disabled')
            if (node.clickable) flags.push('clickable')
            if (node.scrollable) flags.push('scrollable')
            const b = node.bounds
            lines.push(`${indent}- ${node.type}${label ? ` "${label}"` : ''}${id}${flags.length > 0 ? ` (${flags.join(',')})` : ''} @${b.x},${b.y} ${b.w}x${b.h}`)
            if (indent.length < 8) walk(node.children, indent + '  ')
          }
        }
        walk(v.tree, '  ')
        if (v.nodes === 0) lines.push('  (no nodes — the surface may expose no accessibility; try device_screen OCR)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const parsed = await UiTree.readUiTree(serial)
      const { tree, count } = UiTree.buildCompactTree(parsed.roots, args.max_depth, args.filter)
      const capped = UiTree.capTreeToBytes(tree)
      const out = {
        serial,
        nodes: count,
        tree: capped.tree,
        ...(capped.truncated ? { truncated: true } : {}),
        ...(parsed.rotation !== undefined ? { rotation: parsed.rotation } : {}),
      }
      return out
    },
  })
}

function deviceTapElementTool() {
  return defineTool({
    name: 'device_tap_element',
    description: 'Tap an Android UI element by identity — resource_id matches the node\'s resource-id; text matches its ' +
      'text or content-desc. Exact match first, then case-insensitive substring; nested duplicates collapse to one ' +
      'target and an ambiguous match lists up to 8 candidates instead of picking one. Disabled or off-screen elements ' +
      'are refused with the fix. Pass expect_text / expect_gone and the tap plus its verification become one round trip.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      resource_id: { type: 'string', description: 'The resource-id to match (e.g. com.android.settings:id/search_bar).' },
      text: { type: 'string', description: 'Text or content-desc to match. Exact wins over substring.' },
      expect_text: { type: 'string', description: 'After the tap, re-dump and verify this text is present.' },
      expect_gone: { type: 'string', description: 'After the tap, re-dump and verify this text is gone.' },
      allow_offscreen: { type: 'boolean', description: 'Tap a node whose bounds lie outside the screen anyway (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          tapped: { type: 'string', required: true },
          matchedBy: { type: 'string', required: true },
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          expected: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true },
              text: { type: 'string', required: true },
              matched: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', tapped: '', matchedBy: '', x: 0, y: 0 }
        const lines = [`Tapped ${v.tapped} (${v.matchedBy}) at ${v.x},${v.y} on ${v.serial}`]
        if (v.expected) lines.push(`Expect ${v.expected.mode} "${v.expected.text}": ${v.expected.matched ? 'VERIFIED' : 'NOT matched — the action did not land as expected'}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const parsed = await UiTree.readUiTree(serial)
      const selector = { identifier: args.resource_id, label: args.text }
      const { node, matchedBy } = UiTree.resolveTapTarget(parsed.roots, selector, { tool: 'device_tap_element', allowOffscreen: args.allow_offscreen === true })
      const center = UiTree.boundsCenter(node.bounds)
      await DeviceBuild.exec(DeviceBuild.adb(), ['-s', serial, 'shell', 'input', 'tap', String(center.x), String(center.y)]).exit
      const describe = () => {
        const parts = []
        if (node.resourceId) parts.push(`resource_id ${node.resourceId}`)
        if (node.text) parts.push(`text ${JSON.stringify(node.text)}`)
        if (node.contentDesc) parts.push(`content-desc ${JSON.stringify(node.contentDesc)}`)
        return parts.join(', ') || node.type
      }
      const out = { serial, tapped: describe(), matchedBy, x: center.x, y: center.y }
      const mode = args.expect_gone !== undefined && args.expect_gone !== '' ? 'gone' : (args.expect_text !== undefined && args.expect_text !== '' ? 'appear' : undefined)
      if (mode !== undefined) {
        const text = mode === 'gone' ? String(args.expect_gone) : String(args.expect_text)
        await new Promise((resolve) => setTimeout(resolve, 600))
        const fresh = await UiTree.readUiTree(serial).catch(() => undefined)
        const labels = fresh ? UiTree.collectLabels(fresh.roots) : []
        const matched = mode === 'gone' ? !labels.some((label) => label.toLowerCase().includes(text.toLowerCase())) : labels.some((label) => label.toLowerCase().includes(text.toLowerCase()))
        out.expected = { mode, text, matched }
      }
      return out
    },
  })
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
    '- device_ui_tree: the default screen observer — the uiautomator hierarchy as a typed node tree with resource-ids,',
    '  text, and pixel bounds. Narrow with filter/max_depth; on a textless surface (WebView, Compose, canvas) use device_screen.',
    '- device_tap_element: tap a control by resource_id or text/content-desc, with one-call verification via',
    '  expect_text / expect_gone (no separate screenshot needed to know the tap landed).',
    '- device_wait_for: wait for text to appear/disappear (polls the UI tree, falls back to OCR on textless surfaces);',
    '  a timeout is a normal matched:false result, never an error. One call replaces an agent-side poll loop.',
    '- device_input: tap/swipe/type/press on the attached Android device at ABSOLUTE pixel coordinates (take the center of a',
    '  device_screen box: x=(x1+x2)/2, y=(y1+y2)/2). The control loop is device_ui_tree → device_tap_element, falling back to',
    '  device_screen → device_input when a surface exposes no accessibility tree. Typing is ASCII over plain adb; non-ASCII',
    '  (CJK, emoji) goes through the ADBKeyboard IME when installed, and is refused with the install hint otherwise.',
    '- device_action: notifications / quick_settings / collapse / lock / wake / assistant / rotate.',
    '- device_boot / device_shutdown: boot an AVD by name and wait for boot / shut an emulator down (refuses physical devices).',
    '- device_apps / device_launch_app: list installed packages (never guess a package name) / launch one by package or unique substring.',
    '- device_stream: drive the live screen stream the Devices panel shows (status / start an online device / stop). Agents',
    '  that just need to see the screen should prefer device_screen or device_ui_tree.',
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

  // The playbook skill is host-independent; register it once at apply-time.
  let disposeSkill = () => {}
  try {
    disposeSkill = registerMobileSkill(ctx) ?? (() => {})
  } catch {
    // The skills service is optional; the plugin works without the playbook.
  }

  const resolve = () => ({
    enabled: config?.enabled ?? true,
    announceToAgent: config?.announceToAgent ?? true,
  })

  const engine = new DevicePreviewEngine()
  const streamHost = new AndroidStreamHost()
  const streamAccess = new StreamAccess.StreamAccessController()
  const handle = {
    engine,
    stream: streamHost,
    status: () => ({
      directories: [...new Set([...engine.builds.keys()].map((key) => key.split('\0')[0]))],
      servers: [...engine.servers.keys()],
      bundlers: [...engine.bundlers.keys()],
      builds: [...engine.builds.keys()],
    }),
  }
  if (typeof ctx.provide === 'function') ctx.provide('mobilecode', handle)
  else ctx.mobilecode = handle

  const routes = makeRoutes(engine, config, { host: streamHost, access: streamAccess })
  let disposeRoutes
  let disposeTools
  let disposeSection

  const sync = () => {
    const value = resolve()
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (!value.enabled) return
    streamHost.startKeepAlive()
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
        deviceUiTreeTool(),
        deviceTapElementTool(),
        deviceWaitForTool(),
        deviceBootTool(),
        deviceShutdownTool(),
        deviceActionTool(),
        deviceAppsTool(),
        deviceLaunchAppTool(),
        deviceStreamTool(streamHost, streamAccess),
        deviceLogTool(engine),
        deviceStatusTool(engine),
        deviceInputTool(),
      ].map((tool) => ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-mobilecode: tools')
  }

  ctx.effect(() => () => {
    disposeSkill()
    void streamHost.dispose()
    void engine.dispose()
  }, 'dsh-mobilecode: engine')

  sync()
  return sync
}
