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
  | 'local'
  | 'connecting'
  | 'synced'
  | 'offline-buffered'
  | 'reconnecting'
  | 'forbidden'
  | 'closed'

export interface CollabTicketGrant {
  readonly wsUrl: string
  readonly token: string
  readonly expiresAt: string
  readonly role: DocumentAccessRole
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

export interface CollabSessionOptions {
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

export function validateCollabWebSocketUrl(rawUrl: string): {
  readonly ok: true
  readonly normalizedUrl: string
} | {
  readonly ok: false
  readonly reason: 'invalid_url' | 'disallowed_protocol' | 'credentials_forbidden' | 'token_in_query_forbidden'
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

export class CollabSessionController {
  readonly ydoc: Y.Doc
  readonly awareness: Awareness

  private status: CollabConnectionStatus = 'local'
  private role: DocumentAccessRole
  private offlineSynced = false
  private reconnectAttempt = 0
  private refreshedAfter4401 = false
  private destroyed = false
  private ws: WebSocketLike | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private persistence: IndexeddbPersistence | null = null
  private unregisterLogoutCleanup: (() => void) | null = null
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

    this.publishLocalAwareness(null)
    this.cachedSnapshot = this.buildSnapshot()

    this.ydoc.on('update', this.handleDocUpdate)
    this.awareness.on('change', this.handleAwarenessChange)
    this.awareness.on('update', this.handleAwarenessBroadcast)

    const shouldEnableIdb =
      options.enableOfflineBuffer !== false &&
      this.role !== 'viewer' &&
      typeof globalThis.indexedDB !== 'undefined' &&
      typeof globalThis.indexedDB?.open === 'function'

    if (shouldEnableIdb) {
      this.setupOfflinePersistence()
    }
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
      this.unregisterLogoutCleanup = registerLocalSessionCleanup(() => {
        try {
          void persistence.destroy()
        } catch {
          // Ignore teardown errors during logout.
        }
      })
    } catch {
      // IndexedDB unavailable or blocked; continue in-memory + WebSocket sync cleanly.
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

  getSnapshot = (): CollabSessionSnapshot => this.cachedSnapshot

  private buildSnapshot(): CollabSessionSnapshot {
    const peers: CollaboratorPeer[] = []
    for (const [clientId, state] of this.awareness.getStates().entries()) {
      if (clientId === this.ydoc.clientID || !state || typeof state !== 'object') continue
      const userObj = (state as { user?: unknown }).user
      if (!userObj || typeof userObj !== 'object') continue
      const rawUser = userObj as Record<string, unknown>
      const userId = typeof rawUser['id'] === 'string' ? rawUser['id'] : String(clientId)
      const name = typeof rawUser['name'] === 'string' && rawUser['name'].trim() ? rawUser['name'] : userId
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
        this.ws.send(frame)
      } catch {
        this.transitionStatus('offline-buffered')
      }
    } else if (this.fetchSession !== undefined && this.status !== 'forbidden') {
      this.transitionStatus('offline-buffered')
    }
  }

  private handleAwarenessChange = (): void => {
    if (this.destroyed) return
    this.emit()
  }

  private handleAwarenessBroadcast = ({
    added,
    updated,
    removed,
  }: {
    added: number[]
    updated: number[]
    removed: number[]
  }): void => {
    if (this.destroyed || !this.ws || this.ws.readyState !== 1) return
    const changed = [...added, ...updated, ...removed]
    if (changed.length === 0) return
    try {
      this.ws.send(encodeAwarenessFrame(this.awareness, changed))
    } catch {
      // Ignore transient socket error; reconnect handles state resync.
    }
  }

  private transitionStatus(next: CollabConnectionStatus): void {
    if (this.status === next) return
    this.status = next
    this.emit()
  }

  async connect(): Promise<void> {
    if (this.destroyed || !this.fetchSession) return
    this.clearReconnectTimer()
    this.transitionStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting')

    let grant: CollabTicketGrant
    try {
      grant = await this.fetchSession()
    } catch (error) {
      if (this.destroyed) return
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
    if (this.destroyed) return

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

    socket.onopen = () => {
      if (this.destroyed || this.ws !== socket) return
      this.reconnectAttempt = 0
      this.refreshedAfter4401 = false
      try {
        // First frame carries the short-lived session ticket — never in URL query or logs.
        socket.send(JSON.stringify({ type: 'auth', token: grant.token }))
        // Initiate Yjs SyncStep1 handshake.
        socket.send(
          encodeSyncFrame((encoder) => {
            syncProtocol.writeSyncStep1(encoder, this.ydoc)
          })
        )
        socket.send(encodeAwarenessFrame(this.awareness, [this.ydoc.clientID]))
        this.transitionStatus('synced')
      } catch {
        socket.close()
      }
    }

    socket.onmessage = (event: MessageEvent) => {
      if (this.destroyed || this.ws !== socket) return
      const bytes = toUint8Array(event.data)
      if (!bytes || bytes.byteLength === 0) return
      this.handleBinaryFrame(bytes, socket)
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
            const reply = encodeSyncFrame((encoder) => {
              syncProtocol.readSyncStep1(decoder, encoder, this.ydoc)
            })
            if (reply.byteLength > 1 && socket.readyState === 1) {
              socket.send(reply)
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
    if (this.destroyed || !this.fetchSession) return
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
