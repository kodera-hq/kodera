/** Workspace-serialized current authorization and durable native document commits. */
import { randomBytes, randomUUID } from 'node:crypto'
import { work } from './worker.mjs'
import { Refused } from './engine.mjs'
import { TicketRefused } from './tickets.mjs'

export class Unavailable extends Error { constructor(cause = undefined) { super('collaboration storage unavailable', {cause}) } }
export class QuotaRefused extends Refused { constructor() { super('workspace snapshot quota exceeded'); this.name = 'QuotaRefused' } }
export function uuid7() {
  const value = randomBytes(16)
  value.writeUIntBE(Date.now(), 0, 6)
  value[6] = (value[6] & 15) | 0x70
  value[8] = (value[8] & 63) | 0x80
  const text = value.toString('hex')
  return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`
}
function number(value) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Unavailable()
  return result
}
function alive(claims) {
  if (claims.expires <= Math.floor(Date.now() / 1000)) throw new TicketRefused()
}
export class Store {
  constructor(pool) { this.pool = pool }
  async transaction(claims, operation) {
    alive(claims)
    const client = await this.pool.connect()
    let discard = false
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='3s'")
      await client.query("SET LOCAL statement_timeout='5s'")
      const domain = await client.query('SELECT docs_collab_fence($1,$2,$3,$4,$5,$6,$7) AS id',
        [claims.document, claims.organisation, claims.membership, claims.identity, claims.issuer, claims.subject, claims.role])
      if (!domain.rows[0]?.id) throw new TicketRefused(4403)
      alive(claims)
      const result = await operation(client, domain.rows[0].id)
      alive(claims)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { discard = true }
      if (error.constraint === 'workspace_quota_exceeded') throw new QuotaRefused()
      throw error instanceof TicketRefused || error instanceof Refused ? error : new Unavailable(error)
    } finally { client.release(discard) }
  }
  async binary(client, document) {
    const snapshot = await client.query(`SELECT s.state,s.sequence,s.head_sequence,d.revision FROM docs_documentsnapshot s
      JOIN docs_document d ON d.id=s.document_id WHERE d.id=$1 FOR UPDATE OF d,s`, [document])
    if (snapshot.rowCount !== 1) throw new Unavailable()
    const row = snapshot.rows[0], base = number(row.sequence), head = number(row.head_sequence)
    if (head < base || head - base > 256 || !Buffer.isBuffer(row.state) || row.state.length > 2 * 1024 * 1024) throw new Unavailable()
    const journal = await client.query('SELECT sequence,state FROM docs_documentupdate WHERE document_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 257', [document, base])
    if (journal.rows.length !== head - base || journal.rows.some((part, index) => number(part.sequence) !== base + index + 1 || !Buffer.isBuffer(part.state))) throw new Unavailable()
    return {snapshot: row.state, updates: journal.rows.map(part => part.state), head, revision: number(row.revision), base}
  }
  async load(claims) {
    return this.transaction(claims, async client => {
      const state = await this.binary(client, claims.document)
      const value = await work({operation: 'inspect', snapshot: state.snapshot.toString('base64'), updates: state.updates.map(part => part.toString('base64')), nonce: randomUUID()})
      return {state: Buffer.from(value.snapshot, 'base64'), revision: state.revision}
    })
  }
  async admit(claims, consumer) {
    // Persist consumption before disclosure. A failed or ambiguous COMMIT must
    // never emit a snapshot with a nonce that may still be reusable.
    await this.transaction(claims, async client => {
      const used = await client.query('SELECT docs_redeem_collaboration_ticket($1,$2) AS accepted', [claims.nonce, claims.expires])
      if (used.rows[0]?.accepted !== true) throw new TicketRefused()
    })
    return this.deliver(claims, consumer)
  }
  async deliver(claims, consumer, knownRevision = null) {
    return this.transaction(claims, async client => {
      const state = await this.binary(client, claims.document)
      if (knownRevision !== null && state.revision === knownRevision) return
      const value = await work({operation: 'inspect', snapshot: state.snapshot.toString('base64'), updates: state.updates.map(part => part.toString('base64')), nonce: randomUUID()})
      alive(claims)
      // The synchronous socket enqueue happens while membership, identity and
      // workspace policy fences are still held. No network await crosses this boundary.
      consumer({state: Buffer.from(value.snapshot, 'base64'), revision: state.revision})
    })
  }
  async emit(claims, consumer) { return this.transaction(claims, async () => consumer()) }
  async authorize(claims) { return this.transaction(claims, async () => true) }
  async audit(client, claims, action) {
    await client.query('SELECT docs_collab_audit($1,$2,$3,$4,$5,$6)',
      [uuid7(), action, claims.organisation, claims.document, claims.identity, uuid7()])
  }
  async viewerRefusal(claims) {
    return this.transaction(claims, async client => this.audit(client, claims, 'workspace.document.collab_refused'))
  }
  async update(claims, incoming) {
    if (claims.role !== 'editor') throw new TicketRefused(4403)
    return this.transaction(claims, async (client, workspace) => {
      const state = await this.binary(client, claims.document)
      const result = await work({operation: 'apply', snapshot: state.snapshot.toString('base64'), updates: state.updates.map(part => part.toString('base64')), update: Buffer.from(incoming).toString('base64'), nonce: randomUUID()})
      const snapshot = Buffer.from(result.snapshot, 'base64'), update = Buffer.from(result.update, 'base64')
      // A small delta can grow the merged document beyond its policy before the
      // next compaction. Admit the actual materialized size before every write.
      await client.query('SELECT docs_collab_snapshot_admit($1,$2)', [claims.document, snapshot.length])
      if (state.head >= Number.MAX_SAFE_INTEGER - 1) throw new Unavailable()
      const sequence = state.head + 1
      alive(claims)
      await client.query(`INSERT INTO docs_documentupdate(id,created_at,updated_at,document_id,sequence,actor_id,state)
        VALUES($1,clock_timestamp(),clock_timestamp(),$2,$3,$4,$5)`, [uuid7(), claims.document, sequence, claims.identity, update])
      await client.query('UPDATE docs_document SET markdown=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1', [claims.document, result.markdown])
      if (state.updates.length + 1 >= 32 || state.updates.reduce((sum, bytes) => sum + bytes.length, 0) + update.length >= 512 * 1024) {
        await client.query('UPDATE docs_documentsnapshot SET sequence=$2,head_sequence=$2,state=$3,updated_at=clock_timestamp() WHERE document_id=$1', [claims.document, sequence, snapshot])
        await client.query('DELETE FROM docs_documentupdate WHERE document_id=$1 AND sequence<=$2', [claims.document, sequence])
      }
      await client.query('DELETE FROM docs_documentlink WHERE source_id=$1', [claims.document])
      for (const title of result.links) {
        await client.query(`INSERT INTO docs_documentlink(id,created_at,updated_at,source_id,target_id,target_title)
          SELECT $1,clock_timestamp(),clock_timestamp(),$2,
            (SELECT id FROM docs_document WHERE workspace_id=$3 AND deleted_at IS NULL AND lower(title)=lower($4)),lower($4)
          ON CONFLICT(source_id,target_title) DO NOTHING`, [uuid7(), claims.document, workspace, title])
      }
      await this.audit(client, claims, 'workspace.document.collab_updated')
      await client.query("SELECT pg_notify('kodera_docs',$1)", [claims.document])
      return {update, state: snapshot, revision: state.revision + 1}
    })
  }
}
