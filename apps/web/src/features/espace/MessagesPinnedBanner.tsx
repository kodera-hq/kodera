import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import {
  isRoomSearchPermitted,
  type ConfidentialChannelFlags,
} from '../command-palette/omniboxIndex'
import type { EspaceStoreLike } from './liveViewModel'
import { excerptOf } from './searchMatching'

/** Never reveal a pin body or topic across an unclassified or protected room boundary. */
export function MessagesPinnedBanner({
  store,
  roomId,
  topic,
  flags,
  onShow,
}: {
  store: EspaceStoreLike
  roomId: string | null
  topic?: string | undefined
  flags?: ConfidentialChannelFlags | undefined
  onShow: (eventId: string) => boolean
}) {
  const { t } = useTranslation()
  useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (roomId === null || !isRoomSearchPermitted(store, roomId, flags)) return null
  const pins = store.getPinned?.(roomId) ?? []
  const pin = store
    .getTimeline(roomId)
    .findLast((message) => pins.includes(message.eventId) && !message.redacted)
  const text = pin?.body || topic
  if (!text) return null
  return (
    <div
      data-testid="messages-pinned-banner"
      className="flex shrink-0 items-center gap-3 rounded-md border-l-2 border-c-accent-ink bg-c-surface px-3 py-2 text-sm text-c-ink-2"
    >
      <KoderaIcon name="pin" />
      {pin ? (
        <button
          type="button"
          onClick={() => onShow(pin.eventId)}
          aria-label={t('console.workspace.pins.title')}
          className="min-h-8 min-w-0 flex-1 truncate text-left focus-visible:ring narrow:min-h-[44px]"
        >
          {excerptOf(text, 160)}
        </button>
      ) : (
        <p className="min-w-0 truncate">{excerptOf(text, 160)}</p>
      )}
    </div>
  )
}
