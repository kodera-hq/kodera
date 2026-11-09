// The conversation's log between its messages (G9): a divider at each calendar day, read in
// Paris time (« Aujourd’hui », « Hier », « Lundi 2 novembre »), and « Nouveaux messages » above
// the first message someone else wrote since the member last read the room. The marker is
// taken when the room is opened, so it stays while the read marker moves under it.

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView } from './EspaceLiveView'
import type { EspaceStoreLike } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot } from './matrix/store'
import type { MessageView } from './matrix/timeline'
import { CALENDAR_DAY_CHECK_MS } from './useCalendarToday'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const ME = '@me:matrix.acme.kodera.io'
const ALICE = '@alice:matrix.acme.kodera.io'

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

function message(eventId: string, iso: string, patch: Partial<MessageView> = {}): MessageView {
  return {
    key: eventId,
    eventId,
    sender: ALICE,
    body: `body ${eventId}`,
    ts: Date.parse(iso),
    edited: false,
    redacted: false,
    delivery: 'sent',
    replyTo: null,
    reactions: [],
    ...patch,
  }
}

function makeStore(timeline: MessageView[], readMarker: string | null, unread = 1) {
  const listeners = new Set<() => void>()
  let marker = readMarker
  let messages = timeline
  let snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map<string, ChannelRoom>([[GENERAL, { state: 'resolved', roomId: ROOM }]]),
    rooms: [
      {
        roomId: ROOM,
        name: 'général',
        alias: null,
        kind: 'text',
        unread,
        mentions: 0,
        occupancy: null,
      },
    ],
    invites: [],
  }
  const emit = () => {
    snapshot = { ...snapshot }
    for (const listener of listeners) listener()
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: () => messages,
    getThread: () => [],
    getReadMarker: () => marker,
    // Every event in this log is a message, so the first shown one after an event is the next.
    firstShownAfter: (_roomId: string, eventId: string) => {
      const at = messages.findIndex((entry) => entry.eventId === eventId)
      return at === -1 ? null : (messages[at + 1]?.eventId ?? null)
    },
    send: async () => undefined,
    edit: async () => undefined,
    remove: async () => undefined,
    toggleReaction: async () => undefined,
  } satisfies EspaceStoreLike
  return {
    store,
    /** What reading the room does: the marker moves to the newest message, and the store emits. */
    readAll() {
      marker = messages.at(-1)?.eventId ?? null
      emit()
    },
    /** What paging back does: older messages arrive above the loaded ones. */
    loadEarlier(older: MessageView[]) {
      messages = [...older, ...messages]
      emit()
    },
    receive(next: MessageView) {
      messages = [...messages, next]
      emit()
    },
  }
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

/** The log's dividers, in order, as their visible labels. */
function dividers(): string[] {
  return [...document.querySelectorAll('[data-divider]')].map((node) => node.textContent ?? '')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  // 13:00 in Paris on Thursday 5 November 2026.
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'))
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
})

describe('the day dividers', () => {
  it('names today and yesterday, then the date, with the year only for another year', () => {
    const { store } = makeStore(
      [
        message('$old', '2025-12-30T09:00:00Z'),
        message('$mon', '2026-11-02T09:00:00Z'),
        message('$wed', '2026-11-04T09:00:00Z'),
        message('$thu', '2026-11-05T09:00:00Z'),
      ],
      null
    )
    show(store)
    expect(dividers()).toEqual([
      'Mardi 30 décembre 2025',
      'Lundi 2 novembre',
      'Hier',
      'Aujourd’hui',
    ])
  })

  it('reads the day in Paris: 23:30 UTC on the 4th is already today', () => {
    const { store } = makeStore([message('$late', '2026-11-04T23:30:00Z')], null)
    show(store)
    expect(dividers()).toEqual(['Aujourd’hui'])
  })

  it('speaks the member’s language', async () => {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    const { store } = makeStore(
      [message('$mon', '2026-11-02T09:00:00Z'), message('$thu', '2026-11-05T09:00:00Z')],
      null
    )
    show(store)
    expect(dividers()).toEqual(['Monday 2 November', 'Today'])
  })

  it('turns « Aujourd’hui » into « Hier » once midnight passes with the room open', () => {
    vi.setSystemTime(new Date('2026-11-05T22:59:30Z')) // 23:59:30 in Paris
    const { store } = makeStore([message('$thu', '2026-11-05T09:00:00Z')], null)
    show(store)
    expect(dividers()).toEqual(['Aujourd’hui'])
    act(() => {
      vi.advanceTimersByTime(CALENDAR_DAY_CHECK_MS)
    })
    expect(dividers()).toEqual(['Hier'])
  })
})

describe('« Nouveaux messages »', () => {
  const log = () => [
    message('$a', '2026-11-05T08:00:00Z'),
    message('$b', '2026-11-05T08:10:00Z'),
    message('$c', '2026-11-05T08:20:00Z'),
  ]

  it('sits above the first message written since the member last read the room', () => {
    const { store } = makeStore(log(), '$a')
    show(store)
    const marker = screen.getByText('Nouveaux messages')
    const first = screen.getByText('body $b')
    const read = screen.getByText('body $a')
    expect(read.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(marker.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dividers()).toEqual(['Aujourd’hui', 'Nouveaux messages'])
  })

  it('stays where it was while the room is read and new messages arrive', () => {
    const { store, readAll, receive } = makeStore(log(), '$a')
    show(store)
    act(() => readAll())
    act(() => receive(message('$d', '2026-11-05T08:30:00Z')))
    expect(dividers()).toEqual(['Aujourd’hui', 'Nouveaux messages'])
    const marker = screen.getByText('Nouveaux messages')
    expect(
      marker.compareDocumentPosition(screen.getByText('body $b')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen.getByText('body $a').compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('is not drawn when everything was read, nor for a room never read', () => {
    const read = makeStore(log(), '$c')
    const view = show(read.store)
    expect(screen.queryByText('Nouveaux messages')).toBeNull()
    view.unmount()
    show(makeStore(log(), null).store)
    expect(screen.queryByText('Nouveaux messages')).toBeNull()
  })

  it('is not drawn above the member’s own messages', () => {
    const { store } = makeStore(
      [
        message('$a', '2026-11-05T08:00:00Z'),
        message('$mine', '2026-11-05T08:10:00Z', { sender: ME }),
      ],
      '$a'
    )
    show(store)
    expect(screen.queryByText('Nouveaux messages')).toBeNull()
  })

  it('is not drawn in a room already read when it opened, even as messages arrive', () => {
    const { store, receive } = makeStore(log(), '$b', 0)
    show(store)
    expect(screen.queryByText('Nouveaux messages')).toBeNull()
    act(() => receive(message('$d', '2026-11-05T08:30:00Z')))
    expect(screen.getByText('body $d')).toBeInTheDocument()
    expect(screen.queryByText('Nouveaux messages')).toBeNull()
  })

  it('is found once older messages bring in a marker older than the loaded ones', () => {
    const [read, ...unread] = log()
    const { store, loadEarlier } = makeStore(unread, '$a')
    show(store)
    expect(screen.queryByText('Nouveaux messages')).toBeNull()
    act(() => loadEarlier([read!]))
    const marker = screen.getByText('Nouveaux messages')
    expect(
      marker.compareDocumentPosition(screen.getByText('body $b')) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})
