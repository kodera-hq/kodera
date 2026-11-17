// Who is in the workspace, as one list. The Matrix layer knows a room's members, never a
// workspace's: `getRoster` answers per room. The union over every resolved channel is the closest
// thing to a member directory this client can build without a new Core surface, and it is what a
// member means by « the people here » when starting a direct conversation.

import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import type { EspaceSnapshot, MemberView } from './matrix/store'
import type { EspaceStoreLike } from './liveViewModel'

export interface WorkspaceMember {
  readonly userId: string
  /** The name the rooms hold, where one of them holds a human one. */
  readonly name?: string | undefined
  /** The channels this member was seen in, by label: what tells two strangers apart. */
  readonly channels: readonly string[]
}

/**
 * Every member of every resolved channel but the viewer, by name. A member seen in several
 * channels appears once, carrying all of them.
 */
export function workspaceRosterOf(
  store: EspaceStoreLike,
  snapshot: EspaceSnapshot,
  searchEntries: readonly ChannelSearchEntry[],
  viewerId: string
): readonly WorkspaceMember[] {
  const byId = new Map<string, { member: MemberView; channels: string[] }>()
  for (const channel of searchEntries) {
    const resolved = snapshot.channels.get(channel.id)
    if (resolved?.state !== 'resolved') continue
    for (const member of store.getRoster?.(resolved.roomId) ?? []) {
      if (member.userId === viewerId) continue
      const held = byId.get(member.userId)
      if (held === undefined) {
        byId.set(member.userId, { member, channels: [channel.label] })
        continue
      }
      if (!held.channels.includes(channel.label)) held.channels.push(channel.label)
      // A room that holds a name wins over one that holds none.
      if (held.member.name === undefined && member.name !== undefined) held.member = member
    }
  }
  return [...byId.values()]
    .map(({ member, channels }) => ({
      userId: member.userId,
      ...(member.name === undefined ? {} : { name: member.name }),
      channels,
    }))
    .sort((a, b) => (a.name ?? a.userId).localeCompare(b.name ?? b.userId))
}

/** Asks each resolved channel's room for its whole member list, once; the roster grows as they answer. */
export function loadWorkspaceRoster(
  store: EspaceStoreLike,
  snapshot: EspaceSnapshot,
  searchEntries: readonly ChannelSearchEntry[]
): void {
  for (const channel of searchEntries) {
    const resolved = snapshot.channels.get(channel.id)
    if (resolved?.state === 'resolved') store.loadMembers?.(resolved.roomId)
  }
}

/** The members a search term leaves; matched on the name, the id and the channels they are in. */
export function filterWorkspaceRoster(
  members: readonly WorkspaceMember[],
  term: string
): readonly WorkspaceMember[] {
  const needle = term.trim().toLocaleLowerCase()
  if (needle === '') return members
  return members.filter(
    (member) =>
      (member.name ?? '').toLocaleLowerCase().includes(needle) ||
      member.userId.toLocaleLowerCase().includes(needle) ||
      member.channels.some((channel) => channel.toLocaleLowerCase().includes(needle))
  )
}
