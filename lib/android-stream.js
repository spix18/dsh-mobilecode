/**
 * dsh-mobilecode — host-side lifecycle manager for the one live Android stream.
 *
 * Ported (lean) from ZSeven-W/dsh-android (android-host.ts, MIT). The stream is
 * in-process: one AdbFrameLoop per streamed serial, a consumer refcount with an
 * idle timeout, and a keep-alive that restarts a crashed loop. Emulators and
 * physical devices share this path — the serial is the only identity.
 *
 * The control surface takes NORMALIZED 0..1 coordinates of the streamed frame
 * (the panel's <img> is scaled, so the browser knows fractions, not pixels) and
 * maps them onto `adb shell input` pixels using the latest frame's own size.
 */

import * as DeviceBuild from './device-build.js'
import { AdbFrameLoop } from './frame-source.js'

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_RESTART_DELAY_MS = 5000
const KEEP_ALIVE_TICK_MS = 1000
const FIRST_FRAME_TIMEOUT_MS = 15000
const CONTROL_TIMEOUT_MS = 30000
const MAX_SWIPE_MS = 5000

/** Navigation/hardware buttons the panel may press. */
export const ANDROID_BUTTONS = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  menu: 'KEYCODE_MENU',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
}

/** Clockwise user_rotation cycle (Surface.ROTATION_0..270). */
export const ROTATION_CYCLE = [0, 1, 2, 3]

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function requireNormalized(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new RangeError('dsh-mobilecode: tap/drag coordinates must be normalized 0..1 of the streamed frame')
  }
}

/** Lifecycle manager for the (single) in-process Android device stream. */
export class AndroidStreamHost {
  #options
  #loop
  #starting
  #launchQueue = Promise.resolve()
  #consumers = 0
  #keepAliveTimer
  #idleTimer
  #restarts = 0
  #startedAt
  #exitAt
  #lastError
  #lastSerial
  #intentionalStop = false
  #disposed = false
  #frameSubscribers = new Set()

