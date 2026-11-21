/** Real PostgreSQL concurrency proof for workspace Yjs collaboration and immediate erasure fencing. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import pg from 'pg'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { assertDatabaseBoundary } from '../database-boundary.mjs'
import { updateFrame } from '../protocol.mjs'
import { createCollabServer } from '../socket-server.mjs'
import { LockBusy, Store } from '../store.mjs'
import { verify } from '../tickets.mjs'

function buildParagraphInsert(baseState, text) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, baseState)
    const vector = Y.encodeStateVector(doc)
    const paragraph = doc
      .getXmlFragment('content')
      .toArray()
      .find(node => node.nodeName === 'paragraph')
    if (paragraph.length === 0) paragraph.insert(0, [new Y.XmlText()])
    paragraph.get(0).insert(0, text)
    return Y.encodeStateAsUpdate(doc, vector)
  } finally {
    doc.destroy()
  }
}

const input = JSON.parse(
  await new Promise(resolve => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', value => {
      text += value
    })
    process.stdin.on('end', () => resolve(text))
  })
)

const key = Buffer.from(process.env.KODERA_TEST_COLLAB_KEY, 'base64url')
const login = new URL(process.env.KODERA_TEST_DATABASE_URL)
login.username = input.role
login.password = input.rolePassword
login.search = ''

const pool = new pg.Pool({ connectionString: login.href, max: 4 })
const owner = new pg.Pool({ connectionString: process.env.KODERA_TEST_DATABASE_URL, max: 2 })

try {
  await assertDatabaseBoundary(pool)
  const store = new Store(pool)
  const claimsA1 = verify(input.ticketA1, key)
  const claimsB1 = verify(input.ticketB1, key)
  const claimsA2 = verify(input.ticketA2, key)

  const initial1 = await store.load(claimsA1)
  const initial2 = await store.load(claimsA2)

  const deltaA1 = buildParagraphInsert(initial1.state, 'Alpha-edit ')
  const deltaB1 = buildParagraphInsert(initial1.state, 'Beta-edit ')
  const deltaA2 = buildParagraphInsert(initial2.state, 'Doc2-edit ')

  let deliveredCount = 0
  const [resA1, resB1, , resA2] = await Promise.all([
    store.update(claimsA1, deltaA1),
    store.update(claimsB1, deltaB1),
    store.deliver(claimsA1, payload => {
      assert.ok(Buffer.isBuffer(payload.state))
      deliveredCount += 1
    }),
    store.update(claimsA2, deltaA2),
  ])

  assert.equal(deliveredCount, 1)
  assert.equal(Math.max(resA1.revision, resB1.revision), initial1.revision + 2)
  assert.equal(resA2.revision, initial2.revision + 1)

  const markdownRow = await owner.query('SELECT markdown FROM public.docs_document WHERE id = $1', [
    claimsA1.document,
  ])
  const mergedMarkdown = markdownRow.rows[0]?.markdown ?? ''
  assert.ok(mergedMarkdown.includes('Alpha-edit'), mergedMarkdown)
  assert.ok(mergedMarkdown.includes('Beta-edit'), mergedMarkdown)

  // Real WebSocket + real PostgreSQL erasure lock (`orgs_organisation FOR UPDATE`) -> immediate 55P03 -> 1013 lock-busy
  const collab = createCollabServer({
    key,
    store,
    origins: new Set(['https://app.localhost']),
    pollMilliseconds: 60_000,
  })
  await new Promise(resolve => collab.server.listen(0, '127.0.0.1', resolve))
  const ownerClient = await owner.connect()
  try {
    const { port } = collab.server.address()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/documents/collab`, {
      headers: { Origin: 'https://app.localhost' },
    })
    await once(ws, 'open')
    const initialMsg = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'auth', token: input.ticketWs }))
    await initialMsg

    await ownerClient.query('BEGIN')
    await ownerClient.query('SELECT 1 FROM public.orgs_organisation WHERE id = $1 FOR UPDATE', [
      input.organisationId,
    ])

    const startedAt = Date.now()
    await assert.rejects(
      async () => store.authorize(claimsA1),
      err => err instanceof LockBusy && err.cause?.code === '55P03'
    )
    const elapsedMs = Date.now() - startedAt
    assert.ok(elapsedMs < 1500, `expected immediate NOWAIT 55P03, took ${elapsedMs}ms`)

    const latestState = resA1.revision > resB1.revision ? resA1.state : resB1.state
    const liveDelta = buildParagraphInsert(latestState, 'Blocked-during-erasure ')
    const closePromise = once(ws, 'close')
    ws.send(updateFrame(liveDelta))
    const [closeCode, closeReason] = await closePromise
    assert.equal(closeCode, 1013)
    assert.equal(closeReason.toString('utf8'), 'lock-busy')

    await ownerClient.query('ROLLBACK')
    assert.equal(await store.authorize(claimsA1), true)
  } finally {
    try {
      await ownerClient.query('ROLLBACK')
    } catch {
      // ignore
    }
    ownerClient.release()
    await collab.shutdown()
  }

  process.stdout.write(
    JSON.stringify({
      concurrentWorkspaceSucceeded: true,
      mergedBothEditors: true,
      erasureImmediate55P03: true,
      wsClose1013: true,
    })
  )
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error: error.name,
      message: error.message,
      cause: error.cause?.message,
      code: error.cause?.code,
    })
  )
  process.exitCode = 1
} finally {
  await pool.end()
  await owner.end()
}
