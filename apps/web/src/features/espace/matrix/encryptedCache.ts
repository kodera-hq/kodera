// Encrypted device vault for Espace cold-start hydration, composer drafts, server-revalidated
// offline outbox, and persistent confidential room quarantine (`kodera.espace-vault.v1`).
//
// Each `(ownerId, organisationId, membershipId, deviceId)` principal receives an isolated
// non-extractable 256-bit `AES-GCM` `CryptoKey` stored via structured clone in `'owners'`
// alongside a random `incarnation` UUID. Every ciphertext binds:
//   `['kodera-espace-vault-v1', ownerId, organisationId, membershipId, deviceId, incarnation, kind, roomId, verifiedBoundary]`
// as authenticated `additionalData` with a fresh 96-bit random IV, committed with
// `{ durability: 'strict' }`. Legacy plaintext `'kodera-espace-timelines'` is deleted on open
// and on every cryptographic wipe boundary.

import {
  ESPACE_TIMELINE_DATABASE,
  ESPACE_VAULT_DATABASE as SESSION_VAULT_DATABASE,
  ESPACE_VAULT_REALM_ID,
  espaceVaultWipeChannelName,
  registerEspaceVaultCleanup,
  registerLocalSessionCleanup,
} from '@/auth/localSession'
import { getMatrixSession, subscribeMatrixSession } from '@/auth/matrix'
import { permitsPlaintext, type RoomBoundary } from '../../confidential/room-boundary'
import { serverNameOf } from '../homeserver'
import type { MessageView } from './timeline'
import { CACHE_WRITE_DELAY_MS, CACHED_MESSAGES, isCachedMessage, MAX_AGE_MS } from './timelineCache'

export const ESPACE_VAULT_DATABASE = SESSION_VAULT_DATABASE
export const ESPACE_VAULT_DB_VERSION = 2
export const LEGACY_TIMELINE_DATABASE = ESPACE_TIMELINE_DATABASE
export const VAULT_AAD_TAG = 'kodera-espace-vault-v1'
export const LOCAL_FTS_HMAC_DOMAIN = 'kodera-local-fts-v1'
export const VAULT_STORES = [
  'owners',
  'rooms',
  'outbox',
  'drafts',
  'quarantine',
  'search_index',
] as const

export const MAX_OUTBOX_ITEMS = 32
export const MAX_OUTBOX_BODY_BYTES = 64 * 1024
export const MAX_DRAFT_CHARS = 65_536
export const MAX_DRAFT_ROOMS = 64
export const MAX_SEARCH_SHARD_BYTES = 512 * 1024
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024
const SIDEBAR_ROOM_SENTINEL = '*'

export type VerifiedPlaintextBoundary = 'ordinary' | 'community'
export type SearchBoundaryTag = VerifiedPlaintextBoundary | 'confidential-e2ee'
export type VaultRecordKind = 'room' | 'sidebar' | 'outbox' | 'draft'
export type EspaceVaultFailure =
  | 'unavailable'
  | 'closed'
  | 'owner-revoked'
  | 'not-initialized'
  | 'capacity'
  | 'quarantined'
  | 'invalid-input'
  | 'corrupt'
  | 'storage'

export class EspaceVaultError extends Error {
  constructor(readonly code: EspaceVaultFailure) {
    super(code)
    this.name = 'EspaceVaultError'
  }
}

function fail(code: EspaceVaultFailure): never {
  throw new EspaceVaultError(code)
}

function safeVaultError(error: unknown): EspaceVaultError {
  return error instanceof EspaceVaultError ? error : new EspaceVaultError('storage')
}

export interface EspaceVaultPrincipal {
  readonly ownerId: string
  readonly organisationId: string
  readonly membershipId: string
  readonly deviceId: string
}

export interface CachedRoomSummary {
  readonly roomId: string
  readonly name: string
  readonly alias: string | null
  readonly verifiedBoundary: VerifiedPlaintextBoundary
  readonly kind: 'text' | 'audio'
  readonly unread: number
  readonly mentions: number
  readonly joined?: number | undefined
}

export interface VaultRoomPayload {
  readonly v: 1
  readonly roomId: string
  readonly verifiedBoundary: VerifiedPlaintextBoundary
  readonly savedAt: number
  readonly summary?: CachedRoomSummary | undefined
  readonly channelIds?: readonly string[] | undefined
  readonly messages: readonly MessageView[]
}

export interface VaultSidebarPayload {
  readonly v: 1
  readonly savedAt: number
  readonly rooms: readonly CachedRoomSummary[]
  readonly channels: readonly (readonly [string, string])[]
}

export interface VaultOutboxPayload {
  readonly v: 1
  readonly clientTxnId: string
  readonly roomId: string
  readonly channelId?: string | undefined
  readonly verifiedBoundary: VerifiedPlaintextBoundary
  readonly expectedEpoch: 0
  readonly queuedAt: number
  readonly notBefore?: number | undefined
  readonly body: string
  readonly content: Record<string, unknown>
}

export interface VaultDraftPayload {
  readonly v: 1
  readonly roomId: string
  readonly verifiedBoundary: VerifiedPlaintextBoundary
  readonly savedAt: number
  readonly text: string
  readonly threadText: string
}

export interface QuarantineMarkerRow {
  readonly id: string
  readonly ownerKey: string
  readonly roomId: string
  readonly markedAt: number
}

export interface ColdStartHydration {
  readonly quarantined: ReadonlySet<string>
  readonly sidebar: VaultSidebarPayload | null
  readonly activeRoom: VaultRoomPayload | null
  readonly outbox: readonly VaultOutboxPayload[]
}

interface VaultOwnerRow {
  readonly ownerKey: string
  readonly ownerId: string
  readonly organisationId: string
  readonly membershipId: string
  readonly deviceId: string
  readonly incarnation: string
  // Owner metadata is the durable purge fence, shared by independent tab coordinators.
  readonly purgeEpoch?: number
  readonly status: 'active' | 'revoked'
  key?: CryptoKey | undefined
  indexKey?: CryptoKey | undefined
}

export interface EncryptedSearchIndexRow {
  readonly id: string
  readonly ownerKey: string
  readonly ownerRoom: string
  readonly incarnation: string
  readonly roomId: string
  readonly boundaryTag: SearchBoundaryTag
  readonly epoch: number
  readonly savedAt: number
  readonly iv: ArrayBuffer
  readonly ciphertext: ArrayBuffer
}

type SearchEvictionListener = (event: {
  readonly kind: 'room' | 'all'
  readonly ownerKey?: string | undefined
  readonly roomId?: string | undefined
}) => void

const searchEvictionListeners = new Set<SearchEvictionListener>()

export function registerVaultSearchEviction(listener: SearchEvictionListener): () => void {
  searchEvictionListeners.add(listener)
  return () => {
    searchEvictionListeners.delete(listener)
  }
}

export function emitVaultSearchRoomEviction(roomId: string, ownerKey?: string): void {
  notifyVaultSearchEviction({ kind: 'room', ownerKey, roomId })
}

function notifyVaultSearchEviction(event: {
  readonly kind: 'room' | 'all'
  readonly ownerKey?: string | undefined
  readonly roomId?: string | undefined
}): void {
  for (const listener of [...searchEvictionListeners]) {
    try {
      listener(event)
    } catch {
      // Eviction listeners must never block vault security operations.
    }
  }
}

interface EncryptedVaultRow {
  readonly id: string
  readonly ownerKey: string
  readonly incarnation: string
  readonly kind: VaultRecordKind
  readonly roomId: string
  readonly verifiedBoundary: VerifiedPlaintextBoundary
  readonly savedAt: number
  readonly iv: ArrayBuffer
  readonly ciphertext: ArrayBuffer
}

/** Compare persisted ciphertext snapshots without expanding their bytes into JSON. */
function sameVaultRows(before: readonly unknown[], after: readonly unknown[]): boolean {
  if (before.length !== after.length) return false
  const sameBytes = (a: ArrayBuffer | undefined, b: ArrayBuffer | undefined) => {
    if (!a || !b) return a === b
    if (a.byteLength !== b.byteLength) return false
    const right = new Uint8Array(b)
    return new Uint8Array(a).every((value, index) => value === right[index])
  }
  return before.every((raw, index) => {
    const current = after[index]
    if (!raw || typeof raw !== 'object' || !current || typeof current !== 'object') {
      return raw === current
    }
    const left = raw as Partial<EncryptedVaultRow>
    const right = current as Partial<EncryptedVaultRow>
    return (
      (
        ['id', 'ownerKey', 'incarnation', 'kind', 'roomId', 'verifiedBoundary', 'savedAt'] as const
      ).every((field) => left[field] === right[field]) &&
      sameBytes(left.iv, right.iv) &&
      sameBytes(left.ciphertext, right.ciphertext)
    )
  })
}

function sameSearchRows(before: readonly unknown[], after: readonly unknown[]): boolean {
  if (before.length !== after.length) return false
  const sameBytes = (a: ArrayBuffer | undefined, b: ArrayBuffer | undefined) => {
    if (!a || !b) return a === b
    if (a.byteLength !== b.byteLength) return false
    const right = new Uint8Array(b)
    return new Uint8Array(a).every((value, index) => value === right[index])
  }
  return before.every((raw, index) => {
    const current = after[index]
    if (!raw || typeof raw !== 'object' || !current || typeof current !== 'object') {
      return raw === current
    }
    const left = raw as Partial<EncryptedSearchIndexRow>
    const right = current as Partial<EncryptedSearchIndexRow>
    return (
      (
        [
          'id',
          'ownerKey',
          'ownerRoom',
          'incarnation',
          'roomId',
          'boundaryTag',
          'epoch',
          'savedAt',
        ] as const
      ).every((field) => left[field] === right[field]) &&
      sameBytes(left.iv, right.iv) &&
      sameBytes(left.ciphertext, right.ciphertext)
    )
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function nonEmptyField(value: unknown, maxLen = 256): string {
  if (typeof value !== 'string') fail('invalid-input')
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLen) fail('invalid-input')
  return trimmed
}

export function isVerifiedPlaintextBoundary(
  boundary: RoomBoundary | undefined
): boundary is VerifiedPlaintextBoundary {
  return boundary !== undefined && permitsPlaintext(boundary)
}

export function normalizeVaultPrincipal(input: EspaceVaultPrincipal): EspaceVaultPrincipal {
  if (!input || typeof input !== 'object') fail('invalid-input')
  return {
    ownerId: nonEmptyField(input.ownerId),
    organisationId: nonEmptyField(input.organisationId),
    membershipId: nonEmptyField(input.membershipId),
    deviceId: nonEmptyField(input.deviceId),
  }
}

export function resolveSessionVaultPrincipal(
  session: {
    readonly baseUrl: string
    readonly userId: string
    readonly deviceId: string
    readonly ownerId?: string | undefined
    readonly organisationId?: string | undefined
    readonly membershipId?: string | undefined
  },
  partial?: Partial<EspaceVaultPrincipal> | undefined
): EspaceVaultPrincipal | null {
  const ownerId = (partial?.ownerId ?? session.ownerId ?? session.userId).trim()
  const organisationId = (
    partial?.organisationId ??
    session.organisationId ??
    serverNameOf(session.userId) ??
    session.baseUrl
  ).trim()
  const membershipId = (
    partial?.membershipId ??
    session.membershipId ??
    `${session.userId}@${session.baseUrl}`
  ).trim()
  const deviceId = (partial?.deviceId ?? session.deviceId).trim()
  if (!ownerId || !organisationId || !membershipId || !deviceId) return null
  return { ownerId, organisationId, membershipId, deviceId }
}

export function principalOwnerKey(principal: EspaceVaultPrincipal): string {
  const p = normalizeVaultPrincipal(principal)
  return JSON.stringify([p.ownerId, p.organisationId, p.membershipId, p.deviceId])
}

function recordId(
  ownerKey: string,
  kind: VaultRecordKind | 'quarantine' | 'search-index',
  target: string
): string {
  return JSON.stringify([ownerKey, kind, target])
}

function ownerRoomKey(ownerKey: string, roomId: string): string {
  return JSON.stringify([ownerKey, roomId])
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  )
}

function keyValid(key: unknown): key is CryptoKey {
  return (
    typeof CryptoKey !== 'undefined' &&
    key instanceof CryptoKey &&
    key.type === 'secret' &&
    !key.extractable &&
    key.algorithm.name === 'AES-GCM' &&
    (key.algorithm as AesKeyAlgorithm).length === 256 &&
    key.usages.length === 2 &&
    key.usages.includes('encrypt') &&
    key.usages.includes('decrypt')
  )
}

function indexKeyValid(key: unknown): key is CryptoKey {
  return (
    typeof CryptoKey !== 'undefined' &&
    key instanceof CryptoKey &&
    key.type === 'secret' &&
    !key.extractable &&
    key.algorithm.name === 'HMAC' &&
    (key.algorithm as HmacKeyAlgorithm).hash?.name === 'SHA-256' &&
    key.usages.length === 1 &&
    key.usages.includes('sign')
  )
}

export function buildVaultAad(
  principal: EspaceVaultPrincipal,
  incarnation: string,
  kind: VaultRecordKind,
  roomId: string,
  verifiedBoundary: VerifiedPlaintextBoundary
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      VAULT_AAD_TAG,
      principal.ownerId,
      principal.organisationId,
      principal.membershipId,
      principal.deviceId,
      incarnation,
      kind,
      roomId,
      verifiedBoundary,
    ])
  )
}

