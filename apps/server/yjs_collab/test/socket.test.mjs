import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHmac } from 'node:crypto'
import { once } from 'node:events'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocket } from 'ws'
import { createCollabServer } from '../socket-server.mjs'
import { load, replace, apply, inspect } from '../engine.mjs'
import { TicketRefused } from '../tickets.mjs'
import { updateFrame, snapshotFrame } from '../protocol.mjs'

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('test-owned socket condition timed out');await pause(5) }
}
function token(value, key) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url')
}
class MemoryStore {
  constructor() {
    this.document = randomUUID();this.organisation = randomUUID();this.doc = load()
    replace(this.doc, '# Example\n\nInitial text\n')
    this.roles = new Map();this.revision = 1;this.audit = [];this.guards = 0
  }
  guard(claims) {
    this.guards += 1
    if (claims.expires <= Math.floor(Date.now() / 1000)) throw new TicketRefused()
    if (claims.document !== this.document || claims.organisation !== this.organisation || this.roles.get(claims.membership) !== claims.role) throw new TicketRefused(4403)
  }
  async deliver(claims, consumer, known = null) {
    this.guard(claims)
    if (known !== this.revision) consumer({state: Y.encodeStateAsUpdate(this.doc), revision: this.revision})
  }
  async emit(claims, consumer) { this.guard(claims);consumer() }
  async update(claims, update) {
    this.guard(claims)
    if (claims.role !== 'editor') throw new TicketRefused(4403)
    apply(this.doc, update);inspect(this.doc);this.revision += 1
    return {update, revision: this.revision}
  }
  async viewerRefusal(claims) { this.guard(claims);this.audit.push(claims.membership) }
  claims(role) {
    const now = Math.floor(Date.now() / 1000), membership = randomUUID()
    this.roles.set(membership, role)
    return {v: 1, organisation: this.organisation, document: this.document, membership, identity: randomUUID(), issuer: 'https://identity.example.org/realms/community', subject: randomUUID(), role, issued: now, expires: now + 60, nonce: randomUUID()}
  }
}
async function fixture(pollMilliseconds = 100000) {
  const key = randomBytes(32), store = new MemoryStore()
  const service = createCollabServer({key, store, origins: new Set(['https://community.example.org']), pollMilliseconds})
  service.server.listen(0, '127.0.0.1');await once(service.server, 'listening')
  const url = 'ws://127.0.0.1:' + service.server.address().port + '/documents/collab'
  return {key, store, service, url, async close() { await service.shutdown();store.doc.destroy() }}
}
async function connect(fixture, claims, request = {}) {
  const socket = new WebSocket(fixture.url, {origin: 'https://community.example.org'})
  const doc = new Y.Doc()
  let synced = false
  socket.on('error', () => {})
  socket.on('message', bytes => {
    const reader = decoding.createDecoder(new Uint8Array(bytes))
    if (decoding.readVarUint(reader) !== 0) return
    const subtype = decoding.readVarUint(reader), body = decoding.readVarUint8Array(reader)
    if (subtype === 0 && claims.role === 'editor') socket.send(snapshotFrame(Y.encodeStateAsUpdate(doc, body)))
    else if (subtype === 1 || subtype === 2) { Y.applyUpdate(doc, body);synced = true }
  })
  await once(socket, 'open')
  socket.send(JSON.stringify({token: token(claims, fixture.key), organisation: claims.organisation, document: claims.document, ...request}))
  return {socket, doc, synced: () => synced}
}
function edit(peer, suffix) {
  const vector = Y.encodeStateVector(peer.doc)
  const text = peer.doc.getXmlFragment('prosemirror').get(1).get(0)
  text.insert(text.length, suffix)
  peer.socket.send(updateFrame(Y.encodeStateAsUpdate(peer.doc, vector)))
}

test('two editor sockets converge while a viewer update closes and is audited', async () => {
  const fixtureValue = await fixture()
  const peers = []
  try {
    const first = await connect(fixtureValue, fixtureValue.store.claims('editor'));peers.push(first)
    const second = await connect(fixtureValue, fixtureValue.store.claims('editor'));peers.push(second)
    await until(() => first.synced() && second.synced())
    edit(first, ' First')
    await until(() => inspect(second.doc).markdown.includes('First'))
    edit(second, ' Second')
    await until(() => inspect(first.doc).markdown.includes('Second'))
    assert.equal(inspect(first.doc).markdown, inspect(second.doc).markdown)
    const viewer = await connect(fixtureValue, fixtureValue.store.claims('viewer'));peers.push(viewer)
    await until(viewer.synced)
    const before = inspect(fixtureValue.store.doc).markdown
    const closed = once(viewer.socket, 'close')
    edit(viewer, ' Forbidden')
    assert.equal((await closed)[0], 4403)
    assert.equal(inspect(fixtureValue.store.doc).markdown, before)
    assert.equal(fixtureValue.store.audit.length, 1)
  } finally { for (const peer of peers) peer.doc.destroy();await fixtureValue.close() }
})

test('expired and wrongly bound tickets close before a room is joined', async () => {
  const fixtureValue = await fixture()
  const peers = []
  try {
    const current = fixtureValue.store.claims('viewer')
    const expired = {...current, issued: current.issued - 120, expires: current.issued - 1}
    for (const [claims, requested, code] of [[expired, {}, 4401], [current, {document: randomUUID()}, 4403], [current, {organisation: randomUUID()}, 4403]]) {
      const peer = await connect(fixtureValue, claims, requested);peers.push(peer)
      const result = await once(peer.socket, 'close')
      assert.equal(result[0], code)
      assert.equal(fixtureValue.service.rooms.size, 0)
    }
    assert.equal(fixtureValue.store.guards, 0)
  } finally { for (const peer of peers) peer.doc.destroy();await fixtureValue.close() }
})

