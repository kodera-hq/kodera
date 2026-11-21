import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as Y from 'yjs'
import { WebSocket } from 'ws'
import { load } from '../engine.mjs'
import { updateFrame } from '../protocol.mjs'
import { createCollabServer } from '../socket-server.mjs'
import { LockBusy, Store, Unavailable } from '../store.mjs'
import { TicketRefused } from '../tickets.mjs'

const nowSeconds = Math.floor(Date.now() / 1000)
const VALID_CLAIMS = {
  v: 1,
  document: '00000000-0000-7000-8000-000000000001',
  organisation: '00000000-0000-7000-8000-000000000002',
  membership: '00000000-0000-7000-8000-000000000003',
  identity: '00000000-0000-7000-8000-000000000004',
  issuer: 'https://identity.customer.test/realms/alpha',
  subject: 'subject-1',
  role: 'editor',
  issued: nowSeconds,
  expires: nowSeconds + 60,
  nonce: '00000000-0000-7000-8000-000000000005',
}

function signTicket(claims, key) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url')
}

test('Store.transaction classifies PostgreSQL lock/timeout SQLSTATEs as LockBusy subclass of Unavailable', async () => {
  for (const code of ['55P03', '57014', '40P01']) {
    const pool = {
      async connect() {
        return {
          async query(sql) {
            if (sql.includes('docs_collab_fence')) {
              const err = new Error('lock timeout')
              err.code = code
              throw err
            }
            return { rows: [] }
          },
          release() {},
        }
      },
    }
    const store = new Store(pool)
    await assert.rejects(
      async () => store.authorize(VALID_CLAIMS),
      err => err instanceof LockBusy && err instanceof Unavailable
    )
  }
})

test('createCollabServer closes immediately with 1013 lock-busy on both client update and refresh LockBusy without silently dropping edits', async () => {
  const key = Buffer.alloc(32, 7)
  const initialDoc = load()
  const docState = Y.encodeStateAsUpdate(initialDoc)
  initialDoc.destroy()
  let mode = 'busy'
  const store = {
    async admit(_claims, consumer) {
      consumer({ state: Buffer.from(docState), revision: 1 })
    },
    async deliver(_claims, _consumer) {
      if (mode === 'busy') {
        throw new LockBusy(Object.assign(new Error('lock not available'), { code: '55P03' }))
      }
      if (mode === 'refused') throw new TicketRefused(4403)
    },
    async update(_claims, _body) {
      throw new LockBusy(Object.assign(new Error('lock not available'), { code: '55P03' }))
    },
    async emit(_claims, fn) {
      return fn()
    },
  }
  const collab = createCollabServer({
    key,
    store,
    origins: new Set(['https://app.localhost']),
    pollMilliseconds: 60_000,
  })
  await new Promise(resolve => collab.server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = collab.server.address()

    // 1. Client Yjs update encountering LockBusy closes immediately with 1013 ('lock-busy'), never silently dropping the update.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/documents/collab`, {
      headers: { Origin: 'https://app.localhost' },
    })
    await once(ws, 'open')
    const initialMsg = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'auth', token: signTicket(VALID_CLAIMS, key) }))
    await initialMsg
    const admittedRoom = collab.rooms.get(VALID_CLAIMS.document)
    assert.ok(admittedRoom, 'expected admitted room')
    let awarenessDestroyed = false
    const origDestroy = admittedRoom.awareness.destroy.bind(admittedRoom.awareness)
    admittedRoom.awareness.destroy = () => {
      awarenessDestroyed = true
      origDestroy()
    }

    const editDoc = load()
    editDoc.getXmlFragment('content').insert(0, [new Y.XmlElement('paragraph')])
    const editPayload = Y.encodeStateAsUpdate(editDoc)
    editDoc.destroy()
    const closePromise = once(ws, 'close')
    ws.send(updateFrame(editPayload))
    const [updateCloseCode, updateCloseReason] = await closePromise
    assert.equal(updateCloseCode, 1013)
    assert.equal(updateCloseReason.toString('utf8'), 'lock-busy')
    const drainDeadline = Date.now() + 2000
    while (collab.rooms.size > 0 && Date.now() < drainDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(collab.rooms.size, 0)
    assert.equal(awarenessDestroyed, true)

    // 2. Background refresh encountering LockBusy also closes immediately with 1013 ('lock-busy').
    const docId = '00000000-0000-7000-8000-000000000099'
    const refreshClaims = { ...VALID_CLAIMS, document: docId }
    const closed = []
    const refreshSocket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      claims: refreshClaims,
      revision: 1,
      send() {},
      close(code, reason) {
        closed.push([code, reason])
        this.readyState = WebSocket.CLOSED
      },
      terminate() {},
    })
    collab.rooms.set(docId, {
      doc: { destroy() {} },
      awareness: { getStates: () => new Map(), destroy() {} },
      connections: new Set([refreshSocket]),
      owners: new Map(),
      refreshing: false,
    })
    mode = 'busy'
    await collab.notify(docId)
    assert.deepEqual(closed, [[1013, 'lock-busy']])

    // 3. Immediate TicketRefused (e.g., kicked/banned) closes immediately with 4403.
    const revokedClosed = []
    const revokedSocket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      claims: refreshClaims,
      revision: 1,
      send() {},
      close(code, reason) {
        revokedClosed.push([code, reason])
        this.readyState = WebSocket.CLOSED
      },
      terminate() {},
    })
    collab.rooms.get(docId).connections = new Set([revokedSocket])
    mode = 'refused'
    await collab.notify(docId)
    assert.deepEqual(revokedClosed, [[4403, 'operation refused']])
  } finally {
    await collab.shutdown()
  }
})

test(
  'real PostgreSQL concurrent workspace Yjs updates succeed without LockBusy while active org erasure triggers immediate 1013 lock-busy',
  {
    skip:
      !process.env.KODERA_TEST_DATABASE_URL || !process.env.KODERA_TEST_COLLAB_CONCURRENCY_JSON,
  },
  () => {
    const fixturePath = fileURLToPath(new URL('./concurrency-fixture.mjs', import.meta.url))
    const stdout = execFileSync(process.execPath, [fixturePath], {
      input: process.env.KODERA_TEST_COLLAB_CONCURRENCY_JSON,
      env: process.env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.deepEqual(JSON.parse(stdout), {
      concurrentWorkspaceSucceeded: true,
      reciprocalLinksSucceeded: true,
      restWriteWaitedWithoutDisconnect: true,
      erasureImmediate55P03: true,
      wsClose1013: true,
    })
  }
)
