import { MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createEspaceStore, matrixClientForTests } from './store'

const session = {
  baseUrl: 'https://matrix.example.test',
  userId: '@me:example.test',
  deviceId: 'DEVICE',
  accessToken: 'test-token',
}
const ALICE = '@alice:example.test'
const BOB = '@bob:example.test'

function setup(direct: Record<string, string[]>) {
  const store = createEspaceStore(session, vi.fn<typeof fetch>())
  const client = matrixClientForTests(store)
  const accountData = new MatrixEvent({ type: 'm.direct', content: direct })
  vi.spyOn(client, 'getAccountData').mockReturnValue(accountData)
  const createRoom = vi
    .spyOn(client, 'createRoom')
    .mockResolvedValue({ room_id: '!new:example.test' })
  const setAccountData = vi.spyOn(client, 'setAccountData').mockResolvedValue({})
  const sendStateEvent = vi
    .spyOn(client, 'sendStateEvent')
    .mockResolvedValue({ event_id: '$visibility' })
  return { store, client, createRoom, setAccountData, sendStateEvent }
}

describe('direct conversations in the store', () => {
  it('opens the joined conversation already held with the same people', async () => {
    const { store, client, createRoom } = setup({ [ALICE]: ['!a:example.test'] })
    const room = new Room('!a:example.test', client, session.userId)
    vi.spyOn(room, 'getMyMembership').mockReturnValue('join')
    vi.spyOn(client, 'getRoom').mockReturnValue(room)
    await expect(store.openDirect([ALICE])).resolves.toBe('!a:example.test')
    expect(createRoom).not.toHaveBeenCalled()
  })

  it('creates a direct message the Kodera room policy admits: one invitee, no initial state', async () => {
    const { store, client, createRoom, sendStateEvent } = setup({})
    vi.spyOn(client, 'getRoom').mockReturnValue(null)
    await expect(store.openDirect([ALICE])).resolves.toBe('!new:example.test')
    // The conditions of packages/synapse-policy `_is_direct_message`, which refuses anything else.
    const [options] = createRoom.mock.calls[0]!
    expect(options).toEqual({ is_direct: true, invite: [ALICE], preset: 'private_chat', visibility: 'private' })
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!new:example.test',
      'm.room.history_visibility',
      { history_visibility: 'invited' },
      ''
    )
  })

  it('creates a private group room, invites everyone and lists it under each of them', async () => {
    const { store, client, createRoom, setAccountData, sendStateEvent } = setup({ [ALICE]: ['!a:example.test'] })
    vi.spyOn(client, 'getRoom').mockReturnValue(null)
    await expect(store.openDirect([BOB, ALICE, session.userId])).resolves.toBe('!new:example.test')
    expect(createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ is_direct: true, invite: [ALICE, BOB], visibility: 'private' })
    )
    // Invitees are not made administrators (`trusted_private_chat` would give each of them the
    // creator's power level), and someone invited later reads nothing sent before their invite.
    const [options] = createRoom.mock.calls[0]!
    expect(options.preset).toBe('private_chat')
    expect(options.power_level_content_override).toBeUndefined()
    expect(options.initial_state).toBeUndefined()
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!new:example.test',
      'm.room.history_visibility',
      { history_visibility: 'invited' },
      ''
    )
    expect(setAccountData).toHaveBeenCalledWith('m.direct', {
      [ALICE]: ['!a:example.test', '!new:example.test'],
      [BOB]: ['!new:example.test'],
    })
  })

  it('refuses an invalid id before anything is sent', async () => {
    const { store, createRoom } = setup({})
    await expect(store.openDirect(['alice'])).rejects.toThrow('Invalid Matrix user ID')
    expect(createRoom).not.toHaveBeenCalled()
  })

  it('lists only the rooms the member has joined', () => {
    const { store } = setup({ [ALICE]: ['!a:example.test'] })
    expect(store.getDirects()).toEqual([])
    expect(store.getDirects()).toBe(store.getDirects())
  })
})
