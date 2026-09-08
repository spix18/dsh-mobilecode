// mesh-hub.js — host-mediated LocalSend-style mesh for co-op device testing.
//
// Two Android emulators cannot multicast-discover each other (each sits behind
// its own slirp NAT), but both can reach the host at 10.0.2.2. So the hub runs
// on the host: peers join with a persistent random callsign, link into a
// session, and exchange JSON messages through it. Every message is logged
// (with drop/dup marks) and every delivery is governed by a per-session policy
// (latency, jitter, drop, duplicate, bandwidth throttle) — the same hub is
// the game's network backbone AND the agent's observation window.
//
// Pure module: clock and RNG are injectable so the whole queue/policy engine
// is unit-testable offline (test/mesh-hub.mjs).

import { createHmac, randomBytes } from 'node:crypto'

const ADJECTIVES = [
  'amber', 'brisk', 'cobalt', 'dusky', 'eager', 'fable', 'gentle', 'hollow',
  'ivory', 'jolly', 'keen', 'lunar', 'mellow', 'noble', 'onyx', 'prism',
  'quiet', 'rapid', 'solar', 'tidal', 'umber', 'vivid', 'warm', 'zesty',
  'bold', 'crisp', 'dandy', 'eery', 'fuzzy', 'gilded', 'happy', 'mystic',
]
const ANIMALS = [
  'fox', 'owl', 'hare', 'bear', 'lynx', 'wren', 'moth', 'toad',
  'crow', 'deer', 'goat', 'kiwi', 'newt', 'puma', 'quail', 'seal',
  'tern', 'vole', 'wasp', 'yak', 'zebu', 'crane', 'finch', 'gecko',
  'heron', 'ibis', 'jackal', 'koala', 'lemur', 'narwhal', 'otter', 'panda',
]

