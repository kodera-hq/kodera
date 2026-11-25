// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import { createCollabCryptoSession } from '../confidential/collab-crypto.worker'
import type { ConfidentialCollabCipher } from '../confidential/collab-crypto-client'
import { CollabSessionController, maySeedFromMarkdown, type WebSocketLike } from './collabSession'

class Socket implements WebSocketLike {
  binaryType: BinaryType = 'arraybuffer'
  readyState = 0
  onopen: WebSocketLike['onopen'] = null
  onmessage: WebSocketLike['onmessage'] = null
  onclose: WebSocketLike['onclose'] = null
  onerror: WebSocketLike['onerror'] = null
  frames: (string | Uint8Array)[] = []
  relay: ((data: Uint8Array) => void) | undefined
  send(data: string | Uint8Array) {
    this.frames.push(typeof data === 'string' ? data : data.slice())
    if (data instanceof Uint8Array) this.relay?.(data.slice())
  }
  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }
  receive(data: Uint8Array) {
    this.onmessage?.({ data } as MessageEvent)
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 4403 } as CloseEvent)
  }
}
const sessions: CollabSessionController[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.destroy()
    session.awareness.destroy()
    session.ydoc.destroy()
  }
  vi.unstubAllGlobals()
})
const context = { scopeKey: 'workspace-a', documentId: 'page-a', epoch: 7 }
function fakeCipher(overrides: Partial<ConfidentialCollabCipher> = {}): ConfidentialCollabCipher {
  return {
    ...context,
    senderClientId: 303,
    isActive: () => true,
    seal: async () => new Uint8Array([75, 68, 69, 49, 1]),
    open: async () => {
      throw new Error('unauthenticated')
    },
    close: vi.fn(),
    ...overrides,
  }
}
function create(
  cipher: ConfidentialCollabCipher | null,
  socket = new Socket(),
  epoch = 7,
  senderClientId = cipher?.senderClientId ?? 303
) {
  const fetchSession = vi.fn(async () => ({
    wsUrl: 'wss://relay.invalid/page',
    token: 'short-ticket',
    expiresAt: '',
    role: 'editor' as const,
  }))
  const ydoc = new Y.Doc()
  ydoc.clientID = senderClientId
  const session = new CollabSessionController({
    ydoc,
    ...context,
    user: { id: 'member-a', name: 'Member A' },
    confidential: { required: true, epoch, cipher },
    enableOfflineBuffer: true,
    fetchSession,
    webSocketFactory: () => socket,
  })
  sessions.push(session)
  return { session, socket, fetchSession }
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('confidential collaboration transport', () => {
  it('never opens plaintext IndexedDB and actively deletes kodera-docs-yjs:* DBs when confidential.required is true or roomBoundary is non-ordinary', async () => {
    const open = vi.fn()
    const deleteDatabase = vi.fn()
    const databases = vi.fn(async () => [
      { name: 'kodera-docs-yjs:workspace-a:page-a' },
      { name: 'kodera-docs-yjs:workspace-a:legacy-page' },
      { name: 'kodera-docs-yjs:other-workspace:keep' },
    ])
    vi.stubGlobal('indexedDB', { open, deleteDatabase, databases })
    create(fakeCipher())
    await settle()
    expect(open).not.toHaveBeenCalled()
    expect(deleteDatabase).toHaveBeenCalledWith('kodera-docs-yjs:workspace-a:page-a')
    expect(deleteDatabase).not.toHaveBeenCalledWith('kodera-docs-yjs:workspace-a:legacy-page')
    expect(deleteDatabase).not.toHaveBeenCalledWith('kodera-docs-yjs:other-workspace:keep')

    for (const boundary of ['unknown', 'invalid', 'confidential-unavailable'] as const) {
      open.mockClear()
      deleteDatabase.mockClear()
      const ydoc = new Y.Doc()
      const s = new CollabSessionController({
        ydoc,
        scopeKey: 'workspace-b',
        documentId: 'page-b',
        user: { id: 'member-a', name: 'Member A' },
        roomBoundary: boundary,
        enableOfflineBuffer: true,
        fetchSession: vi.fn(),
      })
      sessions.push(s)
      expect(open).not.toHaveBeenCalled()
      expect(deleteDatabase).toHaveBeenCalledWith('kodera-docs-yjs:workspace-b:page-b')
      expect(s.getSnapshot().status).toBe('forbidden')
    }

    for (const remote of [true, false])
      for (const status of ['local', 'synced', 'offline-buffered'] as const)
        expect(
          maySeedFromMarkdown(remote, status, { required: true, epoch: 7, cipher: null })
        ).toBe(false)
  })
  it.each([
    null,
    fakeCipher({ epoch: 6 }),
    fakeCipher({ documentId: 'other' }),
    fakeCipher({ scopeKey: 'other' }),
  ])('refuses absent or mismatched cipher before ticket request', async (cipher) => {
    const { session, fetchSession, socket } = create(cipher)
    await session.connect()
    expect(fetchSession).not.toHaveBeenCalled()
    expect(session.getSnapshot().status).toBe('forbidden')
    expect(socket.frames).toHaveLength(0)
  })
  it('rejects an initial sender mismatch before requesting a collaboration ticket', async () => {
    const { session, fetchSession } = create(fakeCipher(), new Socket(), 7, 404)
    await session.connect()
    expect(fetchSession).not.toHaveBeenCalled()
    expect(session.getSnapshot().status).toBe('forbidden')
  })
  it('rejects a cipher reused for a different tab sender before fetching a ticket', async () => {
    const { session, fetchSession } = create(fakeCipher())
    session.ydoc.clientID = 404
    await session.connect()
    expect(fetchSession).not.toHaveBeenCalled()
    expect(session.getSnapshot().status).toBe('forbidden')
  })
  it.each([0, 1])('quarantines an incoming plaintext frame type %i immediately', async (kind) => {
    const { session, socket } = create(fakeCipher())
    await session.connect()
    socket.open()
    socket.receive(new Uint8Array([kind, 0]))
    expect(socket.readyState).toBe(3)
    expect(session.getSnapshot().status).toBe('forbidden')
    await settle()
    expect(socket.frames.filter((frame) => frame instanceof Uint8Array)).toHaveLength(0)
    expect(session.ydoc.getText('body').toString()).toBe('')
  })
  it('does not send a seal that settles after authority revocation', async () => {
    let active = true
    let release!: (frame: Uint8Array) => void
    const seal = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve
        })
    )
    const { session, socket } = create(fakeCipher({ isActive: () => active, seal }))
    await session.connect()
    socket.open()
    await Promise.resolve()
    expect(seal).toHaveBeenCalledTimes(1)
    active = false
    release(new Uint8Array([75, 68, 69, 49, 99]))
    await settle()
    expect(socket.frames.filter((frame) => frame instanceof Uint8Array)).toHaveLength(0)
    expect(session.getSnapshot().status).toBe('forbidden')
  })
  it('does not apply an open that settles after authority revocation', async () => {
    let active = true
    let release!: (frame: Uint8Array) => void
    const { session, socket } = create(
      fakeCipher({
        isActive: () => active,
        open: () =>
          new Promise((resolve) => {
            release = resolve
          }),
      })
    )
    await session.connect()
    socket.open()
    socket.receive(new Uint8Array([75, 68, 69, 49, 1]))
    await Promise.resolve()
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'private update')
    const update = Y.encodeStateAsUpdate(doc)
    // Yjs update frame: kind 0, sync kind 2, varuint byte length.
    const { createEncoder, writeVarUint, writeVarUint8Array, toUint8Array } =
      await import('lib0/encoding')
    const encoder = createEncoder()
    writeVarUint(encoder, 0)
    writeVarUint(encoder, 2)
    writeVarUint8Array(encoder, update)
    active = false
    release(toUint8Array(encoder))
    await settle()
    expect(session.ydoc.getText('body').toString()).toBe('')
    expect(socket.readyState).toBe(3)
    doc.destroy()
  })
  it('quarantines cryptographic refusal without mutating the document', async () => {
    const { session, socket } = create(fakeCipher())
    await session.connect()
    socket.open()
    socket.receive(new Uint8Array([75, 68, 69, 49, 1]))
    await settle()
    expect(session.getSnapshot().status).toBe('forbidden')
    expect(session.ydoc.getText('body').toString()).toBe('')
  })

  it('setRoomBoundary handles cold-start unknown -> ordinary upgrade and enforces sticky purge on ordinary -> confidential transition', async () => {
    const deleteDatabase = vi.fn()
    const databases = vi.fn(async () => [{ name: 'kodera-docs-yjs:workspace-live:doc-live' }])
    vi.stubGlobal('indexedDB', { deleteDatabase, databases })

    // 1. Cold-start `'unknown'` blocks plaintext Yjs socket/persistence until `/sync` confirms `'ordinary'`.
    const socket = new Socket()
    const fetchSession = vi.fn(async () => ({
      wsUrl: 'wss://relay.invalid/live',
      token: 'ticket-live',
      expiresAt: '',
      role: 'editor' as const,
    }))
    const controller = new CollabSessionController({
      ydoc: new Y.Doc(),
      scopeKey: 'workspace-live',
      documentId: 'doc-live',
      user: { id: 'member-a', name: 'Member A' },
      roomBoundary: 'unknown',
      enableOfflineBuffer: true,
      fetchSession,
      webSocketFactory: () => socket,
    })
    sessions.push(controller)

    expect(controller.getSnapshot().status).toBe('forbidden')
    await controller.connect()
    expect(fetchSession).not.toHaveBeenCalled()

    // 2. `/sync` resolves room as `'ordinary'` -> plaintext session unlocks and connects cleanly.
    controller.setRoomBoundary('ordinary')
    expect(controller.getSnapshot().status).toBe('connecting')
    await controller.connect()
    expect(fetchSession).toHaveBeenCalledTimes(1)
    socket.open()
    expect(socket.readyState).toBe(1)

    // 3. Room transitions to `'confidential-unavailable'` -> closes socket, purges `kodera-docs-yjs:*`, and stays sticky `'forbidden'` even if a stale `'ordinary'` update arrives!
    deleteDatabase.mockClear()
    controller.setRoomBoundary('confidential-unavailable')
    await settle()
    expect(controller.getSnapshot().status).toBe('forbidden')
    expect(socket.readyState).toBe(3)
    expect(deleteDatabase).toHaveBeenCalledWith('kodera-docs-yjs:workspace-live:doc-live')

    controller.setRoomBoundary('ordinary')
    expect(controller.getSnapshot().status).toBe('forbidden')
    await controller.connect()
    expect(fetchSession).toHaveBeenCalledTimes(1)
  })
})

