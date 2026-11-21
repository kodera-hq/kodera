/** Real PostgreSQL concurrency proof for workspace Yjs collaboration, reciprocal wiki-links,
 *  routine REST write wait-through, and immediate advisory erasure fencing. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { assertDatabaseBoundary } from '../database-boundary.mjs'
import { updateFrame } from '../protocol.mjs'
import { createCollabServer } from '../socket-server.mjs'
import { LockBusy, Store } from '../store.mjs'
import { verify } from '../tickets.mjs'

function buildParagraphAppend(baseState, text) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, baseState)
    const vector = Y.encodeStateVector(doc)
    const paragraph = doc
      .getXmlFragment('content')
      .toArray()
      .find(node => node.nodeName === 'paragraph')
    if (paragraph.length === 0) paragraph.insert(0, [new Y.XmlText()])
    paragraph.get(0).insert(paragraph.get(0).length, text)
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
pool.on('error', () => {})
owner.on('error', () => {})

try {
  await assertDatabaseBoundary(pool)
  const store = new Store(pool)
  const claimsA1 = verify(input.ticketA1, key)
  const claimsB1 = verify(input.ticketB1, key)
  const claimsA2 = verify(input.ticketA2, key)

  // 1. Concurrent editors on the same workspace (both same doc and separate docs) succeed with 0 LockBusy.
  const initial1 = await store.load(claimsA1)
  const initial2 = await store.load(claimsA2)

  const deltaA1 = buildParagraphAppend(initial1.state, 'Alpha-edit ')
  const deltaB1 = buildParagraphAppend(initial1.state, 'Beta-edit ')
  const deltaA2 = buildParagraphAppend(initial2.state, 'Doc2-edit ')

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

  // 2. Concurrent reciprocal wiki-links (`Doc 1 -> Doc 2` and `Doc 2 -> Doc 1`) across 6 rounds never deadlock!
  let cur1 = (await store.load(claimsA1)).state
  let cur2 = (await store.load(claimsA2)).state
  for (let round = 0; round < 6; round += 1) {
    const link1 = buildParagraphAppend(cur1, ` [[Concurrent Doc Two]] r${round}`)
    const link2 = buildParagraphAppend(cur2, ` [[Concurrent Doc One]] r${round}`)
    const [next1, next2] = await Promise.all([
      store.update(claimsA1, link1),
      store.update(claimsA2, link2),
    ])
    cur1 = next1.state
    cur2 = next2.state
  }
  const linkRows = await owner.query(
    'SELECT source_id, target_id FROM public.docs_documentlink WHERE source_id = ANY($1::uuid[]) ORDER BY source_id',
    [[claimsA1.document, claimsA2.document]]
  )
  assert.equal(linkRows.rowCount, 2)
  const linkPairs = new Set(linkRows.rows.map(r => `${r.source_id}->${r.target_id}`))
  assert.ok(linkPairs.has(`${claimsA1.document}->${claimsA2.document}`))
  assert.ok(linkPairs.has(`${claimsA2.document}->${claimsA1.document}`))

  // 3. Routine 200ms REST write (`orgs_organisation FOR NO KEY UPDATE` + `workspaces_workspace FOR UPDATE`)
  //    waits cleanly without closing the WebSocket, whereas active erasure advisory locks fail immediately with 1013!
  const collab = createCollabServer({
    key,
    store,
    origins: new Set(['https://app.localhost']),
    pollMilliseconds: 60_000,
  })
  await new Promise(resolve => collab.server.listen(0, '127.0.0.1', resolve))
  const ownerClient = await owner.connect()
  let ws = null
  try {
    const { port } = collab.server.address()
    ws = new WebSocket(`ws://127.0.0.1:${port}/documents/collab`, {
      headers: { Origin: 'https://app.localhost' },
    })
    await once(ws, 'open')
    const initialMsg = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'auth', token: input.ticketWs }))
    await initialMsg

    // 3a. Hold `orgs_organisation FOR NO KEY UPDATE` + `workspaces_workspace FOR UPDATE` for 200ms
    await ownerClient.query('BEGIN')
    await ownerClient.query(
      'SELECT 1 FROM public.orgs_organisation WHERE id = $1 FOR NO KEY UPDATE',
      [input.organisationId]
    )
    await ownerClient.query('SELECT 1 FROM public.workspaces_workspace WHERE id = $1 FOR UPDATE', [
      input.workspaceId,
    ])
    const releaseRestWrite = (async () => {
      await delay(200)
      await ownerClient.query('COMMIT')
    })()

    const restWaitDelta = buildParagraphAppend(cur1, ' Survived-200ms-REST-lock')
    ws.send(updateFrame(restWaitDelta))
    await releaseRestWrite

    let persistedDuringRest = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const checkRow = await owner.query(
        'SELECT markdown FROM public.docs_document WHERE id = $1',
        [claimsA1.document]
      )
      if ((checkRow.rows[0]?.markdown ?? '').includes('Survived-200ms-REST-lock')) {
        persistedDuringRest = true
        break
      }
      await delay(25)
    }
    assert.equal(persistedDuringRest, true, 'edit must persist after 200ms REST lock releases')
    assert.equal(ws.readyState, WebSocket.OPEN, 'routine 200ms REST lock must NOT close socket')

    // 3b. Active org erasure advisory fence (`privacy_erasure_cutoff:<org>`) -> immediate 55P03 (< 1s)
    await ownerClient.query('BEGIN')
    await ownerClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('privacy_erasure_cutoff:' || $1, 0))",
      [input.organisationId]
    )
    const startedAt = Date.now()
    await assert.rejects(
      async () => store.authorize(claimsA1),
      err => err instanceof LockBusy && err.cause?.code === '55P03'
    )
    const elapsedMs = Date.now() - startedAt
    assert.ok(elapsedMs < 1000, `expected immediate advisory 55P03, took ${elapsedMs}ms`)
    await ownerClient.query('ROLLBACK')

    // 3c. Active account erasure advisory fence (`privacy_account_cutoff:<user>`) -> immediate WebSocket 1013 'lock-busy'
    const postRestState = (await store.load(claimsA1)).state
    await ownerClient.query('BEGIN')
    await ownerClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('privacy_account_cutoff:' || $1, 0))",
      [input.userId]
    )
    const erasureDelta = buildParagraphAppend(postRestState, ' Blocked-during-account-erasure')
    const closePromise = once(ws, 'close')
    ws.send(updateFrame(erasureDelta))
    const [closeCode, closeReason] = await closePromise
    assert.equal(closeCode, 1013)
    assert.equal(closeReason.toString('utf8'), 'lock-busy')

    await ownerClient.query('ROLLBACK')
    assert.equal(await store.authorize(claimsA1), true)
  } finally {
    ws?.terminate()
    try {
      await ownerClient.query('ROLLBACK')
    } catch {
      // ignore
    }
    ownerClient.release(true)
    await collab.shutdown()
  }

  const finalMarkdownRow = await owner.query(
    'SELECT markdown FROM public.docs_document WHERE id = $1',
    [claimsA1.document]
  )
  const finalMarkdown = finalMarkdownRow.rows[0]?.markdown ?? ''
  assert.ok(finalMarkdown.includes('Alpha-edit'), finalMarkdown)
  assert.ok(finalMarkdown.includes('Beta-edit'), finalMarkdown)
  assert.ok(finalMarkdown.includes('Survived-200ms-REST-lock'), finalMarkdown)
  assert.ok(!finalMarkdown.includes('Blocked-during-account-erasure'), finalMarkdown)

  process.stdout.write(
    JSON.stringify({
      concurrentWorkspaceSucceeded: true,
      reciprocalLinksSucceeded: true,
      restWriteWaitedWithoutDisconnect: true,
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
