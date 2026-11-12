// Pinned messages and search in a channel (docs/specs/espace-timeline-scale.md): a message is
// pinned and unpinned from its menu, the header lists the room's pins and finds loaded messages,
// and choosing one brings it into sight in the log, focused.

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView } from './EspaceLiveView'
import type { EspaceStoreLike } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot } from './matrix/store'
import type { MessageView } from './matrix/timeline'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@marina.loiseau:matrix.acme.kodera.io'
const ZOE = '@zoe:matrix.acme.kodera.io'

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

function message(eventId: string, sender: string, body: string) {
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
  } satisfies MessageView
}

function makeStore({
  timeline = [
    message('$m1', ALICE, 'Réunion du café demain'),
    message('$m2', ZOE, 'Le compte rendu est en ligne'),
    message('$m3', ME, 'Merci pour le café'),
  ],
  pinned = [] as string[],
  canPin = true,
}: { timeline?: readonly MessageView[]; pinned?: string[]; canPin?: boolean } = {}) {
  let pins: readonly string[] = pinned
  let snapshot: EspaceSnapshot = {
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
  const listeners = new Set<() => void>()
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: (roomId: string) => (roomId === ROOM ? timeline : []),
    getThread: () => [],
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
    getPinned: () => pins,
    canPin: () => canPin,
    setPinned: vi.fn(async (_roomId: string, eventId: string, pinned: boolean) => {
      pins = pinned ? [...pins, eventId] : pins.filter((id) => id !== eventId)
      snapshot = { ...snapshot }
      for (const listener of listeners) listener()
    }),
  } satisfies EspaceStoreLike
  return store
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
}

const rowOf = (text: string) =>
  within(screen.getByRole('log')).getByText(text).closest<HTMLElement>('[data-timeline-row]')!

async function openMenu(user: ReturnType<typeof userEvent.setup>, text: string) {
  const article = rowOf(text).querySelector('article')!
  await user.click(within(article).getByRole('button', { name: /^Actions du message/ }))
}

describe('pinned messages', () => {
  it('pins a message from its menu, then unpins it', async () => {
    const user = userEvent.setup()
    const store = makeStore()
    renderView(store)
    await openMenu(user, 'Le compte rendu est en ligne')
    await user.click(screen.getByRole('menuitem', { name: 'Épingler' }))
    expect(store.setPinned).toHaveBeenCalledWith(ROOM, '$m2', true)
    expect(screen.getByRole('button', { name: 'Messages épinglés (1)' })).toBeInTheDocument()
    await openMenu(user, 'Le compte rendu est en ligne')
    await user.click(screen.getByRole('menuitem', { name: 'Désépingler' }))
    expect(store.setPinned).toHaveBeenLastCalledWith(ROOM, '$m2', false)
  })

  it('offers no pin to a member the room does not let change its pins', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ canPin: false }))
    await openMenu(user, 'Le compte rendu est en ligne')
    expect(screen.getByRole('menuitem', { name: 'Répondre' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Épingler' })).toBeNull()
  })

  it('lists the pins, the latest first, says which are not loaded, and shows the one chosen', async () => {
    const user = userEvent.setup()
    renderView(makeStore({ pinned: ['$m1', '$older', '$m2'] }))
    await user.click(screen.getByRole('button', { name: 'Messages épinglés (3)' }))
    const panel = screen.getByRole('dialog', { name: 'Messages épinglés' })
    const items = within(panel).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Le compte rendu est en ligne'),
      'Message plus ancien que l’historique chargé.',
      expect.stringContaining('Réunion du café demain'),
    ])
    await user.click(within(items[2]!).getByRole('button'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const row = rowOf('Réunion du café demain')
    expect(row.dataset.shown).toBe('true')
    expect(row.contains(document.activeElement)).toBe(true)
  })

  it('says a room has no pin yet, and how to pin one', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    await user.click(screen.getByRole('button', { name: 'Messages épinglés (0)' }))
    expect(
      screen.getByText(
        'Aucun message épinglé dans ce salon. Épinglez-en un depuis son menu « ··· ».'
      )
    ).toBeInTheDocument()
  })
})

describe('searching a channel', () => {
  it('finds the loaded messages holding every word, whatever the accents, and shows the one chosen', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    await user.click(screen.getByRole('button', { name: 'Rechercher dans ce salon' }))
    const field = screen.getByRole('searchbox', { name: 'Mots à chercher' })
    await user.type(field, 'CAFE')
    const panel = screen.getByRole('dialog', { name: 'Rechercher dans ce salon' })
    await waitFor(() =>
      expect(within(panel).getByRole('status')).toHaveTextContent('2 messages trouvés')
    )
    const results = within(panel).getAllByRole('listitem')
    // Newest first.
    expect(results[0]).toHaveTextContent('Merci pour le café')
    expect(results[1]).toHaveTextContent('Réunion du café demain')
    await user.type(field, ' reunion')
    await waitFor(() =>
      expect(within(panel).getByRole('status')).toHaveTextContent('1 message trouvé')
    )
    await user.click(within(panel).getByRole('button', { name: /Réunion du café demain/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const row = rowOf('Réunion du café demain')
    expect(row.dataset.shown).toBe('true')
    expect(row.contains(document.activeElement)).toBe(true)
  })

  it('searches nothing for one letter, and says when nothing matches', async () => {
    const user = userEvent.setup()
    renderView(makeStore())
    await user.click(screen.getByRole('button', { name: 'Rechercher dans ce salon' }))
    const field = screen.getByRole('searchbox', { name: 'Mots à chercher' })
    const panel = screen.getByRole('dialog', { name: 'Rechercher dans ce salon' })
    await user.type(field, 'c')
    expect(within(panel).getByRole('status')).toBeEmptyDOMElement()
    await user.type(field, 'zzz')
    await waitFor(() =>
      expect(within(panel).getByRole('status')).toHaveTextContent(
        'Aucun message chargé ne contient ces mots.'
      )
    )
  })
})
