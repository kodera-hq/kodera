// Keyboard shortcuts (workspace audit item 11), as Discord has them: `Alt` and the arrows to the
// channel above or below, with `Shift` to the next unread one; `ArrowUp` in an empty composer to
// edit the newest own message; `Escape` to give up the edit, else the reply, else the unread.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NARROW_LAYOUT_QUERY } from '../../app/layoutQuery'
import '../../i18n'
import type { Workspace, WorkspaceChannel } from '../workspace/workspace'
import { keepsFocus, releaseRouteFocus } from '../../app/routeFocusHold'
import { EspaceLiveView } from './EspaceLiveView'
import type { EspaceStoreLike } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot, MemberView, RoomSummary } from './matrix/store'
import type { MessageView } from './matrix/timeline'

const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@marina.loiseau:matrix.acme.kodera.io'

function channel(id: string, name: string, kind: 'text' | 'audio' = 'text'): WorkspaceChannel {
  return {
    id,
    kind,
    name,
    template_key: null,
    topic: '',
    lifecycle: 'active',
    room_state: 'ready',
  }
}

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const STANDUP = 'a1111111-1111-4111-8111-000000000002'
const ANNONCES = 'a1111111-1111-4111-8111-000000000003'
const PROJETS = 'a1111111-1111-4111-8111-000000000004'
const DIVERS = 'a1111111-1111-4111-8111-000000000005'
const roomOf = (id: string) => `!${id.slice(-1)}:matrix.acme.kodera.io`

// The sidebar's order: « général », an audio room, « annonces »; then « projets »; then
// « divers », in no category.
const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [
    {
      id: 'cat-a',
      name: 'Équipe',
      template_key: null,
      channels: [
        channel(GENERAL, 'général'),
        channel(STANDUP, 'Point quotidien', 'audio'),
        channel(ANNONCES, 'annonces'),
      ],
    },
    { id: 'cat-b', name: 'Travail', template_key: null, channels: [channel(PROJETS, 'projets')] },
  ],
  uncategorised_channels: [channel(DIVERS, 'divers')],
}

function message(
  eventId: string,
  sender: string,
  body: string,
  extra: Partial<MessageView> = {}
): MessageView {
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
  }
}

function makeStore({
  unread = {},
  timelines = {},
  readMarkers = {},
  members = [],
  thread = [],
}: {
  unread?: Record<string, { unread: number; mentions: number }>
  timelines?: Record<string, readonly MessageView[]>
  readMarkers?: Record<string, string>
  members?: readonly MemberView[]
  thread?: readonly MessageView[]
} = {}) {
  const ids = [GENERAL, STANDUP, ANNONCES, PROJETS, DIVERS]
  const rooms: RoomSummary[] = ids.map((id) => ({
    roomId: roomOf(id),
    name: id,
    alias: null,
    kind: id === STANDUP ? 'audio' : 'text',
    unread: unread[id]?.unread ?? 0,
    mentions: unread[id]?.mentions ?? 0,
    occupancy: id === STANDUP ? { participants: [], screenShare: [] } : null,
  }))
  const snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map<string, ChannelRoom>(
      ids.map((id) => [id, { state: 'resolved', roomId: roomOf(id) }])
    ),
    rooms,
    invites: [],
  }
  const timelineOf = (roomId: string) =>
    timelines[ids.find((id) => roomOf(id) === roomId) ?? ''] ?? []
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: timelineOf,
    getThread: () => thread,
    getMembers: () => members,
    getReadMarker: (roomId: string) =>
      readMarkers[ids.find((id) => roomOf(id) === roomId) ?? ''] ?? null,
    firstShownAfter: (roomId: string, eventId: string) => {
      const messages = timelineOf(roomId)
      const at = messages.findIndex((entry) => entry.eventId === eventId)
      return at === -1 ? null : (messages[at + 1]?.eventId ?? null)
    },
    markRead: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  } satisfies EspaceStoreLike
}

function renderView(
  store: EspaceStoreLike,
  onNavigateChannel?: (channelId: string) => void | Promise<void>,
  workspace: Workspace = WORKSPACE
) {
  return render(
    <EspaceLiveView
      org="acme"
      organisationName="Acme SA"
      workspace={workspace}
      channelId={GENERAL}
      store={store}
      {...(onNavigateChannel === undefined ? {} : { onNavigateChannel })}
    />
  )
}