export function buildSearchIndexAad(
  principal: EspaceVaultPrincipal,
  incarnation: string,
  roomId: string,
  boundaryTag: SearchBoundaryTag,
  epoch: number
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      VAULT_AAD_TAG,
      principal.ownerId,
      principal.organisationId,
      principal.membershipId,
      principal.deviceId,
      incarnation,
      'search-index',
      roomId,
      boundaryTag,
      epoch,
    ])
  )
}

function validateOwnerHeader(value: unknown, expectedKey: string): VaultOwnerRow {
  if (!value || typeof value !== 'object') fail('not-initialized')
  const row = value as VaultOwnerRow
  if (
    row.ownerKey !== expectedKey ||
    typeof row.ownerId !== 'string' ||
    typeof row.organisationId !== 'string' ||
    typeof row.membershipId !== 'string' ||
    typeof row.deviceId !== 'string' ||
    typeof row.incarnation !== 'string' ||
    !UUID_RE.test(row.incarnation) ||
    (row.status !== 'active' && row.status !== 'revoked')
  ) {
    fail('corrupt')
  }
  return row
}

function readActiveOwner(
  value: unknown,
  expectedKey: string,
  options: { readonly allowMissingIndexKey?: boolean } = {}
): VaultOwnerRow {
  const row = validateOwnerHeader(value, expectedKey)
  if (row.status === 'revoked') fail('owner-revoked')
  if (!keyValid(row.key)) fail('corrupt')
  if (row.indexKey === undefined) {
    if (!options.allowMissingIndexKey) fail('corrupt')
  } else if (!indexKeyValid(row.indexKey)) {
    fail('corrupt')
  }
  return row
}

function isValidSearchBoundaryTag(value: unknown): value is SearchBoundaryTag {
  return value === 'ordinary' || value === 'community' || value === 'confidential-e2ee'
}

function validateSearchIndexRow(
  value: unknown,
  expectedId: string,
  owner: VaultOwnerRow,
  expectedRoomId: string
): EncryptedSearchIndexRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as EncryptedSearchIndexRow
  if (
    row.id !== expectedId ||
    row.ownerKey !== owner.ownerKey ||
    row.ownerRoom !== ownerRoomKey(owner.ownerKey, expectedRoomId) ||
    row.incarnation !== owner.incarnation ||
    row.roomId !== expectedRoomId ||
    !isValidSearchBoundaryTag(row.boundaryTag) ||
    typeof row.epoch !== 'number' ||
    !Number.isInteger(row.epoch) ||
    row.epoch < 0 ||
    (row.boundaryTag !== 'confidential-e2ee' && row.epoch !== 0) ||
    typeof row.savedAt !== 'number' ||
    !Number.isFinite(row.savedAt) ||
    !isArrayBuffer(row.iv) ||
    row.iv.byteLength !== 12 ||
    !isArrayBuffer(row.ciphertext) ||
    row.ciphertext.byteLength < 18 ||
    row.ciphertext.byteLength > MAX_SEARCH_SHARD_BYTES + 1024
  ) {
    return null
  }
  return row
}

async function generateVaultAesKey(): Promise<CryptoKey> {
  let key: CryptoKey
  try {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])
  } catch {
    fail('unavailable')
  }
  if (!keyValid(key)) fail('unavailable')
  return key
}

async function generateVaultIndexKey(): Promise<CryptoKey> {
  let indexKey: CryptoKey
  try {
    indexKey = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    )
  } catch {
    fail('unavailable')
  }
  if (!indexKeyValid(indexKey)) fail('unavailable')
  return indexKey
}

function validateEncryptedRow(
  value: unknown,
  expectedId: string,
  owner: VaultOwnerRow,
  expectedKind: VaultRecordKind
): EncryptedVaultRow | null {
  if (!value || typeof value !== 'object') return null
  const row = value as EncryptedVaultRow
  if (
    row.id !== expectedId ||
    row.ownerKey !== owner.ownerKey ||
    row.incarnation !== owner.incarnation ||
    row.kind !== expectedKind ||
    typeof row.roomId !== 'string' ||
    row.roomId.length === 0 ||
    (row.verifiedBoundary !== 'ordinary' && row.verifiedBoundary !== 'community') ||
    typeof row.savedAt !== 'number' ||
    !Number.isFinite(row.savedAt) ||
    !isArrayBuffer(row.iv) ||
    row.iv.byteLength !== 12 ||
    !isArrayBuffer(row.ciphertext) ||
    row.ciphertext.byteLength < 18 ||
    row.ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
  ) {
    return null
  }
  return row
}

function isValidCachedSummary(value: unknown): value is CachedRoomSummary {
  if (!value || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return (
    typeof s.roomId === 'string' &&
    s.roomId.length > 0 &&
    typeof s.name === 'string' &&
    (s.alias === null || typeof s.alias === 'string') &&
    (s.verifiedBoundary === 'ordinary' || s.verifiedBoundary === 'community') &&
    (s.kind === 'text' || s.kind === 'audio') &&
    typeof s.unread === 'number' &&
    Number.isFinite(s.unread) &&
    typeof s.mentions === 'number' &&
    Number.isFinite(s.mentions) &&
    (s.joined === undefined || (typeof s.joined === 'number' && Number.isFinite(s.joined)))
  )
}

function cloneSentMessages(messages: readonly MessageView[], limit: number): MessageView[] {
  const sent = messages.filter((message) => message.delivery === 'sent')
  return sent.slice(Math.max(0, sent.length - limit)).map((message) => ({
    ...message,
    ...(message.mentionedUsers === undefined
      ? {}
      : { mentionedUsers: [...message.mentionedUsers] }),
    ...(message.mentionPills === undefined
      ? {}
      : { mentionPills: message.mentionPills.map((pill) => ({ ...pill })) }),
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments.map((att) => ({ ...att })) }),
    reactions: message.reactions.map((reaction) => ({ ...reaction })),
  }))
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new EspaceVaultError('storage'))
  })
}

export function vaultSupported(idb: IDBFactory | undefined = globalThis.indexedDB): boolean {
  return (
    idb !== undefined &&
    typeof idb.open === 'function' &&
    Boolean(globalThis.crypto?.subtle) &&
    Boolean(globalThis.crypto?.getRandomValues) &&
    typeof CryptoKey !== 'undefined' &&
    globalThis.isSecureContext !== false
  )
}

export function deleteLegacyPlaintextTimelineDb(
  idb: IDBFactory | undefined = globalThis.indexedDB
): void {
  try {
    if (idb !== undefined && typeof idb.deleteDatabase === 'function') {
      idb.deleteDatabase(LEGACY_TIMELINE_DATABASE)
    }
  } catch {
    // Ignore restricted IndexedDB environments.
  }
}

function openVaultDatabase(
  idb: IDBFactory,
  options: { readonly createIfMissing?: boolean } = {}
): Promise<IDBDatabase | null> {
  if (!vaultSupported(idb)) fail('unavailable')
  const createIfMissing = options.createIfMissing !== false
  return new Promise((resolve, reject) => {
    let refused = false
    let absentAborted = false
    const opening = idb.open(ESPACE_VAULT_DATABASE, ESPACE_VAULT_DB_VERSION)
    const refuse = () => {
      refused = true
      reject(new EspaceVaultError('storage'))
    }
    opening.onerror = () => {
      if (absentAborted) {
        resolve(null)
        return
      }
      refuse()
    }
    opening.onblocked = refuse
    opening.onupgradeneeded = () => {
      const db = opening.result
      if (!createIfMissing && !db.objectStoreNames.contains('owners')) {
        absentAborted = true
        try {
          opening.transaction?.abort()
        } catch {
          // Aborting upgrade prevents creating an empty database during wipe.
        }
        return
      }
      if (!db.objectStoreNames.contains('owners')) {
        db.createObjectStore('owners', { keyPath: 'ownerKey' })
      }
      for (const storeName of ['rooms', 'outbox', 'drafts', 'quarantine'] as const) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' }).createIndex('ownerKey', 'ownerKey')
        }
      }
      if (!db.objectStoreNames.contains('search_index')) {
        const searchStore = db.createObjectStore('search_index', { keyPath: 'id' })
        searchStore.createIndex('ownerKey', 'ownerKey')
        searchStore.createIndex('ownerRoom', 'ownerRoom')
      }
    }
    opening.onsuccess = () => {
      const db = opening.result
      if (absentAborted) {
        db.close()
        resolve(null)
        return
      }
      if (refused) {
        db.close()
        return
      }
      if (!VAULT_STORES.every((name) => db.objectStoreNames.contains(name))) {
        db.close()
        refuse()
        return
      }
      resolve(db)
    }
  })
}

