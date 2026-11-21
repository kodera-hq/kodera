import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'
import { LockBusy, Store, Unavailable } from '../store.mjs'
import { createCollabServer } from '../socket-server.mjs'
import { TicketRefused } from '../tickets.mjs'

const VALID_CLAIMS = {
  document: '00000000-0000-7000-8000-000000000001',
  organisation: '00000000-0000-7000-8000-000000000002',
  membership: '00000000-0000-7000-8000-000000000003',
  identity: '00000000-0000-7000-8000-000000000004',
  issuer: 'https://identity.customer.test/realms/alpha',
  subject: 'subject-1',
  role: 'editor',
  nonce: 'nonce-1234567890123456',
  expires: Math.floor(Date.now() / 1000) + 300,
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

test('createCollabServer background refresh tolerates up to 2 transient LockBusy ticks before closing 1013', async () => {
  let mode = 'busy'
  let deliverCalls = 0
  const store = {
    async admit(_claims, consumer) {
      consumer({ state: Buffer.from([0, 0]), revision: 1 })
    },
    async deliver(_claims, _consumer) {
      deliverCalls += 1
      if (mode === 'busy') throw new LockBusy(Object.assign(new Error('lock not available'), { code: '55P03' }))
      if (mode === 'refused') throw new TicketRefused(4403)
    },
    async emit(_claims, fn) {
      return fn()
    },
  }
  const collab = createCollabServer({
    key: Buffer.alloc(32, 7),
    store,
    origins: new Set(['https://app.localhost']),
    pollMilliseconds: 60_000,
  })
  try {
    const docId = VALID_CLAIMS.document
    const closedCodes = []
    const fakeSocket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      claims: VALID_CLAIMS,
      revision: 1,
      send(_bytes, _opts, cb) {
        if (cb) cb()
      },
      close(code) {
        closedCodes.push(code)
        this.readyState = WebSocket.CLOSED
      },
      terminate() {},
    })
    collab.rooms.set(docId, {
      doc: { destroy() {} },
      awareness: { getStates: () => new Map() },
      connections: new Set([fakeSocket]),
      owners: new Map(),
      refreshing: false,
    })

    // First two LockBusy ticks during concurrent moderation lock are absorbed.
    await collab.notify(docId)
    await collab.notify(docId)
    assert.equal(deliverCalls, 2)
    assert.deepEqual(closedCodes, [])

    // A successful tick resets the streak.
    mode = 'ok'
    await collab.notify(docId)
    assert.equal(deliverCalls, 3)
    assert.deepEqual(closedCodes, [])

    // Three consecutive LockBusy ticks close with 1013 (retry later).
    mode = 'busy'
    await collab.notify(docId)
    await collab.notify(docId)
    assert.deepEqual(closedCodes, [])
    await collab.notify(docId)
    assert.deepEqual(closedCodes, [1013])

    // Immediate TicketRefused (e.g., kicked/banned) closes immediately with 4403 on first tick.
    const revokedSocket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      claims: VALID_CLAIMS,
      revision: 1,
      closeCode: null,
      send() {},
      close(code) {
        this.closeCode = code
        this.readyState = WebSocket.CLOSED
      },
      terminate() {},
    })
    collab.rooms.get(docId).connections = new Set([revokedSocket])
    mode = 'refused'
    await collab.notify(docId)
    assert.equal(revokedSocket.closeCode, 4403)
  } finally {
    await collab.shutdown()
  }
})
