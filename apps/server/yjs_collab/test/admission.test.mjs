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
  assert.throws(() => confidentialFrame(buildKde1({ epoch: 3, sender: 'checkpoint', sequence: 1, kind: 3 }), 'viewer', 3), ViewerWrite)
  assert.equal(confidentialFrame(buildKde1({ epoch: 3, sender: '101', sequence: 1, kind: 1 }), 'viewer', 3).kind, 1)
  assert.equal(confidentialFrame(buildKde1({ epoch: 3, sender: '101', sequence: 2, kind: 2 }), 'viewer', 3).kind, 2)
  assert.equal(confidentialFrame(buildKde1({ epoch: 3, sender: 'checkpoint', sequence: 1, kind: 3 }), 'editor', 3).kind, 3)

  // Unsealed frames (varuint 0, 1, 3), wrong epoch/truncated tag, or invalid checkpoint sender fail closed with ConfidentialRefused.
  for (const bad of [
    new Uint8Array([0, 0, 1, 0]),
    new Uint8Array([1, 2, 1, 2]),
    new Uint8Array([3]),
    buildKde1({ epoch: 4, sender: '101', sequence: 1, kind: 0 }),
    buildKde1({ epoch: 3, sender: '101', sequence: 0, kind: 0 }),
    buildKde1({ epoch: 3, sender: '101', sequence: 1, kind: 0, payloadBytes: 28 }),
    buildKde1({ epoch: 3, sender: '101', sequence: 1, kind: 3 }),
    buildKde1({ epoch: 3, sender: 'checkpoint', sequence: 1, kind: 0 }),
    buildKde1({ epoch: 3, sender: '101', sequence: 1, kind: 2, payloadBytes: 70000 }),
  ]) {
    assert.throws(() => confidentialFrame(bad, 'editor', 3), ConfidentialRefused)
  }

  // Confidential Store.admit and Store.update pass (confidential, epoch) to 10-arg docs_collab_fence and never invoke Yjs transform worker.
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
    device: randomUUID(),
    epoch: 3,
    expires: Math.floor(Date.now() / 1000) + 60,
    nonce: randomUUID(),
  }
  await store.update(claims, valid0)
  assert.equal(storedUpdates.length, 1)
  assert.equal(queries.some(q => q.sql.includes('markdown=$2')), false)
  assert.equal(queries.some(q => q.sql.includes('docs_documentlink')), false)
  const fenceCall = queries.find(q => q.sql.includes('docs_collab_fence'))
  assert.deepEqual(fenceCall.params.slice(7), [true, 3, claims.device])

  let delivered = null
  await store.admit({ ...claims, nonce: randomUUID() }, payload => { delivered = payload })
  assert.equal(delivered.confidential, true)
  assert.equal(delivered.envelopes.length, 1)
  assert.deepEqual(new Uint8Array(delivered.envelopes[0]), valid0)

  // Compaction (>256 frames) and epoch advancement in Store.compact + Store.deliver
  let baseSeq = 0
  let snapshotBuf = Buffer.alloc(0)
  const journalMap = new Map([[1, Buffer.from(valid0)]])
  let headSeq = 1
  let docEpoch = 3
  const compactClient = {
    async query(sql, params) {
      if (sql.includes('docs_collab_fence')) return { rows: [{ id: randomUUID() }] }
      if (sql.includes('docs_redeem_collaboration_ticket')) return { rows: [{ accepted: true }] }
      if (sql.includes('SELECT s.state,s.sequence,s.head_sequence')) {
        return {
          rowCount: 1,
          rows: [{ state: snapshotBuf, sequence: baseSeq, head_sequence: headSeq, revision: 1 + headSeq }],
        }
      }
      if (sql.includes('SELECT sequence,state FROM docs_documentupdate')) {
        const rows = []
        for (const [seq, buf] of [...journalMap.entries()].sort((a, b) => a[0] - b[0])) {
          if (seq > params[1]) rows.push({ sequence: seq, state: buf })
        }
        return { rows }
      }
      if (sql.includes('INSERT INTO docs_documentupdate')) {
        const seq = params[2]
        journalMap.set(seq, Buffer.from(params[4]))
        headSeq = seq
        return { rows: [] }
      }
      if (sql.includes('UPDATE docs_documentsnapshot SET sequence=$2,state=$3')) {
        baseSeq = params[1]
        snapshotBuf = Buffer.from(params[2])
        return { rows: [] }
      }
      if (sql.includes('DELETE FROM docs_documentupdate WHERE document_id=$1 AND sequence<=$2')) {
        for (const seq of [...journalMap.keys()]) {
          if (seq <= params[1]) journalMap.delete(seq)
        }
        return { rows: [] }
      }
      if (sql.includes('UPDATE docs_document SET encryption_epoch=$2')) {
        docEpoch = params[1]
        return { rows: [] }
      }
      return { rows: [] }
    },
    release() {},
  }
  const compactStore = new Store({ connect: async () => compactClient })
  // Append 299 more updates (total 300 > 256) compacting every 64 frames!
  for (let i = 2; i <= 300; i += 1) {
    await compactStore.update(claims, buildKde1({ epoch: 3, sender: '101', sequence: i, kind: 0 }))
    if (i % 64 === 0) {
      const cp = buildKde1({ epoch: 3, sender: 'checkpoint', sequence: i, kind: 3 })
      await compactStore.compact(claims, i, cp)
    }
  }
  assert.equal(headSeq, 300)
  assert.equal(baseSeq, 256)
  assert.equal(journalMap.size, 44)
  assert.equal(docEpoch, 3)

  let caughtUp = null
  await compactStore.deliver(claims, payload => { caughtUp = payload })
  assert.equal(caughtUp.envelopes.length, 45) // 1 checkpoint (kind=3) + 44 updates (kind=0)

  // Epoch advancement to epoch 4: deliver filters out epoch-3 rows until editor compacts at epoch 4.
  const epoch4Claims = { ...claims, epoch: 4, nonce: randomUUID() }
  let beforeEpochCompact = null
  await compactStore.deliver(epoch4Claims, payload => { beforeEpochCompact = payload })
  assert.equal(beforeEpochCompact.envelopes.length, 0)
  assert.equal(beforeEpochCompact.epochBootstrapped, false)

  const cpEpoch4 = buildKde1({ epoch: 4, sender: 'checkpoint', sequence: 1, kind: 3 })
  await assert.rejects(
    () => compactStore.compact(epoch4Claims, 300, cpEpoch4),
    /withheld prior-epoch/
  )
  await compactStore.compact(epoch4Claims, 300, cpEpoch4, { deliveredHead: caughtUp.deliveredHead })
  assert.equal(baseSeq, 300)
  assert.equal(journalMap.size, 0)
  assert.equal(docEpoch, 4)

  // Connected epoch-4 viewer whose deliveredHead is ALREADY 300 still receives the newly compacted epoch-4 checkpoint!
  let connectedViewerRefresh = null
  await compactStore.deliver(
    epoch4Claims,
    payload => { connectedViewerRefresh = payload },
    {
      head: beforeEpochCompact.head,
      snapshotEpoch: beforeEpochCompact.snapshotEpoch,
      snapshotBase: beforeEpochCompact.snapshotBase,
      epochBootstrapped: beforeEpochCompact.epochBootstrapped,
    }
  )
  assert.equal(connectedViewerRefresh.envelopes.length, 1)
  assert.equal(connectedViewerRefresh.snapshotDelivered, true)
  assert.equal(connectedViewerRefresh.epochBootstrapped, true)
  assert.deepEqual(new Uint8Array(connectedViewerRefresh.envelopes[0]), cpEpoch4)

  let afterEpochCompact = null
  await compactStore.deliver(epoch4Claims, payload => { afterEpochCompact = payload })
  assert.equal(afterEpochCompact.envelopes.length, 1)
  assert.deepEqual(new Uint8Array(afterEpochCompact.envelopes[0]), cpEpoch4)
})
