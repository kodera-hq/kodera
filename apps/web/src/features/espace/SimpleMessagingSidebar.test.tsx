import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { ShellShortcuts } from '../../app/ShellShortcuts'
import { PaletteProvider } from '../command-palette/PaletteContext'
import type { RoomBoundary } from '../confidential/room-boundary'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { Workspace } from '../workspace/workspace'
import type { CallSnapshot } from './audio/call'
import { EspaceLiveView, type AudioCallLike, type EspaceStoreLike } from './EspaceLiveView'
import type { EspaceSnapshot } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { compareSimpleFeedItems, type SimpleFeedItem } from './SimpleMessagingSidebar'
import { favoriteChannelsStorageKey, setUiMode } from './uiModePreference'

const GENERAL = 'ch-general-uuid'
const OPS = 'ch-ops-uuid'
const VAULT = 'ch-vault-uuid'
const DORMANT = 'ch-dormant-uuid'
const PINNED_EMPTY = 'ch-pinned-uuid'
const STANDUP = 'ch-standup-uuid'

const GENERAL_ROOM = '!general:matrix.acme.kodera.io'
const OPS_ROOM = '!ops:matrix.acme.kodera.io'
const VAULT_ROOM = '!vault:matrix.acme.kodera.io'
const DORMANT_ROOM = '!dormant:matrix.acme.kodera.io'
const PINNED_ROOM = '!pinned:matrix.acme.kodera.io'
const STANDUP_ROOM = '!standup:matrix.acme.kodera.io'
const DM_ROOM = '!dm-camille:matrix.acme.kodera.io'
const INVITE_ROOM = '!dm-invite:matrix.acme.kodera.io'

const ME = '@me:matrix.acme.kodera.io'
const CAMILLE = '@camille:matrix.acme.kodera.io'
const ELODIE = '@elodie:matrix.acme.kodera.io'

const WORKSPACE: Workspace = {
  organisation_id: 'org-acme-uuid',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: 'ws-acme-uuid',
  categories: [
    {
      id: 'cat-general',
      name: 'General',
      template_key: 'general',
      channels: [
        {
          id: GENERAL,
          kind: 'text',
          name: 'general',
          template_key: 'general',
          topic: 'Discussions équipe',
          lifecycle: 'active',
          is_confidential: false,
          room_state: 'ready',
        },
        {
          id: OPS,
          kind: 'text',
          name: 'opérations',
          template_key: null,
          topic: 'Production',
          lifecycle: 'active',
          is_confidential: false,
          room_state: 'ready',
        },
        {
          id: VAULT,
          kind: 'text',
          name: 'direction-confidentiel',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          is_confidential: false,
          room_state: 'ready',
        },
        {
          id: DORMANT,
          kind: 'text',
          name: 'archives-silencieuses',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          is_confidential: false,
          room_state: 'ready',
        },
        {
          id: PINNED_EMPTY,
          kind: 'text',
          name: 'annonces-direction',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          is_confidential: false,
          room_state: 'ready',
        },
        {
          id: STANDUP,
          kind: 'audio',
          name: 'Standup vocal',
          template_key: null,
          topic: '',
          lifecycle: 'active',
          is_confidential: false,
          room_state: 'ready',
        },
      ],
    },
  ],
  uncategorised_channels: [],
}

function makeMsg(
  eventId: string,
  sender: string,
  senderName: string,
  body: string,
  ts: number,
  mentionsMe = false
): MessageView {
  return {
    key: eventId,
    eventId,
    sender,
    senderName,
    body,
    ts,
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
    ...(mentionsMe ? { mentionsMe: true } : {}),
  }
}