/** The composer, named by the channel shown: the way to read which channel is open. */
const composerOf = (name: string) =>
  screen.getByRole('textbox', { name: `Message dans #${name}` }) as HTMLInputElement
const said = () => document.querySelector('p[aria-live="polite"].sr-only')?.textContent

describe('Alt and the arrows', () => {
  it('open the text channel below or above, in the sidebar order, wrapping, focus kept', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    await user.click(composerOf('général'))
    await user.type(composerOf('général'), 'brouillon')
    // The audio room between « général » and « annonces » is skipped.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(composerOf('annonces')).toHaveFocus()
    expect(said()).toBe('Salon #annonces')
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(composerOf('divers')).toHaveFocus()
    // Past the last, the first; and back.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(composerOf('général')).toHaveFocus()
    // The draft of the channel left is kept for it.
    expect(composerOf('général')).toHaveValue('brouillon')
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(composerOf('divers')).toBeInTheDocument()
    expect(said()).toBe('Salon #divers')
  })

  it('with Shift, open the nearest unread channel, and say so when there is none', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ unread: { [PROJETS]: { unread: 0, mentions: 1 } } }))
    await user.click(composerOf('général'))
    await user.keyboard('{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}')
    expect(composerOf('projets')).toHaveFocus()
    // The one shown is left out: no other channel counts anything.
    await user.keyboard('{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}')
    expect(composerOf('projets')).toBeInTheDocument()
    expect(said()).toBe('Aucun autre salon non lu')
  })

  it('answer nothing with Ctrl or Meta, or while the view is withdrawn behind a modal', async () => {
    const user = userEvent.setup()
    const { container } = renderView(makeStore())
    await user.click(composerOf('général'))
    await user.keyboard('{Control>}{Alt>}{ArrowDown}{/Alt}{/Control}')
    await user.keyboard('{Meta>}{Alt>}{ArrowDown}{/Alt}{/Meta}')
    expect(composerOf('général')).toBeInTheDocument()
    container.setAttribute('aria-hidden', 'true')
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    container.removeAttribute('aria-hidden')
    expect(composerOf('général')).toBeInTheDocument()
  })

  it('give the focus to the heading of a channel with no composer', async () => {
    const user = userEvent.setup()
    // « divers » archived: its pane says so, and draws no composer.
    const archived: Workspace = {
      ...WORKSPACE,
      uncategorised_channels: [{ ...channel(DIVERS, 'divers'), lifecycle: 'archived' }],
    }
    renderView(makeStore(), undefined, archived)
    // Only a key's move: the view opening, or a channel opened another way, moves no focus here.
    expect(document.body).toHaveFocus()
    await user.click(composerOf('général'))
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(screen.queryByRole('textbox', { name: /Message dans/ })).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('divers')
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
    // Back to a channel with a composer, the focus stays where it is.
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('général')
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
  })

  it('ask the route change to keep the focus, and go on from a channel still loading', async () => {
    const user = userEvent.setup()
    // An address that never finishes loading: the view stays on « général » meanwhile.
    const navigate = vi.fn<(channelId: string) => Promise<void>>(() => new Promise(() => {}))
    renderView(makeStore({ timelines: { [GENERAL]: [message('$m1', ME, 'À moi')] } }), navigate)
    await user.click(composerOf('général'))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(navigate).toHaveBeenLastCalledWith(ANNONCES)
    expect(keepsFocus(`/acme/workspace/${ANNONCES}`)).toBe(true)
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(navigate).toHaveBeenLastCalledWith(PROJETS)
    // Each address its own: the first, if it settles first, keeps the focus too.
    expect(keepsFocus(`/acme/workspace/${ANNONCES}`)).toBe(true)
    expect(keepsFocus(`/acme/workspace/${PROJETS}`)).toBe(true)
    // Read-only meanwhile, not disabled, so the focus stays in the field; and ↑ edits nothing
    // in a channel that is being left.
    const composer = composerOf('général')
    expect(composer).toHaveFocus()
    expect(composer).toHaveAttribute('readonly')
    expect(composer).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{ArrowUp}')
    expect(composer).toHaveValue('')
    expect(screen.queryByText('Modification du message')).toBeNull()
    releaseRouteFocus(`/acme/workspace/${ANNONCES}`)
    releaseRouteFocus(`/acme/workspace/${PROJETS}`)
  })

  it('let the hold go once the navigation is over, whether it landed or not', async () => {
    const user = userEvent.setup()
    let finish: (() => void) | undefined
    let refuse: ((reason: Error) => void) | undefined
    const navigate = vi
      .fn<(channelId: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
    renderView(makeStore(), navigate)
    await user.click(composerOf('général'))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}{Alt>}{ArrowDown}{/Alt}')
    const annonces = `/acme/workspace/${ANNONCES}`
    const projets = `/acme/workspace/${PROJETS}`
    expect(keepsFocus(annonces) && keepsFocus(projets)).toBe(true)
    await act(async () => {
      finish!()
      refuse!(Error('refused'))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(keepsFocus(annonces)).toBe(false)
    expect(keepsFocus(projets)).toBe(false)
  })

  it('leave the keys to the thread panel and to an open popover', async () => {
    const user = userEvent.setup()
    const store = makeStore({
      timelines: { [GENERAL]: [message('$m1', ALICE, 'Fil')] },
      thread: [message('$t1', ALICE, 'Réponse')],
    })
    renderView(store)
    await user.click(screen.getByRole('button', { name: '1 réponse' }))
    const thread = screen.getByRole('complementary', { name: 'Fil de discussion' })
    await user.click(within(thread).getByRole('combobox', { name: 'Répondre au fil' }))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(composerOf('général')).toBeInTheDocument()
    expect(thread).toBeInTheDocument()

    const article = within(screen.getByRole('log')).getAllByRole('article')[0]!
    await user.click(within(article).getByRole('button', { name: 'Ajouter une réaction' }))
    const palette = await screen.findByRole('dialog', { name: 'Réactions rapides' })
    await waitFor(() => expect(palette.contains(document.activeElement)).toBe(true))
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(composerOf('général')).toBeInTheDocument()
    expect(palette).toBeInTheDocument()
  })

  it('say the same words again when pressed again', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    await user.click(composerOf('général'))
    await user.keyboard('{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}')
    const region = document.querySelector('p[aria-live="polite"].sr-only')!
    const first = region.firstElementChild
    expect(said()).toBe('Aucun autre salon non lu')
    await user.keyboard('{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}')
    expect(said()).toBe('Aucun autre salon non lu')
    expect(region.firstElementChild).not.toBe(first)
  })

  it('move the channel from the empty composer, never editing', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ timelines: { [GENERAL]: [message('$m1', ME, 'À moi')] } }))
    await user.click(composerOf('général'))
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(composerOf('divers')).toHaveValue('')
    expect(screen.queryByText('Modification du message')).toBeNull()
  })

  it('leave the key to an open member list', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ members: [{ userId: ALICE, name: 'Marina Loiseau' }] }))
    await user.type(composerOf('général'), '@')
    expect(screen.getByRole('listbox', { name: 'Membres à mentionner' })).toBeInTheDocument()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(composerOf('général')).toBeInTheDocument()
  })
})

