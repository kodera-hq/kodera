// Mentions (V1 bar M8): « @ » in a composer offers the channel's members, the chosen name goes
// into the text, the message carries the named members in `m.mentions`, and a message that names
// the viewer is marked as one.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { soundEngine } from '../sounds/SoundEngine'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView } from './EspaceLiveView'
import type { EspaceStoreLike } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot, MemberView } from './matrix/store'
import type { MessageView } from './matrix/timeline'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@marina.loiseau:matrix.acme.kodera.io'
const BOB = '@bob.dupont:matrix.acme.kodera.io'
const ELODIE = '@elodie.roux:matrix.acme.kodera.io'

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
          topic: '',
          lifecycle: 'active',
          room_state: 'ready',
        },
      ],
    },
  ],
  uncategorised_channels: [],
}

function message(eventId: string, sender: string, body: string, extra: Partial<MessageView> = {}) {
  return {
    key: eventId,
    eventId,
    sender,
    body,
    ts: Date.UTC(2026, 10, 4, 9, 0),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
    ...extra,
  } satisfies MessageView
}

const MEMBERS: readonly MemberView[] = [
  { userId: ALICE, name: 'Marina Loiseau' },
  { userId: BOB, name: 'Bob Dupont' },
  { userId: ELODIE, name: 'Élodie Roux' },
]

