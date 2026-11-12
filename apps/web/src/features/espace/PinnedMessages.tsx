// A channel's pinned messages (`m.room.pinned_events`), from the channel's header: a popover that
// lists them, the most recently pinned first, and brings the one chosen into sight in the log
// (`MessageTimelineHandle.showMessage`). A pin older than the loaded history is listed and said
// to be so: the room still has it, this screen has not read that far back.

import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { Popover } from '../../ui/Popover/Popover'
import { NO_MESSAGES, nameOf, type EspaceStoreLike } from './liveViewModel'
import { excerptOf } from './searchMatching'
import type { MessageView } from './matrix/timeline'

const NO_PINS: readonly string[] = []

function PinIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z" />
      <path d="M12 14v6" />
    </svg>
  )
}

/** One result row: the author, the time and a line of the message; choosing it shows the message. */
export function MessageJumpButton({
  message,
  onChoose,
}: {
  message: MessageView
  onChoose: (eventId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const iso = new Date(message.ts).toISOString()
  return (
    <button
      type="button"
      onClick={() => onChoose(message.eventId)}
      className="flex w-full min-w-0 flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
    >
      <span className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="min-w-0 truncate font-semibold text-c-ink">{nameOf(message)}</span>
        <time dateTime={iso} className="shrink-0 text-xs text-c-ink-3">
          {formatTime(iso, locale)}
        </time>
      </span>
      <span className="line-clamp-2 text-sm break-words text-c-ink-2">
        {message.redacted ? t('console.workspace.message.label-deleted') : excerptOf(message.body)}
      </span>
    </button>
  )
}

export function PinnedMessages({
  store,
  roomId,
  onShow,
}: {
  store: EspaceStoreLike
  roomId: string
  /** Brings the message into sight in the log; false when it is not loaded. */
  onShow: (eventId: string) => boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false)
  useSyncExternalStore(store.subscribe, store.getSnapshot)
  const pins = store.getPinned?.(roomId) ?? NO_PINS
  const timeline = open ? store.getTimeline(roomId) : NO_MESSAGES
  const loaded = new Map<string, MessageView>()
  if (open)
    for (const message of timeline)
      if (!loaded.has(message.eventId)) loaded.set(message.eventId, message)

  function choose(eventId: string) {
    // The popover closes first: the message then takes the focus, not the trigger.
    setShown(true)
    setOpen(false)
    onShow(eventId)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setShown(false)
        setOpen(next)
      }}
      onCloseAutoFocus={(event) => {
        if (shown) event.preventDefault()
      }}
      align="end"
      label={t('console.workspace.pins.title')}
      trigger={
        <Button
          variant="tertiary"
          size="sm"
          icon={<PinIcon />}
          iconOnly
          aria-label={t('console.workspace.pins.action-open', { count: pins.length })}
          data-testid="espace-pins-trigger"
        />
      }
    >
      <div className="flex w-80 max-w-full flex-col gap-2">
        <h2 className="text-sm font-semibold text-c-ink">{t('console.workspace.pins.title')}</h2>
        {pins.length === 0 ? (
          <p className="text-sm text-c-ink-3">{t('console.workspace.pins.empty')}</p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
            {[...pins].reverse().map((eventId) => {
              const message = loaded.get(eventId)
              return (
                <li key={eventId}>
                  {message === undefined ? (
                    <p className="px-2 py-2 text-sm text-c-ink-3">
                      {t('console.workspace.pins.not-loaded')}
                    </p>
                  ) : (
                    <MessageJumpButton message={message} onChoose={choose} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Popover>
  )
}