describe('ArrowUp in the empty composer', () => {
  const timeline = [
    message('$m1', ME, 'Mon premier message'),
    message('$m2', ALICE, 'Bonjour'),
    message('$m3', ME, 'Mon dernier message'),
    message('$m4', ME, 'Supprimé', { redacted: true }),
    message('$m5', ME, 'En cours', { delivery: 'pending' }),
    message('$m6', ALICE, 'Encore Alice'),
  ]

  it('edits the newest sent, undeleted own message, as « Modifier » does', async () => {
    const user = userEvent.setup()
    const store = makeStore({ timelines: { [GENERAL]: timeline } })
    renderView(store)
    const composer = composerOf('général')
    await user.click(composer)
    await user.keyboard('{ArrowUp}')
    expect(composer).toHaveValue('Mon dernier message')
    expect(screen.getByText('Modification du message')).toBeInTheDocument()
    expect(composer.selectionStart).toBe('Mon dernier message'.length)
    expect(said()).toBe('Modification de votre dernier message. Échap pour annuler.')
    // Once editing, the key is the field's again, even with the edit's text cleared.
    await user.keyboard('{ArrowUp}')
    expect(composer).toHaveValue('Mon dernier message')
    await user.clear(composer)
    await user.keyboard('{ArrowUp}')
    expect(composer).toHaveValue('')
    expect(screen.getByText('Modification du message')).toBeInTheDocument()
    await user.type(composer, 'Mon dernier message')
    await user.keyboard(' !{Enter}')
    expect(store.edit).toHaveBeenCalledWith(roomOf(GENERAL), '$m3', 'Mon dernier message !')
  })

  it('does nothing while the field holds text, or with no own message', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ timelines: { [GENERAL]: timeline, [ANNONCES]: [timeline[1]!] } }))
    const composer = composerOf('général')
    await user.type(composer, 'a{ArrowUp}')
    expect(composer).toHaveValue('a')
    expect(screen.queryByText('Modification du message')).toBeNull()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}{ArrowUp}')
    expect(composerOf('annonces')).toHaveValue('')
    expect(screen.queryByText('Modification du message')).toBeNull()
  })
})

