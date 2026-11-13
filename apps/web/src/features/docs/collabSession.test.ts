import * as decoding from 'lib0/decoding'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  DOCS_COLLAB_REGISTRY_KEY,
  clearLocalSessionStorage,
} from '@/auth/localSession'
import {
  CollabSessionController,
  MSG_SYNC,
  buildDocsOfflineDatabaseName,
  computeReconnectDelayMs,
  recordDocsOfflineDatabase,
  validateCollabWebSocketUrl,
  type WebSocketLike,
} from './collabSession'

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

    await ctrl.connect()
    sockets[0]?.open()
    expect(ctrl.getSnapshot().status).toBe('synced')

    // Unexpected network drop transitions to `offline-buffered` and schedules bounded reconnect.
    sockets[0]?.close(1006, 'abnormal')
    ctrl.ydoc.getText('body').insert(0, 'Buffered while offline')
    expect(ctrl.getSnapshot().status).toBe('offline-buffered')

    await vi.advanceTimersByTimeAsync(100)
    expect(sessionFetches).toBe(2)
    sockets[1]?.open()
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
})