function realCipher(senderClientId: number, changes: Partial<typeof context> = {}) {
  return createCollabCryptoSession(
    { ...context, ...changes, senderClientId },
    new Uint8Array(32).fill(17)
  )
}
function updateFrame(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, text)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeUpdate(encoder, Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return encoding.toUint8Array(encoder)
}
describe('real encrypted Yjs peer transport', () => {
  it('syncs two peers and awareness with no document substring on wire and no IndexedDB', async () => {
    const open = vi.fn()
    vi.stubGlobal('indexedDB', { open })
    const alice = create(realCipher(101)),
      bob = create(realCipher(202))
    alice.socket.relay = (frame) => bob.socket.receive(frame)
    bob.socket.relay = (frame) => alice.socket.receive(frame)
    await Promise.all([alice.session.connect(), bob.session.connect()])
    alice.socket.open()
    bob.socket.open()
    alice.session.ydoc.getText('body').insert(0, 'encrypted page sentinel')
    alice.session.updateSelection({ anchor: 1, head: 3 })
    await vi.waitFor(() => {
      expect(bob.session.ydoc.getText('body').toString()).toBe('encrypted page sentinel')
      expect(bob.session.getSnapshot().peers).toHaveLength(1)
      expect(alice.session.getSnapshot().peers).toHaveLength(1)
    })
    bob.session.ydoc.getText('body').insert(23, ' and shared')
    await vi.waitFor(() =>
      expect(alice.session.ydoc.getText('body').toString()).toContain('and shared')
    )
    for (const frame of [...alice.socket.frames, ...bob.socket.frames]) {
      if (frame instanceof Uint8Array) {
        expect(Array.from(frame.slice(0, 4))).toEqual([75, 68, 69, 49])
        expect(new TextDecoder().decode(frame)).not.toContain('encrypted page sentinel')
        expect(new TextDecoder().decode(frame)).not.toContain('Member A')
      }
    }
    expect(open).not.toHaveBeenCalled()
  })
  it.each(['tamper', 'wrong-document', 'wrong-scope', 'wrong-epoch'] as const)(
    'rejects %s without applying an unauthenticated update',
    async (attack) => {
      const sender = realCipher(
        101,
        attack === 'wrong-document'
          ? { documentId: 'different-page' }
          : attack === 'wrong-scope'
            ? { scopeKey: 'different-workspace' }
            : attack === 'wrong-epoch'
              ? { epoch: 8 }
              : {}
      )
      const target = create(realCipher(202))
      await target.session.connect()
      target.socket.open()
      const frame = await sender.seal(updateFrame('protected update'))
      if (attack === 'tamper') frame[frame.length - 1] = frame[frame.length - 1]! ^ 1
      target.socket.receive(frame)
      await vi.waitFor(() => expect(target.session.getSnapshot().status).toBe('forbidden'))
      expect(target.session.ydoc.getText('body').toString()).toBe('')
      expect(target.socket.readyState).toBe(3)
      sender.close()
    }
  )
  it('survives 4401 ticket renewal reconnect and journal replay without self-quarantining, and auto-compacts >= 64 updates as kind=3 checkpoints', async () => {
    const aliceCipher = realCipher(101)
    const bobCipher = realCipher(202)
    const sockets: Socket[] = []
    let ticketNum = 0
    const ydoc = new Y.Doc()
    ydoc.clientID = 101
    const alice = new CollabSessionController({
      ydoc,
      ...context,
      user: { id: 'member-a', name: 'Member A' },
      confidential: { required: true, epoch: 7, cipher: aliceCipher },
      fetchSession: async () => ({
        wsUrl: 'wss://relay.invalid/page',
        token: `ticket-${++ticketNum}`,
        expiresAt: '',
        role: 'editor',
        confidential: true,
        epoch: 7,
      }),
      webSocketFactory: () => {
        const s = new Socket()
        sockets.push(s)
        return s
      },
    })
    sessions.push(alice)
    await alice.connect()
    expect(sockets).toHaveLength(1)
    sockets[0]!.open()
    await settle()

    // Alice authors an edit and receives an edit from Bob.
    alice.ydoc.getText('body').insert(0, 'Alice-1 ')
    await settle()
    const aliceOwnSealed = sockets[0]!.frames.find(
      (f): f is Uint8Array =>
        f instanceof Uint8Array &&
        new TextDecoder().decode(f.subarray(6, 6 + ((f[4]! << 8) | f[5]!))).includes('"kind":0')
    )!
    expect(aliceOwnSealed).toBeInstanceOf(Uint8Array)

    const bobSealed1 = await bobCipher.seal(updateFrame('Bob-1'))
    sockets[0]!.receive(bobSealed1)
    await vi.waitFor(() => expect(alice.ydoc.getText('body').toString()).toContain('Bob-1'))

    // Duplicate delivery on the same socket is idempotently ignored without killing the worker.
    sockets[0]!.receive(bobSealed1)
    await settle()
    expect(alice.getSnapshot().status).toBe('synced')

    // Simulate 300s ticket expiry (4401) -> automatic reconnect on sockets[1] -> relay replays journal!
    sockets[0]!.readyState = 3
    sockets[0]!.onclose?.({ code: 4401 } as CloseEvent)
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    sockets[1]!.relay = (frame) => {
      if (
        new TextDecoder()
          .decode(frame.subarray(6, 6 + ((frame[4]! << 8) | frame[5]!)))
          .includes('"kind":0')
      ) {
        sockets[1]!.receive(frame)
      }
    }
    sockets[1]!.open()
    sockets[1]!.receive(aliceOwnSealed)
    sockets[1]!.receive(bobSealed1)
    const bobSealed2 = await bobCipher.seal(updateFrame('Bob-2'))
    sockets[1]!.receive(bobSealed2)
    await vi.waitFor(() => expect(alice.ydoc.getText('body').toString()).toContain('Bob-2'))
    expect(alice.getSnapshot().status).toBe('synced')

    // Emit 64 local updates on sockets[1] (echoed on downlink in commit order) -> editor automatically emits a kind===3 checkpoint!
    for (let i = 0; i < 64; i += 1) {
      alice.ydoc.getText('body').insert(alice.ydoc.getText('body').length, 'x')
    }
    await vi.waitFor(() => {
      const hasKind3 = sockets[1]!.frames.some(
        (f) =>
          f instanceof Uint8Array &&
          new TextDecoder().decode(f.subarray(6, 6 + ((f[4]! << 8) | f[5]!))).includes('"kind":3')
      )
      expect(hasKind3).toBe(true)
    })
    const checkpointFrame = sockets[1]!.frames.find(
      (f): f is Uint8Array =>
        f instanceof Uint8Array &&
        new TextDecoder().decode(f.subarray(6, 6 + ((f[4]! << 8) | f[5]!))).includes('"kind":3')
    )!
    // Brand-new viewer at epoch 7 opens the compacted kind===3 checkpoint and hydrates full text!
    const viewer = create(realCipher(505))
    await viewer.session.connect()
    viewer.socket.open()
    viewer.socket.receive(checkpointFrame)
    await vi.waitFor(() =>
      expect(viewer.session.ydoc.getText('body').toString()).toBe(
        alice.ydoc.getText('body').toString()
      )
    )
    bobCipher.close()
  })
  it('applies delayed kind=0 peer edit arriving after higher-sequence kind=1 awareness and preserves concurrent peer B64 during downlink-FIFO compaction', async () => {
    // 1. Per-(sender, kind) dedup: awareness frames (kind=1, seq=1..3) arriving BEFORE delayed kind=0 seq=1 edit never drop the edit!
    const peerCipher = realCipher(606)
    const receiver = create(realCipher(707))
    await receiver.session.connect()
    receiver.socket.open()
    await settle()

    // Empty-doc manual compaction before any downlink journal frame is refused!
    receiver.session.compactConfidentialCheckpoint()
    await settle()
    expect(
      receiver.socket.frames.some(
        (f) =>
          f instanceof Uint8Array &&
          new TextDecoder().decode(f.subarray(6, 6 + ((f[4]! << 8) | f[5]!))).includes('"kind":3')
      )
    ).toBe(false)

    const delayedDurable = await peerCipher.seal(updateFrame('delayed-durable-edit'))
    const awEncoder = encoding.createEncoder()
    encoding.writeVarUint(awEncoder, 1)
    encoding.writeVarUint8Array(awEncoder, new Uint8Array([1, 0]))
    const awPayload = encoding.toUint8Array(awEncoder)
    const aw1 = await peerCipher.seal(awPayload)
    const aw2 = await peerCipher.seal(awPayload)
    receiver.socket.receive(aw1)
    receiver.socket.receive(aw2)
    await settle()
    receiver.socket.receive(delayedDurable)
    await vi.waitFor(() =>
      expect(receiver.session.ydoc.getText('body').toString()).toBe('delayed-durable-edit')
    )
    peerCipher.close()

    // 2. Concurrent 2-editor compaction: Bob's B64 commits at head=64 AHEAD of Alice's 64th edit A64 at head=65!
    const alice = create(realCipher(801))
    const bob = create(realCipher(802))
    let snapshot: Uint8Array | null = null
    let base = 0
    const journal: { seq: number; env: Uint8Array }[] = []
    const downlinkHeads = new Map<Socket, number[]>()
    downlinkHeads.set(alice.socket, [])
    downlinkHeads.set(bob.socket, [])

    const commitKind0 = (env: Uint8Array) => {
      const seq = (journal.length > 0 ? journal[journal.length - 1]!.seq : base) + 1
      journal.push({ seq, env })
      for (const target of [alice.socket, bob.socket]) {
        downlinkHeads.get(target)!.push(seq)
        target.receive(env)
      }
    }
    const applyKind3 = (from: Socket, env: Uint8Array) => {
      const hdr = JSON.parse(
        new TextDecoder().decode(env.subarray(6, 6 + ((env[4]! << 8) | env[5]!)))
      ) as { sequence: number }
      const heads = downlinkHeads.get(from)!
      expect(hdr.sequence).toBeGreaterThanOrEqual(1)
      expect(hdr.sequence).toBeLessThanOrEqual(heads.length)
      const upToHead = heads[hdr.sequence - 1]!
      snapshot = env
      base = upToHead
      while (journal.length > 0 && journal[0]!.seq <= upToHead) {
        journal.shift()
      }
    }

    let holdAlice64: Uint8Array | null = null
    let aliceKind0Sent = 0
    alice.socket.relay = (frame) => {
      const hdrText = new TextDecoder().decode(
        frame.subarray(6, 6 + ((frame[4]! << 8) | frame[5]!))
      )
      if (hdrText.includes('"kind":0')) {
        aliceKind0Sent += 1
        if (aliceKind0Sent === 64) {
          holdAlice64 = frame // Hold A64 until Bob's B64 commits at head=64!
          return
        }
        commitKind0(frame)
      } else if (hdrText.includes('"kind":3')) {
        applyKind3(alice.socket, frame)
      }
    }
    bob.socket.relay = (frame) => {
      const hdrText = new TextDecoder().decode(
        frame.subarray(6, 6 + ((frame[4]! << 8) | frame[5]!))
      )
      if (hdrText.includes('"kind":0')) {
        commitKind0(frame)
      } else if (hdrText.includes('"kind":3')) {
        applyKind3(bob.socket, frame)
      }
    }

    await Promise.all([alice.session.connect(), bob.session.connect()])
    alice.socket.open()
    bob.socket.open()
    await settle()

    // Alice sends 63 edits (committed as heads 1..63).
    for (let i = 1; i <= 63; i += 1) {
      alice.session.ydoc.getText('body').insert(alice.session.ydoc.getText('body').length, `A${i} `)
    }
    await vi.waitFor(() => expect(bob.session.ydoc.getText('body').toString()).toContain('A63 '))

    // Concurrently: Alice types A64 (held in flight!) while Bob's B64 commits FIRST at head=64, then A64 commits at head=65!
    alice.session.ydoc.getText('body').insert(alice.session.ydoc.getText('body').length, 'A64 ')
    await vi.waitFor(() => expect(holdAlice64).not.toBeNull())
    bob.session.ydoc.getText('body').insert(bob.session.ydoc.getText('body').length, 'B64 ')
    await settle()
    commitKind0(holdAlice64!)

    await vi.waitFor(() => expect(snapshot).not.toBeNull())
    expect(base).toBeGreaterThanOrEqual(64)

    // Fresh late-joining viewer replaying [snapshot, ...remaining journal] sees BOTH B64 and A64 — zero data loss!
    const lateViewer = create(realCipher(803))
    await lateViewer.session.connect()
    lateViewer.socket.open()
    lateViewer.socket.receive(snapshot!)
    for (const entry of journal) {
      lateViewer.socket.receive(entry.env)
    }
    await vi.waitFor(() => {
      const text = lateViewer.session.ydoc.getText('body').toString()
      expect(text).toContain('B64 ')
      expect(text).toContain('A64 ')
    })
  })
  it('quarantines server ticket grants whose confidential flag or epoch disagrees with client policy and omits kind===0 sync on confidential viewers', async () => {
    const mismatchSocket = new Socket()
    const ydoc = new Y.Doc()
    ydoc.clientID = 303
    const mismatchSession = new CollabSessionController({
      ydoc,
      ...context,
      user: { id: 'member-a', name: 'Member A' },
      confidential: { required: true, epoch: 7, cipher: fakeCipher() },
      fetchSession: async () => ({
        wsUrl: 'wss://relay.invalid/page',
        token: 'ticket',
        expiresAt: '',
        role: 'editor',
        confidential: true,
        epoch: 8,
      }),
      webSocketFactory: () => mismatchSocket,
    })
    sessions.push(mismatchSession)
    await mismatchSession.connect()
    expect(mismatchSession.getSnapshot().status).toBe('forbidden')
    expect(mismatchSocket.frames).toHaveLength(0)

    // Plaintext session receiving confidential: true grant from server immediately quarantines.
    const downgradeSocket = new Socket()
    const downgradeSession = new CollabSessionController({
      ydoc: new Y.Doc(),
      scopeKey: 'workspace-a',
      documentId: 'page-plain',
      user: { id: 'member-a', name: 'Member A' },
      fetchSession: async () => ({
        wsUrl: 'wss://relay.invalid/page',
        token: 'ticket',
        expiresAt: '',
        role: 'editor',
        confidential: true,
        epoch: 7,
      }),
      webSocketFactory: () => downgradeSocket,
    })
    sessions.push(downgradeSession)
    await downgradeSession.connect()
    expect(downgradeSession.getSnapshot().status).toBe('forbidden')
    expect(downgradeSocket.frames).toHaveLength(0)

    // Confidential viewer sends only auth + kind===1 awareness (never kind===0 sync).
    const sealCalls: number[] = []
    const viewerCipher = realCipher(404)
    const viewerSocket = new Socket()
    const viewerDoc = new Y.Doc()
    viewerDoc.clientID = 404
    const viewerSession = new CollabSessionController({
      ydoc: viewerDoc,
      ...context,
      user: { id: 'member-v', name: 'Viewer' },
      confidential: {
        required: true,
        epoch: 7,
        cipher: {
          ...viewerCipher,
          seal: async (plain) => {
            sealCalls.push(plain[0]!)
            return viewerCipher.seal(plain)
          },
        },
      },
      fetchSession: async () => ({
        wsUrl: 'wss://relay.invalid/page',
        token: 'viewer-ticket',
        expiresAt: '',
        role: 'viewer',
        confidential: true,
        epoch: 7,
      }),
      webSocketFactory: () => viewerSocket,
    })
    sessions.push(viewerSession)
    await viewerSession.connect()
    viewerSocket.open()
    await settle()
    expect(viewerSession.getSnapshot().status).toBe('synced')
    expect(sealCalls).toEqual([1])
  })
})
