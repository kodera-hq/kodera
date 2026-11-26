import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { DOCS_COLLAB_REGISTRY_KEY, clearLocalSessionStorage } from '@/auth/localSession'
import {
  CollabSessionController,
  MSG_SYNC,
  buildDocsOfflineDatabaseName,
  collabSessionOwnsBody,
  computeReconnectDelayMs,
  maySeedFromMarkdown,
  recordDocsOfflineDatabase,
  purgeProtectedDocsOfflineDatabases,
  validateCollabWebSocketUrl,
  type WebSocketLike,
} from './collabSession'

// Persist real Yjs updates across controller lifetimes. Deleting a database removes
// its updates, just as eviction would in a browser.
const offlineUpdates = new Map<string, Uint8Array[]>()
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    constructor(private name: string, private doc: Y.Doc) {
      this.doc.on('update', this.store)
    }
    private store = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return
      const updates = offlineUpdates.get(this.name) ?? []
      updates.push(update)
      offlineUpdates.set(this.name, updates)
    }
    on(_event: 'synced', callback: () => void) {
      for (const update of offlineUpdates.get(this.name) ?? []) {
        Y.applyUpdate(this.doc, update, this)
      }
      callback()
    }
    destroy() {
      this.doc.off('update', this.store)
    }
  },
}))

/** The server's state answer (sync step 2), the frame that makes a session `synced`. */
function serverState(): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC)
  syncProtocol.writeSyncStep2(encoder, new Y.Doc())
  return encoding.toUint8Array(encoder)
}

class MockCollabSocket implements WebSocketLike {
  binaryType: BinaryType = 'arraybuffer'
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  readonly sentFrames: (string | Uint8Array)[] = []
  private readonly onSendToHub: (sender: MockCollabSocket, payload: string | Uint8Array) => void

  constructor(onSendToHub: (sender: MockCollabSocket, payload: string | Uint8Array) => void) {
    this.onSendToHub = onSendToHub
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  send(data: string | Uint8Array): void {
    this.sentFrames.push(data)
    this.onSendToHub(this, data)
  }

  receive(data: Uint8Array): void {
    if (this.readyState !== 1) return
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }
}

class InMemoryCollabRelay {
  readonly sockets: MockCollabSocket[] = []

