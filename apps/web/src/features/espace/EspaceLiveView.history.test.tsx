// The message log's history edge and scrolling (V1 bar M3): it opens at the newest message, asks
// for older ones at the top, keeps the member's place when they arrive, and says where it starts.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView, type EspaceStoreLike } from './EspaceLiveView'
import type { EspaceSnapshot, History, RoomSummary } from './matrix/store'
import type { MessageView } from './matrix/timeline'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const WELCOME = 'a1111111-1111-4111-8111-000000000002'
const WELCOME_ROOM = '!welcome:matrix.acme.kodera.io'

const WORKSPACE: Workspace = {
  organisation_id: '11111111-1111-4111-8111-111111111111',
  state: 'initialised',
  setup: { state: 'ready', reason: null },
  can_initialise: false,
  id: '22222222-2222-4222-8222-222222222222',
  categories: [],
  uncategorised_channels: [
    {
      id: GENERAL,
      kind: 'text',
      name: 'general',
      template_key: 'general',
      topic: '',
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
}

function message(id: string): MessageView {
  return {
    key: id,
    eventId: id,
    sender: '@marina.loiseau:matrix.acme.kodera.io',
    body: `Message ${id}`,
    ts: Date.UTC(2026, 10, 2, 9, 0),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
  }
}

const WELCOME_MESSAGES = [message('$w1')]

function makeStore(history: History | undefined, timeline: MessageView[] = [message('$m1')]) {
  const listeners = new Set<() => void>()
  const general: RoomSummary = {
    roomId: ROOM,
    name: 'general',
    alias: `#kodera-ch-${GENERAL}:matrix.acme.kodera.io`,
    kind: 'text',
    unread: 0,
    mentions: 0,
    occupancy: null,
  }
  const welcome: RoomSummary = {
    ...general,
    roomId: WELCOME_ROOM,
    name: 'welcome',
    alias: `#kodera-ch-${WELCOME}:matrix.acme.kodera.io`,
  }
  let current: History = history ?? 'more'
  let snapshot: EspaceSnapshot = {
    status: 'live',
    rooms: [general, welcome],
    invites: [],
    channels: new Map([
      [GENERAL, { state: 'resolved', roomId: ROOM }],
      [WELCOME, { state: 'resolved', roomId: WELCOME_ROOM }],
    ]),
  }
  let messages: readonly MessageView[] = timeline
  const emit = () => act(() => listeners.forEach((listener) => listener()))
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => '@me:matrix.acme.kodera.io',
    getTimeline: (roomId: string) =>
      roomId === ROOM ? messages : roomId === WELCOME_ROOM ? WELCOME_MESSAGES : [],
    getThread: () => [],
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
    resolveChannels: vi.fn(),
    ...(history === undefined
      ? {}
      : { getHistory: (roomId: string): History => (roomId === ROOM ? current : 'start') }),
    loadOlder: vi.fn(async (_roomId: string) => undefined),
    setHistory(h: History) {
      current = h
      snapshot = { ...snapshot }
      emit()
    },
    setTimeline(next: MessageView[]) {
      messages = next
      snapshot = { ...snapshot }
      emit()
    },
  } satisfies EspaceStoreLike & Record<string, unknown>
  return store
}

/** jsdom lays nothing out: each log answers the heights a test gives, and keeps its scrollTop. */
const layout = { scrollHeight: 1000, clientHeight: 400 }
const tops = new WeakMap<Element, number>()
beforeEach(() => {
  layout.scrollHeight = 1000
  layout.clientHeight = 400
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
    () => layout.scrollHeight
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    () => layout.clientHeight
  )
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return tops.get(this) ?? 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: HTMLElement,
    value: number
  ) {
    tops.set(this, Math.max(0, Math.min(value, layout.scrollHeight - layout.clientHeight)))
  })
})
afterEach(() => vi.restoreAllMocks())

function screenFor(store: ReturnType<typeof makeStore>, channelId: string) {
  return (
    <EspaceLiveView
      org="acme"
      organisationName="Acme SA"
      workspace={WORKSPACE}
      channelId={channelId}
      store={store}
    />
  )
}

function view(store: ReturnType<typeof makeStore>) {
  render(screenFor(store, GENERAL))
  return screen.getByRole('log', { name: 'Messages de général' })
}