function fnv1a(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function hex16(text) {
  return fnv1a(text).toString(16).padStart(8, '0') + fnv1a(text + '#2').toString(16).padStart(8, '0')
}

/** Deterministic LocalSend-style callsign for a stable seed (e.g. a serial). */
export function callsign(seed) {
  const h = fnv1a('mesh-name:' + seed)
  return ADJECTIVES[h % ADJECTIVES.length] + '-' + ANIMALS[(h >>> 5) % ANIMALS.length]
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** Per-session network-condition policy. All knobs default to OFF. */
function makePolicy(input) {
  return {
    latencyMs: clamp(Math.round(num(input?.latencyMs, 0)), 0, 5000),
    jitterMs: clamp(Math.round(num(input?.jitterMs, 0)), 0, 5000),
    dropPct: clamp(num(input?.dropPct, 0), 0, 100),
    dupPct: clamp(num(input?.dupPct, 0), 0, 100),
    throttleKbps: clamp(Math.round(num(input?.throttleKbps, 0)), 0, 1_000_000),
  }
}

export class MeshHub {
  /**
   * @param {object} opts
   * @param {Buffer|string} [opts.secret] token signing key (per-process by default)
   * @param {() => number} [opts.now] injectable clock (ms)
   * @param {() => number} [opts.random] injectable RNG 0..1
   * @param {number} [opts.maxLog] log ring size
   */
  constructor(opts = {}) {
    this.secret = opts.secret ?? randomBytes(32)
    this.now = opts.now ?? (() => Date.now())
    this.random = opts.random ?? Math.random
    this.maxLog = opts.maxLog ?? 500
    this.peers = new Map() // id -> {id,name,serial,role,joinedAt,lastSeen}
    this.sessions = new Map() // id -> {id,members:[peerId],policy,createdAt}
    this.inboxes = new Map() // peerId -> envelope[] (kept seq-sorted by push order)
    this.entries = [] // log ring
    this.seq = 0
    this.messageSeq = 0
    this.waiters = [] // long-poll resolvers
  }

  // ---- auth ---------------------------------------------------------------
  // Tokens are HMAC(process-secret, peerId): stable while the host lives,
  // invalid after a restart — join() is idempotent per serial, so a client
  // that kept an old token simply re-joins and gets a fresh one.
  tokenFor(id) {
    return createHmac('sha256', this.secret).update('mesh:' + id).digest('base64url').slice(0, 32)
  }

  verify(id, token) {
    if (typeof id !== 'string' || typeof token !== 'string') return false
    const expected = this.tokenFor(id)
    if (token.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i)
    return diff === 0
  }

  // ---- identity -----------------------------------------------------------
  /**
   * Join (or re-join) the mesh. A serial pins a stable identity: same device,
   * same peer id and same callsign forever. Returns {peer, token}.
   */
  join({ serial, name, role } = {}) {
    const cleanSerial = typeof serial === 'string' && serial.trim() !== '' ? serial.trim() : undefined
    if (cleanSerial) {
      const existing = [...this.peers.values()].find((peer) => peer.serial === cleanSerial)
      if (existing) {
        existing.lastSeen = this.now()
        return { peer: existing, token: this.tokenFor(existing.id) }
      }
    }
    const id = cleanSerial ? 'p-' + hex16('serial:' + cleanSerial) : 'p-' + randomBytes(6).toString('hex')
    const wanted = typeof name === 'string' && /^[A-Za-z0-9 _-]{1,32}$/.test(name.trim())
      ? name.trim().replace(/\s+/g, '-')
      : callsign(cleanSerial ?? id)
    const taken = new Set([...this.peers.values()].map((peer) => peer.name))
    let unique = wanted
    for (let n = 2; taken.has(unique); n++) unique = wanted + '-' + n
    const peer = {
      id,
      name: unique,
      serial: cleanSerial,
      role: typeof role === 'string' && role ? role : 'player',
      joinedAt: this.now(),
      lastSeen: this.now(),
    }
    this.peers.set(id, peer)
    this.inboxes.set(id, [])
    this.#log('join', { peer: peer.name, id, serial: cleanSerial })
    return { peer, token: this.tokenFor(id) }
  }

  leave(id) {
    const peer = this.peers.get(id)
    if (!peer) return false
    for (const session of this.sessions.values()) {
      session.members = session.members.filter((member) => member !== id)
      if (session.members.length < 2) this.sessions.delete(session.id)
    }
    this.peers.delete(id)
    this.inboxes.delete(id)
    this.#log('leave', { peer: peer.name, id })
    return true
  }

  /** Resolve a peer by id, callsign (case-insensitive), or serial. */
  resolve(query) {
    if (typeof query !== 'string' || query === '') return undefined
    const direct = this.peers.get(query)
    if (direct) return direct
    const lower = query.toLowerCase()
    return [...this.peers.values()].find(
      (peer) => peer.name.toLowerCase() === lower || peer.serial === query,
    )
  }

  // ---- sessions -----------------------------------------------------------
  link(queries) {
    const members = []
    for (const query of queries ?? []) {
      const peer = this.resolve(query)
      if (!peer) throw new HubError('unknown_peer', `no mesh peer named "${query}"`)
      if (!members.includes(peer.id)) members.push(peer.id)
    }
    if (members.length < 2) throw new HubError('bad_request', 'a session needs two or more peers')
    if (members.length > 8) throw new HubError('bad_request', 'a session holds at most 8 peers')
    const id = 's-' + randomBytes(4).toString('hex')
    const session = { id, members, policy: makePolicy(), createdAt: this.now() }
    this.sessions.set(id, session)
    this.#log('link', { session: id, peers: members.map((member) => this.peers.get(member).name) })
    return session
  }

  unlink(sessionId) {
    if (!this.sessions.delete(sessionId)) throw new HubError('unknown_session', `no session "${sessionId}"`)
    this.#log('unlink', { session: sessionId })
  }

  /** Deliver everything currently matured for a peer with seq > cursor. */
  poll(id, after = 0) {
    const peer = this.peers.get(id)
    if (!peer) throw new HubError('unknown_peer', `no peer "${id}"`)
    peer.lastSeen = this.now()
    const inbox = this.inboxes.get(id) ?? []
    const due = inbox.filter((envelope) => envelope.seq > after && envelope.readyAt <= this.now())
    for (const envelope of due) {
      const index = inbox.indexOf(envelope)
      if (index >= 0) inbox.splice(index, 1)
    }
    const cursor = due.length ? due[due.length - 1].seq : after
    return {
      messages: due.map((envelope) => ({
        seq: envelope.seq,
        from: this.peers.get(envelope.from)?.name ?? envelope.from,
        session: envelope.session,
        ts: envelope.ts,
        body: envelope.body,
      })),
      cursor,
      pending: inbox.length,
    }
  }

  // ---- messaging ----------------------------------------------------------
  /**
   * Send a JSON message through a session. `from` may be a peer query;
   * `via: 'agent'` marks an observation-window injection. Returns
   * {seq, delivered, dropped, duplicated, readyAt}.
   */
  send({ session: sessionId, from, body, via }) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new HubError('unknown_session', `no session "${sessionId}"`)
    const sender = this.resolve(from)
    if (!sender) throw new HubError('unknown_peer', `no mesh peer named "${from}"`)
    if (!session.members.includes(sender.id)) {
      throw new HubError('not_member', `${sender.name} is not in session ${session.id}`)
    }
    const serialized = JSON.stringify(body ?? null)
    if (serialized === undefined) throw new HubError('bad_request', 'body must be JSON-serializable')
    if (serialized.length > 64 * 1024) throw new HubError('too_large', 'message body exceeds 64 KiB')
    const seq = ++this.messageSeq
    const ts = this.now()
    const policy = session.policy
    const jitter = policy.jitterMs > 0 ? Math.round(this.random() * policy.jitterMs) : 0
    const throttleExtra = policy.throttleKbps > 0 ? Math.round((serialized.length * 8) / policy.throttleKbps) : 0
    let delivered = 0
    let dropped = 0
    let duplicated = 0
    let firstReadyAt = Infinity
    for (const memberId of session.members) {
      if (memberId === sender.id) continue
      if (policy.dropPct > 0 && this.random() * 100 < policy.dropPct) {
        dropped++
        this.#log('drop', { session: session.id, seq, to: this.peers.get(memberId)?.name ?? memberId, from: sender.name })
        continue
      }
      const readyAt = ts + policy.latencyMs + jitter + throttleExtra
      const inbox = this.inboxes.get(memberId) ?? []
      inbox.push({ seq, readyAt, ts, from: sender.id, session: session.id, body })
      this.inboxes.set(memberId, inbox)
      delivered++
      firstReadyAt = Math.min(firstReadyAt, readyAt)
      // Long-poll correctness: a delayed envelope matures without a new send, so
      // arm a one-shot wake for exactly that moment (unref'd; never keeps tests or
      // the host alive).
      const wake = setTimeout(() => this.#wake(memberId), Math.max(0, readyAt - this.now()))
      wake.unref?.()
      if (policy.dupPct > 0 && this.random() * 100 < policy.dupPct) {
        inbox.push({ seq, readyAt, ts, from: sender.id, session: session.id, body })
        duplicated++
        this.#log('dup', { session: session.id, seq, to: this.peers.get(memberId)?.name ?? memberId })
      }
      this.#wake(memberId)
    }
    this.#log('send', {
      session: session.id, seq, from: sender.name, to: delivered, dropped, duplicated,
      bytes: serialized.length, via, latencyMs: policy.latencyMs,
    })
    return {
      seq,
      delivered,
      dropped,
      duplicated,
      readyAt: delivered ? firstReadyAt : null,
    }
  }

  tune(sessionId, input) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new HubError('unknown_session', `no session "${sessionId}"`)
    session.policy = makePolicy({ ...session.policy, ...input })
    this.#log('tune', { session: session.id, policy: session.policy })
    return session.policy
  }

  // ---- observation --------------------------------------------------------
  status() {
    return {
      peers: [...this.peers.values()].map((peer) => ({ ...peer })),
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        members: session.members.map((member) => this.peers.get(member)?.name ?? member),
        policy: { ...session.policy },
        pending: session.members.reduce((sum, member) => sum + (this.inboxes.get(member)?.length ?? 0), 0),
      })),
      messageSeq: this.messageSeq,
    }
  }

  log({ session, limit = 50 } = {}) {
    const entries = this.entries.filter((entry) => !session || entry.session === session)
    return entries.slice(-clamp(limit, 1, this.maxLog))
  }

  reset() {
    this.peers.clear()
    this.sessions.clear()
    this.inboxes.clear()
    this.entries.length = 0
    this.messageSeq = 0
  }

  /** Long-poll support: resolve waiters when mail for `peerId` may have matured. */
  #wake(peerId) {
    for (const waiter of [...this.waiters]) {
      if (waiter.peerId === peerId) {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        waiter.resolve()
      }
    }
  }

  waitFor(peerId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(false)
      }, clamp(timeoutMs, 0, 30_000))
      const waiter = {
        peerId,
        resolve: () => { clearTimeout(timer); resolve(true) },
      }
      this.waiters.push(waiter)
    })
  }

  #log(kind, fields) {
    this.entries.push({ seq: ++this.seq, ts: this.now(), kind, ...fields })
    if (this.entries.length > this.maxLog) this.entries.splice(0, this.entries.length - this.maxLog)
  }
}

export class HubError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
