import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { Workspace, WorkspaceChannel } from '../workspace/workspace'
import type { AudioCallLike, EspaceStoreLike } from './EspaceLiveView'
import { EspaceLiveView } from './EspaceLiveView'
import type { CallSnapshot } from './audio/call'
import { createEspaceStore, type ChannelRoom, type EspaceSnapshot } from './matrix/store'

const SERVER = 'community.kodera.io'
const HS = `https://matrix.${SERVER}`
const VIEWER = `@ce239589-0000-4000-8000-000000000001:${SERVER}`
const AGENT = `@kodera-agent:${SERVER}`

const CHANNELS = {
  announcements: 'c1111111-1111-4111-8111-000000000001',
  general: 'c1111111-1111-4111-8111-000000000002',
  developers: 'c1111111-1111-4111-8111-000000000003',
  support: 'c1111111-1111-4111-8111-000000000004',
  extensions: 'c1111111-1111-4111-8111-000000000005',
  selfHosting: 'c1111111-1111-4111-8111-000000000006',
  showAndTell: 'c1111111-1111-4111-8111-000000000007',
  officeHours: 'c1111111-1111-4111-8111-000000000008',
  archivedLegacy: 'c1111111-1111-4111-8111-000000000009',
} as const

function makeChannel(
  id: string,
  name: string,
  kind: 'text' | 'audio' = 'text',
  lifecycle: 'active' | 'archived' = 'active'
): WorkspaceChannel {
  return {
    id,
    kind,
    name,
    template_key: null,
    topic: '',
    lifecycle,
    is_confidential: false,
    room_state: 'ready',
  }
}

const COMMUNITY_WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [
    {
      id: 'cat-community',
      name: 'Community',
      template_key: null,
      channels: [
        makeChannel(CHANNELS.announcements, 'announcements'),
        makeChannel(CHANNELS.general, 'general'),
        makeChannel(CHANNELS.developers, 'developers-community'),
        makeChannel(CHANNELS.support, 'support'),
        makeChannel(CHANNELS.extensions, 'extensions'),
        makeChannel(CHANNELS.selfHosting, 'self-hosting'),
        makeChannel(CHANNELS.showAndTell, 'show-and-tell'),
        makeChannel(CHANNELS.officeHours, 'office-hours', 'audio'),
        makeChannel(CHANNELS.archivedLegacy, 'legacy-archive', 'text', 'archived'),
      ],
    },
  ],
  uncategorised_channels: [],
}

const IDLE_CALL: CallSnapshot = {
  status: 'idle',
  roomId: null,
  muted: false,
  deafened: false,
  listenOnly: false,
  speakers: [],
  participants: [],
  playbackBlocked: false,
}

