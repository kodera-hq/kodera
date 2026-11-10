import {
  act,
  fireEvent,
  getDefaultNormalizer,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import * as timeFormatting from '../../i18n/format'
import { communityWorkspace } from '../../mocks/demo/community'
import { createLocalWorkspaceStore } from '../../mocks/demo/workspaceStore'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView } from './EspaceLiveView'
import type { AudioCallLike, EspaceStoreLike } from './EspaceLiveView'
import type { CallSnapshot } from './audio/call'
import {
  EspaceStore,
  createEspaceStore,
  matrixClientForTests,
  type ChannelRoom,
  type EspaceSnapshot,
  type RoomSummary,
} from './matrix/store'
import type { MessageView, RawEvent } from './matrix/timeline'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const WELCOME = 'a1111111-1111-4111-8111-000000000002'
const STANDUP = 'a1111111-1111-4111-8111-000000000003'
const GENERAL_ROOM = '!general:matrix.acme.kodera.io'
const WELCOME_ROOM = '!welcome:matrix.acme.kodera.io'

/** What the directory answered for each channel's alias, as the store's snapshot carries it. */
const RESOLVED: ReadonlyMap<string, ChannelRoom> = new Map([
  [GENERAL, { state: 'resolved', roomId: GENERAL_ROOM }],
  [WELCOME, { state: 'resolved', roomId: WELCOME_ROOM }],
  [STANDUP, { state: 'resolved', roomId: '!standup:matrix.acme.kodera.io' }],
])

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
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
          topic: 'Discussions de toute l’équipe',
          lifecycle: 'active',
          room_state: 'ready',
        },
        {
          id: WELCOME,
          kind: 'text',
          name: 'welcome',
          template_key: 'welcome',
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

function makeFakeStore(options?: {
  status?: EspaceSnapshot['status']
  timelines?: Record<string, readonly MessageView[]>
  threads?: Record<string, readonly MessageView[]>
  rooms?: RoomSummary[]
  channels?: ReadonlyMap<string, ChannelRoom>
}) {
  const listeners = new Set<() => void>()
  let snapshot: EspaceSnapshot = {
    status: options?.status ?? 'live',
    channels: options?.channels ?? RESOLVED,
    rooms: options?.rooms ?? [
      {
        roomId: '!general:matrix.acme.kodera.io',
        name: 'general',
        alias: '#kodera-ch-a1111111-1111-4111-8111-000000000001:matrix.acme.kodera.io',
        kind: 'text',
        unread: 0,
        mentions: 0,
        occupancy: null,
      },
      {
        roomId: '!welcome:matrix.acme.kodera.io',
        name: 'welcome',
        alias: '#kodera-ch-a1111111-1111-4111-8111-000000000002:matrix.acme.kodera.io',
        kind: 'text',
        unread: 3,
        mentions: 2,
        occupancy: null,
      },
      {
        roomId: '!standup:matrix.acme.kodera.io',
        name: 'Point quotidien',
        alias: '#kodera-ch-a1111111-1111-4111-8111-000000000003:matrix.acme.kodera.io',
        kind: 'audio',
        unread: 0,
        mentions: 0,
        occupancy: {
          participants: [
            '@marina.loiseau:matrix.acme.kodera.io',
            '@bob.dupont:matrix.acme.kodera.io',
          ],
          screenShare: ['@marina.loiseau:matrix.acme.kodera.io'],
        },
      },
    ],
    invites: [],
  }

  const timelines = new Map<string, readonly MessageView[]>(
    Object.entries(
      options?.timelines ?? {
        '!general:matrix.acme.kodera.io': [
          {
            key: '$m1',
            eventId: '$m1',
            sender: '@marina.loiseau:matrix.acme.kodera.io',
            body: 'Bonjour tout le monde !',
            ts: Date.UTC(2026, 9, 23, 8, 15, 0),
            edited: false,
            redacted: false,
            delivery: 'sent',
            replyTo: null,
            reactions: [{ key: '👍', count: 2, mine: false }],
          },
          {
            key: '$m2',
            eventId: '$m2',
            sender: '@me:matrix.acme.kodera.io',
            body: 'Mon point est prêt.',
            ts: Date.UTC(2026, 9, 23, 8, 16, 0),
            edited: true,
            redacted: false,
            delivery: 'sent',
            replyTo: '$m1',
            reactions: [],
          },
        ],
      }
    )
  )

  const threads = new Map<string, readonly MessageView[]>(
    Object.entries(
      options?.threads ?? {
        '!general:matrix.acme.kodera.io:$m1': [
          {
            key: '$t1',
            eventId: '$t1',
            sender: '@bob.dupont:matrix.acme.kodera.io',
            body: 'Je partage les notes dans le fil.',
            ts: Date.UTC(2026, 9, 23, 8, 17, 0),
            edited: false,
            redacted: false,
            delivery: 'sent',
            replyTo: null,
            reactions: [],
          },
        ],
      }
    )
  )

  const store: EspaceStoreLike & {
    setStatus: (status: EspaceSnapshot['status']) => void
    setChannels: (channels: ReadonlyMap<string, ChannelRoom>) => void
    setRooms: (rooms: RoomSummary[]) => void
    setTimeline: (roomId: string, messages: readonly MessageView[]) => void
  } = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => '@me:matrix.acme.kodera.io',
    getTimeline: (roomId) => timelines.get(roomId) ?? [],
    getThread: (roomId, rootEventId) => threads.get(`${roomId}:${rootEventId}`) ?? [],
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
    resolveChannels: vi.fn(),
    setStatus: (status) => {
      snapshot = { ...snapshot, status }
      for (const listener of listeners) listener()
    },
    setChannels: (channels) => {
      snapshot = { ...snapshot, channels }
      for (const listener of listeners) listener()
    },
    setRooms: (rooms) => {
      snapshot = { ...snapshot, rooms }
      for (const listener of listeners) listener()
    },
    setTimeline: (roomId, messages) => {
      timelines.set(roomId, messages)
      snapshot = { ...snapshot }
      for (const listener of listeners) listener()
    },
  }

  return store
}

const STANDUP_ROOM = '!standup:matrix.acme.kodera.io'

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

/** A call driven by the test: each action is recorded, and the test says what the media did. */
function makeFakeCall() {
  const listeners = new Set<() => void>()
  let snapshot: CallSnapshot = IDLE_CALL
  const set = (patch: Partial<CallSnapshot>, base: CallSnapshot = snapshot) => {
    snapshot = { ...base, ...patch }
    for (const listener of listeners) listener()
  }
  const call: AudioCallLike & { set: (patch: Partial<CallSnapshot>) => void; reset: () => void } = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    join: vi.fn(async (roomId: string) => set({ status: 'connecting', roomId }, IDLE_CALL)),
    leave: vi.fn(async () => set({}, IDLE_CALL)),
    setMuted: vi.fn(async (muted: boolean) => set({ muted })),
    setDeafened: vi.fn(async (deafened: boolean) => set({ deafened, muted: true })),
    startAudio: vi.fn(async () => set({ playbackBlocked: false })),
    set: (patch) => act(() => set(patch)),
    reset: () => {
      snapshot = IDLE_CALL
    },
  }
  return call
}

async function selectMessageAction(
  user: ReturnType<typeof userEvent.setup>,
  article: HTMLElement,
  name: string
) {
  await user.click(within(article).getByRole('button', { name: /^Actions du message/ }))
  await user.click(screen.getByRole('menuitem', { name }))
}

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
  vi.unstubAllGlobals()
})