function scrollTo(log: HTMLElement, top: number) {
  log.scrollTop = top
  fireEvent.scroll(log)
}

describe('the message log, paging back through history', () => {
  it('opens on the newest message and asks for older ones only at the top', () => {
    const store = makeStore('more')
    const log = view(store)
    expect(log.scrollTop).toBe(600)
    expect(store.loadOlder).not.toHaveBeenCalled()

    scrollTo(log, 300)
    expect(store.loadOlder).not.toHaveBeenCalled()
    scrollTo(log, 10)
    expect(store.loadOlder).toHaveBeenCalledExactlyOnceWith(ROOM)
  })

  it('keeps the message the member was reading in place when older ones arrive above', () => {
    const store = makeStore('more', [message('$m2'), message('$m3')])
    const log = view(store)
    scrollTo(log, 10)
    store.setHistory('loading')
    expect(screen.getByText('Chargement des messages précédents…')).toBeInTheDocument()
    expect(log).toHaveAttribute('aria-busy', 'true')

    layout.scrollHeight = 1600
    store.setTimeline([message('$m1'), message('$m2'), message('$m3')])
    store.setHistory('more')
    // 990 px of log were below the member's place, as before.
    expect(log.scrollTop).toBe(610)
    expect(log).not.toHaveAttribute('aria-busy')
  })

  it('follows new messages at the bottom, and leaves a member who scrolled up where they are', () => {
    const store = makeStore('start')
    const log = view(store)
    layout.scrollHeight = 1200
    store.setTimeline([message('$m1'), message('$m2')])
    expect(log.scrollTop).toBe(800)

    scrollTo(log, 200)
    layout.scrollHeight = 1400
    store.setTimeline([message('$m1'), message('$m2'), message('$m3')])
    expect(log.scrollTop).toBe(200)
  })

  it('opens another channel on its newest message, wherever the member was in the last one', () => {
    const store = makeStore('start')
    const { rerender } = render(screenFor(store, GENERAL))
    scrollTo(screen.getByRole('log'), 200)
    rerender(screenFor(store, WELCOME))
    const log = screen.getByRole('log')
    expect(within(log).getByText('Message $w1')).toBeInTheDocument()
    expect(log.scrollTop).toBe(600)
  })

  it('asks for older messages at once while the log does not fill its height', () => {
    layout.scrollHeight = 300
    const store = makeStore('more')
    view(store)
    expect(store.loadOlder).toHaveBeenCalledExactlyOnceWith(ROOM)
  })

  it('offers the older messages by a button too, and says nothing is missing while they come', async () => {
    const user = userEvent.setup()
    const store = makeStore('more', [])
    const log = view(store)
    expect(within(log).queryByText('Aucun message dans #général.')).not.toBeInTheDocument()
    await user.click(within(log).getByRole('button', { name: 'Afficher les messages précédents' }))
    expect(store.loadOlder).toHaveBeenCalledWith(ROOM)
  })

  it('says why older messages are missing after a failure, offers to ask again, and does not ask on its own', async () => {
    const user = userEvent.setup()
    layout.scrollHeight = 300
    const store = makeStore('failed')
    const log = view(store)
    expect(
      within(log).getByText('Les messages précédents n’ont pas pu être chargés.')
    ).toBeVisible()
    scrollTo(log, 0)
    expect(store.loadOlder).not.toHaveBeenCalled()
    await user.click(within(log).getByRole('button', { name: 'Réessayer' }))
    expect(store.loadOlder).toHaveBeenCalledExactlyOnceWith(ROOM)
  })

  it("marks the channel's beginning once the start is reached, and asks nothing more", () => {
    const store = makeStore('start')
    const log = view(store)
    expect(within(log).getByText('Début de #général')).toBeInTheDocument()
    expect(within(log).queryByRole('button', { name: /précédents/ })).not.toBeInTheDocument()
    scrollTo(log, 0)
    expect(store.loadOlder).not.toHaveBeenCalled()
  })

  it('shows no edge for a store that cannot page back', () => {
    const store = makeStore(undefined)
    const log = view(store)
    expect(within(log).queryByText(/précédents|Début de/)).not.toBeInTheDocument()
    expect(within(log).getByText('Message $m1')).toBeInTheDocument()
  })
})
