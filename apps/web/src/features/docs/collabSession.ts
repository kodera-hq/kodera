import type { ConfidentialCollabCipher } from '../confidential/collab-crypto-client'
import { permitsPlaintext, type RoomBoundary } from '../confidential/room-boundary'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { ApiProblem } from '@/api/client'
import {
  DOCS_COLLAB_DATABASE_PREFIX,
  DOCS_COLLAB_REGISTRY_KEY,
  registerDocsCollabCleanup,
  registerLocalSessionCleanup,
} from '@/auth/localSession'
import type { DocumentAccessRole } from './pageTree'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1

export const REMOTE_SYNC_ORIGIN = 'kodera:collab:remote'
export const OFFLINE_CACHE_ORIGIN = 'kodera:collab:idb'

const MAX_REGISTERED_DATABASES = 64
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6

export type CursorPaletteSlot = 1 | 2 | 3 | 4 | 5 | 6

export interface CollaboratorSelectionState {
  readonly anchor: number
  readonly head: number
}

export interface CollaboratorPeer {
  readonly clientId: number
  readonly userId: string
  readonly name: string
  readonly role: DocumentAccessRole
  readonly cursorSlot: CursorPaletteSlot
  readonly selection: CollaboratorSelectionState | null
}

export type CollabConnectionStatus =
  'local' | 'connecting' | 'synced' | 'offline-buffered' | 'reconnecting' | 'forbidden' | 'closed'

export interface CollabTicketGrant {
  readonly wsUrl: string
  readonly token: string
  readonly expiresAt: string
  readonly role: DocumentAccessRole
  readonly confidential?: boolean | undefined
  readonly epoch?: number | null | undefined
}

export interface WebSocketLike {
  binaryType: BinaryType
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

export interface ConfidentialCollabPolicy {
  readonly required: true
  readonly epoch: number
  readonly cipher: ConfidentialCollabCipher | null
}

export interface CollabSessionOptions {
  readonly confidential?: ConfidentialCollabPolicy
  readonly roomBoundary?: RoomBoundary | undefined

  readonly scopeKey: string
  readonly documentId: string
  readonly initialRole?: DocumentAccessRole | undefined
  readonly user: {
    readonly id: string
    readonly name: string
  }
  readonly ydoc?: Y.Doc | undefined
  readonly fetchSession?: (() => Promise<CollabTicketGrant>) | undefined
  readonly webSocketFactory?: ((url: string) => WebSocketLike) | undefined
  readonly enableOfflineBuffer?: boolean | undefined
  readonly maxReconnectAttempts?: number | undefined
  readonly baseBackoffMs?: number | undefined
}

export interface CollabSessionSnapshot {
  readonly status: CollabConnectionStatus
  readonly role: DocumentAccessRole
  readonly peers: readonly CollaboratorPeer[]
  readonly offlineSynced: boolean
  readonly reconnectAttempt: number
}

export function cursorSlotForClient(clientId: number, userId: string): CursorPaletteSlot {
  let hash = Math.abs(clientId)
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  }
  return ((hash % 6) + 1) as CursorPaletteSlot
}

/**
 * Whether the block editor may seed an empty Yjs document from the REST Markdown. With a server
 * session the server's Yjs state is the document: seeding before it arrives writes a second copy
 * that the merge keeps, so every open would duplicate the page. Only a local document, or a
 * server that declined collaboration (`local` after a 404/501), seeds.
 */
export function maySeedFromMarkdown(
  remote: boolean,
  status: CollabConnectionStatus,
  confidential?: ConfidentialCollabPolicy,
  roomBoundary?: RoomBoundary
): boolean {
  return (
    confidential?.required !== true &&
    (roomBoundary === undefined || permitsPlaintext(roomBoundary)) &&
    (!remote || status === 'local')
  )
}

/**
 * Whether a live collaborative Yjs session owns the document body instead of raw REST Markdown.
 */
export function collabSessionOwnsBody(
  remote: boolean,
  status: CollabConnectionStatus,
  confidential?: ConfidentialCollabPolicy,
  roomBoundary?: RoomBoundary
): boolean {
  return !maySeedFromMarkdown(remote, status, confidential, roomBoundary)
}