describe('EspaceLiveView', () => {
  it('opens one named message menu from the keyboard and Escape preserves the thread and returns focus', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
    await user.click(screen.getByRole('button', { name: '1 réponse' }))
    const log = screen.getByRole('log', { name: 'Messages de général' })
    const trigger = within(log).getByRole('button', {
      name: /Actions du message de Marina Loiseau/,
    })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Réagir 👍' })).toHaveFocus()
    expect(store.send).not.toHaveBeenCalled()
    expect(store.edit).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
    expect(store.toggleReaction).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('complementary', { name: 'Fil de discussion' })).toBeInTheDocument()
  })

  it('dismisses a menu on audience and store replacement, even with the same event IDs', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const props = {
      org: 'acme',
      organisationName: 'Acme SA',
      workspace: WORKSPACE,
      channelId: GENERAL,
    }
    const view = render(<EspaceLiveView {...props} store={store} />)
    const open = async () =>
      user.click(screen.getAllByRole('button', { name: /^Actions du message/ })[0]!)
    await open()
    view.rerender(<EspaceLiveView {...props} channelId={WELCOME} store={store} />)
    expect(screen.queryByRole('menu')).toBeNull()
    view.rerender(<EspaceLiveView {...props} store={store} />)
    await open()
    const replacement = makeFakeStore()
    view.rerender(<EspaceLiveView {...props} store={replacement} />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(replacement.remove).not.toHaveBeenCalled()
    expect(replacement.toggleReaction).not.toHaveBeenCalled()
  })

  it('dismisses a thread reply menu with Escape without closing the thread', async () => {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    await user.click(screen.getByRole('button', { name: '1 réponse' }))
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    const trigger = within(panel).getByRole('button', { name: /^Actions du message de Bob Dupont/ })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Modifier' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Ouvrir le fil' })).toBeNull()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(panel).toBeInTheDocument()
  })

  it('keeps foreign-message permissions and translated menu labels', async () => {
    await i18n.changeLanguage('en')
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    await user.click(
      screen.getByRole('button', { name: /^Actions for the message from Marina Loiseau/ })
    )
    expect(screen.getByRole('menuitem', { name: 'React 👍' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
  })

  it('offers no message menu for archived channels or redacted messages', () => {
    const archived = {
      ...WORKSPACE,
      categories: WORKSPACE.categories.map((category) => ({
        ...category,
        channels: category.channels.map((channel) => ({
          ...channel,
          lifecycle: 'archived' as const,
        })),
      })),
    }
    const props = { org: 'acme', organisationName: 'Acme SA', channelId: GENERAL }
    const store = makeFakeStore()
    const view = render(<EspaceLiveView {...props} workspace={archived} store={store} />)
    expect(screen.queryByRole('button', { name: /^Actions du message/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ajouter une réaction' })).toBeNull()
    const redacted = makeFakeStore({
      timelines: {
        [GENERAL_ROOM]: store
          .getTimeline(GENERAL_ROOM)
          .map((message) => ({ ...message, redacted: true })),
      },
    })
    view.rerender(<EspaceLiveView {...props} workspace={WORKSPACE} store={redacted} />)
    expect(screen.queryByRole('button', { name: /^Actions du message/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ajouter une réaction' })).toBeNull()
  })

  it('renders categories mixing text channels (unread and mentions) and audio rooms (occupancy and screen-share)', () => {
    const store = makeFakeStore()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )

    expect(screen.getByRole('button', { name: 'Général' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Équipe' })).toHaveAttribute('aria-expanded', 'true')

    const generalRow = screen.getByRole('link', { name: 'général' })
    expect(generalRow).toHaveAttribute('aria-current', 'page')

    const welcomeRow = screen.getByRole('link', { name: 'bienvenue, non lu, 2 mentions' })
    expect(welcomeRow).toBeInTheDocument()

    const audioRow = screen.getByRole('button', {
      name: 'Rejoindre Point quotidien, 2 personnes',
    })
    expect(audioRow).toBeInTheDocument()

    const occupantsList = screen.getByRole('list', { name: 'Dans Point quotidien' })
    expect(within(occupantsList).getByText('Marina Loiseau')).toBeInTheDocument()
    expect(within(occupantsList).getByText('partage son écran')).toBeInTheDocument()
    expect(within(occupantsList).getByText('Bob Dupont')).toBeInTheDocument()
  })

  it('sends, replies, edits, redacts, and toggles reactions on timeline messages', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )

    const log = screen.getByRole('log', { name: 'Messages de général' })
    expect(within(log).getAllByText('Bonjour tout le monde !')).toHaveLength(2)
    expect(within(log).getByText('Mon point est prêt.')).toBeInTheDocument()
    expect(within(log).getByText('(modifié)')).toBeInTheDocument()

    // Send a new message
    const composer = screen.getByLabelText('Message dans #général')
    // Icons only (docs/specs/icon-only-controls.md): « Envoyer » is the send button's name, not
    // its text.
    expect(screen.getByRole('button', { name: 'Envoyer' })).toHaveTextContent('')
    // The dark workspace reference's composer: a muted well that keeps its input edge
    // (docs/specs/workspace-dark-roles.md).
    const well = composer.closest('.rounded-lg')
    expect(well).toHaveClass('bg-c-muted', 'border-c-border-input')
    expect(well).not.toHaveClass('bg-c-surface')
    expect(screen.getByRole('button', { name: 'Mentionner' })).toHaveClass('hover:bg-c-sunken')
    await user.hover(screen.getByRole('button', { name: 'Mentionner' }))
    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent('Mentionner')
    await user.unhover(screen.getByRole('button', { name: 'Mentionner' }))
    await user.type(composer, 'Voici la mise à jour')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledWith(
      '!general:matrix.acme.kodera.io',
      'Voici la mise à jour',
      {}
    )

    // Reply to Alice's message ($m1)
    await selectMessageAction(user, within(log).getAllByRole('article')[0]!, 'Répondre')
    await user.type(composer, 'Bien reçu Alice')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledWith('!general:matrix.acme.kodera.io', 'Bien reçu Alice', {
      replyTo: '$m1',
    })

    // Toggle existing reaction on $m1
    await user.click(within(log).getByRole('button', { name: '👍 2' }))
    expect(store.toggleReaction).toHaveBeenCalledWith('!general:matrix.acme.kodera.io', '$m1', '👍')

    // Edit own message ($m2)
    await selectMessageAction(user, within(log).getAllByRole('article')[1]!, 'Modifier')
    expect(composer).toHaveValue('Mon point est prêt.')
    await user.clear(composer)
    await user.type(composer, 'Mon point est validé.')
    // While editing, the same icon button is named « Enregistrer », and its tooltip follows.
    const save = screen.getByRole('button', { name: 'Enregistrer' })
    expect(save).toHaveTextContent('')
    await user.hover(save)
    expect(await screen.findByRole('tooltip', { hidden: true })).toHaveTextContent('Enregistrer')
    await user.unhover(save)
    await user.click(save)
    expect(store.edit).toHaveBeenCalledWith(
      '!general:matrix.acme.kodera.io',
      '$m2',
      'Mon point est validé.'
    )

    // Redact own message ($m2)
    await selectMessageAction(user, within(log).getAllByRole('article')[1]!, 'Supprimer')
    expect(store.remove).toHaveBeenCalledWith('!general:matrix.acme.kodera.io', '$m2')
  })

  it('returns focus to the exact thread opener after composer Escape', async () => {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    const opener = screen.getByRole('button', { name: '1 réponse' })
    act(() => opener.focus())
    await user.keyboard('{Enter}')
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(panel).getByText('Bonjour tout le monde !')).toBeInTheDocument()
    const composer = within(panel).getByLabelText('Répondre au fil')
    await user.click(composer)
    expect(composer).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('complementary', { name: 'Fil de discussion' })).toBeNull()
    expect(opener.isConnected).toBe(true)
    expect(screen.getByRole('button', { name: '1 réponse' })).toBe(opener)
    expect(opener).toHaveFocus()
  })

  it('opens the ThreadPanel for a message, displays thread replies, and sends a thread reply', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )

    await user.click(screen.getByRole('button', { name: /1 réponse/ }))

    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(panel).getByText('Je partage les notes dans le fil.')).toBeInTheDocument()

    const threadInput = within(panel).getByLabelText('Répondre au fil')
    await user.type(threadInput, 'Merci Bob !')
    await user.click(within(panel).getByRole('button', { name: 'Répondre' }))

    expect(store.send).toHaveBeenCalledWith('!general:matrix.acme.kodera.io', 'Merci Bob !', {
      threadRootId: '$m1',
    })

    await user.click(within(panel).getByRole('button', { name: 'Fermer' }))
    expect(
      screen.queryByRole('complementary', { name: 'Fil de discussion' })
    ).not.toBeInTheDocument()
  })

  it('returns to the count button after the thread close button', async () => {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    const opener = screen.getByRole('button', { name: '1 réponse' })
    await user.click(opener)
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    await user.click(within(panel).getByRole('button', { name: 'Fermer' }))
    expect(panel).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1 réponse' })).toBe(opener)
    expect(opener).toHaveFocus()
  })

  it.each(['Escape', 'close button'])(
    'returns from a zero-reply menu thread using %s',
    async (close) => {
      const user = userEvent.setup()
      render(
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL}
          store={makeFakeStore()}
        />
      )
      const log = screen.getByRole('log', { name: 'Messages de général' })
      const opener = within(log).getByRole('button', { name: /^Actions du message de Me/ })
      act(() => opener.focus())
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
      expect(within(panel).getByText('Mon point est prêt.')).toBeInTheDocument()
      expect(within(panel).queryAllByRole('article')).toHaveLength(1)
      const composer = within(panel).getByLabelText('Répondre au fil')
      await user.click(composer)
      expect(composer).toHaveFocus()
      if (close === 'Escape') await user.keyboard('{Escape}')
      else await user.click(within(panel).getByRole('button', { name: 'Fermer' }))
      expect(panel).not.toBeInTheDocument()
      expect(opener.isConnected).toBe(true)
      expect(within(log).getByRole('button', { name: /^Actions du message de Me/ })).toBe(opener)
      expect(opener).toHaveFocus()
    }
  )

  it('uses the latest opener for the same root and then a different root', async () => {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    const log = screen.getByRole('log', { name: 'Messages de général' })
    const count = within(log).getByRole('button', { name: '1 réponse' })
    const alice = within(log).getByRole('button', { name: /^Actions du message de Marina Loiseau/ })
    const own = within(log).getByRole('button', { name: /^Actions du message de Me/ })
    await user.click(count)
    await user.type(
      within(screen.getByRole('complementary')).getByLabelText('Répondre au fil'),
      'Same-root draft'
    )
    await user.click(alice)
    await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    let panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(panel).getByText('Bonjour tout le monde !')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Répondre au fil')).toHaveValue('Same-root draft')
    await user.click(within(panel).getByLabelText('Répondre au fil'))
    await user.keyboard('{Escape}')
    expect(alice).toHaveFocus()
    await user.click(alice)
    await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await user.click(count)
    panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    await user.click(within(panel).getByRole('button', { name: 'Fermer' }))
    expect(count).toHaveFocus()
    await user.click(count)
    await user.type(
      within(screen.getByRole('complementary')).getByLabelText('Répondre au fil'),
      'Old-root draft'
    )
    await user.click(own)
    await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(panel).getByText('Mon point est prêt.')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Répondre au fil')).toHaveValue('')
    await user.click(within(panel).getByRole('button', { name: 'Fermer' }))
    expect(own).toHaveFocus()
    expect(own).not.toBe(alice)
  })

  it('keeps child-menu Escape precedence before returning to the thread opener', async () => {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    const opener = screen.getByRole('button', { name: '1 réponse' })
    await user.click(opener)
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    const child = within(panel).getByRole('button', { name: /^Actions du message de Bob Dupont/ })
    await user.click(child)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(child).toHaveFocus())
    expect(panel).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(panel).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it.each(['room', 'viewer', 'store'])(
    'retires the opener on %s replacement without focusing another audience',
    async (context) => {
      const user = userEvent.setup()
      const baseline = makeFakeStore()
      const timelines = {
        [GENERAL_ROOM]: baseline.getTimeline(GENERAL_ROOM),
        [WELCOME_ROOM]: baseline.getTimeline(GENERAL_ROOM),
      }
      const store = makeFakeStore({ timelines })
      const props = {
        org: 'acme',
        organisationName: 'Acme SA',
        workspace: WORKSPACE,
        channelId: GENERAL,
      }
      const view = render(<EspaceLiveView {...props} store={store} />)
      const old = within(screen.getByRole('log')).getByRole('button', {
        name: /^Actions du message de Marina Loiseau/,
      })
      await user.click(old)
      await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      const oldPanel = screen.getByRole('complementary', { name: 'Fil de discussion' })
      await user.click(within(oldPanel).getByLabelText('Répondre au fil'))
      const oldFocus = vi.spyOn(old, 'focus')
      if (context === 'room')
        view.rerender(<EspaceLiveView {...props} channelId={WELCOME} store={store} />)
      else if (context === 'store')
        view.rerender(<EspaceLiveView {...props} store={makeFakeStore({ timelines })} />)
      else {
        vi.spyOn(store, 'getUserId').mockReturnValue('@another:matrix.acme.kodera.io')
        act(() => store.setStatus('live'))
      }
      expect(old.isConnected).toBe(false)
      expect(oldPanel).not.toBeInTheDocument()
      const current = within(screen.getByRole('log')).getByRole('button', {
        name: /^Actions du message de Marina Loiseau/,
      })
      expect(current.isConnected).toBe(true)
      expect(current).not.toBe(old)
      expect(oldFocus).not.toHaveBeenCalled()
      await user.click(current)
      await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
      await user.click(within(panel).getByRole('button', { name: 'Fermer' }))
      expect(current).toHaveFocus()
      expect(oldFocus).not.toHaveBeenCalled()
    }
  )

  it('names members by their room display name, never by the subject in their Matrix id', () => {
    const subject = '@3f2a1b2c-4d5e-4f70-8a9b-0c1d2e3f4a5b:matrix.acme.kodera.io'
    const unnamed = '@7d8e9f0a-1b2c-4d3e-9f4a-5b6c7d8e9f0a:matrix.acme.kodera.io'
    const [first, second] = makeFakeStore().getTimeline(GENERAL_ROOM)
    const rooms = makeFakeStore()
      .getSnapshot()
      .rooms.map((room) =>
        room.kind === 'audio'
          ? {
              ...room,
              occupancy: { participants: [subject, unnamed], screenShare: [] },
              names: { [subject]: 'Marina Loiseau' },
            }
          : room
      )
    const store = makeFakeStore({
      rooms,
      timelines: {
        [GENERAL_ROOM]: [
          { ...first!, sender: subject, senderName: 'Marina Loiseau' },
          { ...second!, replyTo: first!.eventId },
        ],
      },
    })
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
    const log = screen.getByRole('log', { name: 'Messages de général' })
    expect(
      within(log).getByRole('button', { name: /^Actions du message de Marina Loiseau/ })
    ).toBeInTheDocument()
    // The reply quote names its author the same way.
    expect(within(log).getAllByText('Marina Loiseau')).toHaveLength(2)
    const occupants = screen.getByRole('list', { name: 'Dans Point quotidien' })
    expect(within(occupants).getByText('Marina Loiseau')).toBeInTheDocument()
    expect(screen.queryByText(/3f2a1b2c/i)).toBeNull()
    // A member without a display name falls back to the id's localpart.
    expect(within(occupants).getByText(/^7d8e9f0a/i)).toBeInTheDocument()
  })

  it("names a thread's faces and the reply banner by display name too", async () => {
    const user = userEvent.setup()
    const subject = '@3f2a1b2c-4d5e-4f70-8a9b-0c1d2e3f4a5b:matrix.acme.kodera.io'
    const replier = '@9c8d7e6f-5a4b-4c3d-8e2f-1a0b9c8d7e6f:matrix.acme.kodera.io'
    const [first] = makeFakeStore().getTimeline(GENERAL_ROOM)
    const [reply] = makeFakeStore().getThread(GENERAL_ROOM, first!.eventId)
    const store = makeFakeStore({
      timelines: { [GENERAL_ROOM]: [{ ...first!, sender: subject, senderName: 'Marina Loiseau' }] },
      threads: {
        [`${GENERAL_ROOM}:${first!.eventId}`]: [
          { ...reply!, sender: replier, senderName: 'Bruno Petit' },
        ],
      },
    })
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
    const log = screen.getByRole('log', { name: 'Messages de général' })
    // The thread's face is the replier's initials, from the name, not from the subject.
    expect(within(log).getByText('BP')).toBeInTheDocument()
    await selectMessageAction(user, within(log).getByRole('article'), 'Répondre')
    const banner = screen.getByText(/^En réponse à/)
    expect(banner).toHaveTextContent('En réponse à Marina Loiseau')
  })

  it('retires a removed root and gives a surviving message its own opener', async () => {
    const user = userEvent.setup()
    const messages = [...makeFakeStore().getTimeline(GENERAL_ROOM)]
    const store = makeFakeStore({ timelines: { [GENERAL_ROOM]: messages } })
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
    const old = screen.getByRole('button', { name: '1 réponse' })
    await user.click(old)
    const oldPanel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    const oldFocus = vi.spyOn(old, 'focus')
    act(() => {
      messages.splice(0, 1)
      store.setStatus('live')
    })
    expect(old.isConnected).toBe(false)
    expect(oldPanel).not.toBeInTheDocument()
    expect(screen.queryByText('Bonjour tout le monde !')).toBeNull()
    const current = within(screen.getByRole('log')).getByRole('button', {
      name: /^Actions du message de Me/,
    })
    expect(current.isConnected).toBe(true)
    expect(oldFocus).not.toHaveBeenCalled()
    await user.click(current)
    await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    await user.click(within(panel).getByRole('button', { name: 'Fermer' }))
    expect(current).toHaveFocus()
    expect(oldFocus).not.toHaveBeenCalled()
  })

  it('retires a viewer target even when its exact count button survives and the saved thread returns', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const viewer = vi.spyOn(store, 'getUserId')
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
    const opener = screen.getByRole('button', { name: '1 réponse' })
    await user.click(opener)
    const oldPanel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    const oldFocus = vi.spyOn(opener, 'focus')
    act(() => {
      viewer.mockReturnValue('@another:matrix.acme.kodera.io')
      store.setStatus('live')
    })
    expect(oldPanel).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1 réponse' })).toBe(opener)
    expect(opener.isConnected).toBe(true)
    act(() => {
      viewer.mockReturnValue('@me:matrix.acme.kodera.io')
      store.setStatus('live')
    })
    const restoredPanel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(restoredPanel).getByText('Bonjour tout le monde !')).toBeInTheDocument()
    await user.click(within(restoredPanel).getByLabelText('Répondre au fil'))
    await user.keyboard('{Escape}')
    expect(restoredPanel).not.toBeInTheDocument()
    expect(oldFocus).not.toHaveBeenCalled()
  })

  it('does not focus an action trigger removed while its root remains open', async () => {
    const user = userEvent.setup()
    const messages = [...makeFakeStore().getTimeline(GENERAL_ROOM)]
    const store = makeFakeStore({ timelines: { [GENERAL_ROOM]: messages } })
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
    const old = within(screen.getByRole('log')).getByRole('button', {
      name: /^Actions du message de Me/,
    })
    await user.click(old)
    await user.click(screen.getByRole('menuitem', { name: 'Ouvrir le fil' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const oldFocus = vi.spyOn(old, 'focus')
    act(() => {
      messages[1] = { ...messages[1]!, redacted: true }
      store.setStatus('live')
    })
    expect(old.isConnected).toBe(false)
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(panel).getByText('Message supprimé')).toBeInTheDocument()
    const current = within(screen.getByRole('log')).getByRole('button', {
      name: /^Actions du message de Marina Loiseau/,
    })
    expect(current.isConnected).toBe(true)
    const currentFocus = vi.spyOn(current, 'focus')
    await user.click(within(panel).getByLabelText('Répondre au fil'))
    await user.keyboard('{Escape}')
    expect(panel).not.toBeInTheDocument()
    expect(oldFocus).not.toHaveBeenCalled()
    expect(currentFocus).not.toHaveBeenCalled()
  })

  it('joins an audio room through the call, docks the media state, and drives mute, deafen and leave', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const call = makeFakeCall()
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

    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    expect(call.join).toHaveBeenCalledWith(STANDUP_ROOM)

    const dock = screen.getByRole('region', { name: 'Appel en cours' })
    expect(within(dock).getByText('Point quotidien')).toBeInTheDocument()
    expect(within(dock).getByText('Équipe')).toBeInTheDocument()
    // The media connection's state, not the chat's sync.
    expect(within(dock).getByText('Connexion…')).toBeInTheDocument()

    call.set({ status: 'connected' })
    expect(within(dock).getByText('Connecté')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes, Connecté' })
    ).toBeInTheDocument()

    const muteBtn = within(dock).getByRole('button', { name: 'Couper le micro' })
    expect(muteBtn).toHaveAttribute('aria-pressed', 'false')
    await user.click(muteBtn)
    expect(call.setMuted).toHaveBeenCalledWith(true)
    expect(within(dock).getByRole('button', { name: 'Couper le micro' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await user.click(within(dock).getByRole('button', { name: 'Couper le son' }))
    expect(call.setDeafened).toHaveBeenCalledWith(true)
    expect(within(dock).getByRole('button', { name: 'Couper le son' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    call.set({ status: 'reconnecting' })
    expect(within(dock).getByText('Reconnexion…')).toBeInTheDocument()

    await user.click(within(dock).getByRole('button', { name: 'Quitter' }))
    expect(call.leave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: 'Appel en cours' })).not.toBeInTheDocument()
  })

  it('lets the member turn the sound on when the browser holds it back', async () => {
    const user = userEvent.setup()
    const call = makeFakeCall()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
        call={call}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    call.set({ status: 'connected' })
    expect(screen.queryByRole('button', { name: 'Activer le son' })).not.toBeInTheDocument()

    call.set({ playbackBlocked: true })
    expect(screen.getByText('Votre navigateur retient le son de l’appel.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Activer le son' }))
    expect(call.startAudio).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Activer le son' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Appel en cours' })).toBeInTheDocument()
  })

  it('says when the member may only listen', async () => {
    const user = userEvent.setup()
    const call = makeFakeCall()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
        call={call}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    call.set({ status: 'connected', listenOnly: true, muted: true })
    const dock = screen.getByRole('region', { name: 'Appel en cours' })
    expect(within(dock).getByText('Connecté · écoute seule')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Rejoindre Point quotidien, 2 personnes, Connecté, écoute seule',
      })
    ).toBeInTheDocument()
  })

  it.each([
    ['failed', 'forbidden', 'Vous n’avez plus accès à ce salon.', false],
    [
      'failed',
      'unavailable',
      'L’audio est indisponible pour le moment. Réessayez dans un instant.',
      true,
    ],
    ['ended', 'removed', 'L’appel s’est arrêté\u202f: vous n’avez plus accès à ce salon.', false],
    [
      'ended',
      'connection-lost',
      'La connexion à l’appel a été perdue. Rejoignez le salon pour reprendre.',
      true,
    ],
  ] as const)(
    'explains a call that %s (%s), and lets the member close or retry it',
    async (status, problem, message, retryable) => {
      const user = userEvent.setup()
      const call = makeFakeCall()
      render(
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={WORKSPACE}
          channelId={GENERAL}
          store={makeFakeStore()}
          call={call}
        />
      )
      await user.click(
        screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' })
      )
      call.set({ status, problem, roomId: STANDUP_ROOM })

      expect(screen.queryByRole('region', { name: 'Appel en cours' })).not.toBeInTheDocument()
      // The French narrow no-break space before a colon is part of the copy: keep it.
      const exact = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) }
      expect(screen.getByText(message, exact)).toBeInTheDocument()
      const retry = screen.queryByRole('button', { name: 'Réessayer' })
      if (retryable) {
        await user.click(retry!)
        expect(call.join).toHaveBeenLastCalledWith(STANDUP_ROOM)
        expect(call.join).toHaveBeenCalledTimes(2)
        call.set({ status, problem })
      } else {
        expect(retry).not.toBeInTheDocument()
      }
      await user.click(screen.getByRole('button', { name: 'Fermer' }))
      expect(call.leave).toHaveBeenCalledTimes(1)
      expect(screen.queryByText(message, exact)).not.toBeInTheDocument()
    }
  )

  it('keeps the dock while it says the microphone cannot be used', async () => {
    const user = userEvent.setup()
    const call = makeFakeCall()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
        call={call}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    call.set({ status: 'connected', muted: true, problem: 'microphone' })
    expect(screen.getByRole('region', { name: 'Appel en cours' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Votre micro est inaccessible. Autorisez-le dans votre navigateur, puis réactivez-le.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fermer' })).not.toBeInTheDocument()
  })

  it('keeps reading who is in a room from the Matrix state, not from the call', async () => {
    const user = userEvent.setup()
    const call = makeFakeCall()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
        call={call}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    call.set({ status: 'connected', participants: ['@me:matrix.acme.kodera.io'] })
    const occupants = screen.getByRole('list', { name: 'Dans Point quotidien' })
    expect(within(occupants).getAllByRole('listitem')).toHaveLength(2)
  })

  it('leaves the call when the member is signed out of the homeserver', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const call = makeFakeCall()
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
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    call.set({ status: 'connected' })
    act(() => store.setStatus('signed-out'))
    expect(call.leave).toHaveBeenCalled()
  })

  it("makes its own call from the session, carrying the store's member token to the room-access service", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const store = {
      ...makeFakeStore(),
      accessToken: () => 'tok-live',
      renewAccessToken: vi.fn(async () => 'tok-next'),
    }
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
        session={{
          baseUrl: 'https://matrix.acme.kodera.io',
          userId: '@me:matrix.acme.kodera.io',
          deviceId: 'DEV1',
          accessToken: 'tok-at-sign-in',
          refreshToken: 'ref-live',
          refresh: vi.fn(),
        }}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    await waitFor(() =>
      expect(screen.getByText('Vous n’avez plus accès à ce salon.')).toBeInTheDocument()
    )
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('https://matrix.acme.kodera.io/_kodera/rooms/token')
    expect(new Headers(calls[0]![1].headers).get('Authorization')).toBe('Bearer tok-live')
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ room_id: STANDUP_ROOM })
    expect(store.renewAccessToken).not.toHaveBeenCalled()
  })

  it('shows the expired-session alert when sync status is signed-out and triggers onReconnect', async () => {
    const user = userEvent.setup()
    const onReconnect = vi.fn()
    const store = makeFakeStore({ status: 'signed-out' })
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
        onReconnect={onReconnect}
      />
    )

    expect(screen.getByText('Votre session de messagerie a expiré.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Se reconnecter' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('starts the owned EspaceStore on mount and stops it on unmount when given a MatrixSession', () => {
    const startSpy = vi.spyOn(EspaceStore.prototype, 'start').mockResolvedValue(undefined)
    const stopSpy = vi.spyOn(EspaceStore.prototype, 'stop').mockImplementation(() => undefined)

    const { unmount } = render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        session={{
          baseUrl: 'https://matrix.acme.kodera.io',
          userId: '@me:matrix.acme.kodera.io',
          deviceId: 'DEV1',
          accessToken: 'tok-live',
          refreshToken: 'ref-live',
          refresh: vi.fn(),
        }}
      />
    )

    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).not.toHaveBeenCalled()

    unmount()
    expect(stopSpy).toHaveBeenCalledTimes(1)

    startSpy.mockRestore()
    stopSpy.mockRestore()
  })
})

