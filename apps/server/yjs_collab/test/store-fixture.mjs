/** Owned PostgreSQL/native-state test runner; no connection string enters its output. */
import pg from 'pg'
import * as Y from 'yjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Store } from '../store.mjs'
import { verify, TicketRefused } from '../tickets.mjs'
import { frame, updateFrame, ViewerWrite } from '../protocol.mjs'
const pool = new pg.Pool({connectionString: process.env.KODERA_TEST_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000})
pool.on('error', () => {})
const key = Buffer.from(process.env.KODERA_TEST_COLLAB_KEY, 'base64url')
const payload = JSON.parse(await new Promise(resolve => {
  let text = '';process.stdin.setEncoding('utf8');process.stdin.on('data', chunk => { text += chunk });process.stdin.on('end', () => resolve(text))
}))
const store = new Store(pool)
try {
  const editor = verify(payload.editor, key), viewer = verify(payload.viewer, key)
  const initial = await store.load(editor)
  const client = new Y.Doc()
  try {
    Y.applyUpdate(client, initial.state)
    const obsolete = Y.encodeStateAsUpdate(client)
    for (let index = 0; index < 33; index += 1) {
      const vector = Y.encodeStateVector(client)
      const paragraph = client.getXmlFragment('content').toArray().find(node => node.nodeName === 'paragraph')
      if (paragraph.length === 0) paragraph.insert(0, [new Y.XmlText()])
      paragraph.get(0).insert(paragraph.get(0).length, ' change' + index)
      const result = await store.update(editor, Y.encodeStateAsUpdate(client, vector))
      Y.applyUpdate(client, result.update)
    }
    const persisted = await pool.query('SELECT sequence,head_sequence FROM docs_documentsnapshot WHERE document_id=$1', [editor.document])
    assert.equal(Number(persisted.rows[0].sequence), 32)
    assert.equal(Number(persisted.rows[0].head_sequence), 33)
    const reloaded = await store.load(editor)
    const restored = new Y.Doc()
    try {
      Y.applyUpdate(restored, reloaded.state)
      assert.deepEqual(Y.encodeStateVector(restored), Y.encodeStateVector(client))
    } finally { restored.destroy() }
    const revision = reloaded.revision
    assert.throws(() => frame(updateFrame(obsolete), viewer.role), ViewerWrite)
    await store.viewerRefusal(viewer)
    await assert.rejects(store.update(viewer, obsolete), error => error instanceof TicketRefused && error.code === 4403)
    assert.equal((await store.load(editor)).revision, revision)
    const audit = await pool.query("SELECT count(*) FROM audit_auditevent WHERE action='workspace.document.collab_refused' AND organisation_id=$1", [editor.organisation])
    assert.equal(Number(audit.rows[0].count), 1)
    await assert.rejects(store.load({...editor, organisation: randomUUID()}), error => error.code === 4403)
    await assert.rejects(store.load({...editor, document: randomUUID()}), error => error.code === 4403)
    await assert.rejects(store.load({...editor, expires: 0}), error => error.code === 4401)
    process.stdout.write(JSON.stringify({sequence: 32, head: 33, revision, viewerRefused: true, reloaded: true}))
  } finally { client.destroy() }
} catch (error) {
  process.stderr.write(JSON.stringify({error: error.name, message: error.message, cause: error.cause?.message}))
  process.exitCode = 1
} finally { await pool.end() }
