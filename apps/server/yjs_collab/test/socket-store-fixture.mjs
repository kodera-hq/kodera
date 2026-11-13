/** Actual owned PostgreSQL and WebSocket admission, convergence and revocation proof. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'
import { createCollabServer } from '../socket-server.mjs'
import { Store } from '../store.mjs'
import { verify } from '../tickets.mjs'
import { inspect } from '../engine.mjs'
import { updateFrame, snapshotFrame } from '../protocol.mjs'

const pool = new pg.Pool({connectionString: process.env.KODERA_TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000})
pool.on('error', () => {})
const key = Buffer.from(process.env.KODERA_TEST_COLLAB_KEY, 'base64url')
const payload = JSON.parse(await new Promise(resolve => {
  let text = '';process.stdin.setEncoding('utf8');process.stdin.on('data', chunk => { text += chunk });process.stdin.on('end', () => resolve(text))
}))
const store = new Store(pool), editor = verify(payload.editor, key), viewer = verify(payload.viewer, key)
const service = createCollabServer({key, store, origins: new Set(['https://community.example.org']), pollMilliseconds: 100})
const peers = []
async function until(predicate) {
  const deadline = Date.now() + 10000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('owned PostgreSQL socket condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function connect(raw, claims, requested = {}) {
  const socket = new WebSocket('ws://127.0.0.1:' + service.server.address().port + '/documents/collab', {origin: 'https://community.example.org'})
  const doc = new Y.Doc(), peer = {socket, doc, synced: false, closed: null}
  peers.push(peer)
  socket.on('error', () => {})
  socket.on('close', code => { peer.closed = code })
  socket.on('message', bytes => {
    const reader = decoding.createDecoder(new Uint8Array(bytes))
    if (decoding.readVarUint(reader) !== 0) return
    const subtype = decoding.readVarUint(reader), body = decoding.readVarUint8Array(reader)
    if (subtype === 0 && claims.role === 'editor') socket.send(snapshotFrame(Y.encodeStateAsUpdate(doc, body)))
    else if (subtype === 1 || subtype === 2) { Y.applyUpdate(doc, body);peer.synced = true }
  })
  await once(socket, 'open')
  socket.send(JSON.stringify({token: raw, organisation: claims.organisation, document: claims.document, ...requested}))
  return peer
}
function edit(peer, text) {
  const vector = Y.encodeStateVector(peer.doc)
  const paragraph = peer.doc.getXmlFragment('content').toArray().find(node => node.nodeName === 'paragraph')
  if (paragraph.length === 0) paragraph.insert(0, [new Y.XmlText()])
  paragraph.get(0).insert(paragraph.get(0).length, text)
  peer.socket.send(updateFrame(Y.encodeStateAsUpdate(peer.doc, vector)))
}
try {
  service.server.listen(0, '127.0.0.1');await once(service.server, 'listening')
  const wrong = await connect(payload.editor, editor, {document: randomUUID()})
  await until(() => wrong.closed !== null)
  assert.equal(wrong.closed, 4403);assert.equal(service.rooms.size, 0)
  const first = await connect(payload.editor, editor), second = await connect(payload.secondEditor, verify(payload.secondEditor, key))
  await until(() => first.synced && second.synced)
  const replay = await connect(payload.editor, editor)
  await until(() => replay.closed !== null || replay.synced)
  assert.equal(replay.synced, false)
  assert.equal(replay.closed, 4401)
  edit(first, ' First');await until(() => inspect(second.doc).markdown.includes('First'))
  edit(second, ' Second');await until(() => inspect(first.doc).markdown.includes('Second'))
  assert.equal(inspect(first.doc).markdown, inspect(second.doc).markdown)
  const reader = await connect(payload.viewer, viewer)
  await until(() => reader.synced)
  edit(reader, ' Forbidden');await until(() => reader.closed !== null)
  assert.equal(reader.closed, 4403)
  const audit = await pool.query("SELECT count(*) FROM audit_auditevent WHERE action='workspace.document.collab_refused' AND organisation_id=$1", [viewer.organisation])
  assert.equal(Number(audit.rows[0].count), 1)
  assert.ok(!inspect(first.doc).markdown.includes('Forbidden'))
  const idle = await connect(payload.secondViewer, verify(payload.secondViewer, key))
  await until(() => idle.synced)
  // A committed current-role change invalidates the existing ticket while idle.
  await pool.query("UPDATE docs_documentgrant SET role='editor' WHERE document_id=$1 AND membership_id=$2", [viewer.document, viewer.membership])
  await until(() => idle.closed !== null)
  assert.equal(idle.closed, 4403)
  const row = await pool.query('SELECT markdown FROM docs_document WHERE id=$1', [editor.document])
  assert.ok(row.rows[0].markdown.includes('First') && row.rows[0].markdown.includes('Second'))
  assert.ok(!row.rows[0].markdown.includes('Forbidden'))
  const reload = await store.load(editor), restored = new Y.Doc()
  try { Y.applyUpdate(restored, reload.state);assert.equal(inspect(restored).markdown, row.rows[0].markdown) }
  finally { restored.destroy() }
  process.stdout.write(JSON.stringify({converged: true, viewerRefused: true, revoked: true}))
} catch (error) {
  process.stderr.write(JSON.stringify({error: error.name, message: error.message, cause: error.cause?.message}))
  process.exitCode = 1
} finally {
  await service.shutdown()
  for (const peer of peers) peer.doc.destroy()
  await pool.end()
}