export function validateCollabWebSocketUrl(rawUrl: string):
  | {
      readonly ok: true
      readonly normalizedUrl: string
    }
  | {
      readonly ok: false
      readonly reason:
        'invalid_url' | 'disallowed_protocol' | 'credentials_forbidden' | 'token_in_query_forbidden'
    } {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials_forbidden' }
  }

  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]'

  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && isLoopback)) {
    return { ok: false, reason: 'disallowed_protocol' }
  }

  // Contract 0.43.0: collab ticket travels in the first WebSocket frame, never in a query string.
  for (const key of parsed.searchParams.keys()) {
    if (/^(token|ticket|access_token|auth)$/i.test(key)) {
      return { ok: false, reason: 'token_in_query_forbidden' }
    }
  }

  return { ok: true, normalizedUrl: parsed.toString() }
}

export function buildDocsOfflineDatabaseName(scopeKey: string, documentId: string): string {
  const safeScope = scopeKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
  const safeDoc = documentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return `${DOCS_COLLAB_DATABASE_PREFIX}${safeScope}:${safeDoc}`
}

export function recordDocsOfflineDatabase(dbName: string): void {
  if (!dbName.startsWith(DOCS_COLLAB_DATABASE_PREFIX)) return
  try {
    const raw = window.localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const existing = Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string =>
            typeof item === 'string' &&
            item.startsWith(DOCS_COLLAB_DATABASE_PREFIX) &&
            item !== dbName
        )
      : []
    const next = [...existing, dbName]
    while (next.length > MAX_REGISTERED_DATABASES) {
      const evicted = next.shift()
      if (evicted) {
        try {
          globalThis.indexedDB?.deleteDatabase(evicted)
        } catch {
          // Best-effort eviction.
        }
      }
    }
    window.localStorage.setItem(DOCS_COLLAB_REGISTRY_KEY, JSON.stringify(next))
  } catch {
    // Ignore restricted storage environments.
  }
}

export function purgeProtectedDocsOfflineDatabases(scopeKey: string, documentId: string): void {
  const targetDb = buildDocsOfflineDatabaseName(scopeKey, documentId)
  const toDelete = new Set<string>([targetDb])

  try {
    const raw = globalThis.localStorage?.getItem(DOCS_COLLAB_REGISTRY_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const kept: string[] = []
        for (const item of parsed) {
          if (typeof item !== 'string' || !item.startsWith(DOCS_COLLAB_DATABASE_PREFIX)) continue
          if (item === targetDb) {
            toDelete.add(item)
          } else {
            kept.push(item)
          }
        }
        if (kept.length > 0) {
          globalThis.localStorage?.setItem(DOCS_COLLAB_REGISTRY_KEY, JSON.stringify(kept))
        } else {
          globalThis.localStorage?.removeItem(DOCS_COLLAB_REGISTRY_KEY)
        }
      }
    }
  } catch {
    // Ignore restricted localStorage environments.
  }

  try {
    const idb = globalThis.indexedDB
    if (idb !== undefined && typeof idb.deleteDatabase === 'function') {
      for (const dbName of toDelete) {
        idb.deleteDatabase(dbName)
      }
      if (typeof idb.databases === 'function') {
        void idb
          .databases()
          .then((entries) => {
            for (const entry of entries) {
              if (
                typeof entry.name === 'string' &&
                entry.name === targetDb &&
                !toDelete.has(entry.name)
              ) {
                try {
                  idb.deleteDatabase(entry.name)
                } catch {
                  // Ignore late IndexedDB refusal.
                }
              }
            }
          })
          .catch(() => {
            // Ignore unsupported databases() enumeration.
          })
      }
    }
  } catch {
    // Ignore restricted IndexedDB environments.
  }
}

export function computeReconnectDelayMs(attempt: number, baseMs = BASE_BACKOFF_MS): number {
  const exp = Math.min(Math.max(0, attempt), 8)
  return Math.min(baseMs * 2 ** exp, MAX_BACKOFF_MS)
}

function encodeSyncFrame(writePayload: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  writePayload(encoder)
  return encoding.toUint8Array(encoder)
}

function encodeAwarenessFrame(awareness: Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_AWARENESS)
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(encoder)
}

const kde1HeaderDecoder = new TextDecoder('utf-8', { fatal: true })
const CONFIDENTIAL_COMPACT_THRESHOLD = 64

interface Kde1OuterHeader {
  readonly epoch: number
  readonly sender: string
  readonly sequence: number
  readonly kind: 0 | 1 | 2 | 3
  readonly ratchet: number
}

