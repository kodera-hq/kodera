// Standalone storage only. See local-state.spec.md for authority and rollback limits.
export const CONFIDENTIAL_STATE_DATABASE = 'kodera.confidential-state.v1'
export const LOCAL_STATE_LIMITS = Object.freeze({
  checkpointBytes: 17 * 1024 * 1024,
  pendingCount: 32,
  pendingItemBytes: 64 * 1024,
  pendingBytes: 1024 * 1024,
  batchCount: 8,
  ownerRecords: 64,
  ownerBytes: 64 * 1024 * 1024,
  databaseBytes: 128 * 1024 * 1024,
  lifetimeOwners: 16,
})
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PUBLIC_KEY = /^[0-9a-f]{64}$/
const MAGIC = [75, 67, 83, 49] as const
const MAX_ENCODED = 12 + LOCAL_STATE_LIMITS.checkpointBytes +
  LOCAL_STATE_LIMITS.pendingBytes + LOCAL_STATE_LIMITS.pendingCount * 40
const STORES = ['owners', 'records', 'metadata'] as const

export type LocalStateFailure = 'unavailable' | 'closed' | 'owner-revoked' |
  'not-initialized' | 'conflict' | 'capacity' | 'invalid-input' | 'corrupt' | 'storage'
export class ConfidentialStateError extends Error {
  constructor(readonly code: LocalStateFailure) { super(code); this.name = 'ConfidentialStateError' }
}
function fail(code: LocalStateFailure): never { throw new ConfidentialStateError(code) }
const safeError = (error: unknown): ConfidentialStateError =>
  error instanceof ConfidentialStateError ? error : new ConfidentialStateError('storage')