function makeStore({
  timeline = [message('$m1', ALICE, 'Bonjour !')],
  threads = {},
  members = MEMBERS,
}: {
  timeline?: readonly MessageView[]
  threads?: Record<string, readonly MessageView[]>
  members?: readonly MemberView[]
} = {}) {
  const snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map<string, ChannelRoom>([[GENERAL, { state: 'resolved', roomId: ROOM }]]),
    rooms: [
      {
        roomId: ROOM,
        name: 'general',
        alias: null,
        kind: 'text',
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
    getUserId: () => ME,
    getTimeline: (roomId: string) => (roomId === ROOM ? timeline : []),
    getThread: (_roomId: string, root: string) => threads[root] ?? [],
    getMembers: (roomId: string) => (roomId === ROOM ? members : []),
    loadMembers: vi.fn<(roomId: string) => void>(),
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  } satisfies EspaceStoreLike
}

function renderView(store: EspaceStoreLike) {
  render(
    <EspaceLiveView
      org="acme"
      organisationName="Acme SA"
      workspace={WORKSPACE}
      channelId={GENERAL}
      store={store}
    />
  )
  return screen.getByRole('combobox', { name: 'Message dans #général' })
}

describe('mentions in the composer', () => {
  it('offers the members whose name starts with what follows « @ », and loads the member list', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    expect(composer).toHaveAttribute('aria-expanded', 'false')
    expect(store.loadMembers).not.toHaveBeenCalled()

    await user.type(composer, 'Salut @ma')
    const list = screen.getByRole('listbox', { name: 'Membres à mentionner' })
    // « ma » starts « Martin », a word of Alice's name; nothing of Bob's or Élodie's.
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Marina Loiseau'])
    expect(composer).toHaveAttribute('aria-expanded', 'true')
    expect(composer).toHaveAttribute('aria-controls', list.id)
    expect(store.loadMembers).toHaveBeenCalledTimes(1)
    expect(store.loadMembers).toHaveBeenCalledWith(ROOM)

    // An « @ » inside a word is not a mention.
    await user.clear(composer)
    await user.type(composer, 'mail@al')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('chooses with the arrows and Enter, without sending, then sends the mention', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, '@')
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Marina Loiseau',
      'Bob Dupont',
      'Élodie Roux',
    ])
    expect(composer).toHaveAttribute('aria-activedescendant', options[0]!.id)
    await user.keyboard('{ArrowDown}')
    expect(composer).toHaveAttribute('aria-activedescendant', options[1]!.id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(store.send).not.toHaveBeenCalled()
    expect(composer).toHaveValue('@Bob Dupont ')
    expect(screen.queryByRole('listbox')).toBeNull()

    await user.type(composer, 'tu as vu ?{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, '@Bob Dupont tu as vu ?', { mentions: [BOB] })
  })

  it('finds a name without its accents, and chooses it with a click', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, 'Merci @elo')
    await user.click(screen.getByRole('option', { name: 'Élodie Roux' }))
    expect(composer).toHaveValue('Merci @Élodie Roux ')
    expect(composer).toHaveFocus()
  })

  it('closes the list with Escape until the next « @ », and sends plain text with no mention', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, '@al')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(composer, 'i')
    expect(screen.queryByRole('listbox')).toBeNull()
    await user.type(composer, ' @b')
    expect(screen.getByRole('option', { name: 'Bob Dupont' })).toBeInTheDocument()
    await user.keyboard('{Escape}{Enter}')
    // « @ali » and « @b » name no member in full: nothing is mentioned.
    expect(store.send).toHaveBeenCalledWith(ROOM, '@ali @b', {})
  })

  it('mentions a member whose whole name is typed by hand, the longest name winning', async () => {
    const user = userEvent.setup()
    const store = makeStore({
      members: [...MEMBERS, { userId: '@alice:matrix.acme.kodera.io', name: 'Alice' }],
    })
    const composer = renderView(store)
    await user.type(composer, '@Marina Loiseau, et @Bob Dupont.{Escape}{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, '@Marina Loiseau, et @Bob Dupont.', {
      mentions: [ALICE, BOB],
    })
  })

  it('opens the list from « Mentionner », where the caret was, and keeps writing there', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    const mention = screen.getByRole('button', { name: 'Mentionner' })
    // An empty field: « @ » alone, the list open, the focus in the field.
    await user.click(mention)
    expect(composer).toHaveValue('@')
    expect(composer).toHaveFocus()
    expect(store.loadMembers).toHaveBeenCalledWith(ROOM)
    expect(
      within(screen.getByRole('listbox', { name: 'Membres à mentionner' }))
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Marina Loiseau', 'Bob Dupont', 'Élodie Roux'])
    await user.keyboard('{Escape}')
    await user.clear(composer)
    // After a word, a space keeps « @ » from touching it; the caret's place, not the end, counts.
    await user.type(composer, 'Salut fin')
    ;(composer as HTMLInputElement).setSelectionRange(5, 5)
    await user.click(mention)
    expect(composer).toHaveValue('Salut @ fin')
    expect(composer).toHaveFocus()
    expect(composer).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('bo{Enter}')
    expect(composer).toHaveValue('Salut @Bob Dupont fin')
    const send = screen.getByRole('button', { name: 'Envoyer' })
    // The tools row of reference screen p02: « Mentionner », « Insérer un émoji », then
    // « Envoyer » with its glyph, and nothing else: no tool is drawn that does nothing yet.
    expect(mention.parentElement).toBe(send.parentElement)
    expect(within(send.parentElement!).getAllByRole('button')).toEqual([
      mention,
      screen.getByRole('button', { name: 'Insérer un émoji' }),
      send,
    ])
    expect(send.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    await user.click(send)
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Salut @Bob Dupont fin', {
      mentions: [BOB],
    })
  })

  it('reaches « Mentionner » by keyboard, and comes back to the field', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, 'Merci')
    await user.tab()
    expect(screen.getByRole('button', { name: 'Mentionner' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(composer).toHaveValue('Merci @')
    expect(composer).toHaveFocus()
    expect(composer).toHaveAttribute('aria-expanded', 'true')
    // One bordered box for the field and its tools, ringed while the focus is in it.
    expect(
      screen.getByRole('button', { name: 'Mentionner' }).parentElement?.parentElement
    ).toHaveClass('focus-within:ring')
  })

  it('opens the list from « Mentionner » in the same render, and keeps a selection', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store) as HTMLInputElement
    await user.type(composer, 'Salut fin')
    // A selected word stays, and « @ » goes after it.
    composer.setSelectionRange(0, 5)
    // A click and nothing else: no key, and no selection report from the browser yet.
    fireEvent.click(screen.getByRole('button', { name: 'Mentionner' }))
    expect(composer).toHaveValue('Salut @ fin')
    expect(composer).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens the list from « Mentionner » afresh, even where Escape had closed it', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    const composer = renderView(store)
    await user.type(composer, '@{ArrowDown}{ArrowDown}{Escape}')
    expect(composer).toHaveAttribute('aria-expanded', 'false')
    // The caret back before that « @ »: the new one lands where the closed list's began.
    await user.keyboard('{Home}')
    await user.click(screen.getByRole('button', { name: 'Mentionner' }))
    expect(composer).toHaveValue('@@')
    expect(composer).toHaveAttribute('aria-expanded', 'true')
    const options = within(
      screen.getByRole('listbox', { name: 'Membres à mentionner' })
    ).getAllByRole('option')
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ])
  })

  it('offers no list when the room has no one else', async () => {
    const user = userEvent.setup()
    const composer = renderView(makeStore({ members: [] }))
    await user.type(composer, '@')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(composer).toHaveAttribute('aria-expanded', 'false')
    // « Mentionner » writes its « @ », and opens nothing either.
    await user.click(screen.getByRole('button', { name: 'Mentionner' }))
    expect(composer).toHaveValue('@ @')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('mentions from the thread composer too, in the thread', async () => {
    const user = userEvent.setup()
    const store = makeStore({ threads: { $m1: [message('$t1', BOB, 'Dans le fil')] } })
    renderView(store)
    await user.click(screen.getByRole('button', { name: '1 réponse' }))
    const thread = screen.getByRole('complementary', { name: 'Fil de discussion' })
    const input = within(thread).getByRole('combobox', { name: 'Répondre au fil' })
    // Escape closes the list, not the thread behind it.
    await user.type(input, '@bo{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(thread).toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '@bo{Enter}ok{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, '@Bob Dupont ok', {
      mentions: [BOB],
      threadRootId: '$m1',
    })
  })
})

describe('a message that mentions the viewer', () => {
  it('is marked, and says so to assistive technology', () => {
    const store = makeStore({
      timeline: [
        message('$m1', ALICE, 'Bonjour !'),
        message('$m2', BOB, '@Moi tu peux relire ?', { mentionsMe: true }),
      ],
    })
    renderView(store)
    const log = screen.getByRole('log', { name: 'Messages de général' })
    const marked = within(log).getByRole('article', { name: /Vous mentionne/ })
    expect(marked).toHaveAttribute('data-mention')
    expect(marked).toHaveTextContent('@Moi tu peux relire ?')
    const plain = within(log)
      .getAllByRole('article')
      .filter((row) => row !== marked)
    expect(plain).toHaveLength(1)
    expect(plain[0]).not.toHaveAttribute('data-mention')
  })

  it('plays the msg_mention sound cue on a live incoming mention from a peer, but never on initial history load or self-authored messages', () => {
    soundEngine.resetCooldowns()
    const playSpy = vi.spyOn(soundEngine, 'play')

    try {
      const listeners = new Set<() => void>()
      let currentTimeline: readonly MessageView[] = [
        message('$m1', ALICE, 'Bonjour !'),
        message('$m2', BOB, '@Moi déjà là au chargement', { mentionsMe: true }),
      ]
      let currentSnapshot: EspaceSnapshot = {
        status: 'live',
        channels: new Map<string, ChannelRoom>([[GENERAL, { state: 'resolved', roomId: ROOM }]]),
        rooms: [
          {
            roomId: ROOM,
            name: 'general',
            alias: null,
            kind: 'text',
            unread: 0,
            mentions: 1,
            occupancy: null,
          },
        ],
        invites: [],
      }

      const publishTimeline = (nextTimeline: readonly MessageView[]) => {
        currentTimeline = nextTimeline
        currentSnapshot = {
          ...currentSnapshot,
          rooms: currentSnapshot.rooms.map((room) => ({ ...room })),
        }
        for (const listener of listeners) listener()
      }

      const store: EspaceStoreLike = {
        ...makeStore(),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => currentSnapshot,
        getTimeline: (roomId: string) => (roomId === ROOM ? currentTimeline : []),
      }

      // 1. Initial history load containing a mention must NOT trigger msg_mention
      renderView(store)
      expect(playSpy).not.toHaveBeenCalled()

      // 2. Self-authored live message (even if marked mentionsMe) must NOT trigger msg_mention
      act(() => {
        publishTimeline([
          ...currentTimeline,
          message('$m3', ME, '@Moi pense-bête perso', { mentionsMe: true }),
        ])
      })
      expect(playSpy).not.toHaveBeenCalled()

      // 3. Live non-mention message from a peer must NOT trigger msg_mention
      act(() => {
        publishTimeline([...currentTimeline, message('$m4', ALICE, 'Simple message sans mention')])
      })
      expect(playSpy).not.toHaveBeenCalled()

      // 4. Live incoming mention from a peer MUST trigger msg_mention with channelId, senderId, currentUserId
      act(() => {
        publishTimeline([
          ...currentTimeline,
          message('$m5', BOB, '@Moi tu peux valider la PR ?', { mentionsMe: true }),
        ])
      })
      expect(playSpy).toHaveBeenCalledTimes(1)
      expect(playSpy).toHaveBeenCalledWith('msg_mention', {
        channelId: GENERAL,
        senderId: BOB,
        currentUserId: ME,
      })
    } finally {
      playSpy.mockRestore()
      soundEngine.resetCooldowns()
    }
  })
})

describe('member profile cards', () => {
  it('opens a timeline author, copies the complete Matrix ID and mentions them in the active composer', async () => {
    const user = userEvent.setup()
    const store = makeStore({
      timeline: [message('$profile', ALICE, 'Hello', { senderName: 'Marina Loiseau' })],
    })
    const composer = renderView(store)
    await user.type(composer, 'Hello ')
    await user.click(
      within(screen.getByRole('log')).getAllByRole('button', { name: 'Marina Loiseau' })[0]!
    )
    const card = screen.getByRole('dialog', { name: 'Marina Loiseau' })
    expect(within(card).getByText(ALICE)).toBeVisible()
    await user.click(within(card).getByRole('button', { name: 'Copier l’ID Matrix' }))
    expect(await navigator.clipboard.readText()).toBe(ALICE)
    await user.click(within(card).getByRole('button', { name: 'Mentionner' }))
    expect(composer).toHaveValue('Hello @Marina Loiseau ')
    expect(composer).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Hello @Marina Loiseau', { mentions: [ALICE] })
  })

  it('opens member cards and keeps the members panel open when Escape dismisses a profile', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    await user.click(screen.getByRole('button', { name: /^Membres$/ }))
    const panel = screen.getByRole('complementary', { name: 'Membres' })
    await user.click(within(panel).getByRole('button', { name: /Bob Dupont/ }))
    expect(screen.getByRole('dialog', { name: 'Bob Dupont' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Bob Dupont' })).not.toBeInTheDocument()
    expect(panel).toBeVisible()
  })
})