describe("EspaceLiveView finds a channel's room by its alias, and by nothing else", () => {
  const SERVER = 'matrix.acme.kodera.io'
  const room = (patch: Partial<RoomSummary> & Pick<RoomSummary, 'roomId'>): RoomSummary => ({
    name: 'general',
    alias: null,
    kind: 'text',
    unread: 0,
    mentions: 0,
    occupancy: null,
    ...patch,
  })
  const view = (store: EspaceStoreLike) =>
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
  const message = (body: string): MessageView => ({
    key: body,
    eventId: `$${body}`,
    sender: '@marina.loiseau:matrix.acme.kodera.io',
    body,
    ts: Date.UTC(2026, 9, 23, 8, 15, 0),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  })

  it('asks the store for the rooms of the channels Core says are ready', () => {
    const store = makeFakeStore()
    view(store)
    expect(store.resolveChannels).toHaveBeenCalledWith([GENERAL, WELCOME, STANDUP])
  })

  it('uses the room the alias resolved to, among rooms named like the channel', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore({
      rooms: [
        room({ roomId: '!impostor:matrix.acme.kodera.io', name: 'general' }),
        room({ roomId: '!right:matrix.acme.kodera.io', name: 'general' }),
      ],
      channels: new Map([[GENERAL, { state: 'resolved', roomId: '!right:matrix.acme.kodera.io' }]]),
      timelines: {
        '!impostor:matrix.acme.kodera.io': [message('pas ici')],
        '!right:matrix.acme.kodera.io': [message('le bon salon')],
      },
    })
    view(store)
    expect(screen.getByText('le bon salon')).toBeInTheDocument()
    expect(screen.queryByText('pas ici')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Message dans #général'), 'bonjour')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledWith('!right:matrix.acme.kodera.io', 'bonjour', {})
  })

  it('never takes a room for its name: an unresolved channel is not usable', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore({
      rooms: [
        // The channel's very name, with no alias, and with a different one.
        room({ roomId: '!named:matrix.acme.kodera.io', name: 'general' }),
        room({
          roomId: '!other:matrix.acme.kodera.io',
          name: 'General',
          alias: `#general:${SERVER}`,
        }),
      ],
      channels: new Map(),
      timelines: { '!named:matrix.acme.kodera.io': [message('pas ici')] },
    })
    view(store)
    expect(screen.getByRole('link', { name: 'général, En préparation' })).toBeInTheDocument()
    expect(screen.queryByText('pas ici')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message dans #général')).not.toBeInTheDocument()
    expect(screen.getByText('En préparation', { selector: 'p' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'général, En préparation' }))
    expect(store.send).not.toHaveBeenCalled()
  })

  it('keeps a renamed room: another name, the same alias, still the channel', () => {
    const store = makeFakeStore({
      rooms: [
        room({
          roomId: '!renamed:matrix.acme.kodera.io',
          name: 'ancien nom',
          alias: `#kodera-ch-${GENERAL}:${SERVER}`,
        }),
      ],
      channels: new Map([
        [GENERAL, { state: 'resolved', roomId: '!renamed:matrix.acme.kodera.io' }],
      ]),
      timelines: { '!renamed:matrix.acme.kodera.io': [message('toujours là')] },
    })
    view(store)
    expect(screen.getByText('toujours là')).toBeInTheDocument()
    expect(screen.getByLabelText('Message dans #général')).toBeInTheDocument()
  })

  it.each([
    ['the channel id as a room id', { roomId: GENERAL }],
    ['an alias containing the channel id', { alias: `#channel-${GENERAL}:${SERVER}` }],
    ['the alias with one more character', { alias: `#kodera-ch-${GENERAL}x:${SERVER}` }],
    ['the right local part on another server', { alias: `#kodera-ch-${GENERAL}:evil.example` }],
    [
      'the alias in upper case',
      { alias: `#KODERA-CH-${GENERAL.toUpperCase()}:${SERVER.toUpperCase()}` },
    ],
    ['the channel id as the local part', { alias: `#${GENERAL}:${SERVER}` }],
  ])('takes no room for a look-alike: %s', (_case, patch) => {
    const store = makeFakeStore({
      rooms: [room({ roomId: '!lookalike:matrix.acme.kodera.io', name: 'autre', ...patch })],
      channels: new Map(),
      timelines: {
        '!lookalike:matrix.acme.kodera.io': [message('pas ici')],
        [GENERAL]: [message('pas ici non plus')],
      },
    })
    view(store)
    expect(screen.queryByText('pas ici')).not.toBeInTheDocument()
    expect(screen.queryByText('pas ici non plus')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message dans #général')).not.toBeInTheDocument()
  })

  it.each([
    ['starting', null],
    ['live', 'Vos salons arrivent…'],
  ] as const)(
    'says nothing empty for a found room the member is not in, while the sync is %s',
    (status, notice) => {
      const store = makeFakeStore({
        status,
        rooms: [],
        channels: new Map([[GENERAL, { state: 'resolved', roomId: GENERAL_ROOM }]]),
      })
      view(store)
      expect(screen.queryByLabelText('Message dans #général')).not.toBeInTheDocument()
      const log = screen.getByRole('log', { name: 'Messages de général' })
      const after = log.nextElementSibling
      if (notice === null) {
        expect(after).toBeNull()
      } else {
        expect(after).toHaveTextContent(notice)
      }
    }
  )

  it('says a channel whose alias the directory does not know (a 404) is not ready yet', async () => {
    const user = userEvent.setup()
    const call = makeFakeCall()
    const store = makeFakeStore({
      channels: new Map([
        [GENERAL, { state: 'pending' }],
        [STANDUP, { state: 'pending' }],
      ]),
    })
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
    expect(screen.getByRole('link', { name: 'général, En préparation' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Message dans #général')).not.toBeInTheDocument()
    const audio = screen.getByRole('button', { name: /^Rejoindre Point quotidien/ })
    expect(audio).toHaveAccessibleName(expect.stringContaining('En préparation'))
    await user.click(audio)
    expect(call.join).not.toHaveBeenCalled()

    // Found once the room exists: the channel becomes usable.
    act(() => store.setChannels(RESOLVED))
    expect(screen.getByLabelText('Message dans #général')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'général' })).toBeInTheDocument()
  })
})

describe('a draft, a reply, an edit and a thread stay in the channel they were started in', () => {
  function renderIn(channelId: string, store: EspaceStoreLike, onNavigateChannel?: () => void) {
    const props = {
      org: 'acme',
      organisationName: 'Acme SA',
      workspace: WORKSPACE,
      store,
      ...(onNavigateChannel === undefined ? {} : { onNavigateChannel }),
    }
    const view = render(<EspaceLiveView {...props} channelId={channelId} />)
    return {
      ...view,
      showChannel: (next: string) => view.rerender(<EspaceLiveView {...props} channelId={next} />),
    }
  }
  const log = () => screen.getByRole('log')
  const own = () => within(log()).getByText('Mon point est prêt.').closest('article') as HTMLElement

  it('never sends a draft typed in one channel to the channel chosen next', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    renderIn(GENERAL, store)
    await user.type(screen.getByLabelText('Message dans #général'), 'secret pour general')
    await user.click(screen.getByRole('link', { name: /bienvenue/ }))
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message dans #bienvenue')).toHaveValue('')

    // Back in #général, the draft is where it was typed, and goes to that channel's room.
    await user.click(screen.getByRole('link', { name: 'général' }))
    expect(screen.getByLabelText('Message dans #général')).toHaveValue('secret pour general')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledTimes(1)
    expect(store.send).toHaveBeenCalledWith(GENERAL_ROOM, 'secret pour general', {})
  })

  it('never posts an edit into the channel the address changed to', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const view = renderIn(GENERAL, store)
    await selectMessageAction(user, own(), 'Modifier')
    view.showChannel(WELCOME)
    await user.click(screen.getByRole('button', { name: /^(Enregistrer|Envoyer)$/ }))
    expect(store.edit).not.toHaveBeenCalled()
    expect(store.send).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message dans #bienvenue')).toHaveValue('')
    expect(screen.queryByText('Modification du message')).not.toBeInTheDocument()

    // The edit is still open in #général, and is saved there.
    view.showChannel(GENERAL)
    expect(screen.getByText('Modification du message')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(store.edit).toHaveBeenCalledTimes(1)
    expect(store.edit).toHaveBeenCalledWith(GENERAL_ROOM, '$m2', 'Mon point est prêt.')
  })

  it('never sends the text of an edit into the channel the member clicked next', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    renderIn(GENERAL, store)
    await selectMessageAction(user, own(), 'Modifier')
    await user.click(screen.getByRole('link', { name: /bienvenue/ }))
    await user.click(screen.getByRole('button', { name: /^(Enregistrer|Envoyer)$/ }))
    expect(store.edit).not.toHaveBeenCalled()
    expect(store.send).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message dans #bienvenue')).toHaveValue('')
    expect(screen.queryByText('Modification du message')).not.toBeInTheDocument()
  })

  it('never threads a reply under a message of the channel the address left', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const view = renderIn(GENERAL, store)
    await selectMessageAction(user, within(log()).getAllByRole('article')[0]!, 'Répondre')
    view.showChannel(WELCOME)
    expect(screen.queryByRole('button', { name: 'Annuler la réponse' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Message dans #bienvenue'), 'bonjour')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledTimes(1)
    expect(store.send).toHaveBeenCalledWith(WELCOME_ROOM, 'bonjour', {})

    // The reply waits in #général, to the message it was started on.
    view.showChannel(GENERAL)
    expect(screen.getByRole('button', { name: 'Annuler la réponse' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Message dans #général'), 'bien reçu')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenLastCalledWith(GENERAL_ROOM, 'bien reçu', { replyTo: '$m1' })
  })

  it('never sends a reply typed in one channel to the channel the member clicked next', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    renderIn(GENERAL, store)
    await selectMessageAction(user, within(log()).getAllByRole('article')[0]!, 'Répondre')
    await user.type(screen.getByLabelText('Message dans #général'), 'réponse pour général')
    await user.click(screen.getByRole('link', { name: /bienvenue/ }))
    expect(screen.queryByRole('button', { name: 'Annuler la réponse' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).not.toHaveBeenCalled()

    await user.click(screen.getByRole('link', { name: 'général' }))
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledWith(GENERAL_ROOM, 'réponse pour général', {
      replyTo: '$m1',
    })
  })

  it('keeps a thread and its draft in the channel it was opened in', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const view = renderIn(GENERAL, store)
    await user.click(screen.getByRole('button', { name: /1 réponse/ }))
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    await user.type(within(panel).getByLabelText('Répondre au fil'), 'note du fil')
    view.showChannel(WELCOME)
    expect(
      screen.queryByRole('complementary', { name: 'Fil de discussion' })
    ).not.toBeInTheDocument()

    view.showChannel(GENERAL)
    const again = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(again).getByLabelText('Répondre au fil')).toHaveValue('note du fil')
    await user.click(within(again).getByRole('button', { name: 'Répondre' }))
    expect(store.send).toHaveBeenCalledWith(GENERAL_ROOM, 'note du fil', { threadRootId: '$m1' })
  })

  it('never sends a draft typed for one room once the channel answers with another', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    renderIn(GENERAL, store)
    const movedTo = (roomId: string) =>
      act(() => store.setChannels(new Map([...RESOLVED, [GENERAL, { state: 'resolved', roomId }]])))

    // Typed for #général's room, as a message and as a reply, then the channel moves.
    await user.type(screen.getByLabelText('Message dans #général'), 'secret pour X')
    movedTo(WELCOME_ROOM)
    expect(screen.getByLabelText('Message dans #général')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).not.toHaveBeenCalled()

    movedTo(GENERAL_ROOM)
    await user.clear(screen.getByLabelText('Message dans #général'))
    await selectMessageAction(user, within(log()).getAllByRole('article')[0]!, 'Répondre')
    await user.type(screen.getByLabelText('Message dans #général'), 'réponse secrète')
    movedTo(WELCOME_ROOM)
    expect(screen.getByLabelText('Message dans #général')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).not.toHaveBeenCalled()

    // Back on the room it was typed for, the draft is there again, and goes to that room.
    movedTo(GENERAL_ROOM)
    expect(screen.getByLabelText('Message dans #général')).toHaveValue('réponse secrète')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledTimes(1)
    expect(store.send).toHaveBeenCalledWith(GENERAL_ROOM, 'réponse secrète', { replyTo: '$m1' })
  })

  it('never carries a draft to another store, or to another member on the same store', async () => {
    const user = userEvent.setup()
    const first = makeFakeStore()
    const second = makeFakeStore()
    const props = {
      org: 'acme',
      organisationName: 'Acme SA',
      workspace: WORKSPACE,
      channelId: GENERAL,
    }
    const view = render(<EspaceLiveView {...props} store={first} />)
    await user.type(screen.getByLabelText('Message dans #général'), 'secret du premier')
    view.rerender(<EspaceLiveView {...props} store={second} />)
    expect(screen.getByLabelText('Message dans #général')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(second.send).not.toHaveBeenCalled()
    expect(first.send).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Message dans #général'), 'secret de moi')
    second.getUserId = () => '@someone.else:matrix.acme.kodera.io'
    act(() => second.setStatus('live'))
    expect(screen.getByLabelText('Message dans #général')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(second.send).not.toHaveBeenCalled()
  })

  it("drops a reply or an edit whose room is no longer the channel's, and sends nothing there", async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    renderIn(GENERAL, store)
    const movedTo = (roomId: string) =>
      act(() => store.setChannels(new Map([...RESOLVED, [GENERAL, { state: 'resolved', roomId }]])))

    // An edit started in #général's room, then the channel answers with another room.
    await selectMessageAction(user, own(), 'Modifier')
    movedTo(WELCOME_ROOM)
    expect(screen.queryByText('Modification du message')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message dans #général')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /^(Enregistrer|Envoyer)$/ }))
    expect(store.edit).not.toHaveBeenCalled()
    expect(store.send).not.toHaveBeenCalled()

    // A reply started in the first room goes to the new one without its target.
    movedTo(GENERAL_ROOM)
    await selectMessageAction(user, within(log()).getAllByRole('article')[0]!, 'Répondre')
    movedTo(WELCOME_ROOM)
    expect(screen.queryByRole('button', { name: 'Annuler la réponse' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Message dans #général'), 'bonjour')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.edit).not.toHaveBeenCalled()
    expect(store.send).toHaveBeenCalledTimes(1)
    expect(store.send).toHaveBeenCalledWith(WELCOME_ROOM, 'bonjour', {})
  })

  it('sends a reply on its own once its message is no longer in the loaded timeline', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    renderIn(GENERAL, store)
    await selectMessageAction(user, within(log()).getAllByRole('article')[0]!, 'Répondre')
    expect(screen.getByRole('button', { name: 'Annuler la réponse' })).toBeInTheDocument()
    // $m1 leaves the loaded timeline: no banner, so no reply relation either.
    const remaining = store.getTimeline(GENERAL_ROOM).filter((msg) => msg.eventId !== '$m1')
    store.getTimeline = (roomId) => (roomId === GENERAL_ROOM ? remaining : [])
    act(() => store.setStatus('live'))
    expect(screen.queryByRole('button', { name: 'Annuler la réponse' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Message dans #général'), 'bonjour')
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledWith(GENERAL_ROOM, 'bonjour', {})
  })

  it("never sends a reply typed under one thread into another message's thread", async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    renderIn(GENERAL, store)
    await selectMessageAction(user, within(log()).getAllByRole('article')[0]!, 'Ouvrir le fil')
    await user.type(screen.getByLabelText('Répondre au fil'), 'pour le fil de m1')
    await selectMessageAction(user, within(log()).getAllByRole('article')[1]!, 'Ouvrir le fil')
    const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
    expect(within(panel).getByLabelText('Répondre au fil')).toHaveValue('')
    await user.click(within(panel).getByRole('button', { name: 'Répondre' }))
    expect(store.send).not.toHaveBeenCalled()
  })

  it('links each channel to its own address, and opens it in place on a click', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const onNavigateChannel = vi.fn()
    renderIn(GENERAL, store, onNavigateChannel)
    const link = screen.getByRole('link', { name: /bienvenue/ })
    expect(link).toHaveAttribute('href', `/acme/workspace/${WELCOME}`)
    expect(screen.getByRole('link', { name: 'général' })).toHaveAttribute(
      'href',
      `/acme/workspace/${GENERAL}`
    )
    await user.click(link)
    expect(onNavigateChannel).toHaveBeenCalledWith(WELCOME)
    expect(window.location.pathname).not.toBe(`/acme/workspace/${WELCOME}`)
  })

  it('sends nothing while the channel asked for is not the address yet', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const held = new Promise<void>(() => undefined)
    const props = {
      org: 'acme',
      organisationName: 'Acme SA',
      workspace: WORKSPACE,
      channelId: GENERAL,
      store,
      onNavigateChannel: () => held,
    }
    const view = render(<EspaceLiveView {...props} />)
    await user.type(screen.getByLabelText('Message dans #général'), 'pour qui ?')
    await user.click(screen.getByRole('link', { name: /bienvenue/ }))
    const composer = screen.getByLabelText('Message dans #général')
    expect(composer).toHaveAttribute('readonly')
    expect(composer).toHaveAttribute('aria-disabled', 'true')
    // Read-only: what is typed meanwhile is not written.
    await user.type(composer, ' encore')
    expect(composer).toHaveValue('pour qui ?')
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled()
    // Nor can « Mentionner » write into a draft, or tell a room the member types, meanwhile.
    expect(screen.getByRole('button', { name: 'Mentionner' })).toBeDisabled()
    fireEvent.submit(screen.getByRole('button', { name: 'Envoyer' }).closest('form')!)
    expect(store.send).not.toHaveBeenCalled()

    // The router goes pending, then settles without moving: the address is #général, and wins.
    view.rerender(<EspaceLiveView {...props} navigationPending />)
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled()
    view.rerender(<EspaceLiveView {...props} navigationPending={false} />)
    expect(screen.getByRole('button', { name: 'Envoyer' })).not.toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledWith(GENERAL_ROOM, 'pour qui ?', {})
  })

  it('asks for the channel the member clicks once, and then follows the address', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    const onNavigateChannel = vi.fn()
    const view = renderIn(GENERAL, store, onNavigateChannel)
    await user.click(screen.getByRole('link', { name: /bienvenue/ }))
    expect(onNavigateChannel).toHaveBeenCalledTimes(1)
    expect(onNavigateChannel).toHaveBeenCalledWith(WELCOME)
    // Until the router commits it, the address still names #général, and so does the view.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')

    // The address follows the click: the clicked channel is shown, with no second request.
    view.showChannel(WELCOME)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('bienvenue')
    // Back: the address names #général again, and #général is shown.
    view.showChannel(GENERAL)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')
    expect(onNavigateChannel).toHaveBeenCalledTimes(1)
  })
})

// Subscription regressions use real SDK rooms/events, with no external server.
type SnapshotEvent = RawEvent & { state_key?: string; redacts?: string }
const SNAPSHOT_ROOM = '!general:matrix.acme.kodera.io'
const SNAPSHOT_CHANNEL = 'a1111111-1111-4111-8111-000000000001'
const SNAPSHOT_ME = '@me:matrix.acme.kodera.io'
const SNAPSHOT_ALICE = '@marina.loiseau:matrix.acme.kodera.io'
const SNAPSHOT_BODY = 'Snapshot <b>&</b> {literal} é 👍'
const SNAPSHOT_TIME = Date.UTC(2026, 9, 23, 8, 15)

function snapshotMessage(
  eventId: string,
  body: string,
  patch: Partial<SnapshotEvent> = {}
): SnapshotEvent {
  return {
    event_id: eventId,
    type: 'm.room.message',
    sender: SNAPSHOT_ALICE,
    origin_server_ts: SNAPSHOT_TIME,
    content: { msgtype: 'm.text', body },
    ...patch,
  }
}

function snapshotFixture(
  initialEvents = [snapshotMessage('$root', SNAPSHOT_BODY)],
  initialCounts = { unread: 0, mentions: 0 },
  initialStateEvents: SnapshotEvent[] = []
) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const unexpected: string[] = []
  const requests: { path: string; body: Record<string, unknown> }[] = []
  let syncCount = 0
  let holdSend = false
  let sendAnswer: ((response: Response) => void) | undefined
  let pollAnswer: ((response: Response) => void) | undefined
  let batch = 0
  const member = (user: string, membership: 'join' | 'leave'): SnapshotEvent => ({
    ...snapshotMessage(`$${membership}-${user}`, ''),
    type: 'm.room.member',
    state_key: user,
    sender: user,
    content: { membership },
  })
  const initialState: SnapshotEvent[] = [
    {
      ...snapshotMessage('$create', ''),
      type: 'm.room.create',
      state_key: '',
      content: { creator: SNAPSHOT_ME, room_version: '10' },
    },
    ...[
      ...new Set([SNAPSHOT_ME, SNAPSHOT_ALICE, ...initialEvents.map((event) => event.sender)]),
    ].map((user) => member(user, 'join')),
    {
      ...snapshotMessage('$name', ''),
      type: 'm.room.name',
      state_key: '',
      content: { name: 'général' },
    },
    ...initialStateEvents,
  ]
  const roomData = (
    events: SnapshotEvent[],
    state: SnapshotEvent[] = [],
    counts = initialCounts
  ) => ({
    state: { events: state },
    timeline: { events, limited: false, prev_batch: 'previous' },
    unread_notifications: { notification_count: counts.unread, highlight_count: counts.mentions },
  })
  const response = (rooms: unknown) => json(200, { next_batch: `s${++batch}`, rooms })
  const base = vi.fn<typeof fetch>(async (input, init) => {
    const path = decodeURIComponent(
      new URL(String(input instanceof Request ? input.url : input)).pathname
    )
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    // No `org.matrix.msc4143` in `unstable_features`, as on our Synapse: matrix-js-sdk 45 then
    // never asks for RTC transports, and `cachedRtcTransports` stays unset.
    if (method === 'GET' && path === '/_matrix/client/versions') {
      return json(200, { versions: ['v1.11'] })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/capabilities') {
      return json(200, { capabilities: {} })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/pushrules/') {
      return json(200, { global: {} })
    }
    if (method === 'POST' && path === `/_matrix/client/v3/user/${SNAPSHOT_ME}/filter`) {
      return json(200, { filter_id: 'snapshot-filter' })
    }
    if (
      method === 'GET' &&
      path ===
        `/_matrix/client/v3/directory/room/#kodera-ch-${SNAPSHOT_CHANNEL}:matrix.acme.kodera.io`
    ) {
      return json(200, { room_id: SNAPSHOT_ROOM, servers: ['matrix.acme.kodera.io'] })
    }
    if (method === 'GET' && path === '/_matrix/client/v3/sync') {
      syncCount++
      if (syncCount === 1) {
        return response({ join: { [SNAPSHOT_ROOM]: roomData(initialEvents, initialState) } })
      }
      return new Promise<Response>((resolve, reject) => {
        const answer = (value: Response) => {
          pollAnswer = undefined
          init?.signal?.removeEventListener('abort', abort)
          resolve(value)
        }
        const abort = () => {
          pollAnswer = undefined
          reject(new DOMException('Stopped test sync', 'AbortError'))
        }
        pollAnswer = answer
        init?.signal?.addEventListener('abort', abort, { once: true })
        if (init?.signal?.aborted) abort()
      })
    }
    if (method === 'PUT' && path.startsWith(`/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/send/`)) {
      requests.push({
        path,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      if (holdSend) {
        holdSend = false
        return new Promise<Response>((resolve) => {
          sendAnswer = (value) => {
            sendAnswer = undefined
            resolve(value)
          }
        })
      }
      return json(200, { event_id: `$accepted-${requests.length}` })
    }
    // The log has no height in jsdom, so it pages back at once: there is nothing older.
    if (method === 'GET' && path === `/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/messages`) {
      return json(200, { start: 'previous', chunk: [] })
    }
    if (method === 'POST' && path === `/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/read_markers`) {
      requests.push({
        path,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      return json(200, {})
    }
    // « Typing » notices from the composer: answered, and not among the requests the tests read.
    if (
      method === 'PUT' &&
      path === `/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/typing/${SNAPSHOT_ME}`
    ) {
      return json(200, {})
    }
    // The full member list, which the store asks for when someone in a call never wrote here:
    // the members the room's state already holds, and no one else.
    if (method === 'GET' && path === `/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/members`) {
      return json(200, { chunk: initialState.filter((event) => event.type === 'm.room.member') })
    }
    unexpected.push(`${method} ${path}`)
    throw new Error(`Unexpected snapshot fixture request: ${method} ${path}`)
  })
  const store = createEspaceStore(
    {
      baseUrl: 'https://matrix.acme.kodera.io',
      userId: SNAPSHOT_ME,
      deviceId: 'SNAPSHOT-TEST',
      accessToken: 'synthetic-test-token',
    },
    base
  )
  async function settleSync(rooms: unknown) {
    await vi.waitFor(() => expect(pollAnswer).toBeDefined())
    const next = syncCount + 1
    pollAnswer!(response(rooms))
    await vi.waitFor(() => {
      expect(syncCount).toBeGreaterThanOrEqual(next)
      expect(pollAnswer).toBeDefined()
    })
  }
  return {
    store,
    requests,
    async start() {
      await store.start()
      await store.resolveChannels([SNAPSHOT_CHANNEL])
      await vi.waitFor(() => {
        expect(matrixClientForTests(store).getCachedCapabilities()).toEqual({})
        expect(matrixClientForTests(store).cachedRtcTransports.get()).toBeUndefined()
        expect(store.getSnapshot().status).toBe('live')
        expect(store.getSnapshot().channels.get(SNAPSHOT_CHANNEL)).toEqual({
          state: 'resolved',
          roomId: SNAPSHOT_ROOM,
        })
        expect(pollAnswer).toBeDefined()
      })
      const room = matrixClientForTests(store).getRoom(SNAPSHOT_ROOM)
      expect(room?.getMyMembership()).toBe('join')
      expect(
        room
          ?.getLiveTimeline()
          .getEvents()
          .map((event) => event.getId())
      ).toEqual(initialEvents.map((event) => event.event_id))
    },
    holdNextSend() {
      holdSend = true
    },
    async finishSend(status = 200, body: unknown = { event_id: '$released' }) {
      await vi.waitFor(() => expect(sendAnswer).toBeDefined())
      sendAnswer!(json(status, body))
    },
    async releaseHeldSend() {
      if (holdSend || sendAnswer !== undefined) {
        await vi.waitFor(() => expect(sendAnswer).toBeDefined())
        sendAnswer!(json(200, { event_id: '$cleanup' }))
      }
    },
    publish: (events: SnapshotEvent[], counts = initialCounts) =>
      settleSync({ join: { [SNAPSHOT_ROOM]: roomData(events, [], counts) } }),
    publishState: (state: SnapshotEvent[]) =>
      settleSync({ join: { [SNAPSHOT_ROOM]: roomData([], state) } }),
    idle: () => settleSync({}),
    leave: () =>
      settleSync({ leave: { [SNAPSHOT_ROOM]: roomData([member(SNAPSHOT_ME, 'leave')]) } }),
    stop() {
      store.stop()
      expect(sendAnswer).toBeUndefined()
      expect(unexpected).toEqual([])
    },
  }
}

function snapshotThreadReply(eventId: string, body: string): SnapshotEvent {
  return snapshotMessage(eventId, body, {
    content: {
      msgtype: 'm.text',
      body,
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: '$root',
        is_falling_back: true,
        'm.in_reply_to': { event_id: '$root' },
      },
    },
  })
}

function expectSameSummaries(
  before: ReturnType<ReturnType<typeof snapshotFixture>['store']['getSnapshot']>,
  after: ReturnType<ReturnType<typeof snapshotFixture>['store']['getSnapshot']>
) {
  expect(after.rooms).toBe(before.rooms)
  expect(after.invites).toBe(before.invites)
  expect(after.channels).toBe(before.channels)
  expect(after.status).toBe(before.status)
}

const SNAPSHOT_WORKSPACE: Workspace = {
  ...WORKSPACE,
  categories: [
    {
      ...WORKSPACE.categories[0]!,
      channels: [WORKSPACE.categories[0]!.channels[0]!],
    },
  ],
}

describe('reading a channel clears its unread mark', () => {
  function countsOn(
    store: ReturnType<typeof makeFakeStore>,
    roomId: string,
    counts: { unread: number; mentions: number }
  ) {
    return store
      .getSnapshot()
      .rooms.map((room) => (room.roomId === roomId ? { ...room, ...counts } : room))
  }
  function withMarkRead(store: ReturnType<typeof makeFakeStore>) {
    const markRead = vi.fn<(roomId: string) => Promise<void>>(async () => undefined)
    store.markRead = markRead
    return markRead
  }
  function show(store: EspaceStoreLike) {
    return render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
  }
  const newer: MessageView = {
    key: '$m3',
    eventId: '$m3',
    sender: '@marina.loiseau:matrix.acme.kodera.io',
    body: 'Encore une chose',
    ts: Date.UTC(2026, 9, 23, 8, 20, 0),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }

  it('marks the channel on screen read, once per newest message, and not another channel', async () => {
    const store = makeFakeStore()
    store.setRooms(countsOn(store, GENERAL_ROOM, { unread: 2, mentions: 0 }))
    const markRead = withMarkRead(store)
    show(store)
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1))
    // #welcome counts 3 unread, but it is not on screen.
    expect(markRead).toHaveBeenCalledWith(GENERAL_ROOM)
    // A redraw with the same newest message, still counted unread, asks nothing more.
    act(() => store.setStatus('live'))
    expect(markRead).toHaveBeenCalledTimes(1)
    // A new message while the channel is on screen is read too.
    act(() => store.setTimeline(GENERAL_ROOM, [...store.getTimeline(GENERAL_ROOM), newer]))
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2))
  })

  it('marks a channel that counts only mentions, and never one with nothing unread', async () => {
    const quiet = makeFakeStore()
    const untouched = withMarkRead(quiet)
    const view = show(quiet)
    await act(async () => {})
    expect(untouched).not.toHaveBeenCalled()
    view.unmount()

    const mentioned = makeFakeStore()
    mentioned.setRooms(countsOn(mentioned, GENERAL_ROOM, { unread: 0, mentions: 1 }))
    const markRead = withMarkRead(mentioned)
    show(mentioned)
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(GENERAL_ROOM))
  })

  it('waits while the page is hidden, and marks it once the page is shown again', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const store = makeFakeStore()
      store.setRooms(countsOn(store, GENERAL_ROOM, { unread: 1, mentions: 0 }))
      const markRead = withMarkRead(store)
      show(store)
      await act(async () => {})
      expect(markRead).not.toHaveBeenCalled()
      visibility.mockReturnValue('visible')
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await waitFor(() => expect(markRead).toHaveBeenCalledWith(GENERAL_ROOM))
    } finally {
      visibility.mockRestore()
    }
  })

  it('leaves a refused receipt without an unhandled rejection', async () => {
    const store = makeFakeStore()
    store.setRooms(countsOn(store, GENERAL_ROOM, { unread: 1, mentions: 0 }))
    // Not a `vi.fn`: a spy settles the promises it returns, which would hide the rejection.
    const asked: string[] = []
    store.markRead = (roomId) => {
      asked.push(roomId)
      return Promise.reject(new Error('receipt refused'))
    }
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', record)
    try {
      show(store)
      await waitFor(() => expect(asked).toEqual([GENERAL_ROOM]))
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  it('sends the read marker for the newest message from the real store', async () => {
    const fixture = snapshotFixture(undefined, { unread: 1, mentions: 0 })
    let mounted: ReturnType<typeof render> | undefined
    try {
      await fixture.start()
      mounted = render(
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={SNAPSHOT_WORKSPACE}
          channelId={SNAPSHOT_CHANNEL}
          store={fixture.store}
        />
      )
      await waitFor(() =>
        expect(fixture.requests.filter(({ path }) => path.endsWith('/read_markers'))).toEqual([
          {
            path: `/_matrix/client/v3/rooms/${SNAPSHOT_ROOM}/read_markers`,
            body: expect.objectContaining({ 'm.fully_read': '$root' }),
          },
        ])
      )
    } finally {
      await act(async () => {
        mounted?.unmount()
        fixture.stop()
      })
    }
  })
})

describe('actual-store message subscriptions without a parent render', () => {
  it('shows pending, failed and same-transaction retried delivery from the store alone', async () => {
    await i18n.changeLanguage('fr')
    const fixture = snapshotFixture()
    const { store } = fixture
    let mounted: ReturnType<typeof render> | undefined
    let sending: Promise<unknown> | undefined
    let unsubscribe = () => {}
    let parentRenders = 0
    function Parent() {
      parentRenders++
      return (
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={SNAPSHOT_WORKSPACE}
          channelId={GENERAL}
          store={store}
        />
      )
    }
    try {
      await fixture.start()
      mounted = render(<Parent />)
      expect(screen.getByText(SNAPSHOT_BODY).textContent).toBe(SNAPSHOT_BODY)
      const composer = screen.getByRole('combobox', { name: 'Message dans #général' })
      const summaries = store.getSnapshot()
      let witnessedPending = false
      unsubscribe = store.subscribe(() => {
        witnessedPending ||= store
          .getTimeline(SNAPSHOT_ROOM)
          .some(
            (message) =>
              message.body === 'Pending <b>&</b> {literal}' && message.delivery === 'pending'
          )
      })
      await act(async () => {
        fixture.holdNextSend()
        sending = store
          .send(SNAPSHOT_ROOM, 'Pending <b>&</b> {literal}')
          .catch((error: unknown) => error)
        await vi.waitFor(() => expect(witnessedPending).toBe(true))
      })
      const pending = store.getTimeline(SNAPSHOT_ROOM).at(-1)!
      expect(screen.getByText('Pending <b>&</b> {literal}').textContent).toBe(pending.body)
      expect(screen.getByText('Envoi en cours…')).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: 'Message dans #général' })).toBe(composer)
      expect(composer).toHaveValue('')
      expect(parentRenders).toBe(1)
      expectSameSummaries(summaries, store.getSnapshot())

      await act(async () => {
        await fixture.finishSend(403, { errcode: 'M_FORBIDDEN', error: 'Controlled send failure' })
        expect(await sending).toMatchObject({ errcode: 'M_FORBIDDEN' })
      })
      expect(screen.getByText('Échec de l’envoi')).toBeInTheDocument()
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.key).toBe(pending.key)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Réessayer' }))
      await waitFor(() => expect(fixture.requests).toHaveLength(2))
      expect(fixture.requests[1]).toEqual(fixture.requests[0])
      expect(fixture.requests[0]!.path).toContain(
        `/${SNAPSHOT_ROOM}/send/m.room.message/${pending.key}`
      )
      expect(fixture.requests[0]!.body).toEqual({ msgtype: 'm.text', body: pending.body })
      expect(screen.getByText('Envoi en cours…')).toBeInTheDocument()
      await act(async () => {
        await fixture.publish([
          snapshotMessage('$accepted-2', pending.body, {
            sender: SNAPSHOT_ME,
            unsigned: { transaction_id: pending.key },
          }),
        ])
      })
      expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)).toMatchObject({
        key: pending.key,
        eventId: '$accepted-2',
        body: pending.body,
        delivery: 'sent',
      })
      expect(screen.getByText(pending.body)).toBeInTheDocument()
      expect(screen.queryByText('Envoi en cours…')).toBeNull()
      expect(screen.queryByText('Échec de l’envoi')).toBeNull()
      expect(parentRenders).toBe(1)
      expectSameSummaries(summaries, store.getSnapshot())
      expect(screen.getByRole('combobox', { name: 'Message dans #général' })).toBe(composer)
    } finally {
      unsubscribe()
      await act(async () => {
        await fixture.releaseHeldSend()
        await sending
        mounted?.unmount()
        fixture.stop()
      })
    }
  })

  it('refreshes a preopened thread and incoming edits, reactions and redactions with constant parent props', async () => {
    await i18n.changeLanguage('fr')
    const fixture = snapshotFixture([
      snapshotMessage('$root', SNAPSHOT_BODY),
      snapshotThreadReply('$reply1', 'First thread <b>&</b>'),
    ])
    const { store } = fixture
    let mounted: ReturnType<typeof render> | undefined
    let parentRenders = 0
    function Parent() {
      parentRenders++
      return (
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={SNAPSHOT_WORKSPACE}
          channelId={GENERAL}
          store={store}
        />
      )
    }
    try {
      await fixture.start()
      mounted = render(<Parent />)
      await userEvent.setup().click(screen.getByRole('button', { name: '1 réponse' }))
      const panel = screen.getByRole('complementary', { name: 'Fil de discussion' })
      expect(within(panel).getByText('First thread <b>&</b>')).toBeInTheDocument()
      const composer = within(panel).getByRole('combobox', { name: 'Répondre au fil' })
      const mainBefore = store.getTimeline(SNAPSHOT_ROOM)
      const threadBefore = store.getThread(SNAPSHOT_ROOM, '$root')
      const before = store.getSnapshot()
      await act(async () => {
        await fixture.publish([snapshotThreadReply('$reply2', 'Second thread {literal}')])
      })
      expect(store.getTimeline(SNAPSHOT_ROOM)).toBe(mainBefore)
      expect(store.getThread(SNAPSHOT_ROOM, '$root')).not.toBe(threadBefore)
      expectSameSummaries(before, store.getSnapshot())
      expect(store.getSnapshot()).not.toBe(before)
      expect(within(panel).getByText('Second thread {literal}')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '2 réponses' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      expect(within(panel).getByRole('combobox', { name: 'Répondre au fil' })).toBe(composer)
      expect(parentRenders).toBe(1)

      await act(async () => {
        await fixture.publish([snapshotMessage('$incoming', 'Incoming <i>&</i>')])
      })
      expect(screen.getByText('Incoming <i>&</i>').textContent).toBe('Incoming <i>&</i>')
      await act(async () => {
        await fixture.publish([
          snapshotMessage('$edit', '* edited', {
            origin_server_ts: SNAPSHOT_TIME + 1,
            content: {
              msgtype: 'm.text',
              body: '* edited',
              'm.new_content': { msgtype: 'm.text', body: 'Edited <b>&</b> {literal}' },
              'm.relates_to': { rel_type: 'm.replace', event_id: '$incoming' },
            },
          }),
        ])
      })
      expect(screen.getByText('Edited <b>&</b> {literal}').querySelector('b')).toBeNull()
      expect(screen.getByText('(modifié)')).toBeInTheDocument()
      expect(screen.queryByText('Incoming <i>&</i>')).toBeNull()
      await act(async () => {
        await fixture.publish([
          snapshotMessage('$reaction', '', {
            type: 'm.reaction',
            sender: SNAPSHOT_ME,
            content: {
              'm.relates_to': { rel_type: 'm.annotation', event_id: '$incoming', key: '👍' },
            },
          }),
        ])
      })
      expect(screen.getByRole('button', { name: '👍 1, vous avez réagi' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await act(async () => {
        await fixture.publish([
          snapshotMessage('$redact', '', {
            type: 'm.room.redaction',
            redacts: '$incoming',
            content: {},
          }),
        ])
      })
      expect(screen.getByText('Message supprimé')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '👍 1, vous avez réagi' })).toBeNull()
      expect(screen.queryByText('Edited <b>&</b> {literal}')).toBeNull()
      expectSameSummaries(before, store.getSnapshot())
      expect(parentRenders).toBe(1)
      expect(screen.getByRole('complementary', { name: 'Fil de discussion' })).toBe(panel)
    } finally {
      await act(async () => {
        mounted?.unmount()
        fixture.stop()
      })
    }
  })
})

