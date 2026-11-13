// Searching the channel's loaded messages from its header (`searchMatching.ts` is the matching):
// a popover with one field and the messages that hold every word, newest first; choosing one
// brings it into sight in the log. The count is announced politely as the member types.

import { useDeferredValue, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { Popover } from '../../ui/Popover/Popover'
import { TextField } from '../../ui/TextField/TextField'
import type { EspaceStoreLike } from './liveViewModel'
import { MAX_RESULTS, queryTerms, searchMessages } from './searchMatching'
import { MessageJumpButton } from './PinnedMessages'

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

export function MessageSearch({
  store,
  roomId,
  onShow,
}: {
  store: EspaceStoreLike
  roomId: string
  /** Brings the message into sight in the log; false when it is no longer loaded. */
  onShow: (eventId: string) => boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(false)
  // Typing stays responsive in a long channel: the list follows a beat behind the field.
  const deferred = useDeferredValue(query)
  useSyncExternalStore(store.subscribe, store.getSnapshot)
  const searching = open && queryTerms(deferred).length > 0
  const result = searching ? searchMessages(store.getTimeline(roomId), deferred) : null

  function choose(eventId: string) {
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
      label={t('console.workspace.find.action-open')}
      trigger={
        <Button
          variant="tertiary"
          size="sm"
          icon={<SearchIcon />}
          iconOnly
          aria-label={t('console.workspace.find.action-open')}
          data-testid="espace-find-trigger"
        />
      }
    >
      <div className="flex w-[320px] max-w-full flex-col gap-2">
        <TextField
          label={t('console.workspace.find.field-label')}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          help={t('console.workspace.find.hint')}
          autoComplete="off"
        />
        <p role="status" aria-live="polite" className="text-sm text-c-ink-2">
          {result === null
            ? null
            : result.messages.length === 0
              ? t('console.workspace.find.empty')
              : t('console.workspace.find.count-results', { count: result.messages.length })}
        </p>
        {result !== null && result.messages.length > 0 ? (
          <ul className="flex max-h-[384px] flex-col gap-1 overflow-y-auto">
            {result.messages.map((message) => (
              <li key={message.key}>
                <MessageJumpButton message={message} onChoose={choose} />
              </li>
            ))}
          </ul>
        ) : null}
        {result?.more ? (
          <p className="text-xs text-c-ink-3">
            {t('console.workspace.find.label-more', { count: MAX_RESULTS })}
          </p>
        ) : null}
      </div>
    </Popover>
  )
}
