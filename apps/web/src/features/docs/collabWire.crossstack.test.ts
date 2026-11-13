// @vitest-environment node
//
// Cross-stack wire proof: the web client's real `CollabSessionController` against the real
// `apps/server/yjs_collab` socket server, over real WebSockets. The unit suite's in-memory relay
// forwards every frame, so it cannot see what the server refuses; this suite can. The document is
// created by the server engine's `replace`, exactly as Django's create endpoint does through the
// private transform, so the fragment the server writes is the one the browser must edit.
//
// It needs `apps/server/yjs_collab/node_modules` (`npm ci` there); CI installs it before the web
// unit suite. A missing install fails the import loudly rather than skipping.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
// The server modules are plain ESM without type declarations.
// @ts-expect-error untyped server module
import { createCollabServer } from '../../../../server/yjs_collab/socket-server.mjs'
// @ts-expect-error untyped server module
import { apply, inspect, load, replace } from '../../../../server/yjs_collab/engine.mjs'
// @ts-expect-error untyped server module
import { TicketRefused } from '../../../../server/yjs_collab/tickets.mjs'
import { CollabSessionController, type WebSocketLike } from './collabSession'

// The WebSocket client is the `ws` the collaboration service itself installs and pins.
const serverRequire = createRequire(new URL('../../../../server/yjs_collab/package.json', import.meta.url))
const NodeWebSocket = serverRequire('ws') as new (
  url: string,
  options: { origin: string }
) => WebSocketLike & { on(event: 'close', listener: (code: number) => void): void }

const ORIGIN = 'https://community.example.org'
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`cross-stack condition timed out: ${label}`)
    await pause(10)
  }
}

interface Claims {
  readonly v: 1
  readonly organisation: string
  readonly document: string
  readonly membership: string
  readonly identity: string
  readonly issuer: string
  readonly subject: string
  readonly role: 'editor' | 'viewer'
  readonly issued: number
  readonly expires: number
  readonly nonce: string
}

/** The PostgreSQL store's contract, held in memory: same guard, admit, deliver, emit and update shape. */
class MemoryStore {
  readonly document = randomUUID()
  readonly organisation = randomUUID()
  readonly roles = new Map<string, string>()
  readonly redeemed = new Set<string>()
  doc: Y.Doc
  revision = 1

  constructor(markdown: string) {
    // Django's create: `engine.transform(markdown=...)` on an empty snapshot is `replace(load(), …)`.
    this.doc = load()
    replace(this.doc, markdown)
  }

  private guard(claims: Claims): void {
    if (claims.expires <= Math.floor(Date.now() / 1000)) throw new TicketRefused()
    if (
      claims.document !== this.document ||
      claims.organisation !== this.organisation ||
      this.roles.get(claims.membership) !== claims.role
    ) {
      throw new TicketRefused(4403)
    }
  }

  async admit(
    claims: Claims,
    consumer: (value: { state: Uint8Array; revision: number }) => void
  ): Promise<void> {
    this.guard(claims)
    if (this.redeemed.has(claims.nonce)) throw new TicketRefused()
    this.redeemed.add(claims.nonce)
    await this.deliver(claims, consumer)
  }

  async deliver(
    claims: Claims,
    consumer: (value: { state: Uint8Array; revision: number }) => void,
    known: number | null = null
  ): Promise<void> {
    this.guard(claims)
    if (known !== this.revision) consumer({ state: Y.encodeStateAsUpdate(this.doc), revision: this.revision })
  }

  async emit(claims: Claims, consumer: () => void): Promise<void> {
    this.guard(claims)
    consumer()
  }

  async update(claims: Claims, update: Uint8Array): Promise<{ update: Uint8Array; revision: number }> {
    this.guard(claims)
    if (claims.role !== 'editor') throw new TicketRefused(4403)
    // The real store inspects the merged state before it commits; a refusal closes the socket.
    const candidate = load(Y.encodeStateAsUpdate(this.doc))
    try {
      apply(candidate, update)
      inspect(candidate)
    } finally {
      candidate.destroy()
    }
    apply(this.doc, update)
    this.revision += 1
    return { update, revision: this.revision }
  }

  async viewerRefusal(claims: Claims): Promise<void> {
    this.guard(claims)
  }

  claims(role: 'editor' | 'viewer'): Claims {
    const now = Math.floor(Date.now() / 1000)
    const membership = randomUUID()
    this.roles.set(membership, role)
    return {
      v: 1,
      organisation: this.organisation,
      document: this.document,
      membership,
      identity: randomUUID(),
      issuer: 'https://identity.example.org/realms/community',
      subject: randomUUID(),
      role,
      issued: now,
      expires: now + 60,
      nonce: randomUUID(),
    }
  }

  markdown(): string {
    return inspect(this.doc).markdown as string
  }
}

function ticket(claims: Claims, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url')
}

interface Peer {
  readonly controller: CollabSessionController
  readonly closes: number[]
}

