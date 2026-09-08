/**
 * dsh-mobilecode mesh — tiny client SDK for co-op game testing (v0.8.0).
 *
 * Plain fetch, no dependencies: runs in Node 18+, Deno, Bun, and any WebView /
 * Expo / React Native JS environment. For non-JS engines (Unity, Godot, plain
 * Kotlin) the protocol is six JSON-over-HTTP endpoints — see README "Co-op
 * mesh". From inside an Android emulator the hub is at
 * http://10.0.2.2:<dsh-port>/api/dsh-mobilecode (default port 3080).
 *
 * Usage:
 *   import { MeshClient } from 'dsh-mobilecode/sdk/mesh-client.mjs'
 *   const mesh = new MeshClient('http://10.0.2.2:3080/api/dsh-mobilecode')
 *   const { peer, token } = await mesh.join({ serial: 'emulator-5554' })
 *   const { session } = await mesh.link(['brisk-owl'])            // find + link peer by callsign
 *   await mesh.send(session.id, { type: 'attack', dmg: 12 })
 *   for await (const m of mesh.inbox({ waitMs: 5000 })) console.log(m.from, m.body)
 */
export class MeshClient {
  constructor(baseUrl = 'http://10.0.2.2:3080/api/dsh-mobilecode') {
    this.base = String(baseUrl).replace(/\/+$/, '')
    this.id = undefined
    this.token = undefined
    this.cursor = 0
  }

  async #rpc(path, { method = 'GET', body, query } = {}) {
    const url = new URL(this.base + path)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify({ id: this.id, token: this.token, ...body }),
    })
    const json = await res.json().catch(() => ({ error: 'non-JSON response' }))
    if (!res.ok) throw Object.assign(new Error(json.error ?? `${method} ${path} → ${res.status}`), { status: res.status, code: json.code })
    return json
  }

  /** Join (or re-join — idempotent per serial). Stores id + token for later calls. */
  async join(input = {}) {
    const json = await this.#rpc('/mesh/join', { method: 'POST', body: input })
    this.id = json.peer.id
    this.token = json.token
    return json // { ok, peer: { id, name, serial, role, ... }, token }
  }

  /** Who else is here, and which sessions exist. */
  peers() { return this.#rpc('/mesh/peers') }

  /** Link this client with the named peers into a new session. */
  link(withPeers) { return this.#rpc('/mesh/link', { method: 'POST', body: { with: withPeers } }) }

  /** Send a JSON body to every other member of a session. */
  send(session, body) { return this.#rpc('/mesh/send', { method: 'POST', body: { session, body } }) }

  /** One drain of matured mail; pass waitMs (<=30000) to long-poll. Advances the cursor. */
  async poll({ waitMs } = {}) {
    const json = await this.#rpc('/mesh/poll', { query: { after: this.cursor, ...(waitMs ? { wait: waitMs } : {}) } })
    if (json.messages?.length) this.cursor = json.cursor
    return json // { messages: [{ seq, from, session, ts, body }], cursor, pending }
  }

  /** Async iterator over incoming messages (long-polls until left). */
  async *inbox({ waitMs = 5000 } = {}) {
    while (this.id) {
      const { messages } = await this.poll({ waitMs })
      for (const message of messages ?? []) yield message
    }
  }

  /** Leave the mesh; the hub dissolves any session this drops below two members. */
  async leave() {
    const json = await this.#rpc('/mesh/leave', { method: 'POST', body: {} })
    this.id = undefined
    this.token = undefined
    return json
  }
}
