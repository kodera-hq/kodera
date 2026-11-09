import { ClientEvent, MatrixEvent, Room, SyncState } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'
import { createEspaceStore, matrixClientForTests } from './store'

const session = {
  baseUrl: 'https://matrix.example.test',
  userId: '@me:example.test',
  deviceId: 'DEVICE',
  accessToken: 'test-token',
}

describe('session presence received through sync', () => {
  it('keeps self in the human roster, out of mentions, and hides service accounts', () => {
    const store = createEspaceStore(session, vi.fn<typeof fetch>())
    const client = matrixClientForTests(store)
    const room = new Room('!room:example.test', client, session.userId)
    vi.spyOn(room, 'getMyMembership').mockReturnValue('join')
    room.currentState.setStateEvents(
      [session.userId, '@kodera-agent:example.test', '@room-access:example.test'].map(
        (userId) =>
          new MatrixEvent({
            type: 'm.room.member',
            state_key: userId,
            room_id: room.roomId,
            sender: userId,
            content: {
              membership: 'join',
              displayname: userId === session.userId ? 'My name' : 'Service',
            },
          })
      )
    )
    vi.spyOn(client, 'getRoom').mockReturnValue(room)
    expect(store.getRoster(room.roomId)).toEqual([{ userId: session.userId, name: 'My name' }])
    expect(store.getMembers(room.roomId)).toEqual([])
    expect(store.getRoster(room.roomId)).toBe(store.getRoster(room.roomId))
  })

  it('waits for an event, follows online and active, clears offline, and never polls', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const store = createEspaceStore(session, fetcher)
    const client = matrixClientForTests(store)
    vi.spyOn(client, 'startClient').mockResolvedValue()
    vi.spyOn(client, 'getSyncState').mockReturnValue(SyncState.Prepared)
    await store.start()
    const before = store.getSnapshot()
    const presence = (content: Record<string, unknown>) =>
      client.emit(
        ClientEvent.Event,
        new MatrixEvent({
          type: 'm.presence',
          sender: '@alice:example.test',
          content,
        })
      )
    expect(store.isOnline('@alice:example.test')).toBe(false)
    presence({ presence: 'online', status_msg: 'private text' })
    await Promise.resolve()
    expect(store.isOnline('@alice:example.test')).toBe(true)
    expect(store.getSnapshot()).not.toBe(before)
    expect(JSON.stringify(store.getSnapshot())).not.toContain('private text')
    presence({ currently_active: true })
    expect(store.isOnline('@alice:example.test')).toBe(true)
    for (const state of ['unavailable', 'offline']) {
      presence({ presence: state, currently_active: true })
      expect(store.isOnline('@alice:example.test')).toBe(false)
    }
    presence({ presence: 'online' })
    store.stop()
    expect(store.isOnline('@alice:example.test')).toBe(false)
    const nextSession = createEspaceStore(session, fetcher)
    expect(nextSession.isOnline('@alice:example.test')).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
