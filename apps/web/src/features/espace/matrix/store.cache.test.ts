// The store and the device's timeline cache & encrypted vault (`kodera.espace-vault.v1`), against
// the real matrix-js-sdk and a fake homeserver whose /sync and /send endpoints are controlled per test.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfidentialRoomUnavailable } from '../../confidential/room-boundary'
import {
  ESPACE_VAULT_DATABASE,
  LEGACY_TIMELINE_DATABASE,
  openEspaceVault,
  type EspaceVaultPrincipal,
} from './encryptedCache'
import { createEspaceStore, type EspaceStore } from './store'
import { createTestVaultIndexedDb } from './testVaultIdb'
import { memoryBackend, TimelineCache } from './timelineCache'
import type { MessageView } from './timeline'

const HS = 'https://matrix.acme.kodera.test'
const ROOM = '!general:matrix.acme.kodera.test'
const ROOM_SECRET = '!confidential:matrix.acme.kodera.test'
const ME = '@me:matrix.acme.kodera.test'
const ALICE = '@alice:matrix.acme.kodera.test'
const AGENT = '@kodera-agent:matrix.acme.kodera.test'

const PRINCIPAL: EspaceVaultPrincipal = {
  ownerId: ME,
  organisationId: 'org-acme-01',
  membershipId: 'mem-me-01',
  deviceId: 'DEV',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let ts = Date.UTC(2026, 10, 2, 9, 0)
const state = (
  id: string,
  type: string,
  content: Record<string, unknown>,
  key = '',
  sender = ME
) => ({
  event_id: id,
  type,
  state_key: key,
  sender,
  origin_server_ts: ts++,
  content,
})
const live = (id: string, body = id) => ({
  event_id: id,
  type: 'm.room.message',
  sender: ALICE,
  origin_server_ts: ts++,
  content: { msgtype: 'm.text', body },
})

function kept(id: string): MessageView {
  return {
    key: id,
    eventId: id,
    sender: ALICE,
    body: `kept ${id}`,
    ts: ts++,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

function homeserver() {
  let answer: (() => void) | null = null
  const synced = new Promise<void>((resolve) => {
    answer = resolve
  })
  let syncs = 0
  const base = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = decodeURIComponent(url.pathname)
    const method = init?.method ?? 'GET'
    if (path === '/_matrix/client/versions') return json(200, { versions: ['v1.11'] })
    if (path === '/_matrix/client/v3/capabilities') return json(200, { capabilities: {} })
    if (path === '/_matrix/client/v3/pushrules/') return json(200, { global: {} })
    if (method === 'POST' && path === `/_matrix/client/v3/user/${ME}/filter`) {
      return json(200, { filter_id: 'f' })
    }
    if (method === 'GET' && path === `/_matrix/client/v3/profile/${ME}`) {
      return json(200, {})
    }
    if (path === '/_matrix/client/v3/sync') {
      if (++syncs === 1) {
        await synced
        return json(200, {
          next_batch: 's1',
          rooms: {
            join: {
              [ROOM]: {
                state: {
                  events: [
                    state('$create', 'm.room.create', { creator: ME, room_version: '10' }),
                    state(`$join-me`, 'm.room.member', { membership: 'join' }, ME),
                  ],
                },
                timeline: { events: [live('$live-1'), live('$live-2')], limited: false },
                unread_notifications: { notification_count: 0, highlight_count: 0 },
              },
            },
          },
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('stopped', 'AbortError'))
        if (init?.signal?.aborted) abort()
        init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })
  return { base, answer: () => answer?.() }
}

interface QueuedSyncResponse {
  readonly status?: number
  readonly body: unknown
}

function scriptedHomeserver(options?: {
  readonly onSend?: (
    roomId: string,
    txnId: string,
    body: Record<string, unknown>
  ) => Response | Promise<Response>
}) {
  const syncQueue: Array<{
    gate: Promise<QueuedSyncResponse>
    resolve: (res: QueuedSyncResponse) => void
  }> = []
  const ensureSlot = (index: number) => {
    while (syncQueue.length <= index) {
      let resolve!: (res: QueuedSyncResponse) => void
      const gate = new Promise<QueuedSyncResponse>((r) => {
        resolve = r
      })
      syncQueue.push({ gate, resolve })
    }
    return syncQueue[index]!
  }

  let syncCalls = 0
  const sentRequests: Array<{ roomId: string; txnId: string; body: Record<string, unknown> }> = []

  const base = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = decodeURIComponent(url.pathname)
    const method = init?.method ?? 'GET'
    if (path === '/_matrix/client/versions') return json(200, { versions: ['v1.11'] })
    if (path === '/_matrix/client/v3/capabilities') return json(200, { capabilities: {} })
    if (path === '/_matrix/client/v3/pushrules/') return json(200, { global: {} })
    if (path.startsWith('/_matrix/client/v3/pushrules/')) return json(200, {})
    if (method === 'POST' && path === `/_matrix/client/v3/user/${ME}/filter`) {
      return json(200, { filter_id: 'f' })
    }
    if (method === 'GET' && path === `/_matrix/client/v3/profile/${ME}`) {
      return json(200, { displayname: 'Me' })
    }
    if (method === 'GET' && path.startsWith('/_matrix/client/v3/directory/room/')) {
      return json(200, { room_id: ROOM })
    }
    const sendMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/.exec(
      path
    )
    if (method === 'PUT' && sendMatch) {
      const roomId = sendMatch[1]!
      const txnId = sendMatch[2]!
      const rawText =
        typeof init?.body === 'string'
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : '{}'
      const parsed = JSON.parse(rawText) as Record<string, unknown>
      sentRequests.push({ roomId, txnId, body: parsed })
      if (options?.onSend) return options.onSend(roomId, txnId, parsed)
      return json(200, { event_id: `$sent-${txnId}` })
    }
    if (path === '/_matrix/client/v3/sync') {
      const idx = syncCalls++
      const slot = ensureSlot(idx)
      let aborted = false
      return new Promise<Response>((resolve, reject) => {
        const abort = () => {
          aborted = true
          reject(new DOMException('stopped', 'AbortError'))
        }
        if (init?.signal?.aborted) {
          abort()
          return
        }
        init?.signal?.addEventListener('abort', abort, { once: true })
        void slot.gate.then((res) => {
          if (aborted) return
          init?.signal?.removeEventListener('abort', abort)
          resolve(json(res.status ?? 200, res.body))
        })
      })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  })

  return {
    base,
    sentRequests,
    syncCount: () => syncCalls,
    deliverSync(index: number, body: unknown, status = 200) {
      ensureSlot(index).resolve({ status, body })
    },
  }
}

const stores: EspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.stop()
  vi.unstubAllGlobals()
})

function open(cache: TimelineCache, base: typeof fetch) {
  const store = createEspaceStore(
    { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
    base,
    { cache, vault: null }
  )
  stores.push(store)
  return store
}

const changed = (_store: EspaceStore, test: () => boolean) =>
  vi.waitFor(() => expect(test()).toBe(true), { timeout: 4000 })

describe("the store and the device's timeline cache", () => {
  it('withholds cached plaintext until immutable room protection state is synced', async () => {
    const backend = memoryBackend()
    const before = new TimelineCache(backend, ME)
    before.save(ROOM, [kept('$kept-1'), kept('$kept-2')])
    await before.close()
    const { base, answer } = homeserver()
    const store = open(new TimelineCache(backend, ME, { delayMs: 0 }), base)
    void store.start()
    await vi.waitFor(() => expect(base).toHaveBeenCalled())
    expect(store.getTimeline(ROOM)).toEqual([])
    answer()
    await changed(store, () => store.getTimeline(ROOM)[0]?.eventId === '$live-1')
    expect(store.getTimeline(ROOM).map((m) => m.eventId)).toEqual(['$live-1', '$live-2'])
    // And the live room is what the device keeps from now on.
    await vi.waitFor(() =>
      expect(backend.records.get(`${ME}\n${ROOM}`)?.messages.map((m) => m.eventId)).toEqual([
        '$live-1',
        '$live-2',
      ])
    )
  })

  it('wipes what the device kept when the session signs out', async () => {
    const backend = memoryBackend()
    const before = new TimelineCache(backend, ME)
    before.save(ROOM, [kept('$kept-1')])
    await before.close()
    const { base } = homeserver()
    const store = open(new TimelineCache(backend, ME), base)
    void store.start()
    await vi.waitFor(() => expect(base).toHaveBeenCalled())
    expect(store.getTimeline(ROOM)).toEqual([])
    store.stop('signed-out')
    expect(store.getTimeline(ROOM)).toHaveLength(0)
    await vi.waitFor(() => expect(backend.records.size).toBe(0))
  })

  it('keeps nothing when told to keep nothing', async () => {
    const { base, answer } = homeserver()
    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      base,
      { cache: null, vault: null }
    )
    stores.push(store)
    void store.start()
    answer()
    await changed(store, () => store.getTimeline(ROOM).length === 2)
  })
})

describe('H1.2b encrypted cold-start vault, persistent quarantine (issue 180), and server-revalidated offline outbox', () => {
  it('hydrates active 200-message room + sidebar from encrypted vault in < 300 ms before /sync answers and reconciles on /sync', async () => {
    const idb = createTestVaultIndexedDb()
    const seedVault = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    const seededMessages = Array.from({ length: 200 }, (_, i) => kept(`$cached-${i + 1}`))
    seedVault.scheduleRoomSave(
      ROOM,
      'ordinary',
      seededMessages,
      {
        roomId: ROOM,
        name: 'General',
        alias: '#kodera-ch-ch-general:matrix.acme.kodera.test',
        verifiedBoundary: 'ordinary',
        kind: 'text',
        unread: 3,
        mentions: 1,
      },
      ['ch-general']
    )
    seedVault.scheduleSidebarSave(
      [
        {
          roomId: ROOM,
          name: 'General',
          alias: '#kodera-ch-ch-general:matrix.acme.kodera.test',
          verifiedBoundary: 'ordinary',
          kind: 'text',
          unread: 3,
          mentions: 1,
        },
      ],
      [['ch-general', ROOM]]
    )
    await seedVault.close()

    // Verify prioritized coldStartRead itself completes well under 25 ms.
    const probeVault = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    const readStartedAt = performance.now()
    const coldProbe = await probeVault.coldStartRead('ch-general')
    const readElapsedMs = performance.now() - readStartedAt
    expect(coldProbe.activeRoom?.messages).toHaveLength(200)
    expect(readElapsedMs).toBeLessThan(25)
    await probeVault.close()

    const { base, answer } = homeserver()
    const startedAt = performance.now()
    const coldStore = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      base,
      {
        cache: null,
        vaultIdb: idb,
        principal: PRINCIPAL,
        activeChannelId: 'ch-general',
      }
    )
    stores.push(coldStore)
    const hydratedReady = new Promise<void>((resolve) => {
      const check = () => {
        if (
          coldStore.getTimeline(ROOM).length === 200 &&
          coldStore.getSnapshot().rooms[0]?.roomId === ROOM
        ) {
          unsubscribe()
          resolve()
        }
      }
      const unsubscribe = coldStore.subscribe(check)
      check()
    })
    void coldStore.start()
    await hydratedReady
    const elapsedMs = performance.now() - startedAt
    console.info(
      `[H1.2b cold-start benchmark] vault.coldStartRead=${readElapsedMs.toFixed(2)}ms, EspaceStore.hydrate=${elapsedMs.toFixed(2)}ms`
    )
    // Cold-start encrypted hydration must strictly complete under 300 ms while /sync is still held.
    expect(elapsedMs).toBeLessThan(300)
    expect(coldStore.getSnapshot().status).toBe('starting')
    expect(coldStore.getSnapshot().channels.get('ch-general')).toEqual({
      state: 'resolved',
      roomId: ROOM,
    })
    expect(coldStore.getTimeline(ROOM)[0]?.eventId).toBe('$cached-1')
    expect(coldStore.getTimeline(ROOM)[199]?.eventId).toBe('$cached-200')

    // Once initial /sync answers, authoritative live state replaces cached timeline cleanly.
    answer()
    await changed(coldStore, () => coldStore.getTimeline(ROOM)[0]?.eventId === '$live-1')
    expect(coldStore.getTimeline(ROOM).map((m) => m.eventId)).toEqual(['$live-1', '$live-2'])
  })

  it('confidential-quarantine-across-restart: persists body-free quarantine marker on confidential observation and blocks cold-start plaintext + sends on restart', async () => {
    const idb = createTestVaultIndexedDb()
    const hs1 = scriptedHomeserver()
    const vault1 = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    const store1 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs1.base,
      { cache: null, vault: vault1, vaultIdb: idb, principal: PRINCIPAL, activeRoomId: ROOM }
    )
    stores.push(store1)
    void store1.start()

    // Sync 1: ROOM is ordinary, ROOM_SECRET is confidential (`io.kodera.room.confidential`).
    hs1.deliverSync(0, {
      next_batch: 'b1',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$ord-1', 'ordinary-hello')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
          [ROOM_SECRET]: {
            state: {
              events: [
                state(
                  '$c2',
                  'm.room.create',
                  {
                    creator: AGENT,
                    room_version: '10',
                    'io.kodera.room.confidential': { version: 1, mode: 'mls-128' },
                  },
                  '',
                  AGENT
                ),
                state('$j2', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$sec-1', 'NEVER_CACHE_SECRET')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })

    await changed(store1, () => store1.getTimeline(ROOM).length === 1)
    expect(store1.getTimeline(ROOM_SECRET)).toEqual([])
    await vault1.flush()

    // Verify ROOM_SECRET was never written to `rooms` and IS recorded in `quarantine`.
    await vi.waitFor(() => {
      const qRows = [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'quarantine').values()] as Array<{
        roomId: string
      }>
      expect(qRows.some((r) => r.roomId === ROOM_SECRET)).toBe(true)
    })

    // Now mark ROOM confidential out-of-band (`markConfidentialRoom`) — must purge cached ROOM and quarantine it!
    store1.markConfidentialRoom(ROOM)
    expect(store1.getTimeline(ROOM)).toEqual([])
    await vi.waitFor(() => {
      const qRows = [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'quarantine').values()] as Array<{
        roomId: string
      }>
      expect(qRows.some((r) => r.roomId === ROOM)).toBe(true)
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'rooms').size).toBe(0)
    })
    store1.stop()

    // Restart a brand-new EspaceStore on the same `idb` while /sync is held (before /sync answers).
    const hs2 = scriptedHomeserver()
    const store2 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs2.base,
      { cache: null, vaultIdb: idb, principal: PRINCIPAL, activeRoomId: ROOM }
    )
    stores.push(store2)
    void store2.start()

    await changed(
      store2,
      () =>
        store2.getRoomBoundary(ROOM) !== 'unknown' &&
        store2.getRoomBoundary(ROOM_SECRET) !== 'unknown'
    )
    expect(store2.getRoomBoundary(ROOM)).toBe('invalid')
    expect(store2.getRoomBoundary(ROOM_SECRET)).toBe('invalid')
    expect(store2.getTimeline(ROOM)).toEqual([])
    expect(store2.getTimeline(ROOM_SECRET)).toEqual([])
    await expect(store2.send(ROOM, 'blocked before sync')).rejects.toBeInstanceOf(
      ConfidentialRoomUnavailable
    )
    expect(hs2.sentRequests).toHaveLength(0)
  })

  it('revoke-while-offline: refuses network replay when room membership was revoked (leave/ban) or workspace membership deactivated while offline', async () => {
    const idb = createTestVaultIndexedDb()
    let failNetworkSend = false
    const hs1 = scriptedHomeserver({
      onSend: () => {
        if (failNetworkSend) throw new TypeError('Failed to fetch')
        return json(200, { event_id: '$ok' })
      },
    })
    const vault1 = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    const store1 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs1.base,
      { cache: null, vault: vault1, vaultIdb: idb, principal: PRINCIPAL }
    )
    stores.push(store1)
    void store1.start()

    hs1.deliverSync(0, {
      next_batch: 's1',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m1', 'hello')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(store1, () => store1.getSnapshot().status === 'live')

    // Go offline and send with deterministic clientTxnId; network fails and item persists encrypted in outbox.
    failNetworkSend = true
    await expect(
      store1.send(ROOM, 'sensitive-offline-draft', { clientTxnId: 'txn-revoked-1' })
    ).rejects.toThrow()
    expect(store1.getOutboxStatus(ROOM)).toEqual([
      expect.objectContaining({
        clientTxnId: 'txn-revoked-1',
        roomId: ROOM,
        state: 'queued',
      }),
    ])
    store1.stop()

    // Restart while online; fresh /sync reports that ME was removed (`leave`) from ROOM while offline.
    const hs2 = scriptedHomeserver()
    const store2 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs2.base,
      { cache: null, vaultIdb: idb, principal: PRINCIPAL, activeRoomId: ROOM }
    )
    stores.push(store2)
    void store2.start()

    hs2.deliverSync(0, {
      next_batch: 's2',
      rooms: {
        leave: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$l1', 'm.room.member', { membership: 'leave' }, ME),
              ],
            },
            timeline: { events: [], limited: false },
          },
        },
      },
    })

    await changed(
      store2,
      () => store2.getOutboxStatus(ROOM)[0]?.state === 'refused'
    )
    // ZERO network PUT /send calls were made!
    expect(hs2.sentRequests).toHaveLength(0)
    const status = store2.getOutboxStatus(ROOM)[0]!
    expect(status).toMatchObject({
      clientTxnId: 'txn-revoked-1',
      roomId: ROOM,
      state: 'refused',
      reason: 'membership-revoked',
    })
    expect(JSON.stringify(status)).not.toContain('sensitive-offline-draft')
    await vi.waitFor(() => {
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'outbox').size).toBe(0)
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'rooms').size).toBe(0)
    })
  })

  it('policy-readonly-while-offline: refuses network replay when io.kodera.room.policy becomes read-only or mutes member while offline', async () => {
    const idb = createTestVaultIndexedDb()
    const hs1 = scriptedHomeserver({
      onSend: () => {
        throw new TypeError('Network unreachable')
      },
    })
    const vault1 = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    const store1 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs1.base,
      { cache: null, vault: vault1, vaultIdb: idb, principal: PRINCIPAL }
    )
    stores.push(store1)
    void store1.start()

    hs1.deliverSync(0, {
      next_batch: 's1',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: AGENT, room_version: '10' }, '', AGENT),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m1', 'open-channel')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(store1, () => store1.getSnapshot().status === 'live')

    await expect(
      store1.send(ROOM, 'queued-before-readonly', { clientTxnId: 'txn-readonly-1' })
    ).rejects.toThrow()
    expect(store1.getOutboxStatus(ROOM)[0]?.state).toBe('queued')
    store1.stop()

    // Reconnect on restart: fresh /sync delivers `io.kodera.room.policy` with `read_only: true` from `@kodera-agent`.
    const hs2 = scriptedHomeserver()
    const store2 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs2.base,
      { cache: null, vaultIdb: idb, principal: PRINCIPAL }
    )
    stores.push(store2)
    void store2.start()

    hs2.deliverSync(0, {
      next_batch: 's2',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: AGENT, room_version: '10' }, '', AGENT),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
                state(
                  '$pol1',
                  'io.kodera.room.policy',
                  { read_only: true, kind: 'text' },
                  '',
                  AGENT
                ),
              ],
            },
            timeline: { events: [live('$m1', 'open-channel')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })

    await changed(store2, () => store2.getOutboxStatus(ROOM)[0]?.state === 'refused')
    expect(hs2.sentRequests).toHaveLength(0)
    expect(store2.getOutboxStatus(ROOM)[0]).toMatchObject({
      clientTxnId: 'txn-readonly-1',
      roomId: ROOM,
      state: 'refused',
      reason: 'policy-readonly',
    })
    await vi.waitFor(() => {
      expect(idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'outbox').size).toBe(0)
    })
  })

  it('quarantines queued outbox item if room becomes confidential/epoch>0 while offline, and replays with deterministic clientTxnId when revalidation passes', async () => {
    // Part A: room transitions to confidential / epoch 1 while offline -> quarantined, zero network send.
    const idbConfidential = createTestVaultIndexedDb()
    const vaultConf = await openEspaceVault(PRINCIPAL, { idb: idbConfidential, delayMs: 0 })
    await vaultConf.putOutbox({
      clientTxnId: 'txn-epoch-changed',
      roomId: ROOM,
      verifiedBoundary: 'ordinary',
      body: 'never-send-in-confidential-epoch',
      content: { msgtype: 'm.text', body: 'never-send-in-confidential-epoch' },
    })
    await vaultConf.close()

    const hsConf = scriptedHomeserver()
    const storeConf = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hsConf.base,
      { cache: null, vaultIdb: idbConfidential, principal: PRINCIPAL }
    )
    stores.push(storeConf)
    void storeConf.start()

    hsConf.deliverSync(0, {
      next_batch: 's-conf',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: AGENT, room_version: '10' }, '', AGENT),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
                state('$enc1', 'm.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }, '', AGENT),
              ],
            },
            timeline: { events: [], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })

    await changed(storeConf, () => storeConf.getOutboxStatus(ROOM)[0]?.state === 'quarantined')
    expect(hsConf.sentRequests).toHaveLength(0)
    expect(storeConf.getOutboxStatus(ROOM)[0]).toMatchObject({
      clientTxnId: 'txn-epoch-changed',
      roomId: ROOM,
      state: 'quarantined',
      reason: 'boundary-or-epoch-changed',
    })
    storeConf.stop()

    // Part B: happy-path server-revalidated replay with deterministic `clientTxnId` when membership + policy + epoch=0 all pass!
    const idbOk = createTestVaultIndexedDb()
    const vaultOk = await openEspaceVault(PRINCIPAL, { idb: idbOk, delayMs: 0 })
    await vaultOk.putOutbox({
      clientTxnId: 'txn-deterministic-42',
      roomId: ROOM,
      verifiedBoundary: 'ordinary',
      body: 'revalidated-hello',
      content: { msgtype: 'm.text', body: 'revalidated-hello' },
    })
    await vaultOk.close()

    const hsOk = scriptedHomeserver()
    const storeOk = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hsOk.base,
      { cache: null, vaultIdb: idbOk, principal: PRINCIPAL }
    )
    stores.push(storeOk)
    void storeOk.start()

    // Before /sync answers, zero network sends occur!
    await vi.waitFor(() => expect(hsOk.syncCount()).toBeGreaterThanOrEqual(1))
    expect(hsOk.sentRequests).toHaveLength(0)

    // Deliver fresh /sync confirming join + writable policy + ordinary boundary + epoch 0.
    hsOk.deliverSync(0, {
      next_batch: 's-ok',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m1', 'prior')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })

    await vi.waitFor(() => expect(hsOk.sentRequests).toHaveLength(1))
    expect(hsOk.sentRequests[0]).toEqual({
      roomId: ROOM,
      txnId: 'txn-deterministic-42',
      body: { msgtype: 'm.text', body: 'revalidated-hello' },
    })
    await vi.waitFor(() => {
      expect(storeOk.getOutboxStatus(ROOM)).toEqual([])
      expect(idbOk.peekStoreRows(ESPACE_VAULT_DATABASE, 'outbox').size).toBe(0)
    })
  })

  it('cryptographically wipes kodera.espace-vault.v1 on /sync 403 M_FORBIDDEN or SessionLoggedOut', async () => {
    const idb = createTestVaultIndexedDb()
    const seed = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    seed.scheduleRoomSave(ROOM, 'ordinary', [kept('$k1')])
    await seed.close()

    const hs = scriptedHomeserver()
    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs.base,
      { cache: null, vaultIdb: idb, principal: PRINCIPAL, activeRoomId: ROOM }
    )
    stores.push(store)
    void store.start()

    await changed(store, () => store.getTimeline(ROOM).length === 1)

    // Workspace/session 403 M_FORBIDDEN from homeserver /sync triggers cryptographic wipe!
    hs.deliverSync(
      0,
      { errcode: 'M_FORBIDDEN', error: 'Membership suspended' },
      403
    )

    await changed(store, () => store.getSnapshot().status === 'signed-out')
    expect(store.getTimeline(ROOM)).toEqual([])
    await vi.waitFor(() => {
      expect(idb.deletedDatabases).toContain(ESPACE_VAULT_DATABASE)
      expect(idb.deletedDatabases).toContain(LEGACY_TIMELINE_DATABASE)
    })
  })

  it('catchup-epoch-gate: holds outbox replay across ERROR -> CATCHUP until recovery /sync (SYNCING) is ingested', async () => {
    const idb = createTestVaultIndexedDb()
    let failVersionsOnce = false
    const hs = scriptedHomeserver()
    const baseWithConnectivityDrop = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (decodeURIComponent(url.pathname) === '/_matrix/client/versions' && failVersionsOnce) {
        failVersionsOnce = false
        return json(503, { errcode: 'M_UNKNOWN', error: 'offline' })
      }
      return hs.base(input, init)
    })

    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      baseWithConnectivityDrop,
      { cache: null, vaultIdb: idb, principal: PRINCIPAL }
    )
    stores.push(store)
    void store.start()

    hs.deliverSync(0, {
      next_batch: 's-init',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m1', 'hello')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(store, () => store.getSnapshot().status === 'live')

    // Queue an offline outbox message while `navigator.onLine === false`.
    const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await store.send(ROOM, 'hold-until-syncing', { clientTxnId: 'txn-catchup-gate' })
    onlineSpy.mockRestore()
    expect(hs.sentRequests).toHaveLength(0)
    expect(store.getOutboxStatus(ROOM)[0]?.state).toBe('queued')

    // Fail two consecutive /sync calls + one keepalive `/versions` probe so matrix-js-sdk
    // transitions `RECONNECTING -> ERROR -> CATCHUP` BEFORE recovery `/sync` #3 answers!
    await vi.waitFor(() => expect(hs.syncCount()).toBeGreaterThanOrEqual(2))
    hs.deliverSync(1, { errcode: 'M_UNKNOWN', error: 'drop-1' }, 503)
    await new Promise((r) => setTimeout(r, 15))
    window.dispatchEvent(new Event('online'))

    await vi.waitFor(() => expect(hs.syncCount()).toBeGreaterThanOrEqual(3))
    failVersionsOnce = true
    hs.deliverSync(2, { errcode: 'M_UNKNOWN', error: 'drop-2' }, 503)
    await new Promise((r) => setTimeout(r, 15))
    // First `online` wakes keepalive poke 1 (fails 503 -> connDidFail = true);
    // second `online` wakes keepalive poke 2 (200 -> SyncState.Catchup emitted before /sync #3 answers!).
    window.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 15))
    window.dispatchEvent(new Event('online'))

    // Recovery `/sync` #3 is now in-flight AFTER `SyncState.Catchup` fired, but unanswered.
    await vi.waitFor(() => expect(hs.syncCount()).toBeGreaterThanOrEqual(4))
    await new Promise((r) => setTimeout(r, 30))
    expect(store.getSnapshot().status).toBe('reconnecting')
    expect(hs.sentRequests).toHaveLength(0)

    // Now deliver recovery `/sync` #3 (`SyncState.Syncing`) confirming join + ordinary boundary -> replay fires!
    hs.deliverSync(3, {
      next_batch: 's-recovered',
      rooms: {
        join: {
          [ROOM]: {
            state: { events: [] },
            timeline: { events: [], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })

    await vi.waitFor(() => expect(hs.sentRequests).toHaveLength(1))
    expect(hs.sentRequests[0]?.txnId).toBe('txn-catchup-gate')
  })

  it('disables MatrixScheduler automatic 429 retries, routes 429 through fresh-/sync revalidation, and enforces transport fence on membership/archive', async () => {
    const idb = createTestVaultIndexedDb()
    let rateLimitNext = true
    const hs = scriptedHomeserver({
      onSend: () => {
        if (rateLimitNext) {
          rateLimitNext = false
          return json(429, {
            errcode: 'M_LIMIT_EXCEEDED',
            error: 'Too Many Requests',
            retry_after_ms: 35,
          })
        }
        return json(200, { event_id: '$ok-after-429' })
      },
    })

    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs.base,
      { cache: null, vaultIdb: idb, principal: PRINCIPAL }
    )
    stores.push(store)
    void store.start()

    hs.deliverSync(0, {
      next_batch: 's-429-0',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: AGENT, room_version: '10' }, '', AGENT),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m1', 'hello')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(store, () => store.getSnapshot().status === 'live')

    await expect(
      store.send(ROOM, 'rate-limited-message', { clientTxnId: 'txn-429-revalidated' })
    ).rejects.toThrow()
    expect(hs.sentRequests).toHaveLength(1)
    expect(store.getOutboxStatus(ROOM)[0]?.state).toBe('queued')

    // Wait well past `retry_after_ms` (35 ms) while Sync 1 remains unanswered:
    // neither MatrixScheduler nor our outbox may retry before a fresh `/sync` is ingested!
    await new Promise((r) => setTimeout(r, 110))
    expect(hs.sentRequests).toHaveLength(1)

    // Next `/sync` makes the room read-only -> queued 429 message is refused with zero extra sends!
    hs.deliverSync(1, {
      next_batch: 's-429-1',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state(
                  '$pol-ro',
                  'io.kodera.room.policy',
                  { read_only: true, kind: 'text' },
                  '',
                  AGENT
                ),
              ],
            },
            timeline: { events: [], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })

    await changed(store, () => store.getOutboxStatus(ROOM)[0]?.state === 'refused')
    expect(hs.sentRequests).toHaveLength(1)
    expect(store.getOutboxStatus(ROOM)[0]).toMatchObject({
      clientTxnId: 'txn-429-revalidated',
      state: 'refused',
      reason: 'policy-readonly',
    })

    // Transport fence also blocks direct mutations when workspace membership is deactivated.
    const hsFence = scriptedHomeserver()
    const fencedStore = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hsFence.base,
      { cache: null, vault: null, membershipActive: false }
    )
    stores.push(fencedStore)
    void fencedStore.start()
    hsFence.deliverSync(0, {
      next_batch: 's-fence',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m1', 'hello')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(fencedStore, () => fencedStore.getSnapshot().status === 'live')
    await expect(fencedStore.react(ROOM, '$m1', '+1')).rejects.toThrow(/membership is inactive/i)
    await expect(fencedStore.setPinned(ROOM, '$m1', true)).rejects.toThrow(/membership is inactive/i)
    expect(hsFence.sentRequests).toHaveLength(0)
  })

  it('persists channelId on OutboxRecord and fails closed (holds replay) when non-DM channel archive mapping is unresolved', async () => {
    // Subcase A: `channelId` persisted in outbox blocks replay on restart even before sidebar channel map resolves.
    const idbPersisted = createTestVaultIndexedDb()
    const hs1 = scriptedHomeserver({
      onSend: () => {
        throw new TypeError('offline')
      },
    })
    const store1 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs1.base,
      { cache: null, vaultIdb: idbPersisted, principal: PRINCIPAL }
    )
    stores.push(store1)
    void store1.start()
    hs1.deliverSync(0, {
      next_batch: 's1',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(store1, () => store1.getSnapshot().status === 'live')
    await expect(
      store1.send(ROOM, 'archived-channel-msg', {
        clientTxnId: 'txn-persisted-channel',
        channelId: 'ch-archived-now',
      })
    ).rejects.toThrow()
    store1.stop()

    const hs2 = scriptedHomeserver()
    const store2 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs2.base,
      {
        cache: null,
        vaultIdb: idbPersisted,
        principal: PRINCIPAL,
        workspaceChannelIds: new Set(['ch-archived-now']),
        archivedChannelIds: new Set(['ch-archived-now']),
      }
    )
    stores.push(store2)
    void store2.start()
    hs2.deliverSync(0, {
      next_batch: 's2',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(store2, () => store2.getOutboxStatus(ROOM)[0]?.state === 'refused')
    expect(hs2.sentRequests).toHaveLength(0)
    expect(store2.getOutboxStatus(ROOM)[0]).toMatchObject({
      clientTxnId: 'txn-persisted-channel',
      state: 'refused',
      reason: 'channel-archived',
    })
    store2.stop()

    // Subcase B: Outbox item without `channelId` in a non-DM room holds replay while archived channel mapping is unresolved.
    const idbUnresolved = createTestVaultIndexedDb()
    const seedVault = await openEspaceVault(PRINCIPAL, { idb: idbUnresolved, delayMs: 0 })
    await seedVault.putOutbox({
      clientTxnId: 'txn-hold-unresolved',
      roomId: ROOM,
      verifiedBoundary: 'ordinary',
      body: 'hold-until-channel-resolved',
      content: { msgtype: 'm.text', body: 'hold-until-channel-resolved' },
    })
    await seedVault.close()

    let resolveDirectory!: () => void
    const directoryGate = new Promise<void>((r) => {
      resolveDirectory = r
    })
    const hs3 = scriptedHomeserver()
    const baseWithHeldDirectory = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (decodeURIComponent(url.pathname).startsWith('/_matrix/client/v3/directory/room/')) {
        await directoryGate
        return json(200, { room_id: ROOM })
      }
      return hs3.base(input, init)
    })

    const slowArchivedChannelId = '11111111-2222-4333-8444-555555555555'
    const store3 = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      baseWithHeldDirectory,
      {
        cache: null,
        vaultIdb: idbUnresolved,
        principal: PRINCIPAL,
        workspaceChannelIds: new Set([slowArchivedChannelId]),
        archivedChannelIds: new Set([slowArchivedChannelId]),
      }
    )
    stores.push(store3)
    void store3.start()
    void store3.resolveChannels([slowArchivedChannelId])

    hs3.deliverSync(0, {
      next_batch: 's3',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(store3, () => store3.getSnapshot().status === 'live')
    await new Promise((r) => setTimeout(r, 30))

    // Held fail-closed while channel resolution is still pending: 0 sends, item still queued!
    expect(hs3.sentRequests).toHaveLength(0)
    expect(store3.getOutboxStatus(ROOM)[0]?.state).toBe('queued')

    // Once channel directory resolves `ch-slow-archived -> ROOM`, replay re-evaluates and refuses with `'channel-archived'`!
    resolveDirectory()
    await changed(store3, () => store3.getOutboxStatus(ROOM)[0]?.state === 'refused')
    expect(hs3.sentRequests).toHaveLength(0)
    expect(store3.getOutboxStatus(ROOM)[0]).toMatchObject({
      clientTxnId: 'txn-hold-unresolved',
      state: 'refused',
      reason: 'channel-archived',
    })
  })

  it('wipes room timeline + encrypted draft + outbox AND rotates owner CryptoKey + incarnation on send 403 M_FORBIDDEN', async () => {
    const idb = createTestVaultIndexedDb()
    const roomSurviving = '!surviving:matrix.acme.kodera.test'
    const vault = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    const hs = scriptedHomeserver({
      onSend: (roomId) => {
        if (roomId === ROOM) {
          return json(403, { errcode: 'M_FORBIDDEN', error: 'Removed from room' })
        }
        return json(200, { event_id: '$ok' })
      },
    })

    const store = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hs.base,
      { cache: null, vault, vaultIdb: idb, principal: PRINCIPAL }
    )
    stores.push(store)
    void store.start()

    hs.deliverSync(0, {
      next_batch: 's-403',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m1', 'before-403')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
          [roomSurviving]: {
            state: {
              events: [
                state('$c2', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j2', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [live('$m2', 'surviving-msg')], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(
      store,
      () => store.getTimeline(ROOM).length === 1 && store.getTimeline(roomSurviving).length === 1
    )
    await vault.flush()
    await vault.putDraft(ROOM, 'ordinary', 'secret-draft-in-revoked-room', 'thread-draft')
    await vault.putDraft(roomSurviving, 'ordinary', 'surviving-draft', '')

    const ownerBefore = (
      [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'owners').values()] as Array<{
        incarnation: string
        key?: CryptoKey
      }>
    )[0]!

    await expect(
      store.send(ROOM, 'triggers-403', { clientTxnId: 'txn-403-wipe' })
    ).rejects.toThrow()

    await vi.waitFor(async () => {
      const ownerAfter = (
        [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'owners').values()] as Array<{
          incarnation: string
          key?: CryptoKey
        }>
      )[0]!
      expect(ownerAfter.incarnation).not.toBe(ownerBefore.incarnation)
      expect(ownerAfter.key).not.toBe(ownerBefore.key)
      expect(await vault.readDraft(ROOM)).toBeNull()
      // Live in-memory plaintext timeline + sidebar room summary for the forbidden room are scrubbed too!
      expect(store.getTimeline(ROOM)).toEqual([])
      expect(store.getSnapshot().rooms.some((r) => r.roomId === ROOM)).toBe(false)
    })

    expect(store.getOutboxStatus(ROOM)[0]).toMatchObject({
      clientTxnId: 'txn-403-wipe',
      state: 'refused',
      reason: 'membership-revoked',
    })
    expect(store.getTimeline(roomSurviving).map((m) => m.body)).toEqual(['surviving-msg'])
    expect((await vault.readDraft(roomSurviving))?.text).toBe('surviving-draft')
  })

  it('persists 429 Retry-After notBefore across restart so first /sync does not replay early before Retry-After expires', async () => {
    const idb = createTestVaultIndexedDb()
    let nowMs = 1_762_500_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    try {
      const hs1 = scriptedHomeserver({
        onSend: () =>
          json(429, {
            errcode: 'M_LIMIT_EXCEEDED',
            error: 'Too Many Requests',
            retry_after_ms: 60_000,
          }),
      })
      const vault1 = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0, now: () => nowMs })
      const store1 = createEspaceStore(
        { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
        hs1.base,
        { cache: null, vault: vault1, vaultIdb: idb, principal: PRINCIPAL }
      )
      stores.push(store1)
      void store1.start()

      hs1.deliverSync(0, {
        next_batch: 's-rl-1',
        rooms: {
          join: {
            [ROOM]: {
              state: {
                events: [
                  state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                  state('$j1', 'm.room.member', { membership: 'join' }, ME),
                ],
              },
              timeline: { events: [], limited: false },
              unread_notifications: { notification_count: 0, highlight_count: 0 },
            },
          },
        },
      })
      await changed(store1, () => store1.getSnapshot().status === 'live')

      await expect(
        store1.send(ROOM, 'persisted-backoff-body', { clientTxnId: 'txn-429-restart' })
      ).rejects.toThrow()
      await vi.waitFor(async () => {
        const cold = await vault1.coldStartRead()
        expect(cold.outbox[0]?.notBefore).toBe(nowMs + 60_000)
      })
      store1.stop()

      // Restart 5 seconds later (`55s` of Retry-After still remaining!): first `/sync` MUST NOT replay early!
      nowMs += 5_000
      const hs2 = scriptedHomeserver()
      const store2 = createEspaceStore(
        { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
        hs2.base,
        { cache: null, vaultIdb: idb, principal: PRINCIPAL }
      )
      stores.push(store2)
      void store2.start()

      hs2.deliverSync(0, {
        next_batch: 's-rl-2',
        rooms: {
          join: {
            [ROOM]: {
              state: {
                events: [
                  state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                  state('$j1', 'm.room.member', { membership: 'join' }, ME),
                ],
              },
              timeline: { events: [], limited: false },
              unread_notifications: { notification_count: 0, highlight_count: 0 },
            },
          },
        },
      })
      await changed(store2, () => store2.getSnapshot().status === 'live')
      await new Promise((r) => setTimeout(r, 40))

      expect(hs2.sentRequests).toHaveLength(0)
      expect(store2.getOutboxStatus(ROOM)[0]?.state).toBe('queued')

      // Advance clock past `notBefore` and deliver next `/sync` -> now revalidated replay succeeds!
      nowMs += 60_000
      hs2.deliverSync(1, {
        next_batch: 's-rl-3',
        rooms: {
          join: {
            [ROOM]: {
              state: { events: [] },
              timeline: { events: [], limited: false },
              unread_notifications: { notification_count: 0, highlight_count: 0 },
            },
          },
        },
      })
      await vi.waitFor(() => expect(hs2.sentRequests).toHaveLength(1))
      expect(hs2.sentRequests[0]?.txnId).toBe('txn-429-restart')
    } finally {
      nowSpy.mockRestore()
    }

    // Also verify the hydrated `#armOutboxRetryTimer` wakes replay automatically once `notBefore` expires after Sync 0!
    const idbTimer = createTestVaultIndexedDb()
    const seedTimerVault = await openEspaceVault(PRINCIPAL, { idb: idbTimer, delayMs: 0 })
    await seedTimerVault.putOutbox({
      clientTxnId: 'txn-429-hydrated-timer',
      roomId: ROOM,
      verifiedBoundary: 'ordinary',
      notBefore: Date.now() + 90,
      body: 'timer-woken-body',
      content: { msgtype: 'm.text', body: 'timer-woken-body' },
    })
    await seedTimerVault.close()

    const hsTimer = scriptedHomeserver()
    const storeTimer = createEspaceStore(
      { baseUrl: HS, userId: ME, deviceId: 'DEV', accessToken: 'at' },
      hsTimer.base,
      { cache: null, vaultIdb: idbTimer, principal: PRINCIPAL }
    )
    stores.push(storeTimer)
    void storeTimer.start()
    hsTimer.deliverSync(0, {
      next_batch: 's-timer-0',
      rooms: {
        join: {
          [ROOM]: {
            state: {
              events: [
                state('$c1', 'm.room.create', { creator: ME, room_version: '10' }),
                state('$j1', 'm.room.member', { membership: 'join' }, ME),
              ],
            },
            timeline: { events: [], limited: false },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          },
        },
      },
    })
    await changed(storeTimer, () => storeTimer.getSnapshot().status === 'live')
    // Immediately after Sync 0 (well before 90 ms), 0 sends have fired.
    expect(hsTimer.sentRequests).toHaveLength(0)
    // Without delivering another /sync, the hydrated retry timer fires past 90 ms and replays!
    await vi.waitFor(() => expect(hsTimer.sentRequests).toHaveLength(1), { timeout: 1000 })
    expect(hsTimer.sentRequests[0]?.txnId).toBe('txn-429-hydrated-timer')
  })
})