describe('bilingual live-store message catalogues', () => {
  it('localizes rendered live-store pending delivery and composer controls in English', async () => {
    await i18n.changeLanguage('en')
    const fixture = snapshotFixture()
    const { store } = fixture
    let mounted: ReturnType<typeof render> | undefined
    let sending: Promise<unknown> | undefined
    let unsubscribe = () => {}
    let parentRenders = 0
    function Parent() {
      parentRenders++
      return (
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={SNAPSHOT_WORKSPACE}
          channelId={GENERAL}
          store={store}
        />
      )
    }
    try {
      await fixture.start()
      mounted = render(<Parent />)
      expect(screen.getByText(SNAPSHOT_BODY).textContent).toBe(SNAPSHOT_BODY)
      const composer = screen.getByRole('combobox')
      const before = store.getSnapshot()
      let witnessed = false
      unsubscribe = store.subscribe(() => {
        witnessed ||= store
          .getTimeline(SNAPSHOT_ROOM)
          .some(
            (message) =>
              message.body === 'Pending <b>&</b> {unchanged}' && message.delivery === 'pending'
          )
      })
      await act(async () => {
        fixture.holdNextSend()
        sending = store
          .send(SNAPSHOT_ROOM, 'Pending <b>&</b> {unchanged}')
          .catch((error: unknown) => error)
        await vi.waitFor(() => expect(witnessed).toBe(true))
      })
      const pending = store.getTimeline(SNAPSHOT_ROOM).at(-1)!
      expect(pending).toMatchObject({ body: 'Pending <b>&</b> {unchanged}', delivery: 'pending' })
      const body = screen.getByText(pending.body)
      expect(body.textContent).toBe(pending.body)
      const article = body.closest('article')
      expect(article).not.toBeNull()
      const delivery = article!.querySelector('[data-delivery="sending"]')
      expect(delivery).not.toBeNull()
      expectSameSummaries(before, store.getSnapshot())
      expect(parentRenders).toBe(1)
      expect(screen.getByRole('combobox')).toBe(composer)
      expect(delivery!.textContent).toBe('Sending…')
      expect(screen.getByRole('combobox', { name: 'Message in #general' })).toBe(composer)
      expect(composer).toHaveAttribute('placeholder', 'Write in #general')
    } finally {
      unsubscribe()
      await act(async () => {
        await fixture.releaseHeldSend()
        await sending
        mounted?.unmount()
        fixture.stop()
      })
    }
  })
})

