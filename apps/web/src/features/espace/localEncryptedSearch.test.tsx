import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { RoomBoundary } from '../confidential/room-boundary'
import { MessageSearch } from './MessageSearch'
import type { EspaceStoreLike } from './liveViewModel'
import {
  LocalEncryptedSearchEngine,
  MAX_INDEXED_MESSAGES_PER_SHARD,
  MAX_TOKENS_PER_MESSAGE,
  searchRoomTimelineLocally,
  tokenizeSearchText,
  workspaceLocalEncryptedSearch,
} from './localEncryptedSearch'
import {
  ESPACE_VAULT_DATABASE,
  openEspaceVault,
  wipeEspaceVault,
  type EspaceVault,
  type EspaceVaultPrincipal,
} from './matrix/encryptedCache'
import { createTestVaultIndexedDb } from './matrix/testVaultIdb'
import type { MessageView } from './matrix/timeline'

const PRINCIPAL: EspaceVaultPrincipal = {
  ownerId: '@camille:matrix.acme.kodera.test',
  organisationId: 'org-acme-zk',
  membershipId: 'mem-camille-zk',
  deviceId: 'DEV_CAMILLE_ZK',
}

const ROOM_E2EE_DM = '!dm-secret:matrix.acme.kodera.test'
const ROOM_STANDARD = '!general:matrix.acme.kodera.test'
const ROOM_LOCKED = '!locked-conf:matrix.acme.kodera.test'

