// The typing line (gap report G9): who is writing in the channel, said once under the log, and the
// notices the composer sends while the member writes a new message.

import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
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

function message(eventId: string, sender: string, body: string): MessageView {
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
  }
}

/** A store whose typing members the test sets, as a sync would. */
function makeStore() {
  const listeners = new Set<() => void>()
  let typing: readonly MemberView[] = []
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
  const timeline = [message('$m1', ALICE, 'Bonjour !'), message('$mine', ME, 'Mon message')]
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getUserId: () => ME,
    getTimeline: (roomId: string) => (roomId === ROOM ? timeline : []),
    getThread: () => [],
    getTyping: (roomId: string) => (roomId === ROOM ? typing : []),
    setTyping: vi.fn<(roomId: string, typing: boolean) => void>(),
    send: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    toggleReaction: vi.fn(async () => undefined),
  } satisfies EspaceStoreLike
  return {
    store,
    typing(members: readonly MemberView[]) {
      act(() => {
        typing = members
        snapshot = { ...snapshot }
        for (const listener of listeners) listener()
      })
    },
  }
}

function renderView(store: EspaceStoreLike) {
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

/** The typing line: the polite region between the log and the composer. */
function typingLine() {
  const log = screen.getByRole('log')
  const line = log.nextElementSibling
  expect(line?.tagName).toBe('P')
  expect(line).toHaveAttribute('aria-live', 'polite')
  expect(line).toHaveAttribute('aria-atomic', 'true')
  return line as HTMLElement
}

describe('the typing line', () => {
  it('names one or two people typing, and says « Plusieurs personnes » for more', () => {
    const { store, typing } = makeStore()
    renderView(store)
    expect(typingLine()).toHaveTextContent(/^$/)
    typing([{ userId: ALICE, name: 'Marina Loiseau' }])
    expect(typingLine()).toHaveTextContent(/^Marina Loiseau écrit…$/)
    // Someone with no display name is named as their messages are signed.
    typing([{ userId: ALICE, name: 'Marina Loiseau' }, { userId: BOB }])
    expect(typingLine()).toHaveTextContent(/^Marina Loiseau et Bob Dupont écrivent…$/)
    typing([
      { userId: ALICE, name: 'Marina Loiseau' },
      { userId: BOB, name: 'Bob Dupont' },
      { userId: ELODIE, name: 'Élodie Roux' },
    ])
    expect(typingLine()).toHaveTextContent(/^Plusieurs personnes écrivent…$/)
    typing([])
    expect(typingLine()).toHaveTextContent(/^$/)
    // Never inside the log: a message arriving is not read out behind it.
    expect(within(screen.getByRole('log')).queryByText(/écri/)).toBeNull()
  })

  it('tells the room while a new message is written, and stops on clearing and on sending', async () => {
    const user = userEvent.setup()
    const { store } = makeStore()
    renderView(store)
    const composer = screen.getByRole('textbox', { name: 'Message dans #général' })
    await user.type(composer, 'Sa')
    expect(store.setTyping.mock.calls).toEqual([
      [ROOM, true],
      [ROOM, true],
    ])
    await user.clear(composer)
    expect(store.setTyping).toHaveBeenLastCalledWith(ROOM, false)
    store.setTyping.mockClear()
    await user.type(composer, 'Salut')
    expect(store.setTyping).toHaveBeenLastCalledWith(ROOM, true)
    await user.click(screen.getByRole('button', { name: 'Envoyer' }))
    expect(store.send).toHaveBeenCalledWith(ROOM, 'Salut', {})
    expect(store.setTyping).toHaveBeenLastCalledWith(ROOM, false)
  })

  it('says nothing while an edit is written, and stops when the view goes', async () => {
    const user = userEvent.setup()
    const { store } = makeStore()
    const view = renderView(store)
    const composer = screen.getByRole('textbox', { name: 'Message dans #général' })
    // A new message half-written gives way to the edit: the room stops seeing the member type.
    await user.type(composer, 'Bro')
    expect(store.setTyping).toHaveBeenLastCalledWith(ROOM, true)
    const mine = within(screen.getByRole('log')).getByText('Mon message').closest('article')!
    await user.click(
      within(mine)
        .getAllByRole('button')
        .find((button) => button.textContent === '···')!
    )
    store.setTyping.mockClear()
    await user.click(screen.getByRole('menuitem', { name: 'Modifier' }))
    expect(store.setTyping.mock.calls).toEqual([[ROOM, false]])
    expect(composer).toHaveValue('Mon message')
    store.setTyping.mockClear()
    await user.type(composer, ' corrigé')
    expect(store.setTyping.mock.calls.every(([, typing]) => typing === false)).toBe(true)
    expect(store.setTyping).toHaveBeenCalled()
    store.setTyping.mockClear()
    view.unmount()
    expect(store.setTyping).toHaveBeenCalledWith(ROOM, false)
  })
})
