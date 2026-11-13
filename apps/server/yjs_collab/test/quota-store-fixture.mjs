/** Real restricted PostgreSQL + native Yjs regression and its missing-admission mutation. */
import assert from 'node:assert/strict'
import pg from 'pg'
import * as Y from 'yjs'
import { Store, QuotaRefused } from '../store.mjs'
import { verify } from '../tickets.mjs'

const input = JSON.parse(await new Promise(resolve => {
  let raw = ''; process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { raw += chunk })
  process.stdin.on('end', () => resolve(raw))
}))
assert.match(input.role, /^collab_test_[a-f0-9]{12}$/)
const pool = new pg.Pool({connectionString: process.env.KODERA_TEST_DATABASE_URL, max: 1})
const store = new Store({connect: async () => {
  const client = await pool.connect()
  await client.query(`SET ROLE "${input.role}"`)
  return {query: (sql, ...args) => input.skipAdmission && sql.includes('docs_collab_snapshot_admit')
    ? Promise.resolve({rows: []}) : client.query(sql, ...args), release: value => client.release(value)}
}})
try {
  const claims = verify(input.ticket, Buffer.from(process.env.KODERA_TEST_COLLAB_KEY, 'base64url'))
  const initial = await store.load(claims), document = new Y.Doc()
  try {
    Y.applyUpdate(document, initial.state)
    let accepted = 0, refused = false, last = initial
    for (let index = 0; index < 30; index += 1) {
      const vector = Y.encodeStateVector(document)
      const paragraph = document.getXmlFragment('content').toArray().find(node => node.nodeName === 'paragraph')
      if (paragraph.length === 0) paragraph.insert(0, [new Y.XmlText()])
      const text = paragraph.get(0)
      text.insert(text.length, ' hello')
      const update = Y.encodeStateAsUpdate(document, vector)
      assert.ok(update.length < input.limit, 'fixture delta itself reached quota')
      try {
        last = await store.update(claims, update)
        Y.applyUpdate(document, last.update)
        accepted += 1
      } catch (error) {
        assert.ok(error instanceof QuotaRefused, error.message)
        refused = true
        break
      }
    }
    assert.ok(refused, 'materialized snapshot quota was bypassed')
    assert.ok(accepted > 1 && accepted < 30, 'fixture did not exercise repeated uncompacted deltas')
    const persisted = await store.load(claims)
    assert.equal(persisted.revision, last.revision)
    assert.deepEqual(persisted.state, last.state)
    assert.ok(persisted.state.length <= input.limit)
    process.stdout.write(JSON.stringify({accepted, refused, finalSize: persisted.state.length}))
  } finally { document.destroy() }
} finally { await pool.end() }
