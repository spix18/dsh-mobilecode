/**
 * dsh-mobilecode — capability tokens and the transport fence for the live
 * stream routes.
 *
 * Ported from ZSeven-W/dsh-android (stream-access.ts, MIT), same security
 * posture:
 * - HMAC-SHA256 capabilities `base64url(payload).base64url(mac)`, signed with a
 *   32-byte per-install key (`~/.dsh/mobilecode/stream-access.key`, created
 *   atomically); tokens expire within 10 minutes.
 * - Every route applies the loopback / trusted-browser transport fence (peer
 *   address, loopback Host, Sec-Fetch-Site / Origin) BEFORE any capability is
 *   consulted — Host/Origin are caller-controlled, so a LAN client cannot spoof
 *   localhost and a DNS-rebinding Host is rejected.
 *
 * The screenshot-cache containment walk of the reference is not ported: this
 * plugin serves only the live stream over its routes (device_screen writes PNGs
 * to disk directly), so there is no arbitrary-path-serving surface to fence.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HOME } from './setup.js'

/** Hard capability lifetime (tokens expire within 10 minutes). */
export const TOKEN_TTL_MS = 10 * 60 * 1000

const KEY_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const MAX_TOKEN_LENGTH = 16 * 1024
/** Signing may run ahead of verification by this much before the TTL cap trips. */
const CLOCK_SKEW_MS = 60 * 1000

/** adb device serials: `emulator-5554`, `RFCX123ABC`, or `host:port` for network adb. */
export const SERIAL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function keyPath() {
  return path.join(HOME, 'stream-access.key')
}

function mac(key, payload) {
  return createHmac('sha256', key).update(payload).digest()
}

function safeEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Load or atomically create the per-install 32-byte signing key. */
export async function prepareStreamAccessKey() {
  await mkdir(HOME, { recursive: true })
  const file = keyPath()
  if (existsSync(file)) {
    const key = await readFile(file)
    if (key.length === KEY_BYTES) return key
    throw new Error('dsh-mobilecode: stream access key has an invalid length')
  }
  const candidate = randomBytes(KEY_BYTES)
  try {
    await writeFile(file, candidate, { flag: 'wx', mode: 0o600 })
    return candidate
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const key = await readFile(file)
    if (key.length !== KEY_BYTES) throw new Error('dsh-mobilecode: stream access key has an invalid length')
    return key
  }
}

function parseStreamPayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (
    value.v !== 1
    || value.kind !== 'mobilecode-stream'
    || typeof value.serial !== 'string'
    || !SERIAL_PATTERN.test(value.serial)
    || typeof value.exp !== 'number'
    || !Number.isSafeInteger(value.exp)
  ) return undefined
  return { v: 1, kind: 'mobilecode-stream', serial: value.serial, exp: value.exp }
}

/** HMAC capability encoder/verifier for the live stream URL. */
export class StreamAccessController {
  #routeCount = 0
  #keyPromise

  constructor(resolveKey = prepareStreamAccessKey) {
    this.resolveKey = resolveKey
  }

  /** Whether at least one HTTP carrier currently owns the routes. */
  get routeAvailable() {
    return this.#routeCount > 0
  }

  /** Mark one route attachment; the returned disposer removes it. */
  attachRoute() {
    this.#routeCount += 1
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#routeCount -= 1
    }
  }

  /** Mint a stream capability for one device serial. */
  async signStreamToken(serial, options = {}) {
    if (!SERIAL_PATTERN.test(serial)) throw new TypeError('dsh-mobilecode: signStreamToken requires a device serial')
    const key = await this.#key()
    const payload = { v: 1, kind: 'mobilecode-stream', serial, exp: Date.now() + this.#ttl(options.ttlMs) }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { token: `${encoded}.${mac(key, encoded).toString('base64url')}`, expiresAt: payload.exp }
  }

  async verifyStreamToken(token) {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return undefined
    const [encoded, signature] = token.split('.')
    if (encoded === undefined || signature === undefined) return undefined
    const key = await this.#key().catch(() => undefined)
    if (key === undefined) return undefined
    let supplied
    try {
      supplied = Buffer.from(signature, 'base64url')
    } catch {
      return undefined
    }
    if (!safeEqual(mac(key, encoded), supplied)) return undefined
    try {
      const payload = parseStreamPayload(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
      if (payload === undefined) return undefined
      const now = Date.now()
      if (payload.exp <= now) return undefined
      if (payload.exp - now > TOKEN_TTL_MS + CLOCK_SKEW_MS) return undefined
      return payload
    } catch {
      return undefined
    }
  }

  #ttl(ttlMs) {
    if (ttlMs === undefined || !Number.isFinite(ttlMs)) return TOKEN_TTL_MS
    return Math.min(TOKEN_TTL_MS, Math.max(1, Math.floor(ttlMs)))
  }

  #key() {
    this.#keyPromise ??= this.resolveKey()
    return this.#keyPromise
  }
}

// ── loopback / trusted-browser transport fence ───────────────────────────────

function isIpv4LoopbackAddress(address) {
  const parts = address.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Trust the transport peer, never forwarded or caller-controlled host data.
 * Node may expose an IPv4 peer directly or as an IPv4-mapped IPv6 address,
 * including the compact hexadecimal form used by some platforms.
 */
export function isLoopbackRemoteAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0]
  if (normalized === '::1' || isIpv4LoopbackAddress(normalized)) return true
  if (!normalized.startsWith('::ffff:')) return false
  const mapped = normalized.slice('::ffff:'.length)
  if (isIpv4LoopbackAddress(mapped)) return true
  const hexadecimal = /^([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(mapped)
  return hexadecimal !== null && (Number.parseInt(hexadecimal[1], 16) >>> 8) === 127
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isIpv4LoopbackAddress(hostname)
}

function requestAuthority(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return undefined
  try {
    const parsed = new URL(`http://${host}`)
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function isLoopbackRequest(req) {
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false
  const authority = requestAuthority(req)
  return authority !== undefined && isLoopbackHostname(authority.hostname)
}

function isTrustedBrowserRequest(req, requireOrigin) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  if (typeof origin !== 'string') return false
  const authority = requestAuthority(req)
  if (authority === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === authority.host
  } catch {
    return false
  }
}

/** The transport fence applied to every stream route. */
export function isTrustedRequest(req, requireOrigin = false) {
  return isLoopbackRequest(req) && isTrustedBrowserRequest(req, requireOrigin)
}