async function runVaultTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (tx: IDBTransaction) => Promise<T>,
  alive: () => void = () => {},
  tracked?: Set<IDBTransaction>
): Promise<T> {
  alive()
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx =
        mode === 'readwrite'
          ? db.transaction([...VAULT_STORES], mode, { durability: 'strict' })
          : db.transaction([...VAULT_STORES], mode)
    } catch (error) {
      const unsupported =
        mode === 'readwrite' &&
        (error instanceof TypeError ||
          (typeof DOMException !== 'undefined' &&
            error instanceof DOMException &&
            error.name === 'NotSupportedError'))
      reject(new EspaceVaultError(unsupported ? 'unavailable' : 'storage'))
      return
    }
    if (mode === 'readwrite' && tx.durability !== 'strict') {
      try {
        tx.abort()
      } catch {
        // Transaction has not invoked any request yet.
      }
      reject(new EspaceVaultError('unavailable'))
      return
    }
    tracked?.add(tx)
    let result!: T
    let done = false
    let failure: unknown
    tx.oncomplete = () => {
      tracked?.delete(tx)
      try {
        alive()
        if (!done) fail('storage')
        resolve(result)
      } catch (error) {
        reject(safeVaultError(error))
      }
    }
    tx.onabort = () => {
      tracked?.delete(tx)
      reject(safeVaultError(failure))
    }
    tx.onerror = () => {
      // Request failure aborts the enclosing transaction.
    }
    operation(tx)
      .then((value) => {
        result = value
        done = true
      })
      .catch((error: unknown) => {
        failure = error
        try {
          tx.abort()
        } catch {
          reject(safeVaultError(error))
        }
      })
  })
}

const openVaultInstances = new Set<EspaceVault>()

interface CoordinatedOwnerEntry {
  owner: VaultOwnerRow
  refCount: number
}

/**
 * Per-`(IDBFactory, dbName)` coordinator: serializes all vault mutations, key rotations, and
 * snapshot reads via a strict FIFO async mutex (`runExclusive`), and refcounts open handles per
 * `ownerKey` so closing one handle never zeros a surviving peer handle's `CryptoKey`.
 */
class VaultCoordinator {
  #tail: Promise<void> = Promise.resolve()
  readonly owners = new Map<string, CoordinatedOwnerEntry>()

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn)
    this.#tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  retainOwner(owner: VaultOwnerRow): VaultOwnerRow {
    const existing = this.owners.get(owner.ownerKey)
    if (
      existing !== undefined &&
      existing.owner.incarnation === owner.incarnation &&
      keyValid(existing.owner.key) &&
      indexKeyValid(existing.owner.indexKey)
    ) {
      existing.refCount += 1
      return existing.owner
    }
    const copy: VaultOwnerRow = { ...owner }
    const refCount = (existing?.refCount ?? 0) + 1
    if (existing !== undefined) {
      delete existing.owner.key
      delete existing.owner.indexKey
    }
    this.owners.set(owner.ownerKey, { owner: copy, refCount })
    return copy
  }

  updateOwner(nextOwner: VaultOwnerRow): VaultOwnerRow {
    const copy: VaultOwnerRow = { ...nextOwner }
    const existing = this.owners.get(nextOwner.ownerKey)
    if (existing !== undefined) {
      delete existing.owner.key
      delete existing.owner.indexKey
      existing.owner = copy
    } else {
      this.owners.set(nextOwner.ownerKey, { owner: copy, refCount: 1 })
    }
    return copy
  }

  getOwner(ownerKey: string): VaultOwnerRow | undefined {
    return this.owners.get(ownerKey)?.owner
  }

  releaseOwner(ownerKey: string): void {
    const existing = this.owners.get(ownerKey)
    if (existing === undefined) return
    existing.refCount -= 1
    if (existing.refCount <= 0) {
      delete existing.owner.key
      delete existing.owner.indexKey
      this.owners.delete(ownerKey)
    }
  }

  revokeAll(): void {
    for (const entry of this.owners.values()) {
      delete entry.owner.key
      delete entry.owner.indexKey
    }
    this.owners.clear()
  }
}

const coordinatorsByIdb = new WeakMap<IDBFactory, Map<string, VaultCoordinator>>()
const fallbackCoordinators = new Map<string, VaultCoordinator>()

function getVaultCoordinator(
  idb: IDBFactory | undefined,
  dbName = ESPACE_VAULT_DATABASE
): VaultCoordinator {
  if (idb === undefined || typeof idb !== 'object') {
    let coord = fallbackCoordinators.get(dbName)
    if (coord === undefined) {
      coord = new VaultCoordinator()
      fallbackCoordinators.set(dbName, coord)
    }
    return coord
  }
  let byName = coordinatorsByIdb.get(idb)
  if (byName === undefined) {
    byName = new Map()
    coordinatorsByIdb.set(idb, byName)
  }
  let coord = byName.get(dbName)
  if (coord === undefined) {
    coord = new VaultCoordinator()
    byName.set(dbName, coord)
  }
  return coord
}

export interface OpenEspaceVaultOptions {
  readonly initialize?: boolean | undefined
  readonly idb?: IDBFactory | undefined
  readonly limit?: number | undefined
  readonly delayMs?: number | undefined
  readonly now?: (() => number) | undefined
}

interface PendingRoomWrite {
  readonly verifiedBoundary: VerifiedPlaintextBoundary
  readonly messages: readonly MessageView[]
  readonly summary?: CachedRoomSummary | undefined
  readonly channelIds?: readonly string[] | undefined
}