function makeFakeCall(): AudioCallLike {
  const listeners = new Set<() => void>()
  let snapshot = IDLE_CALL
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    join: vi.fn(async (roomId: string) => {
      snapshot = { ...IDLE_CALL, status: 'connecting', roomId }
      for (const listener of listeners) listener()
    }),
    leave: vi.fn(async () => {
      snapshot = IDLE_CALL
      for (const listener of listeners) listener()
    }),
    setMuted: vi.fn(async () => undefined),
    setDeafened: vi.fn(async () => undefined),
    startAudio: vi.fn(async () => undefined),
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

function buildCommunityHomeserver(options?: { refusedRooms?: ReadonlySet<string> }) {
  const refused = options?.refusedRooms ?? new Set<string>()
  const aliasToRoom = new Map<
    string,
    { roomId: string; name: string; kind: 'text' | 'audio'; readOnly: boolean }
  >([
    [
      `#kodera-ch-${CHANNELS.announcements}:${SERVER}`,
      { roomId: `!announcements:${SERVER}`, name: 'announcements', kind: 'text', readOnly: true },
    ],
    [
      `#kodera-ch-${CHANNELS.general}:${SERVER}`,
      { roomId: `!general:${SERVER}`, name: 'general', kind: 'text', readOnly: false },
    ],
    [
      `#kodera-ch-${CHANNELS.developers}:${SERVER}`,
      {
        roomId: `!developers:${SERVER}`,
        name: 'developers-community',
        kind: 'text',
        readOnly: false,
      },
    ],
    [
      `#kodera-ch-${CHANNELS.support}:${SERVER}`,
      { roomId: `!support:${SERVER}`, name: 'support', kind: 'text', readOnly: false },
    ],
    [
      `#kodera-ch-${CHANNELS.extensions}:${SERVER}`,
      { roomId: `!extensions:${SERVER}`, name: 'extensions', kind: 'text', readOnly: false },
    ],
    [
      `#kodera-ch-${CHANNELS.selfHosting}:${SERVER}`,
      { roomId: `!self-hosting:${SERVER}`, name: 'self-hosting', kind: 'text', readOnly: false },
    ],
    [
      `#kodera-ch-${CHANNELS.showAndTell}:${SERVER}`,
      { roomId: `!show-and-tell:${SERVER}`, name: 'show-and-tell', kind: 'text', readOnly: false },
    ],
    [
      `#kodera-ch-${CHANNELS.officeHours}:${SERVER}`,
      { roomId: `!office-hours:${SERVER}`, name: 'office-hours', kind: 'audio', readOnly: false },
    ],
    [
      `#kodera-ch-${CHANNELS.archivedLegacy}:${SERVER}`,
      { roomId: `!archived:${SERVER}`, name: 'legacy-archive', kind: 'text', readOnly: true },
    ],
  ])
  const roomMeta = new Map([...aliasToRoom.values()].map((entry) => [entry.roomId, entry]))

  const joinedOrder: string[] = []
  const joinAttempts = new Map<string, number>()
  const sentMessages: { roomId: string; body: string }[] = []
  const pendingSyncRooms = new Map<string, unknown>()
  let batch = 0
  let syncCount = 0
  let pollAnswer: ((res: Response) => void) | undefined

  function flushSync() {
    if (pollAnswer === undefined || pendingSyncRooms.size === 0) return
    const joinPayload = Object.fromEntries(pendingSyncRooms.entries())
    pendingSyncRooms.clear()
    const resolve = pollAnswer
    pollAnswer = undefined
    resolve(json(200, { next_batch: `s${++batch}`, rooms: { join: joinPayload } }))
  }

  const base = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = decodeURIComponent(url.pathname)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')

    if (method === 'GET' && path === '/_matrix/client/versions') {
      return json(200, { versions: ['v1.11'] })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/capabilities') {
      return json(200, { capabilities: {} })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/pushrules/') {
      return json(200, { global: {} })
    }
    if (method === 'POST' && path === `/_matrix/client/v3/user/${VIEWER}/filter`) {
      return json(200, { filter_id: 'community-filter' })
    }
    if (method === 'GET' && path === `/_matrix/client/v3/profile/${VIEWER}`) {
      return json(200, {})
    }
    if (method === 'GET' && path.startsWith('/_matrix/client/v3/directory/room/')) {
      const alias = path.slice('/_matrix/client/v3/directory/room/'.length)
      const entry = aliasToRoom.get(alias)
      return entry === undefined
        ? json(404, { errcode: 'M_NOT_FOUND', error: 'Room alias not found' })
        : json(200, { room_id: entry.roomId, servers: [SERVER] })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/sync') {
      syncCount += 1
      if (syncCount === 1) {
        return json(200, { next_batch: `s${++batch}`, rooms: { join: {} } })
      }
      if (pendingSyncRooms.size > 0) {
        const joinPayload = Object.fromEntries(pendingSyncRooms.entries())
        pendingSyncRooms.clear()
        return json(200, { next_batch: `s${++batch}`, rooms: { join: joinPayload } })
      }
      return new Promise<Response>((resolve, reject) => {
        pollAnswer = resolve
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Stopped sync', 'AbortError'))
        )
      })
    }
    if (method === 'POST' && path.startsWith('/_matrix/client/v3/join/')) {
      const roomId = path.slice('/_matrix/client/v3/join/'.length)
      joinAttempts.set(roomId, (joinAttempts.get(roomId) ?? 0) + 1)
      if (refused.has(roomId)) {
        return json(403, { errcode: 'M_FORBIDDEN', error: 'You are not invited to this room' })
      }
      joinedOrder.push(roomId)
      const meta = roomMeta.get(roomId)!
      pendingSyncRooms.set(roomId, {
        state: {
          events: [
            {
              event_id: `$create-${roomId}`,
              type: 'm.room.create',
              sender: AGENT,
              origin_server_ts: 1_700_000_000_000,
              state_key: '',
              content: { room_version: '12' },
            },
            {
              event_id: `$member-${roomId}`,
              type: 'm.room.member',
              sender: VIEWER,
              origin_server_ts: 1_700_000_000_001,
              state_key: VIEWER,
              content: { membership: 'join', displayname: 'New Member' },
            },
            {
              event_id: `$pl-${roomId}`,
              type: 'm.room.power_levels',
              sender: AGENT,
              origin_server_ts: 1_700_000_000_002,
              state_key: '',
              content: {
                users_default: 0,
                events_default: meta.readOnly ? 20 : 0,
                state_default: 100,
                ...(meta.readOnly ? { events: { 'm.reaction': 0, 'm.room.redaction': 0 } } : {}),
              },
            },
            {
              event_id: `$policy-${roomId}`,
              type: 'io.kodera.room.policy',
              sender: AGENT,
              origin_server_ts: 1_700_000_000_003,
              state_key: '',
              content: { version: 1, kind: meta.kind, read_only: meta.readOnly },
            },
            {
              event_id: `$name-${roomId}`,
              type: 'm.room.name',
              sender: AGENT,
              origin_server_ts: 1_700_000_000_004,
              state_key: '',
              content: { name: meta.name },
            },
          ],
        },
        timeline: {
          events:
            roomId === `!announcements:${SERVER}`
              ? [
                  {
                    event_id: '$ann-root',
                    type: 'm.room.message',
                    sender: AGENT,
                    origin_server_ts: 1_700_000_010_000,
                    content: { msgtype: 'm.text', body: 'Bienvenue sur Kodera Community' },
                  },
                  {
                    event_id: '$ann-reply',
                    type: 'm.room.message',
                    sender: AGENT,
                    origin_server_ts: 1_700_000_020_000,
                    content: {
                      msgtype: 'm.text',
                      body: 'Note de version disponible',
                      'm.relates_to': {
                        rel_type: 'm.thread',
                        event_id: '$ann-root',
                        is_falling_back: true,
                        'm.in_reply_to': { event_id: '$ann-root' },
                      },
                    },
                  },
                ]
              : [],
          limited: false,
          prev_batch: null,
        },
        unread_notifications: { notification_count: 0, highlight_count: 0 },
      })
      queueMicrotask(flushSync)
      return json(200, { room_id: roomId })
    }
    if (method === 'PUT' && path.includes('/send/m.room.message/')) {
      const roomId = path.slice('/_matrix/client/v3/rooms/'.length).split('/send/')[0]!
      const body = JSON.parse(String(init?.body ?? '{}')) as { body?: string }
      sentMessages.push({ roomId, body: body.body ?? '' })
      return json(200, { event_id: `$sent-${sentMessages.length}` })
    }
    if (method === 'GET' && path.endsWith('/messages')) {
      return json(200, { start: 's0', chunk: [] })
    }
    if (method === 'PUT' && path.includes('/typing/')) {
      return json(200, {})
    }
    if (method === 'POST' && path.endsWith('/read_markers')) {
      return json(200, {})
    }
    if (method === 'GET' && path.endsWith('/members')) {
      return json(200, { chunk: [] })
    }
    throw new Error(`Unexpected Matrix request: ${method} ${path}`)
  })

  const store = createEspaceStore(
    { baseUrl: HS, userId: VIEWER, deviceId: 'C2B-DEV', accessToken: 'tok' },
    base,
    { cache: null }
  )

  return {
    store,
    joinedOrder,
    joinAttempts,
    sentMessages,
    pushEmptySync() {
      if (pollAnswer !== undefined) {
        const resolve = pollAnswer
        pollAnswer = undefined
        resolve(json(200, { next_batch: `s${++batch}`, rooms: { join: {} } }))
      }
    },
  }
}

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
})

