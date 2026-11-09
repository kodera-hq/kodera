// The tab's title while Espace is open (V1 bar M9): « Espace — Kodera », and « (3) Espace —
// Kodera » while the member's rooms count unread messages, so a background tab says there is
// something to read. Leaving Espace gives the tab back its own title.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoomSummary } from './matrix/store'

/** The unread messages across the member's rooms; a room counting only mentions counts those. */
export function unreadTotal(rooms: readonly RoomSummary[]): number {
  return rooms.reduce((total, room) => total + Math.max(room.unread, room.mentions), 0)
}

export function useTabTitle(rooms: readonly RoomSummary[]) {
  const { t } = useTranslation()
  const count = unreadTotal(rooms)
  const app = t('console.common.app-title')
  const title =
    count > 0
      ? t('console.workspace.live.document-title-unread', { count, app })
      : t('console.workspace.live.document-title', { app })

  useEffect(() => {
    document.title = title
    // Unmounted, or about to show another title: the tab's own title until then.
    return () => {
      document.title = app
    }
  }, [title, app])
}