  constructor(options = {}) {
    this.#options = {
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      firstFrameTimeoutMs: options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS,
    }
  }

  get running() {
    return this.#loop?.running === true
  }

  get streamedSerial() {
    return this.running ? this.#loop?.serial : undefined
  }

  get latestFrame() {
    return this.#loop?.latestFrame
  }

  /** Observe every decoded frame; the returned function unsubscribes. */
  subscribeFrames(subscriber) {
    this.#frameSubscribers.add(subscriber)
    return () => {
      this.#frameSubscribers.delete(subscriber)
    }
  }

  /**
   * Make sure the frame loop is live for `serial`. Concurrent callers share one
   * launch; a call for a different serial retires the current loop first (one
   * streamed device at a time).
   */
  async ensureStreaming({ serial }) {
    if (this.#disposed) throw new Error('dsh-mobilecode: the stream host is disposed')
    if (typeof serial !== 'string' || serial === '') throw new TypeError('dsh-mobilecode: ensureStreaming requires a non-empty serial')
    const startFor = async () => {
      const current = this.#loop
      if (current !== undefined && current.running && current.serial === serial) return this.#infoOf(current)
      if (current !== undefined && current.serial !== serial) {
        current.stop()
        this.#loop = undefined
      }
      return this.#startFor(serial)
    }
    let starting = this.#starting
    if (starting !== undefined) {
      try {
        await starting
      } catch {
        // A failed shared launch is settled; retry below.
      }
      if (this.running && this.#loop?.serial === serial) {
        this.#armIdle()
        return this.#infoOf(this.#loop)
      }
      starting = undefined
    }
    starting = this.#serializeLaunch(startFor)
    this.#starting = starting
    try {
      const info = await starting
      this.#lastError = undefined
      this.#armIdle()
      return info
    } catch (error) {
      this.#lastError = errorMessage(error)
      throw error
    } finally {
      if (this.#starting === starting) this.#starting = undefined
    }
  }

  /** Start the crash keep-alive loop (restarts an unintentionally dead loop). */
  startKeepAlive() {
    if (this.#keepAliveTimer !== undefined || this.#disposed) return
    this.#keepAliveTimer = setInterval(() => {
      void this.#keepAliveTick().catch(() => {})
    }, KEEP_ALIVE_TICK_MS)
    this.#keepAliveTimer.unref?.()
  }

  stopKeepAlive() {
    if (this.#keepAliveTimer !== undefined) clearInterval(this.#keepAliveTimer)
    this.#keepAliveTimer = undefined
  }

  /** Stop the stream intentionally (keep-alive will not fight it). */
  async stop() {
    this.#clearIdle()
    this.#intentionalStop = true
    this.#exitAt = undefined
    const loop = this.#loop
    this.#loop = undefined
    this.#startedAt = undefined
    loop?.stop()
    await this.#starting?.catch(() => {})
    const landed = this.#loop
    if (landed !== undefined) {
      this.#loop = undefined
      landed.stop()
    }
  }

  /** Hold the stream alive for one consumer; release exactly once. */
  acquire() {
    this.#consumers += 1
    this.#armIdle()
    let released = false
    return () => {
      if (released) return
      released = true
      this.#consumers = Math.max(0, this.#consumers - 1)
      this.#armIdle()
    }
  }

  status() {
    const loop = this.#loop
    const frame = loop?.latestFrame
    return {
      running: this.running,
      ...(loop === undefined ? {} : { serial: loop.serial }),
      restarts: this.#restarts,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      consumers: this.#consumers,
      ...(frame === undefined ? {} : { frameSequence: frame.sequence, lastFrameAt: frame.at, width: frame.width, height: frame.height }),
      stderr: loop?.stderrLines ?? [],
    }
  }

  dispose() {
    this.#disposed = true
    this.stopKeepAlive()
    this.#frameSubscribers.clear()
    return this.stop()
  }

  // ── control surface (normalized 0..1 of the streamed frame) ────────────────

  async tap(serial, x, y) {
    requireNormalized(x, y)
    const point = await this.#pixels(serial, x, y)
    await this.#shell(serial, ['input', 'tap', String(point.x), String(point.y)])
  }

  async drag(serial, drag) {
    requireNormalized(drag.fromX, drag.fromY)
    requireNormalized(drag.toX, drag.toY)
    const from = await this.#pixels(serial, drag.fromX, drag.fromY)
    const to = await this.#pixels(serial, drag.toX, drag.toY)
    const durationMs = Math.min(MAX_SWIPE_MS, Math.max(20, Math.round((drag.duration ?? 0.3) * 1000)))
    await this.#shell(serial, ['input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), String(durationMs)])
  }

  async button(serial, name = 'home') {
    const keycode = ANDROID_BUTTONS[name] ?? (/^KEYCODE_[A-Z0-9_]+$/.test(name) ? name : undefined)
    if (keycode === undefined) throw new Error(`unknown button "${name}"; expected one of ${Object.keys(ANDROID_BUTTONS).join(', ')} or a KEYCODE_* name`)
    await this.#shell(serial, ['input', 'keyevent', keycode])
  }

  /** ASCII via `input text`; non-ASCII via the ADBKeyboard IME, else refused. */
  async type(serial, text) {
    if (typeof text !== 'string' || text === '') throw new TypeError('dsh-mobilecode: type requires a non-empty text')
    if (DeviceBuild.isAsciiInput(text)) {
      await this.#shell(serial, ['input', 'text', DeviceBuild.escapeInputText(text)])
      return
    }
    if (!(await DeviceBuild.adbKeyboardReady(serial))) {
      throw new Error('the text contains non-ASCII characters that `input text` cannot deliver; install the ADBKeyboard IME (github.com/senzhk/ADBKeyBoard) and select it')
    }
    await DeviceBuild.typeViaAdbKeyboard(serial, text)
  }

  async rotate(serial, rotation) {
    if (!ROTATION_CYCLE.includes(rotation)) throw new RangeError('dsh-mobilecode: rotation must be 0, 1, 2 or 3')
    await this.#shell(serial, ['settings', 'put', 'system', 'accelerometer_rotation', '0'])
    await this.#shell(serial, ['settings', 'put', 'system', 'user_rotation', String(rotation)])
  }

  async getRotation(serial) {
    try {
      const value = Number((await DeviceBuild.adbRun(serial, ['shell', 'settings', 'get', 'system', 'user_rotation'])).trim())
      return ROTATION_CYCLE.includes(value) ? value : 0
    } catch {
      return 0
    }
  }

  /** The online device list for the panel picker (serial + kind). */
  async listDevices() {
    const rows = await DeviceBuild.devices()
    return rows
      .filter((row) => row.state === 'device')
      .map((row) => ({ serial: row.serial, kind: row.serial.startsWith('emulator-') ? 'emulator' : 'physical' }))
  }

  async #shell(serial, shell) {
    await DeviceBuild.adbRun(serial, ['shell', ...shell], { timeoutMs: CONTROL_TIMEOUT_MS })
  }

  async #keepAliveTick() {
    if (this.#disposed || this.#intentionalStop) return
    const exitAt = this.#exitAt
    const serial = this.#lastSerial
    if (exitAt === undefined || serial === undefined) return
    if (Date.now() - exitAt < this.#options.restartDelayMs) return
    this.#exitAt = undefined
    this.#restarts += 1
    try {
      await this.ensureStreaming({ serial })
    } catch (error) {
      this.#lastError = errorMessage(error)
      if (this.#exitAt === undefined) this.#exitAt = Date.now()
    }
  }

  async #startFor(serial) {
    if (this.#disposed) throw new Error('dsh-mobilecode: the stream host is disposed')
    const online = await DeviceBuild.devices()
    if (!online.some((row) => row.serial === serial && row.state === 'device')) {
      const known = online.find((row) => row.serial === serial)
      throw new Error(
        known === undefined
          ? `no connected device has the serial ${serial}`
          : `device ${serial} is ${known.state}, not ready to stream`,
      )
    }
    const loop = new AdbFrameLoop(serial, {
      onFrame: (frame) => {
        for (const subscriber of this.#frameSubscribers) {
          try {
            subscriber(frame)
          } catch {
            // One broken consumer must not stall the fan-out.
          }
        }
      },
      onExit: (detail) => {
        if (this.#loop !== loop) return
        this.#loop = undefined
        this.#startedAt = undefined
        this.#lastError = `the screencap loop for ${serial} died (${detail})`
        this.#exitAt = Date.now()
      },
    })
    this.#loop = loop
    this.#lastSerial = serial
    this.#intentionalStop = false
    loop.reset()
    loop.start()
    const frame = await loop.waitForFrame(this.#options.firstFrameTimeoutMs)
    if (frame === undefined) {
      const stderr = loop.stderrLines.join('\n')
      loop.stop()
      if (this.#loop === loop) this.#loop = undefined
      throw new Error(`no frame arrived from ${serial} within ${this.#options.firstFrameTimeoutMs} ms${stderr === '' ? '' : `: ${stderr}`}`)
    }
    this.#startedAt = Date.now()
    this.#exitAt = undefined
    return this.#infoOf(loop)
  }

  #infoOf(loop) {
    const frame = loop.latestFrame
    return { serial: loop.serial, ...(frame === undefined ? {} : { width: frame.width, height: frame.height }) }
  }

  /** Normalized frame coordinates → `input` pixels via the live frame size. */
  async #pixels(serial, x, y) {
    const frame = this.streamedSerial === serial ? this.latestFrame : undefined
    if (frame !== undefined) return { x: Math.round(x * frame.width), y: Math.round(y * frame.height) }
    const size = await screenSize(serial)
    return { x: Math.round(x * size.width), y: Math.round(y * size.height) }
  }

  #armIdle() {
    this.#clearIdle()
    const idleMs = this.#options.idleTimeoutMs
    if (idleMs <= 0) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.#consumers > 0) {
        this.#armIdle()
        return
      }
      void this.stop()
    }, idleMs)
    this.#idleTimer.unref?.()
  }

  #clearIdle() {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
  }

  #serializeLaunch(task) {
    const run = this.#launchQueue.then(task, task)
    this.#launchQueue = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Override-aware physical screen size for the non-streaming control fallback. */
async function screenSize(serial) {
  const output = await DeviceBuild.adbRun(serial, ['shell', 'wm', 'size'])
  const match = /Override size:\s*(\d+)x(\d+)/.exec(output) ?? /Physical size:\s*(\d+)x(\d+)/.exec(output)
  if (!match) throw new Error(`cannot read the screen size of ${serial}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}
