// Reading a channel clears its unread mark (the lab's defect after M1): while the channel is on
// screen and the page is visible, the newest message is sent as read. Only when the room counts
// something unread, and once per newest message, so an answer the server is slow to count is not
// asked for again on every render.

import { useEffect, useState } from 'react'
import type { RoomSummary } from './matrix/store'

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

export function useMarkRead({
  room,
  newestKey,
  store,
}: {
  /** The room shown, as the sidebar counts it; none while no room is shown. */
  room: RoomSummary | undefined
  /** The newest message's row key: a new one, while unread, is read again. */
  newestKey: string | undefined
  /** Called as a method: the store's `markRead` reads its own client. */
  store: { markRead?: (roomId: string) => Promise<void> }
}) {
  const [visible, setVisible] = useState(pageVisible)

  useEffect(() => {
    const follow = () => setVisible(pageVisible())
    document.addEventListener('visibilitychange', follow)
    return () => document.removeEventListener('visibilitychange', follow)
  }, [])

  const roomId = room?.roomId
  const unread = room === undefined ? false : room.unread > 0 || room.mentions > 0
  useEffect(() => {
    if (roomId === undefined || !unread || !visible || store.markRead === undefined) return
    // A refused or lost receipt leaves the mark; the next message, or the next visit, tries again.
    store.markRead(roomId).catch(() => undefined)
  }, [roomId, unread, visible, newestKey, store])
}