describe('web collab client against the real yjs_collab server', () => {
  const cleanups: (() => Promise<void> | void)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function start(markdown: string) {
    const key = randomBytes(32)
    const store = new MemoryStore(markdown)
    const service = createCollabServer({ key, store, origins: new Set([ORIGIN]), pollMilliseconds: 100_000 })
    service.server.listen(0, '127.0.0.1')
    await once(service.server, 'listening')
    const port = (service.server.address() as AddressInfo).port
    cleanups.push(async () => {
      await service.shutdown()
      store.doc.destroy()
    })

    const join = (role: 'editor' | 'viewer', name: string): Peer => {
      const claims = store.claims(role)
      const closes: number[] = []
      const controller = new CollabSessionController({
        scopeKey: store.organisation,
        documentId: store.document,
        initialRole: role,
        user: { id: claims.membership, name },
        enableOfflineBuffer: false,
        maxReconnectAttempts: 0,
        fetchSession: async () => {
          const issued = Math.floor(Date.now() / 1000)
          const fresh = { ...claims, issued, expires: issued + 60, nonce: randomUUID() }
          return {
            wsUrl: `ws://127.0.0.1:${port}/documents/collab`,
            token: ticket(fresh, key),
            expiresAt: new Date(fresh.expires * 1000).toISOString(),
            role,
          }
        },
        // A browser sends its page origin on the upgrade; the server admits only listed origins.
        webSocketFactory: (url) => {
          const socket = new NodeWebSocket(url, { origin: ORIGIN })
          socket.on('close', (code) => closes.push(code))
          return socket
        },
      })
      cleanups.push(() => controller.destroy())
      void controller.connect()
      return { controller, closes }
    }

    return { store, join }
  }

  function text(controller: CollabSessionController): string {
    return controller.ydoc.getXmlFragment('content').toString()
  }

  function appendToFirstParagraph(controller: CollabSessionController, suffix: string): void {
    const fragment = controller.ydoc.getXmlFragment('content')
    const paragraph = fragment.toArray().find(
      (node): node is Y.XmlElement => node instanceof Y.XmlElement && node.nodeName === 'paragraph'
    )
    if (!paragraph) throw new Error('no paragraph in the editor fragment')
    const run = paragraph.get(0)
    if (!(run instanceof Y.XmlText)) throw new Error('paragraph has no text run')
    run.insert(run.length, suffix)
  }

  it('delivers a server-created document into the fragment the block editor binds', async () => {
    const { join } = await start('# Example\n\nInitial text\n')
    const alice = join('editor', 'Alice')
    await until(() => alice.controller.getSnapshot().status === 'synced', 'alice synced')
    await until(() => text(alice.controller).includes('Initial text'), 'server text in content fragment')
    expect(alice.closes).toEqual([])
  })

  it('converges two editors and persists their edits without the server closing either socket', async () => {
    const { store, join } = await start('# Example\n\nInitial text\n')
    const alice = join('editor', 'Alice')
    const bob = join('editor', 'Bob')
    await until(() => text(alice.controller).includes('Initial text'), 'alice loaded')
    await until(() => text(bob.controller).includes('Initial text'), 'bob loaded')

    appendToFirstParagraph(alice.controller, ' from Alice')
    await until(() => text(bob.controller).includes('from Alice'), 'bob sees alice')
    appendToFirstParagraph(bob.controller, ' and Bob')
    await until(() => text(alice.controller).includes('and Bob'), 'alice sees bob')

    await until(() => store.markdown().includes('from Alice and Bob'), 'server persisted both edits')
    expect(alice.closes).toEqual([])
    expect(bob.closes).toEqual([])
  })

  it('relays presence between collaborators without echoing a peer identity back to the server', async () => {
    const { join } = await start('# Example\n\nInitial text\n')
    const alice = join('editor', 'Alice')
    const bob = join('editor', 'Bob')
    await until(() => text(alice.controller).includes('Initial text'), 'alice loaded')
    await until(() => text(bob.controller).includes('Initial text'), 'bob loaded')

    alice.controller.updateSelection({ anchor: 3, head: 5 })
    await until(
      () => bob.controller.getSnapshot().peers.some((peer) => peer.name === 'Alice' && peer.selection?.head === 5),
      'bob sees alice selection'
    )
    await until(
      () => alice.controller.getSnapshot().peers.some((peer) => peer.name === 'Bob'),
      'alice sees bob'
    )
    // Give the server time to refuse an echoed foreign presence identity, if one was sent.
    await pause(200)
    expect(alice.closes).toEqual([])
    expect(bob.closes).toEqual([])
    expect(alice.controller.getSnapshot().status).toBe('synced')
    expect(bob.controller.getSnapshot().status).toBe('synced')
  })

  it('lets a viewer read the document and never closes it for writing', async () => {
    const { join } = await start('# Example\n\nInitial text\n')
    const viewer = join('viewer', 'Vera')
    await until(() => text(viewer.controller).includes('Initial text'), 'viewer loaded')
    await pause(100)
    expect(viewer.closes).toEqual([])
  })
})