function createFixtureStore() {
  const timelines: Record<string, readonly MessageView[]> = {
    [GENERAL_ROOM]: [
      makeMsg('$g1', ELODIE, 'Élodie Roux', 'Bonjour à toute l’équipe', 1_700_000_010_000),
    ],
    [OPS_ROOM]: [
      makeMsg('$o1', ELODIE, 'Élodie Roux', 'Migration passerelle prête', 1_700_000_020_000),
      makeMsg(
        '$o2',
        CAMILLE,
        'Camille Laurent',
        '@me Peux-tu valider le basculement DNS ?',
        1_700_000_050_000,
        true
      ),
    ],
    [VAULT_ROOM]: [
      makeMsg(
        '$v1',
        CAMILLE,
        'Camille Laurent',
        'CONTENU ULTRA CONFIDENTIEL NE JAMAIS AFFICHER',
        1_700_000_090_000
      ),
    ],
    [DM_ROOM]: [
      makeMsg(
        '$dm1',
        CAMILLE,
        'Camille Laurent',
        'On se retrouve à 14h pour le point budget ?',
        1_700_000_080_000
      ),
    ],
    [DORMANT_ROOM]: [],
    [PINNED_ROOM]: [],
    [STANDUP_ROOM]: [],
  }

  const snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map([
      [GENERAL, { state: 'resolved', roomId: GENERAL_ROOM }],
      [OPS, { state: 'resolved', roomId: OPS_ROOM }],
      [VAULT, { state: 'resolved', roomId: VAULT_ROOM }],
      [DORMANT, { state: 'resolved', roomId: DORMANT_ROOM }],
      [PINNED_EMPTY, { state: 'resolved', roomId: PINNED_ROOM }],
      [STANDUP, { state: 'resolved', roomId: STANDUP_ROOM }],
    ]),
    rooms: [
      {
        roomId: GENERAL_ROOM,
        name: 'general',
        alias: null,
        kind: 'text',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
      {
        roomId: OPS_ROOM,
        name: 'opérations',
        alias: null,
        kind: 'text',
        unread: 3,
        mentions: 1,
        occupancy: null,
      },
      {
        roomId: VAULT_ROOM,
        name: 'direction-confidentiel',
        alias: null,
        kind: 'text',
        unread: 1,
        mentions: 0,
        occupancy: null,
      },
      {
        roomId: DORMANT_ROOM,
        name: 'archives-silencieuses',
        alias: null,
        kind: 'text',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
      {
        roomId: PINNED_ROOM,
        name: 'annonces-direction',
        alias: null,
        kind: 'text',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
      {
        roomId: STANDUP_ROOM,
        name: 'Standup vocal',
        alias: null,
        kind: 'audio',
        unread: 0,
        mentions: 0,
        occupancy: { participants: [ELODIE], screenShare: [] },
      },
      {
        roomId: DM_ROOM,
        name: 'Camille Laurent',
        alias: null,
        kind: 'text',
        unread: 2,
        mentions: 0,
        occupancy: null,
      },
    ],
    invites: [
      {
        roomId: INVITE_ROOM,
        name: 'Nadia Benali',
        inviter: '@nadia:matrix.acme.kodera.io',
        direct: true,
      },
    ],
  }

  const store: EspaceStoreLike = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: (roomId: string) => timelines[roomId] ?? [],
    getHistory: () => 'start',
    getThread: () => [],
    getDirects: () => [{ roomId: DM_ROOM, userIds: [CAMILLE], name: 'Camille Laurent', unread: 2 }],
    openDirect: vi.fn(async () => DM_ROOM),
    acceptInvite: vi.fn(async () => undefined),
    declineInvite: vi.fn(async () => undefined),
    getRoomBoundary: (roomId: string): RoomBoundary =>
      roomId === VAULT_ROOM ? 'confidential-unavailable' : 'ordinary',
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  }

  return store
}

function createFakeCall(initialRoomId: string | null = null) {
  const listeners = new Set<() => void>()
  let callSnap: CallSnapshot = {
    status: initialRoomId ? 'connected' : 'idle',
    roomId: initialRoomId,
    self: ME,
    muted: false,
    deafened: false,
    listenOnly: false,
    speakers: [],
    participants: initialRoomId ? [ME] : [],
    playbackBlocked: false,
  }
  const join = vi.fn(async (roomId: string) => {
    callSnap = {
      ...callSnap,
      status: 'connected',
      roomId,
      participants: [ME],
    }
    for (const listener of listeners) listener()
  })
  const leave = vi.fn(async () => {
    callSnap = { ...callSnap, status: 'idle', roomId: null, participants: [] }
    for (const listener of listeners) listener()
  })
  const call: AudioCallLike = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => callSnap,
    join,
    leave,
    setMuted: vi.fn(async () => undefined),
    setDeafened: vi.fn(async () => undefined),
    startAudio: vi.fn(async () => undefined),
  }
  return { call, join, leave }
}

