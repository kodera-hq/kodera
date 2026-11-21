/** Owned PostgreSQL runner: one collaborative edit's wiki-links resolve on locale-free title keys. */
import pg from 'pg'
import * as Y from 'yjs'
import { Store } from '../store.mjs'
import { verify } from '../tickets.mjs'
const pool = new pg.Pool({connectionString: process.env.KODERA_TEST_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000})
pool.on('error', () => {})
const payload = JSON.parse(await new Promise(resolve => {
  let text = '';process.stdin.setEncoding('utf8');process.stdin.on('data', chunk => { text += chunk });process.stdin.on('end', () => resolve(text))
}))
try {
  const editor = verify(payload.editor, Buffer.from(process.env.KODERA_TEST_COLLAB_KEY, 'base64url'))
  const store = new Store(pool), initial = await store.load(editor), client = new Y.Doc()
  try {
    Y.applyUpdate(client, initial.state)
    const vector = Y.encodeStateVector(client)
    const paragraph = client.getXmlFragment('content').toArray().find(node => node.nodeName === 'paragraph')
    if (paragraph.length === 0) paragraph.insert(0, [new Y.XmlText()])
    paragraph.get(0).insert(paragraph.get(0).length, payload.links.map(title => `[[${title}]]`).join(' '))
    await store.update(editor, Y.encodeStateAsUpdate(client, vector))
    const stored = await pool.query('SELECT target_title,target_id FROM docs_documentlink WHERE source_id=$1 ORDER BY target_title', [editor.document])
    process.stdout.write(JSON.stringify(stored.rows))
  } finally { client.destroy() }
} catch (error) {
  process.stderr.write(JSON.stringify({error: error.name, message: error.message, cause: error.cause?.message}))
  process.exitCode = 1
} finally { await pool.end() }
