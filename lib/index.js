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
import * as RowList from './list-rows.js'
import * as FrameSource from './frame-source.js'
import * as StreamAccess from './stream-access.js'
import { AndroidStreamHost, ROTATION_CYCLE } from './android-stream.js'
import * as Vision from './vision.js'
import { DevicePreviewEngine } from './device-preview.js'
import { MeshHub } from './mesh-hub.js'
import * as Setup from './setup.js'
import { registerMobileSkill } from './skill.js'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

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
  // Mesh fence: game clients are plain HTTP stacks (OkHttp/Unity/curl) that
  // never send browser headers — they must only prove a loopback peer plus a
  // Host the emulator NAT actually presents (10.0.2.2) or loopback. Anything
  // that DOES look like a browser request (Origin / Sec-Fetch-*) additionally
  // passes the trusted-browser stream fence, so a random web page can never
  // join a game session or read its messages.
  const meshGuard = (req, res) => {
    if (!StreamAccess.isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      writeJson(res, 403, { code: 'forbidden', error: 'the mesh is loopback-only (emulators reach it via 10.0.2.2)' })
      return false
    }
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] !== undefined) {
      return fence(req, res, false)
    }
    let hostname = ''
    try { hostname = new URL('http://' + String(req.headers.host ?? '')).hostname } catch { hostname = '' }
    const trusted = hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
      || hostname.startsWith('127.') || hostname === '10.0.2.2' || hostname === '10.0.3.2'
    if (!trusted) { writeJson(res, 403, { code: 'forbidden', error: `unexpected Host "${hostname}" for a mesh client` }); return false }
    return true
  }
  const meshAuth = (req, url, body) => {
    const id = body?.id ?? url.searchParams.get('id') ?? req.headers['x-mesh-peer']
    const token = body?.token ?? url.searchParams.get('token') ?? req.headers['x-mesh-token']
    if (typeof id !== 'string' || !stream.mesh.verify(id, typeof token === 'string' ? token : '')) return undefined
    return stream.mesh.peers.get(id)
  }
  const meshUnauthorized = (res) => writeJson(res, 401, { code: 'token_invalid', error: 'POST /mesh/join first, then pass your id + token' })
  const meshFail = (res, error) => {
    const status = ({ unknown_peer: 404, unknown_session: 409, not_member: 403, too_large: 413 })[error?.code] ?? 400
    writeJson(res, status, { code: error?.code ?? 'bad_request', error: error instanceof Error ? error.message : String(error) })
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
    // GET /api/dsh-mobilecode/connection → {adb, devices:[{serial, state, model?, wifi}]} — connection card data.
    {
      kind: 'exact',
      path: API_BASE + '/connection',
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          writeJson(res, 200, { adb: adbHostInfo(), devices: await connectionDevices() })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/connect {host, port?, pairing_code?, pairing_port?} — attach a Wi-Fi device (with optional pairing).
    {
      kind: 'exact',
      path: API_BASE + '/connect',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        try {
          const host = String(body.host ?? '').trim().replace(/^adb:\/\//, '')
          if (host === '') { writeJson(res, 400, { error: 'host is required' }); return }
          const port = body.port ?? 5555
          const target = `${host}:${port}`
          let paired
          const code = String(body.pairing_code ?? '').trim()
          if (code !== '') {
            const pairPort = body.pairing_port ?? 37000
            await DeviceBuild.adbPair(`${host}:${pairPort}`, code)
            paired = true
          }
          const connected = await DeviceBuild.adbConnectSerial(target)
          if (!connected) { writeJson(res, 409, { error: `adb connect ${target} failed — check the Wi-Fi IP/port and Wireless debugging; pass pairing_code + pairing_port if it needs pairing.` }); return }
          writeJson(res, 200, { ok: true, serial: target, paired: paired === true })
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/pair-qr {timeout_ms?} — WIFI:T:ADB QR + mDNS auto-pair + connect (one blocking call).
    {
      kind: 'exact',
      path: API_BASE + '/pair-qr',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        try {
          const timeoutMs = Math.min(Math.max(Number(body.timeout_ms) || 60_000, 10_000), 180_000)
          const { name, password } = DeviceBuild.randomQrCredentials()
          const qrText = DeviceBuild.generateQrAdbWifi(name, password)
          const how = 'Render the returned qr_text as a QR code and scan it with the phone (Settings → Connected devices → Pair by QR). Pairing + connect happen automatically once scanned.'
          const pairingSerial = await DeviceBuild.waitForMdnsPairing(timeoutMs)
          if (pairingSerial === undefined) { writeJson(res, 200, { qr_text: qrText, name, password, status: 'timeout', how }); return }
          await DeviceBuild.adbPair(pairingSerial, password)
          const connectHost = pairingSerial.split(':')[0]
          const connected = await DeviceBuild.adbConnectSerial(`${connectHost}:5555`)
          writeJson(res, 200, connected
            ? { qr_text: qrText, name, password, status: 'connected', serial: `${connectHost}:5555`, how }
            : { qr_text: qrText, name, password, status: 'paired-not-connected', serial: pairingSerial, how })
        } catch (error) {
          writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
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
        if (payload === undefined) { writeJson(res, 403, { code: 'token_invalid', error: 'the stream token is invalid or expired' }); return }
        if (stream.host.streamedSerial !== payload.serial) { writeJson(res, 503, { code: 'stream_not_running', error: 'the device stream is not running; request a fresh grant' }); return }
        const release = stream.host.acquire()
        try {
          await stream.host.ensureStreaming({ serial: payload.serial })
        } catch (error) {
          release()
          writeJson(res, 502, { code: 'stream_start_failed', error: `the device stream failed to start: ${error instanceof Error ? error.message : String(error)}` })
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
    // POST /api/dsh-mobilecode/stream/devices — online device list for the picker
    // + bootable AVDs (for the "start with device_boot" hint rows).
    {
      kind: 'exact',
      path: API_BASE + '/stream/devices',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        await readBody(req, res)
        try {
          const [devices, avds] = await Promise.all([
            stream.host.listDevices(),
            DeviceBuild.androidAvds().catch(() => []),
          ])
          const streamed = stream.host.streamedSerial
          writeJson(res, 200, {
            ok: true,
            avds,
            devices: devices.map((device) => ({ ...device, ...(device.serial === streamed ? { streaming: true } : {}) })),
          })
        } catch (error) {
          writeJson(res, 503, { code: 'devices_unavailable', error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // POST /api/dsh-mobilecode/stream/still {device?} — capture ONE fresh
    // screencap PNG and serve it; returns {path, width, height, dataUrl}. The
    // panel's Screenshot button uses this (a still is the current pixels, unlike
    // the live multipart loop). Falls back to the streamed device when device is
    // omitted. The PNG is written to a temp dir; dataUrl embeds it so the
    // browser can show it immediately (device_screen writes the same files).
    {
      kind: 'exact',
      path: API_BASE + '/stream/still',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        try {
          const serial = typeof body.device === 'string' && body.device !== '' ? body.device : stream.host.streamedSerial
          if (!serial) { writeJson(res, 409, { code: 'device_not_found', error: 'no device is streaming; pass a serial' }); return }
          if (!StreamAccess.SERIAL_PATTERN.test(serial)) { writeJson(res, 400, { code: 'bad_request', error: 'device must be an adb device serial' }); return }
          const local = await DeviceBuild.screenCapture(serial, tmpdir())
          if (local === undefined) { writeJson(res, 502, { code: 'capture_failed', error: `could not capture a still of ${serial}` }); return }
          const size = pngSize(local)
          const out = { ok: true, path: local, ...(size ? { width: size.width, height: size.height } : {}) }
          const bytes = readFileSync(local)
          if (bytes.length > 0 && bytes.length < 4 * 1024 * 1024) {
            out.dataUrl = 'data:image/png;base64,' + bytes.toString('base64')
          }
          writeJson(res, 200, out)
        } catch (error) {
          writeJson(res, 502, { code: 'capture_failed', error: `the still capture failed: ${error instanceof Error ? error.message : String(error)}` })
        }
      },
    },
    // POST /api/dsh-mobilecode/stream/device-action {device, action} — the
    // panel device menu: notifications / quick_settings / collapse / lock /
    // wake / assistant (the DEVICE_ACTIONS map device_action uses as a tool).
    {
      kind: 'exact',
      path: API_BASE + '/stream/device-action',
      handler: async (req, res) => {
        if (!fence(req, res, true) || !isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        const serial = typeof body.device === 'string' && body.device !== '' ? body.device : stream.host.streamedSerial
        if (!serial) { writeJson(res, 409, { code: 'device_not_found', error: 'no device is streaming; pass a device' }); return }
        const action = typeof body.action === 'string' ? body.action : ''
        const argv = DEVICE_ACTIONS[action]
        if (argv === undefined) { writeJson(res, 400, { code: 'unknown_action', error: `unknown device action "${action}"` }); return }
        if (!StreamAccess.SERIAL_PATTERN.test(serial)) { writeJson(res, 400, { code: 'bad_request', error: 'device must be an adb device serial' }); return }
        if (serial !== stream.host.streamedSerial) {
          const online = await stream.host.listDevices()
          if (!online.some((device) => device.serial === serial)) { writeJson(res, 409, { code: 'device_not_found', error: `device ${serial} is not online` }); return }
        }
        try {
          await DeviceBuild.adbRun(serial, ['shell', ...argv])
          writeJson(res, 200, { ok: true, action, device: serial })
        } catch (error) {
          writeJson(res, 502, { code: 'device_action_failed', error: `device action "${action}" failed: ${error instanceof Error ? error.message : String(error)}` })
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
        if (typeof serial !== 'string' || !StreamAccess.SERIAL_PATTERN.test(serial)) { writeJson(res, 400, { code: 'bad_request', error: 'device must be an adb device serial' }); return }
        const action = body.action
        if (typeof action !== 'object' || action === null || typeof action.kind !== 'string') { writeJson(res, 400, { code: 'bad_request', error: 'action must be an object with a kind' }); return }
        const point = (x, y) => typeof x === 'number' && typeof y === 'number' && x >= 0 && x <= 1 && y >= 0 && y <= 1
        if (action.kind === 'tap' && !point(action.x, action.y)) { writeJson(res, 400, { code: 'bad_request', error: 'tap needs normalized x,y in 0..1' }); return }
        if (action.kind === 'drag' && !(point(action.fromX, action.fromY) && point(action.toX, action.toY))) { writeJson(res, 400, { code: 'bad_request', error: 'drag needs normalized fromX,fromY,toX,toY in 0..1' }); return }
        if (action.kind === 'button' && (typeof action.name !== 'string' || action.name === '')) { writeJson(res, 400, { code: 'bad_request', error: 'button requires a non-empty name' }); return }
        if (action.kind === 'type' && (typeof action.text !== 'string' || action.text === '')) { writeJson(res, 400, { code: 'bad_request', error: 'type requires a non-empty text' }); return }
        if (stream.host.streamedSerial !== serial) {
          const online = await stream.host.listDevices()
          if (!online.some((device) => device.serial === serial)) { writeJson(res, 409, { code: 'device_offline', error: `device ${serial} is not online` }); return }
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
            default: writeJson(res, 400, { code: 'unknown_action', error: `unknown control action ${JSON.stringify(action.kind)}` }); return
          }
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 502, { code: 'control_failed', error: `the device control failed: ${error instanceof Error ? error.message : String(error)}` })
        } finally {
          release()
        }
      },
    },
    // ── mesh (v0.8.0) ─ LocalSend-style rendezvous for co-op testing. Emulators
    // cannot multicast through their isolated slirp NATs, but every one reaches
    // the host at 10.0.2.2, so the hub lives on these routes. A game joins once
    // (its serial pins a stable random callsign), links with a peer, then sends
    // and polls JSON through the hub — which doubles as the agent's observation
    // window (mesh_log) and network-condition injector (mesh_tune).
    {
      kind: 'exact',
      path: API_BASE + '/mesh/join',
      handler: async (req, res) => {
        if (!meshGuard(req, res)) return
        if (!isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        try {
          const { peer, token } = stream.mesh.join({ serial: body.serial, name: body.name, role: body.role })
          writeJson(res, 200, { ok: true, peer, token })
        } catch (error) {
          meshFail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/mesh/peers',
      handler: async (req, res) => {
        if (!meshGuard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const me = meshAuth(req, url, undefined)
        if (!me) { meshUnauthorized(res); return }
        writeJson(res, 200, { ok: true, me, ...stream.mesh.status() })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/mesh/link',
      handler: async (req, res) => {
        if (!meshGuard(req, res)) return
        if (!isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const me = meshAuth(req, url, body)
        if (!me) { meshUnauthorized(res); return }
        try {
          const queries = Array.isArray(body.with) ? body.with : []
          const session = stream.mesh.link([me.name, ...queries])
          writeJson(res, 200, {
            ok: true,
            session: {
              id: session.id,
              members: session.members.map((id) => stream.mesh.peers.get(id)?.name ?? id),
              policy: session.policy,
            },
          })
        } catch (error) {
          meshFail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/mesh/send',
      handler: async (req, res) => {
        if (!meshGuard(req, res)) return
        if (!isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const me = meshAuth(req, url, body)
        if (!me) { meshUnauthorized(res); return }
        try {
          const result = stream.mesh.send({ session: body.session, from: me.id, body: body.body })
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          meshFail(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/mesh/poll',
      handler: async (req, res) => {
        if (!meshGuard(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const me = meshAuth(req, url, undefined)
        if (!me) { meshUnauthorized(res); return }
        const after = Number(url.searchParams.get('after')) || 0
        const wait = Math.min(Number(url.searchParams.get('wait')) || 0, 30_000)
        let result = stream.mesh.poll(me.id, after)
        if (result.messages.length === 0 && wait > 0) {
          await stream.mesh.waitFor(me.id, wait)
          result = stream.mesh.poll(me.id, after)
        }
        writeJson(res, 200, { ok: true, ...result })
      },
    },
    {
      kind: 'exact',
      path: API_BASE + '/mesh/leave',
      handler: async (req, res) => {
        if (!meshGuard(req, res)) return
        if (!isPost(req, res)) return
        const body = await readBody(req, res)
        if (body === undefined) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const me = meshAuth(req, url, body)
        if (!me) { meshUnauthorized(res); return }
        stream.mesh.leave(me.id)
        writeJson(res, 200, { ok: true })
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

/**
 * PNG IHDR hand-parse: read the 8-byte signature + 24-byte IHDR chunk and pull
 * width/height (big-endian at offsets 16/20). Returns undefined for non-PNGs —
 * the PNG the screencap writes is always 8-bit RGBA non-interlaced, so no
 * deeper parsing is needed.
 */
function pngSize(filePath) {
  try {
    const bytes = readFileSync(filePath)
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  } catch {
    return undefined
  }
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
      switch (action) {
        case 'tap': {
          if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new Error('action=tap requires x and y (integer pixels).')
          await DeviceBuild.adbRun(serial, ['shell', 'input', 'tap', String(args.x), String(args.y)])
          return { serial, action, sent: `tap ${args.x},${args.y}` }
        }
        case 'swipe': {
          if (typeof args.x !== 'number' || typeof args.y !== 'number' || typeof args.x2 !== 'number' || typeof args.y2 !== 'number') {
            throw new Error('action=swipe requires x, y, x2, y2.')
          }
          const duration = args.duration ?? 200
          await DeviceBuild.adbRun(serial, ['shell', 'input', 'swipe', String(args.x), String(args.y), String(args.x2), String(args.y2), String(duration)])
          return { serial, action, sent: `swipe ${args.x},${args.y}→${args.x2},${args.y2} (${duration}ms)` }
        }
        case 'text': {
          if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('action=text requires a non-empty text string.')
          if (DeviceBuild.isAsciiInput(args.text)) {
            await DeviceBuild.adbRun(serial, ['shell', 'input', 'text', DeviceBuild.escapeInputText(args.text)])
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
          await DeviceBuild.adbRun(serial, ['shell', 'input', 'keyevent', String(code)])
          return { serial, action, sent: `key ${raw} (${code})` }
        }
        default:
          throw new Error(`unknown action "${action}" — use tap, swipe, text or key.`)
      }
    },
  })
}

/** Plain-device adb diagnostics (no serial) for the settings Connection card. */
export function adbHostInfo() {
  return DeviceBuild.adb()
}

/** Lines of `adb devices -l` after the header rows, parsed for the settings Connection card. */
export async function connectionDevices() {
  const output = await DeviceBuild.capture(DeviceBuild.adb(), ["devices", "-l"])
  return parseDeviceLongList(output)
}

/** Parse `adb devices -l` into [{serial, state, model, wifi}]. */
export function parseDeviceLongList(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^List of devices/i.test(line) && !/^\* daemon/i.test(line))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/)
      const model = /model:(\S+)/.exec(rest.join(" "))?.[1]
      const row = { serial, state: state || "unknown", wifi: DeviceBuild.isWifiSerial(serial) }
      if (model) row.model = model
      return row
    })
    .filter((row) => row.serial)
}

function deviceIntentTool() {
  return defineTool({
    name: 'device_intent',
    description: 'Open anything on the device by Android intent: an action (e.g. android.settings.WIFI_SETTINGS), ' +
      'a deep-link URI, or an explicit component (package/.Activity). Reaches screens no tap can address — deep ' +
      'settings pages, app deep links, files. Values are device-shell quoted so metacharacters stay inert.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      action: { type: 'string', description: 'Intent action, e.g. android.settings.WIFI_SETTINGS or android.intent.action.VIEW.' },
      uri: { type: 'string', description: 'Data URI the intent carries, e.g. geo:0,0?q=Berlin or a https:// deep link.' },
      component: { type: 'string', description: 'Explicit component, e.g. com.android.settings/.Settings.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          intent: { type: 'string', required: true },
          started: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Started ${value?.intent} on ${value?.serial}` }],
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const argv = DeviceBuild.adbIntentArgs({ action: args.action, uri: args.uri, component: args.component })
      if (argv.length === 3) throw new Error('device_intent needs at least one of action, uri or component.')
      const output = await DeviceBuild.adbRun(serial, argv)
      if (/^Error/i.test(output.trim())) throw new Error(`am start refused the intent on ${serial}: ${output.trim().split(/\r?\n/)[0]}`)
      const label = [["-a", args.action], ["-d", args.uri], ["-n", args.component]]
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([flag, value]) => `${flag} ${value}`)
        .join(' ')
      return { serial, intent: label, started: true }
    },
  })
}
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

/** First node matching the tap-element selector (exact, then contains), or undefined. Used by device_scroll_to. */
function findMatchingNode(roots, selector) {
  const identifier = selector.identifier !== undefined && selector.identifier.trim() !== '' ? selector.identifier.trim() : undefined
  const label = selector.label !== undefined && selector.label.trim() !== '' ? selector.label.trim() : undefined
  if (identifier === undefined && label === undefined) return undefined
  const matchesValue = (actual, wanted, mode) => actual !== undefined && (mode === 'exact' ? actual === wanted : actual.toLowerCase().includes(wanted.toLowerCase()))
  const matchesNode = (node, mode) => {
    if (identifier !== undefined && !matchesValue(node.resourceId, identifier, mode)) return false
    if (label !== undefined && !matchesValue(node.text, label, mode) && !matchesValue(node.contentDesc, label, mode)) return false
    return true
  }
  const flat = UiTree.flattenNodes(roots)
  return flat.find((node) => matchesNode(node, 'exact')) ?? flat.find((node) => matchesNode(node, 'contains'))
}

function deviceScrollToTool() {
  return defineTool({
    name: 'device_scroll_to',
    description: 'Scroll until an element (by resource_id or text/content-desc, exact then substring) comes into view, then ' +
      'tap nothing — just report it. Repeats: read UI tree → check the selector → swipe up (or left) until found or max_swipes ' +
      'exhausted. Completes the control loop for long lists: run device_wait_for won\'t scroll, this brings the element to the ' +
      'screen so a follow-up device_tap_element can hit it. Returns the found node and how many swipes it took.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      resource_id: { type: 'string', description: 'The resource-id to find, e.g. com.android.settings:id/some_item.' },
      text: { type: 'string', description: 'Text or content-desc to find (exact wins; falls back to substring).' },
      max_swipes: { type: 'integer', description: 'Swipe budget before giving up (default 8).' },
      direction: { type: 'string', enum: ['up', 'left'], description: 'Which way to swipe (default up).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          found: { type: 'boolean', required: true },
          swipes: { type: 'integer', required: true },
          node: { type: 'string' },
          bounds: { type: 'array', items: { type: 'integer' } },
          x: { type: 'integer' },
          y: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', found: false, swipes: 0 }
        return [{ type: 'text', text: v.found
          ? `Found ${v.node} at ${v.bounds?.join(',') ?? ''} (center ${v.x},${v.y}) after ${v.swipes} swipe(s) on ${v.serial} — device_tap_element it (text/resource_id) or tap ${v.x},${v.y} via device_input`
          : `Not found after ${v.swipes} swipes on ${v.serial} — the element may live behind a deeper navigation, or the selector is wrong (run device_ui_tree / device_screen to check).` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const selector = { identifier: args.resource_id, label: args.text }
      const maxSwipes = Math.min(Math.max(args.max_swipes ?? 8, 1), 20)
      const direction = args.direction === 'left' ? 'left' : 'up'
      // Screen size drives the swipe path so it works on any panel.
      let swipes = 0
      for (;;) {
        const parsed = await UiTree.readUiTree(serial)
        const found = findMatchingNode(parsed.roots, selector)
        if (found) {
          const center = UiTree.boundsCenter(found.bounds)
          return { serial, found: true, swipes, node: found.text || found.contentDesc || found.resourceId || found.type, bounds: [found.bounds.x, found.bounds.y, found.bounds.w, found.bounds.h], x: center.x, y: center.y }
        }
        if (swipes >= maxSwipes) return { serial, found: false, swipes }
        const sizeStr = await DeviceBuild.adbRun(serial, ['shell', 'wm', 'size']).catch(() => '')
        const override = /Override size:\s*(\d+)x(\d+)/.exec(sizeStr)
        const physical = /Physical size:\s*(\d+)x(\d+)/.exec(sizeStr)
        const match = override ?? physical
        if (!match) throw new Error(`cannot read the screen size of ${serial} (wm size returned nothing) — cannot swipe`)
        const w = Number(match[1]); const h = Number(match[2])
        const fromX = Math.round(w / 2); const fromY = Math.round(h * 0.7); const toY = Math.round(h * 0.3)
        if (direction === 'left') {
          await DeviceBuild.adbRun(serial, ['shell', 'input', 'swipe', String(Math.round(w * 0.8)), String(Math.round(h / 2)), String(Math.round(w * 0.2)), String(Math.round(h / 2)), '400'])
        } else {
          await DeviceBuild.adbRun(serial, ['shell', 'input', 'swipe', String(fromX), String(fromY), String(fromX), String(toY), '400'])
        }
        swipes += 1
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    },
  })
}

function deviceConnectTool() {
  return defineTool({
    name: 'device_connect',
    description: 'Attach an Android device over Wi-Fi: `adb connect <host>:<port>` (requires the phone\'s Wireless debugging' +
      ' "Pair device" flow the first time — pass pairing_code to pair first). Reattaching a known wireless device needs no' +
      ' code. Returns the connected serial.',
    parameters: {
      host: { type: 'string', description: 'IP address (or mDNS name) of the device.' },
      port: { type: 'integer', description: 'Connect port (default 5555).' },
      pairing_code: { type: 'string', description: 'Six-digit pairing code shown by "Wireless debugging → Pair device".' },
      pairing_port: { type: 'integer', description: 'Pairing port shown by the pairing dialog (default 37000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          paired: { type: 'boolean' },
          connected: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', connected: false }
        return [{ type: 'text', text: `${v.connected ? 'Connected' : 'Failed to connect'} to ${v.serial}${v.paired ? ' (paired)' : ''}` }]
      },
    },
    async execute(args) {
      const host = String(args.host ?? '').trim().replace(/^adb:\/\//, '')
      if (host === '') throw new Error('device_connect requires a host (IP address).')
      const port = args.port ?? 5555
      const target = `${host}:${port}`
      let paired
      const code = String(args.pairing_code ?? '').trim()
      if (code !== '') {
        const pairPort = args.pairing_port ?? 37000
        await DeviceBuild.adbPair(`${host}:${pairPort}`, code)
        paired = true
      }
      const connected = await DeviceBuild.adbConnectSerial(target)
      if (!connected) throw new Error(`adb connect ${target} failed — check the Wi-Fi IP/port and that Wireless debugging is on; if it needs pairing, pass pairing_code + pairing_port.`)
      return { serial: target, paired, connected: true }
    },
  })
}

function devicePairQrTool() {
  return defineTool({
    name: 'device_pair_qr',
    description: 'The full Wi-Fi pairing flow: generates a WIFI:T:ADB QR string (render it as a QR code — any QR generator ' +
      'works — and scan it with the phone: Settings → Connected devices → Pair by QR), waits for the phone to advertise its ' +
      'pairing service over mDNS (`adb mdns services`, needs adb >= 31), then auto-pairs and connects. One call covers ' +
      'generate → wait → pair → connect.',
    parameters: {
      timeout_ms: { type: 'integer', description: 'How long to wait for the QR scan (default 60000).' },
      serial: { type: 'string', description: 'Only used to pre-check adb is present; pairing targets whatever the QR scan names.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          qr_text: { type: 'string', required: true },
          name: { type: 'string', required: true },
          password: { type: 'string', required: true },
          status: { type: 'string', required: true },
          serial: { type: 'string' },
          how: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { qr_text: '', name: '', password: '', status: '' }
        const lines = [`WIFI:T:ADB QR (status ${v.status})`, `  ${v.qr_text}`, '']
        if (v.serial) lines.push(`Paired & connected: ${v.serial}`)
        lines.push('Scan the QR text above with the phone: Settings → Connected devices → Pair by QR. Any QR generator renders it.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 60_000, 10_000), 180_000)
      const { name, password } = DeviceBuild.randomQrCredentials()
      const qrText = DeviceBuild.generateQrAdbWifi(name, password)
      const how = 'Render the returned qr_text as a QR code and scan it with the phone (Settings → Connected devices → Pair by QR). Pairing + connect happen automatically once scanned.'
      const pairingSerial = await DeviceBuild.waitForMdnsPairing(timeoutMs)
      if (pairingSerial === undefined) {
        return { qr_text: qrText, name, password, status: 'timeout', how }
      }
      await DeviceBuild.adbPair(pairingSerial, password)
      // The pairing dialog usually pairs the tls-port; the connect port is 5555 or mdns-advertised — try 5555.
      const connectHost = pairingSerial.split(':')[0]
      const connected = await DeviceBuild.adbConnectSerial(`${connectHost}:5555`)
      if (!connected) {
        return { qr_text: qrText, name, password, status: 'paired-not-connected', serial: pairingSerial, how }
      }
      return { qr_text: qrText, name, password, status: 'connected', serial: `${connectHost}:5555`, how }
    },
  })
}

function devicePerfTool() {
  return defineTool({
    name: 'device_perf',
    description: 'One-shot memory / battery / CPU snapshot of an attached Android device (reads /proc/meminfo, dumpsys battery, ' +
      '/proc/cpuinfo). Use to check the device\'s resource state before or after a run — cheap and deterministic.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          memory: { type: 'object', additionalProperties: true },
          battery: { type: 'object', additionalProperties: true },
          cpu: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '' }
        const mem = v.memory ? `RAM ${v.memory.usedPercent}% used (${Math.round(v.memory.usedKb / 1024)}/${Math.round(v.memory.totalKb / 1024)} MB)` : 'RAM n/a'
        const bat = v.battery && v.battery.level !== undefined ? `Battery ${v.battery.level}% ${v.battery.temperatureC !== undefined ? `(${v.battery.temperatureC}°C) ` : ''}${v.battery.status}` : 'Battery n/a'
        const cpu = v.cpu && v.cpu.cores ? `CPU ${v.cpu.cores} cores${v.cpu.hardware ? ` (${v.cpu.hardware})` : ''}` : 'CPU n/a'
        return [{ type: 'text', text: `${v.serial}: ${mem} · ${bat} · ${cpu}` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const [meminfo, battery, cpuinfo] = await Promise.all([
        DeviceBuild.adbRun(serial, ['shell', 'cat', '/proc/meminfo']).catch(() => ''),
        DeviceBuild.adbRun(serial, ['shell', 'dumpsys', 'battery']).catch(() => ''),
        DeviceBuild.adbRun(serial, ['shell', 'cat', '/proc/cpuinfo']).catch(() => ''),
      ])
      return DeviceBuild.jsonSafe({
        serial,
        memory: DeviceBuild.parseMeminfo(meminfo),
        battery: parseBatteryShaped(battery),
        cpu: DeviceBuild.parseCpuinfo(cpuinfo),
      })
    },
  })
}

/** battery status words: dumpsys battery status 2=charging, 5=full etc. */
function parseBatteryShaped(output) {
  const raw = DeviceBuild.parseBattery(output)
  if (raw === undefined) return undefined
  const status = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not charging', 5: 'full' }[raw.status] ?? raw.status
  const health = { 1: 'unknown', 2: 'good', 3: 'overheat', 4: 'dead', 5: 'over-voltage', 6: 'unspecified', 7: 'cold' }[raw.health] ?? raw.health
  return { ...raw, status, health }
}

function deviceAppInfoTool() {
  return defineTool({
    name: 'device_app_info',
    description: 'Detail for one installed app: versionName/versionCode, minSdk/targetSdk, requested permissions, and exported ' +
      'activities — straight from `dumpsys package <pkg>`. Use to answer "what does this app do / what permissions / which ' +
      'version" without guessing.',
    parameters: {
      package: { type: 'string', description: 'Package name, e.g. com.android.chrome.' },
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          package: { type: 'string', required: true },
          versionName: { type: 'string' },
          versionCode: { type: 'string' },
          minSdk: { type: 'string' },
          targetSdk: { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } },
          activities: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value ?? { package: '' }
        const lines = [`${v.package}`, `  version ${v.versionName ?? '?'} (${v.versionCode ?? '?'}) · minSdk ${v.minSdk ?? '?'} · targetSdk ${v.targetSdk ?? '?'}`]
        if (v.permissions?.length) lines.push(`  permissions (${v.permissions.length}):`, v.permissions.slice(0, 15).map((p) => `    ${p}`).join('\n'))
        if (v.activities?.length) lines.push(`  activities (${v.activities.length}):`, v.activities.slice(0, 8).map((a) => `    ${a}`).join('\n'))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const pkg = String(args.package ?? '').trim()
      if (pkg === '') throw new Error('device_app_info requires a package name.')
      const output = await DeviceBuild.adbRun(serial, ['shell', 'dumpsys', 'package', pkg])
      const info = DeviceBuild.parseAppInfo(output, pkg)
      if (info.versionName === undefined) throw new Error(`package ${pkg} is not installed (dumpsys package returned nothing for it) — run device_apps to list what is.`)
      return DeviceBuild.jsonSafe(info)
    },
  })
}

function deviceInstallTool() {
  return defineTool({
    name: 'device_install',
    description: 'Install a local APK onto an attached Android device (`adb install -r -g`: replace + grant runtime permissions). ' +
      'The apk_path is a LOCAL path on this host (e.g. a build output). Independent of device_run — use it to sideload a debug ' +
      'build onto a device whose app is already set up.',
    parameters: {
      apk_path: { type: 'string', description: 'Absolute local path to the APK, e.g. F:/app/build/outputs/apk/debug/app-debug.apk.' },
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          apk: { type: 'string', required: true },
          installed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', apk: '', installed: false }
        return [{ type: 'text', text: `Installed ${v.apk} on ${v.serial} (${v.installed ? 'ok' : 'failed'})` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const apk = String(args.apk_path ?? '').trim()
      if (apk === '') throw new Error('device_install requires apk_path.')
      if (!existsSync(apk)) throw new Error(`APK not found on this host: ${apk}`)
      const output = await DeviceBuild.adbRun(serial, ['install', '-r', '-g', apk], { timeoutMs: 180_000 })
      if (!/success/i.test(output)) throw new Error(`adb install failed on ${serial}: ${output.slice(-300)}`)
      return { serial, apk, installed: true }
    },
  })
}

function deviceUninstallTool() {
  return defineTool({
    name: 'device_uninstall',
    description: 'Uninstall an app from an attached Android device (`adb uninstall <pkg>`, keeps data unless -k is wanted). ' +
      'Irreversible — the app\'s data is removed. Confirm the intent before calling.',
    parameters: {
      package: { type: 'string', description: 'Package name to remove, e.g. com.example.app.' },
      keep_data: { type: 'boolean', description: 'Pass -k to keep the app data (default false).' },
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          package: { type: 'string', required: true },
          uninstalled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', package: '', uninstalled: false }
        return [{ type: 'text', text: `Uninstalled ${v.package} on ${v.serial} (${v.uninstalled ? 'ok' : 'failed'})` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const pkg = String(args.package ?? '').trim()
      if (pkg === '') throw new Error('device_uninstall requires a package name.')
      const argv = args.keep_data === true ? ['uninstall', '-k', pkg] : ['uninstall', pkg]
      const output = await DeviceBuild.adbRun(serial, argv)
      if (!/success/i.test(output)) throw new Error(`adb uninstall failed on ${serial}: ${output.slice(-300)}`)
      return { serial, package: pkg, uninstalled: true }
    },
  })
}

function deviceRebootTool() {
  return defineTool({
    name: 'device_reboot',
    description: 'Reboot an attached Android device: `adb reboot` (normal), recovery, or bootloader. The device goes offline and ' +
      'comes back in a minute or two — a subsequent call to a device_* tool will auto-wait or fail with a reconnect hint. ' +
      'Disruptive: rebooting interrupts anything running on the device.',
    parameters: {
      mode: { type: 'string', enum: ['normal', 'recovery', 'bootloader'], description: 'Where to reboot into (default normal).' },
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          rebooting: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Rebooting ${value?.serial} into ${value?.mode}` }],
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const mode = args.mode === 'recovery' || args.mode === 'bootloader' ? args.mode : 'normal'
      const argv = mode === 'normal' ? ['reboot'] : ['reboot', mode]
      await DeviceBuild.adbRun(serial, argv)
      return { serial, mode, rebooting: true }
    },
  })
}

function deviceUiRowsTool() {
  return defineTool({
    name: 'device_ui_rows',
    description: 'Detect the list/feed ROWS on the attached Android screen (Settings pages, inboxes, feeds): every row reports ' +
      'its index, an isomorphic group id, its pixel frame, the aggregated visible label, and any parsed counters (e.g. "3万 粉丝" ' +
      '→ {key:"粉丝", value:30000}, "1.2k likes" → {key:"likes", value:1200}). Rows are the unit the user sees — use this instead of ' +
      'device_ui_tree when the screen is a list, then tap a row by index with device_tap_row. Row detection is repetition-based: ' +
      '>=3 sibling subtrees of one parent sharing a class and near-equal height (tolerance max(8px, 15%)).',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      filter: { type: 'string', description: 'Optional case-insensitive substring; keep only rows whose label contains it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          screen: {
            type: 'object',
            additionalProperties: false,
            properties: {
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          omittedOffscreen: { type: 'integer' },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                group: { type: 'integer', required: true },
                frame: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'integer', required: true },
                    y: { type: 'integer', required: true },
                    w: { type: 'integer', required: true },
                    h: { type: 'integer', required: true },
                  },
                },
                label: { type: 'string', required: true },
                counters: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      key: { type: 'string', required: true },
                      value: { type: 'number', required: true },
                      raw: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', rows: [] }
        const lines = [`Device: ${v.serial} — ${v.rows.length} row(s)${v.omittedOffscreen ? ` (${v.omittedOffscreen} off-screen omitted)` : ''}`]
        for (const row of v.rows.slice(0, 20)) {
          const counterText = row.counters.length > 0 ? ` [${row.counters.map((c) => `${c.key}=${c.value}`).join(', ')}]` : ''
          lines.push(`  #${row.index} g${row.group} @${row.frame.x},${row.frame.y} ${row.frame.w}x${row.frame.h} — ${row.label || '(no text)'}${counterText}`)
        }
        if (v.rows.length > 20) lines.push(`  ... and ${v.rows.length - 20} more`)
        if (v.rows.length === 0) lines.push('No repeated rows detected — the screen may not be a list, or it may need a scroll (see device_scroll_to).')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const parsed = await UiTree.readUiTree(serial)
      const screen = UiTree.screenBoundsOf(parsed.roots)
      const { rows, omittedOffscreen } = RowList.detectRows(parsed.roots, screen)
      const filter = args.filter !== undefined && String(args.filter).trim() !== '' ? String(args.filter).trim().toLowerCase() : undefined
      const out = {
        serial,
        screen: { width: screen.width, height: screen.height },
        omittedOffscreen,
        rows: rows.filter((row) => filter === undefined || row.label.toLowerCase().includes(filter)),
      }
      return DeviceBuild.jsonSafe(out)
    },
  })
}

function deviceTapRowTool() {
  return defineTool({
    name: 'device_tap_row',
    description: 'Tap inside a list/feed row by index (from device_ui_rows) at a row-relative position: x,y are fractions of the ' +
      'row frame (default 0.5,0.5 = the row center). Optional expect_count {key, delta} turns the tap into one verified round trip: ' +
      'the counter must ALREADY be visible in the row before the tap (refused otherwise — never probe an unknown control), and after ' +
      'an 800ms settle the row at the same index + position must show the count changed by EXACTLY delta (default +1).',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      row: { type: 'integer', description: 'Zero-based row index from device_ui_rows.', required: true },
      x: { type: 'number', description: 'Row-relative X fraction 0..1 (0 = left edge, 1 = right edge). Default 0.5.' },
      y: { type: 'number', description: 'Row-relative Y fraction 0..1. Default 0.5.' },
      expect_count: {
        type: 'object',
        additionalProperties: false,
        description: 'Verify a counter changed by exactly delta after the tap.',
        properties: {
          key: { type: 'string', description: 'Counter key as reported by device_ui_rows (e.g. "粉丝", "likes").', required: true },
          delta: { type: 'integer', description: 'Expected change: 1 (default) or -1.' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          row: { type: 'integer', required: true },
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          expect: {
            type: 'object',
            additionalProperties: false,
            properties: {
              verified: { type: 'boolean', required: true },
              reason: { type: 'string' },
              before: { type: 'number' },
              after: { type: 'number' },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', row: 0, x: 0, y: 0 }
        const lines = [`Tapped row #${v.row} at ${v.x},${v.y} on ${v.serial}`]
        if (v.expect) {
          lines.push(`Expect_count: ${v.expect.verified ? 'VERIFIED' : 'NOT verified'}${v.expect.reason ? ` — ${v.expect.reason}` : ''}${v.expect.before !== undefined ? ` (${v.expect.before} → ${v.expect.after})` : ''}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      if (!Number.isInteger(args.row) || args.row < 0) throw new Error('device_tap_row requires a non-negative integer row index (see device_ui_rows).')
      const parsed = await UiTree.readUiTree(serial)
      const screen = UiTree.screenBoundsOf(parsed.roots)
      const { rows } = RowList.detectRows(parsed.roots, screen)
      const row = rows[args.row]
      if (row === undefined) throw new Error(`row ${args.row} does not exist — device_ui_rows reported ${rows.length} row(s). Re-run it for fresh indices.`)
      const fractionX = args.x === undefined ? 0.5 : args.x
      const fractionY = args.y === undefined ? 0.5 : args.y
      const expect = args.expect_count
      if (expect) {
        const key = RowList.normalizeCountKey(String(expect.key))
        if (!row.counters.some((c) => c.key === key)) {
          throw new Error(`refusing to tap: counter "${expect.key}" is not visible in row ${args.row} ("${row.label}") — pass a key device_ui_rows reported.`)
        }
      }
      const point = RowList.planRowTap(rows, args.row, fractionX, fractionY)
      await DeviceBuild.adbRun(serial, ['shell', 'input', 'tap', String(point.x), String(point.y)])
      const out = { serial, row: args.row, x: point.x, y: point.y }
      if (expect) {
        await new Promise((resolve) => setTimeout(resolve, 800))
        const fresh = await UiTree.readUiTree(serial).catch(() => undefined)
        if (fresh === undefined) {
          out.expect = { verified: false, reason: 'could not re-read the screen after the tap' }
        } else {
          const freshRows = RowList.detectRows(fresh.roots, UiTree.screenBoundsOf(fresh.roots)).rows
          const afterRow = freshRows[args.row]
          const key = RowList.normalizeCountKey(String(expect.key))
          const delta = expect.delta === undefined ? 1 : Number(expect.delta)
          const verification = afterRow !== undefined && RowList.rowsStayedPut(row, afterRow)
            ? RowList.verifyCountChange(row, afterRow, key, delta)
            : { verified: false, reason: 'the list moved after the tap (row at this index changed position) — the count could not be verified' }
          out.expect = {
            verified: verification.verified,
            ...(verification.reason ? { reason: verification.reason } : {}),
            ...(verification.before !== undefined ? { before: verification.before, after: verification.after } : {}),
          }
        }
      }
      return DeviceBuild.jsonSafe(out)
    },
  })
}

function deviceBacktraceTool() {
  return defineTool({
    name: 'device_backtrace',
    description: 'Capture a native/ANR thread backtrace or crash log for an app on the device. Sends SIGQUIT (kill -3) to the process, ' +
      'waits for the ART runtime to write the thread dump, then reads the newest /data/anr entry. When /data/anr is unrunnable it falls ' +
      'back to the logcat crash buffer and says so (engine field: "anr-trace" | "logcat-crash"). SIGQUIT refusal (system-uid or ' +
      'non-debuggable process) degrades to the crash buffer with an explanatory note instead of failing. Pass package_name or pid.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      package_name: { type: 'string', description: 'Package of the process to trace (e.g. com.simspoof.app).' },
      pid: { type: 'integer', description: 'Explicit pid; resolved from package_name when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          package_name: { type: 'string' },
          pid: { type: 'integer', required: true },
          trace_path: { type: 'string' },
          note: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', engine: '', pid: 0, lines: [] }
        const lines = [`Backtrace of pid ${v.pid} on ${v.serial} (engine: ${v.engine})${v.trace_path ? ` — ${v.trace_path}` : ''}`]
        if (v.note) lines.push(v.note)
        for (const line of v.lines.slice(-40)) lines.push(`  ${line}`)
        if (v.lines.length > 40) lines.push(`  ... ${v.lines.length - 40} more lines`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const packageName = args.package_name !== undefined && args.package_name !== '' ? String(args.package_name) : undefined
      let pid
      if (args.pid !== undefined && Number.isInteger(args.pid) && args.pid > 0) {
        pid = args.pid
      } else if (packageName) {
        const pidout = await DeviceBuild.adbRun(serial, ['shell', 'pidof', '-s', DeviceBuild.shQuoteDevice(packageName)]).catch(() => undefined)
        const parsedPid = Number((pidout ?? '').trim())
        if (Number.isInteger(parsedPid) && parsedPid > 0) pid = parsedPid
        if (pid === undefined) {
          const ps = await DeviceBuild.adbRun(serial, ['shell', 'ps', '-A']).catch(() => '')
          const match = ps.split(/\r?\n/).find((line) => /\s+\d+\s/.test(line) && line.split(/\s+/).pop() === packageName)
          pid = match ? Number(/\s+(\d+)\s+/.exec(match)?.[1]) : undefined
        }
      }
      if (pid === undefined) {
        throw new Error(`device_backtrace could not resolve a running process for ${packageName ? `"${packageName}"` : 'the request'} on ${serial} — pass a package_name of a running app, or an explicit pid.`)
      }
      // SIGQUIT: the ART runtime writes the thread dump to /data/anr/. The adb
      // shell user cannot signal system-uid / non-debuggable processes on
      // enforcing builds (EPERM) — degrade honestly instead of throwing.
      let sigquit = true
      try {
        await DeviceBuild.adbRun(serial, ['shell', 'kill', '-3', String(pid)])
      } catch {
        sigquit = false
      }
      let newest
      if (sigquit) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const listing = await DeviceBuild.adbRun(serial, ['shell', 'ls', '-t', '/data/anr']).catch(() => undefined)
        newest = (listing ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.includes(' '))[0]
        if (newest !== undefined) {
          const content = await DeviceBuild.adbRun(serial, ['shell', 'cat', DeviceBuild.shQuoteDevice(`/data/anr/${newest}`)], { timeoutMs: 30_000 }).catch(() => undefined)
          if (content !== undefined && content.trim() !== '') {
            return DeviceBuild.jsonSafe({
              serial,
              engine: 'anr-trace',
              ...(packageName ? { package_name: packageName } : {}),
              pid,
              trace_path: `/data/anr/${newest}`,
              lines: content.split(/\r?\n/).slice(-250),
            })
          }
        }
      }
      // Fallback: the logcat crash buffer (FATAL/AndroidRuntime lines), filtered by package when known.
      const log = await DeviceBuild.adbRun(serial, ['logcat', '-b', 'crash', '-d', '-v', 'time']).catch(() => '')
      const all = log.split(/\r?\n/).filter((line) => /FATAL EXCEPTION|AndroidRuntime|DEBUG|Abort message/.test(line))
      const lines = (packageName ? all.filter((line) => line.includes(packageName)) : all)
      if (lines.length === 0) {
        // Keep the honest fallback note: anr-trace failed; crash buffer silent.
        return DeviceBuild.jsonSafe({
          serial,
          engine: 'logcat-crash',
          ...(packageName ? { package_name: packageName } : {}),
          pid,
          note: sigquit
            ? `SIGQUIT sent to pid ${pid}; /data/anr was ${newest === undefined ? 'empty/unreadable' : `read but produced no content for ${newest}`}; the logcat crash buffer has no matching FATAL lines now. The app may not have crashed — check device_log for the main buffer.`
            : `SIGQUIT refused for pid ${pid} — the adb shell user cannot signal this process (system uid or non-debuggable app on an enforcing build), so no fresh thread dump exists; the logcat crash buffer has no matching FATAL lines either. Target a debuggable app for a live dump, or use an adb-rooted device.`,
          lines: [],
        })
      }
      return DeviceBuild.jsonSafe({
        serial,
        engine: 'logcat-crash',
        ...(packageName ? { package_name: packageName } : {}),
        pid,
        note: '/data/anr unreadable; fell back to the logcat crash buffer.',
        lines: lines.slice(-200),
      })
    },
  })
}

function deviceMeminfoTool() {
  return defineTool({
    name: 'device_meminfo',
    description: 'Read a running app\'s memory profile from `dumpsys meminfo <package>`: TOTAL PSS/RSS/Swap-PSS plus the App Summary heap ' +
      'breakdown (Java/Native/Code/Stack/Graphics) and the top PSS categories (mmap regions etc.). Throws when the package has no running ' +
      'process. Use to check an app\'s footprint after a run, or to compare builds.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      package_name: { type: 'string', description: 'Package to profile (see device_apps).', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          package_name: { type: 'string', required: true },
          totalPssKb: { type: 'number' },
          totalRssKb: { type: 'number' },
          totalSwapPssKb: { type: 'number' },
          appSummary: {
            type: 'object',
            additionalProperties: true,
            description: 'PSS KB per heap bucket: {javaHeapKb, nativeHeapKb, codeKb, stackKb, graphicsKb}.',
          },
          topCategories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                pssKb: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', package_name: '' }
        const mb = (kb) => (kb === undefined ? '?' : `${Math.round(kb / 1024)} MB`)
        const lines = [`Memory of ${v.package_name} on ${v.serial}`]
        lines.push(`  TOTAL PSS: ${mb(v.totalPssKb)}  RSS: ${mb(v.totalRssKb)}  SwapPSS: ${mb(v.totalSwapPssKb)}`)
        if (v.appSummary && Object.keys(v.appSummary).length > 0) {
          const labels = { javaHeapKb: 'Java heap', nativeHeapKb: 'Native heap', codeKb: 'Code', stackKb: 'Stack', graphicsKb: 'Graphics' }
          const parts = []
          for (const [key, label] of Object.entries(labels)) {
            if (v.appSummary[key] !== undefined) parts.push(`${label}: ${mb(v.appSummary[key])}`)
          }
          if (parts.length > 0) lines.push(`  App Summary — ${parts.join(', ')}`)
        }
        if (v.topCategories && v.topCategories.length > 0) {
          lines.push('  Top categories:')
          for (const category of v.topCategories.slice(0, 6)) lines.push(`    - ${category.name}: ${mb(category.pssKb)}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const packageName = String(args.package_name ?? '').trim()
      if (packageName === '') throw new Error('device_meminfo requires a package_name (see device_apps).')
      const output = await DeviceBuild.adbRun(serial, ['shell', 'dumpsys', 'meminfo', packageName], { timeoutMs: 30_000 })
      const parsed = DeviceBuild.parsePackageMeminfo(output)
      if (parsed === undefined) throw new Error(`\`dumpsys meminfo ${packageName}\` produced no process block on ${serial} — is ${packageName} running?`)
      return DeviceBuild.jsonSafe({ serial, package_name: packageName, ...parsed })
    },
  })
}

// ── display, fleet, co-op observation + mesh tools (v0.8.0) ─────────────────

/** Drop null/undefined fields so strict output schemas stay satisfiable. */
function clean(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined))
}

function deviceDisplayTool() {
  return defineTool({
    name: 'device_display',
    description: 'Read or change a device display metrics: DPI (wm density) and pixel resolution (wm size). ' +
      'action=get reports physical + current override; action=set applies overrides (density and/or width+height); ' +
      'action=reset restores physical values for both. Layouts reflow instantly — re-observe with device_screen ' +
      'after a change, and remember input coordinates follow the new resolution.',
    parameters: {
      serial: { type: 'string', description: 'Android device serial. Omit to use the first attached device.' },
      action: { type: 'string', enum: ['get', 'set', 'reset'], description: 'Defaults to get.' },
      density: { type: 'integer', description: 'DPI to set (action=set), 80..800 — e.g. 420 for a phone, 260 for a tablet-ish look.' },
      width: { type: 'integer', description: 'Resolution width px to set (action=set, requires height).' },
      height: { type: 'integer', description: 'Resolution height px to set (action=set, requires width).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          action: { type: 'string', required: true },
          density: {
            type: 'object',
            additionalProperties: false,
            properties: { physical: { type: 'integer' }, override: { type: 'integer' } },
          },
          size: {
            type: 'object',
            additionalProperties: false,
            properties: {
              physical: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
              override: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
            },
          },
          applied: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value ?? { serial: '', action: 'get' }
        const d = v.density ?? {}
        const s = v.size ?? {}
        const dpi = `DPI ${d.override ?? d.physical ?? '?'}${d.override ? ` (physical ${d.physical}, overridden)` : ''}`
        const px = s.physical ? `${s.override?.width ?? s.physical.width}x${s.override?.height ?? s.physical.height}${s.override ? ` (physical ${s.physical.width}x${s.physical.height})` : ''}` : 'size unknown'
        const applied = v.applied?.length ? ` → applied: ${v.applied.join(', ')}` : ''
        return [{ type: 'text', text: `${v.serial} [${v.action}]: ${dpi} · ${px}${applied}` }]
      },
    },
    async execute(args) {
      const serial = await requireAndroidDevice(args.serial)
      const action = args.action ?? 'get'
      const applied = []
      if (action === 'set') {
        const { density, width, height } = args
        if (density == null && width == null && height == null) throw new Error('action=set needs density and/or width+height (or use get/reset).')
        if ((width == null) !== (height == null)) throw new Error('setting resolution needs BOTH width and height.')
        if (density != null && (density < 80 || density > 800)) throw new Error('density must be within 80..800.')
        if (width != null && (width < 100 || width > 10_000 || height < 100 || height > 10_000)) throw new Error('resolution sides must each be 100..10000 px.')
        if (width != null) {
          await DeviceBuild.adbRun(serial, ['shell', 'wm', 'size', `${width}x${height}`])
          applied.push(`size ${width}x${height}`)
        }
        if (density != null) {
          await DeviceBuild.adbRun(serial, ['shell', 'wm', 'density', String(density)])
          applied.push(`density ${density}`)
        }
      } else if (action === 'reset') {
        await DeviceBuild.adbRun(serial, ['shell', 'wm', 'density', 'reset'])
        await DeviceBuild.adbRun(serial, ['shell', 'wm', 'size', 'reset'])
        applied.push('density reset', 'size reset')
      }
      const [densityText, sizeText] = await Promise.all([
        DeviceBuild.adbRun(serial, ['shell', 'wm', 'density']),
        DeviceBuild.adbRun(serial, ['shell', 'wm', 'size']),
      ])
      return {
        serial,
        action,
        density: clean(DeviceBuild.parseWmDensity(densityText)),
        size: clean(DeviceBuild.parseWmSize(sizeText)),
        ...(applied.length ? { applied } : {}),
      }
    },
  })
}

/** Prefer the newest API level when picking a default system image. */
function newestImage(images) {
  const apiOf = (id) => Number(/android-(\d+)/.exec(id)?.[1] ?? 0)
  return [...images].sort((a, b) => apiOf(a) - apiOf(b)).at(-1)
}

function deviceAvdCreateTool() {
  return defineTool({
    name: 'device_avd_create',
    description: 'Create a second virtual device (the co-op partner) via avdmanager. clone_from copies an existing ' +
      'AVD\'s full hardware config (same image, DPI, RAM, SoC) so both players behave identically; otherwise pass an ' +
      'explicit image id + device profile. This only creates the AVD — boot it with device_boot (a running emulator ' +
      'holds 5554, so device #2 lands on emulator-5556 automatically), then wire the two together with the mesh.',
    parameters: {
      name: { type: 'string', description: 'New AVD name (letters/digits/._-, up to 64).' },
      clone_from: { type: 'string', description: 'Existing AVD whose config.ini to clone (recommended for parity).' },
      image: { type: 'string', description: 'System-image package id (e.g. system-images;android-35;google_apis;x86_64). Defaults to the clone source\'s image, else the newest installed.' },
      device: { type: 'string', description: 'avdmanager hardware profile when not cloning (default pixel_7).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          imageId: { type: 'string', required: true },
          configPath: { type: 'string', required: true },
          clonedFrom: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { name: '', imageId: '', configPath: '' }
        return [{ type: 'text', text: `Created AVD "${v.name}" (${v.imageId}${v.clonedFrom ? `, cloned hardware from ${v.clonedFrom}` : ''}) — boot it with device_boot.` }]
      },
    },
    async execute(args) {
      const name = String(args.name ?? '').trim()
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('AVD name must match [A-Za-z0-9._-]{1,64}.')
      if (!DeviceBuild.avdmanagerBinary()) throw new Error('avdmanager not found — install SDK cmdline-tools (sdkmanager --install "cmdline-tools;latest").')
      const avds = await DeviceBuild.androidAvds()
      if (avds.includes(name)) throw new Error(`AVD "${name}" already exists — boot it with device_boot or choose another name.`)
      let cloneConfig
      let imageId = typeof args.image === 'string' && args.image.includes(';') ? args.image.trim() : undefined
      if (args.clone_from) {
        if (!avds.includes(args.clone_from)) throw new Error(`clone_from "${args.clone_from}" is not a known AVD (see device_status.avds).`)
        try { cloneConfig = readFileSync(DeviceBuild.avdConfigPath(args.clone_from), 'utf8') } catch { throw new Error(`could not read config.ini for "${args.clone_from}".`) }
        if (!imageId) {
          const sysdir = /^\s*image\.sysdir\.1\s*=\s*(.+)$/m.exec(cloneConfig)?.[1]?.trim()
          if (sysdir) imageId = sysdir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').join(';')
        }
      }
      if (!imageId) {
        const images = await DeviceBuild.installedSystemImages()
        if (images.length === 0) throw new Error('no system images installed — install one first: sdkmanager --install "system-images;android-35;google_apis;x86_64".')
        imageId = newestImage(images)
      }
      const created = await DeviceBuild.createAvd({ name, imageId, deviceProfile: imageId && !cloneConfig ? (args.device ?? 'pixel_7') : undefined, cloneConfigText: cloneConfig })
      return { name, imageId, configPath: created.configPath, ...(args.clone_from ? { clonedFrom: args.clone_from } : {}) }
    },
  })
}

/**
 * Pure adb-argv builder for one device_batch step (exported for offline tests).
 * Throws with the offending step named when the parameters do not fit the action.
 */
export function buildInputArgv(step) {
  const action = step?.action ?? 'tap'
  const int = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined)
  switch (action) {
    case 'tap': {
      const x = int(step.x)
      const y = int(step.y)
      if (x === undefined || y === undefined) throw new Error('step action=tap needs numeric x and y.')
      return { argv: ['shell', 'input', 'tap', String(x), String(y)], sent: `tap ${x},${y}` }
    }
    case 'swipe': {
      const x = int(step.x)
      const y = int(step.y)
      const x2 = int(step.x2)
      const y2 = int(step.y2)
      if ([x, y, x2, y2].some((value) => value === undefined)) throw new Error('step action=swipe needs numeric x, y, x2, y2.')
      const duration = int(step.duration) ?? 200
      return { argv: ['shell', 'input', 'swipe', String(x), String(y), String(x2), String(y2), String(duration)], sent: `swipe ${x},${y}→${x2},${y2}` }
    }
    case 'text': {
      const text = step.text
      if (typeof text !== 'string' || text === '') throw new Error('step action=text needs a non-empty text string.')
      if (!DeviceBuild.isAsciiInput(text)) throw new Error(`batch action=text is ASCII-only (non-ASCII needs the ADBKeyboard path — use device_input): "${text}".`)
      return { argv: ['shell', 'input', 'text', DeviceBuild.escapeInputText(text)], sent: `text "${text}"` }
    }
    case 'key': {
      const raw = String(step.key ?? '')
      const code = /^\d+$/.test(raw) ? Number(raw) : KEYCODES[raw.toLowerCase()]
      if (!code) throw new Error(`unknown key "${raw}" in batch step.`)
      return { argv: ['shell', 'input', 'keyevent', String(code)], sent: `key ${raw}` }
    }
    default:
      throw new Error(`unknown step action "${action}" — use tap, swipe, text or key.`)
  }
}

function deviceBatchTool() {
  return defineTool({
    name: 'device_batch',
    description: 'Fire several input actions at once across devices — the co-op primitive for "both players press ' +
      'attack on the same frame". All steps dispatch concurrently (separate adb connections, spawned in parallel, so ' +
      'cross-device skew is a few milliseconds), each step carries the same fields device_input uses plus its own ' +
      'serial (omit serial to target the first device). A failing step never blocks the others; the per-step results ' +
      'say what landed. Follow with device_pair_capture to watch what both screens did.',
    parameters: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            serial: { type: 'string' },
            action: { type: 'string', enum: ['tap', 'swipe', 'text', 'key'] },
            x: { type: 'integer' }, y: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' },
            duration: { type: 'integer' }, text: { type: 'string' }, key: { type: 'string' },
          },
        },
        description: '1..16 input steps, e.g. [{serial:"emulator-5554",action:"tap",x:540,y:1200},{serial:"emulator-5556",action:"key",key:"space"}].',
      },
      settle_ms: { type: 'integer', description: 'After the last dispatch, wait this long (0..10000, default 0) so the game can react before you observe.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                serial: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                sent: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value ?? { ok: false, results: [] }
        const lines = v.results.map((r) => `  #${r.index} ${r.serial}: ${r.ok ? r.sent : `FAILED — ${r.error}`}`)
        return [{ type: 'text', text: `device_batch ${v.ok ? 'all landed' : 'had failures'}:\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (steps.length === 0 || steps.length > 16) throw new Error('steps must hold 1..16 input actions.')
      const planned = steps.map((step, index) => ({ index, step, ...buildInputArgv(step) }))
      let fallback
      for (const item of planned) {
        if (typeof item.step.serial === 'string' && item.step.serial !== '') item.serial = item.step.serial
        else { fallback ??= await requireAndroidDevice(undefined); item.serial = fallback }
      }
      const results = await Promise.all(planned.map(async (item) => {
        try {
          await DeviceBuild.adbRun(item.serial, item.argv)
          return { index: item.index, serial: item.serial, ok: true, sent: item.sent }
        } catch (error) {
          return { index: item.index, serial: item.serial, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }))
      const settle = Math.min(Math.max(args.settle_ms ?? 0, 0), 10_000)
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle))
      return { ok: results.every((r) => r.ok), results }
    },
  })
}

/** One device's screen state for device_pair_capture (mirrors device_screen's parts). */
async function captureForPair(serial, directory, wantOcr) {
  const [png, ui, foreground, size] = await Promise.all([
    DeviceBuild.screenCapture(serial, directory).catch(() => undefined),
    DeviceBuild.uiDump(serial).catch(() => []),
    DeviceBuild.foregroundActivity(serial).catch(() => undefined),
    captureScreenSize(serial).catch(() => undefined),
  ])
  const out = { serial, ui, ...(foreground ? { foreground } : {}), ...(png ? { screenshot: png } : {}) }
  if (png && size) { out.width = size.width; out.height = size.height }
  if (wantOcr) {
    if (!png) out.ocrError = 'screenshot failed'
    else {
      const ocr = await DeviceBuild.ocrImage(png).catch(() => [])
      if (ocr.length > 0) out.ocr = ocr
      else out.ocrError = 'PaddleOCR returned no text'
    }
  }
  return out
}

function devicePairCaptureTool(vision) {
  return defineTool({
    name: 'device_pair_capture',
    description: 'Watch two devices at the same instant: one call captures BOTH screens (PNG + uiautomator digest, ' +
      'optional OCR) in parallel and attaches both screenshots as real image blocks, so a vision model sees both ' +
      'players in a single glance. This is the co-op observation primitive — call it right after device_batch (or any ' +
      'mesh_send) to watch the reaction on both sides.',
    parameters: {
      serials: { type: 'array', items: { type: 'string' }, description: 'Exactly two device serials. Defaults to the first two attached devices.' },
      ocr: { type: 'boolean', description: 'Run PaddleOCR on both screenshots (default false — slower). UI trees usually suffice.' },
      directory: { type: 'string', description: 'Where to store the PNGs (default: temp).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          devices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                serial: { type: 'string', required: true },
                screenshot: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                foreground: { type: 'string' },
                ui: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, resourceId: { type: 'string' }, bounds: { type: 'array', items: { type: 'integer' } } } } },
                ocr: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, confidence: { type: 'number' }, box: { type: 'array', items: { type: 'integer' } } } } },
                ocrError: { type: 'string' },
              },
            },
          },
          images: { type: 'array', items: Vision.IMAGE_REF_SCHEMA },
        },
      },
      render: (_args, value) => {
        const v = value ?? { devices: [] }
        const blocks = [{ type: 'text', text: 'Pair capture (both devices, same instant):' }]
        for (const device of v.devices) {
          blocks.push({
            type: 'text',
            text: [
              `▶ ${device.serial}${device.foreground ? ` — foreground: ${device.foreground}` : ''}${device.screenshot ? ` [${device.screenshot}${device.width ? ` ${device.width}x${device.height}` : ''}]` : ''}`,
              ...(device.ui ?? []).slice(0, 25).map((item) => `    - ${item.text}${item.resourceId ? ` [${item.resourceId}]` : ''}${item.bounds ? ` @${item.bounds.join(',')}` : ''}`),
              ...((device.ui?.length ?? 0) > 25 ? [`    … and ${device.ui.length - 25} more`] : []),
              ...(device.ocr ?? []).slice(0, 15).map((item) => `    “${item.text}” (${Math.round(item.confidence * 100)}%)`),
              ...(device.ocrError ? [`    OCR unavailable: ${device.ocrError}`] : []),
            ].join('\n'),
          })
        }
        return Vision.appendImageBlock(blocks, v)
      },
    },
    async execute(args, exec) {
      let serials = (Array.isArray(args.serials) ? args.serials : []).filter((s) => typeof s === 'string' && s !== '').slice(0, 2)
      if (serials.length < 2) {
        const rows = await DeviceBuild.devices()
        const online = [...new Set([...serials, ...rows.filter((r) => r.state === 'device').map((r) => r.serial)])]
        serials = online.slice(0, 2)
      }
      if (serials.length < 2) throw new Error(`device_pair_capture needs two devices — found ${serials.length}. Boot a second with device_boot, then mesh-link them.`)
      const wantOcr = args.ocr === true
      const devices = await Promise.all(serials.map((serial) => captureForPair(serial, args.directory, wantOcr)))
      const images = (await Promise.all(devices.map((device) => Vision.maybeAttachScreenshot(vision, device.screenshot, exec)))).filter((image) => image !== undefined)
      return { devices, ...(images.length > 0 ? { images } : {}) }
    },
  })
}

const MESH_POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    latencyMs: { type: 'integer', required: true },
    jitterMs: { type: 'integer', required: true },
    dropPct: { type: 'number', required: true },
    dupPct: { type: 'number', required: true },
    throttleKbps: { type: 'integer', required: true },
  },
}
const MESH_PEER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    role: { type: 'string', required: true },
    joinedAt: { type: 'integer', required: true },
    lastSeen: { type: 'integer', required: true },
    serial: { type: 'string' },
  },
}
const MESH_SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    members: { type: 'array', items: { type: 'string' }, required: true },
    policy: MESH_POLICY_SCHEMA,
    pending: { type: 'integer', required: true },
  },
}

function meshStatusTool(mesh) {
  return defineTool({
    name: 'mesh_status',
    description: 'Inspect the host mesh hub: every peer that joined from a device (a random callsign pinned to its ' +
      'serial, LocalSend-style), every session with its members, live network policy and undelivered mail. Devices ' +
      'reach this hub at http://10.0.2.2:<dsh-port>/api/dsh-mobilecode/mesh/* — games POST join {serial?,name?}, ' +
      'then link/send/poll with the returned id+token.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peers: { type: 'array', items: MESH_PEER_SCHEMA, required: true },
          sessions: { type: 'array', items: MESH_SESSION_SCHEMA, required: true },
          messageSeq: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const v = value ?? { peers: [], sessions: [], messageSeq: 0 }
        const lines = [
          `mesh: ${v.peers.length} peer(s), ${v.sessions.length} session(s), ${v.messageSeq} message(s) so far`,
          ...v.peers.map((peer) => `  ● ${peer.name}${peer.serial ? ` (${peer.serial})` : ''} [${peer.role}] last-seen ${new Date(peer.lastSeen).toISOString().slice(11, 19)}`),
          ...v.sessions.map((s) => `  ◈ ${s.id}: ${s.members.join(' ↔')} — ${JSON.stringify(s.policy)}${s.pending ? ` (${s.pending} undelivered)` : ''}`),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const status = mesh.status()
      return { peers: status.peers.map(clean), sessions: status.sessions, messageSeq: status.messageSeq }
    },
  })
}

function meshSendTool(mesh) {
  return defineTool({
    name: 'mesh_send',
    description: 'Inject a JSON message into a mesh session AS an existing peer ("ghost" the other player) — the ' +
      'fastest way to drive a co-op test without touching the app: the receiving game gets it from /mesh/poll ' +
      'exactly as if its partner sent it, and the hub applies the session latency/drop/dup policy on delivery. ' +
      'Every injection is logged (via: agent) so you can see how each side reacts.',
    parameters: {
      session: { type: 'string', description: 'Session id from mesh_status.' },
      from: { type: 'string', description: 'Peer name / id to speak as (must be a session member).' },
      body: { type: 'object', additionalProperties: true, description: 'JSON payload delivered verbatim to the other members.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'integer', required: true },
          delivered: { type: 'integer', required: true },
          dropped: { type: 'integer', required: true },
          duplicated: { type: 'integer', required: true },
          readyAt: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const v = value ?? { seq: 0, delivered: 0, dropped: 0, duplicated: 0 }
        return [{ type: 'text', text: `mesh message #${v.seq}: delivered ${v.delivered}, dropped ${v.dropped}, duplicated ${v.duplicated}${v.readyAt ? ` (due ${new Date(v.readyAt).toISOString().slice(11, 23)})` : ''}` }]
      },
    },
    async execute(args) {
      const result = mesh.send({ session: args.session, from: args.from, body: args.body ?? null, via: 'agent' })
      return clean(result)
    },
  })
}

function meshLogTool(mesh) {
  return defineTool({
    name: 'mesh_log',
    description: 'Read the mesh message log — every join/link/send/drop/dup/tune event with timestamps, sequence ' +
      'numbers, byte sizes and the acting peer. This is the wire between the players: watch the game talk, spot ' +
      'policy drops, and correlate traffic bursts with what device_pair_capture shows on both screens.',
    parameters: {
      session: { type: 'string', description: 'Only entries for this session id (default: all).' },
      limit: { type: 'integer', description: 'Most recent N entries (default 50, max 500).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true } },
      },
      render: (_args, value) => {
        const entries = value?.entries ?? []
        const text = entries.length === 0
          ? 'mesh log is empty'
          : entries.map((e) => `  ${new Date(e.ts).toISOString().slice(11, 23)} ${e.kind} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['seq', 'ts', 'kind'].includes(k))))}`).join('\n')
        return [{ type: 'text', text: `mesh log (${entries.length} entries):\n${text}` }]
      },
    },
    async execute(args) {
      return { entries: mesh.log({ session: args.session, limit: args.limit }) }
    },
  })
}

function meshTuneTool(mesh) {
    return defineTool({
    name: 'mesh_tune',
    description: 'Set the network conditions a mesh session delivers under: latencyMs delay, jitterMs random extra ' +
      'delay, dropPct random message loss, dupPct random duplicates, throttleKbps size-proportional delay (8000 bytes ' +
      'at 8 Kbps = +1000 ms). Applied per send to every recipient, zero means OFF. This is the desync-testing lever: ' +
      'make player B lag 400 ms with 100 ms jitter and watch the game handle it — no app code changes.',
    parameters: {
      session: { type: 'string', description: 'Session id from mesh_status.' },
      latencyMs: { type: 'integer', description: 'Fixed per-message delay, 0..5000.' },
      jitterMs: { type: 'integer', description: 'Random extra delay 0..jitterMs, 0..5000.' },
      dropPct: { type: 'number', description: 'Chance each recipient-copy is dropped, 0..100.' },
      dupPct: { type: 'number', description: 'Chance each delivered copy is duplicated, 0..100.' },
      throttleKbps: { type: 'integer', description: 'Bandwidth cap: adds bytes*8/kbps ms per message. 0 = unlimited.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: { type: 'string', required: true },
          policy: MESH_POLICY_SCHEMA,
        },
      },
      render: (_args, value) => {
        const v = value ?? { session: '', policy: {} }
        return [{ type: 'text', text: `session ${v.session} policy → ${JSON.stringify(v.policy)}` }]
      },
    },
    async execute(args) {
      const policy = mesh.tune(args.session, {
        latencyMs: args.latencyMs, jitterMs: args.jitterMs, dropPct: args.dropPct, dupPct: args.dupPct, throttleKbps: args.throttleKbps,
      })
      return { session: args.session, policy }
    },
  })
}

function meshResetTool(mesh) {
  return defineTool({
    name: 'mesh_reset',
    description: 'Clear mesh state: pass a session id to dissolve that one session, or nothing to wipe ALL peers and ' +
      'sessions and the log. Devices re-join with /mesh/join afterwards (their callsigns stay pinned to serial), so a ' +
      'reset between test runs is cheap.',
    parameters: {
      session: { type: 'string', description: 'Dissolve only this session (default: full wipe).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { cleared: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `mesh cleared: ${value?.cleared ?? '?'}` }],
    },
    async execute(args) {
      if (typeof args.session === 'string' && args.session !== '') {
        mesh.unlink(args.session)
        return { cleared: `session ${args.session}` }
      }
      mesh.reset()
      return { cleared: 'everything (peers, sessions, log)' }
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
          presentationMeta: {
            type: 'object',
            additionalProperties: true,
            description: 'Projected into ToolResultNode.meta for the conversation stream card.',
          },
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
          return {
            serial: row.serial, avd, booted, alreadyRunning: true,
            presentationMeta: { kind: 'android-stream', device: { serial: row.serial, name: avd } },
          }
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
      return {
        serial, avd, booted: true, alreadyRunning: false,
        presentationMeta: { kind: 'android-stream', device: { serial, name: avd } },
      }
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
      await DeviceBuild.adbRun(serial, ['emu', 'kill'])
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
        const current = Number(await DeviceBuild.adbRun(serial, ['shell', 'settings', 'get', 'system', 'user_rotation']))
        const next = ((Number.isFinite(current) ? current : 0) + 1) % 4
        await DeviceBuild.adbRun(serial, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
        await DeviceBuild.adbRun(serial, ['shell', 'settings', 'put', 'system', 'user_rotation', String(next)])
        return { serial, action, rotation: next }
      }
      const shell = DEVICE_ACTIONS[action]
      if (!shell) throw new Error(`unknown action "${action}" — use ${[...Object.keys(DEVICE_ACTIONS), 'rotate'].join(', ')}.`)
      await DeviceBuild.adbRun(serial, ['shell', ...shell])
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
      const output = await DeviceBuild.adbRun(serial, ['shell', 'pm', 'list', 'packages', ...(args.include_system ? [] : ['-3'])])
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
      const listOut = await DeviceBuild.adbRun(serial, ['shell', 'pm', 'list', 'packages'])
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
      if (args.relaunch) await DeviceBuild.adbRun(serial, ['shell', 'am', 'force-stop', pkg])
      const launched = await DeviceBuild.adbRun(serial, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']).catch((error) => { throw new Error(`Could not launch ${pkg}: ${error instanceof Error ? error.message : error}`) })
      if (/no activities found|no events to send/i.test(launched)) throw new Error(`Could not launch ${pkg} (no launcher activity).`)
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
          presentationMeta: {
            type: 'object',
            additionalProperties: true,
            description: 'Projected into ToolResultNode.meta for the conversation stream card.',
          },
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
      return {
        action, running: true, serial: info.serial, width: info.width, height: info.height, streamUrl: `${API_BASE}/stream?token=${encodeURIComponent(signed.token)}`,
        presentationMeta: {
          kind: 'android-stream',
          device: { serial: info.serial },
          streamRouteId: `dsh-mobilecode/stream/${info.serial}`,
        },
      }
    },
  })
}

function deviceScreenTool(engine, vision) {
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
          image: Vision.IMAGE_REF_SCHEMA,
          presentationMeta: {
            type: 'object',
            additionalProperties: true,
            description: 'Projected into ToolResultNode.meta for the conversation screenshot card.',
          },
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
        const blocks = [{ type: 'text', text: lines.join('\n') }]
        // When the routed model accepts images, the screenshot rides along as a
        // real image block so the model SEES the screen (see lib/vision.js).
        return Vision.appendImageBlock(blocks, v)
      },
    },
    async execute(args, exec) {
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
      const image = await Vision.maybeAttachScreenshot(vision, png, exec)
      if (image !== undefined) out.image = image
      if (png) {
        out.presentationMeta = {
          kind: 'android-screenshot',
          device: { serial },
          path: png,
        }
      } else {
        out.presentationMeta = { kind: 'android-screenshot', device: { serial } }
      }
      return out
    },
  })
}

async function captureScreenSize(serial) {
  const output = await DeviceBuild.adbRun(serial, ['shell', 'wm', 'size'])
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
      await DeviceBuild.adbRun(serial, ['shell', 'input', 'tap', String(center.x), String(center.y)])
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
    '- device_scroll_to: scroll until an element (resource_id or text) comes into view, then report it — use before tapping',
    '  elements that are off-screen in long lists (Settings pages, app lists). Returns the found node + its center tap point.',
    '- device_connect / device_pair_qr: attach a Wi-Fi device. device_connect does `adb connect host:port` (pass pairing_code +',
    '  pairing_port for the first-time "Pair device" flow). device_pair_qr does the full journey: generates a WIFI:T:ADB QR',
    '  string (render it as a QR code and scan it with the phone: Settings → Connected devices → Pair by QR), waits for the',
    '  pairing service over mDNS, then auto-pairs and connects. Needs adb >= 31 for the QR flow.',
    '- device_perf: one-shot RAM / battery / CPU snapshot of an attached device (meminfo + dumpsys battery + cpuinfo).',
    '- device_app_info / device_install / device_uninstall: per-app detail (version, SDK, permissions, activities via dumpsys',
    '  package) / sideload a local APK onto a running device (`install -r -g`) / remove an app. Uninstall is destructive.',
    '- device_reboot: reboot the device (normal / recovery / bootloader). The device drops off then comes back; disruptive.',
    '- device_input: tap/swipe/type/press on the attached Android device at ABSOLUTE pixel coordinates (take the center of a',
    '  device_screen box: x=(x1+x2)/2, y=(y1+y2)/2). The control loop is device_ui_tree → device_tap_element, falling back to',
    '  device_screen → device_input when a surface exposes no accessibility tree. Typing is ASCII over plain adb; non-ASCII',
    '  (CJK, emoji) goes through the ADBKeyboard IME when installed, and is refused with the install hint otherwise.',
    '- device_action: notifications / quick_settings / collapse / lock / wake / assistant / rotate.',
    '- device_boot / device_shutdown: boot an AVD by name and wait for boot / shut an emulator down (refuses physical devices).',
    '- device_apps / device_launch_app: list installed packages (never guess a package name) / launch one by package or unique substring.',
    '- device_intent: open anything by Android intent (action, deep-link URI, or package/.Activity). Reaches screens no tap can address.',
    '  Every adb command runs through one classified boundary: a dropped Wi-Fi connection (ip:port serial) gets exactly one',
    '  `adb connect` attempt, read-only commands then replay automatically, and side-effectful ones refuse the replay —',
    '  a replayed tap could double-tap — and raise "reconnected — call again" instead.',
    '- device_stream: drive the live screen stream the Devices panel shows (status / start an online device / stop). Agents',
    '  that just need to see the screen should prefer device_screen or device_ui_tree.',
    '- device_log: read device logs (logcat main/crash/events, kernel dmesg). Call it when a run fails or an app misbehaves.',
    '- device_status: one normalized snapshot of attached devices, AVDs, running/parked projects, Metro and preview servers.',
    '- device_ui_rows: detect list/feed ROWS on the attached screen (Settings pages, feeds, inboxes) with per-row index, group,',
    '  frame, aggregated label and parsed counters (e.g. "3万 粉丝" → 粉丝=30000). Use it before tapping a row.',
    '- device_tap_row: tap inside a row by index at a row-relative position; optional expect_count {key, delta} verifies the',
    '  counter changed by exactly delta after the tap (refused when the key is not visible first).',
    '- device_meminfo: `dumpsys meminfo <pkg>` → TOTAL PSS/RSS/Swap-PSS + App Summary heap buckets + top categories. Use it to',
    '  check a running app\'s footprint.',
    '- device_backtrace: SIGQUIT an app process and read its newest /data/anr thread dump; falls back to the logcat crash buffer',
    '  when /data/anr is unreadable (engine field says which). Deterministic crash/ANR capture for debugging.',
    '- device_display: read or set a device\'s DPI (wm density) and pixel resolution (wm size) — action get/set/reset.',
    '  Use it to test layout scaling, or to make two devices share a viewport. Re-observe with device_screen after a change.',
    '- device_avd_create: create a second virtual device (clone_from copies an existing AVD\'s full hardware config so both',
    '  players behave identically). Boot it with device_boot; a running emulator holds 5554 so device #2 lands on 5556.',
    '- device_batch: fire 1..16 input actions concurrently across devices (each step carries its own serial) — the co-op',
    '  primitive for "both players press attack on the same frame". Per-step results; a failing step never blocks others.',
    '- device_pair_capture: capture BOTH devices\' screens in one call (parallel PNG + UI digests, both attached as real',
    '  image blocks) — the way to watch two players at the same instant. Add ocr:true only when UI trees are not enough.',
    '',
    'Co-op mesh (v0.8.0) — two emulators cannot multicast-discover each other through their isolated NATs, so the plugin',
    'hosts a LocalSend-style JSON pub/sub hub. Any app inside an emulator reaches it at http://10.0.2.2:<dsh-port>' +
    '/api/dsh-mobilecode/mesh/join — POST {serial?,name?} to join (the hub assigns a random callsign like "amber-fox",',
    'stable per serial, and a token), POST /mesh/link {with:[names]} to form a session, then POST /mesh/send and GET',
    '/mesh/poll?id&token&after&wait to exchange JSON. The hub is also your observation window and network simulator:',
    '- mesh_status: who has joined, which sessions exist, live per-session policy and undelivered mail.',
    '- mesh_send: inject a message as any peer (the other game receives it from /mesh/poll as if its partner sent it).',
    '- mesh_log: every join/link/send/drop/dup/tune event with timestamps, sizes and latency — the wire between players.',
    '- mesh_tune: set a session\'s latencyMs / jitterMs / dropPct / dupPct / throttleKbps to desync-test the pair',
    '  (e.g. latency 400 + jitter 100 on player B) without touching app code.',
    '- mesh_reset: dissolve one session or wipe everything between test runs.',
    'Typical co-op loop: device_avd_create + device_boot a clone → both apps join → mesh_link → device_batch inputs at',
    'both, device_pair_capture to watch, mesh_log to see the traffic, mesh_tune to inject real-world network pain.',
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
  const mesh = new MeshHub()
  const vision = Vision.resolveVisionServices(ctx)
  const handle = {
    engine,
    stream: streamHost,
    mesh,
    status: () => ({
      directories: [...new Set([...engine.builds.keys()].map((key) => key.split('\0')[0]))],
      servers: [...engine.servers.keys()],
      bundlers: [...engine.bundlers.keys()],
      builds: [...engine.builds.keys()],
    }),
  }
  if (typeof ctx.provide === 'function') ctx.provide('mobilecode', handle)
  else ctx.mobilecode = handle

  const routes = makeRoutes(engine, config, { host: streamHost, access: streamAccess, mesh })
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
        deviceScreenTool(engine, vision),
        deviceUiTreeTool(),
        deviceTapElementTool(),
        deviceWaitForTool(),
        deviceBootTool(),
        deviceShutdownTool(),
        deviceActionTool(),
        deviceAppsTool(),
        deviceLaunchAppTool(),
        deviceIntentTool(),
        deviceScrollToTool(),
        deviceConnectTool(),
        devicePairQrTool(),
        devicePerfTool(),
        deviceAppInfoTool(),
        deviceInstallTool(),
        deviceUninstallTool(),
        deviceRebootTool(),
        deviceStreamTool(streamHost, streamAccess),
        deviceLogTool(engine),
        deviceStatusTool(engine),
        deviceInputTool(),
        deviceUiRowsTool(),
        deviceTapRowTool(),
        deviceBacktraceTool(),
        deviceMeminfoTool(),
        deviceDisplayTool(),
        deviceAvdCreateTool(),
        deviceBatchTool(),
        devicePairCaptureTool(vision),
        meshStatusTool(mesh),
        meshSendTool(mesh),
        meshLogTool(mesh),
        meshTuneTool(mesh),
        meshResetTool(mesh),
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
