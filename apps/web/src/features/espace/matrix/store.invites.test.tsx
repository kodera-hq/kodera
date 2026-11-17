import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ClientEvent,
  EventType,
  MatrixEvent,
  PendingEventOrdering,
  Room,
  RoomEvent,
  SyncState,
} from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../../../i18n'
import { DirectMessages } from '../DirectMessages'
import type { EspaceStoreLike } from '../liveViewModel'
import { PendingInvitations } from '../PendingInvitations'
import { NotificationCenter } from '../../notifications/NotificationCenter'
import { NotificationFeed } from '../../notifications/notificationFeed'
import { createEspaceStore, matrixClientForTests, type EspaceStore, type InviteView } from './store'

const ME = '@me:example.test'
const ALICE = '@alice:example.test'
const ROOM = '!dm:example.test'
const stores: EspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.stop()
  vi.restoreAllMocks()
})

async function invited({
  direct = true,
  encrypted = false,
  named = false,
  inviter = ALICE,
}: {
  direct?: boolean
  encrypted?: boolean
  named?: boolean
  inviter?: string
} = {}) {
  await i18n.changeLanguage('en')
  const store = createEspaceStore(
    { baseUrl: 'https://matrix.example.test', userId: ME, deviceId: 'DEVICE', accessToken: 'test' },
    vi.fn(async () => new Response('{}')),
    { cache: null }
  )
  stores.push(store)
  const client = matrixClientForTests(store)
  const room = new Room(ROOM, client, ME, { pendingEventOrdering: PendingEventOrdering.Detached })
  room.name = 'Alice'
  const state = (type: string, content: Record<string, unknown>, key = '') =>
    new MatrixEvent({ type, state_key: key, room_id: ROOM, sender: inviter, content })
  room.currentState.setStateEvents([
    state('m.room.create', { creator: inviter }),
    state('m.room.member', { membership: 'join', displayname: 'Alice' }, inviter),
    state('m.room.member', { membership: 'invite', ...(direct ? { is_direct: true } : {}) }, ME),
    ...(named ? [state('m.room.name', { name: 'Planning' })] : []),
    ...(encrypted ? [state('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' })] : []),
  ])
  room.updateMyMembership('invite')
  vi.spyOn(client, 'getRoom').mockReturnValue(room)
  vi.spyOn(client, 'getRooms').mockReturnValue([room])
  vi.spyOn(client, 'startClient').mockResolvedValue(undefined)
  vi.spyOn(client, 'stopClient').mockImplementation(() => undefined)
  vi.spyOn(client, 'getSyncState').mockReturnValue(SyncState.Prepared)
  vi.spyOn(client, 'getProfileInfo').mockResolvedValue({})
  let data: Record<string, string[]> = { '@bob:example.test': ['!old:example.test'] }
  vi.spyOn(client, 'getAccountData').mockImplementation(
    () => new MatrixEvent({ type: 'm.direct', content: data }) as never
  )
  const setAccountData = vi
    .spyOn(client, 'setAccountData')
    .mockImplementation(async (_type, content) => {
      data = content as Record<string, string[]>
      client.emit(
        ClientEvent.AccountData,
        new MatrixEvent({ type: 'm.direct', content }),
        undefined
      )
      return {}
    })
  const join = vi.spyOn(client, 'joinRoom').mockImplementation(async () => {
    room.updateMyMembership('join')
    client.emit(RoomEvent.MyMembership, room, 'join', 'invite')
    return room
  })
  const leave = vi.spyOn(client, 'leave').mockResolvedValue({})
  await store.start()
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  await vi.waitFor(() => expect(store.getSnapshot().invites).toHaveLength(1))
  return { store, client, room, setAccountData, join, leave }
}