  connect = (): WebSocketLike => {
    const sock = new MockCollabSocket((sender, payload) => {
      if (typeof payload === 'string') return
      for (const peer of this.sockets) {
        if (peer !== sender && peer.readyState === 1) {
          peer.receive(payload)
        }
      }
    })
    this.sockets.push(sock)
    queueMicrotask(() => sock.open())
    return sock
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  offlineUpdates.clear()
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('CollabSessionController and Yjs transport rules', () => {
  it('validates WebSocket URLs and refuses query-string tokens, credentials, and insecure origins', () => {
    expect(validateCollabWebSocketUrl('wss://collab.kodera.io/ws/doc-1')).toEqual({
      ok: true,
      normalizedUrl: 'wss://collab.kodera.io/ws/doc-1',
    })
    expect(validateCollabWebSocketUrl('ws://localhost:8787/ws/doc-1').ok).toBe(true)
    expect(validateCollabWebSocketUrl('ws://collab.kodera.io/ws/doc-1')).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })
    expect(validateCollabWebSocketUrl('https://collab.kodera.io/ws/doc-1')).toEqual({
      ok: false,
      reason: 'disallowed_protocol',
    })
    expect(validateCollabWebSocketUrl('wss://user:secret@collab.kodera.io/ws/doc-1')).toEqual({
      ok: false,
      reason: 'credentials_forbidden',
    })
    expect(
      validateCollabWebSocketUrl('wss://collab.kodera.io/ws/doc-1?token=secret-ticket')
    ).toEqual({
      ok: false,
      reason: 'token_in_query_forbidden',
    })
  })

  it('synchronizes Y.Doc updates and collaborator awareness across WebSocket peers with first-frame auth', async () => {
    const relay = new InMemoryCollabRelay()

    const alice = new CollabSessionController({
      scopeKey: 'org-1',
      documentId: 'doc-1',
      user: { id: 'u-alice', name: 'Alice' },
      enableOfflineBuffer: false,
      fetchSession: async () => ({
        wsUrl: 'wss://collab.kodera.io/ws/doc-1',
        token: 'ticket-alice',
        expiresAt: '2099-01-01T00:00:00Z',
        role: 'editor',
      }),
      webSocketFactory: relay.connect,
    })

    const bob = new CollabSessionController({
      scopeKey: 'org-1',
      documentId: 'doc-1',
      user: { id: 'u-bob', name: 'Bob' },
      enableOfflineBuffer: false,
      fetchSession: async () => ({
        wsUrl: 'wss://collab.kodera.io/ws/doc-1',
        token: 'ticket-bob',
        expiresAt: '2099-01-01T00:00:00Z',
        role: 'editor',
      }),
      webSocketFactory: relay.connect,
    })

    await alice.connect()
    await bob.connect()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // First frame on each socket is the JSON auth ticket, never in URL.
    expect(relay.sockets[0]?.sentFrames[0]).toBe(
      JSON.stringify({ type: 'auth', token: 'ticket-alice' })
    )
    expect(relay.sockets[1]?.sentFrames[0]).toBe(
      JSON.stringify({ type: 'auth', token: 'ticket-bob' })
    )

    alice.ydoc.getText('body').insert(0, 'Shared architecture note')
    alice.updateSelection({ anchor: 4, head: 12 })

    expect(bob.ydoc.getText('body').toString()).toBe('Shared architecture note')
    expect(bob.getSnapshot().status).toBe('synced')
    expect(bob.getSnapshot().peers).toEqual([
      expect.objectContaining({
        userId: 'u-alice',
        name: 'Alice',
        role: 'editor',
        selection: { anchor: 4, head: 12 },
      }),
    ])

    alice.destroy()
    bob.destroy()
  })

  it('never transmits Yjs document update frames when connected in strict viewer mode', async () => {
    const relay = new InMemoryCollabRelay()

    const editorPeer = new CollabSessionController({
      scopeKey: 'org-1',
      documentId: 'doc-ro',
      user: { id: 'u-editor', name: 'Editor' },
      enableOfflineBuffer: false,
      fetchSession: async () => ({
        wsUrl: 'wss://collab.kodera.io/ws/doc-ro',
        token: 'ticket-ed',
        expiresAt: '2099-01-01T00:00:00Z',
        role: 'editor',
      }),
      webSocketFactory: relay.connect,
    })
    editorPeer.ydoc.getText('body').insert(0, 'Authoritative text')

    const viewerPeer = new CollabSessionController({
      scopeKey: 'org-1',
      documentId: 'doc-ro',
      initialRole: 'viewer',
      user: { id: 'u-viewer', name: 'Viewer' },
      enableOfflineBuffer: false,
      fetchSession: async () => ({
        wsUrl: 'wss://collab.kodera.io/ws/doc-ro',
        token: 'ticket-vw',
        expiresAt: '2099-01-01T00:00:00Z',
        role: 'viewer',
      }),
      webSocketFactory: relay.connect,
    })

    await editorPeer.connect()
    await viewerPeer.connect()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Viewer receives authoritative updates from editor.
    expect(viewerPeer.ydoc.getText('body').toString()).toBe('Authoritative text')
    expect(viewerPeer.getSnapshot().role).toBe('viewer')

    const viewerSocket = relay.sockets[1]!
    const baselineFrameCount = viewerSocket.sentFrames.length

    // Even if someone mutates the viewer's Y.Doc or selection programmatically,
    // zero outbound Yjs sync update frames (syncKind 1 or 2) are ever sent.
    viewerPeer.ydoc.getText('body').insert(0, 'Attempted write ')
    viewerPeer.updateSelection({ anchor: 1, head: 5 })

    const subsequentSyncUpdates = viewerSocket.sentFrames
      .slice(baselineFrameCount)
      .filter((frame): frame is Uint8Array => {
        if (!(frame instanceof Uint8Array)) return false
        const dec = decoding.createDecoder(frame)
        const msgType = decoding.readVarUint(dec)
        if (msgType !== MSG_SYNC) return false
        const syncKind = decoding.readVarUint(dec)
        return syncKind !== 0
      })

    expect(subsequentSyncUpdates).toHaveLength(0)
    expect(editorPeer.ydoc.getText('body').toString()).toBe('Authoritative text')

    editorPeer.destroy()
    viewerPeer.destroy()
  })

  it('buffers offline edits during disconnects, refreshes once on 4401, and stops on 4403', async () => {
    vi.useFakeTimers()
    expect(computeReconnectDelayMs(0, 500)).toBe(500)
    expect(computeReconnectDelayMs(3, 500)).toBe(4_000)
    expect(computeReconnectDelayMs(9, 500)).toBe(8_000)

    const sockets: MockCollabSocket[] = []
    let sessionFetches = 0

    const ctrl = new CollabSessionController({
      scopeKey: 'org-1',
      documentId: 'doc-backoff',
      user: { id: 'u-1', name: 'Member' },
      enableOfflineBuffer: false,
      baseBackoffMs: 100,
      maxReconnectAttempts: 3,
      fetchSession: async () => {
        sessionFetches += 1
        return {
          wsUrl: 'wss://collab.kodera.io/ws/doc-backoff',
          token: `ticket-${sessionFetches}`,
          expiresAt: '2099-01-01T00:00:00Z',
          role: 'editor',
        }
      },
      webSocketFactory: () => {
        const s = new MockCollabSocket(() => undefined)
        sockets.push(s)
        return s
      },
    })

    expect(ctrl.getSnapshot().status).toBe('connecting')
    await ctrl.connect()
    sockets[0]?.open()
    // An open socket has delivered nothing yet: only the server's state makes the session synced.
    expect(ctrl.getSnapshot().status).toBe('connecting')
    sockets[0]?.receive(serverState())
    expect(ctrl.getSnapshot().status).toBe('synced')

    // Unexpected network drop transitions to `offline-buffered` and schedules bounded reconnect.
    sockets[0]?.close(1006, 'abnormal')
    ctrl.ydoc.getText('body').insert(0, 'Buffered while offline')
    expect(ctrl.getSnapshot().status).toBe('offline-buffered')

    await vi.advanceTimersByTimeAsync(100)
    expect(sessionFetches).toBe(2)
    sockets[1]?.open()
    sockets[1]?.receive(serverState())
    expect(ctrl.getSnapshot().status).toBe('synced')

    // 4401 refreshes ticket immediately once; 4403 transitions to `forbidden` with no retry.
    sockets[1]?.close(4401, 'expired')
    await Promise.resolve()
    await Promise.resolve()
    expect(sessionFetches).toBe(3)
    sockets[2]?.close(4403, 'forbidden')
    expect(ctrl.getSnapshot().status).toBe('forbidden')

    ctrl.destroy()
  })

  it('preserves a released offline edit until the server confirms it', async () => {
    const deleteDatabase = vi.fn((name: string) => offlineUpdates.delete(name))
    vi.stubGlobal('indexedDB', { open: vi.fn(), deleteDatabase })
    const sockets: MockCollabSocket[] = []
    const makeSession = (documentId: string) => new CollabSessionController({
      documentId, scopeKey: 'org', user: { id: 'editor', name: 'Editor' },
      fetchSession: async () => ({
        wsUrl: 'wss://example.test/collab', token: 'ticket', role: 'editor', expiresAt: '',
      }),
      webSocketFactory: () => {
        const socket = new MockCollabSocket(() => undefined)
        sockets.push(socket)
        return socket
      },
    })
    const churn = (prefix: string) => {
      for (let i = 0; i < 65; i++) makeSession(prefix + i).destroy()
    }
    const name = buildDocsOfflineDatabaseName('org', 'draft')
    const draft = makeSession('draft')
    await draft.connect()
    sockets[0]!.open()
    sockets[0]!.receive(serverState())
    sockets[0]!.close(1006)
    draft.ydoc.getText('body').insert(0, 'Offline-only edit')
    draft.destroy()
    churn('clean')
    expect(deleteDatabase).toHaveBeenCalled()
    expect(deleteDatabase).not.toHaveBeenCalledWith(name)

    const reopened = makeSession('draft')
    expect(reopened.ydoc.getText('body').toString()).toBe('Offline-only edit')
    await reopened.connect()
    sockets[1]!.open()
    sockets[1]!.receive(serverState())
    expect(reopened.getSnapshot().status).toBe('synced')
    reopened.destroy()
    churn('before-ack')
    expect(deleteDatabase).not.toHaveBeenCalledWith(name)

    const finalSession = makeSession('draft')
    await finalSession.connect()
    const socket = sockets[2]!
    socket.open()
    socket.receive(serverState())
    const server = new Y.Doc()
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MSG_SYNC)
    syncProtocol.writeSyncStep1(encoder, server)
    socket.receive(encoding.toUint8Array(encoder))
    const reply = decoding.createDecoder(socket.sentFrames.at(-1) as Uint8Array)
    expect(decoding.readVarUint(reply)).toBe(MSG_SYNC)
    expect(decoding.readVarUint(reply)).toBe(syncProtocol.messageYjsSyncStep2)
    const committed = decoding.readVarUint8Array(reply)
    Y.applyUpdate(server, committed)
    expect(server.getText('body').toString()).toBe('Offline-only edit')
    const echo = encoding.createEncoder()
    encoding.writeVarUint(echo, MSG_SYNC)
    syncProtocol.writeUpdate(echo, committed)
    socket.receive(encoding.toUint8Array(echo))
    finalSession.destroy()
    churn('after-ack')
    expect(deleteDatabase).toHaveBeenCalledWith(name)
    server.destroy()
  })

