/** Owned database-role proof; no password or connection address is returned. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import * as Y from 'yjs'
import { assertDatabaseBoundary } from '../database-boundary.mjs'
import { Store } from '../store.mjs'
import { verify } from '../tickets.mjs'

const input = JSON.parse(await new Promise(resolve => {
  let text = '';process.stdin.setEncoding('utf8');process.stdin.on('data', value => { text += value });process.stdin.on('end', () => resolve(text))
}))
const login = new URL(process.env.KODERA_TEST_DATABASE_URL)
login.username = input.role;login.password = input.rolePassword;login.search = ''
const pool = new pg.Pool({connectionString: login.href, max: 2})
const owner = new pg.Pool({connectionString: process.env.KODERA_TEST_DATABASE_URL, max: 1})
const maskedOwner = new URL(process.env.KODERA_TEST_DATABASE_URL)
maskedOwner.searchParams.set('options', '-c role=' + input.role)
const masked = new pg.Pool({connectionString: maskedOwner.href, max: 1})
try {
  await assert.rejects(assertDatabaseBoundary(owner), /collaboration database role refused/)
  await assert.rejects(assertDatabaseBoundary(masked), /collaboration database role refused/)
  await assertDatabaseBoundary(pool)
  assert.deepEqual((await pool.query('SELECT session_user,current_user')).rows[0], {session_user: input.role, current_user: input.role})
  const claims = verify(input.ticket, Buffer.from(process.env.KODERA_TEST_COLLAB_KEY, 'base64url'))
  const store = new Store(pool), initial = await store.load(claims)
  const document = new Y.Doc()
  try {
    Y.applyUpdate(document, initial.state)
    const vector = Y.encodeStateVector(document)
    const paragraph = document.getXmlFragment('content').toArray().find(node => node.nodeName === 'paragraph')
    if (paragraph.length === 0) paragraph.insert(0, [new Y.XmlText()])
    paragraph.get(0).insert(0, 'Restricted store update')
    await store.update(claims, Y.encodeStateAsUpdate(document, vector))
    await store.load(claims)
    await store.viewerRefusal({...claims, role: 'viewer'}).catch(error => { assert.equal(error.code, 4403) })
    const nonce = randomUUID(), expires = Math.floor(Date.now() / 1000) + 60
    const attempts = await Promise.all(Array.from({length: 8}, () => pool.query('SELECT docs_redeem_collaboration_ticket($1,$2) AS accepted', [nonce, expires])))
    assert.equal(attempts.filter(result => result.rows[0].accepted).length, 1)
    const database = (await owner.query('SELECT current_database() AS name')).rows[0].name
    const quote = value => '"' + value.replaceAll('"', '""') + '"'
    const excess = [
      'SELECT (email) ON identity_user',
      'UPDATE (visibility) ON docs_document',
      'TRUNCATE ON docs_document',
      'REFERENCES (id) ON docs_document',
      'CREATE ON SCHEMA public',
      'CREATE ON DATABASE ' + quote(database),
    ]
    for (const privilege of excess) {
      await owner.query('GRANT ' + privilege + ' TO ' + input.role)
      try { await assert.rejects(assertDatabaseBoundary(pool), /collaboration database role refused/) }
      finally { await owner.query('REVOKE ' + privilege + ' FROM ' + input.role) }
      await assertDatabaseBoundary(pool)
    }
    const sequence = 'collab_privilege_' + randomUUID().replaceAll('-', '')
    await owner.query('CREATE SEQUENCE ' + sequence)
    try {
      await owner.query('GRANT USAGE ON SEQUENCE ' + sequence + ' TO ' + input.role)
      await assert.rejects(assertDatabaseBoundary(pool), /collaboration database role refused/)
    } finally { await owner.query('DROP SEQUENCE ' + sequence) }
    await assertDatabaseBoundary(pool)
    process.stdout.write(JSON.stringify({restricted: true, persisted: true, nonceWinners: 1, widenedRefused: true}))
  } finally { document.destroy() }
} catch (error) {
  process.stderr.write(JSON.stringify({error: error.name, message: error.message, cause: error.cause?.message}))
  process.exitCode = 1
} finally { await pool.end();await owner.end();await masked.end() }