const MESSAGE_COPY = {
  fr: {
    general: 'général',
    log: 'Messages de général',
    composer: 'Message dans #général',
    placeholder: 'Écrire dans #général',
    sending: 'Envoi en cours…',
    failed: 'Échec de l’envoi',
    retry: 'Réessayer',
    edited: '(modifié)',
    deleted: 'Message supprimé',
    replyPrefix: 'En réponse à',
    reply: 'Répondre',
    cancelReply: 'Annuler la réponse',
    edit: 'Modifier',
    editing: 'Modification du message',
    cancelEdit: 'Annuler la modification',
    save: 'Enregistrer',
    send: 'Envoyer',
    remove: 'Supprimer',
    openThread: 'Ouvrir le fil',
    thread: 'Fil de discussion',
    replies: 'Réponses',
    threadInput: 'Répondre au fil',
    threadPlaceholder: 'Répondre au fil…',
    one: '1 réponse',
    two: '2 réponses',
    reaction: '👍 1, vous avez réagi',
    unread: 'non lu',
    expired: 'Votre session de messagerie a expiré.',
    reconnect: 'Se reconnecter',
    actions: 'Actions du message de',
    empty: 'Aucun message dans #général.',
  },
  en: {
    general: 'general',
    log: 'Messages in general',
    composer: 'Message in #general',
    placeholder: 'Write in #general',
    sending: 'Sending…',
    failed: 'Send failed',
    retry: 'Try again',
    edited: '(edited)',
    deleted: 'Message deleted',
    replyPrefix: 'In reply to',
    reply: 'Reply',
    cancelReply: 'Cancel reply',
    edit: 'Edit',
    editing: 'Editing message',
    cancelEdit: 'Cancel edit',
    save: 'Save',
    send: 'Send',
    remove: 'Delete',
    openThread: 'Open thread',
    thread: 'Thread',
    replies: 'Replies',
    threadInput: 'Reply to thread',
    threadPlaceholder: 'Reply to thread…',
    one: '1 reply',
    two: '2 replies',
    reaction: '👍 1, you reacted',
    unread: 'unread',
    expired: 'Your messaging session has expired.',
    reconnect: 'Sign in again',
    actions: 'Actions for the message from',
    empty: 'No messages in #general.',
  },
} as const

const MESSAGE_LANGUAGES = ['fr', 'en'] as const