function inspectKde1Header(bytes: Uint8Array): Kde1OuterHeader | null {
  if (bytes.byteLength < 35) return null
  if (bytes[0] !== 75 || bytes[1] !== 68 || bytes[2] !== 69 || bytes[3] !== 49) return null
  const size = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0)
  if (size < 1 || size > 1024 || bytes.byteLength < 6 + size + 29) return null
  let parsed: unknown
  let encoded: string
  try {
    encoded = kde1HeaderDecoder.decode(bytes.subarray(6, 6 + size))
    parsed = JSON.parse(encoded)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  const epoch = raw['epoch']
  const sender = raw['sender']
  const sequence = raw['sequence']
  const kind = raw['kind']
  const ratchet = raw['ratchet']
  if (
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    epoch > 0xffffffff ||
    typeof sender !== 'string' ||
    sender.length === 0 ||
    sender.length > 256 ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    (kind !== 0 && kind !== 1 && kind !== 2 && kind !== 3) ||
    typeof ratchet !== 'number' ||
    !Number.isSafeInteger(ratchet) ||
    ratchet < 0 ||
    ratchet > 0xffffffff
  ) {
    return null
  }
  const canonical = JSON.stringify({ epoch, sender, sequence, kind, ratchet })
  if (canonical !== encoded) return null
  return { epoch, sender, sequence, kind, ratchet }
}

export class CollabSessionController {
  readonly ydoc: Y.Doc
  readonly awareness: Awareness

  private status: CollabConnectionStatus = 'local'
  private role: DocumentAccessRole
  private offlineSynced = false
  private reconnectAttempt = 0
  private refreshedAfter4401 = false
  private destroyed = false
  private readonly confidential: ConfidentialCollabPolicy | undefined
  private roomBoundary: RoomBoundary | undefined
  private stickyProtected = false
  private readonly enableOfflineBuffer: boolean
  private connectionGeneration = 0
  private outgoing = Promise.resolve()
  private incoming = Promise.resolve()
  private ws: WebSocketLike | null = null
  private readonly highestOpenedSeqBySenderAndKind = new Map<string, number>()
  private readonly socketSeenDurableKeys = new Set<string>()
  private socketJournalCount = 0
  private uncompactedUpdates = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private persistence: IndexeddbPersistence | null = null
  private unregisterLogoutCleanup: (() => void) | null = null
  private unregisterDocsCleanup: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  private cachedSnapshot: CollabSessionSnapshot

  private readonly scopeKey: string
  private readonly documentId: string
  private readonly user: { readonly id: string; readonly name: string }
  private readonly fetchSession: (() => Promise<CollabTicketGrant>) | undefined
  private readonly webSocketFactory: (url: string) => WebSocketLike
  private readonly maxReconnectAttempts: number
  private readonly baseBackoffMs: number

  constructor(options: CollabSessionOptions) {
    this.confidential = options.confidential
    this.roomBoundary = options.roomBoundary
    this.stickyProtected =
      options.confidential?.required === true ||
      options.roomBoundary === 'confidential-unavailable' ||
      options.roomBoundary === 'invalid'
    this.enableOfflineBuffer = options.enableOfflineBuffer !== false
    this.scopeKey = options.scopeKey
    this.documentId = options.documentId
    this.role = options.initialRole ?? 'editor'
    this.user = options.user
    this.ydoc = options.ydoc ?? new Y.Doc()
    this.awareness = new Awareness(this.ydoc)
    this.fetchSession = options.fetchSession
    this.webSocketFactory =
      options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    this.baseBackoffMs = options.baseBackoffMs ?? BASE_BACKOFF_MS

    // A server-backed session is not local even before `connect()`: an editor that saw `local`
    // would seed the document from Markdown and duplicate it once the server state arrives.
    if (this.fetchSession) this.status = 'connecting'
    const nonOrdinaryBoundary =
      this.roomBoundary !== undefined && !permitsPlaintext(this.roomBoundary)
    if ((this.confidential && !this.hasCipherAuthority()) || (nonOrdinaryBoundary && !this.confidential)) {
      this.status = 'forbidden'
    }
    this.publishLocalAwareness(null)
    this.cachedSnapshot = this.buildSnapshot()

    this.ydoc.on('update', this.handleDocUpdate)
    this.awareness.on('change', this.handleAwarenessChange)
    this.awareness.on('update', this.handleAwarenessBroadcast)

    const forbidsPlaintextPersistence =
      this.confidential?.required === true || nonOrdinaryBoundary
    if (forbidsPlaintextPersistence) {
      purgeProtectedDocsOfflineDatabases(this.scopeKey, this.documentId)
    }

    const shouldEnableIdb =
      !forbidsPlaintextPersistence &&
      this.enableOfflineBuffer &&
      this.role !== 'viewer' &&
      typeof globalThis.indexedDB !== 'undefined' &&
      typeof globalThis.indexedDB?.open === 'function'

    if (shouldEnableIdb) {
      this.setupOfflinePersistence()
    }
  }