function makeMsg(
  eventId: string,
  body: string,
  ts: number,
  options?: { sender?: string; senderName?: string; redacted?: boolean }
): MessageView {
  return {
    key: eventId,
    eventId,
    sender: options?.sender ?? '@nadia:matrix.acme.kodera.test',
    ...(options?.senderName === undefined ? {} : { senderName: options.senderName }),
    body,
    ts,
    edited: false,
    redacted: options?.redacted ?? false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

function dumpRawBytes(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  ) {
    return new TextDecoder().decode(new Uint8Array(value as ArrayBuffer))
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    )
  }
  if (Array.isArray(value)) return value.map(dumpRawBytes).join('|')
  if (typeof value === 'object') {
    if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) return '[CryptoKey]'
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}:${dumpRawBytes(v)}`)
      .join('|')
  }
  return ''
}

const openVaults: EspaceVault[] = []
afterEach(() => {
  workspaceLocalEncryptedSearch.clearAll()
  for (const v of openVaults.splice(0)) {
    v.closeImmediate()
  }
  vi.restoreAllMocks()
})

describe('localEncryptedSearch — zero-egress client FTS, blind HMAC tags & #180 quarantine', () => {
  it('folds NFD accents, drops 1-char tokens, and caps per-message terms at 64', () => {
    expect(tokenizeSearchText('À côté de l’Élysée : été 2026 !')).toEqual([
      'cote',
      'de',
      'elysee',
      'ete',
      '2026',
    ])
    const manyUnique = Array.from({ length: 95 }, (_, idx) => `terme${idx + 10}`).join(' ')
    const tokens = tokenizeSearchText(manyUnique)
    expect(tokens).toHaveLength(MAX_TOKENS_PER_MESSAGE)
  })

  it('seals unlocked E2EE shards with blind HMAC tags & AES-GCM AAD, hydrates cold-start, and issues zero network calls', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network egress during local search'))
    const idb = createTestVaultIndexedDb()
    const vault = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    openVaults.push(vault)

    const unlockedEpochs = new Map<string, number>([[ROOM_E2EE_DM, 5]])
    const quarantinedRooms = new Set<string>()
    const store = {
      getRoomBoundary: (roomId: string): RoomBoundary =>
        roomId === ROOM_STANDARD ? 'ordinary' : 'confidential-unavailable',
      isRoomQuarantined: (roomId: string) => quarantinedRooms.has(roomId),
      getUnlockedEncryptedRoomSearchAuthority: (roomId: string) => {
        const ep = unlockedEpochs.get(roomId)
        return ep === undefined ? null : ({ unlocked: true as const, epoch: ep } as const)
      },
    }

    const engine = new LocalEncryptedSearchEngine()
    try {
      // Locked confidential room without unlocked decryptor MUST fail closed!
      const lockedIndexed = await engine.indexRoom({
        store,
        roomId: ROOM_LOCKED,
        messages: [makeMsg('$lk1', 'Acquisition confidentielle verrouillée', 1_000)],
        vault,
      })
      expect(lockedIndexed).toBe(false)
      expect(engine.hasRoom(ROOM_LOCKED)).toBe(false)

      // Unlocked E2EE room at epoch 5 indexes locally and seals blind-tagged shard in IDB.
      const secretBody = 'Protocole SFrame validé pour la réunion confidentielle'
      const ok = await engine.indexRoom({
        store,
        roomId: ROOM_E2EE_DM,
        messages: [
          makeMsg('$dm1', secretBody, 2_000, { senderName: 'Hélène Morel' }),
          makeMsg('$dm2', 'Message révoqué confidentiel', 2_500, { redacted: true }),
        ],
        vault,
      })
      expect(ok).toBe(true)

      await engine.indexRoom({
        store,
        roomId: ROOM_STANDARD,
        messages: [makeMsg('$g1', 'Bienvenue dans le salon général équipe', 1_500)],
        vault,
      })

      // Raw IndexedDB search_index rows contain ZERO plaintext words or snippets.
      const rawShards = [...idb.peekStoreRows(ESPACE_VAULT_DATABASE, 'search_index').values()]
      expect(rawShards).toHaveLength(2)
      for (const raw of rawShards) {
        const dumped = dumpRawBytes(raw)
        expect(dumped).not.toContain('SFrame')
        expect(dumped).not.toContain('reunion')
        expect(dumped).not.toContain('Helene')
        expect(dumped).not.toContain(secretBody)
      }

      // Cold-start hydration into a fresh engine instance queries via blind HMAC tags.
      const coldEngine = new LocalEncryptedSearchEngine()
      try {
        expect(
          await coldEngine.hydrateRoomFromVault({
            store,
            roomId: ROOM_E2EE_DM,
            vault,
          })
        ).toBe(true)

        const hits = await coldEngine.search({
          store,
          query: 'HELENE sframe reunion',
          vault,
        })
        expect(hits).toHaveLength(1)
        expect(hits[0]?.eventId).toBe('$dm1')
        expect(hits[0]?.boundaryTag).toBe('confidential-e2ee')
        expect(hits[0]?.epoch).toBe(5)

        // Redacted message is never indexed.
        expect(await coldEngine.search({ store, query: 'revoque', vault })).toEqual([])
      } finally {
        coldEngine.dispose()
      }

      // Quarantine (#180) on ROOM_E2EE_DM synchronously evicts RAM BEFORE IDB settles,
      // rotates vault AES + HMAC keys, and preserves surviving ROOM_STANDARD via re-key!
      quarantinedRooms.add(ROOM_E2EE_DM)
      unlockedEpochs.delete(ROOM_E2EE_DM)
      const purgePromise = vault.quarantineRoom(ROOM_E2EE_DM)
      // Synchronously evicted on the exact tick before `await purgePromise`!
      expect(engine.hasRoom(ROOM_E2EE_DM)).toBe(false)
      await purgePromise

      expect(await engine.search({ store, query: 'sframe', vault })).toEqual([])
      const standardHits = await engine.search({ store, query: 'bienvenue equipe', vault })
      expect(standardHits).toHaveLength(1)
      expect(standardHits[0]?.eventId).toBe('$g1')

      // Full vault wipe synchronously clears all remaining RAM postings.
      const wipePromise = wipeEspaceVault(idb)
      expect(engine.indexedRoomCount).toBe(0)
      await wipePromise
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      engine.dispose()
    }
  })

  it('caps per-room indexed messages at 500 and enforces #180 quarantine in MessageSearch UI with zero network egress', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network egress'))
    const messages = Array.from({ length: 540 }, (_, i) =>
      makeMsg(`$m-${i}`, `Entrée confidentielle numéro ${i} jalon`, 10_000 + i)
    )
    let unlocked = true
    let quarantined = false
    const snapshot = { status: 'live' as const, rooms: [], invites: [], channels: new Map() }

    const store: EspaceStoreLike = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      getUserId: () => '@camille:matrix.acme.kodera.test',
      getTimeline: () => messages,
      getThread: () => [],
      getRoomBoundary: () => 'confidential-unavailable',
      isRoomQuarantined: () => quarantined,
      getUnlockedEncryptedRoomSearchAuthority: () =>
        unlocked ? { unlocked: true, epoch: 2 } : null,
      send: async () => undefined,
      edit: async () => undefined,
      remove: async () => undefined,
      toggleReaction: async () => undefined,
    }

    const engine = new LocalEncryptedSearchEngine()
    try {
      await engine.indexRoom({ store, roomId: ROOM_E2EE_DM, messages })
      // Oldest 40 messages beyond the 500 cap are excluded; newest are searchable.
      expect(await engine.search({ store, query: 'numero 539 jalon' })).toHaveLength(1)
      expect(MAX_INDEXED_MESSAGES_PER_SHARD).toBe(500)
    } finally {
      engine.dispose()
    }

    // MessageSearch UI permits unlocked E2EE room locally, then refuses immediately when locked/quarantined.
    const user = userEvent.setup()
    const onShow = vi.fn(() => true)
    const { rerender } = render(
      <MessageSearch store={store} roomId={ROOM_E2EE_DM} onShow={onShow} />
    )
    await user.click(screen.getByTestId('espace-find-trigger'))
    const field = screen.getByRole('searchbox')
    await user.type(field, 'jalon 539')
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(1))

    // Lock / quarantine the room (#180): local search immediately returns empty and evicts RAM!
    unlocked = false
    quarantined = true
    expect(searchRoomTimelineLocally(store, ROOM_E2EE_DM, 'jalon')).toEqual({
      messages: [],
      more: false,
    })
    expect(workspaceLocalEncryptedSearch.hasRoom(ROOM_E2EE_DM)).toBe(false)

    rerender(<MessageSearch store={store} roomId={ROOM_E2EE_DM} onShow={onShow} />)
    await user.type(field, ' ')
    await waitFor(() => expect(within(dialog).queryAllByRole('listitem')).toHaveLength(0))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('retains tokens beyond 240-char snippet across epoch-0 vault hydration + rekey, supports prefix matching, and drops mid-await evicted rooms', async () => {
    const idb = createTestVaultIndexedDb()
    const vault = await openEspaceVault(PRINCIPAL, { idb, delayMs: 0 })
    openVaults.push(vault)

    // Pre-quarantined confidential room that unlocks at initial epoch 0!
    await vault.quarantineRoom(ROOM_E2EE_DM)
    const unlockedEpochs = new Map<string, number>([[ROOM_E2EE_DM, 0]])
    const store = {
      getRoomBoundary: (roomId: string): RoomBoundary =>
        roomId === ROOM_STANDARD ? 'ordinary' : 'confidential-unavailable',
      isRoomQuarantined: () => false,
      getUnlockedEncryptedRoomSearchAuthority: (roomId: string) => {
        const ep = unlockedEpochs.get(roomId)
        return ep === undefined ? null : ({ unlocked: true as const, epoch: ep } as const)
      },
    }

    const longBody = `${'préambule '.repeat(30)}tailkeywordomega9921`
    expect(longBody.length).toBeGreaterThan(280)

    const writer = new LocalEncryptedSearchEngine()
    const reader = new LocalEncryptedSearchEngine()
    try {
      expect(
        await writer.indexRoom({
          store,
          roomId: ROOM_E2EE_DM,
          messages: [makeMsg('$long1', longBody, 5_000)],
          vault,
        })
      ).toBe(true)

      // Hydrate into a fresh cold engine and rotate vault keys on an unrelated room!
      expect(await reader.hydrateRoomFromVault({ store, roomId: ROOM_E2EE_DM, vault })).toBe(true)
      await vault.forgetRoom('!unrelated-other:matrix.acme.kodera.test')

      // Prefix match ('tailkeywordomega') finds the token beyond char 240 even after vault re-key!
      const prefixHits = await reader.search({
        store,
        query: 'tailkeywordomega',
        vault,
      })
      expect(prefixHits).toHaveLength(1)
      expect(prefixHits[0]?.eventId).toBe('$long1')
      expect(prefixHits[0]?.epoch).toBe(0)

      // Mid-await clearAll / evictRoom drops in-flight search results!
      const origCompute = vault.computeBlindTermTag.bind(vault)
      let releaseTag!: () => void
      vi.spyOn(vault, 'computeBlindTermTag').mockImplementationOnce(async (room, tok) => {
        await new Promise<void>((resolve) => {
          releaseTag = resolve
        })
        return origCompute(room, tok)
      })

      const inFlight = reader.search({
        store,
        query: 'tailkeywordomega9921',
        vault,
      })
      await waitFor(() => expect(typeof releaseTag).toBe('function'))
      reader.clearAll()
      releaseTag()
      expect(await inFlight).toEqual([])
    } finally {
      writer.dispose()
      reader.dispose()
    }
  })
})