export class EspaceVault {
  readonly #db: IDBDatabase
  readonly #idb: IDBFactory
  readonly #coordinator: VaultCoordinator
  readonly #principal: EspaceVaultPrincipal
  readonly #ownerKey: string
  #cachedIncarnation: string
  readonly #limit: number
  readonly #delayMs: number
  readonly #now: () => number
  readonly #transactions = new Set<IDBTransaction>()
  readonly #pendingRooms = new Map<string, PendingRoomWrite>()
  #pendingSidebar: {
    readonly rooms: readonly CachedRoomSummary[]
    readonly channels: readonly (readonly [string, string])[]
  } | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #writing: Promise<void> = Promise.resolve()
  #releasedOwner = false
  #wiping = false
  #closed = false

  private constructor(
    db: IDBDatabase,
    idb: IDBFactory,
    coordinator: VaultCoordinator,
    principal: EspaceVaultPrincipal,
    owner: VaultOwnerRow,
    options: OpenEspaceVaultOptions
  ) {
    this.#db = db
    this.#idb = idb
    this.#coordinator = coordinator
    this.#principal = principal
    this.#ownerKey = owner.ownerKey
    const retained = coordinator.retainOwner(owner)
    this.#cachedIncarnation = retained.incarnation
    this.#limit = options.limit ?? CACHED_MESSAGES
    this.#delayMs = options.delayMs ?? CACHE_WRITE_DELAY_MS
    this.#now = options.now ?? Date.now
    db.onversionchange = () => {
      if (this.#wiping) {
        this.#db.close()
        return
      }
      this.closeImmediate()
    }
    openVaultInstances.add(this)
  }

  static async open(
    rawPrincipal: EspaceVaultPrincipal,
    options: OpenEspaceVaultOptions = {}
  ): Promise<EspaceVault> {
    const principal = normalizeVaultPrincipal(rawPrincipal)
    const ownerKey = principalOwnerKey(principal)
    const idb = options.idb ?? globalThis.indexedDB
    deleteLegacyPlaintextTimelineDb(idb)
    const coordinator = getVaultCoordinator(idb, ESPACE_VAULT_DATABASE)
    return coordinator.runExclusive(async () => {
      const db = await openVaultDatabase(idb, { createIfMissing: true })
      if (db === null) fail('unavailable')
      const initialize = options.initialize !== false
      try {
        const lookup = async (
          tx: IDBTransaction,
          lookupOpts: { readonly allowMissingIndexKey?: boolean } = {}
        ): Promise<VaultOwnerRow | undefined> => {
          const existing: unknown = await idbRequest(tx.objectStore('owners').get(ownerKey))
          if (existing !== undefined) {
            return readActiveOwner(existing, ownerKey, lookupOpts)
          }
          for (const storeName of ['rooms', 'outbox', 'drafts', 'search_index'] as const) {
            const surviving = await idbRequest(
              tx.objectStore(storeName).index('ownerKey').count(ownerKey)
            )
            if (surviving !== 0) fail('corrupt')
          }
          return undefined
        }
        const prior = await runVaultTx(db, 'readonly', (tx) =>
          lookup(tx, { allowMissingIndexKey: true })
        )
        if (prior !== undefined) {
          if (prior.indexKey === undefined) {
            const indexKey = await generateVaultIndexKey()
            const upgraded = await runVaultTx(db, 'readwrite', async (tx) => {
              const latest = await lookup(tx, { allowMissingIndexKey: true })
              if (latest === undefined) fail('corrupt')
              if (latest.indexKey !== undefined) return latest
              const next: VaultOwnerRow = { ...latest, indexKey }
              await idbRequest(tx.objectStore('owners').put(next))
              return next
            })
            return new EspaceVault(db, idb, coordinator, principal, upgraded, options)
          }
          return new EspaceVault(db, idb, coordinator, principal, prior, options)
        }
        if (!initialize) fail('not-initialized')

        const [key, indexKey] = await Promise.all([generateVaultAesKey(), generateVaultIndexKey()])

        const created = await runVaultTx(db, 'readwrite', async (tx) => {
          const existing = await lookup(tx, { allowMissingIndexKey: true })
          if (existing !== undefined) {
            if (existing.indexKey !== undefined) return existing
            const upgraded: VaultOwnerRow = { ...existing, indexKey }
            await idbRequest(tx.objectStore('owners').put(upgraded))
            return upgraded
          }
          const next: VaultOwnerRow = {
            ownerKey,
            ownerId: principal.ownerId,
            organisationId: principal.organisationId,
            membershipId: principal.membershipId,
            deviceId: principal.deviceId,
            incarnation: crypto.randomUUID(),
            status: 'active',
            key,
            indexKey,
          }
          await idbRequest(tx.objectStore('owners').add(next))
          return next
        })
        return new EspaceVault(db, idb, coordinator, principal, created, options)
      } catch (error) {
        db.close()
        throw safeVaultError(error)
      }
    })
  }

  get principal(): EspaceVaultPrincipal {
    return this.#principal
  }

  get ownerKey(): string {
    return this.#ownerKey
  }

  get incarnation(): string {
    const live = this.#coordinator.getOwner(this.#ownerKey)
    if (!this.#closed && live !== undefined) {
      this.#cachedIncarnation = live.incarnation
    }
    return this.#cachedIncarnation
  }

  get isClosed(): boolean {
    return this.#closed
  }

  #alive = (): void => {
    if (this.#closed) fail('closed')
  }

  #currentOwner(): VaultOwnerRow {
    this.#alive()
    const live = this.#coordinator.getOwner(this.#ownerKey)
    if (live === undefined || !keyValid(live.key) || !indexKeyValid(live.indexKey)) {
      fail('owner-revoked')
    }
    this.#cachedIncarnation = live.incarnation
    return live
  }

  async #liveOwner(tx: IDBTransaction): Promise<VaultOwnerRow> {
    const current = readActiveOwner(
      await idbRequest(tx.objectStore('owners').get(this.#ownerKey)),
      this.#ownerKey
    )
    const coordinated = this.#coordinator.getOwner(this.#ownerKey)
    if (
      coordinated === undefined ||
      coordinated.incarnation !== current.incarnation ||
      !keyValid(coordinated.key) ||
      !indexKeyValid(coordinated.indexKey)
    ) {
      this.#coordinator.updateOwner(current)
    }
    this.#cachedIncarnation = current.incarnation
    return current
  }

  #syncOwnerAcrossHandles(nextOwner: VaultOwnerRow): void {
    this.#coordinator.updateOwner(nextOwner)
    this.#cachedIncarnation = nextOwner.incarnation
    for (const peer of openVaultInstances) {
      if (!peer.#closed && peer.#idb === this.#idb && peer.#ownerKey === nextOwner.ownerKey) {
        peer.#cachedIncarnation = nextOwner.incarnation
      }
    }
  }

  async #encryptJsonWithOwner(
    owner: VaultOwnerRow,
    kind: VaultRecordKind,
    roomId: string,
    verifiedBoundary: VerifiedPlaintextBoundary,
    payload: unknown
  ): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer; incarnation: string }> {
    this.#alive()
    if (!keyValid(owner.key)) fail('corrupt')
    const plaintext = new TextEncoder().encode(JSON.stringify(payload))
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: buildVaultAad(
            this.#principal,
            owner.incarnation,
            kind,
            roomId,
            verifiedBoundary
          ),
        },
        owner.key,
        plaintext
      )
      this.#alive()
      return { iv: iv.buffer, ciphertext, incarnation: owner.incarnation }
    } catch (error) {
      throw safeVaultError(error)
    } finally {
      plaintext.fill(0)
    }
  }

  async #decryptJsonWithOwner(owner: VaultOwnerRow, row: EncryptedVaultRow): Promise<unknown> {
    this.#alive()
    if (!keyValid(owner.key)) fail('corrupt')
    let plaintext: Uint8Array<ArrayBuffer> | undefined
    try {
      const clear = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: row.iv,
          additionalData: buildVaultAad(
            this.#principal,
            row.incarnation,
            row.kind,
            row.roomId,
            row.verifiedBoundary
          ),
        },
        owner.key,
        row.ciphertext
      )
      plaintext = new Uint8Array(clear)
      this.#alive()
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    } catch (error) {
      if (error instanceof EspaceVaultError) throw error
      throw new EspaceVaultError('corrupt')
    } finally {
      plaintext?.fill(0)
    }
  }

  /**
   * Prioritized `< 25 ms` cold-start read: loads quarantined room IDs, decrypts the sidebar
   * summary + channel index and the active channel's room timeline first, plus queued outbox items.
   */
  async coldStartRead(
    activeChannelId?: string | undefined,
    activeRoomId?: string | undefined
  ): Promise<ColdStartHydration> {
    this.#alive()
    return this.#coordinator.runExclusive(async () => {
      this.#alive()
      const oldest = this.#now() - MAX_AGE_MS
      const sidebarId = recordId(this.#ownerKey, 'sidebar', SIDEBAR_ROOM_SENTINEL)
      const directRoomKey =
        activeRoomId !== undefined ? recordId(this.#ownerKey, 'room', activeRoomId) : undefined

      const initial = await runVaultTx(
        this.#db,
        'readonly',
        async (tx) => {
          const owner = await this.#liveOwner(tx)
          const [quarantineRows, rawSidebar, rawDirectRoom, rawOutbox] = await Promise.all([
            idbRequest(tx.objectStore('quarantine').index('ownerKey').getAll(owner.ownerKey)),
            idbRequest(tx.objectStore('rooms').get(sidebarId)),
            directRoomKey === undefined
              ? Promise.resolve(undefined)
              : idbRequest(tx.objectStore('rooms').get(directRoomKey)),
            idbRequest(tx.objectStore('outbox').index('ownerKey').getAll(owner.ownerKey)),
          ])
          return { owner, quarantineRows, rawSidebar, rawDirectRoom, rawOutbox }
        },
        this.#alive,
        this.#transactions
      )

      const quarantined = new Set<string>()
      for (const raw of initial.quarantineRows) {
        const marker = raw as Partial<QuarantineMarkerRow> | undefined
        if (
          marker &&
          marker.ownerKey === this.#ownerKey &&
          typeof marker.roomId === 'string' &&
          marker.roomId.length > 0
        ) {
          quarantined.add(marker.roomId)
        }
      }

      let sidebar: VaultSidebarPayload | null = null
      const sidebarRow = validateEncryptedRow(
        initial.rawSidebar,
        sidebarId,
        initial.owner,
        'sidebar'
      )
      if (sidebarRow !== null && sidebarRow.savedAt >= oldest) {
        try {
          const parsed = (await this.#decryptJsonWithOwner(
            initial.owner,
            sidebarRow
          )) as Partial<VaultSidebarPayload>
          if (
            parsed &&
            parsed.v === 1 &&
            typeof parsed.savedAt === 'number' &&
            Array.isArray(parsed.rooms) &&
            parsed.rooms.every(isValidCachedSummary) &&
            Array.isArray(parsed.channels) &&
            parsed.channels.every(
              (pair) =>
                Array.isArray(pair) &&
                pair.length === 2 &&
                typeof pair[0] === 'string' &&
                typeof pair[1] === 'string'
            )
          ) {
            sidebar = {
              v: 1,
              savedAt: parsed.savedAt,
              rooms: parsed.rooms.filter((r) => !quarantined.has(r.roomId)),
              channels: parsed.channels.filter(([, rId]) => !quarantined.has(rId)),
            }
          }
        } catch (error) {
          if (error instanceof EspaceVaultError && error.code !== 'corrupt') throw error
        }
      }

      const resolvedActiveRoomId =
        activeRoomId ??
        (activeChannelId !== undefined
          ? sidebar?.channels.find(([chId]) => chId === activeChannelId)?.[1]
          : sidebar?.rooms[0]?.roomId)

      let rawActiveRoom = initial.rawDirectRoom
      if (
        rawActiveRoom === undefined &&
        resolvedActiveRoomId !== undefined &&
        resolvedActiveRoomId !== activeRoomId &&
        !quarantined.has(resolvedActiveRoomId)
      ) {
        const targetId = recordId(this.#ownerKey, 'room', resolvedActiveRoomId)
        rawActiveRoom = await runVaultTx(
          this.#db,
          'readonly',
          async (tx) => {
            await this.#liveOwner(tx)
            return idbRequest(tx.objectStore('rooms').get(targetId))
          },
          this.#alive,
          this.#transactions
        )
      }

      let activeRoom: VaultRoomPayload | null = null
      if (resolvedActiveRoomId !== undefined && !quarantined.has(resolvedActiveRoomId)) {
        activeRoom = await this.#decodeRoomRow(
          rawActiveRoom,
          resolvedActiveRoomId,
          initial.owner,
          oldest,
          quarantined
        )
      }

      const outbox = await this.#decodeOutboxRows(
        initial.rawOutbox,
        initial.owner,
        oldest,
        quarantined
      )

      // Final owner-liveness check after async decryptions so concurrent revocation never leaks plaintext.
      await runVaultTx(
        this.#db,
        'readonly',
        async (tx) => {
          await this.#liveOwner(tx)
        },
        this.#alive,
        this.#transactions
      )

      return { quarantined, sidebar, activeRoom, outbox }
    })
  }

  /** Background hydration of remaining ordinary/community room timelines after active channel paint. */
  async readRemainingRooms(excludeRoomId?: string | undefined): Promise<Map<string, VaultRoomPayload>> {
    if (this.#closed) return new Map()
    return this.#coordinator.runExclusive(async () => {
      const result = new Map<string, VaultRoomPayload>()
      if (this.#closed) return result
      const oldest = this.#now() - MAX_AGE_MS
      const sidebarId = recordId(this.#ownerKey, 'sidebar', SIDEBAR_ROOM_SENTINEL)
      const loaded = await runVaultTx(
        this.#db,
        'readonly',
        async (tx) => {
          const owner = await this.#liveOwner(tx)
          const [quarantineRows, roomRows] = await Promise.all([
            idbRequest(tx.objectStore('quarantine').index('ownerKey').getAll(owner.ownerKey)),
            idbRequest(tx.objectStore('rooms').index('ownerKey').getAll(owner.ownerKey)),
          ])
          return { owner, quarantineRows, roomRows }
        },
        this.#alive,
        this.#transactions
      )
      const quarantined = new Set<string>()
      for (const raw of loaded.quarantineRows) {
        const marker = raw as Partial<QuarantineMarkerRow> | undefined
        if (marker && typeof marker.roomId === 'string') quarantined.add(marker.roomId)
      }
      const staleIds: string[] = []
      for (const raw of loaded.roomRows) {
        const candidate = raw as Partial<EncryptedVaultRow> | undefined
        if (!candidate || candidate.id === sidebarId || typeof candidate.roomId !== 'string') continue
        if (candidate.roomId === excludeRoomId) continue
        if (quarantined.has(candidate.roomId)) {
          if (typeof candidate.id === 'string') staleIds.push(candidate.id)
          continue
        }
        const decoded = await this.#decodeRoomRow(
          raw,
          candidate.roomId,
          loaded.owner,
          oldest,
          quarantined
        )
        if (decoded === null) {
          if (typeof candidate.id === 'string') staleIds.push(candidate.id)
          continue
        }
        result.set(decoded.roomId, decoded)
      }
      if (staleIds.length > 0 && !this.#closed) {
        await runVaultTx(
          this.#db,
          'readwrite',
          async (tx) => {
            await this.#liveOwner(tx)
            const store = tx.objectStore('rooms')
            for (const id of staleIds) await idbRequest(store.delete(id))
          },
          this.#alive,
          this.#transactions
        )
      } else {
        await runVaultTx(
          this.#db,
          'readonly',
          async (tx) => {
            await this.#liveOwner(tx)
          },
          this.#alive,
          this.#transactions
        )
      }
      return result
    })
  }

  async #decodeRoomRow(
    raw: unknown,
    expectedRoomId: string,
    owner: VaultOwnerRow,
    oldest: number,
    quarantined: ReadonlySet<string>
  ): Promise<VaultRoomPayload | null> {
    if (quarantined.has(expectedRoomId)) return null
    const expectedId = recordId(owner.ownerKey, 'room', expectedRoomId)
    const row = validateEncryptedRow(raw, expectedId, owner, 'room')
    if (row === null || row.roomId !== expectedRoomId || row.savedAt < oldest) return null
    try {
      const parsed = (await this.#decryptJsonWithOwner(owner, row)) as Partial<VaultRoomPayload>
      if (
        !parsed ||
        parsed.v !== 1 ||
        parsed.roomId !== expectedRoomId ||
        parsed.verifiedBoundary !== row.verifiedBoundary ||
        typeof parsed.savedAt !== 'number' ||
        !Array.isArray(parsed.messages) ||
        parsed.messages.length === 0 ||
        !parsed.messages.every(isCachedMessage) ||
        (parsed.summary !== undefined && !isValidCachedSummary(parsed.summary))
      ) {
        return null
      }
      return {
        v: 1,
        roomId: parsed.roomId,
        verifiedBoundary: parsed.verifiedBoundary,
        savedAt: parsed.savedAt,
        ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
        ...(Array.isArray(parsed.channelIds)
          ? { channelIds: parsed.channelIds.filter((c): c is string => typeof c === 'string') }
          : {}),
        messages: parsed.messages.slice(-this.#limit),
      }
    } catch (error) {
      if (error instanceof EspaceVaultError && error.code !== 'corrupt') throw error
      return null
    }
  }

  async #decodeOutboxRows(
    rawRows: readonly unknown[],
    owner: VaultOwnerRow,
    oldest: number,
    quarantined: ReadonlySet<string>
  ): Promise<VaultOutboxPayload[]> {
    const items: VaultOutboxPayload[] = []
    for (const raw of rawRows) {
      const candidate = raw as Partial<EncryptedVaultRow> | undefined
      if (!candidate || typeof candidate.id !== 'string' || typeof candidate.roomId !== 'string') {
        continue
      }
      if (quarantined.has(candidate.roomId)) continue
      const row = validateEncryptedRow(raw, candidate.id, owner, 'outbox')
      if (row === null || row.savedAt < oldest) continue
      try {
        const parsed = (await this.#decryptJsonWithOwner(owner, row)) as Partial<VaultOutboxPayload>
        if (
          !parsed ||
          parsed.v !== 1 ||
          typeof parsed.clientTxnId !== 'string' ||
          parsed.clientTxnId.length === 0 ||
          recordId(owner.ownerKey, 'outbox', parsed.clientTxnId) !== row.id ||
          parsed.roomId !== row.roomId ||
          parsed.verifiedBoundary !== row.verifiedBoundary ||
          parsed.expectedEpoch !== 0 ||
          typeof parsed.queuedAt !== 'number' ||
          typeof parsed.body !== 'string' ||
          new TextEncoder().encode(parsed.body).byteLength > MAX_OUTBOX_BODY_BYTES ||
          !parsed.content ||
          typeof parsed.content !== 'object' ||
          Array.isArray(parsed.content) ||
          (parsed.channelId !== undefined &&
            (typeof parsed.channelId !== 'string' ||
              parsed.channelId.trim().length === 0 ||
              parsed.channelId.length > 128)) ||
          (parsed.notBefore !== undefined &&
            (typeof parsed.notBefore !== 'number' ||
              !Number.isFinite(parsed.notBefore) ||
              parsed.notBefore <= 0))
        ) {
          continue
        }
        items.push({
          v: 1,
          clientTxnId: parsed.clientTxnId,
          roomId: parsed.roomId,
          ...(parsed.channelId === undefined ? {} : { channelId: parsed.channelId }),
          verifiedBoundary: parsed.verifiedBoundary,
          expectedEpoch: 0,
          queuedAt: parsed.queuedAt,
          ...(parsed.notBefore === undefined ? {} : { notBefore: parsed.notBefore }),
          body: parsed.body,
          content: parsed.content,
        })
      } catch (error) {
        if (error instanceof EspaceVaultError && error.code !== 'corrupt') throw error
      }
    }
    items.sort((a, b) => a.queuedAt - b.queuedAt || a.clientTxnId.localeCompare(b.clientTxnId))
    return items.slice(0, MAX_OUTBOX_ITEMS)
  }

  /** Schedules a debounced write for a positively verified ordinary or community room. */
  scheduleRoomSave(
    roomId: string,
    verifiedBoundary: RoomBoundary,
    messages: readonly MessageView[],
    summary?: CachedRoomSummary | undefined,
    channelIds?: readonly string[] | undefined
  ): void {
    if (this.#closed || !isVerifiedPlaintextBoundary(verifiedBoundary)) return
    this.#pendingRooms.set(roomId, {
      verifiedBoundary,
      messages,
      summary,
      channelIds,
    })
    this.#armTimer()
  }

  /** Schedules a debounced write for the sidebar room summaries and channel alias mappings. */
  scheduleSidebarSave(
    rooms: readonly CachedRoomSummary[],
    channels: readonly (readonly [string, string])[]
  ): void {
    if (this.#closed) return
    this.#pendingSidebar = { rooms, channels }
    this.#armTimer()
  }

  #armTimer(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#delayMs)
  }

  /** Flushes all pending debounced room and sidebar writes immediately. */
  flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#closed) return this.#writing
    const roomBatch = [...this.#pendingRooms]
    this.#pendingRooms.clear()
    const sidebarSnapshot = this.#pendingSidebar
    this.#pendingSidebar = null

    if (roomBatch.length === 0 && sidebarSnapshot === null) {
      return this.#writing
    }

    return this.#enqueueBackground(async () => {
      if (this.#closed) return
      const activeOwner = this.#currentOwner()
      const now = this.#now()
      const preparedRooms: { roomId: string; id: string; row: EncryptedVaultRow | null }[] = []
      for (const [roomId, item] of roomBatch) {
        const kept = cloneSentMessages(item.messages, this.#limit)
        const id = recordId(this.#ownerKey, 'room', roomId)
        if (kept.length === 0) {
          preparedRooms.push({ roomId, id, row: null })
          continue
        }
        const payload: VaultRoomPayload = {
          v: 1,
          roomId,
          verifiedBoundary: item.verifiedBoundary,
          savedAt: now,
          ...(item.summary === undefined ? {} : { summary: item.summary }),
          ...(item.channelIds === undefined ? {} : { channelIds: [...item.channelIds] }),
          messages: kept,
        }
        const sealed = await this.#encryptJsonWithOwner(
          activeOwner,
          'room',
          roomId,
          item.verifiedBoundary,
          payload
        )
        preparedRooms.push({
          roomId,
          id,
          row: {
            id,
            ownerKey: this.#ownerKey,
            incarnation: sealed.incarnation,
            kind: 'room',
            roomId,
            verifiedBoundary: item.verifiedBoundary,
            savedAt: now,
            iv: sealed.iv,
            ciphertext: sealed.ciphertext,
          },
        })
      }

      let preparedSidebar: EncryptedVaultRow | null = null
      let deleteEmptySidebar = false
      if (sidebarSnapshot !== null) {
        const validRooms = sidebarSnapshot.rooms.filter((r) =>
          isVerifiedPlaintextBoundary(r.verifiedBoundary)
        )
        const validRoomIds = new Set(validRooms.map((r) => r.roomId))
        const validChannels = sidebarSnapshot.channels.filter(([, rId]) => validRoomIds.has(rId))
        if (validRooms.length === 0 && validChannels.length === 0) {
          deleteEmptySidebar = true
        } else {
          const payload: VaultSidebarPayload = {
            v: 1,
            savedAt: now,
            rooms: validRooms,
            channels: validChannels,
          }
          const sealed = await this.#encryptJsonWithOwner(
            activeOwner,
            'sidebar',
            SIDEBAR_ROOM_SENTINEL,
            'ordinary',
            payload
          )
          preparedSidebar = {
            id: recordId(this.#ownerKey, 'sidebar', SIDEBAR_ROOM_SENTINEL),
            ownerKey: this.#ownerKey,
            incarnation: sealed.incarnation,
            kind: 'sidebar',
            roomId: SIDEBAR_ROOM_SENTINEL,
            verifiedBoundary: 'ordinary',
            savedAt: now,
            iv: sealed.iv,
            ciphertext: sealed.ciphertext,
          }
        }
      }

      await runVaultTx(
        this.#db,
        'readwrite',
        async (tx) => {
          const owner = await this.#liveOwner(tx)
          const quarantineStore = tx.objectStore('quarantine')
          const roomsStore = tx.objectStore('rooms')
          for (const entry of preparedRooms) {
            const qId = recordId(owner.ownerKey, 'quarantine', entry.roomId)
            const isQuarantined = (await idbRequest(quarantineStore.get(qId))) !== undefined
            if (isQuarantined || entry.row === null) {
              await idbRequest(roomsStore.delete(entry.id))
            } else if (entry.row.incarnation === owner.incarnation) {
              await idbRequest(roomsStore.put(entry.row))
            }
          }
          if (deleteEmptySidebar) {
            await idbRequest(
              roomsStore.delete(recordId(owner.ownerKey, 'sidebar', SIDEBAR_ROOM_SENTINEL))
            )
          } else if (preparedSidebar !== null && preparedSidebar.incarnation === owner.incarnation) {
            await idbRequest(roomsStore.put(preparedSidebar))
          }
        },
        this.#alive,
        this.#transactions
      )
    })
  }

  /**
   * Computes a 128-bit lowercase hex blind term tag keyed by the principal's non-extractable
   * `HMAC-SHA-256` `indexKey` over `"kodera-local-fts-v1\0" + incarnation + "\0" + roomId + "\0" + token`.
   */
  async computeBlindTermTag(roomId: string, foldedToken: string): Promise<string> {
    this.#alive()
    const validRoom = nonEmptyField(roomId, 255)
    const validToken = nonEmptyField(foldedToken, 128)
    const owner = this.#currentOwner()
    if (!indexKeyValid(owner.indexKey)) fail('owner-revoked')
    const message = new TextEncoder().encode(
      `${LOCAL_FTS_HMAC_DOMAIN}\0${owner.incarnation}\0${validRoom}\0${validToken}`
    )
    try {
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', owner.indexKey, message))
      this.#alive()
      let hex = ''
      for (let i = 0; i < 16; i += 1) {
        hex += mac[i]!.toString(16).padStart(2, '0')
      }
      return hex
    } catch (error) {
      throw safeVaultError(error)
    } finally {
      message.fill(0)
    }
  }

  /**
   * Seals and persists a per-room local search index shard (`<= 512 KiB`) under `AES-256-GCM`
   * binding `(principal, incarnation, 'search-index', roomId, boundaryTag, epoch)` as AAD.
   */
  async putSearchIndexShard(input: {
    readonly roomId: string
    readonly boundaryTag: SearchBoundaryTag
    readonly epoch: number
    readonly savedAt?: number | undefined
    readonly payload: unknown
  }): Promise<void> {
    this.#alive()
    const validRoom = nonEmptyField(input.roomId, 255)
    if (!isValidSearchBoundaryTag(input.boundaryTag)) fail('invalid-input')
    if (
      typeof input.epoch !== 'number' ||
      !Number.isInteger(input.epoch) ||
      input.epoch < 0 ||
      (input.boundaryTag !== 'confidential-e2ee' && input.epoch !== 0)
    ) {
      fail('invalid-input')
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(input.payload))
    if (plaintext.byteLength > MAX_SEARCH_SHARD_BYTES) {
      plaintext.fill(0)
      fail('capacity')
    }
    return this.#coordinator.runExclusive(async () => {
      try {
        this.#alive()
        const activeOwner = this.#currentOwner()
        if (!keyValid(activeOwner.key)) fail('corrupt')
        const now = input.savedAt ?? this.#now()
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: buildSearchIndexAad(
              this.#principal,
              activeOwner.incarnation,
              validRoom,
              input.boundaryTag,
              input.epoch
            ),
          },
          activeOwner.key,
          plaintext
        )
        this.#alive()
        const id = recordId(this.#ownerKey, 'search-index', validRoom)
        await runVaultTx(
          this.#db,
          'readwrite',
          async (tx) => {
            const owner = await this.#liveOwner(tx)
            if (owner.incarnation !== activeOwner.incarnation) fail('storage')
            if (input.boundaryTag !== 'confidential-e2ee') {
              const qId = recordId(owner.ownerKey, 'quarantine', validRoom)
              if ((await idbRequest(tx.objectStore('quarantine').get(qId))) !== undefined) {
                fail('quarantined')
              }
            }
            await idbRequest(
              tx.objectStore('search_index').put({
                id,
                ownerKey: owner.ownerKey,
                ownerRoom: ownerRoomKey(owner.ownerKey, validRoom),
                incarnation: activeOwner.incarnation,
                roomId: validRoom,
                boundaryTag: input.boundaryTag,
                epoch: input.epoch,
                savedAt: now,
                iv: iv.buffer,
                ciphertext,
              } satisfies EncryptedSearchIndexRow)
            )
          },
          this.#alive,
          this.#transactions
        )
      } catch (error) {
        throw safeVaultError(error)
      } finally {
        plaintext.fill(0)
      }
    })
  }

  /** Decrypts a per-room local search index shard if unquarantined and matching expected AAD metadata. */
  async readSearchIndexShard(
    roomId: string,
    expected?: {
      readonly boundaryTag?: SearchBoundaryTag | undefined
      readonly epoch?: number | undefined
    }
  ): Promise<{
    readonly boundaryTag: SearchBoundaryTag
    readonly epoch: number
    readonly incarnation: string
    readonly savedAt: number
    readonly payload: unknown
  } | null> {
    this.#alive()
    const validRoom = nonEmptyField(roomId, 255)
    return this.#coordinator.runExclusive(async () => {
      this.#alive()
      const id = recordId(this.#ownerKey, 'search-index', validRoom)
      const qId = recordId(this.#ownerKey, 'quarantine', validRoom)
      const oldest = this.#now() - MAX_AGE_MS
      const loaded = await runVaultTx(
        this.#db,
        'readonly',
        async (tx) => {
          const owner = await this.#liveOwner(tx)
          const [quarantined, raw] = await Promise.all([
            idbRequest(tx.objectStore('quarantine').get(qId)),
            idbRequest(tx.objectStore('search_index').get(id)),
          ])
          const validated = validateSearchIndexRow(raw, id, owner, validRoom)
          if (quarantined !== undefined && validated?.boundaryTag !== 'confidential-e2ee') {
            return { owner, row: null }
          }
          return { owner, row: validated }
        },
        this.#alive,
        this.#transactions
      )
      if (loaded.row === null || loaded.row.savedAt < oldest) return null
      if (expected?.boundaryTag !== undefined && loaded.row.boundaryTag !== expected.boundaryTag) {
        return null
      }
      if (expected?.epoch !== undefined && loaded.row.epoch !== expected.epoch) {
        return null
      }
      if (!keyValid(loaded.owner.key)) fail('corrupt')
      let plaintext: Uint8Array<ArrayBuffer> | undefined
      try {
        const clear = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: loaded.row.iv,
            additionalData: buildSearchIndexAad(
              this.#principal,
              loaded.row.incarnation,
              loaded.row.roomId,
              loaded.row.boundaryTag,
              loaded.row.epoch
            ),
          },
          loaded.owner.key,
          loaded.row.ciphertext
        )
        plaintext = new Uint8Array(clear)
        this.#alive()
        const parsed: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
        )
        await runVaultTx(
          this.#db,
          'readonly',
          async (tx) => {
            await this.#liveOwner(tx)
          },
          this.#alive,
          this.#transactions
        )
        return {
          boundaryTag: loaded.row.boundaryTag,
          epoch: loaded.row.epoch,
          incarnation: loaded.row.incarnation,
          savedAt: loaded.row.savedAt,
          payload: parsed,
        }
      } catch (error) {
        if (error instanceof EspaceVaultError && error.code !== 'corrupt') throw error
        return null
      } finally {
        plaintext?.fill(0)
      }
    })
  }

  async deleteSearchIndexShard(roomId: string): Promise<void> {
    if (this.#closed) return
    const validRoom = nonEmptyField(roomId, 255)
    return this.#coordinator.runExclusive(async () => {
      if (this.#closed) return
      const id = recordId(this.#ownerKey, 'search-index', validRoom)
      await runVaultTx(
        this.#db,
        'readwrite',
        async (tx) => {
          await this.#liveOwner(tx)
          await idbRequest(tx.objectStore('search_index').delete(id))
        },
        this.#alive,
        this.#transactions
      )
    })
  }

  /**
   * Immediately purges room cache, search index, outbox entries, and drafts for `roomId`, rotates
   * the owner's non-extractable `AES-GCM` `key`, `HMAC-SHA-256` `indexKey`, and `incarnation` so
   * revoked ciphertexts and blind tags can never be used, and persists a body-free quarantine
   * marker so restarts refuse plaintext before `/sync` arrives (issue 180).
   */
  quarantineRoom(roomId: string): Promise<void> {
    notifyVaultSearchEviction({ kind: 'room', ownerKey: this.#ownerKey, roomId })
    if (this.#closed) return this.#writing
    this.#pendingRooms.delete(roomId)
    if (this.#pendingSidebar !== null) {
      this.#pendingSidebar = {
        rooms: this.#pendingSidebar.rooms.filter((r) => r.roomId !== roomId),
        channels: this.#pendingSidebar.channels.filter(([, rId]) => rId !== roomId),
      }
    }
    return this.#enqueueBackground(() =>
      this.#purgeRoomAndRotateOwnerKey(roomId, { quarantine: true })
    )
  }

  /**
   * Purges room cache, search index, outbox entries, and drafts when the member leaves, is banned,
   * or receives `403 / M_FORBIDDEN`, and rotates the owner's non-extractable `key` + `indexKey` +
   * `incarnation`.
   */
  forgetRoom(roomId: string): Promise<void> {
    notifyVaultSearchEviction({ kind: 'room', ownerKey: this.#ownerKey, roomId })
    if (this.#closed) return this.#writing
    this.#pendingRooms.delete(roomId)
    if (this.#pendingSidebar !== null) {
      this.#pendingSidebar = {
        rooms: this.#pendingSidebar.rooms.filter((r) => r.roomId !== roomId),
        channels: this.#pendingSidebar.channels.filter(([, rId]) => rId !== roomId),
      }
    }
    return this.#enqueueBackground(() =>
      this.#purgeRoomAndRotateOwnerKey(roomId, { quarantine: false })
    )
  }

  async #purgeRoomAndRotateOwnerKey(
    roomId: string,
    options: { readonly quarantine: boolean }
  ): Promise<void> {
    if (this.#closed) return
    const sidebarId = recordId(this.#ownerKey, 'sidebar', SIDEBAR_ROOM_SENTINEL)

    const snapshot = await runVaultTx(
      this.#db,
      'readonly',
      async (tx) => {
        const owner = await this.#liveOwner(tx)
        const [roomRows, outboxRows, draftRows, searchRows] = await Promise.all([
          idbRequest(tx.objectStore('rooms').index('ownerKey').getAll(owner.ownerKey)),
          idbRequest(tx.objectStore('outbox').index('ownerKey').getAll(owner.ownerKey)),
          idbRequest(tx.objectStore('drafts').index('ownerKey').getAll(owner.ownerKey)),
          idbRequest(tx.objectStore('search_index').index('ownerKey').getAll(owner.ownerKey)),
        ])
        return { owner, roomRows, outboxRows, draftRows, searchRows }
      },
      this.#alive,
      this.#transactions
    )
    if (this.#closed) return

    const [newKey, newIndexKey] = await Promise.all([
      generateVaultAesKey(),
      generateVaultIndexKey(),
    ])
    if (this.#closed) return

    const nextOwner: VaultOwnerRow = {
      ownerKey: snapshot.owner.ownerKey,
      ownerId: snapshot.owner.ownerId,
      organisationId: snapshot.owner.organisationId,
      membershipId: snapshot.owner.membershipId,
      deviceId: snapshot.owner.deviceId,
      incarnation: crypto.randomUUID(),
      purgeEpoch: (snapshot.owner.purgeEpoch ?? 0) + 1,
      status: 'active',
      key: newKey,
      indexKey: newIndexKey,
    }

    const reencryptedRooms: EncryptedVaultRow[] = []
    for (const raw of snapshot.roomRows) {
      const candidate = raw as Partial<EncryptedVaultRow> | undefined
      if (!candidate || typeof candidate.id !== 'string' || typeof candidate.roomId !== 'string') {
        continue
      }
      if (candidate.roomId === roomId) continue
      if (candidate.id === sidebarId) {
        const row = validateEncryptedRow(raw, sidebarId, snapshot.owner, 'sidebar')
        if (row === null) continue
        try {
          const parsed = (await this.#decryptJsonWithOwner(
            snapshot.owner,
            row
          )) as Partial<VaultSidebarPayload>
          if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rooms) || !Array.isArray(parsed.channels)) {
            continue
          }
          const nextRooms = parsed.rooms.filter(
            (r): r is CachedRoomSummary => isValidCachedSummary(r) && r.roomId !== roomId
          )
          const nextChannels = parsed.channels.filter(
            (pair): pair is readonly [string, string] =>
              Array.isArray(pair) &&
              pair.length === 2 &&
              typeof pair[0] === 'string' &&
              typeof pair[1] === 'string' &&
              pair[1] !== roomId
          )
          if (nextRooms.length === 0 && nextChannels.length === 0) continue
          const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : row.savedAt
          const scrubbed: VaultSidebarPayload = {
            v: 1,
            savedAt,
            rooms: nextRooms,
            channels: nextChannels,
          }
          const sealed = await this.#encryptJsonWithOwner(
            nextOwner,
            'sidebar',
            SIDEBAR_ROOM_SENTINEL,
            'ordinary',
            scrubbed
          )
          reencryptedRooms.push({
            id: sidebarId,
            ownerKey: nextOwner.ownerKey,
            incarnation: sealed.incarnation,
            kind: 'sidebar',
            roomId: SIDEBAR_ROOM_SENTINEL,
            verifiedBoundary: 'ordinary',
            savedAt,
            iv: sealed.iv,
            ciphertext: sealed.ciphertext,
          })
        } catch {
          // Drop corrupt sidebar row.
        }
        continue
      }
      const row = validateEncryptedRow(raw, candidate.id, snapshot.owner, 'room')
      if (row === null) continue
      try {
        const parsed = await this.#decryptJsonWithOwner(snapshot.owner, row)
        const sealed = await this.#encryptJsonWithOwner(
          nextOwner,
          'room',
          row.roomId,
          row.verifiedBoundary,
          parsed
        )
        reencryptedRooms.push({
          id: row.id,
          ownerKey: nextOwner.ownerKey,
          incarnation: sealed.incarnation,
          kind: 'room',
          roomId: row.roomId,
          verifiedBoundary: row.verifiedBoundary,
          savedAt: row.savedAt,
          iv: sealed.iv,
          ciphertext: sealed.ciphertext,
        })
      } catch {
        // Drop corrupt room row.
      }
    }

    const reencryptedOutbox: EncryptedVaultRow[] = []
    for (const raw of snapshot.outboxRows) {
      const candidate = raw as Partial<EncryptedVaultRow> | undefined
      if (!candidate || typeof candidate.id !== 'string' || typeof candidate.roomId !== 'string') {
        continue
      }
      if (candidate.roomId === roomId) continue
      const row = validateEncryptedRow(raw, candidate.id, snapshot.owner, 'outbox')
      if (row === null) continue
      try {
        const parsed = await this.#decryptJsonWithOwner(snapshot.owner, row)
        const sealed = await this.#encryptJsonWithOwner(
          nextOwner,
          'outbox',
          row.roomId,
          row.verifiedBoundary,
          parsed
        )
        reencryptedOutbox.push({
          id: row.id,
          ownerKey: nextOwner.ownerKey,
          incarnation: sealed.incarnation,
          kind: 'outbox',
          roomId: row.roomId,
          verifiedBoundary: row.verifiedBoundary,
          savedAt: row.savedAt,
          iv: sealed.iv,
          ciphertext: sealed.ciphertext,
        })
      } catch {
        // Drop corrupt outbox row.
      }
    }

    const reencryptedDrafts: EncryptedVaultRow[] = []
    for (const raw of snapshot.draftRows) {
      const candidate = raw as Partial<EncryptedVaultRow> | undefined
      if (!candidate || typeof candidate.id !== 'string' || typeof candidate.roomId !== 'string') {
        continue
      }
      if (candidate.roomId === roomId) continue
      const row = validateEncryptedRow(raw, candidate.id, snapshot.owner, 'draft')
      if (row === null) continue
      try {
        const parsed = await this.#decryptJsonWithOwner(snapshot.owner, row)
        const sealed = await this.#encryptJsonWithOwner(
          nextOwner,
          'draft',
          row.roomId,
          row.verifiedBoundary,
          parsed
        )
        reencryptedDrafts.push({
          id: row.id,
          ownerKey: nextOwner.ownerKey,
          incarnation: sealed.incarnation,
          kind: 'draft',
          roomId: row.roomId,
          verifiedBoundary: row.verifiedBoundary,
          savedAt: row.savedAt,
          iv: sealed.iv,
          ciphertext: sealed.ciphertext,
        })
      } catch {
        // Drop corrupt draft row.
      }
    }

    if (this.#closed) return
    const committed = await runVaultTx(
      this.#db,
      'readwrite',
      async (tx) => {
        const currentOwner = await this.#liveOwner(tx)
        if (
          currentOwner.incarnation !== snapshot.owner.incarnation ||
          (currentOwner.purgeEpoch ?? 0) !== (snapshot.owner.purgeEpoch ?? 0)
        )
          return false

        // Crypto runs outside IDB transactions. Revalidate every row before replacing the
        // snapshot so a cross-tab deletion or newer write can never be rolled back.
        for (const [storeName, prior] of [
          ['rooms', snapshot.roomRows],
          ['outbox', snapshot.outboxRows],
          ['drafts', snapshot.draftRows],
        ] as const) {
          const current = await idbRequest(
            tx.objectStore(storeName).index('ownerKey').getAll(this.#ownerKey)
          )
          if (!sameVaultRows(prior, current)) return false
        }
        const currentSearchRows = await idbRequest(
          tx.objectStore('search_index').index('ownerKey').getAll(this.#ownerKey)
        )
        if (!sameSearchRows(snapshot.searchRows, currentSearchRows)) return false

        await idbRequest(tx.objectStore('owners').put(nextOwner))

        const replaceStoreRows = async (
          storeName: 'rooms' | 'outbox' | 'drafts',
          nextRows: readonly EncryptedVaultRow[]
        ) => {
          const store = tx.objectStore(storeName)
          const currentRows = await idbRequest(store.index('ownerKey').getAll(nextOwner.ownerKey))
          for (const existing of currentRows) {
            const rec = existing as Partial<EncryptedVaultRow> | undefined
            if (rec && typeof rec.id === 'string') {
              await idbRequest(store.delete(rec.id))
            }
          }
          for (const row of nextRows) {
            await idbRequest(store.put(row))
          }
        }

        await replaceStoreRows('rooms', reencryptedRooms)
        await replaceStoreRows('outbox', reencryptedOutbox)
        await replaceStoreRows('drafts', reencryptedDrafts)

        const searchStore = tx.objectStore('search_index')
        const existingSearchRows = await idbRequest(
          searchStore.index('ownerKey').getAll(nextOwner.ownerKey)
        )
        for (const existing of existingSearchRows) {
          const rec = existing as Partial<EncryptedSearchIndexRow> | undefined
          if (rec && typeof rec.id === 'string') {
            await idbRequest(searchStore.delete(rec.id))
          }
        }

        if (options.quarantine) {
          const qId = recordId(nextOwner.ownerKey, 'quarantine', roomId)
          await idbRequest(
            tx.objectStore('quarantine').put({
              id: qId,
              ownerKey: nextOwner.ownerKey,
              roomId,
              markedAt: this.#now(),
            } satisfies QuarantineMarkerRow)
          )
        }
        return true
      },
      this.#alive,
      this.#transactions
    )
    if (!committed) {
      // Retry this purge against the surviving state and key, never the stale snapshot.
      return this.#purgeRoomAndRotateOwnerKey(roomId, options)
    }
    this.#syncOwnerAcrossHandles(nextOwner)
  }

  /** Encrypts and persists an unsent ordinary/community message (`<= 32` items, `<= 64 KiB`). */
  async putOutbox(input: {
    readonly clientTxnId: string
    readonly roomId: string
    readonly channelId?: string | undefined
    readonly verifiedBoundary: RoomBoundary
    readonly queuedAt?: number | undefined
    readonly notBefore?: number | undefined
    readonly body: string
    readonly content: Record<string, unknown>
  }): Promise<void> {
    this.#alive()
    const verifiedBoundary = input.verifiedBoundary
    if (!isVerifiedPlaintextBoundary(verifiedBoundary)) fail('quarantined')
    const clientTxnId = nonEmptyField(input.clientTxnId, 128)
    const roomId = nonEmptyField(input.roomId, 255)
    const channelId =
      input.channelId !== undefined && input.channelId.trim().length > 0
        ? nonEmptyField(input.channelId, 128)
        : undefined
    const notBefore =
      input.notBefore !== undefined &&
      typeof input.notBefore === 'number' &&
      Number.isFinite(input.notBefore) &&
      input.notBefore > 0
        ? input.notBefore
        : undefined
    if (typeof input.body !== 'string') fail('invalid-input')
    const bodyBytes = new TextEncoder().encode(input.body).byteLength
    if (bodyBytes > MAX_OUTBOX_BODY_BYTES) fail('capacity')

    return this.#coordinator.runExclusive(async () => {
      this.#alive()
      const activeOwner = this.#currentOwner()
      const now = input.queuedAt ?? this.#now()
      const payload: VaultOutboxPayload = {
        v: 1,
        clientTxnId,
        roomId,
        ...(channelId === undefined ? {} : { channelId }),
        verifiedBoundary,
        expectedEpoch: 0,
        queuedAt: now,
        ...(notBefore === undefined ? {} : { notBefore }),
        body: input.body,
        content: input.content,
      }
      const sealed = await this.#encryptJsonWithOwner(
        activeOwner,
        'outbox',
        roomId,
        verifiedBoundary,
        payload
      )
      const id = recordId(this.#ownerKey, 'outbox', clientTxnId)
      await runVaultTx(
        this.#db,
        'readwrite',
        async (tx) => {
          const owner = await this.#liveOwner(tx)
          if (owner.incarnation !== sealed.incarnation) {
            fail('storage')
          }
          const qId = recordId(owner.ownerKey, 'quarantine', roomId)
          if ((await idbRequest(tx.objectStore('quarantine').get(qId))) !== undefined) {
            fail('quarantined')
          }
          const outboxStore = tx.objectStore('outbox')
          const existing = await idbRequest(outboxStore.get(id))
          if (existing === undefined) {
            const count = await idbRequest(outboxStore.index('ownerKey').count(owner.ownerKey))
            if (count >= MAX_OUTBOX_ITEMS) fail('capacity')
          }
          await idbRequest(
            outboxStore.put({
              id,
              ownerKey: owner.ownerKey,
              incarnation: sealed.incarnation,
              kind: 'outbox',
              roomId,
              verifiedBoundary,
              savedAt: now,
              iv: sealed.iv,
              ciphertext: sealed.ciphertext,
            } satisfies EncryptedVaultRow)
          )
        },
        this.#alive,
        this.#transactions
      )
    })
  }

  async deleteOutbox(clientTxnId: string): Promise<void> {
    if (this.#closed) return
    return this.#coordinator.runExclusive(async () => {
      if (this.#closed) return
      const id = recordId(this.#ownerKey, 'outbox', clientTxnId)
      await runVaultTx(
        this.#db,
        'readwrite',
        async (tx) => {
          await this.#liveOwner(tx)
          await idbRequest(tx.objectStore('outbox').delete(id))
        },
        this.#alive,
        this.#transactions
      )
    })
  }

  async putDraft(
    roomId: string,
    verifiedBoundary: RoomBoundary,
    text: string,
    threadText: string
  ): Promise<void> {
    this.#alive()
    if (!isVerifiedPlaintextBoundary(verifiedBoundary)) fail('quarantined')
    const validRoom = nonEmptyField(roomId, 255)
    const clippedText = text.slice(0, MAX_DRAFT_CHARS)
    const clippedThread = threadText.slice(0, MAX_DRAFT_CHARS)
    if (clippedText.length === 0 && clippedThread.length === 0) {
      await this.deleteDraft(validRoom)
      return
    }
    return this.#coordinator.runExclusive(async () => {
      this.#alive()
      const activeOwner = this.#currentOwner()
      const now = this.#now()
      const payload: VaultDraftPayload = {
        v: 1,
        roomId: validRoom,
        verifiedBoundary,
        savedAt: now,
        text: clippedText,
        threadText: clippedThread,
      }
      const sealed = await this.#encryptJsonWithOwner(
        activeOwner,
        'draft',
        validRoom,
        verifiedBoundary,
        payload
      )
      const id = recordId(this.#ownerKey, 'draft', validRoom)
      await runVaultTx(
        this.#db,
        'readwrite',
        async (tx) => {
          const owner = await this.#liveOwner(tx)
          if (owner.incarnation !== sealed.incarnation) fail('storage')
          const qId = recordId(owner.ownerKey, 'quarantine', validRoom)
          if ((await idbRequest(tx.objectStore('quarantine').get(qId))) !== undefined) {
            fail('quarantined')
          }
          const draftsStore = tx.objectStore('drafts')
          const existing = await idbRequest(draftsStore.get(id))
          if (existing === undefined) {
            const all = await idbRequest(draftsStore.index('ownerKey').getAll(owner.ownerKey))
            if (all.length >= MAX_DRAFT_ROOMS) {
              const sorted = [...all]
                .map((r) => r as EncryptedVaultRow)
                .sort((a, b) => a.savedAt - b.savedAt)
              for (const victim of sorted.slice(0, all.length - MAX_DRAFT_ROOMS + 1)) {
                await idbRequest(draftsStore.delete(victim.id))
              }
            }
          }
          await idbRequest(
            draftsStore.put({
              id,
              ownerKey: owner.ownerKey,
              incarnation: sealed.incarnation,
              kind: 'draft',
              roomId: validRoom,
              verifiedBoundary,
              savedAt: now,
              iv: sealed.iv,
              ciphertext: sealed.ciphertext,
            } satisfies EncryptedVaultRow)
          )
        },
        this.#alive,
        this.#transactions
      )
    })
  }

  async readDraft(roomId: string): Promise<VaultDraftPayload | null> {
    this.#alive()
    return this.#coordinator.runExclusive(async () => {
      this.#alive()
      const id = recordId(this.#ownerKey, 'draft', roomId)
      const qId = recordId(this.#ownerKey, 'quarantine', roomId)
      const oldest = this.#now() - MAX_AGE_MS
      const loaded = await runVaultTx(
        this.#db,
        'readonly',
        async (tx) => {
          const owner = await this.#liveOwner(tx)
          const [quarantined, raw] = await Promise.all([
            idbRequest(tx.objectStore('quarantine').get(qId)),
            idbRequest(tx.objectStore('drafts').get(id)),
          ])
          if (quarantined !== undefined) return { owner, row: null }
          return { owner, row: validateEncryptedRow(raw, id, owner, 'draft') }
        },
        this.#alive,
        this.#transactions
      )
      if (loaded.row === null || loaded.row.roomId !== roomId || loaded.row.savedAt < oldest) {
        return null
      }
      try {
        const parsed = (await this.#decryptJsonWithOwner(
          loaded.owner,
          loaded.row
        )) as Partial<VaultDraftPayload>
        await runVaultTx(
          this.#db,
          'readonly',
          async (tx) => {
            await this.#liveOwner(tx)
          },
          this.#alive,
          this.#transactions
        )
        if (
          !parsed ||
          parsed.v !== 1 ||
          parsed.roomId !== roomId ||
          parsed.verifiedBoundary !== loaded.row.verifiedBoundary ||
          typeof parsed.text !== 'string' ||
          typeof parsed.threadText !== 'string' ||
          parsed.text.length > MAX_DRAFT_CHARS ||
          parsed.threadText.length > MAX_DRAFT_CHARS
        ) {
          return null
        }
        return {
          v: 1,
          roomId,
          verifiedBoundary: parsed.verifiedBoundary,
          savedAt: loaded.row.savedAt,
          text: parsed.text,
          threadText: parsed.threadText,
        }
      } catch (error) {
        if (error instanceof EspaceVaultError && error.code !== 'corrupt') throw error
        return null
      }
    })
  }

  async deleteDraft(roomId: string): Promise<void> {
    if (this.#closed) return
    return this.#coordinator.runExclusive(async () => {
      if (this.#closed) return
      const id = recordId(this.#ownerKey, 'draft', roomId)
      await runVaultTx(
        this.#db,
        'readwrite',
        async (tx) => {
          await this.#liveOwner(tx)
          await idbRequest(tx.objectStore('drafts').delete(id))
        },
        this.#alive,
        this.#transactions
      )
    })
  }

  /** Flushes pending ordinary writes and closes the IndexedDB handle cleanly. */
  async close(): Promise<void> {
    if (this.#closed) return this.#writing
    const done = this.flush()
    await done.catch(() => undefined)
    this.closeImmediate()
  }

  #releaseOwnerOnce(): void {
    if (this.#releasedOwner) return
    this.#releasedOwner = true
    this.#coordinator.releaseOwner(this.#ownerKey)
  }

  matchesIdbFactory(target: IDBFactory | undefined): boolean {
    return target === undefined || this.#idb === target
  }

  closeImmediate(): void {
    if (this.#closed) return
    this.#closed = true
    openVaultInstances.delete(this)
    this.#pendingRooms.clear()
    this.#pendingSidebar = null
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    for (const tx of this.#transactions) {
      try {
        tx.abort()
      } catch {
        // Already committed or aborted.
      }
    }
    this.#transactions.clear()
    this.#releaseOwnerOnce()
    this.#db.close()
  }

  /**
   * Synchronously revokes in-memory key access, queues a strict-durability cryptographic tombstone
   * removing `'owners'` `CryptoKey`s and clearing all stores, and closes the database handle so an
   * immediately following `deleteDatabase` unblocks cleanly.
   */
  revokeAndCloseSync(): Promise<void> {
    notifyVaultSearchEviction({ kind: 'all', ownerKey: this.#ownerKey })
    if (this.#wiping) return this.#writing
    this.#wiping = true
    this.#closed = true
    this.#releasedOwner = true
    openVaultInstances.delete(this)
    this.#pendingRooms.clear()
    this.#pendingSidebar = null
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    for (const tx of this.#transactions) {
      try {
        tx.abort()
      } catch {
        // Already committed or aborted.
      }
    }
    this.#transactions.clear()
    this.#coordinator.revokeAll()
    for (const peer of [...openVaultInstances]) {
      if (peer.#idb === this.#idb) {
        peer.#closed = true
        peer.#releasedOwner = true
        openVaultInstances.delete(peer)
        try {
          peer.#db.close()
        } catch {
          // Ignore close failure.
        }
      }
    }

    const tombstoneDone = this.#coordinator.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          try {
            const tx = this.#db.transaction([...VAULT_STORES], 'readwrite', {
              durability: 'strict',
            })
            const owners = tx.objectStore('owners')
            const getAllReq = owners.getAll()
            getAllReq.onsuccess = () => {
              const rows = Array.isArray(getAllReq.result)
                ? (getAllReq.result as VaultOwnerRow[])
                : []
              let sawSelf = false
              for (const row of rows) {
                if (row && typeof row.ownerKey === 'string') {
                  if (row.ownerKey === this.#ownerKey) sawSelf = true
                  owners.put({
                    ownerKey: row.ownerKey,
                    ownerId: row.ownerId,
                    organisationId: row.organisationId,
                    membershipId: row.membershipId,
                    deviceId: row.deviceId,
                    incarnation: row.incarnation,
                    purgeEpoch: (row.purgeEpoch ?? 0) + 1,
                    status: 'revoked',
                  } satisfies VaultOwnerRow)
                }
              }
              if (!sawSelf) {
                owners.put({
                  ownerKey: this.#ownerKey,
                  ownerId: this.#principal.ownerId,
                  organisationId: this.#principal.organisationId,
                  membershipId: this.#principal.membershipId,
                  deviceId: this.#principal.deviceId,
                  incarnation: this.#cachedIncarnation,
                  purgeEpoch: 1,
                  status: 'revoked',
                } satisfies VaultOwnerRow)
              }
            }
            for (const storeName of [
              'rooms',
              'outbox',
              'drafts',
              'quarantine',
              'search_index',
            ] as const) {
              tx.objectStore(storeName).clear()
            }
            const finish = () => {
              try {
                this.#db.close()
              } catch {
                // Ignore close failure.
              }
              resolve()
            }
            tx.oncomplete = finish
            tx.onabort = finish
            tx.onerror = () => {
              // Handled by onabort.
            }
            // Setting closePending in IDB allows `tx` to commit and closes immediately after.
            this.#db.close()
          } catch {
            try {
              this.#db.close()
            } catch {
              // Ignore close failure.
            }
            resolve()
          }
        })
    )
    this.#writing = this.#writing.then(() => tombstoneDone, () => tombstoneDone)
    return tombstoneDone
  }

  async wipe(): Promise<void> {
    await this.revokeAndCloseSync()
    await wipeEspaceVault(this.#idb)
  }

  #enqueueBackground(work: () => Promise<void>): Promise<void> {
    const op = this.#coordinator.runExclusive(work).catch(() => undefined)
    this.#writing = op
    return op
  }
}

