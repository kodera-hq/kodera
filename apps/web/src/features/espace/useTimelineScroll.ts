// The message log's scrolling. It opens on the newest message and stays there while new ones
// arrive, unless the member scrolled up to read. It keeps the member's place when older messages
// are added above, and asks for them at the top, or at once while the log does not fill its height.

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { History } from './matrix/store'

/** How near an edge, in pixels, still counts as at it. */
export const EDGE_PX = 64

export function useTimelineScroll({
  roomId,
  timeline,
  history,
  loadOlder,
}: {
  roomId: string | null
  /** The room's messages: a new array is a change to draw. */
  timeline: readonly unknown[]
  history: History | undefined
  loadOlder: ((roomId: string) => Promise<void>) | undefined
}) {
  const ref = useRef<HTMLDivElement>(null)
  /** The log's height below the member's place, kept while older messages are asked for. */
  const fromBottom = useRef<number | null>(null)
  /** The member is reading the newest messages: new ones keep the log at the bottom. */
  const pinned = useRef(true)
  const shownRoom = useRef<string | null>(null)

  const older = useCallback(() => {
    const log = ref.current
    if (log === null || roomId === null || loadOlder === undefined) return
    if (history !== 'more' && history !== 'failed') return
    fromBottom.current = log.scrollHeight - log.scrollTop
    void loadOlder(roomId)
  }, [roomId, history, loadOlder])

  useLayoutEffect(() => {
    const log = ref.current
    if (log === null) return
    if (shownRoom.current !== roomId) {
      shownRoom.current = roomId
      pinned.current = true
      fromBottom.current = null
    }
    if (fromBottom.current !== null) {
      log.scrollTop = log.scrollHeight - fromBottom.current
      if (history !== 'loading') fromBottom.current = null
    } else if (pinned.current) {
      log.scrollTop = log.scrollHeight
    }
  }, [roomId, timeline, history])

  // A log shorter than its height has no top to scroll to.
  useEffect(() => {
    const log = ref.current
    if (log !== null && history === 'more' && log.scrollHeight <= log.clientHeight) older()
  }, [timeline, history, older])

  const onScroll = useCallback(() => {
    const log = ref.current
    if (log === null) return
    pinned.current = log.scrollHeight - log.scrollTop - log.clientHeight < EDGE_PX
    if (log.scrollTop < EDGE_PX && history === 'more') older()
  }, [history, older])

  return { ref, onScroll, older }
}
