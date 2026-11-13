// Direct conversations, as Matrix keeps them (client-server API, `m.direct` account data): a map
// from another person's user id to the rooms held with them. A group conversation is one room
// listed under each of its people. This module reads that map and writes the next one; the store
// does the talking (docs/specs/messaging-media-and-notifications.md).

import { isMatrixUserId } from '../roomInvitations'

/** A direct conversation the member is in. */
export interface DirectSummary {
  roomId: string
  /** The other people, by Matrix id, sorted. */
  userIds: readonly string[]
  /** Their names as the room knows them, else their ids, joined. */
  name: string
  unread: number
}

/** At most this many other people in a group conversation started here. */
export const MAX_DIRECT_PEOPLE = 8

/** The `m.direct` map, checked: user ids that are ids, room ids that are room ids. */
export function directMap(content: unknown): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return map
  for (const [userId, rooms] of Object.entries(content as Record<string, unknown>)) {
    if (!isMatrixUserId(userId) || !Array.isArray(rooms)) continue
    const roomIds = rooms.filter(
      (room): room is string => typeof room === 'string' && /^![^\s:]+:\S+$/u.test(room)
    )
    if (roomIds.length > 0) map.set(userId, [...new Set(roomIds)])
  }
  return map
}

/** Each listed room, with the people it is listed under. */
export function directRooms(map: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const rooms = new Map<string, string[]>()
  for (const [userId, roomIds] of map) {
    for (const roomId of roomIds) rooms.set(roomId, [...(rooms.get(roomId) ?? []), userId])
  }
  for (const people of rooms.values()) people.sort()
  return rooms
}

/** The people a new conversation is with: valid ids, not the member, each once, at most eight. */
export function directPeople(userIds: readonly string[], me: string): string[] {
  const people = [...new Set(userIds.map((id) => id.trim()))].filter((id) => id !== me)
  if (people.length === 0 || people.length > MAX_DIRECT_PEOPLE) {
    throw new Error('A direct conversation is with one to eight other people')
  }
  if (!people.every(isMatrixUserId)) throw new Error('Invalid Matrix user ID')
  return people.sort()
}

/** The joined room already held with exactly these people, if any. */
export function existingDirect(
  rooms: ReadonlyMap<string, readonly string[]>,
  people: readonly string[],
  joined: (roomId: string) => boolean
): string | undefined {
  const wanted = people.join('\n')
  for (const [roomId, listed] of rooms) {
    if (joined(roomId) && listed.join('\n') === wanted) return roomId
  }
  return undefined
}

/** The map once `roomId` is listed under each of `people`, as an object for account data. */
export function withDirect(
  map: ReadonlyMap<string, readonly string[]>,
  roomId: string,
  people: readonly string[]
): Record<string, string[]> {
  const next: Record<string, string[]> = {}
  for (const [userId, roomIds] of map) next[userId] = [...roomIds]
  for (const userId of people) {
    next[userId] = [...new Set([...(next[userId] ?? []), roomId])]
  }
  return next
}