describe('Escape in the channel column', () => {
  const log = [message('$a', ALICE, 'Lu'), message('$b', ALICE, 'Pas encore lu')]

  it('gives up the edit, then the reply, then the unread, one at a time', async () => {
    const user = userEvent.setup()
    const store = makeStore({
      unread: { [GENERAL]: { unread: 1, mentions: 0 } },
      timelines: { [GENERAL]: [...log, message('$c', ME, 'À moi')] },
      readMarkers: { [GENERAL]: '$a' },
    })
    renderView(store)
    const composer = composerOf('général')
    expect(screen.getByText('Nouveaux messages')).toBeInTheDocument()
    await user.click(composer)
    await user.keyboard('{ArrowUp}')
    expect(screen.getByText('Modification du message')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByText('Modification du message')).toBeNull()
    expect(composer).toHaveValue('')
    expect(screen.getByText('Nouveaux messages')).toBeInTheDocument()

    const articles = within(screen.getByRole('log')).getAllByRole('article')
    await user.click(within(articles[0]!).getByRole('button', { name: /^Actions du message/ }))
    await user.click(screen.getByRole('menuitem', { name: 'Répondre' }))
    expect(screen.getByRole('button', { name: 'Annuler la réponse' })).toBeInTheDocument()
    await user.click(composer)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: 'Annuler la réponse' })).toBeNull()
    expect(screen.getByText('Nouveaux messages')).toBeInTheDocument()

    const reads = store.markRead.mock.calls.length
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Nouveaux messages')).toBeNull()
    expect(store.markRead.mock.calls.length).toBe(reads + 1)
    expect(store.markRead).toHaveBeenLastCalledWith(roomOf(GENERAL))
    expect(said()).toBe('#général marqué comme lu')
  })

  it('closes an open message menu and nothing more', async () => {
    const user = userEvent.setup()
    const store = makeStore({
      unread: { [GENERAL]: { unread: 1, mentions: 0 } },
      timelines: { [GENERAL]: log },
      readMarkers: { [GENERAL]: '$a' },
    })
    renderView(store)
    const article = within(screen.getByRole('log')).getAllByRole('article')[0]!
    await user.click(within(article).getByRole('button', { name: /^Actions du message/ }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    const reads = store.markRead.mock.calls.length
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByText('Nouveaux messages')).toBeInTheDocument()
    expect(store.markRead.mock.calls.length).toBe(reads)
  })

  it('leaves Escape and ArrowUp to an input method while it composes', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ timelines: { [GENERAL]: [message('$m1', ME, 'À moi')] } }))
    const composer = composerOf('général')
    await user.click(composer)
    fireEvent.keyDown(composer, { key: 'ArrowUp', isComposing: true })
    expect(composer).toHaveValue('')
    await user.keyboard('{ArrowUp}')
    expect(composer).toHaveValue('À moi')
    // Safari reports a composing key as 229, with no flag.
    fireEvent.keyDown(composer, { key: 'Escape', keyCode: 229 })
    expect(composer).toHaveValue('À moi')
    expect(screen.getByText('Modification du message')).toBeInTheDocument()
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(composer).toHaveValue('')
  })

  it('does nothing in a channel already read, with no divider', async () => {
    const user = userEvent.setup()
    const store = makeStore({ timelines: { [GENERAL]: log } })
    renderView(store)
    await user.click(composerOf('général'))
    await user.keyboard('{Escape}')
    expect(store.markRead).not.toHaveBeenCalled()
    expect(said()).toBe('')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('lists no keys on the composer at phone width, where none is in reach', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      media,
      matches: media === NARROW_LAYOUT_QUERY,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => true,
    }))
  )
  renderView(makeStore())
  expect(composerOf('général')).not.toHaveAttribute('aria-keyshortcuts')
})

it('lists its channel keys on the composer', () => {
  renderView(makeStore())
  expect(composerOf('général')).toHaveAttribute(
    'aria-keyshortcuts',
    'Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown'
  )
})