test('current policy revocation closes an idle reader without a content update', async () => {
  const fixtureValue = await fixture(20)
  const claims = fixtureValue.store.claims('viewer')
  let peer
  try {
    peer = await connect(fixtureValue, claims)
    await until(peer.synced)
    const closed = once(peer.socket, 'close')
    fixtureValue.store.roles.delete(claims.membership)
    assert.equal((await closed)[0], 4403)
    assert.equal(fixtureValue.store.revision, 1)
  } finally { peer?.doc.destroy();await fixtureValue.close() }
})

test('awareness cannot claim another socket identity and binds user IDs server-side', async () => {
  const fixtureValue = await fixture()
  let peer
  try {
    const claims = fixtureValue.store.claims('viewer')
    peer = await connect(fixtureValue, claims);await until(peer.synced)
    const clientId = peer.doc.clientID
    function presence(id) {
      const body = encoding.createEncoder()
      encoding.writeVarUint(body, 1);encoding.writeVarUint(body, id);encoding.writeVarUint(body, 1)
      encoding.writeVarString(body, JSON.stringify({cursor: null, user: {id: randomUUID()}}))
      const packet = encoding.createEncoder()
      encoding.writeVarUint(packet, 1);encoding.writeVarUint8Array(packet, encoding.toUint8Array(body))
      return encoding.toUint8Array(packet)
    }
    peer.socket.send(presence(clientId))
    const room = fixtureValue.service.rooms.get(claims.document)
    await until(() => room.awareness.getStates().has(clientId))
    assert.equal(room.awareness.getStates().get(clientId).user.id, claims.membership)
    const closed = once(peer.socket, 'close')
    peer.socket.send(presence((clientId + 1) >>> 0))
    assert.equal((await closed)[0], 1008)
  } finally { peer?.doc.destroy();await fixtureValue.close() }
})

test('active connections close at ticket expiry and cannot reuse their room', async () => {
  const fixtureValue = await fixture()
  let peer
  try {
    const value = fixtureValue.store.claims('viewer')
    value.expires = value.issued + 2
    peer = await connect(fixtureValue, value)
    const closed = once(peer.socket, 'close')
    await until(peer.synced)
    assert.equal((await closed)[0], 4401)
    await until(() => fixtureValue.service.rooms.size === 0)
  } finally { peer?.doc.destroy();await fixtureValue.close() }
})

test('unapproved origins and query-string credentials fail before WebSocket admission', async () => {
  const fixtureValue = await fixture()
  try {
    for (const [url, origin] of [[fixtureValue.url, 'https://other.example.org'], [fixtureValue.url + '?token=unsupported', 'https://community.example.org']]) {
      const socket = new WebSocket(url, {origin})
      socket.on('error', () => {})
      const [, response] = await once(socket, 'unexpected-response')
      assert.equal(response.statusCode, 403)
      response.resume();socket.terminate()
    }
    assert.equal(fixtureValue.service.rooms.size, 0)
    assert.equal(fixtureValue.store.guards, 0)
  } finally { await fixtureValue.close() }
})

test('web auth first-frame shape and bounded selection awareness authenticate and strip role spoofing', async () => {
  const fixtureValue = await fixture()
  let socket, badSocket
  const doc = new Y.Doc()
  try {
    const claims = fixtureValue.store.claims('viewer')
    let synced = false
    socket = new WebSocket(fixtureValue.url, {origin: 'https://community.example.org'})
    socket.on('error', () => {})
    socket.on('message', bytes => {
      const reader = decoding.createDecoder(new Uint8Array(bytes))
      if (decoding.readVarUint(reader) !== 0) return
      const subtype = decoding.readVarUint(reader), body = decoding.readVarUint8Array(reader)
      if (subtype === 1 || subtype === 2) { Y.applyUpdate(doc, body); synced = true }
    })
    await once(socket, 'open')
    socket.send(JSON.stringify({type: 'auth', token: token(claims, fixtureValue.key)}))
    await until(() => synced)

    const clientId = doc.clientID
    const body = encoding.createEncoder()
    encoding.writeVarUint(body, 1); encoding.writeVarUint(body, clientId); encoding.writeVarUint(body, 1)
    encoding.writeVarString(body, JSON.stringify({
      user: {id: randomUUID(), name: 'Camille', role: 'editor', cursorSlot: 4},
      selection: {anchor: 2, head: 9},
    }))
    const packet = encoding.createEncoder()
    encoding.writeVarUint(packet, 1); encoding.writeVarUint8Array(packet, encoding.toUint8Array(body))
    socket.send(encoding.toUint8Array(packet))

    const room = fixtureValue.service.rooms.get(claims.document)
    await until(() => room.awareness.getStates().has(clientId))
    const storedState = room.awareness.getStates().get(clientId)
    assert.deepEqual(storedState, {
      cursor: null,
      selection: {anchor: 2, head: 9},
      user: {id: claims.membership, role: 'viewer', name: 'Camille', cursorSlot: 4},
    })

    badSocket = new WebSocket(fixtureValue.url, {origin: 'https://community.example.org'})
    badSocket.on('error', () => {})
    await once(badSocket, 'open')
    const closed = once(badSocket, 'close')
    badSocket.send(JSON.stringify({type: 'wrong', token: token(claims, fixtureValue.key)}))
    assert.equal((await closed)[0], 4401)
  } finally {
    doc.destroy()
    socket?.terminate()
    badSocket?.terminate()
    await fixtureValue.close()
  }
})