describe('literal bilingual live-store acceptance', () => {
  it.each(MESSAGE_LANGUAGES)(
    'keeps %s pending, failed and retried message bytes and transaction identity',
    async (language) => {
      await i18n.changeLanguage(language)
      const copy = MESSAGE_COPY[language]
      const fixture = snapshotFixture()
      const { store } = fixture
      let mounted: ReturnType<typeof render> | undefined
      let sending: Promise<unknown> | undefined
      try {
        await fixture.start()
        mounted = render(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={SNAPSHOT_WORKSPACE}
            channelId={GENERAL}
            store={store}
          />
        )
        await act(async () => {
          fixture.holdNextSend()
          sending = store
            .send(SNAPSHOT_ROOM, 'Unchanged é <b>&</b> {literal}')
            .catch((error: unknown) => error)
          await vi.waitFor(() =>
            expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)?.delivery).toBe('pending')
          )
        })
        const pending = store.getTimeline(SNAPSHOT_ROOM).at(-1)!
        expect(screen.getByText(pending.body).textContent).toBe('Unchanged é <b>&</b> {literal}')
        expect(screen.getByText(copy.sending)).toBeInTheDocument()
        expect(screen.getByRole('combobox', { name: copy.composer })).toHaveAttribute(
          'placeholder',
          copy.placeholder
        )
        await act(async () => {
          await fixture.finishSend(403, {
            errcode: 'M_FORBIDDEN',
            error: 'Controlled send failure',
          })
          expect(await sending).toMatchObject({ errcode: 'M_FORBIDDEN' })
        })
        expect(screen.getByText(copy.failed)).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: copy.retry }))
        await waitFor(() => expect(fixture.requests).toHaveLength(2))
        expect(fixture.requests[1]).toEqual(fixture.requests[0])
        expect(fixture.requests[1]!.path).toContain(
          `/${SNAPSHOT_ROOM}/send/m.room.message/${pending.key}`
        )
        expect(fixture.requests[1]!.body).toEqual({ msgtype: 'm.text', body: pending.body })
        await act(async () => {
          await fixture.publish([
            snapshotMessage('$accepted-2', pending.body, {
              sender: SNAPSHOT_ME,
              unsigned: { transaction_id: pending.key },
            }),
          ])
        })
        expect(store.getTimeline(SNAPSHOT_ROOM).at(-1)).toMatchObject({
          key: pending.key,
          eventId: '$accepted-2',
          body: pending.body,
          delivery: 'sent',
        })
        expect(screen.queryByText(copy.sending)).toBeNull()
        expect(screen.queryByText(copy.failed)).toBeNull()
      } finally {
        await act(async () => {
          await fixture.releaseHeldSend()
          await sending
          mounted?.unmount()
          fixture.stop()
        })
      }
    }
  )

  it.each(MESSAGE_LANGUAGES)(
    'localizes %s message controls, threads and time while escaping user data',
    async (language) => {
      await i18n.changeLanguage(language)
      const copy = MESSAGE_COPY[language]
      const authorId = '@eve.<img>:matrix.acme.kodera.io'
      const author = 'Eve <img>'
      const channel = 'Projet <b>&</b> {team}'
      const workspace: Workspace = {
        ...SNAPSHOT_WORKSPACE,
        categories: [
          {
            ...SNAPSHOT_WORKSPACE.categories[0]!,
            channels: [
              {
                ...SNAPSHOT_WORKSPACE.categories[0]!.channels[0]!,
                template_key: null,
                name: channel,
                topic: 'Topic <script>&</script> {literal}',
              },
            ],
          },
        ],
      }
      const fixture = snapshotFixture([
        snapshotMessage('$root', SNAPSHOT_BODY, { sender: authorId }),
        snapshotMessage('$own', 'Own original', { sender: SNAPSHOT_ME }),
        snapshotMessage('$deleted', 'Before deletion'),
        snapshotMessage('$quoted', 'Quoted deleted target', {
          content: {
            msgtype: 'm.text',
            body: 'Quoted deleted target',
            'm.relates_to': { 'm.in_reply_to': { event_id: '$deleted' } },
          },
        }),
        snapshotThreadReply('$reply1', 'First thread <b>&</b>'),
        snapshotMessage('$mine', '', {
          type: 'm.reaction',
          sender: SNAPSHOT_ME,
          content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$root', key: '👍' } },
        }),
        snapshotMessage('$other', '', {
          type: 'm.reaction',
          content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$root', key: '✨' } },
        }),
      ])
      const { store } = fixture
      const timeSpy = vi.spyOn(timeFormatting, 'formatTime')
      let mounted: ReturnType<typeof render> | undefined
      const user = userEvent.setup()
      try {
        await fixture.start()
        mounted = render(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={workspace}
            channelId={GENERAL}
            store={store}
          />
        )
        const log = screen.getByRole('log', {
          name: language === 'fr' ? `Messages de ${channel}` : `Messages in ${channel}`,
        })
        const root = within(log).getByText(SNAPSHOT_BODY).closest('article')!
        expect(root).not.toBeNull()
        expect(within(log).getByText(SNAPSHOT_BODY).textContent).toBe(SNAPSHOT_BODY)
        expect(within(log).getByText(SNAPSHOT_BODY).querySelector('b')).toBeNull()
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(channel)
        expect(
          screen.getByText('Topic <script>&</script> {literal}').querySelector('script')
        ).toBeNull()
        expect(within(root).getByText(author).textContent).toBe(author)
        const time = root.querySelector('time')!
        expect(time.textContent).toBe('10:15')
        expect(time).toHaveAttribute('datetime', '2026-10-23T08:15:00.000Z')
        expect(
          within(root).getByRole('button', {
            name: `${copy.actions} ${author} ${language === 'fr' ? 'à' : 'at'} 10:15`,
          })
        ).toBeInTheDocument()
        const rootTimeCalls = timeSpy.mock.calls.filter(
          ([iso]) => iso === '2026-10-23T08:15:00.000Z'
        )
        expect(rootTimeCalls.length).toBeGreaterThanOrEqual(3)
        expect(rootTimeCalls.every(([, locale]) => locale === language)).toBe(true)
        expect(within(root).getByRole('button', { name: copy.reaction })).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        await user.click(within(root).getByRole('button', { name: '✨ 1' }))
        await waitFor(() =>
          expect(
            fixture.requests.some((request) => request.path.includes('/send/m.reaction/'))
          ).toBe(true)
        )
        expect(
          fixture.requests.find((request) => request.path.includes('/send/m.reaction/'))!.body
        ).toEqual({
          'm.relates_to': { rel_type: 'm.annotation', event_id: '$root', key: '✨' },
        })
        await act(async () => {
          await fixture.publish([
            snapshotMessage('$redact-deleted', '', {
              type: 'm.room.redaction',
              redacts: '$deleted',
              content: {},
            }),
          ])
        })
        expect(within(log).getAllByText(copy.deleted)).toHaveLength(2)
        expect(within(log).getByText(copy.replyPrefix)).toBeInTheDocument()
        expect(within(log).getByText('Quoted deleted target')).toBeInTheDocument()
        const deleted = within(log)
          .getAllByText(copy.deleted)
          .find((node) => node.hasAttribute('data-deleted'))!
        expect(deleted.closest('article')!.querySelector('[data-message-actions]')).toBeNull()
        const choose = async (article: HTMLElement, action: string) => {
          await user.click(
            within(article).getByRole('button', {
              name: /^(Actions du message|Actions for the message)/,
            })
          )
          await user.click(screen.getByRole('menuitem', { name: action }))
        }
        await user.click(
          within(root).getByRole('button', {
            name: /^(Actions du message|Actions for the message)/,
          })
        )
        expect(screen.queryByRole('menuitem', { name: copy.edit })).toBeNull()
        expect(screen.queryByRole('menuitem', { name: copy.remove })).toBeNull()
        await user.click(screen.getByRole('menuitem', { name: copy.reply }))
        const strong = mounted.container.querySelector('strong')!
        expect(strong.textContent).toBe(author)
        expect(strong.querySelector('img')).toBeNull()
        expect(strong.parentElement!.textContent).toBe(`${copy.replyPrefix} ${author}`)
        const composer = screen.getByRole('combobox', {
          name: language === 'fr' ? `Message dans #${channel}` : `Message in #${channel}`,
        })
        fireEvent.change(composer, { target: { value: 'Draft <b>&</b> {literal}' } })
        await user.click(screen.getByRole('button', { name: copy.cancelReply }))
        expect(composer).toHaveValue('Draft <b>&</b> {literal}')
        await choose(root, copy.reply)
        await user.click(screen.getByRole('button', { name: copy.send }))
        await waitFor(() =>
          expect(
            fixture.requests.some((request) => request.body.body === 'Draft <b>&</b> {literal}')
          ).toBe(true)
        )
        expect(
          fixture.requests.find((request) => request.body.body === 'Draft <b>&</b> {literal}')!
            .body['m.relates_to']
        ).toEqual({ 'm.in_reply_to': { event_id: '$root' } })
        const own = within(log).getByText('Own original').closest('article')!
        await choose(own, copy.edit)
        expect(screen.getByText(copy.editing)).toBeInTheDocument()
        expect(composer).toHaveValue('Own original')
        await user.click(screen.getByRole('button', { name: copy.cancelEdit }))
        expect(composer).toHaveValue('')
        await choose(own, copy.edit)
        fireEvent.change(composer, { target: { value: 'Edited own <b>&</b> {literal}' } })
        await user.click(screen.getByRole('button', { name: copy.save }))
        await waitFor(() =>
          expect(
            fixture.requests.some((request) => request.body['m.new_content'] !== undefined)
          ).toBe(true)
        )
        expect(
          fixture.requests.find((request) => request.body['m.new_content'] !== undefined)!.body
        ).toEqual({
          msgtype: 'm.text',
          body: '* Edited own <b>&</b> {literal}',
          'm.new_content': { msgtype: 'm.text', body: 'Edited own <b>&</b> {literal}' },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$own' },
        })
        expect(within(own).getByText(copy.edited)).toBeInTheDocument()
        await user.click(
          within(own).getByRole('button', { name: /^(Actions du message|Actions for the message)/ })
        )
        expect(screen.getByRole('menuitem', { name: copy.remove })).toBeInTheDocument()
        await user.keyboard('{Escape}')
        await choose(root, copy.openThread)
        const panel = screen.getByRole('complementary', { name: copy.thread })
        expect(within(panel).getByRole('heading', { name: copy.thread })).toBeInTheDocument()
        expect(within(panel).getByRole('region', { name: copy.replies })).toBeInTheDocument()
        expect(within(panel).getByRole('combobox', { name: copy.threadInput })).toHaveAttribute(
          'placeholder',
          copy.threadPlaceholder
        )
        expect(screen.getByRole('button', { name: copy.one })).toHaveAttribute(
          'aria-expanded',
          'true'
        )
        await act(async () => {
          await fixture.publish([snapshotThreadReply('$reply2', 'Second thread {literal}')])
        })
        expect(screen.getByRole('button', { name: copy.two })).toHaveAttribute(
          'aria-expanded',
          'true'
        )
        const threadInput = within(panel).getByRole('combobox', { name: copy.threadInput })
        fireEvent.change(threadInput, { target: { value: 'Thread raw <b>&</b> {literal}' } })
        await user.click(within(panel).getByRole('button', { name: copy.reply }))
        await waitFor(() =>
          expect(
            fixture.requests.some(
              (request) => request.body.body === 'Thread raw <b>&</b> {literal}'
            )
          ).toBe(true)
        )
        expect(
          fixture.requests.find((request) => request.body.body === 'Thread raw <b>&</b> {literal}')!
            .body['m.relates_to']
        ).toEqual({
          rel_type: 'm.thread',
          event_id: '$root',
          is_falling_back: true,
          'm.in_reply_to': { event_id: '$root' },
        })
        mounted.rerender(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={{
              ...workspace,
              categories: workspace.categories.map((category) => ({
                ...category,
                channels: category.channels.map((entry) => ({
                  ...entry,
                  lifecycle: 'archived' as const,
                })),
              })),
            }}
            channelId={GENERAL}
            store={store}
          />
        )
        expect(
          within(log).queryByRole('button', {
            name: /^(Actions du message|Actions for the message)/,
          })
        ).toBeNull()
        expect(
          screen.queryByRole('combobox', {
            name: language === 'fr' ? `Message dans #${channel}` : `Message in #${channel}`,
          })
        ).toBeNull()
        expect(within(panel).queryByRole('combobox', { name: copy.threadInput })).toBeNull()
      } finally {
        await act(async () => {
          mounted?.unmount()
          fixture.stop()
        })
      }
    }
  )

  it.each(MESSAGE_LANGUAGES)(
    'localizes %s unread, empty-channel and expired-session controls through the actual store',
    async (language) => {
      await i18n.changeLanguage(language)
      const copy = MESSAGE_COPY[language]
      const fixture = snapshotFixture([])
      const { store } = fixture
      const reconnect = vi.fn()
      let mounted: ReturnType<typeof render> | undefined
      try {
        await fixture.start()
        mounted = render(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={SNAPSHOT_WORKSPACE}
            channelId={GENERAL}
            store={store}
            onReconnect={reconnect}
          />
        )
        expect(screen.getByRole('log', { name: copy.log })).toBeInTheDocument()
        // Said once the homeserver has answered that nothing older exists.
        expect(await screen.findByText(copy.empty)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: copy.general })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: copy.one })).toBeNull()
        await act(async () => {
          await fixture.publish([], { unread: 2, mentions: 2 })
        })
        expect(
          screen.getByRole('link', { name: `${copy.general}, ${copy.unread}, 2 mentions` })
        ).toBeInTheDocument()
        await act(async () => {
          await fixture.publish([], { unread: 1, mentions: 1 })
        })
        expect(
          screen.getByRole('link', { name: `${copy.general}, ${copy.unread}, 1 mention` })
        ).toBeInTheDocument()
        await act(async () => {
          await fixture.publish([], { unread: 0, mentions: 0 })
        })
        expect(screen.getByRole('link', { name: copy.general })).toBeInTheDocument()
        await act(async () => {
          store.stop('signed-out')
        })
        expect(screen.getByText(copy.expired)).toBeInTheDocument()
        await userEvent.setup().click(screen.getByRole('button', { name: copy.reconnect }))
        expect(reconnect).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => {
          mounted?.unmount()
          fixture.stop()
        })
      }
    }
  )

  it.each(MESSAGE_LANGUAGES)(
    'resolves %s generated plural categories without manufacturing huge timelines',
    async (language) => {
      await i18n.changeLanguage(language)
      for (const count of [0, 1, 2, 1_000_000]) {
        const singular = language === 'fr' ? count <= 1 : count === 1
        expect(i18n.t('console.workspace.thread.count-replies', { count })).toBe(
          `${count} ${language === 'fr' ? (singular ? 'réponse' : 'réponses') : singular ? 'reply' : 'replies'}`
        )
        expect(i18n.t('console.workspace.channel.count-mentions', { count })).toBe(
          `${count} ${singular ? 'mention' : 'mentions'}`
        )
      }
    }
  )

  it('keeps draft, reply/thread targets and failed retry identity on one mounted store when language changes', async () => {
    await i18n.changeLanguage('fr')
    const fixture = snapshotFixture([
      snapshotMessage('$root', SNAPSHOT_BODY),
      snapshotThreadReply('$reply1', 'Existing thread'),
    ])
    const { store } = fixture
    let mounted: ReturnType<typeof render> | undefined
    let sending: Promise<unknown> | undefined
    const user = userEvent.setup()
    try {
      await fixture.start()
      mounted = render(
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={SNAPSHOT_WORKSPACE}
          channelId={GENERAL}
          store={store}
        />
      )
      await act(async () => {
        fixture.holdNextSend()
        sending = store
          .send(SNAPSHOT_ROOM, 'Failed unchanged {body}')
          .catch((error: unknown) => error)
        await fixture.finishSend(403, { errcode: 'M_FORBIDDEN', error: 'Controlled send failure' })
        await sending
      })
      const failed = store.getTimeline(SNAPSHOT_ROOM).at(-1)!
      expect(screen.getByText('Échec de l’envoi')).toBeInTheDocument()
      const log = screen.getByRole('log', { name: 'Messages de général' })
      const root = within(log).getByText(SNAPSHOT_BODY).closest('article')!
      await selectMessageAction(user, root, 'Répondre')
      await selectMessageAction(user, root, 'Ouvrir le fil')
      const composer = screen.getByRole('combobox', { name: 'Message dans #général' })
      const threadInput = screen.getByRole('combobox', { name: 'Répondre au fil' })
      fireEvent.change(composer, { target: { value: 'Reply draft <b>&</b> {raw}' } })
      fireEvent.change(threadInput, { target: { value: 'Thread draft <b>&</b> {raw}' } })
      await act(async () => {
        await i18n.changeLanguage('en')
      })
      expect(screen.getByRole('combobox', { name: 'Message in #general' })).toBe(composer)
      expect(composer).toHaveValue('Reply draft <b>&</b> {raw}')
      expect(screen.getByRole('combobox', { name: 'Reply to thread' })).toBe(threadInput)
      expect(threadInput).toHaveValue('Thread draft <b>&</b> {raw}')
      expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeInTheDocument()
      expect(screen.getByRole('complementary', { name: 'Thread' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(fixture.requests).toHaveLength(2))
      expect(fixture.requests[1]).toEqual(fixture.requests[0])
      expect(fixture.requests[1]!.path).toContain(`/${failed.key}`)
      expect(
        store.getTimeline(SNAPSHOT_ROOM).find((message) => message.key === failed.key)?.body
      ).toBe(failed.body)
      await user.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(
          fixture.requests.some((request) => request.body.body === 'Reply draft <b>&</b> {raw}')
        ).toBe(true)
      )
      expect(
        fixture.requests.find((request) => request.body.body === 'Reply draft <b>&</b> {raw}')!
          .body['m.relates_to']
      ).toEqual({ 'm.in_reply_to': { event_id: '$root' } })
      const panel = screen.getByRole('complementary', { name: 'Thread' })
      await user.click(within(panel).getByRole('button', { name: 'Reply' }))
      await waitFor(() =>
        expect(
          fixture.requests.some((request) => request.body.body === 'Thread draft <b>&</b> {raw}')
        ).toBe(true)
      )
      expect(
        fixture.requests.find((request) => request.body.body === 'Thread draft <b>&</b> {raw}')!
          .body['m.relates_to']
      ).toEqual({
        rel_type: 'm.thread',
        event_id: '$root',
        is_falling_back: true,
        'm.in_reply_to': { event_id: '$root' },
      })
    } finally {
      await act(async () => {
        await fixture.releaseHeldSend()
        await sending
        mounted?.unmount()
        fixture.stop()
      })
    }
  })
})

const AUDIO_ROOM_WORKSPACE: Workspace = {
  ...SNAPSHOT_WORKSPACE,
  categories: [],
  uncategorised_channels: [
    {
      ...SNAPSHOT_WORKSPACE.categories[0]!.channels[0]!,
      id: SNAPSHOT_CHANNEL,
      kind: 'audio',
      template_key: null,
      name: 'Point quotidien',
    },
  ],
}

const AUDIO_ROOM_INITIAL_STATE: SnapshotEvent[] = [
  {
    ...snapshotMessage('$audio-policy', ''),
    type: 'io.kodera.room.policy',
    state_key: '',
    content: { kind: 'audio' },
  },
  {
    ...snapshotMessage('$audio-occupancy', ''),
    type: 'io.kodera.room.occupancy',
    state_key: '',
    content: {
      version: 1,
      at_ms: SNAPSHOT_TIME,
      participants: [
        { user_id: SNAPSHOT_ALICE, devices: 1, screen_share: true },
        { user_id: SNAPSHOT_ME, devices: 1, screen_share: false },
      ],
    },
  },
]

describe('audio room catalogue integration', () => {
  it('localizes the rendered live audio room join and occupancy in English', async () => {
    await i18n.changeLanguage('en')
    const fixture = snapshotFixture([], { unread: 0, mentions: 0 }, AUDIO_ROOM_INITIAL_STATE)
    const call = makeFakeCall()
    let mounted: ReturnType<typeof render> | undefined
    let parentRenders = 0
    function Parent() {
      parentRenders++
      return (
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={AUDIO_ROOM_WORKSPACE}
          channelId={undefined}
          store={fixture.store}
          call={call}
        />
      )
    }
    try {
      await fixture.start()
      const audioRoom = fixture.store
        .getSnapshot()
        .rooms.find((room) => room.roomId === SNAPSHOT_ROOM)
      expect(audioRoom?.kind).toBe('audio')
      expect(audioRoom?.occupancy).toEqual({
        participants: [SNAPSHOT_ALICE, SNAPSHOT_ME],
        screenShare: [SNAPSHOT_ALICE],
      })
      mounted = render(<Parent />)
      const join = screen.getByText('Point quotidien').closest('button')!
      expect(join).not.toBeNull()
      expect(join.querySelector('[data-occupancy]')).not.toBeNull()
      const list = join.closest('li')!.querySelector('ul')!
      expect(list).not.toBeNull()
      expect(within(list).getAllByRole('listitem')).toHaveLength(2)
      expect(list.querySelector('[data-sharing]')).not.toBeNull()
      expect(parentRenders).toBe(1)
      expect(call.join).not.toHaveBeenCalled()
      expect(join).toHaveAccessibleName('Join Point quotidien, 2 people')
    } finally {
      await act(async () => {
        mounted?.unmount()
        fixture.stop()
      })
    }
  })
})

const ROOM_AUDIO_COPY = {
  fr: {
    join: 'Rejoindre',
    empty: 'vide',
    person: 'personne',
    people: 'personnes',
    in: 'Dans',
    sharing: 'partage son écran',
    oneOther: 'Afficher 1 autre personne',
    twoOthers: 'Afficher 2 autres personnes',
    dock: 'Appel en cours',
    connecting: 'Connexion…',
    connected: 'Connecté',
    reconnecting: 'Reconnexion…',
    listening: 'Connecté · écoute seule',
    listenOnly: 'écoute seule',
    mute: 'Couper le micro',
    unmute: 'Réactiver le micro',
    deafen: 'Couper le son',
    undeafen: 'Réactiver le son',
    leave: 'Quitter',
    blocked: 'Votre navigateur retient le son de l’appel.',
    start: 'Activer le son',
    unavailable: 'L’audio est indisponible pour le moment. Réessayez dans un instant.',
    forbidden: 'Vous n’avez plus accès à ce salon.',
    retry: 'Réessayer',
    dismiss: 'Fermer',
    preparing: 'En préparation',
    archived: 'Archivé',
    arriving: 'Vos salons arrivent…',
  },
  en: {
    join: 'Join',
    empty: 'empty',
    person: 'person',
    people: 'people',
    in: 'In',
    sharing: 'sharing their screen',
    oneOther: 'Show 1 other person',
    twoOthers: 'Show 2 other people',
    dock: 'Call in progress',
    connecting: 'Connecting…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    listening: 'Connected · listen only',
    listenOnly: 'listen only',
    mute: 'Mute',
    unmute: 'Unmute',
    deafen: 'Deafen',
    undeafen: 'Undeafen',
    leave: 'Leave',
    blocked: "Your browser is holding back the call's sound.",
    start: 'Turn on sound',
    unavailable: 'Audio is unavailable right now. Try again in a moment.',
    forbidden: 'You no longer have access to this room.',
    retry: 'Try again',
    dismiss: 'Close',
    preparing: 'Being prepared',
    archived: 'Archived',
    arriving: 'Your channels are on their way…',
  },
} as const