it('shows a real recipient invite, accepts it, preserves m.direct and lists the joined conversation', async () => {
  const { store, join, setAccountData } = await invited()
  const select = vi.fn()
  render(<DirectMessages store={store} activeRoomId={null} onSelect={select} searchEntries={[]} />)
  expect(screen.getByText('Pending invitations (1)')).toBeVisible()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Accept and join' }))
  await waitFor(() => expect(select).toHaveBeenCalledWith(ROOM))
  expect(join).toHaveBeenCalledExactlyOnceWith(ROOM)
  expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
    '@bob:example.test': ['!old:example.test'],
    [ALICE]: [ROOM],
  })
  expect(screen.getByRole('button', { name: 'Alice' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Accept and join' })).not.toBeInTheDocument()
})

it('recognises an unnamed two-person legacy DM and leaves a named room as a room invite', async () => {
  const legacy = await invited({ direct: false })
  expect(legacy.store.getSnapshot().invites[0]?.direct).toBe(true)
  const named = await invited({ direct: false, named: true })
  expect(named.store.getSnapshot().invites[0]?.direct).toBe(false)
  await named.store.acceptInvite(ROOM)
  expect(named.join).toHaveBeenCalledWith(ROOM)
  expect(named.setAccountData).not.toHaveBeenCalled()
})

it('keeps an account-data failure actionable and allows a retry without joining first', async () => {
  const { store, join, setAccountData } = await invited()
  setAccountData.mockRejectedValueOnce(new Error('offline'))
  render(<DirectMessages store={store} activeRoomId={null} onSelect={vi.fn()} searchEntries={[]} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Accept and join' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Could not update this invitation')
  expect(join).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Accept and join' }))
  await waitFor(() => expect(join).toHaveBeenCalledTimes(1))
})

it('declines without joining or changing m.direct and deduplicates concurrent actions', async () => {
  const { store, leave, join, setAccountData } = await invited()
  const first = store.declineInvite(ROOM)
  expect(store.declineInvite(ROOM)).toBe(first)
  await first
  expect(leave).toHaveBeenCalledExactlyOnceWith(ROOM)
  expect(join).not.toHaveBeenCalled()
  expect(setAccountData).not.toHaveBeenCalled()
})

it('does not weaken confidential room quarantine when accepting an invitation', async () => {
  const { store, client } = await invited({ encrypted: true })
  const send = vi.spyOn(client, 'sendMessage')
  await store.acceptInvite(ROOM)
  await vi.waitFor(() => expect(store.getSnapshot().rooms).toHaveLength(1))
  expect(store.canSendMessage(ROOM)).toBe(false)
  await expect(store.send(ROOM, 'secret')).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})

it('counts Matrix invites in the bell and renders actionable invitations in the panel', async () => {
  const { store, join } = await invited()
  const source = new NotificationFeed(async () => ({ data: [] }))
  render(<NotificationCenter source={source} store={store} onSelectInvite={vi.fn()} />)
  const bell = screen.getByRole('button', { name: /1/ })
  await userEvent.setup().click(bell)
  const panel = screen.getByRole('dialog')
  expect(within(panel).getByText('Pending invitations (1)')).toBeVisible()
  await act(async () => {
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Accept and join' }))
  })
  expect(join).toHaveBeenCalledWith(ROOM)
})

it('excludes service accounts from legacy unnamed two-person direct invite detection and m.direct', async () => {
  for (const service of ['@kodera-agent:example.test', '@room-access:example.test']) {
    const entry = await invited({ direct: false, inviter: service })
    expect(entry.store.getSnapshot().invites[0]?.direct).toBe(false)
    await entry.store.acceptInvite(ROOM)
    expect(entry.join).toHaveBeenCalledWith(ROOM)
    expect(entry.setAccountData).not.toHaveBeenCalled()
  }
})

it('sanitizes bidi/confusable invitation titles, isolates inviter MXIDs, falls back for Empty room/UUIDs, and binds button aria-describedby per row', async () => {
  await i18n.changeLanguage('en')
  const invites: readonly InviteView[] = [
    {
      roomId: '!bidi:example.test',
      name: 'Alice\u202E Spoof',
      inviter: '@alice\u202E:example.test',
      direct: true,
    },
    {
      roomId: '!confusable:example.test',
      name: '＠admin։host',
      inviter: '@mallory:example.test',
      direct: true,
    },
    {
      roomId: '!empty-uuid:example.test',
      name: 'Empty room',
      inviter: '@ce239589-a4bd-41db-9cfb-d06e66a77ff3:example.test',
      direct: true,
    },
    {
      roomId: '!roomid-uuid:example.test',
      name: '!roomid-uuid:example.test',
      inviter: '@88aa1122-a4bd-41db-9cfb-d06e66a77ff3:example.test',
      direct: true,
    },
    {
      roomId: '!room-bidi:example.test',
      name: 'Planning\u202E Room',
      inviter: '@lead:example.test',
      direct: false,
    },
    {
      roomId: '!room-fallback:example.test',
      name: '\u202E   ',
      inviter: '@lead:example.test',
      direct: false,
    },
  ]
  const fakeStore = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ status: 'live' as const, rooms: [], invites, channels: new Map() }),
    acceptInvite: vi.fn(async () => undefined),
    declineInvite: vi.fn(async () => undefined),
  } as unknown as EspaceStoreLike

  render(<PendingInvitations store={fakeStore} onSelect={vi.fn()} />)

  const expectedTitles = [
    'Alice Spoof',
    'Mallory',
    'Member · ce23',
    'Member · 88aa',
    'Planning Room',
    '!room-fallback:example.test',
  ]
  for (const title of expectedTitles) {
    expect(screen.getByText(title)).toBeVisible()
  }
  expect(screen.queryByText(/＠admin/)).toBeNull()
  expect(screen.queryByText('Empty room')).toBeNull()

  const bdi = screen.getByText('@alice:example.test')
  expect(bdi.tagName.toLowerCase()).toBe('bdi')
  expect(bdi).toHaveAttribute('dir', 'ltr')

  const acceptButtons = screen.getAllByRole('button', { name: 'Accept and join' })
  const declineButtons = screen.getAllByRole('button', { name: 'Decline' })
  expect(acceptButtons).toHaveLength(expectedTitles.length)
  expect(declineButtons).toHaveLength(expectedTitles.length)

  acceptButtons.forEach((button, index) => {
    const labelId = button.getAttribute('aria-describedby')
    expect(labelId).toBeTruthy()
    expect(declineButtons[index]).toHaveAttribute('aria-describedby', labelId)
    expect(document.getElementById(labelId!)?.textContent).toBe(expectedTitles[index])
  })
})
