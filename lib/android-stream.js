/**
 * dsh-mobilecode — host-side lifecycle manager for live Android streams.
 *
 * Ported (lean) from ZSeven-W/dsh-android (android-host.ts, MIT), widened in
 * 0.9.0 for co-op testing: the host keeps one INDEPENDENT frame loop per
 * serial (Map<serial, state>) instead of a single global loop, so two devices
 * stream at once and the panel can show them side by side. Each stream owns
 * its consumer refcount, idle timer, crash bookkeeping and frame subscribers;
 * the "primary" stream (most recently ensured; the first live one as a
 * fallback) preserves every single-stream default the agent tools and the
 * control surface already rely on.
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

/** Lifecycle manager for live Android device streams (one loop per serial). */
export class AndroidStreamHost {
  #options
  /** @type {Map<string, object>} serial → per-stream state. */
  #streams = new Map()
  /** Most recently ensured serial; the anchor for single-stream defaults. */
  #primary = undefined
  #keepAliveTimer
  #disposed = false

  constructor(options = {}) {
    this.#options = {
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      firstFrameTimeoutMs: options.firstFrameTimeoutMs ?? FIRST_FRAME_TIMEOUT_MS,
      // Test seam: the offline suite injects a fake loop factory + device list.
      loopFactory: options.loopFactory ?? ((serial, handlers) => new AdbFrameLoop(serial, handlers)),
      devicesFn: options.devicesFn ?? (() => DeviceBuild.devices()),
    }
  }

  // ── registry ───────────────────────────────────────────────────────────────

  #state(serial) {
    if (typeof serial !== 'string' || serial === '') {
      throw new TypeError('dsh-mobilecode: stream operations require a non-empty serial')
    }
    let state = this.#streams.get(serial)
    if (state === undefined) {
      state = {
        serial,
        loop: undefined,
        starting: undefined,
        queue: Promise.resolve(),
        consumers: 0,
        restarts: 0,
        startedAt: undefined,
        exitAt: undefined,
        lastError: undefined,
        intentionalStop: false,
        idleTimer: undefined,
        subscribers: new Set(),
      }
      this.#streams.set(serial, state)
    }
    return state
  }

  /** Serials with a live loop, in start order. */
  runningSerials() {
    return [...this.#streams.values()].filter((s) => s.loop?.running === true).map((s) => s.serial)
  }

  isStreaming(serial) {
    if (typeof serial !== 'string' || serial === '') return false
    return this.#streams.get(serial)?.loop?.running === true
  }

  /** The primary serial: a live stream if any (first started), else the last ensured. */
  get streamedSerial() {
    const running = this.runningSerials()
    if (running.length > 0) return running[0]
    return this.#primary !== undefined && this.#streams.has(this.#primary) ? this.#primary : undefined
  }

  get running() {
    return this.runningSerials().length > 0
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Make sure a frame loop is live for `serial`. Concurrent callers of the same
   * serial share one launch; every serial gets its OWN loop — starting a second
   * device never retires the first (co-op streams are independent).
   */
  async ensureStreaming({ serial }) {
    const state = this.#state(serial)
    this.#primary = serial
    return this.#ensureStream(state)
  }

  async #ensureStream(state) {
    if (this.#disposed) throw new Error('dsh-mobilecode: the stream host is disposed')
    if (state.loop !== undefined && state.loop.running) {
      this.#armIdle(state)
      return this.#infoOf(state.loop)
    }
    if (state.starting !== undefined) {
      try {
        await state.starting
      } catch {
        // A failed shared launch is settled; retry below.
      }
      if (state.loop !== undefined && state.loop.running) {
        this.#armIdle(state)
        return this.#infoOf(state.loop)
      }
    }
    const launch = async () => {
      if (state.loop !== undefined && state.loop.running) return this.#infoOf(state.loop)
      return this.#startFor(state)
    }
    const launching = state.queue.then(launch, launch)
    state.queue = launching.then(() => undefined, () => undefined)
    state.starting = launching
    try {
      const info = await launching
      state.lastError = undefined
      this.#armIdle(state)
      return info
    } catch (error) {
      state.lastError = errorMessage(error)
      throw error
    } finally {
      if (state.starting === launching) state.starting = undefined
    }
  }

  /** Start the crash keep-alive loop (restarts any unintentionally dead loop). */
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

  /** Stop one stream intentionally (defaults to the primary). */
  async stop(serial = this.streamedSerial) {
    if (serial === undefined) return
    const state = this.#streams.get(serial)
    if (state !== undefined) await this.#stopStream(state)
  }

  /** Stop every stream (panel teardown, device_stream stop without a serial). */
  async stopAll() {
    for (const state of [...this.#streams.values()]) await this.#stopStream(state)
    this.#primary = undefined
  }

  async #stopStream(state) {
    this.#streams.delete(state.serial)
    if (this.#primary === state.serial) this.#primary = undefined
    state.intentionalStop = true
    this.#clearIdle(state)
    state.exitAt = undefined
    const loop = state.loop
    state.loop = undefined
    state.startedAt = undefined
    loop?.stop()
    await state.starting?.catch(() => {})
    const landed = state.loop
    if (landed !== undefined) {
      state.loop = undefined
      landed.stop()
    }
  }

  dispose() {
    this.#disposed = true
    this.stopKeepAlive()
    for (const state of this.#streams.values()) {
      state.subscribers.clear()
      void this.#stopStream(state)
    }
    this.#streams.clear()
    this.#primary = undefined
  }

  // ── accessors (primary unless a serial is given) ───────────────────────────

  /** Hold a stream alive for one consumer; release exactly once. */
  acquire(serial = this.streamedSerial) {
    const state = this.#state(serial)
    state.consumers += 1
    this.#armIdle(state)
    let released = false
    return () => {
      if (released) return
      released = true
      state.consumers = Math.max(0, state.consumers - 1)
      this.#armIdle(state)
    }
  }

  /**
   * Observe every decoded frame of ONE serial; the returned function
   * unsubscribes. Serial-scoped so two panels never cross frames.
   */
  subscribeFrames(serial, subscriber) {
    const state = this.#state(serial)
    state.subscribers.add(subscriber)
    return () => {
      state.subscribers.delete(subscriber)
    }
  }

  status(serial = this.streamedSerial) {
    const state = serial === undefined ? undefined : this.#streams.get(serial)
    if (state === undefined) {
      return { running: false, restarts: 0, consumers: 0, stderr: [] }
    }
    const frame = state.loop?.latestFrame
    return {
      running: state.loop?.running === true,
      serial: state.serial,
      restarts: state.restarts,
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      consumers: state.consumers,
      ...(frame === undefined ? {} : { frameSequence: frame.sequence, lastFrameAt: frame.at, width: frame.width, height: frame.height }),
      stderr: state.loop?.stderrLines ?? [],
    }
  }

  /** Latest frame of one stream (primary by default). */
  latestFrame(serial = this.streamedSerial) {
    if (serial === undefined) return undefined
    return this.#streams.get(serial)?.loop?.latestFrame
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

  // ── internals ──────────────────────────────────────────────────────────────

  async #shell(serial, shell) {
    await DeviceBuild.adbRun(serial, ['shell', ...shell], { timeoutMs: CONTROL_TIMEOUT_MS })
  }

  async #keepAliveTick() {
    if (this.#disposed) return
    const now = Date.now()
    for (const state of [...this.#streams.values()]) {
      if (state.intentionalStop || state.exitAt === undefined) continue
      if (now - state.exitAt < this.#options.restartDelayMs) continue
      state.exitAt = undefined
      state.restarts += 1
      try {
        await this.#ensureStream(state)
      } catch (error) {
        state.lastError = errorMessage(error)
        if (state.exitAt === undefined) state.exitAt = Date.now()
      }
    }
  }

  async #startFor(state) {
    if (this.#disposed) throw new Error('dsh-mobilecode: the stream host is disposed')
    const { serial } = state
    const online = await this.#options.devicesFn()
    if (!online.some((row) => row.serial === serial && row.state === 'device')) {
      const known = online.find((row) => row.serial === serial)
      throw new Error(
        known === undefined
          ? `no connected device has the serial ${serial}`
          : `device ${serial} is ${known.state}, not ready to stream`,
      )
    }
    const loop = this.#options.loopFactory(serial, {
      onFrame: (frame) => {
        for (const subscriber of state.subscribers) {
          try {
            subscriber(frame)
          } catch {
            // One broken consumer must not stall the fan-out.
          }
        }
      },
      onExit: (detail) => {
        if (state.loop !== loop) return
        state.loop = undefined
        state.startedAt = undefined
        state.lastError = `the screencap loop for ${serial} died (${detail})`
        state.exitAt = Date.now()
      },
    })
    state.loop = loop
    state.intentionalStop = false
    loop.reset()
    loop.start()
    const frame = await loop.waitForFrame(this.#options.firstFrameTimeoutMs)
    if (frame === undefined) {
      const stderr = loop.stderrLines.join('\n')
      loop.stop()
      if (state.loop === loop) state.loop = undefined
      throw new Error(`no frame arrived from ${serial} within ${this.#options.firstFrameTimeoutMs} ms${stderr === '' ? '' : `: ${stderr}`}`)
    }
    state.startedAt = Date.now()
    state.exitAt = undefined
    return this.#infoOf(loop)
  }

  #infoOf(loop) {
    const frame = loop.latestFrame
    return { serial: loop.serial, ...(frame === undefined ? {} : { width: frame.width, height: frame.height }) }
  }

  /** Normalized frame coordinates → `input` pixels via the live frame size. */
  async #pixels(serial, x, y) {
    const frame = this.#streams.get(serial)?.loop?.latestFrame
    if (frame !== undefined) return { x: Math.round(x * frame.width), y: Math.round(y * frame.height) }
    const size = await screenSize(serial)
    return { x: Math.round(x * size.width), y: Math.round(y * size.height) }
  }

  #armIdle(state) {
    this.#clearIdle(state)
    const idleMs = this.#options.idleTimeoutMs
    if (idleMs <= 0) return
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined
      if (state.consumers > 0) {
        this.#armIdle(state)
        return
      }
      void this.#stopStream(state)
    }, idleMs)
    state.idleTimer.unref?.()
  }

  #clearIdle(state) {
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer)
    state.idleTimer = undefined
  }
}

/** Override-aware physical screen size for the non-streaming control fallback. */
async function screenSize(serial) {
  const output = await DeviceBuild.adbRun(serial, ['shell', 'wm', 'size'])
  const match = /Override size:\s*(\d+)x(\d+)/.exec(output) ?? /Physical size:\s*(\d+)x(\d+)/.exec(output)
  if (!match) throw new Error(`cannot read the screen size of ${serial}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}