interface ScopeBase {
  ownerId: string
  organisationId: string
  membershipId: string
  devicePublicKey: string
}
export type ConfidentialScope = ScopeBase & (
  { kind: 'device-vault'; roomId?: never } | { kind: 'room'; roomId: string }
)
export interface PendingCiphertext { id: string; ciphertext: Uint8Array }
export interface OpaqueLocalState { checkpoint: Uint8Array; pendingSends: readonly PendingCiphertext[] }
export interface StateMutation { scope: ConfidentialScope; expectedGeneration: number; state: OpaqueLocalState }
export interface StateSnapshot extends OpaqueLocalState { generation: number }
interface Owner {
  ownerId: string; incarnation: string; status: 'active' | 'revoked'
  records: number; bytes: number; key?: CryptoKey
}
interface Capacity { id: 'capacity'; bytes: number }
interface EncryptedRecord {
  id: string; ownerId: string; incarnation: string; generation: number
  iv: ArrayBuffer; ciphertext: ArrayBuffer
}
interface Prepared { id: string; expected: number; record: EncryptedRecord }
function integer(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}
function ownerId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid-input')
}
function scopeKey(scope: ConfidentialScope, owner: string): string {
  if (!scope || typeof scope !== 'object') fail('invalid-input')
  for (const field of ['ownerId', 'organisationId', 'membershipId'] as const) ownerId(scope[field])
  if (scope.ownerId !== owner || typeof scope.devicePublicKey !== 'string' ||
      !PUBLIC_KEY.test(scope.devicePublicKey)) fail('invalid-input')
  if (scope.kind === 'room') ownerId(scope.roomId)
  else if (scope.kind !== 'device-vault' || scope.roomId !== undefined) fail('invalid-input')
  return JSON.stringify([scope.ownerId, scope.organisationId, scope.membershipId,
    scope.devicePublicKey, scope.kind, scope.roomId ?? null])
}
function keyValid(key: unknown): key is CryptoKey {
  return key instanceof CryptoKey && key.type === 'secret' && !key.extractable &&
    key.algorithm.name === 'AES-GCM' && (key.algorithm as AesKeyAlgorithm).length === 256 &&
    key.usages.length === 2 && key.usages.includes('encrypt') && key.usages.includes('decrypt')
}
function ownerHeader(value: unknown): Owner {
  if (!value || typeof value !== 'object') fail('not-initialized')
  const row = value as Owner
  if (typeof row.ownerId !== 'string' || !UUID.test(row.ownerId) ||
      typeof row.incarnation !== 'string' || !UUID.test(row.incarnation) ||
      !integer(row.records, LOCAL_STATE_LIMITS.ownerRecords) ||
      !integer(row.bytes, LOCAL_STATE_LIMITS.ownerBytes) ||
      (row.status !== 'active' && row.status !== 'revoked')) fail('corrupt')
  return row
}
function readOwner(value: unknown): Owner {
  const row = ownerHeader(value)
  if (row.status === 'revoked') fail('owner-revoked')
  if (!keyValid(row.key)) fail('corrupt')
  return row
}
function capacity(value: unknown): Capacity {
  const row = value as Capacity | undefined
  if (!row || row.id !== 'capacity' || !integer(row.bytes, LOCAL_STATE_LIMITS.databaseBytes)) fail('corrupt')
  return row
}
function record(value: unknown, id: string, owner: Owner): EncryptedRecord {
  const row = value as EncryptedRecord | undefined
  if (!row || row.id !== id || row.ownerId !== owner.ownerId ||
      row.incarnation !== owner.incarnation || !integer(row.generation, Number.MAX_SAFE_INTEGER) ||
      row.generation === 0 || !(row.iv instanceof ArrayBuffer) || row.iv.byteLength !== 12 ||
      !(row.ciphertext instanceof ArrayBuffer) || row.ciphertext.byteLength < 28 ||
      row.ciphertext.byteLength > MAX_ENCODED + 16) fail('corrupt')
  return row
}
function aad(id: string, incarnation: string, generation: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(['kodera-confidential-local-v1', id, incarnation, generation]))
}
function encode(state: OpaqueLocalState): Uint8Array<ArrayBuffer> {
  if (!state || !(state.checkpoint instanceof Uint8Array) ||
      !(state.checkpoint.buffer instanceof ArrayBuffer) || !Array.isArray(state.pendingSends)) fail('invalid-input')
  if (state.checkpoint.byteLength > LOCAL_STATE_LIMITS.checkpointBytes ||
      state.pendingSends.length > LOCAL_STATE_LIMITS.pendingCount) fail('capacity')
  const ids = new Set<string>()
  let pendingBytes = 0
  for (const item of state.pendingSends) {
    if (!item || typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id) ||
        !(item.ciphertext instanceof Uint8Array) ||
        !(item.ciphertext.buffer instanceof ArrayBuffer)) fail('invalid-input')
    ids.add(item.id)
    pendingBytes += item.ciphertext.byteLength
    if (item.ciphertext.byteLength > LOCAL_STATE_LIMITS.pendingItemBytes ||
        pendingBytes > LOCAL_STATE_LIMITS.pendingBytes) fail('capacity')
  }
  const output = new Uint8Array(12 + state.checkpoint.byteLength + state.pendingSends.length * 40 + pendingBytes)
  const view = new DataView(output.buffer)
  output.set(MAGIC)
  view.setUint32(4, state.checkpoint.byteLength)
  view.setUint32(8, state.pendingSends.length)
  output.set(state.checkpoint, 12)
  let offset = 12 + state.checkpoint.byteLength
  for (const item of state.pendingSends) {
    output.set(new TextEncoder().encode(item.id), offset); offset += 36
    view.setUint32(offset, item.ciphertext.byteLength); offset += 4
    output.set(item.ciphertext, offset); offset += item.ciphertext.byteLength
  }
  return output
}
function decode(bytes: Uint8Array<ArrayBuffer>): OpaqueLocalState {
  if (bytes.length < 12 || bytes.length > MAX_ENCODED || !MAGIC.every((b, i) => bytes[i] === b)) fail('corrupt')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const checkpointLength = view.getUint32(4), count = view.getUint32(8)
  if (checkpointLength > LOCAL_STATE_LIMITS.checkpointBytes || count > LOCAL_STATE_LIMITS.pendingCount ||
      checkpointLength + 12 > bytes.length) fail('corrupt')
  let offset = 12 + checkpointLength, total = 0
  const pendingSends: PendingCiphertext[] = [], ids = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (offset + 40 > bytes.length) fail('corrupt')
    const id = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + 36))
    offset += 36
    const length = view.getUint32(offset); offset += 4; total += length
    if (!UUID.test(id) || ids.has(id) || length > LOCAL_STATE_LIMITS.pendingItemBytes ||
        total > LOCAL_STATE_LIMITS.pendingBytes || offset + length > bytes.length) fail('corrupt')
    ids.add(id); pendingSends.push({ id, ciphertext: bytes.slice(offset, offset + length) }); offset += length
  }
  if (offset !== bytes.length) fail('corrupt')
  return { checkpoint: bytes.slice(12, 12 + checkpointLength), pendingSends }
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(new ConfidentialStateError('storage'))
  })
}
function supported(): void {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues ||
      typeof CryptoKey === 'undefined' || !globalThis.isSecureContext) fail('unavailable')
}
function openDatabase(): Promise<IDBDatabase> {
  supported()
  return new Promise((resolve, reject) => {
    let refused = false
    const opening = indexedDB.open(CONFIDENTIAL_STATE_DATABASE, 1)
    const refuse = () => { refused = true; reject(new ConfidentialStateError('storage')) }
    opening.onerror = refuse
    opening.onblocked = refuse
    opening.onupgradeneeded = () => {
      const db = opening.result
      db.createObjectStore('owners', { keyPath: 'ownerId' })
      db.createObjectStore('records', { keyPath: 'id' }).createIndex('ownerId', 'ownerId')
      db.createObjectStore('metadata', { keyPath: 'id' }).put({ id: 'capacity', bytes: 0 })
    }
    opening.onsuccess = () => {
      const db = opening.result
      if (refused) { db.close(); return }
      db.onversionchange = () => db.close()
      if (!STORES.every((name) => db.objectStoreNames.contains(name))) { db.close(); refuse(); return }
      resolve(db)
    }
  })
}
async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode,
  operation: (tx: IDBTransaction) => Promise<T>, alive: () => void = () => {},
  tracked?: Set<IDBTransaction>): Promise<T> {
  alive()
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = mode === 'readwrite'
        ? db.transaction([...STORES], mode, { durability: 'strict' })
        : db.transaction([...STORES], mode)
    } catch (error) {
      const unsupported = mode === 'readwrite' && (error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'NotSupportedError'))
      reject(new ConfidentialStateError(unsupported ? 'unavailable' : 'storage')); return
    }
    if (mode === 'readwrite' && tx.durability !== 'strict') {
      // Unsupported or ignored options must never become a weaker write fallback.
      try { tx.abort() } catch { /* No operation has been invoked. */ }
      reject(new ConfidentialStateError('unavailable')); return
    }
    tracked?.add(tx)
    let result: T, done = false, failure: unknown
    tx.oncomplete = () => {
      tracked?.delete(tx)
      try { alive(); if (!done) fail('storage'); resolve(result) } catch (error) { reject(safeError(error)) }
    }
    tx.onabort = () => { tracked?.delete(tx); reject(safeError(failure)) }
    tx.onerror = () => { /* Request errors abort the complete transaction. */ }
    operation(tx).then((value) => { result = value; done = true }).catch((error: unknown) => {
      failure = error
      try { tx.abort() } catch { reject(safeError(error)) }
    })
  })
}