describe('EspaceLiveView automatic public room joins (C2b)', () => {
  it('joins #general first among all 8 active rooms (text + audio), skips archived, lets a new member post, and keeps #announcements read-only', async () => {
    const hs = buildCommunityHomeserver()
    const call = makeFakeCall()
    const user = userEvent.setup()
    let mounted: ReturnType<typeof render> | undefined
    try {
      await hs.store.start()
      mounted = render(
        <EspaceLiveView
          org="community"
          organisationName="Kodera Community"
          workspace={COMMUNITY_WORKSPACE}
          channelId={CHANNELS.general}
          store={hs.store}
          call={call}
        />
      )

      const composer = await screen.findByRole('textbox', { name: 'Message dans #general' })
      expect(screen.queryByText('Vos salons arrivent…')).toBeNull()

      await waitFor(() => expect(hs.joinedOrder).toHaveLength(8))
      expect(hs.joinedOrder[0]).toBe(`!general:${SERVER}`)
      expect(hs.joinedOrder).toContain(`!office-hours:${SERVER}`)
      expect(hs.joinedOrder).not.toContain(`!archived:${SERVER}`)
      expect(hs.joinAttempts.has(`!archived:${SERVER}`)).toBe(false)

      await user.type(composer, 'Bonjour la communauté{Enter}')
      await waitFor(() =>
        expect(hs.sentMessages).toEqual([
          { roomId: `!general:${SERVER}`, body: 'Bonjour la communauté' },
        ])
      )

      const officeHoursButton = screen.getByText('office-hours').closest('button')!
      expect(officeHoursButton).not.toBeDisabled()
      await user.click(officeHoursButton)
      expect(call.join).toHaveBeenCalledWith(`!office-hours:${SERVER}`)

      mounted.rerender(
        <EspaceLiveView
          org="community"
          organisationName="Kodera Community"
          workspace={COMMUNITY_WORKSPACE}
          channelId={CHANNELS.announcements}
          store={hs.store}
          call={call}
        />
      )
      expect(await screen.findByText('Salon en lecture seule')).toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Message dans #announcements' })).toBeNull()
      expect(await screen.findByText('Bienvenue sur Kodera Community')).toBeInTheDocument()

      // Composer-targeting menu items (`Répondre`) are gated on `!canWrite`, while reading threads
      // and reacting (`m.reaction: 0`) remain available.
      const actionsButton = screen.getByRole('button', { name: /Actions du message de/i })
      await user.click(actionsButton)
      expect(screen.queryByRole('menuitem', { name: 'Répondre' })).toBeNull()
      expect(screen.getByRole('menuitem', { name: 'Ouvrir le fil' })).toBeInTheDocument()
      await user.keyboard('{Escape}')

      const threadButton = screen.getByRole('button', { name: /1 réponse/i })
      await user.click(threadButton)
      const threadPanel = await screen.findByRole('complementary', { name: 'Fil de discussion' })
      expect(within(threadPanel).getByText('Note de version disponible')).toBeInTheDocument()
      expect(within(threadPanel).queryByRole('textbox')).toBeNull()
    } finally {
      await act(async () => {
        mounted?.unmount()
        hs.store.stop()
      })
    }
  })

  it.each(['fr', 'en'] as const)(
    'replaces arriving notice with honest refusal copy in %s on 403 M_FORBIDDEN without looping',
    async (language) => {
      await act(async () => {
        await i18n.changeLanguage(language)
      })
      const refusedRooms = new Set([`!general:${SERVER}`, `!office-hours:${SERVER}`])
      const hs = buildCommunityHomeserver({ refusedRooms })
      const call = makeFakeCall()
      let mounted: ReturnType<typeof render> | undefined
      try {
        await hs.store.start()
        mounted = render(
          <EspaceLiveView
            org="community"
            organisationName="Kodera Community"
            workspace={COMMUNITY_WORKSPACE}
            channelId={CHANNELS.general}
            store={hs.store}
            call={call}
          />
        )

        const expectedTextNotice =
          language === 'fr'
            ? 'Ce salon est sur invitation. Demandez à un administrateur de vous y ajouter.'
            : 'This channel is invite-only. Ask an administrator to add you to it.'
        const expectedAudioNotice = language === 'fr' ? 'sur invitation' : 'invite only'

        expect(await screen.findByText(expectedTextNotice)).toBeInTheDocument()
        expect(
          screen.queryByText(
            language === 'fr' ? 'Vos salons arrivent…' : 'Your channels are on their way…'
          )
        ).toBeNull()

        const officeHoursButton = screen.getByText('office-hours').closest('button')!
        await waitFor(() =>
          expect(officeHoursButton.getAttribute('aria-label')).toContain(expectedAudioNotice)
        )
        expect(officeHoursButton).toBeDisabled()

        await act(async () => {
          hs.pushEmptySync()
        })
        expect(hs.joinAttempts.get(`!general:${SERVER}`)).toBe(1)
        expect(hs.joinAttempts.get(`!office-hours:${SERVER}`)).toBe(1)
      } finally {
        await act(async () => {
          mounted?.unmount()
          hs.store.stop()
        })
      }
    }
  )

  it('re-drains newly resolved targets when channels update while a fallback join is in flight', async () => {
    const listeners = new Set<() => void>()
    const channels = new Map<string, ChannelRoom>([
      [CHANNELS.general, { state: 'resolved', roomId: `!general:${SERVER}` }],
    ])
    let snapshot: EspaceSnapshot = {
      status: 'live',
      rooms: [],
      invites: [],
      channels,
    }
    const joinedOrder: string[] = []
    let finishFirstJoin!: () => void
    const fakeStore: EspaceStoreLike = {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => snapshot,
      getUserId: () => VIEWER,
      getTimeline: () => [],
      getThread: () => [],
      send: vi.fn(async () => undefined),
      edit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
      join: vi.fn(async (roomId: string) => {
        joinedOrder.push(roomId)
        if (roomId === `!general:${SERVER}`) {
          await new Promise<void>((resolve) => {
            finishFirstJoin = resolve
          })
        }
        snapshot = {
          ...snapshot,
          rooms: [
            ...snapshot.rooms,
            {
              roomId,
              name: roomId,
              alias: null,
              kind: 'text',
              unread: 0,
              mentions: 0,
              occupancy: null,
            },
          ],
        }
        for (const listener of listeners) listener()
      }),
    }

    const view = render(
      <EspaceLiveView
        org="community"
        organisationName="Kodera Community"
        workspace={COMMUNITY_WORKSPACE}
        channelId={CHANNELS.general}
        store={fakeStore}
      />
    )
    try {
      await waitFor(() => expect(joinedOrder).toEqual([`!general:${SERVER}`]))

      // Resolve a second channel while the first `join()` promise is still pending.
      await act(async () => {
        const nextChannels = new Map(snapshot.channels)
        nextChannels.set(CHANNELS.support, { state: 'resolved', roomId: `!support:${SERVER}` })
        snapshot = { ...snapshot, channels: nextChannels }
        for (const listener of listeners) listener()
      })

      await act(async () => {
        finishFirstJoin()
      })

      await waitFor(() => expect(joinedOrder).toEqual([`!general:${SERVER}`, `!support:${SERVER}`]))
    } finally {
      view.unmount()
    }
  })
})