  private isPlaintextBoundaryBlocked(): boolean {
    return (
      !this.confidential &&
      (this.stickyProtected ||
        (this.roomBoundary !== undefined && !permitsPlaintext(this.roomBoundary)))
    )
  }

  private setupOfflinePersistence(): void {
    try {
      const dbName = buildDocsOfflineDatabaseName(this.scopeKey, this.documentId)
      recordDocsOfflineDatabase(dbName)
      const persistence = new IndexeddbPersistence(dbName, this.ydoc)
      this.persistence = persistence
      persistence.on('synced', () => {
        if (this.destroyed) return
        this.offlineSynced = true
        this.emit()
      })
      const closePersistence = () => {
        try {
          void persistence.destroy()
        } catch {
          // Ignore teardown errors during logout or principal switch.
        }
      }
      this.unregisterLogoutCleanup = registerLocalSessionCleanup(closePersistence)
      this.unregisterDocsCleanup = registerDocsCollabCleanup(closePersistence)
    } catch {
      // IndexedDB unavailable or blocked; continue in-memory + WebSocket sync cleanly.
    }
  }

  /**
   * Updates the bound Matrix room protection boundary in live production workspaces.
   * Non-ordinary boundaries immediately tear down plaintext Yjs IndexedDB persistence and purge
   * `kodera-docs-yjs:*` databases; sticky confidential/invalid boundaries never downgrade back.
   */
  setRoomBoundary(nextBoundary: RoomBoundary | undefined): void {
    if (this.destroyed) return
    if (nextBoundary === 'confidential-unavailable' || nextBoundary === 'invalid') {
      this.stickyProtected = true
    }
    const effectiveBoundary: RoomBoundary | undefined = this.stickyProtected
      ? nextBoundary === 'confidential-unavailable' || nextBoundary === 'invalid'
        ? nextBoundary
        : 'invalid'
      : nextBoundary
    if (this.roomBoundary === effectiveBoundary) return
    this.roomBoundary = effectiveBoundary

    const nonOrdinaryBoundary =
      this.roomBoundary !== undefined && !permitsPlaintext(this.roomBoundary)
    const forbidsPlaintextPersistence =
      this.confidential?.required === true || nonOrdinaryBoundary || this.stickyProtected

    if (forbidsPlaintextPersistence) {
      this.destroyOfflinePersistenceAndPurge()
      if (!this.confidential) {
        const socket = this.ws
        this.ws = null
        ++this.connectionGeneration
        this.clearReconnectTimer()
        this.transitionStatus('forbidden')
        socket?.close(4403, 'protected collaboration refused')
      }
      return
    }

    // Cold-start `'unknown'` resolved to positively verified `'ordinary' | 'community'`:
    if (
      this.persistence === null &&
      this.enableOfflineBuffer &&
      this.role !== 'viewer' &&
      typeof globalThis.indexedDB !== 'undefined' &&
      typeof globalThis.indexedDB?.open === 'function'
    ) {
      this.setupOfflinePersistence()
    }
    if (!this.confidential && this.status === 'forbidden') {
      this.transitionStatus(this.fetchSession ? 'connecting' : 'local')
    }
  }

  private publishLocalAwareness(selection: CollaboratorSelectionState | null): void {
    const slot = cursorSlotForClient(this.ydoc.clientID, this.user.id)
    this.awareness.setLocalState({
      user: {
        id: this.user.id,
        name: this.user.name,
        role: this.role,
        cursorSlot: slot,
      },
      selection: this.role === 'viewer' ? null : selection,
    })
  }

  updateSelection(selection: CollaboratorSelectionState | null): void {
    if (this.destroyed) return
    this.publishLocalAwareness(selection)
  }

