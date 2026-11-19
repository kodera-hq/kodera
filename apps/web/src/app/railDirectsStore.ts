// The direct conversations the module rail pops under its « Messages privés » button (Discord
// style): the live workspace view publishes them while it is mounted, the rail reads them. The
// rail lives in the shell, outside the view, so the two meet here and import nothing of each other.

import { useSyncExternalStore } from 'react'
import type { AvatarCache } from '../features/espace/matrix/avatarCache'

export interface RailDirect {
  roomId: string
  name: string
  /** The other person, for a one-to-one conversation: their initials' tone. */
  userId?: string | undefined
  avatarMxc?: string | undefined
  unread: number
  /** The conversation on screen. */
  active: boolean
}

export interface RailDirects {
  items: readonly RailDirect[]
  avatars?: AvatarCache | undefined
  onOpen: (roomId: string) => void
  /** The rail's « Messages privés » button: the list of conversations, or a new one. */
  onOpenAll: () => void
}

/** At most this many faces under the button: the unread ones first, then the one on screen. */
export const RAIL_DIRECT_LIMIT = 5

let current: RailDirects | null = null
const listeners = new Set<() => void>()

export function publishRailDirects(next: RailDirects | null): void {
  if (current === next) return
  current = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useRailDirects(): RailDirects | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
}

/** The faces the rail draws: unread conversations, most unread first, and the active one. */
export function railFaces(items: readonly RailDirect[]): RailDirect[] {
  return items
    .filter((item) => item.unread > 0 || item.active)
    .sort((a, b) => b.unread - a.unread || Number(b.active) - Number(a.active))
    .slice(0, RAIL_DIRECT_LIMIT)
}
