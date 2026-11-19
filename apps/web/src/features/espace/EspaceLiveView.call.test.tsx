// The view's own call, made from the session, against a LiveKit room the test drives: what the
// view does to a call when it goes away mid-join.
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView, type EspaceStoreLike } from './EspaceLiveView'
import type { EspaceSnapshot } from './matrix/store'

const room = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  let connected: () => void = () => undefined
  const state = { value: 'disconnected' }
  return {
    handlers,
    state,
    connected: () => connected(),
    connect: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          connected = () => {
            state.value = 'connected'
            resolve()
          }
        })
    ),
    disconnect: vi.fn(async () => {
      state.value = 'disconnected'
    }),
    startAudio: vi.fn(async () => undefined),
    setMicrophoneEnabled: vi.fn(async () => undefined),
  }
})

vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  class FakeRoom {
    readonly remoteParticipants = new Map()
    readonly localParticipant = {
      identity: '@me:matrix.acme.kodera.io|DEV1',
      permissions: { canPublish: true },
      setMicrophoneEnabled: room.setMicrophoneEnabled,
    }
    readonly canPlaybackAudio = true
    get state() {
      return room.state.value
    }
    connect = room.connect
    disconnect = room.disconnect
    startAudio = room.startAudio
    on(event: string, handler: (...args: unknown[]) => void) {
      let set = room.handlers.get(event)
      if (set === undefined) room.handlers.set(event, (set = new Set()))
      set.add(handler)
      return this
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      room.handlers.get(event)?.delete(handler)
      return this
    }
  }
  return { ...original, Room: FakeRoom }
})

const STANDUP = 'a1111111-1111-4111-8111-000000000003'
const STANDUP_ROOM = '!standup:matrix.acme.kodera.io'

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [
    {
      id: 'cat-team',
      name: 'Team',
      template_key: 'team',
      channels: [
        {
          id: STANDUP,
          kind: 'audio',
          name: 'Point quotidien',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          room_state: 'ready',
        },
      ],
    },
  ],
  uncategorised_channels: [],
}

function store(): EspaceStoreLike {
  const snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map([[STANDUP, { state: 'resolved', roomId: STANDUP_ROOM }]]),
    rooms: [
      {
        roomId: STANDUP_ROOM,
        name: 'Point quotidien',
        alias: '#kodera-ch-a1111111-1111-4111-8111-000000000003:matrix.acme.kodera.io',
        kind: 'audio',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
    ],
    invites: [],
  }
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => '@me:matrix.acme.kodera.io',
    getTimeline: () => [],
    getThread: () => [],
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
    accessToken: () => 'tok-live',
    renewAccessToken: vi.fn(async () => 'tok-next'),
  }
}

beforeEach(() => {
  // The organisation's server name is `acme.kodera.test`: its LiveKit host must sit under it.
  vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.test')
})

afterEach(async () => {
  await i18n.changeLanguage('fr')
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  room.handlers.clear()
  room.state.value = 'disconnected'
})

describe("the view's own call", () => {
  it('is left when the view goes away while it connects: no microphone, nothing left behind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              url: 'wss://rtc.acme.kodera.test',
              token: 'lk.jwt',
              listen_only: false,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    )
    const user = userEvent.setup()
    const { unmount } = render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={undefined}
        store={store()}
        session={{
          baseUrl: 'https://acme.kodera.test',
          userId: '@me:acme.kodera.test',
          deviceId: 'DEV1',
          accessToken: 'tok-at-sign-in',
          refreshToken: 'ref-live',
          refresh: vi.fn(),
        }}
      />
    )
    await user.click(screen.getByRole('button', { name: /^Rejoindre Point quotidien/ }))
    await waitFor(() =>
      expect(room.connect).toHaveBeenCalledWith('wss://rtc.acme.kodera.test', 'lk.jwt')
    )
    expect(document.querySelector('[data-espace-audio]')).not.toBeNull()

    unmount()
    room.connected()
    await waitFor(() => expect(room.disconnect).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(room.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(document.querySelector('[data-espace-audio]')).toBeNull()
    expect([...room.handlers.values()].reduce((count, set) => count + set.size, 0)).toBe(0)
  })
})