  setRole(nextRole: DocumentAccessRole): void {
    if (this.role === nextRole) return
    this.role = nextRole
    this.publishLocalAwareness(null)
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Local Markdown must not seed a second copy before the offline Yjs state has arrived. */
  get offlineCacheReady(): boolean {
    return this.persistence === null || this.offlineSynced
  }

  getSnapshot = (): CollabSessionSnapshot => this.cachedSnapshot

  private buildSnapshot(): CollabSessionSnapshot {
    const peers: CollaboratorPeer[] = []
    for (const [clientId, state] of this.awareness.getStates().entries()) {
      if (clientId === this.ydoc.clientID || !state || typeof state !== 'object') continue
      const userObj = (state as { user?: unknown }).user
      if (!userObj || typeof userObj !== 'object') continue
      const rawUser = userObj as Record<string, unknown>
      const userId = typeof rawUser['id'] === 'string' ? rawUser['id'] : String(clientId)
      const name =
        typeof rawUser['name'] === 'string' && rawUser['name'].trim() ? rawUser['name'] : userId
      const peerRole: DocumentAccessRole = rawUser['role'] === 'viewer' ? 'viewer' : 'editor'
      const rawSlot = rawUser['cursorSlot']
      const cursorSlot: CursorPaletteSlot =
        typeof rawSlot === 'number' && rawSlot >= 1 && rawSlot <= 6
          ? (rawSlot as CursorPaletteSlot)
          : cursorSlotForClient(clientId, userId)

      const selObj = (state as { selection?: unknown }).selection
      let selection: CollaboratorSelectionState | null = null
      if (selObj && typeof selObj === 'object') {
        const anchor = (selObj as Record<string, unknown>)['anchor']
        const head = (selObj as Record<string, unknown>)['head']
        if (typeof anchor === 'number' && typeof head === 'number') {
          selection = { anchor, head }
        }
      }

      peers.push({
        clientId,
        userId,
        name,
        role: peerRole,
        cursorSlot,
        selection,
      })
    }

    return {
      status: this.status,
      role: this.role,
      peers,
      offlineSynced: this.offlineSynced,
      reconnectAttempt: this.reconnectAttempt,
    }
  }

  private emit(): void {
    this.cachedSnapshot = this.buildSnapshot()
    for (const listener of this.listeners) {
      listener()
    }
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (this.destroyed) return
    // Strict viewer read-only rule: never transmit Yjs document update frames in viewer mode!
    if (this.role === 'viewer') return
    if (origin === REMOTE_SYNC_ORIGIN) return

    if (this.ws && this.ws.readyState === 1) {
      const frame = encodeSyncFrame((encoder) => {
        syncProtocol.writeUpdate(encoder, update)
      })
      try {
        this.sendFrame(frame, this.ws)
      } catch {
        this.transitionStatus('offline-buffered')
      }
    } else if (
      this.fetchSession !== undefined &&
      this.status !== 'forbidden' &&
      // `local` is final: the server declined collaboration and nothing reconnects, so the page is
      // saved as Markdown over REST. Marking an edit there as buffered would stop that save.
      this.status !== 'local'
    ) {
      this.transitionStatus('offline-buffered')
    }
  }

  private handleAwarenessChange = (): void => {
    if (this.destroyed) return
    this.emit()
  }

  private handleAwarenessBroadcast = (
    {
      added,
      updated,
      removed,
    }: {
      added: number[]
      updated: number[]
      removed: number[]
    },
    origin: unknown
  ): void => {
    if (this.destroyed || !this.ws || this.ws.readyState !== 1) return
    // The server binds one presence identity to each socket and closes a socket that sends any
    // other (`presence.mjs`). Applying a peer's state, or expiring it, fires this same event, so
    // only this client's own state is ever sent back.
    if (origin === REMOTE_SYNC_ORIGIN) return
    const ownId = this.ydoc.clientID
    const changed = [...added, ...updated, ...removed].filter((clientId) => clientId === ownId)
    if (changed.length === 0) return
    try {
      this.sendFrame(encodeAwarenessFrame(this.awareness, changed), this.ws)
    } catch {
      // Ignore transient socket error; reconnect handles state resync.
    }
  }

  private transitionStatus(next: CollabConnectionStatus): void {
    if (this.status === next) return
    this.status = next
    this.emit()
  }

  private hasCipherAuthority(): boolean {
    const policy = this.confidential
    if (!policy) return true
    const cipher = policy.cipher
    return (
      cipher !== null &&
      cipher.epoch === policy.epoch &&
      cipher.senderClientId === this.ydoc.clientID &&
      cipher.scopeKey === this.scopeKey &&
      cipher.documentId === this.documentId &&
      cipher.isActive()
    )
  }

  private currentSocket(socket: WebSocketLike): boolean {
    return (
      !this.destroyed &&
      this.ws === socket &&
      this.status !== 'forbidden' &&
      socket.readyState === 1 &&
      this.hasCipherAuthority()
    )
  }

  private destroyOfflinePersistenceAndPurge(): void {
    if (this.unregisterLogoutCleanup) {
      this.unregisterLogoutCleanup()
      this.unregisterLogoutCleanup = null
    }
    if (this.unregisterDocsCleanup) {
      this.unregisterDocsCleanup()
      this.unregisterDocsCleanup = null
    }
    if (this.persistence) {
      try {
        void this.persistence.destroy()
      } catch {
        // Ignore IDB destroy errors.
      }
      this.persistence = null
    }
    this.offlineSynced = false
    purgeProtectedDocsOfflineDatabases(this.scopeKey, this.documentId)
  }

  private quarantine(): void {
    this.destroyOfflinePersistenceAndPurge()
    const socket = this.ws
    this.ws = null
    ++this.connectionGeneration
    this.clearReconnectTimer()
    this.transitionStatus('forbidden')
    this.confidential?.cipher?.close()
    socket?.close(4403, 'protected collaboration refused')
  }

  compactConfidentialCheckpoint(): void {
    if (
      this.destroyed ||
      !this.confidential ||
      this.role !== 'editor' ||
      this.socketJournalCount <= 0
    ) {
      return
    }
    const socket = this.ws
    const cipher = this.confidential.cipher
    if (!socket || !this.currentSocket(socket) || cipher === null) return
    const targetSequence = this.socketJournalCount
    this.uncompactedUpdates = 0
    this.outgoing = this.outgoing.then(async () => {
      let checkpointPlain: Uint8Array | undefined
      try {
        if (!this.currentSocket(socket) || this.role !== 'editor' || targetSequence <= 0) return
        checkpointPlain = encodeSyncFrame((encoder) => {
          syncProtocol.writeSyncStep2(encoder, this.ydoc)
        })
        const sealed = await cipher.seal(checkpointPlain, {
          checkpoint: true,
          sequence: targetSequence,
        })
        if (!this.currentSocket(socket)) return
        if (sealed[0] !== 75 || sealed[1] !== 68 || sealed[2] !== 69 || sealed[3] !== 49) {
          throw new Error('invalid protected checkpoint envelope')
        }
        socket.send(sealed)
      } catch {
        if (this.ws === socket) this.quarantine()
      } finally {
        checkpointPlain?.fill(0)
      }
    })
  }

  private sendFrame(frame: Uint8Array, socket: WebSocketLike): void {
    if (!this.confidential) {
      socket.send(frame)
      return
    }
    const cipher = this.confidential.cipher
    // Queue ownership preserves sender sequence order across asynchronous worker calls.
    const owned = frame.slice()
    this.outgoing = this.outgoing.then(async () => {
      try {
        if (!this.currentSocket(socket) || cipher === null) {
          if (this.ws === socket) this.quarantine()
          return
        }
        const sealed = await cipher.seal(owned)
        if (!this.currentSocket(socket)) {
          if (this.ws === socket) this.quarantine()
          return
        }
        if (sealed[0] !== 75 || sealed[1] !== 68 || sealed[2] !== 69 || sealed[3] !== 49) {
          throw new Error('invalid protected envelope')
        }
        socket.send(sealed)
      } catch {
        if (this.ws === socket) this.quarantine()
      } finally {
        owned.fill(0)
      }
    })
  }

  private receiveFrame(bytes: Uint8Array, socket: WebSocketLike): void {
    if (!this.confidential) {
      this.handleBinaryFrame(bytes, socket)
      return
    }
    if (bytes[0] !== 75 || bytes[1] !== 68 || bytes[2] !== 69 || bytes[3] !== 49) {
      this.quarantine()
      return
    }
    const cipher = this.confidential.cipher
    const owned = bytes.slice()
    const policyEpoch = this.confidential.epoch
    this.incoming = this.incoming.then(async () => {
      let plaintext: Uint8Array | undefined
      try {
        if (!this.currentSocket(socket) || cipher === null) {
          if (this.ws === socket) this.quarantine()
          return
        }
        const header = inspectKde1Header(owned)
        if (header !== null && header.epoch === policyEpoch) {
          if (header.kind === 3) {
            this.socketJournalCount += 1
            this.uncompactedUpdates = 0
          } else if (header.kind === 0) {
            const durableKey = `${header.sender}:${header.sequence}`
            if (!this.socketSeenDurableKeys.has(durableKey)) {
              this.socketSeenDurableKeys.add(durableKey)
              this.socketJournalCount += 1
              this.uncompactedUpdates += 1
            }
          }
          if (header.kind !== 3) {
            const selfSender = String(this.ydoc.clientID)
            const senderKindKey = `${header.sender}:${header.kind}`
            const highest = this.highestOpenedSeqBySenderAndKind.get(senderKindKey)
            if (
              header.sender === selfSender ||
              (highest !== undefined && header.sequence <= highest)
            ) {
              if (header.kind === 0) {
                this.transitionStatus('synced')
                if (
                  this.role === 'editor' &&
                  this.uncompactedUpdates >= CONFIDENTIAL_COMPACT_THRESHOLD
                ) {
                  this.compactConfidentialCheckpoint()
                }
              }
              return
            }
          }
        }
        plaintext = await cipher.open(owned)
        if (!this.currentSocket(socket)) {
          if (this.ws === socket) this.quarantine()
          return
        }
        if (plaintext[0] !== MSG_SYNC && plaintext[0] !== MSG_AWARENESS && plaintext[0] !== 3) {
          throw new Error('invalid protected frame')
        }
        if (header !== null && header.kind !== 3) {
          const senderKindKey = `${header.sender}:${header.kind}`
          const prev = this.highestOpenedSeqBySenderAndKind.get(senderKindKey) ?? 0
          if (header.sequence > prev) {
            this.highestOpenedSeqBySenderAndKind.set(senderKindKey, header.sequence)
          }
        }
        this.handleBinaryFrame(plaintext, socket)
        if (header !== null && (header.kind === 0 || header.kind === 3)) {
          this.transitionStatus('synced')
        }
        if (this.role === 'editor' && this.uncompactedUpdates >= CONFIDENTIAL_COMPACT_THRESHOLD) {
          this.compactConfidentialCheckpoint()
        }
      } catch {
        if (this.ws === socket) this.quarantine()
      } finally {
        plaintext?.fill(0)
        owned.fill(0)
      }
    })
  }

  async connect(): Promise<void> {
    if (this.destroyed || !this.fetchSession || this.status === 'forbidden') return
    if (!this.hasCipherAuthority() || this.isPlaintextBoundaryBlocked()) {
      this.quarantine()
      return
    }
    const generation = ++this.connectionGeneration
    this.clearReconnectTimer()
    this.transitionStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting')

    let grant: CollabTicketGrant
    try {
      grant = await this.fetchSession()
    } catch (error) {
      if (this.destroyed || generation !== this.connectionGeneration) return
      if (this.confidential || this.isPlaintextBoundaryBlocked()) {
        this.quarantine()
        return
      }
      if (error instanceof ApiProblem && error.status === 403) {
        this.role = 'viewer'
        this.publishLocalAwareness(null)
        this.transitionStatus('forbidden')
        return
      }
      if (error instanceof ApiProblem && (error.status === 501 || error.status === 404)) {
        this.transitionStatus('local')
        return
      }
      this.scheduleReconnect()
      return
    }
    if (this.destroyed || generation !== this.connectionGeneration) return
    if (!this.hasCipherAuthority() || this.isPlaintextBoundaryBlocked()) {
      this.quarantine()
      return
    }
    if (grant.confidential !== undefined) {
      if (grant.confidential !== Boolean(this.confidential?.required)) {
        this.quarantine()
        return
      }
      if (
        grant.confidential &&
        (typeof grant.epoch !== 'number' ||
          !Number.isSafeInteger(grant.epoch) ||
          grant.epoch !== this.confidential?.epoch)
      ) {
        this.quarantine()
        return
      }
      if (!grant.confidential && grant.epoch !== undefined && grant.epoch !== null) {
        this.quarantine()
        return
      }
    }

    this.role = grant.role
    this.publishLocalAwareness(null)

    const validated = validateCollabWebSocketUrl(grant.wsUrl)
    if (!validated.ok) {
      this.transitionStatus('forbidden')
      return
    }

    let socket: WebSocketLike
    try {
      socket = this.webSocketFactory(validated.normalizedUrl)
    } catch {
      this.scheduleReconnect()
      return
    }

    socket.binaryType = 'arraybuffer'
    this.ws = socket
    this.socketSeenDurableKeys.clear()
    this.socketJournalCount = 0
    this.uncompactedUpdates = 0

    socket.onopen = () => {
      if (this.destroyed || this.ws !== socket) return
      if (!this.hasCipherAuthority()) {
        this.quarantine()
        return
      }
      this.reconnectAttempt = 0
      this.refreshedAfter4401 = false
      try {
        // First frame carries the short-lived session ticket — never in URL query or logs.
        socket.send(JSON.stringify({ type: 'auth', token: grant.token }))
        // Initiate Yjs SyncStep1 handshake; confidential viewers receive opaque KDE1 replays
        // directly from the relay and never emit kind===0 sync frames.
        if (!this.confidential || this.role === 'editor') {
          this.sendFrame(
            encodeSyncFrame((encoder) => {
              syncProtocol.writeSyncStep1(encoder, this.ydoc)
            }),
            socket
          )
        }
        this.sendFrame(encodeAwarenessFrame(this.awareness, [this.ydoc.clientID]), socket)
        if (this.confidential) {
          this.transitionStatus('synced')
        }
        // For plaintext sessions, `synced` waits for the server's state (sync step 2).
      } catch {
        socket.close()
      }
    }

    socket.onmessage = (event: MessageEvent) => {
      if (this.destroyed || this.ws !== socket) return
      const bytes = toUint8Array(event.data)
      if (!bytes || bytes.byteLength === 0) return
      this.receiveFrame(bytes, socket)
    }

    socket.onerror = () => {
      // `onclose` always follows `onerror` in WebSocket lifecycle and drives backoff.
    }

    socket.onclose = (event: CloseEvent) => {
      if (this.destroyed || this.ws !== socket) return
      this.ws = null

      if (event.code === 4403) {
        this.transitionStatus('forbidden')
        return
      }
      if (event.code === 4401) {
        if (!this.refreshedAfter4401) {
          this.refreshedAfter4401 = true
          void this.connect()
        } else {
          this.transitionStatus('forbidden')
        }
        return
      }

      this.scheduleReconnect()
    }
  }

  private handleBinaryFrame(bytes: Uint8Array, socket: WebSocketLike): void {
    try {
      const decoder = decoding.createDecoder(bytes)
      const messageType = decoding.readVarUint(decoder)

      if (messageType === MSG_SYNC) {
        const syncKind = decoding.readVarUint(decoder)
        if (syncKind === syncProtocol.messageYjsSyncStep1) {
          // Only editors answer SyncStep1 with SyncStep2; viewers never transmit document updates.
          if (this.role === 'editor') {
            if (this.confidential) {
              const peerVector = decoding.readVarUint8Array(decoder)
              const diff = Y.encodeStateAsUpdate(this.ydoc, peerVector)
              const isEmptyDiff =
                diff.byteLength === 2 && diff[0] === 0 && diff[1] === 0
              if (!isEmptyDiff && socket.readyState === 1) {
                const reply = encodeSyncFrame((encoder) => {
                  encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2)
                  encoding.writeVarUint8Array(encoder, diff)
                })
                this.sendFrame(reply, socket)
              }
            } else {
              const reply = encodeSyncFrame((encoder) => {
                syncProtocol.readSyncStep1(decoder, encoder, this.ydoc)
              })
              if (reply.byteLength > 1 && socket.readyState === 1) {
                this.sendFrame(reply, socket)
              }
            }
          }
        } else if (syncKind === syncProtocol.messageYjsSyncStep2) {
          syncProtocol.readSyncStep2(decoder, this.ydoc, REMOTE_SYNC_ORIGIN)
          this.transitionStatus('synced')
        } else if (syncKind === syncProtocol.messageYjsUpdate) {
          syncProtocol.readUpdate(decoder, this.ydoc, REMOTE_SYNC_ORIGIN)
        }
      } else if (messageType === MSG_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder)
        applyAwarenessUpdate(this.awareness, update, REMOTE_SYNC_ORIGIN)
      }
    } catch {
      // Malformed binary frame ignored safely.
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || !this.fetchSession || this.status === 'forbidden') return
    if (!this.hasCipherAuthority()) {
      this.quarantine()
      return
    }
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.transitionStatus('offline-buffered')
      return
    }
    const delayMs = computeReconnectDelayMs(this.reconnectAttempt, this.baseBackoffMs)
    this.reconnectAttempt += 1
    this.transitionStatus('offline-buffered')
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) {
        void this.connect()
      }
    }, delayMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    ++this.connectionGeneration
    this.confidential?.cipher?.close()
    this.clearReconnectTimer()
    this.ydoc.off('update', this.handleDocUpdate)
    this.awareness.off('change', this.handleAwarenessChange)
    this.awareness.off('update', this.handleAwarenessBroadcast)
    try {
      removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'local-destroy')
    } catch {
      // Ignore awareness cleanup failures.
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'closed')
      } catch {
        // Ignore close errors.
      }
      this.ws = null
    }
    if (this.unregisterLogoutCleanup) {
      this.unregisterLogoutCleanup()
      this.unregisterLogoutCleanup = null
    }
    if (this.persistence) {
      try {
        void this.persistence.destroy()
      } catch {
        // Ignore IDB destroy errors.
      }
      this.persistence = null
    }
    this.status = 'closed'
    this.listeners.clear()
  }
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}
