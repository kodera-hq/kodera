import { describe, expect, it } from 'vitest'
import type { RoomBoundary } from '../confidential/room-boundary'
import type { MessageView } from '../espace/matrix/timeline'
import {
  MAX_INDEXED_MESSAGES_PER_ROOM,
  buildOmniboxIndex,
  isRoomSearchPermitted,
  queryOmnibox,
  type OmniboxCollectionDescriptor,
  type OmniboxRoomSource,
} from './omniboxIndex'

function makeMessage(
  eventId: string,
  body: string,
  ts: number,
  options?: { sender?: string; senderName?: string; redacted?: boolean }
): MessageView {
  return {
    key: eventId,
    eventId,
    sender: options?.sender ?? '@nadia:kodera.io',
    ...(options?.senderName ? { senderName: options.senderName } : {}),
    body,
    ts,
    edited: false,
    redacted: options?.redacted ?? false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

describe('omniboxIndex & fail-closed confidential quarantine', () => {
  it('fails closed when getRoomBoundary is absent and permits only ordinary and community boundaries', () => {
    const boundaries: Record<string, RoomBoundary> = {
      '!ord:kodera.io': 'ordinary',
      '!com:kodera.io': 'community',
      '!unk:kodera.io': 'unknown',
      '!inv:kodera.io': 'invalid',
      '!conf:kodera.io': 'confidential-unavailable',
    }
    const store = {
      getRoomBoundary: (roomId: string): RoomBoundary => boundaries[roomId] ?? 'unknown',
    }

    // Absent getRoomBoundary MUST fail closed even on an unmarked channel.
    expect(isRoomSearchPermitted({}, '!ord:kodera.io')).toBe(false)
    expect(isRoomSearchPermitted({ getRoomBoundary: undefined }, '!com:kodera.io')).toBe(false)

    expect(isRoomSearchPermitted(store, '!ord:kodera.io')).toBe(true)
    expect(isRoomSearchPermitted(store, '!com:kodera.io')).toBe(true)
    expect(isRoomSearchPermitted(store, '!unk:kodera.io')).toBe(false)
    expect(isRoomSearchPermitted(store, '!inv:kodera.io')).toBe(false)
    expect(isRoomSearchPermitted(store, '!conf:kodera.io')).toBe(false)

    // Channel metadata flags fail closed even if boundary reports ordinary.
    expect(isRoomSearchPermitted(store, '!ord:kodera.io', { isConfidential: true })).toBe(false)
    expect(isRoomSearchPermitted(store, '!ord:kodera.io', { is_confidential: true })).toBe(false)

    // Unlocked E2EE room authority (including initial epoch 0) permits local-only search until quarantined or locked (#180).
    let quarantined = false
    let unlockedEpoch: number | null = 0
    const unlockedStore = {
      getRoomBoundary: (): RoomBoundary => 'confidential-unavailable',
      isRoomQuarantined: () => quarantined,
      getUnlockedEncryptedRoomSearchAuthority: () =>
        unlockedEpoch === null ? null : ({ unlocked: true, epoch: unlockedEpoch } as const),
    }
    expect(
      isRoomSearchPermitted(unlockedStore, '!conf:kodera.io', { is_confidential: true })
    ).toBe(true)
    unlockedEpoch = 4
    expect(
      isRoomSearchPermitted(unlockedStore, '!conf:kodera.io', { is_confidential: true })
    ).toBe(true)
    quarantined = true
    expect(
      isRoomSearchPermitted(unlockedStore, '!conf:kodera.io', { is_confidential: true })
    ).toBe(false)
    quarantined = false
    unlockedEpoch = null
    expect(
      isRoomSearchPermitted(unlockedStore, '!conf:kodera.io', { is_confidential: true })
    ).toBe(false)
  })

  it('excludes boundary-less, confidential, unknown, invalid, and redacted messages from omnibox results', () => {
    const store = {
      getRoomBoundary: (roomId: string): RoomBoundary => {
        if (roomId === '!public:kodera.io') return 'ordinary'
        if (roomId === '!unknown:kodera.io') return 'unknown'
        return 'confidential-unavailable'
      },
    }
    const rooms: OmniboxRoomSource[] = [
      {
        roomId: '!public:kodera.io',
        targetId: 'ch-general',
        isDirect: false,
        label: '#général',
        timeline: [
          makeMessage('$m1', 'Architecture migration validée pour mardi', 1_000, {
            senderName: 'Élodie Roux',
          }),
          makeMessage('$m2', 'Architecture secret supprimé', 2_000, { redacted: true }),
        ],
      },
      {
        roomId: '!unknown:kodera.io',
        targetId: 'ch-unknown',
        isDirect: false,
        label: '#attente',
        timeline: [makeMessage('$m3', 'Architecture confidentielle en vérification', 3_000)],
      },
      {
        roomId: '!vault:kodera.io',
        targetId: 'ch-vault',
        isDirect: false,
        label: '#direction',
        timeline: [makeMessage('$m4', 'Architecture acquisition ultra secrète', 4_000)],
      },
      {
        roomId: '!public:kodera.io',
        targetId: 'ch-flagged',
        isDirect: false,
        label: '#juridique',
        channel: { is_confidential: true },
        timeline: [makeMessage('$m5', 'Architecture contrat confidentiel', 5_000)],
      },
    ]

    // Boundary-less store indexes zero rooms.
    const unguardedIndex = buildOmniboxIndex({ store: {}, rooms })
    expect(queryOmnibox(unguardedIndex, 'architecture').messages).toEqual([])

    const index = buildOmniboxIndex({ store, rooms })
    expect(queryOmnibox(index, 'a')).toEqual({ messages: [], collections: [] })

    const res = queryOmnibox(index, 'ELODIE migration')
    expect(res.messages).toHaveLength(1)
    expect(res.messages[0]?.eventId).toBe('$m1')
    expect(res.messages[0]?.targetId).toBe('ch-general')

    const broad = queryOmnibox(index, 'architecture')
    expect(broad.messages.map((hit) => hit.eventId)).toEqual(['$m1'])
  })

  it('caps per-room scan at newest 500 non-redacted messages and guards WeakMap caches against in-place mutations', () => {
    const ordinaryStore = { getRoomBoundary: (): RoomBoundary => 'ordinary' }
    const timeline: MessageView[] = Array.from({ length: 620 }, (_, idx) =>
      makeMessage(`$ev-${idx}`, `Rapport trimestriel séquence ${idx}`, 10_000 + idx)
    )
    const docObj = { id: 'page-q4', title: 'Feuille de route Q4' }
    const mutableCollection = {
      id: 'workspace-page:page-q4',
      title: 'Feuille de route Q4',
      propertiesText: 'status:in_progress assignee:Camille priority:high',
      content: 'Objectifs de résilience Postgres et bascule multi-zone.',
      cacheKey: docObj,
    }
    const collections: OmniboxCollectionDescriptor[] = [mutableCollection]

    const firstIndex = buildOmniboxIndex({
      store: ordinaryStore,
      rooms: [
        {
          roomId: '!ops:kodera.io',
          targetId: 'ch-ops',
          isDirect: false,
          label: '#opérations',
          timeline,
        },
      ],
      collections,
    })

    // Rebuilding with identical array & unmutated records hits WeakMap caches cleanly.
    const secondIndex = buildOmniboxIndex({
      store: ordinaryStore,
      rooms: [
        {
          roomId: '!ops:kodera.io',
          targetId: 'ch-ops',
          isDirect: false,
          label: '#opérations',
          timeline,
        },
      ],
      collections,
    })
    expect(secondIndex.rooms[0]?.records).toBe(firstIndex.rooms[0]?.records)
    expect(secondIndex.collections[0]).toBe(firstIndex.collections[0])
    expect(secondIndex.rooms[0]?.records).toHaveLength(MAX_INDEXED_MESSAGES_PER_ROOM)

    expect(
      queryOmnibox(secondIndex, 'sequence 0').messages.some((m) => m.eventId === '$ev-0')
    ).toBe(false)
    expect(queryOmnibox(secondIndex, 'sequence 619').messages.map((m) => m.eventId)).toEqual([
      '$ev-619',
    ])

    // In-place mutation of a middle MessageView (redaction & body edit) invalidates stale plaintext!
    const middleMsg = timeline[400]! as { body: string; redacted: boolean }
    middleMsg.body = 'Texte remplacé après édition'
    // Even before rebuilding the index, queryOmnibox drops records whose live body/redacted drifted.
    expect(queryOmnibox(secondIndex, 'sequence 400').messages).toEqual([])

    const afterEditIndex = buildOmniboxIndex({
      store: ordinaryStore,
      rooms: [
        {
          roomId: '!ops:kodera.io',
          targetId: 'ch-ops',
          isDirect: false,
          label: '#opérations',
          timeline,
        },
      ],
      collections,
    })
    expect(afterEditIndex.rooms[0]?.records).not.toBe(secondIndex.rooms[0]?.records)
    expect(queryOmnibox(afterEditIndex, 'remplace edition').messages.map((m) => m.eventId)).toEqual(
      ['$ev-400']
    )

    // In-place redaction of that same MessageView immediately suppresses it on both existing & rebuilt index.
    middleMsg.redacted = true
    expect(queryOmnibox(afterEditIndex, 'remplace edition').messages).toEqual([])
    const afterRedactIndex = buildOmniboxIndex({
      store: ordinaryStore,
      rooms: [
        {
          roomId: '!ops:kodera.io',
          targetId: 'ch-ops',
          isDirect: false,
          label: '#opérations',
          timeline,
        },
      ],
      collections,
    })
    expect(queryOmnibox(afterRedactIndex, 'remplace edition').messages).toEqual([])

    // In-place senderName mutation invalidates timeline cache and indexes the updated sender.
    const senderMsg = timeline[401]! as { senderName?: string }
    senderMsg.senderName = 'Séverine Moreau'
    expect(queryOmnibox(afterRedactIndex, 'sequence 401').messages).toEqual([])
    const afterSenderIndex = buildOmniboxIndex({
      store: ordinaryStore,
      rooms: [
        {
          roomId: '!ops:kodera.io',
          targetId: 'ch-ops',
          isDirect: false,
          label: '#opérations',
          timeline,
        },
      ],
      collections,
    })
    expect(queryOmnibox(afterSenderIndex, 'severine moreau').messages.map((m) => m.eventId)).toEqual(
      ['$ev-401']
    )

    // In-place mutation of collection properties/content sharing the same cacheKey refreshes haystack.
    mutableCollection.content = 'Nouvelle topologie Kafka inter-clusters.'
    const refreshedColIndex = buildOmniboxIndex({
      store: ordinaryStore,
      rooms: [],
      collections,
    })
    expect(queryOmnibox(refreshedColIndex, 'bascule multi-zone').collections).toEqual([])
    expect(queryOmnibox(refreshedColIndex, 'topologie kafka').collections).toHaveLength(1)
  })

  it('queries 5,000 messages + 1,000 collection entries in well under 50 ms', () => {
    const rooms: OmniboxRoomSource[] = Array.from({ length: 10 }, (_, roomIdx) => ({
      roomId: `!bench-${roomIdx}:kodera.io`,
      targetId: `ch-bench-${roomIdx}`,
      isDirect: false,
      label: `#équipe-${roomIdx}`,
      timeline: Array.from({ length: 500 }, (__, msgIdx) =>
        makeMessage(
          `$r${roomIdx}-m${msgIdx}`,
          msgIdx === 499 && roomIdx === 7
            ? ' Déploiement passerelle LiveKit terminé avec latence nominale '
            : `Journal de synchronisation module ${roomIdx} entrée ${msgIdx} vérification nominale`,
          1_700_000_000_000 + roomIdx * 1_000 + msgIdx,
          { senderName: `Membre ${roomIdx}` }
        )
      ),
    }))

    const collections: OmniboxCollectionDescriptor[] = Array.from({ length: 1_000 }, (_, idx) => ({
      id: `workspace-page:col-${idx}`,
      title: `Spécification système ${idx}`,
      propertiesText: `status:${idx % 3 === 0 ? 'done' : 'active'} owner:nadia`,
      content:
        idx === 777
          ? 'Passerelle LiveKit et politique de chiffrement bout en bout.'
          : `Documentation technique standard lot ${idx} pour les services internes.`,
    }))

    const index = buildOmniboxIndex({
      store: { getRoomBoundary: () => 'ordinary' },
      rooms,
      collections,
    })

    queryOmnibox(index, 'journal module')

    const start = performance.now()
    const result = queryOmnibox(index, 'deploiement passerelle livekit')
    const elapsedMs = performance.now() - start

    const collectionStart = performance.now()
    const collectionResult = queryOmnibox(index, 'passerelle livekit nadia')
    const collectionElapsedMs = performance.now() - collectionStart

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.eventId).toBe('$r7-m499')
    expect(collectionResult.collections).toHaveLength(1)
    expect(collectionResult.collections[0]?.id).toBe('workspace-page:col-777')

    expect(elapsedMs).toBeLessThan(50)
    expect(collectionElapsedMs).toBeLessThan(50)
    console.info(
      `[omnibox-benchmark] 5000 msgs + 1000 collections: messageQuery=${elapsedMs.toFixed(2)}ms, collectionQuery=${collectionElapsedMs.toFixed(2)}ms`
    )
  })
})
