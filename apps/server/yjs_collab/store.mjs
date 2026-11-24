/** Workspace-serialized current authorization and durable native document commits. */
import { randomBytes, randomUUID } from 'node:crypto'
import { work } from './worker.mjs'
import { Refused } from './engine.mjs'
import { TicketRefused } from './tickets.mjs'
import { confidentialFrame, isKde1Magic, parseKde1Header, ConfidentialRefused } from './protocol.mjs'
import { titleKey } from './title-key.mjs'

export class Unavailable extends Error { constructor(cause = undefined) { super('collaboration storage unavailable', {cause}) } }
export class LockBusy extends Unavailable { constructor(cause = undefined) { super(cause); this.name = 'LockBusy' } }
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
function storedKde1Header(buffer, expectedKind = null) {
  if (!isKde1Magic(buffer)) throw new Unavailable()
  let header
  try { header = parseKde1Header(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)) }
  catch { throw new Unavailable() }
  if (expectedKind !== null && header.kind !== expectedKind) throw new Unavailable()
  return header
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
      const confidential = Boolean(claims.confidential)
      const epoch = confidential ? claims.epoch : null
      const domain = await client.query('SELECT docs_collab_fence($1,$2,$3,$4,$5,$6,$7,$8,$9) AS id',
        [claims.document, claims.organisation, claims.membership, claims.identity, claims.issuer, claims.subject, claims.role, confidential, epoch])
      if (!domain.rows[0]?.id) throw new TicketRefused(4403)
      alive(claims)
      const result = await operation(client, domain.rows[0].id)
      alive(claims)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { discard = true }
      if (error?.constraint === 'workspace_quota_exceeded') throw new QuotaRefused()
      const lockBusy = error && typeof error === 'object' && ['55P03', '57014', '40P01'].includes(error.code)
      throw error instanceof TicketRefused || error instanceof Refused ? error : lockBusy ? new LockBusy(error) : new Unavailable(error)
    } finally { client.release(discard) }
  }
  async binary(client, document) {
    const snapshot = await client.query(`SELECT s.state,s.sequence,s.head_sequence,d.revision FROM docs_documentsnapshot s
      JOIN docs_document d ON d.id=s.document_id WHERE d.id=$1 FOR NO KEY UPDATE OF d,s`, [document])
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
      if (claims.confidential) {
        const envelopes = []
        if (state.snapshot.length > 0) {
          const snapHeader = storedKde1Header(state.snapshot, 3)
          if (snapHeader.epoch === claims.epoch) envelopes.push(Buffer.from(state.snapshot))
        }
        for (const envelope of state.updates) {
          const updHeader = storedKde1Header(envelope, 0)
          if (updHeader.epoch === claims.epoch) envelopes.push(Buffer.from(envelope))
        }
        return {confidential: true, envelopes, head: state.head, base: state.base, revision: state.revision}
      }
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
  async deliver(claims, consumer, knownMarker = null) {
    return this.transaction(claims, async client => {
      const state = await this.binary(client, claims.document)
      if (claims.confidential) {
        const knownHead =
          knownMarker !== null && typeof knownMarker === 'object'
            ? knownMarker.head
            : knownMarker
        const knownSnapshotEpoch =
          knownMarker !== null && typeof knownMarker === 'object'
            ? knownMarker.snapshotEpoch ?? null
            : null
        const knownSnapshotBase =
          knownMarker !== null && typeof knownMarker === 'object'
            ? knownMarker.snapshotBase ?? null
            : null
        const knownBootstrapped =
          knownMarker !== null && typeof knownMarker === 'object'
            ? Boolean(knownMarker.epochBootstrapped)
            : false
        const snapHeader = state.snapshot.length > 0 ? storedKde1Header(state.snapshot, 3) : null
        const updHeaders = state.updates.map(part => storedKde1Header(part, 0))
        const hasMatchingSnapshot = snapHeader !== null && snapHeader.epoch === claims.epoch
        const allUpdatesMatchEpoch = updHeaders.every(h => h.epoch === claims.epoch)
        const snapshotUnseen =
          !knownBootstrapped &&
          hasMatchingSnapshot &&
          (knownSnapshotEpoch !== claims.epoch || knownSnapshotBase !== state.base)
        if (knownHead !== null && state.head <= knownHead && !snapshotUnseen) return
        const envelopes = []
        const journalSeqs = []
        const includeSnapshot =
          hasMatchingSnapshot &&
          (knownHead === null || knownHead < state.base || snapshotUnseen)
        if (includeSnapshot) {
          envelopes.push(Buffer.from(state.snapshot))
        }
        const startOffset =
          knownHead === null || knownHead < state.base ? 0 : Math.max(0, knownHead - state.base)
        for (let idx = startOffset; idx < state.updates.length; idx += 1) {
          if (updHeaders[idx].epoch === claims.epoch) {
            envelopes.push(Buffer.from(state.updates[idx]))
            journalSeqs.push(state.base + idx + 1)
          }
        }
        const epochBootstrapped =
          (knownBootstrapped ||
            ((state.snapshot.length === 0 && state.base === 0) || includeSnapshot)) &&
          allUpdatesMatchEpoch
        alive(claims)
        consumer({
          confidential: true,
          envelopes,
          journalSeqs,
          snapshotDelivered: includeSnapshot,
          snapshotEpoch: hasMatchingSnapshot ? claims.epoch : null,
          snapshotBase: hasMatchingSnapshot ? state.base : null,
          epochBootstrapped,
          head: state.head,
          base: state.base,
          revision: state.revision,
        })
        return
      }
      if (knownMarker !== null && state.revision === knownMarker) return
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
  async compact(claims, upToHead, snapshotEnvelope) {
    if (!claims.confidential || claims.role !== 'editor') throw new TicketRefused(4403)
    if (!Number.isSafeInteger(upToHead) || upToHead < 0) {
      throw new ConfidentialRefused('invalid confidential compaction cursor')
    }
    const parsed = confidentialFrame(
      snapshotEnvelope instanceof Uint8Array ? snapshotEnvelope : new Uint8Array(snapshotEnvelope),
      'editor',
      claims.epoch
    )
    if (parsed.kind !== 3) throw new ConfidentialRefused('confidential compaction requires kind=3 checkpoint')
    const snapshotBuf = Buffer.from(parsed.envelope)
    return this.transaction(claims, async client => {
      const state = await this.binary(client, claims.document)
      if (upToHead > state.head) throw new ConfidentialRefused('confidential compaction exceeds journal head')
      if (upToHead < state.base) {
        const snapHeader = state.snapshot.length > 0 ? storedKde1Header(state.snapshot, 3) : null
        if (snapHeader !== null && snapHeader.epoch === claims.epoch) {
          return {compacted: false, base: state.base, head: state.head, revision: state.revision}
        }
        throw new ConfidentialRefused('confidential compaction below snapshot base')
      }
      const targetSeq = Math.max(state.base, upToHead)
      const remainingBytes = state.updates
        .slice(targetSeq - state.base)
        .reduce((sum, bytes) => sum + bytes.length, 0)
      await client.query('SELECT docs_collab_snapshot_admit($1,$2)', [claims.document, snapshotBuf.length + remainingBytes])
      alive(claims)
      await client.query('UPDATE docs_documentsnapshot SET sequence=$2,state=$3,updated_at=clock_timestamp() WHERE document_id=$1',
        [claims.document, targetSeq, snapshotBuf])
      await client.query('DELETE FROM docs_documentupdate WHERE document_id=$1 AND sequence<=$2',
        [claims.document, targetSeq])
      await client.query('UPDATE docs_document SET encryption_epoch=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1',
        [claims.document, claims.epoch])
      await this.audit(client, claims, 'workspace.document.collab_updated')
      await client.query("SELECT pg_notify('kodera_docs',$1)", [claims.document])
      return {compacted: true, base: targetSeq, head: state.head, revision: state.revision + 1}
    })
  }
  async update(claims, incoming) {
    if (claims.role !== 'editor') throw new TicketRefused(4403)
    if (claims.confidential) {
      const parsed = confidentialFrame(
        incoming instanceof Uint8Array ? incoming : new Uint8Array(incoming),
        'editor',
        claims.epoch
      )
      if (parsed.kind !== 0) throw new ConfidentialRefused('confidential journal update requires kind=0')
      return this.transaction(claims, async client => {
        const state = await this.binary(client, claims.document)
        if (state.updates.length >= 256 || state.head >= Number.MAX_SAFE_INTEGER - 1) throw new QuotaRefused()
        const envelope = Buffer.from(parsed.envelope)
        const totalBytes = state.snapshot.length + state.updates.reduce((sum, bytes) => sum + bytes.length, 0) + envelope.length
        await client.query('SELECT docs_collab_snapshot_admit($1,$2)', [claims.document, totalBytes])
        const sequence = state.head + 1
        alive(claims)
        await client.query(`INSERT INTO docs_documentupdate(id,created_at,updated_at,document_id,sequence,actor_id,state)
          VALUES($1,clock_timestamp(),clock_timestamp(),$2,$3,$4,$5)`, [uuid7(), claims.document, sequence, claims.identity, envelope])
        await client.query('UPDATE docs_document SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1', [claims.document])
        await this.audit(client, claims, 'workspace.document.collab_updated')
        await client.query("SELECT pg_notify('kodera_docs',$1)", [claims.document])
        return {confidential: true, envelope, head: sequence, base: state.base, revision: state.revision + 1}
      })
    }
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
      // One statement on locale-free title keys, shared with the REST path's resolution.
      const keys = [...new Set(result.links.map(titleKey))].sort()
      if (keys.length) {
        await client.query(`INSERT INTO docs_documentlink(id,created_at,updated_at,document_id,target_id,target_title)
          SELECT l.id,clock_timestamp(),clock_timestamp(),$2,
            (SELECT d.id FROM docs_document d WHERE d.workspace_id=$3 AND d.deleted_at IS NULL AND d.title_key=l.key),l.key
          FROM unnest($1::uuid[],$4::text[]) AS l(id,key)
          ON CONFLICT(source_id,target_title) DO NOTHING`.replace('document_id,target_id', 'source_id,target_id'), [keys.map(() => uuid7()), claims.document, workspace, keys])
      }
      await this.audit(client, claims, 'workspace.document.collab_updated')
      await client.query("SELECT pg_notify('kodera_docs',$1)", [claims.document])
      return {update, state: snapshot, revision: state.revision + 1}
    })
  }
}