export class ConfidentialStateStore {
  readonly #db: IDBDatabase
  readonly #owner: Owner
  readonly #transactions = new Set<IDBTransaction>()
  #closed = false
  /** Use initializeConfidentialState/openConfidentialState; the constructor is not an authority grant. */
  private constructor(db: IDBDatabase, owner: Owner) {
    this.#db = db; this.#owner = owner
    db.onversionchange = () => this.close()
  }
  static async open(owner: string, initialize: boolean): Promise<ConfidentialStateStore> {
    ownerId(owner)
    const db = await openDatabase()
    try {
      const lookup = async (tx: IDBTransaction): Promise<Owner | undefined> => {
        const existing: unknown = await request(tx.objectStore('owners').get(owner))
        if (existing !== undefined) {
          const current = readOwner(existing)
          if (current.ownerId !== owner) fail('corrupt')
          return current
        }
        // Header loss must not silently replace the key over surviving ciphertext.
        const surviving = await request(tx.objectStore('records').index('ownerId').count(owner))
        if (surviving !== 0) fail('corrupt')
        return undefined
      }
      const prior = await transaction(db, 'readonly', lookup)
      if (prior !== undefined) return new ConfidentialStateStore(db, prior)
      if (!initialize) fail('not-initialized')
      let key: CryptoKey
      // Outside a transaction: awaiting WebCrypto inside IDB would let it expire.
      try { key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) }
      catch { fail('unavailable') }
      const result = await transaction(db, 'readwrite', async (tx) => {
        const existing = await lookup(tx)
        if (existing !== undefined) return existing
        const owners = tx.objectStore('owners')
        if ((await request(owners.count())) >= LOCAL_STATE_LIMITS.lifetimeOwners) fail('capacity')
        if (!keyValid(key)) fail('unavailable')
        const next: Owner = { ownerId: owner, incarnation: crypto.randomUUID(), status: 'active', records: 0, bytes: 0, key }
        await request(owners.add(next))
        return next
      })
      return new ConfidentialStateStore(db, result)
    } catch (error) { db.close(); throw safeError(error) }
  }
  #alive = (): void => { if (this.#closed) fail('closed') }
  async #liveOwner(tx: IDBTransaction): Promise<Owner> {
    const current = readOwner(await request(tx.objectStore('owners').get(this.#owner.ownerId)))
    if (current.ownerId !== this.#owner.ownerId) fail('corrupt')
    if (current.incarnation !== this.#owner.incarnation) fail('owner-revoked')
    return current
  }
  async read(scope: ConfidentialScope): Promise<StateSnapshot | null> {
    this.#alive()
    const id = scopeKey(scope, this.#owner.ownerId)
    const loaded = await transaction(this.#db, 'readonly', async (tx) => {
      const owner = await this.#liveOwner(tx)
      const value: unknown = await request(tx.objectStore('records').get(id))
      return value === undefined ? null : record(value, id, owner)
    }, this.#alive, this.#transactions)
    this.#alive()
    if (loaded === null) return null
    let plaintext: Uint8Array<ArrayBuffer> | undefined
    try {
      if (!keyValid(this.#owner.key)) fail('corrupt')
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: loaded.iv,
        additionalData: aad(id, loaded.incarnation, loaded.generation) }, this.#owner.key, loaded.ciphertext)
      plaintext = new Uint8Array(clear)
      this.#alive()
      await transaction(this.#db, 'readonly', async (tx) => { await this.#liveOwner(tx) }, this.#alive, this.#transactions)
      this.#alive()
      return { ...decode(plaintext), generation: loaded.generation }
    } catch (error) {
      if (error instanceof ConfidentialStateError) throw error
      fail('corrupt')
    } finally { plaintext?.fill(0) }
  }
  async compareAndSwap(changes: readonly StateMutation[]): Promise<readonly number[]> {
    this.#alive()
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > LOCAL_STATE_LIMITS.batchCount) fail('invalid-input')
    // Snapshot every field and byte synchronously before the first async crypto call.
    // A caller mutating its input during encryption cannot change the committed generation.
    const staged: { id: string; expected: number; plaintext: Uint8Array<ArrayBuffer> }[] = []
    const prepared: Prepared[] = [], seen = new Set<string>()
    let total = 0
    try {
      for (const change of changes.slice()) {
        if (!change || !integer(change.expectedGeneration, Number.MAX_SAFE_INTEGER - 1)) fail('invalid-input')
        const id = scopeKey(change.scope, this.#owner.ownerId)
        if (seen.has(id)) fail('invalid-input')
        seen.add(id)
        const plaintext = encode(change.state)
        staged.push({ id, expected: change.expectedGeneration, plaintext })
        total += plaintext.byteLength + 16
        if (total > LOCAL_STATE_LIMITS.ownerBytes) fail('capacity')
      }
      for (const item of staged) {
        const next = item.expected + 1
        const iv = crypto.getRandomValues(new Uint8Array(12))
        if (!keyValid(this.#owner.key)) fail('corrupt')
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
          additionalData: aad(item.id, this.#owner.incarnation, next) }, this.#owner.key, item.plaintext)
        this.#alive()
        prepared.push({ id: item.id, expected: item.expected,
          record: { id: item.id, ownerId: this.#owner.ownerId, incarnation: this.#owner.incarnation,
            generation: next, iv: iv.buffer, ciphertext } })
      }
    } catch (error) { throw safeError(error) }
    finally { for (const item of staged) item.plaintext.fill(0) }
    return transaction(this.#db, 'readwrite', async (tx) => {
      const owner = await this.#liveOwner(tx)
      const meta = capacity(await request(tx.objectStore('metadata').get('capacity')))
      const records = tx.objectStore('records')
      let count = owner.records, bytes = owner.bytes
      for (const item of prepared) {
        const previous: unknown = await request(records.get(item.id))
        if (previous === undefined) {
          if (item.expected !== 0) fail('conflict')
          count++
        } else {
          const old = record(previous, item.id, owner)
          if (old.generation !== item.expected) fail('conflict')
          bytes -= old.ciphertext.byteLength
        }
        bytes += item.record.ciphertext.byteLength
      }
      const allBytes = meta.bytes - owner.bytes + bytes
      if (!integer(count, LOCAL_STATE_LIMITS.ownerRecords) || !integer(bytes, LOCAL_STATE_LIMITS.ownerBytes) ||
          !integer(allBytes, LOCAL_STATE_LIMITS.databaseBytes)) fail('capacity')
      for (const item of prepared) await request(records.put(item.record))
      await request(tx.objectStore('owners').put({ ...owner, records: count, bytes }))
      await request(tx.objectStore('metadata').put({ id: 'capacity', bytes: allBytes }))
      return prepared.map((item) => item.record.generation)
    }, this.#alive, this.#transactions)
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const tx of this.#transactions) { try { tx.abort() } catch { /* Already committed. */ } }
    this.#transactions.clear(); this.#db.close(); delete this.#owner.key
  }
}
export function initializeConfidentialState(owner: string): Promise<ConfidentialStateStore> {
  return ConfidentialStateStore.open(owner, true)
}
export function openConfidentialState(owner: string): Promise<ConfidentialStateStore> {
  return ConfidentialStateStore.open(owner, false)
}
export async function deleteConfidentialOwner(owner: string): Promise<void> {
  ownerId(owner)
  const db = await openDatabase()
  try {
    await transaction(db, 'readwrite', async (tx) => {
      const owners = tx.objectStore('owners'), records = tx.objectStore('records')
      const value: unknown = await request(owners.get(owner))
      if (value === undefined && (await request(owners.count())) >= LOCAL_STATE_LIMITS.lifetimeOwners) fail('capacity')
      const current = value === undefined ? undefined : ownerHeader(value)
      if (current !== undefined && current.ownerId !== owner) fail('corrupt')
      if (current?.status === 'revoked' && (current.records !== 0 || current.bytes !== 0)) fail('corrupt')
      const meta = capacity(await request(tx.objectStore('metadata').get('capacity')))
      let actualBytes = 0, actualCount = 0
      // Include tombstones: success means no surviving rows or key, not merely
      // that a previous header said deletion had happened.
      await new Promise<void>((resolve, reject) => {
        const cursor = records.index('ownerId').openCursor(IDBKeyRange.only(owner))
        cursor.onerror = () => reject(new ConfidentialStateError('storage'))
        cursor.onsuccess = () => {
          try {
            const row = cursor.result
            if (row === null) { resolve(); return }
            if (typeof row.primaryKey !== 'string' || row.primaryKey.length > 256) fail('corrupt')
            const parts: unknown = JSON.parse(row.primaryKey)
            if (!Array.isArray(parts) || parts.length !== 6) fail('corrupt')
            const storedScope = { ownerId: parts[0], organisationId: parts[1], membershipId: parts[2],
              devicePublicKey: parts[3], kind: parts[4], ...(parts[4] === 'room' ? { roomId: parts[5] } : {}) } as ConfidentialScope
            if (scopeKey(storedScope, owner) !== row.primaryKey) fail('corrupt')
            const candidate = row.value as EncryptedRecord
            if (typeof candidate.incarnation !== 'string' || !UUID.test(candidate.incarnation)) fail('corrupt')
            const binding: Owner = current?.status === 'active' ? current : { ownerId: owner, incarnation: candidate.incarnation,
              status: 'active', records: 0, bytes: 0 }
            const valid = record(candidate, row.primaryKey, binding)
            actualCount++; actualBytes += valid.ciphertext.byteLength
            if (actualCount > LOCAL_STATE_LIMITS.ownerRecords || actualBytes > LOCAL_STATE_LIMITS.ownerBytes) fail('corrupt')
            row.delete(); row.continue()
          } catch { reject(new ConfidentialStateError('corrupt')) }
        }
      })
      if (current?.status === 'active' &&
          (current.records !== actualCount || current.bytes !== actualBytes)) fail('corrupt')
      const bytes = meta.bytes - actualBytes
      if (!integer(bytes, LOCAL_STATE_LIMITS.databaseBytes)) fail('corrupt')
      await request(owners.put({ ownerId: owner, incarnation: current?.incarnation ?? crypto.randomUUID(),
        status: 'revoked', records: 0, bytes: 0 }))
      await request(tx.objectStore('metadata').put({ id: 'capacity', bytes }))
    })
  } finally { db.close() }
}
