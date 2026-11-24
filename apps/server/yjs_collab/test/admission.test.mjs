import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Store, Unavailable } from '../store.mjs'
import { load, replace } from '../engine.mjs'
import { confidentialFrame, ConfidentialRefused, ViewerWrite } from '../protocol.mjs'
import { verify, bind, TicketRefused } from '../tickets.mjs'

test('a failed redemption commit cannot disclose a snapshot', async () => {
  let disclosed = false, commits = 0
  const client = {
    async query(sql) {
      if (sql.includes('docs_collab_fence')) return {rows: [{id: randomUUID()}]}
      if (sql.includes('docs_redeem_collaboration_ticket')) return {rows: [{accepted: true}]}
      if (sql === 'COMMIT' && ++commits === 1) throw new Error('injected commit failure')
      return {rows: []}
    },
    release() {},
  }
  const store = new Store({connect: async () => client})
  const doc = load()
  const snapshot = replace(doc, '# Example\n\nAdmission\n').state
  doc.destroy()
  store.binary = async () => ({snapshot: Buffer.from(snapshot), updates: [], revision: 1})
  const claims = {expires: Math.floor(Date.now() / 1000) + 60, nonce: randomUUID()}
  await assert.rejects(store.admit(claims, () => { disclosed = true }), Unavailable)
  assert.equal(disclosed, false, 'snapshot preceded durable ticket consumption')
})

function buildKde1({ epoch = 3, sender = '101', sequence = 1, kind = 0, ratchet = 0, payloadBytes = 32 } = {}) {
  const meta = Buffer.from(JSON.stringify({ epoch, sender, sequence, kind, ratchet }), 'utf8')
  const out = Buffer.alloc(6 + meta.length + payloadBytes)
  out.set([0x4b, 0x44, 0x45, 0x31], 0)
  out.writeUInt16BE(meta.length, 4)
  meta.copy(out, 6)
  out.fill(0xa5, 6 + meta.length)
  return new Uint8Array(out)
}

test('confidential tickets and KDE1 protocol parser enforce strict magic, canonical metadata, epoch, and role', async () => {
  const valid0 = buildKde1({ epoch: 3, sender: '101', sequence: 1, kind: 0 })
  const parsed = confidentialFrame(valid0, 'editor', 3)
  assert.equal(parsed.kind, 0)
  assert.equal(parsed.sender, '101')
  assert.equal(parsed.sequence, 1)

  assert.throws(() => confidentialFrame(valid0, 'viewer', 3), ViewerWrite)
  assert.equal(confidentialFrame(buildKde1({ epoch: 3, sender: '101', sequence: 1, kind: 1 }), 'viewer', 3).kind, 1)

  // Unsealed frames (varuint 0, 1, 3) and wrong epoch/truncated tag fail closed with ConfidentialRefused.
  for (const bad of [
    new Uint8Array([0, 0, 1, 0]),
    new Uint8Array([1, 2, 1, 2]),
    new Uint8Array([3]),
    buildKde1({ epoch: 4, sender: '101', sequence: 1, kind: 0 }),
    buildKde1({ epoch: 3, sender: '101', sequence: 0, kind: 0 }),
    buildKde1({ epoch: 3, sender: '101', sequence: 1, kind: 0, payloadBytes: 28 }),
  ]) {
    assert.throws(() => confidentialFrame(bad, 'editor', 3), ConfidentialRefused)
  }

  // Confidential Store.admit and Store.update pass (confidential, epoch) to 9-arg docs_collab_fence and never invoke Yjs transform worker.
  const queries = []
  const storedUpdates = []
  const client = {
    async query(sql, params) {
      queries.push({ sql, params })
      if (sql.includes('docs_collab_fence')) return { rows: [{ id: randomUUID() }] }
      if (sql.includes('docs_redeem_collaboration_ticket')) return { rows: [{ accepted: true }] }
      if (sql.includes('SELECT s.state,s.sequence,s.head_sequence')) {
        return {
          rowCount: 1,
          rows: [{ state: Buffer.alloc(0), sequence: 0, head_sequence: storedUpdates.length, revision: 1 + storedUpdates.length }],
        }
      }
      if (sql.includes('SELECT sequence,state FROM docs_documentupdate')) {
        return {
          rows: storedUpdates.map((buf, idx) => ({ sequence: idx + 1, state: buf })),
        }
      }
      if (sql.includes('INSERT INTO docs_documentupdate')) {
        storedUpdates.push(Buffer.from(params[4]))
        return { rows: [] }
      }
      return { rows: [] }
    },
    release() {},
  }
  const store = new Store({ connect: async () => client })
  const claims = {
    document: randomUUID(),
    organisation: randomUUID(),
    membership: randomUUID(),
    identity: randomUUID(),
    issuer: 'https://identity.example.org/realms/community',
    subject: 'alice',
    role: 'editor',
    confidential: true,
    epoch: 3,
    expires: Math.floor(Date.now() / 1000) + 60,
    nonce: randomUUID(),
  }
  await store.update(claims, valid0)
  assert.equal(storedUpdates.length, 1)
  assert.equal(queries.some(q => q.sql.includes('markdown=$2')), false)
  assert.equal(queries.some(q => q.sql.includes('docs_documentlink')), false)
  const fenceCall = queries.find(q => q.sql.includes('docs_collab_fence'))
  assert.deepEqual(fenceCall.params.slice(7), [true, 3])

  let delivered = null
  await store.admit({ ...claims, nonce: randomUUID() }, payload => { delivered = payload })
  assert.equal(delivered.confidential, true)
  assert.equal(delivered.envelopes.length, 1)
  assert.deepEqual(new Uint8Array(delivered.envelopes[0]), valid0)
})
