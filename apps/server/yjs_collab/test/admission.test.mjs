import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Store, Unavailable } from '../store.mjs'
import { load, replace } from '../engine.mjs'

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