describe('the search', () => {
  it('moves focus to an audio room without joining it', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={undefined}
        store={store()}
        session={{
          baseUrl: 'https://acme.kodera.test',
          userId: '@me:acme.kodera.test',
          deviceId: 'DEV1',
          accessToken: 'tok-at-sign-in',
          refreshToken: 'ref-live',
          refresh: vi.fn(),
        }}
      />
    )

    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('quoti')
    expect(screen.getByRole('option', { name: /Point quotidien/ })).toHaveTextContent('Salon audio')
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /^Rejoindre Point quotidien/ })).toHaveFocus()
    expect(room.connect).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps focus on « Rechercher » for a room that cannot be joined yet', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const user = userEvent.setup()
    const preparing = store()
    // The room is not resolved yet: its row is drawn disabled. One object, as a store's
    // snapshot is: a new one on every read never settles.
    const unresolved = { ...preparing.getSnapshot(), channels: new Map() }
    preparing.getSnapshot = () => unresolved
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={undefined}
        store={preparing}
        session={{
          baseUrl: 'https://acme.kodera.test',
          userId: '@me:acme.kodera.test',
          deviceId: 'DEV1',
          accessToken: 'tok-at-sign-in',
          refreshToken: 'ref-live',
          refresh: vi.fn(),
        }}
      />
    )
    expect(screen.getByRole('button', { name: /^Rejoindre Point quotidien/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Rechercher' }))
    await user.keyboard('quoti{Enter}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Rechercher' })).toHaveFocus()
  })
})

const CALL_COPY = {
  fr: {
    join: 'Rejoindre Point quotidien, vide',
    dock: 'Appel en cours',
    connecting: 'Connexion…',
    leave: 'Quitter',
    forbidden: 'Vous n’avez plus accès à ce salon.',
    dismiss: 'Fermer',
    retry: 'Réessayer',
  },
  en: {
    join: 'Join Point quotidien, empty',
    dock: 'Call in progress',
    connecting: 'Connecting…',
    leave: 'Leave',
    forbidden: 'You no longer have access to this room.',
    dismiss: 'Close',
    retry: 'Try again',
  },
} as const

describe('bilingual production call boundary', () => {
  it.each(['fr', 'en'] as const)(
    'keeps %s join authorization, held-connect leave and late settlement intact',
    async (language) => {
      await i18n.changeLanguage(language)
      const copy = CALL_COPY[language]
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              url: 'wss://rtc.acme.kodera.test',
              token: 'lk.jwt',
              listen_only: false,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
      vi.stubGlobal('fetch', fetchMock)
      const activeStore = store()
      let mounted: ReturnType<typeof render> | undefined
      try {
        mounted = render(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={WORKSPACE}
            channelId={undefined}
            store={activeStore}
            session={{
              baseUrl: 'https://acme.kodera.test',
              userId: '@me:acme.kodera.test',
              deviceId: 'DEV1',
              accessToken: 'tok-at-sign-in',
              refreshToken: 'ref-live',
              refresh: vi.fn(),
            }}
          />
        )
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: copy.join }))
        await waitFor(() =>
          expect(room.connect).toHaveBeenCalledExactlyOnceWith(
            'wss://rtc.acme.kodera.test',
            'lk.jwt'
          )
        )
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [input, init] = fetchMock.mock.calls[0]!
        expect(String(input)).toBe('https://acme.kodera.test/_kodera/rooms/token')
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        })
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-live')
        expect(JSON.parse(String(init?.body))).toEqual({ room_id: STANDUP_ROOM })
        expect(activeStore.renewAccessToken).not.toHaveBeenCalled()
        const dock = screen.getByRole('region', { name: copy.dock })
        expect(within(dock).getByText(copy.connecting)).toBeInTheDocument()
        expect(document.querySelector('[data-espace-audio]')).not.toBeNull()
        await user.click(within(dock).getByRole('button', { name: copy.leave }))
        await waitFor(() => expect(room.disconnect).toHaveBeenCalled())
        await act(async () => {
          room.connected()
          await Promise.resolve()
        })
        expect(room.setMicrophoneEnabled).not.toHaveBeenCalled()
        expect(document.querySelector('[data-espace-audio]')).toBeNull()
        expect([...room.handlers.values()].reduce((count, set) => count + set.size, 0)).toBe(0)
        expect(screen.queryByRole('region', { name: copy.dock })).toBeNull()
      } finally {
        await act(async () => {
          mounted?.unmount()
          if (room.connect.mock.calls.length > 0) room.connected()
          await Promise.resolve()
        })
      }
    }
  )

  it.each(['fr', 'en'] as const)(
    'keeps %s forbidden joins disconnected without retry or microphone access',
    async (language) => {
      await i18n.changeLanguage(language)
      const copy = CALL_COPY[language]
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
      )
      vi.stubGlobal('fetch', fetchMock)
      const activeStore = store()
      let mounted: ReturnType<typeof render> | undefined
      try {
        mounted = render(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={WORKSPACE}
            channelId={undefined}
            store={activeStore}
            session={{
              baseUrl: 'https://acme.kodera.test',
              userId: '@me:acme.kodera.test',
              deviceId: 'DEV1',
              accessToken: 'tok-at-sign-in',
              refreshToken: 'ref-live',
              refresh: vi.fn(),
            }}
          />
        )
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', { name: copy.join }))
        expect(await screen.findByText(copy.forbidden)).toBeInTheDocument()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(room.connect).not.toHaveBeenCalled()
        expect(room.setMicrophoneEnabled).not.toHaveBeenCalled()
        expect(activeStore.renewAccessToken).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: copy.retry })).toBeNull()
        expect(screen.queryByRole('region', { name: copy.dock })).toBeNull()
        await user.click(screen.getByRole('button', { name: copy.dismiss }))
        expect(screen.queryByText(copy.forbidden)).toBeNull()
        expect(document.querySelector('[data-espace-audio]')).toBeNull()
        expect([...room.handlers.values()].reduce((count, set) => count + set.size, 0)).toBe(0)
      } finally {
        await act(async () => {
          mounted?.unmount()
          await Promise.resolve()
        })
      }
    }
  )
})