export function openEspaceVault(
  principal: EspaceVaultPrincipal,
  options?: OpenEspaceVaultOptions
): Promise<EspaceVault> {
  return EspaceVault.open(principal, options)
}

function deleteDatabaseAsync(idb: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      if (typeof idb.deleteDatabase !== 'function') {
        resolve()
        return
      }
      const req = idb.deleteDatabase(name)
      if (!req || typeof req !== 'object') {
        resolve()
        return
      }
      req.onsuccess = () => resolve()
      req.onblocked = () => resolve()
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * Cryptographically destroys `'kodera.espace-vault.v1'` (revoking non-extractable `'owners'`
 * `CryptoKey`s with tombstones, clearing `'rooms'`, `'outbox'`, `'drafts'`, `'quarantine'`,
 * closing handles, and deleting `'kodera.espace-vault.v1'` + `'kodera-espace-timelines'`).
 */
export function wipeEspaceVault(
  idb: IDBFactory | undefined = globalThis.indexedDB
): Promise<void> {
  notifyVaultSearchEviction({ kind: 'all' })
  const coordinator = getVaultCoordinator(idb, ESPACE_VAULT_DATABASE)
  coordinator.revokeAll()
  const open = [...openVaultInstances].filter((vault) => vault.matchesIdbFactory(idb))
  const revocations = open.map((vault) => vault.revokeAndCloseSync())

  const cleanup = coordinator.runExclusive(async () => {
    await Promise.all(revocations)
    if (idb !== undefined && open.length === 0 && vaultSupported(idb)) {
      try {
        const db = await openVaultDatabase(idb, { createIfMissing: false })
        if (db !== null) {
          try {
            await runVaultTx(db, 'readwrite', async (tx) => {
              const owners = tx.objectStore('owners')
              const all = (await idbRequest(owners.getAll())) as VaultOwnerRow[]
              for (const row of all) {
                if (row && typeof row.ownerKey === 'string') {
                  await idbRequest(
                    owners.put({
                      ownerKey: row.ownerKey,
                      ownerId: row.ownerId,
                      organisationId: row.organisationId,
                      membershipId: row.membershipId,
                      deviceId: row.deviceId,
                      incarnation: row.incarnation,
                      purgeEpoch: (row.purgeEpoch ?? 0) + 1,
                      status: 'revoked',
                    } satisfies VaultOwnerRow)
                  )
                }
              }
              for (const storeName of [
                'rooms',
                'outbox',
                'drafts',
                'quarantine',
                'search_index',
              ] as const) {
                await idbRequest(tx.objectStore(storeName).clear())
              }
            })
          } finally {
            db.close()
          }
        }
      } catch {
        // Fall through to full database deletion.
      }
    }

    if (idb !== undefined) {
      await Promise.all([
        deleteDatabaseAsync(idb, ESPACE_VAULT_DATABASE),
        deleteDatabaseAsync(idb, LEGACY_TIMELINE_DATABASE),
      ])
    }
  })
  return cleanup
}

function revokeOpenVaultsSynchronously(): void {
  notifyVaultSearchEviction({ kind: 'all' })
  for (const vault of [...openVaultInstances]) {
    void vault.revokeAndCloseSync()
  }
}

registerEspaceVaultCleanup(revokeOpenVaultsSynchronously)
registerLocalSessionCleanup(revokeOpenVaultsSynchronously)

if (typeof indexedDB !== 'undefined') {
  subscribeMatrixSession(() => {
    if (getMatrixSession() === undefined) {
      void wipeEspaceVault()
    }
  })
}

if (typeof BroadcastChannel === 'function') {
  try {
    const channel = new BroadcastChannel(espaceVaultWipeChannelName())
    channel.onmessage = (event: MessageEvent<{ type?: string; senderRealmId?: string }>) => {
      if (event.data?.senderRealmId === ESPACE_VAULT_REALM_ID) return
      revokeOpenVaultsSynchronously()
    }
    // Never prevent Node/Vitest worker exit when BroadcastChannel exists in test runtimes.
    ;(channel as unknown as { unref?: () => void }).unref?.()
  } catch {
    // Ignore restricted BroadcastChannel environments.
  }
}
