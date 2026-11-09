// The tab's title while Espace is open (V1 bar M9): « (3) Espace — Kodera » while the member's
// rooms count unread messages, « Espace — Kodera » otherwise, and the console's own title again
// once Espace is left.

import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../i18n'
import type { Workspace } from '../workspace/workspace'
import { EspaceLiveView } from './EspaceLiveView'
import type { EspaceStoreLike } from './EspaceLiveView'
import type { ChannelRoom, EspaceSnapshot, RoomSummary } from './matrix/store'
import { unreadTotal } from './useTabTitle'

const GENERAL = 'a1111111-1111-4111-8111-000000000001'
const ROOM = '!general:matrix.acme.kodera.io'
const OTHER = '!other:matrix.acme.kodera.io'

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

function room(roomId: string, unread: number, mentions: number): RoomSummary {
  return { roomId, name: roomId, alias: null, kind: 'text', unread, mentions, occupancy: null }
}

function makeStore(rooms: RoomSummary[]) {
  const listeners = new Set<() => void>()
  let snapshot: EspaceSnapshot = {
    status: 'live',
    channels: new Map<string, ChannelRoom>([[GENERAL, { state: 'resolved', roomId: ROOM }]]),
    rooms,
    invites: [],
  }
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => '@me:matrix.acme.kodera.io',
    getTimeline: () => [],
    getThread: () => [],
    send: async () => undefined,
    edit: async () => undefined,
    remove: async () => undefined,
    toggleReaction: async () => undefined,
  } satisfies EspaceStoreLike
  return {
    store,
    setRooms(next: RoomSummary[]) {
      snapshot = { ...snapshot, rooms: next }
      for (const listener of listeners) listener()
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

beforeEach(() => {
  document.title = 'Kodera'
})

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('fr')
  })
})

describe('the unread total', () => {
  it("adds every room's unread messages, a room with only mentions counting those", () => {
    expect(unreadTotal([])).toBe(0)
    expect(unreadTotal([room(ROOM, 0, 0)])).toBe(0)
    expect(unreadTotal([room(ROOM, 2, 1), room(OTHER, 3, 0)])).toBe(5)
    expect(unreadTotal([room(ROOM, 0, 2)])).toBe(2)
  })
})

describe('the tab title while Espace is open', () => {
  it('counts the unread messages across the rooms, and drops the count once they are read', () => {
    const { store, setRooms } = makeStore([room(ROOM, 1, 0), room(OTHER, 2, 1)])
    const view = show(store)
    expect(document.title).toBe('(3) Espace — Kodera')
    act(() => setRooms([room(ROOM, 0, 0), room(OTHER, 1, 0)]))
    expect(document.title).toBe('(1) Espace — Kodera')
    act(() => setRooms([room(ROOM, 0, 0), room(OTHER, 0, 0)]))
    expect(document.title).toBe('Espace — Kodera')
    view.unmount()
    expect(document.title).toBe('Kodera')
  })

  it('keeps the title through a change of language', async () => {
    const { store } = makeStore([room(ROOM, 4, 0)])
    show(store)
    expect(document.title).toBe('(4) Espace — Kodera')
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(document.title).toBe('(4) Espace — Kodera')
  })
})