describe('literal audio room-row catalogues', () => {
  it.each(MESSAGE_LANGUAGES)(
    'uses %s real SDK occupancy, sharing and overflow without changing call actions',
    async (language) => {
      await i18n.changeLanguage(language)
      const copy = ROOM_AUDIO_COPY[language]
      const roomName = 'Salon <b>&</b> {room}'
      const workspace: Workspace = {
        ...AUDIO_ROOM_WORKSPACE,
        uncategorised_channels: AUDIO_ROOM_WORKSPACE.uncategorised_channels.map((channel) => ({
          ...channel,
          name: roomName,
        })),
      }
      const fixture = snapshotFixture([], { unread: 0, mentions: 0 }, [
        AUDIO_ROOM_INITIAL_STATE[0]!,
        {
          ...AUDIO_ROOM_INITIAL_STATE[1]!,
          content: { version: 1, participants: [], at_ms: SNAPSHOT_TIME },
        },
      ])
      const call = makeFakeCall()
      const user = userEvent.setup()
      let mounted: ReturnType<typeof render> | undefined
      try {
        await fixture.start()
        mounted = render(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={workspace}
            channelId={undefined}
            store={fixture.store}
            call={call}
          />
        )
        const join = screen.getByText(roomName).closest('button')!
        expect(join).toHaveAccessibleName(`${copy.join} ${roomName}, ${copy.empty}`)
        expect(join.closest('li')!.querySelector('ul')).toBeNull()
        expect(screen.getByText(roomName).querySelector('b')).toBeNull()
        for (const count of [1, 2, 6, 7]) {
          const participants = Array.from({ length: count }, (_, index) => ({
            user_id:
              index === 0
                ? '@eve.<img>-{tag}:matrix.acme.kodera.io'
                : `@person${index}:matrix.acme.kodera.io`,
            devices: 1,
            screen_share: index === 0,
          }))
          await act(async () => {
            await fixture.publishState([
              {
                ...snapshotMessage(`$audio-count-${count}`, ''),
                type: 'io.kodera.room.occupancy',
                state_key: '',
                content: { version: 1, participants, at_ms: SNAPSHOT_TIME + count },
              },
            ])
          })
          expect(fixture.store.getSnapshot().rooms[0]?.occupancy?.participants).toEqual(
            participants.map((person) => person.user_id)
          )
          expect(join).toHaveAccessibleName(
            `${copy.join} ${roomName}, ${count} ${count === 1 ? copy.person : copy.people}`
          )
          const list = screen.getByRole('list', { name: `${copy.in} ${roomName}` })
          expect(within(list).getByText(copy.sharing)).toBeInTheDocument()
          const name = within(list).getByText('Eve <img> {tag}')
          expect(name.textContent).toBe('Eve <img> {tag}')
          expect(name.querySelector('img')).toBeNull()
          const occupants = Array.from(list.children).filter(
            (node) => node.tagName === 'LI' && node.querySelector('button') === null
          )
          expect(occupants.filter((node) => !node.hasAttribute('hidden'))).toHaveLength(
            Math.min(5, count)
          )
          if (count > 5) {
            const overflow = within(list).getByRole('button', {
              name: count === 6 ? copy.oneOther : copy.twoOthers,
            })
            expect(overflow).toHaveAttribute('aria-expanded', 'false')
            const controlled = overflow
              .getAttribute('aria-controls')!
              .split(' ')
              .map((id) => document.getElementById(id)!)
            expect(controlled).toHaveLength(count - 5)
            expect(
              controlled.every((node) => node.parentElement === list && node.hasAttribute('hidden'))
            ).toBe(true)
            await user.click(overflow)
            expect(overflow).toHaveAttribute('aria-expanded', 'true')
            expect(controlled.every((node) => !node.hasAttribute('hidden'))).toBe(true)
            expect(occupants.filter((node) => !node.hasAttribute('hidden'))).toHaveLength(count)
            await user.click(overflow)
            expect(overflow).toHaveAttribute('aria-expanded', 'false')
            expect(controlled.every((node) => node.hasAttribute('hidden'))).toBe(true)
          }
        }
        await user.click(join)
        expect(call.join).toHaveBeenCalledExactlyOnceWith(SNAPSHOT_ROOM)
        const dock = screen.getByRole('region', { name: copy.dock })
        expect(within(dock).getByText(copy.connecting)).toBeInTheDocument()
        call.set({ status: 'connected', participants: ['@not-in-matrix:matrix.acme.kodera.io'] })
        expect(join).toHaveAccessibleName(
          `${copy.join} ${roomName}, 7 ${copy.people}, ${copy.connected}`
        )
        expect(
          within(screen.getByRole('list', { name: `${copy.in} ${roomName}` })).queryByText(
            'Not In Matrix'
          )
        ).toBeNull()
        expect(fixture.store.getSnapshot().rooms[0]?.occupancy?.participants).toHaveLength(7)
        const mute = within(dock).getByRole('button', { name: copy.mute })
        expect(mute).toHaveAttribute('aria-pressed', 'false')
        await user.click(mute)
        expect(call.setMuted).toHaveBeenCalledExactlyOnceWith(true)
        expect(within(dock).getByRole('button', { name: copy.mute })).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        await user.click(within(dock).getByRole('button', { name: copy.mute }))
        expect(call.setMuted).toHaveBeenNthCalledWith(2, false)
        expect(within(dock).getByRole('button', { name: copy.mute })).toHaveAttribute(
          'aria-pressed',
          'false'
        )
        await user.click(within(dock).getByRole('button', { name: copy.deafen }))
        expect(call.setDeafened).toHaveBeenCalledExactlyOnceWith(true)
        expect(within(dock).getByRole('button', { name: copy.deafen })).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        await user.click(within(dock).getByRole('button', { name: copy.deafen }))
        expect(call.setDeafened).toHaveBeenNthCalledWith(2, false)
        expect(within(dock).getByRole('button', { name: copy.deafen })).toHaveAttribute(
          'aria-pressed',
          'false'
        )
        call.set({ status: 'reconnecting' })
        expect(within(dock).getByText(copy.reconnecting)).toBeInTheDocument()
        call.set({ status: 'connected', listenOnly: true, muted: true, playbackBlocked: true })
        expect(within(dock).getByText(copy.listening.replaceAll('\u00a0', ' '))).toBeInTheDocument()
        expect(join).toHaveAccessibleName(
          `${copy.join} ${roomName}, 7 ${copy.people}, ${copy.connected}, ${copy.listenOnly}`
        )
        expect(screen.getByText(copy.blocked)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: copy.start }))
        expect(call.startAudio).toHaveBeenCalledTimes(1)
        expect(screen.queryByText(copy.blocked)).toBeNull()
        call.set({ status: 'failed', problem: 'unavailable' })
        expect(screen.getByText(copy.unavailable)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: copy.retry }))
        expect(call.join).toHaveBeenCalledTimes(2)
        expect(call.join).toHaveBeenLastCalledWith(SNAPSHOT_ROOM)
        call.set({ status: 'failed', problem: 'forbidden' })
        expect(screen.getByText(copy.forbidden)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: copy.retry })).toBeNull()
        await user.click(screen.getByRole('button', { name: copy.dismiss }))
        expect(call.leave).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('region', { name: copy.dock })).toBeNull()
      } finally {
        await act(async () => {
          mounted?.unmount()
          fixture.stop()
        })
      }
    }
  )

  it.each(MESSAGE_LANGUAGES)(
    'keeps %s unavailable audio rooms disabled with original permission reasons',
    async (language) => {
      await i18n.changeLanguage(language)
      const copy = ROOM_AUDIO_COPY[language]
      for (const reason of ['preparing', 'archived', 'arriving'] as const) {
        const channels = new Map(RESOLVED)
        if (reason === 'preparing') channels.set(STANDUP, { state: 'pending' })
        const rooms = makeFakeStore()
          .getSnapshot()
          .rooms.filter((room) => reason !== 'arriving' || room.roomId !== STANDUP_ROOM)
        const store = makeFakeStore({ rooms: [...rooms], channels })
        const workspace: Workspace = {
          ...WORKSPACE,
          categories: WORKSPACE.categories.map((category) => ({
            ...category,
            channels: category.channels.map((channel) => ({
              ...channel,
              lifecycle:
                reason === 'archived' && channel.id === STANDUP ? 'archived' : channel.lifecycle,
            })),
          })),
        }
        const call = makeFakeCall()
        const mounted = render(
          <EspaceLiveView
            org="acme"
            organisationName="Acme SA"
            workspace={workspace}
            channelId={GENERAL}
            store={store}
            call={call}
          />
        )
        try {
          const join = screen.getByText('Point quotidien').closest('button')!
          expect(join).toBeDisabled()
          expect(join.getAttribute('aria-label')).toContain(copy[reason])
          await userEvent.setup().click(join)
          expect(call.join).not.toHaveBeenCalled()
        } finally {
          mounted.unmount()
        }
      }
    }
  )

  it('preserves the same expanded room and call state across language changes', async () => {
    await i18n.changeLanguage('fr')
    const participants = Array.from({ length: 7 }, (_, index) => ({
      user_id: `@person${index}:matrix.acme.kodera.io`,
      devices: 1,
    }))
    const fixture = snapshotFixture([], { unread: 0, mentions: 0 }, [
      AUDIO_ROOM_INITIAL_STATE[0]!,
      {
        ...AUDIO_ROOM_INITIAL_STATE[1]!,
        content: { version: 1, participants, at_ms: SNAPSHOT_TIME },
      },
    ])
    const call = makeFakeCall()
    const user = userEvent.setup()
    let mounted: ReturnType<typeof render> | undefined
    try {
      await fixture.start()
      mounted = render(
        <EspaceLiveView
          org="acme"
          organisationName="Acme SA"
          workspace={AUDIO_ROOM_WORKSPACE}
          channelId={undefined}
          store={fixture.store}
          call={call}
        />
      )
      const join = screen.getByRole('button', { name: 'Rejoindre Point quotidien, 7 personnes' })
      const overflow = screen.getByRole('button', { name: 'Afficher 2 autres personnes' })
      await user.click(overflow)
      await user.click(join)
      call.set({ status: 'connected', muted: true, deafened: true })
      const before = call.getSnapshot()
      await act(async () => {
        await i18n.changeLanguage('en')
      })
      expect(
        screen.getByRole('button', { name: 'Join Point quotidien, 7 people, Connected' })
      ).toBe(join)
      expect(screen.getByRole('button', { name: 'Show 2 other people' })).toBe(overflow)
      expect(overflow).toHaveAttribute('aria-expanded', 'true')
      const dock = screen.getByRole('region', { name: 'Call in progress' })
      expect(within(dock).getByRole('button', { name: 'Mute' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(within(dock).getByRole('button', { name: 'Deafen' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(call.getSnapshot()).toBe(before)
      expect(call.join).toHaveBeenCalledExactlyOnceWith(SNAPSHOT_ROOM)
      await act(async () => {
        await i18n.changeLanguage('fr')
      })
      expect(
        screen.getByRole('button', { name: 'Rejoindre Point quotidien, 7 personnes, Connecté' })
      ).toBe(join)
      expect(screen.getByRole('button', { name: 'Afficher 2 autres personnes' })).toBe(overflow)
      expect(overflow).toHaveAttribute('aria-expanded', 'true')
      expect(call.getSnapshot()).toBe(before)
    } finally {
      await act(async () => {
        mounted?.unmount()
        fixture.stop()
      })
    }
  })

  it.each(MESSAGE_LANGUAGES)(
    'uses %s generated person and overflow plural categories',
    async (language) => {
      await i18n.changeLanguage(language)
      for (const count of [0, 1, 2, 1_000_000]) {
        const singular = language === 'fr' ? count <= 1 : count === 1
        expect(i18n.t('console.workspace.audio.count-people', { count })).toBe(
          `${count} ${language === 'fr' ? (singular ? 'personne' : 'personnes') : singular ? 'person' : 'people'}`
        )
        expect(i18n.t('console.workspace.audio.action-show-others', { count })).toBe(
          language === 'fr'
            ? `Afficher ${count} ${singular ? 'autre personne' : 'autres personnes'}`
            : `Show ${count} other ${singular ? 'person' : 'people'}`
        )
      }
    }
  )
})

describe('a message with a web address in the timeline (M10)', () => {
  it('draws the address as a link that opens a new tab', () => {
    const store = makeFakeStore({
      timelines: {
        [GENERAL_ROOM]: [
          {
            key: '$link',
            eventId: '$link',
            sender: '@marina.loiseau:matrix.acme.kodera.io',
            body: 'Le plan : https://docs.acme.fr/plan',
            ts: Date.UTC(2026, 10, 4, 9, 0, 0),
            edited: false,
            redacted: false,
            delivery: 'sent',
            replyTo: null,
            reactions: [],
          },
        ],
      },
    })
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={store}
      />
    )
    const log = screen.getByRole('log', { name: 'Messages de général' })
    const link = within(log).getByRole('link', { name: 'https://docs.acme.fr/plan' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('the quick reactions', () => {
  const props = {
    org: 'acme',
    organisationName: 'Acme SA',
    workspace: WORKSPACE,
    channelId: GENERAL,
  }

  it('offer eight fixed reactions beside a message; picking one reacts and closes the palette', async () => {
    const user = userEvent.setup()
    const store = makeFakeStore()
    render(<EspaceLiveView {...props} store={store} />)
    const log = screen.getByRole('log', { name: 'Messages de général' })
    const first = within(log).getAllByRole('article')[0]!
    const trigger = within(first).getByRole('button', { name: 'Ajouter une réaction' })
    await user.click(trigger)
    const palette = screen.getByRole('dialog', { name: 'Réactions rapides' })
    expect(
      within(palette)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏', '😮'])
    await user.click(within(palette).getByRole('button', { name: 'Réagir avec 🎉' }))
    expect(store.toggleReaction).toHaveBeenCalledTimes(1)
    expect(store.toggleReaction).toHaveBeenCalledWith(GENERAL_ROOM, '$m1', '🎉')
    expect(screen.queryByRole('dialog', { name: 'Réactions rapides' })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('show the ones the viewer already made as pressed, and picking one again takes it back', async () => {
    const user = userEvent.setup()
    const base = makeFakeStore()
    const store = makeFakeStore({
      timelines: {
        [GENERAL_ROOM]: base.getTimeline(GENERAL_ROOM).map((message) =>
          message.eventId === '$m1'
            ? {
                ...message,
                reactions: [
                  { key: '👍', count: 2, mine: false },
                  { key: '❤️', count: 1, mine: true },
                ],
              }
            : message
        ),
      },
    })
    render(<EspaceLiveView {...props} store={store} />)
    const log = screen.getByRole('log', { name: 'Messages de général' })
    const first = within(log).getAllByRole('article')[0]!
    await user.click(within(first).getByRole('button', { name: 'Ajouter une réaction' }))
    const palette = screen.getByRole('dialog', { name: 'Réactions rapides' })
    const pressed = within(palette)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
    expect(pressed.map((button) => button.textContent)).toEqual(['❤️'])
    await user.click(within(palette).getByRole('button', { name: 'Réagir avec ❤️' }))
    expect(store.toggleReaction).toHaveBeenCalledWith(GENERAL_ROOM, '$m1', '❤️')
  })

  it('react to a thread reply too, and speak English', async () => {
    await i18n.changeLanguage('en')
    const user = userEvent.setup()
    const store = makeFakeStore()
    render(<EspaceLiveView {...props} store={store} />)
    await user.click(screen.getByRole('button', { name: '1 reply' }))
    const thread = screen.getByRole('complementary', { name: 'Thread' })
    const reply = within(thread)
      .getAllByRole('article')
      .find((article) => article.textContent?.includes('Je partage les notes'))!
    await user.click(within(reply).getByRole('button', { name: 'Add a reaction' }))
    const palette = screen.getByRole('dialog', { name: 'Quick reactions' })
    await user.click(within(palette).getByRole('button', { name: 'React with 👀' }))
    expect(store.toggleReaction).toHaveBeenCalledWith(GENERAL_ROOM, '$t1', '👀')
  })
})

describe("a channel's header says who is in it (G10)", () => {
  const ALICE = '@marina.loiseau:matrix.acme.kodera.io'
  const BOB = '@bob.dupont:matrix.acme.kodera.io'
  function withMembers(
    store: ReturnType<typeof makeFakeStore>,
    joined: number | undefined,
    faces: RoomSummary['faces'],
    roomId = GENERAL_ROOM
  ) {
    store.setRooms(
      store.getSnapshot().rooms.map((room) =>
        room.roomId === roomId
          ? {
              ...room,
              ...(joined === undefined ? {} : { joined }),
              ...(faces === undefined ? {} : { faces }),
            }
          : room
      )
    )
  }
  function show(store: EspaceStoreLike, channelId = GENERAL) {
    return render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={channelId}
        store={store}
      />
    )
  }
  it('shows the welcome block at the loaded start of a populated channel', () => {
    const store = makeFakeStore()
    show({ ...store, getHistory: () => 'start' })
    expect(
      screen.getByRole('heading', { level: 2, name: 'Bienvenue dans #général' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Aucun message dans #général.')).toBeNull()
    expect(screen.getByRole('log')).toContainElement(
      screen.getByRole('heading', { level: 2, name: 'Bienvenue dans #général' })
    )
  })

  it('shows the viewer in a solo room roster without offering a self mention', async () => {
    const store = makeFakeStore()
    show({
      ...store,
      getMembers: () => [],
      getRoster: () => [{ userId: store.getUserId(), name: 'My name' }],
    })
    await userEvent.click(screen.getByRole('button', { name: 'Membres' }))
    const panel = screen.getByRole('complementary', { name: 'Membres' })
    expect(within(panel).getByRole('img', { name: 'My name' })).toBeInTheDocument()
  })

  it('opens role groups with accessible presence and stacks the panel on phones, then restores trigger focus', async () => {
    const store = makeFakeStore()
    const alice = { userId: ALICE, name: 'Marina Loiseau' }
    const bob = { userId: BOB, name: 'Bob Dupont' }
    const loadMembers = vi.fn()
    withMembers(store, 3, [alice, bob])
    show({
      ...store,
      getMembers: () => [alice, bob],
      loadMembers,
      isOnline: (id) => id === ALICE,
      getMemberRole: (_room, id) => (id === ALICE ? 'admin' : 'member'),
    })
    const trigger = screen.getByRole('button', { name: 'Membres' })
    expect(loadMembers).not.toHaveBeenCalled()
    await userEvent.click(trigger)
    expect(loadMembers).toHaveBeenCalledWith(GENERAL_ROOM)
    const panel = screen.getByRole('complementary', { name: 'Membres' })
    expect(panel).toHaveClass('narrow:w-full')
    expect(panel.parentElement).toHaveClass('narrow:flex-col')
    expect(within(panel).getByRole('region', { name: 'Administration' })).toHaveTextContent(
      'Marina Loiseau'
    )
    expect(within(panel).getByRole('img', { name: 'Marina Loiseau, en ligne' })).toBeInTheDocument()
    expect(
      within(panel)
        .getByRole('img', { name: 'Marina Loiseau, en ligne' })
        .querySelector('[data-online]')
    ).toHaveClass('ring-c-sunken')
    expect(within(panel).getByRole('img', { name: 'Bob Dupont' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Message dans #général' })).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Fermer' }))
    expect(screen.queryByRole('complementary', { name: 'Membres' })).toBeNull()
    expect(trigger).toHaveFocus()
  })

  const header = () => screen.getByRole('heading', { level: 1 }).closest('header')!
  const line = () => header().querySelector('p')!
  /** What a screen reader reads of an element: its text without the hidden parts. */
  function readText(element: Element) {
    const copy = element.cloneNode(true) as Element
    for (const hidden of Array.from(copy.querySelectorAll('[aria-hidden="true"]'))) hidden.remove()
    return (copy.textContent ?? '').replace(/\s+/gu, ' ').trim()
  }

  it('reads « topic · 18 membres », the « · » drawn but not read, beside faces that are not read', () => {
    const store = makeFakeStore()
    withMembers(store, 18, [
      { userId: ALICE, name: 'Marina Loiseau' },
      // A display name the id does not give: the face is drawn from the name, not the id.
      { userId: BOB, name: 'Robert Dupont' },
    ])
    show(store)
    expect(line().textContent).toBe('Discussions de toute l’équipe · 18 membres')
    // The words stay apart once the separator is left out.
    expect(readText(line())).toBe('Discussions de toute l’équipe 18 membres')
    const stack = within(header()).getByText('ML').parentElement!
    expect(stack.textContent).toBe('MLRD')
    // Beside the count it illustrates, on its line: not at the header's far end.
    expect(stack.previousElementSibling).toBe(line())
    expect(stack.parentElement).toHaveClass('flex', 'items-center', 'gap-2')
    for (const face of Array.from(stack.children)) expect(face).toHaveClass('h-5', 'w-5')
    // The count says it in words: the faces are not read, so it is not said twice.
    expect(stack).not.toHaveAttribute('aria-hidden')
    for (const face of Array.from(stack.children)) {
      expect(face).toHaveClass('ring-2', 'ring-c-surface')
    }
    // Separate the faces so each member's initials stay readable.
    expect(stack).toHaveClass('gap-1')
    expect(stack).not.toHaveClass('-space-x-1')
    // A narrow screen drops the faces and keeps the count.
    expect(stack).toHaveClass('narrow:hidden')
    for (
      let node: Element | null = line();
      node !== null && node !== header();
      node = node.parentElement
    ) {
      expect(node).not.toHaveClass('narrow:hidden')
    }
  })

  it('says « 1 membre » for one, with no faces when no one else is shown', () => {
    const store = makeFakeStore()
    withMembers(store, 1, [])
    show(store)
    expect(line().textContent).toBe('Discussions de toute l’équipe · 1 membre')
    // Nothing but the heading and the line: no stack beside it.
    expect(line().nextElementSibling).toBeNull()
    expect(line().parentElement?.nextElementSibling ?? null).toBeNull()
  })

  it('draws a person glyph for someone with no name, never a character of their id', () => {
    // Staging's #général, once its faces showed: « 9 », « 9 » and « F », from ids no one reads.
    const store = makeFakeStore()
    withMembers(store, 4, [
      { userId: '@9f3c2b1a-0d4e-4c55-9a77-1b2c3d4e5f60:matrix.acme.kodera.io' },
      { userId: ALICE, name: 'Marina Loiseau' },
    ])
    show(store)
    const stack = line().nextElementSibling!
    const [unnamed, named] = Array.from(stack.children)
    expect(unnamed!.textContent).toBe('')
    expect(unnamed!.querySelector('svg')).not.toBeNull()
    expect(named!.textContent).toBe('ML')
    expect(named!.querySelector('svg')).toBeNull()
  })

  it('shows the count alone where the channel has no topic', () => {
    const store = makeFakeStore()
    withMembers(store, 4, undefined, WELCOME_ROOM)
    show(store, WELCOME)
    expect(line().textContent).toBe('4 membres')
  })

  it('asks for the member list when it shows fewer faces than the people it counts', () => {
    // Staging's #général: « 4 membres », and only the member has written.
    const store = Object.assign(makeFakeStore(), { loadMembers: vi.fn() })
    withMembers(store, 4, [])
    show(store)
    expect(store.loadMembers).toHaveBeenCalledWith(GENERAL_ROOM)
  })

  it('asks for no member list when the faces already show everyone they can', () => {
    for (const [joined, faces] of [
      [1, []],
      [3, [{ userId: ALICE }, { userId: BOB }]],
      [18, [{ userId: ALICE }, { userId: BOB }, { userId: '@carol:matrix.acme.kodera.io' }]],
    ] as const) {
      const store = Object.assign(makeFakeStore(), { loadMembers: vi.fn() })
      withMembers(store, joined, faces)
      const { unmount } = show(store)
      expect(store.loadMembers).not.toHaveBeenCalled()
      unmount()
    }
    // A room the store does not count, as an audio room is not, asks nothing either.
    const uncounted = Object.assign(makeFakeStore(), { loadMembers: vi.fn() })
    withMembers(uncounted, undefined, [])
    show(uncounted)
    expect(uncounted.loadMembers).not.toHaveBeenCalled()
  })

  it('says nothing of the members, and shows no faces, for a room the store does not count', () => {
    const store = makeFakeStore()
    withMembers(store, undefined, [{ userId: ALICE, name: 'Marina Loiseau' }])
    show(store)
    expect(line().textContent).toBe('Discussions de toute l’équipe')
    expect(within(header()).queryByText('ML')).toBeNull()
  })
})

describe('the member hears themselves in an audio room (W2 audio feedback)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  async function inCall(call: ReturnType<typeof makeFakeCall>) {
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
        call={call}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    call.set({ status: 'connected', participants: ['@me:matrix.acme.kodera.io'] })
    return screen.getByRole('region', { name: 'Appel en cours' })
  }
  const fillOf = (dock: HTMLElement) => dock.querySelector<HTMLElement>('[data-mic-meter] > span')!

  it("fills the dock's meter from the member's own level, alone in the room, and empties it muted", async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    let level = 1
    const call = Object.assign(makeFakeCall(), { micLevel: vi.fn(() => level) })
    const dock = await inCall(call)
    const meter = dock.querySelector('[data-mic-meter]')!
    // Decoration: the mute toggle says whether the member is heard.
    expect(meter).toHaveAttribute('aria-hidden', 'true')
    act(() => void vi.advanceTimersByTime(16))
    expect(fillOf(dock).style.transform).toBe('scaleX(1)')
    level = 0
    act(() => void vi.advanceTimersByTime(16))
    expect(fillOf(dock).style.transform).toBe('scaleX(0)')

    level = 1
    call.set({ muted: true })
    call.micLevel.mockClear()
    act(() => void vi.advanceTimersByTime(160))
    expect(call.micLevel).not.toHaveBeenCalled()
    expect(fillOf(dock).style.transform).toBe('scaleX(0)')
  })

  const ALICE = '@marina.loiseau:matrix.acme.kodera.io'
  const BOB = '@bob.dupont:matrix.acme.kodera.io'
  const faceOf = (name: string) =>
    screen
      .getByRole('list', { name: 'Dans Point quotidien' })
      .querySelector(`[aria-label="${name}"]`)!

  it("rings the member's own face from their microphone, alone or not, and the others' as the call says", async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    let level = 1
    const call = Object.assign(makeFakeCall(), { micLevel: vi.fn(() => level) })
    await inCall(call)
    // Alice is the member; the call's speakers have not named her (no one else hears her).
    call.set({ participants: [ALICE, BOB], self: ALICE, speakers: [] })
    act(() => void vi.advanceTimersByTime(16))
    expect(faceOf('Marina Loiseau')).toHaveAttribute('data-speaking', '')
    expect(faceOf('Bob Dupont')).not.toHaveAttribute('data-speaking')

    // Bob speaks, as the call says; Alice falls quiet past the hold.
    level = 0
    call.set({ speakers: [BOB, ALICE] })
    act(() => void vi.advanceTimersByTime(400))
    expect(faceOf('Bob Dupont')).toHaveAttribute('data-speaking', '')
    // Her own ring is her microphone's, not the server's word.
    expect(faceOf('Marina Loiseau')).not.toHaveAttribute('data-speaking')
    // Reconnecting, the call's speakers are stale: no one is ringed until it is through again.
    call.set({ status: 'reconnecting' })
    expect(faceOf('Bob Dupont')).not.toHaveAttribute('data-speaking')
    call.set({ status: 'connected' })
    expect(faceOf('Bob Dupont')).toHaveAttribute('data-speaking', '')

    // Muted: no ring of hers, whatever the level.
    level = 1
    call.set({ muted: true })
    act(() => void vi.advanceTimersByTime(160))
    expect(faceOf('Marina Loiseau')).not.toHaveAttribute('data-speaking')

    // She speaks again, then leaves the room: the ring goes with her call, not with the row.
    call.set({ muted: false })
    act(() => void vi.advanceTimersByTime(16))
    expect(faceOf('Marina Loiseau')).toHaveAttribute('data-speaking')
    call.set({ status: 'idle', roomId: null, self: null, speakers: [] })
    act(() => void vi.advanceTimersByTime(160))
    expect(faceOf('Marina Loiseau')).not.toHaveAttribute('data-speaking')
    expect(faceOf('Bob Dupont')).not.toHaveAttribute('data-speaking')
  })

  it('rings no one in a room the member is not in', async () => {
    const call = makeFakeCall()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
        call={call}
      />
    )
    call.set({ status: 'connected', roomId: '!other:matrix.acme.kodera.io', speakers: [BOB] })
    expect(faceOf('Bob Dupont')).not.toHaveAttribute('data-speaking')
  })

  it('reads no level while the call is still connecting, or listen-only', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const call = Object.assign(makeFakeCall(), { micLevel: vi.fn(() => 1) })
    await inCall(call)
    call.set({ status: 'connecting' })
    call.micLevel.mockClear()
    act(() => void vi.advanceTimersByTime(160))
    expect(call.micLevel).not.toHaveBeenCalled()
    call.set({ status: 'connected', listenOnly: true })
    act(() => void vi.advanceTimersByTime(160))
    expect(call.micLevel).not.toHaveBeenCalled()
  })

  it('draws no meter for a call that reads no level', async () => {
    const dock = await inCall(makeFakeCall())
    expect(dock.querySelector('[data-mic-meter]')).toBeNull()
  })

  it("opens « Réglages audio » from the dock, for a call that can choose the member's devices", async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const choice = { input: null, output: null }
    const call = Object.assign(makeFakeCall(), {
      micLevel: vi.fn(() => 1),
      getDeviceChoice: vi.fn(() => choice),
      chooseInput: vi.fn(async () => undefined),
      chooseOutput: vi.fn(async () => undefined),
    })
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { enumerateDevices: async () => [] } })
    const dock = await inCall(call)
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    await user.click(within(dock).getByRole('button', { name: 'Réglages audio' }))
    const panel = await screen.findByRole('dialog', { name: 'Réglages audio' })
    // Its meter is drawn from the same level as the dock's.
    act(() => void vi.advanceTimersByTime(16))
    const fill = panel.querySelector<HTMLElement>('[data-panel-meter] > span')!
    expect(fill.style.transform).toBe('scaleX(1)')
    expect(within(panel).getByRole('combobox', { name: 'Micro' })).toBeInTheDocument()
  })

  it('says the chosen microphone is not plugged in, in the panel', async () => {
    const call = Object.assign(makeFakeCall(), {
      getDeviceChoice: vi.fn(() => ({ input: 'unplugged', output: null })),
      chooseInput: vi.fn(async () => undefined),
      chooseOutput: vi.fn(async () => undefined),
    })
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { enumerateDevices: async () => [] } })
    const dock = await inCall(call)
    call.set({ inputMissing: true })
    await userEvent.setup().click(within(dock).getByRole('button', { name: 'Réglages audio' }))
    const panel = await screen.findByRole('dialog', { name: 'Réglages audio' })
    expect(
      within(panel).getByText('Le micro choisi n’est pas branché : celui par défaut est utilisé.')
    ).toBeInTheDocument()
  })

  it('offers no settings for a call that cannot choose devices', async () => {
    const dock = await inCall(makeFakeCall())
    expect(within(dock).queryByRole('button', { name: 'Réglages audio' })).toBeNull()
  })

  it.each([
    ['microphone-denied', 'Le micro est bloqué pour ce site ou par votre système.'],
    ['microphone-missing', 'Aucun micro n’est détecté. Branchez-en un, puis réactivez-le.'],
    ['microphone-in-use', 'Votre micro est utilisé par une autre application.'],
    ['microphone', 'Votre micro est inaccessible.'],
  ] as const)('says why the microphone is off (%s)', async (problem, copy) => {
    const call = makeFakeCall()
    await inCall(call)
    call.set({ muted: true, problem })
    expect(screen.getByText((text) => text.startsWith(copy))).toBeInTheDocument()
  })
})

describe('Matrix channel invitations', () => {
  it('invites from the community channel header and returns focus on Escape', async () => {
    const user = userEvent.setup()
    const workspace = communityWorkspace()
    const store = createLocalWorkspaceStore(workspace, 'community')
    const channel = workspace.categories
      .flatMap((category) => category.channels)
      .find((channel) => channel.name === 'partner-dinum')!
    const invite = vi.spyOn(store, 'inviteToRoom')
    render(
      <EspaceLiveView
        org="community"
        organisationName="Community"
        workspace={workspace}
        channelId={channel.id}
        store={store}
      />
    )
    const trigger = screen.getByTestId('espace-channel-invite-btn')
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Inviter au salon (Matrix)' })
    expect(within(dialog).getByText('#partner-dinum:demo.invalid')).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'https://matrix.to/#/%23partner-dinum%3Ademo.invalid?via=community.kodera.io'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'matrix:r/partner-dinum:demo.invalid?action=join&via=community.kodera.io'
      )
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(`${window.location.origin}/community/workspace/${channel.id}`)
    ).toBeInTheDocument()
    const field = within(dialog).getByRole('textbox', { name: 'Identifiant Matrix' })
    expect(field).toHaveFocus()
    for (const invalid of ['marie:dinum.gouv.fr', '@marie']) {
      await user.clear(field)
      await user.type(field, invalid)
      await user.click(within(dialog).getByTestId('espace-channel-invite-submit'))
      expect(field).toHaveAttribute('aria-invalid', 'true')
      expect(invite).not.toHaveBeenCalled()
    }
    await user.clear(field)
    await user.type(field, '@marie:dinum.gouv.fr')
    await user.click(within(dialog).getByTestId('espace-channel-invite-submit'))
    expect(invite).toHaveBeenCalledWith(`!${channel.id}:demo.invalid`, '@marie:dinum.gouv.fr')
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'Invitation Matrix envoyée à @marie:dinum.gouv.fr'
    )
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('hides the invitation action for unresolved rooms and focused documents', () => {
    const store = makeFakeStore({ channels: new Map() })
    const props = {
      org: 'acme',
      organisationName: 'Acme',
      workspace: WORKSPACE,
      channelId: GENERAL,
    }
    const view = render(<EspaceLiveView {...props} store={store} />)
    expect(screen.queryByTestId('espace-channel-invite-btn')).not.toBeInTheDocument()
    view.rerender(<EspaceLiveView {...props} store={makeFakeStore()} focusedDocs />)
    expect(screen.queryByTestId('espace-channel-invite-btn')).not.toBeInTheDocument()
  })
})

function useMobileViewport() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      media,
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )
}

describe('mobile channel chooser', () => {
  it('starts with the conversation and closes the bounded chooser after selecting a channel', async () => {
    useMobileViewport()
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    expect(screen.getByRole('heading', { level: 1, name: 'général' })).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Messages de général' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Salons' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salons' }))
    const chooser = screen.getByRole('dialog', { name: 'Salons' })
    expect(within(chooser).getByRole('navigation', { name: 'Salons' })).toHaveClass(
      'narrow:max-h-[calc(100vh*3/4)]'
    )
    await user.click(within(chooser).getByRole('link', { name: /bienvenue/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const heading = screen.getByRole('heading', { level: 1, name: 'bienvenue' })
    await waitFor(() => expect(heading).toHaveFocus())
  })

  it('returns focus to the compact trigger when Escape dismisses the chooser', async () => {
    useMobileViewport()
    const user = userEvent.setup()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
      />
    )
    const trigger = screen.getByRole('button', { name: 'Salons' })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('keeps one accessible audio dock after choosing a voice room', async () => {
    useMobileViewport()
    const user = userEvent.setup()
    const call = makeFakeCall()
    render(
      <EspaceLiveView
        org="acme"
        organisationName="Acme SA"
        workspace={WORKSPACE}
        channelId={GENERAL}
        store={makeFakeStore()}
        call={call}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Salons' }))
    await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(call.join).toHaveBeenCalledWith(STANDUP_ROOM)
    expect(screen.getAllByRole('region', { name: 'Appel en cours' })).toHaveLength(1)
    const dock = screen.getByRole('region', { name: 'Appel en cours' })
    call.set({ status: 'connected' })
    await user.click(within(dock).getByRole('button', { name: 'Couper le micro' }))
    expect(call.setMuted).toHaveBeenCalledWith(true)
    await user.click(within(dock).getByRole('button', { name: 'Quitter' }))
    expect(call.leave).toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Appel en cours' })).not.toBeInTheDocument()
  })
})

it('keeps the same call and document subtree across canvas navigation', async () => {
  const user = userEvent.setup()
  const store = makeFakeStore()
  const call = makeFakeCall()
  const props = {
    org: 'acme',
    organisationName: 'Acme SA',
    workspace: WORKSPACE,
    channelId: GENERAL,
    store,
    call,
    docsCanvasSlot: <input aria-label="Draft" defaultValue="Review" />,
  }
  const view = render(<EspaceLiveView {...props} activeCanvasMode="chat" />)
  await user.click(screen.getByRole('button', { name: 'Rejoindre Point quotidien, 2 personnes' }))
  call.set({ status: 'connected' })
  const dock = screen.getByRole('region', { name: 'Appel en cours' })
  expect(dock.closest('nav')).toBeNull()
  view.rerender(<EspaceLiveView {...props} activeCanvasMode="docs" />)
  const draft = screen.getByRole('textbox', { name: 'Draft' })
  await user.type(draft, ' retained')
  view.rerender(<EspaceLiveView {...props} activeCanvasMode="chat" />)
  view.rerender(<EspaceLiveView {...props} activeCanvasMode="docs" />)
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
  expect(draft).toHaveValue('Review retained')
  expect(screen.getByRole('region', { name: 'Appel en cours' })).toBe(dock)
  expect(call.join).toHaveBeenCalledTimes(1)
  expect(call.leave).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Couper le micro' }))
  expect(call.setMuted).toHaveBeenCalledWith(true)
})
