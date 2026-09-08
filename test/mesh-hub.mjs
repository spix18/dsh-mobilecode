// Offline test for the mesh hub: identity, linking, and the delivery policy
// engine. Clock and RNG are injected so latency/jitter/drop/dup are exact.
import assert from 'node:assert/strict'
import { MeshHub, HubError, callsign } from '../lib/mesh-hub.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name) }
  catch (error) { console.error('FAIL  ' + name + '\n      ' + error.message); process.exitCode = 1 }
}

// A hub with a controllable clock and a scripted RNG (repeats its script).
function makeHub({ random = () => 0.99 } = {}) {
  let t = 1000
  const hub = new MeshHub({ secret: 'test-secret', now: () => t, random })
  hub.advance = (ms) => { t += ms }
  return hub
}

ok('callsign is deterministic and adjective-animal shaped', () => {
  const a = callsign('emulator-5554')
  assert.equal(a, callsign('emulator-5554'))
  assert.match(a, /^[a-z]+-[a-z]+$/)
  assert.notEqual(a, callsign('emulator-5556'))
})

ok('join assigns a stable id + serial-pinned name, returns a token', () => {
  const hub = makeHub()
  const { peer, token } = hub.join({ serial: 'emulator-5554' })
  assert.equal(peer.serial, 'emulator-5554')
  assert.equal(peer.name, callsign('emulator-5554'))
  assert.ok(hub.verify(peer.id, token))
  assert.ok(!hub.verify(peer.id, 'bogus'))
})

ok('re-join with same serial reuses identity and dedupes name', () => {
  const hub = makeHub()
  const first = hub.join({ serial: 'A' })
  const again = hub.join({ serial: 'A' })
  assert.equal(first.peer.id, again.peer.id)
  assert.equal(hub.status().peers.length, 1)
})

ok('serialless joins get unique callsigns (collision -> suffix)', () => {
  const hub = makeHub()
  const p1 = hub.join({ name: 'gamer' })
  const p2 = hub.join({ name: 'gamer' })
  assert.equal(p1.peer.name, 'gamer')
  assert.equal(p2.peer.name, 'gamer-2')
})

ok('link needs 2+ resolvable peers and names them in order', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  assert.throws(() => hub.link(['A-ghost']), HubError)
  const session = hub.link([a.peer.name, b.peer.name])
  assert.equal(session.members.length, 2)
})

ok('send delivers zero-latency mail immediately and poll drains the inbox', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  const res = hub.send({ session: s.id, from: a.peer.name, body: { hit: 1 } })
  assert.equal(res.delivered, 1)
  const got = hub.poll(b.peer.id)
  assert.equal(got.messages.length, 1)
  assert.deepEqual(got.messages[0].body, { hit: 1 })
  assert.equal(got.messages[0].from, a.peer.name)
  assert.equal(hub.poll(b.peer.id, got.cursor).messages.length, 0, 'inbox drained')
})

ok('latency holds mail until the clock catches up', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  hub.tune(s.id, { latencyMs: 120 })
  const res = hub.send({ session: s.id, from: a.peer.name, body: 'x' })
  assert.equal(hub.poll(b.peer.id).messages.length, 0, 'not due yet')
  hub.advance(119)
  assert.equal(hub.poll(b.peer.id).messages.length, 0, '1ms short')
  hub.advance(1)
  const got = hub.poll(b.peer.id, res.seq - 1)
  assert.equal(got.messages.length, 1)
  assert.deepEqual(got.messages[0].body, 'x')
})

ok('poll cursor filters already-seen sequences', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  hub.send({ session: s.id, from: a.peer.name, body: 1 })
  hub.advance(1)
  const first = hub.poll(b.peer.id)
  hub.advance(1)
  hub.send({ session: s.id, from: a.peer.name, body: 2 })
  const second = hub.poll(b.peer.id, first.cursor)
  assert.equal(second.messages.length, 1)
  assert.deepEqual(second.messages[0].body, 2)
})

ok('drop policy with RNG under threshold removes delivery and logs it', () => {
  const hub = makeHub({ random: () => 0.01 }) // 0.01*100=1 < dropPct -> drop
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  hub.tune(s.id, { dropPct: 50 })
  const res = hub.send({ session: s.id, from: a.peer.name, body: 'gone' })
  assert.equal(res.delivered, 0)
  assert.equal(res.dropped, 1)
  hub.advance(10)
  assert.equal(hub.poll(b.peer.id).messages.length, 0)
  assert.ok(hub.log({ session: s.id }).some((e) => e.kind === 'drop'))
})

ok('dup policy doubles a message under an always-true RNG', () => {
  const hub = makeHub({ random: () => 0.0 }) // jitter*0 = 0; 0 < dupPct always
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  hub.tune(s.id, { dupPct: 50 })
  const res = hub.send({ session: s.id, from: a.peer.name, body: 'echo' })
  assert.equal(res.duplicated, 1)
  hub.advance(1)
  const got = hub.poll(b.peer.id)
  assert.equal(got.messages.length, 2) // both copies share a seq, matured together
})

ok('throttle adds size-proportional delay', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  hub.tune(s.id, { throttleKbps: 8 }) // 1000 bytes*8/8 = 1000ms extra
  const body = { pad: 'x'.repeat(990) }
  const res = hub.send({ session: s.id, from: a.peer.name, body })
  hub.advance(900)
  assert.equal(hub.poll(b.peer.id).messages.length, 0, 'throttled below 1000ms')
  hub.advance(200)
  assert.equal(hub.poll(b.peer.id, res.seq - 1).messages.length, 1)
})

ok('tune clamps nonsense policy values', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  const policy = hub.tune(s.id, { latencyMs: 999999, dropPct: -5, dupPct: 200 })
  assert.equal(policy.latencyMs, 5000)
  assert.equal(policy.dropPct, 0)
  assert.equal(policy.dupPct, 100)
})

ok('sender not in session is refused', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const c = hub.join({ serial: 'C' })
  const s = hub.link([a.peer.name, b.peer.name])
  assert.throws(() => hub.send({ session: s.id, from: c.peer.name, body: 1 }), /not in session/)
})

ok('oversized body is rejected', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  assert.throws(() => hub.send({ session: s.id, from: a.peer.name, body: { big: 'x'.repeat(70 * 1024) } }), /64 KiB/)
})

ok('leave evicts a peer and dissolves singleton sessions', () => {
  const hub = makeHub()
  const a = hub.join({ serial: 'A' })
  const b = hub.join({ serial: 'B' })
  const s = hub.link([a.peer.name, b.peer.name])
  hub.leave(b.peer.id)
  assert.equal(hub.status().peers.length, 1)
  assert.equal(hub.sessions.get(s.id), undefined)
})

ok('reset clears the whole board', () => {
  const hub = makeHub()
  hub.join({ serial: 'A' })
  hub.join({ serial: 'B' })
  hub.reset()
  assert.equal(hub.status().peers.length, 0)
  assert.equal(hub.status().sessions.length, 0)
})

console.log(`\n${passed} mesh-hub checks passed`)