describe('SimpleMessagingSidebar & Workspace UI Mode', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setUiMode('pro')
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    setUiMode('pro')
    window.localStorage.clear()
  })

  it('sorts unified feed items deterministically: favorite > mentions > unread > timestamp > label', () => {
    const base: Omit<SimpleFeedItem, 'key' | 'label'> = {
      kind: 'text',
      isFavorite: false,
      mentions: 0,
      unread: 0,
      lastActivityTs: 100,
      selected: false,
      quarantined: false,
      excerpt: '',
    }
    const items: SimpleFeedItem[] = [
      { ...base, key: 'recent-b', label: 'Bravo', lastActivityTs: 500 },
      { ...base, key: 'recent-a', label: 'Alpha', lastActivityTs: 500 },
      { ...base, key: 'unread', label: 'Support', unread: 2, lastActivityTs: 200 },
      { ...base, key: 'mention', label: 'Ops', mentions: 1, unread: 1, lastActivityTs: 150 },
      { ...base, key: 'fav', label: 'Annonces', isFavorite: true, lastActivityTs: 0 },
    ]

    expect([...items].sort(compareSimpleFeedItems).map((item) => item.key)).toEqual([
      'fav',
      'mention',
      'unread',
      'recent-a',
      'recent-b',
    ])
  })

  it('defaults to Pro mode, switches to Simple mode in 1 click without dropping an active call, and resets non-chat canvas', async () => {
    const user = userEvent.setup()
    const store = createFixtureStore()
    const { call, leave } = createFakeCall(STANDUP_ROOM)
    const onChangeCanvasMode = vi.fn()

    window.localStorage.setItem(
      favoriteChannelsStorageKey('acme', WORKSPACE.organisation_id, ME),
      JSON.stringify([PINNED_EMPTY])
    )

    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
        call={call}
        activeCanvasMode="docs"
        onChangeCanvasMode={onChangeCanvasMode}
        docsCanvasSlot={<div data-testid="docs-slot">Docs Canvas</div>}
      />
    )

    // Default mode is Pro: Simple sidebar is absent, toggle shows Pro pressed.
    expect(screen.queryByTestId('simple-messaging-sidebar')).toBeNull()
    const toggle = screen.getByTestId('workspace-ui-mode-toggle')
    expect(within(toggle).getByRole('button', { name: 'Mode Espace Pro' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(toggle).getByRole('button', { name: 'Mode Messages' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    // 1-click switch to mode Messages: switches canvas cleanly to chat without dropping call.
    await user.click(within(toggle).getByRole('button', { name: 'Mode Messages' }))
    expect(onChangeCanvasMode).toHaveBeenCalledWith('chat')
    expect(leave).not.toHaveBeenCalled()

    const simpleNav = await screen.findByTestId('simple-messaging-sidebar')
    expect(within(simpleNav).getByRole('button', { name: 'Mode Messages' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    // Active channels remain discoverable; pinned, DM, mention, voice-occupied, and unread appear in deterministic order!
    expect(within(simpleNav).getByText('archives-silencieuses')).toBeVisible()
    expect(within(simpleNav).getByText('Invitations en attente (1)')).toBeInTheDocument()

    const rows = within(simpleNav).getAllByTestId(/^simple-feed-row-/)
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      `simple-feed-row-channel:${PINNED_EMPTY}`,
      `simple-feed-row-channel:${OPS}`,
      `simple-feed-row-channel:${VAULT}`,
      `simple-feed-row-direct:${DM_ROOM}`,
      `simple-feed-row-channel:${GENERAL}`,
      `simple-feed-row-channel:${DORMANT}`,
      `simple-feed-row-channel:${STANDUP}`,
    ])

    // Confidential room NEVER exposes plaintext excerpt in SimpleMessagingSidebar!
    expect(simpleNav.textContent).not.toContain('CONTENU ULTRA CONFIDENTIEL')
    expect(within(simpleNav).getByTestId('simple-feed-quarantined-excerpt')).toHaveTextContent(
      'Salon protégé · aperçu masqué'
    )

    // Ordinary rooms DO show their message / voice occupancy excerpts.
    expect(simpleNav.textContent).toContain('Peux-tu valider le basculement DNS')
    expect(simpleNav.textContent).toContain('1 personne en appel')
  })

  it('triggers 1-tap call from a conversation row without switching the active text channel', async () => {
    const user = userEvent.setup()
    setUiMode('messages')
    const store = createFixtureStore()
    const { call, join } = createFakeCall()

    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
        call={call}
      />
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')
    const callDmBtn = screen.getByTestId(`simple-feed-call-direct:${DM_ROOM}`)
    expect(callDmBtn).toHaveAttribute('aria-label', 'Appeler Camille Laurent')

    await user.click(callDmBtn)
    expect(join).toHaveBeenCalledWith(DM_ROOM)
    // stopPropagation kept the active text channel on #général instead of opening the DM row.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')
  })

  it('pins favorites via context menu, switches modes from UniversalSearch, and jumps across channels to a matched message while quarantining confidential rooms', async () => {
    const user = userEvent.setup()
    const store = createFixtureStore()
    const onOpenDoc = vi.fn()
    const docs: readonly ChannelDoc[] = [
      {
        id: 'doc-slo',
        channelId: OPS,
        title: 'Runbook Basculement',
        content: 'Procédure failover PostgreSQL multi-région avec objectif RTO court.',
        role: 'editor',
      },
    ]

    render(
      <PaletteProvider>
        <ShellShortcuts org="acme" />
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL}
          store={store}
          documents={docs}
          onOpenDocument={onOpenDoc}
        />
      </PaletteProvider>
    )

    // Pin #archives-silencieuses as favorite from Pro mode context menu.
    const dormantLink = screen.getByRole('link', { name: 'archives-silencieuses' })
    fireEvent.contextMenu(dormantLink, { clientX: 20, clientY: 40 })
    await user.click(await screen.findByRole('menuitem', { name: 'Épingler aux favoris' }))

    // Switch to Simple mode via Command Palette quick action!
    await user.keyboard('{Control>}k{/Control}')
    const paletteInput = await screen.findByRole('combobox')
    await user.type(paletteInput, 'mode Messages')
    await user.keyboard('{Enter}')

    const simpleNav = await screen.findByTestId('simple-messaging-sidebar')
    // Now #archives-silencieuses appears at the top of Simple feed because it is pinned as Favorite!
    expect(within(simpleNav).getByText('archives-silencieuses')).toBeInTheDocument()

    // Verify confidential room messages NEVER appear in omnibox search!
    await user.keyboard('{Control>}k{/Control}')
    const searchConfidential = await screen.findByRole('combobox')
    await user.type(searchConfidential, 'ULTRA CONFIDENTIEL')
    expect(screen.queryByText(/CONTENU ULTRA CONFIDENTIEL/)).toBeNull()
    await user.keyboard('{Escape}{Escape}')

    // Cross-channel jump: from #général, search for message "$o2" in #opérations ("basculement DNS") and press Enter!
    await user.keyboard('{Control>}k{/Control}')
    const searchJump = await screen.findByRole('combobox')
    await user.type(searchJump, 'basculement DNS')
    expect(await screen.findByText(/#opérations · Camille Laurent/)).toBeVisible()
    await user.keyboard('{Enter}')

    // Channel switched from #général to #opérations and highlighted message $o2!
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('opérations')
    )
    await waitFor(() => {
      const highlightedRow = document.querySelector('[data-timeline-row="$o2"][data-shown="true"]')
      expect(highlightedRow).not.toBeNull()
    })

    // Collection/page content search in omnibox opens the document!
    await user.keyboard('{Control>}k{/Control}')
    const searchCollection = await screen.findByRole('combobox')
    await user.type(searchCollection, 'failover PostgreSQL')
    expect((await screen.findAllByText('Collections'))[0]).toBeVisible()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(onOpenDoc).toHaveBeenCalledWith(docs[0]))
  })

  it('restores keyboard focus across Pro/Simple mode toggle swaps and when closing ChannelContextMenu on a Simple feed row', async () => {
    const user = userEvent.setup()
    const store = createFixtureStore()

    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )

    // Activate Simple mode button -> focus lands on the newly mounted Simple button in SimpleMessagingSidebar!
    await user.click(screen.getByTestId('workspace-ui-mode-messages'))
    const simpleNav = await screen.findByTestId('simple-messaging-sidebar')
    expect(within(simpleNav).getByTestId('workspace-ui-mode-messages')).toHaveFocus()

    // Open ChannelContextMenu on #opérations row in SimpleMessagingSidebar and close with Escape -> focus returns to the row's primary button!
    const opsRow = within(simpleNav).getByTestId(`simple-feed-row-channel:${OPS}`)
    const primaryButton = opsRow.querySelector<HTMLButtonElement>('[data-primary-row-button]')!
    expect(primaryButton).not.toBeNull()
    fireEvent.contextMenu(opsRow, { clientX: 24, clientY: 48 })
    expect(
      await screen.findByRole('menu', { name: 'Actions pour #opérations' })
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(primaryButton).toHaveFocus())

    // Activate Pro mode button -> focus lands on the newly mounted Pro button in ChannelSidebar!
    await user.click(within(simpleNav).getByTestId('workspace-ui-mode-pro'))
    await waitFor(() => expect(screen.queryByTestId('simple-messaging-sidebar')).toBeNull())
    expect(screen.getByTestId('workspace-ui-mode-pro')).toHaveFocus()
  })

  it('fails closed when getRoomBoundary is absent and clears pendingMessageJump when navigation is blocked or superseded', async () => {
    const user = userEvent.setup()
    setUiMode('messages')
    const baseStore = createFixtureStore()
    // Boundary-less store adapter: excerpts and omnibox message hits must fail closed!
    const { getRoomBoundary: _omittedBoundary, ...boundarylessStore } = baseStore

    const firstView = render(
      <PaletteProvider>
        <ShellShortcuts org="acme" />
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL}
          store={boundarylessStore}
        />
      </PaletteProvider>
    )

    const simpleNav = screen.getByTestId('simple-messaging-sidebar')
    expect(simpleNav.textContent).not.toContain('Peux-tu valider le basculement DNS')
    expect(simpleNav.textContent).not.toContain('On se retrouve à 14h')
    expect(
      within(simpleNav).getAllByTestId('simple-feed-quarantined-excerpt').length
    ).toBeGreaterThanOrEqual(3)

    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'basculement DNS')
    expect(screen.queryByText(/#opérations · Camille Laurent/)).toBeNull()
    await user.keyboard('{Escape}{Escape}')
    firstView.unmount()

    // Now test blocked cross-channel jump: onNavigateChannel returns false (e.g., cancelled guard),
    // then user later visits #opérations manually -> old pendingMessageJump must NOT fire!
    let allowNav = false
    let currentChannel = GENERAL
    const view = render(
      <PaletteProvider>
        <ShellShortcuts org="acme" />
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={currentChannel}
          store={baseStore}
          onNavigateChannel={(nextId) => {
            if (!allowNav) return false
            currentChannel = nextId
            return undefined
          }}
        />
      </PaletteProvider>
    )

    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByRole('combobox'), 'basculement DNS')
    expect(await screen.findByText(/#opérations · Camille Laurent/)).toBeVisible()
    await user.keyboard('{Enter}')

    // Navigation was refused (false); still on #général.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')
    )

    // Later, user navigates manually to #opérations: $o2 must NOT be marked data-shown="true"!
    allowNav = true
    view.rerender(
      <PaletteProvider>
        <ShellShortcuts org="acme" />
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={OPS}
          store={baseStore}
          onNavigateChannel={(nextId) => {
            currentChannel = nextId
          }}
        />
      </PaletteProvider>
    )
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('opérations')
    )
    expect(document.querySelector('[data-timeline-row="$o2"][data-shown="true"]')).toBeNull()
  })
})