describe('compact sidebar voice card, detachable floating pill, and in-pane Calls surface', () => {
  const MULTI_CHANNEL_WORKSPACE: Workspace = {
    ...WORKSPACE,
    categories: [
      {
        id: 'cat-general',
        name: 'General',
        template_key: 'general',
        channels: [
          {
            id: 'ch-general',
            kind: 'text',
            name: 'général',
            template_key: 'general',
            topic: '',
            lifecycle: 'active',
            room_state: 'ready',
          },
          {
            id: 'ch-support',
            kind: 'text',
            name: 'support',
            template_key: null,
            topic: '',
            lifecycle: 'active',
            room_state: 'ready',
          },
        ],
      },
      {
        id: 'cat-team',
        name: 'Team',
        template_key: 'team',
        channels: [
          {
            id: STANDUP,
            kind: 'audio',
            name: 'office-hours',
            template_key: null,
            topic: '',
            lifecycle: 'active',
            room_state: 'ready',
          },
        ],
      },
    ],
  }

  function multiStore(): EspaceStoreLike {
    const snapshot: EspaceSnapshot = {
      status: 'live',
      channels: new Map([
        ['ch-general', { state: 'resolved', roomId: '!general:matrix.acme.kodera.io' }],
        ['ch-support', { state: 'resolved', roomId: '!support:matrix.acme.kodera.io' }],
        [STANDUP, { state: 'resolved', roomId: STANDUP_ROOM }],
      ]),
      rooms: [
        {
          roomId: '!general:matrix.acme.kodera.io',
          name: 'général',
          alias: '#general:matrix.acme.kodera.io',
          kind: 'text',
          unread: 0,
          mentions: 0,
          occupancy: null,
        },
        {
          roomId: '!support:matrix.acme.kodera.io',
          name: 'support',
          alias: '#support:matrix.acme.kodera.io',
          kind: 'text',
          unread: 0,
          mentions: 0,
          occupancy: null,
        },
        {
          roomId: STANDUP_ROOM,
          name: 'office-hours',
          alias: '#office-hours:matrix.acme.kodera.io',
          kind: 'audio',
          unread: 0,
          mentions: 0,
          occupancy: {
            participants: ['@alice:matrix.acme.kodera.io', '@bob:matrix.acme.kodera.io'],
            screenShare: [],
          },
          names: {
            '@alice:matrix.acme.kodera.io': 'Alice Laurent',
            '@bob:matrix.acme.kodera.io': 'Bob Martin',
          },
        },
      ],
      invites: [],
    }
    return {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      getUserId: () => '@me:matrix.acme.kodera.io',
      getTimeline: () => [],
      getThread: () => [],
      send: vi.fn(async () => undefined),
      edit: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      toggleReaction: vi.fn(async () => undefined),
      accessToken: () => 'tok-live',
      renewAccessToken: vi.fn(async () => 'tok-next'),
    }
  }

  it('docks a compact 56px sidebar voice card when browsing another channel, detaches/re-docks via icon-only arrows, and opens in-pane Appels without a modal scrim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              url: 'wss://rtc.acme.kodera.test',
              token: 'lk.jwt',
              listen_only: false,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    )
    const user = userEvent.setup()
    let mounted: ReturnType<typeof render> | undefined
    try {
      mounted = render(
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={MULTI_CHANNEL_WORKSPACE}
          channelId="ch-general"
          store={multiStore()}
          session={{
            baseUrl: 'https://acme.kodera.test',
            userId: '@me:acme.kodera.test',
            deviceId: 'DEV1',
            accessToken: 'tok-at-sign-in',
            refreshToken: 'ref-live',
            refresh: vi.fn(),
          }}
        />
      )

      // Voice channel row uses compact count pill ("2") without inline "2 personnes" / "Connecté" crowding
      const joinRow = screen.getByRole('button', { name: /^Rejoindre office-hours/ })
      expect(joinRow.querySelector('[data-occupancy]')).toHaveTextContent('2')

      // Join office-hours -> opens bounded Call Stage
      await user.click(joinRow)
      await waitFor(() => expect(room.connect).toHaveBeenCalledTimes(1))
      await act(async () => {
        room.connected()
        await Promise.resolve()
      })

      const stageDock = screen.getByRole('region', { name: 'Appel en cours' })
      expect(stageDock.closest('[data-call-placement="stage"]')).not.toBeNull()
      expect(stageDock.closest('.call-stage-bounded')).not.toBeNull()
      expect(document.querySelectorAll('video')).toHaveLength(0)

      // Navigate away to #support -> collapses to compact 56px sidebar card, zero Détacher visible text
      await user.click(screen.getByRole('link', { name: 'support' }))
      const sidebarDock = screen.getByRole('region', { name: 'Appel en cours' })
      expect(sidebarDock).toBe(stageDock)
      expect(sidebarDock).toHaveAttribute('data-dock-layout', 'compact')
      expect(sidebarDock).toHaveClass('h-[56px]')
      expect(screen.queryByText(/détacher|ancrer|réduire/iu)).toBeNull()

      // Click ↗ icon-only button -> detaches into FloatingCallPill
      const detachBtn = within(sidebarDock).getByRole('button', { name: 'Fenêtre flottante' })
      expect(detachBtn).toHaveTextContent('')
      await user.click(detachBtn)
      const pill = screen.getByTestId('floating-call-pill')
      expect(pill).toBeVisible()
      expect(screen.queryByText(/détacher|ancrer|réduire/iu)).toBeNull()

      // Click ↙ icon-only button -> re-docks into compact sidebar card
      const redockBtn = within(pill).getByRole('button', { name: 'Rattacher à la barre latérale' })
      expect(redockBtn).toHaveTextContent('')
      await user.click(redockBtn)
      expect(screen.queryByTestId('floating-call-pill')).toBeNull()
      expect(screen.getByRole('region', { name: 'Appel en cours' })).toHaveAttribute(
        'data-dock-layout',
        'compact'
      )

      // Click Appels in sidebar navigation -> renders in-pane CallsSurfaceView, zero blocking dialog scrim
      await user.click(screen.getByRole('button', { name: 'Appels' }))
      expect(screen.queryByRole('dialog', { name: 'Appels' })).toBeNull()
      const callsCanvas = await screen.findByTestId('espace-calls-canvas')
      expect(within(callsCanvas).getByTestId('calls-active-banner')).toHaveTextContent(
        'office-hours'
      )
      expect(within(callsCanvas).getByTestId('calls-prejoin-mic-meter')).toBeInTheDocument()

      // Return to stage from CallsSurfaceView
      await user.click(
        within(callsCanvas).getAllByRole('button', { name: 'Retourner à la scène' })[0]!
      )
      expect(
        screen.getByRole('region', { name: 'Appel en cours' }).closest('[data-call-placement]')
      ).toHaveAttribute('data-call-placement', 'stage')
    } finally {
      await act(async () => {
        mounted?.unmount()
        await Promise.resolve()
      })
    }
  })
})