  it('stops after the refreshed socket opens and rejects its ticket before sync', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sockets: MockCollabSocket[] = []
    const fetchSession = vi.fn(async () => ({
      wsUrl: 'wss://example.test/collab', token: 'ticket', role: 'editor' as const, expiresAt: '',
    }))
    const ctrl = new CollabSessionController({
      documentId: 'revoked', scopeKey: 'org', user: { id: 'editor', name: 'Editor' },
      enableOfflineBuffer: false, fetchSession,
      webSocketFactory: () => {
        const socket = new MockCollabSocket(() => undefined)
        sockets.push(socket)
        return socket
      },
    })
    await ctrl.connect()
    sockets[0]!.open()
    sockets[0]!.close(4401)
    await Promise.resolve()
    sockets[1]!.open()
    sockets[1]!.close(4401)
    expect(ctrl.getSnapshot().status).toBe('forbidden')
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchSession).toHaveBeenCalledTimes(2)
    ctrl.destroy()
  })

  it('wipes registered Yjs IndexedDB databases on sign-out via clearLocalSessionStorage', () => {
    const deleteDatabase = vi.fn()
    vi.stubGlobal('indexedDB', {
      deleteDatabase,
    })

    const dbA = buildDocsOfflineDatabaseName('org-alpha', 'doc-spec')
    const dbB = buildDocsOfflineDatabaseName('org-alpha', 'doc-runbook')
    recordDocsOfflineDatabase(dbA)
    recordDocsOfflineDatabase(dbB)

    expect(JSON.parse(window.localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY) ?? '[]')).toEqual([
      dbA,
      dbB,
    ])

    // Verify Y.Doc binary snapshot round-trip for offline buffer integrity
    const offlineDoc = new Y.Doc()
    offlineDoc.getText('content').insert(0, 'Offline draft')
    const snapshot = Y.encodeStateAsUpdate(offlineDoc)
    const hydrated = new Y.Doc()
    Y.applyUpdate(hydrated, snapshot)
    expect(hydrated.getText('content').toString()).toBe('Offline draft')

    clearLocalSessionStorage()

    expect(window.localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY)).toBeNull()
    expect(deleteDatabase).toHaveBeenCalledWith(dbA)
    expect(deleteDatabase).toHaveBeenCalledWith(dbB)
    vi.unstubAllGlobals()
  })

  it('reports when a live Yjs session owns the document body instead of REST Markdown seeding', () => {
    expect(maySeedFromMarkdown(false, 'local')).toBe(true)
    expect(collabSessionOwnsBody(false, 'local')).toBe(false)
    expect(maySeedFromMarkdown(true, 'local')).toBe(true)
    expect(collabSessionOwnsBody(true, 'local')).toBe(false)

    expect(maySeedFromMarkdown(true, 'connecting')).toBe(false)
    expect(collabSessionOwnsBody(true, 'connecting')).toBe(true)
    expect(maySeedFromMarkdown(true, 'synced')).toBe(false)
    expect(collabSessionOwnsBody(true, 'synced')).toBe(true)
    expect(maySeedFromMarkdown(true, 'offline-buffered')).toBe(false)
    expect(collabSessionOwnsBody(true, 'offline-buffered')).toBe(true)
  })
})

it('purges only the newly protected document and retains other offline drafts in its workspace', () => {
  const deleteDatabase = vi.fn()
  vi.stubGlobal('indexedDB', { deleteDatabase })
  try {
    const protectedDb = buildDocsOfflineDatabaseName('workspace', 'protected')
    const ordinaryDb = buildDocsOfflineDatabaseName('workspace', 'offline-draft')
    recordDocsOfflineDatabase(protectedDb)
    recordDocsOfflineDatabase(ordinaryDb)
    purgeProtectedDocsOfflineDatabases('workspace', 'protected')
    expect(deleteDatabase).toHaveBeenCalledWith(protectedDb)
    expect(deleteDatabase).not.toHaveBeenCalledWith(ordinaryDb)
    expect(JSON.parse(localStorage.getItem(DOCS_COLLAB_REGISTRY_KEY) ?? '[]')).toContain(ordinaryDb)
  } finally {
    vi.unstubAllGlobals()
  }
})
