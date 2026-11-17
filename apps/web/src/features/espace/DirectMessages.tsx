// The sidebar's direct conversations (docs/specs/messaging-media-and-notifications.md): the rooms
// `m.direct` lists, joined, and a field to start one with one to eight people by Matrix id.

import { lazy, Suspense, useCallback, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import type { EspaceStoreLike } from './liveViewModel'
import type { DirectSummary } from './matrix/directs'
import { useStoreSlice } from './useStoreSlice'

const NONE: readonly DirectSummary[] = []

// Chosen only when « Nouveau » is pressed: the picker and its roster never weigh on opening the
// workspace, and the dialog's chunk is fetched on the click that needs it.
const LazyDirectMessageDialog = lazy(() =>
  import('./DirectMessageDialog').then((module) => ({ default: module.DirectMessageDialog }))
)

export interface DirectMessagesProps {
  store: EspaceStoreLike
  activeRoomId: string | null
  onSelect: (roomId: string) => void
  /** Every channel of the workspace: where the picker gathers the people to choose from. */
  searchEntries: readonly ChannelSearchEntry[]
}

export function DirectMessages({
  store,
  activeRoomId,
  onSelect,
  searchEntries,
}: DirectMessagesProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const directsOf = useCallback(() => store.getDirects?.() ?? NONE, [store])
  const directs = useStoreSlice(store.subscribe, store.getSnapshot, directsOf)
  const [composing, setComposing] = useState(false)

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1 border-t border-c-border-soft pt-2"
    >
      <div className="flex items-center justify-between gap-2 px-2">
        <h3 id={headingId} className="text-xs font-semibold text-c-ink-3">
          {t('console.workspace.directs.title')}
        </h3>
        {store.openDirect === undefined ? null : (
          <Button variant="secondary" size="sm" onClick={() => setComposing(true)}>
            {t('console.workspace.directs.action-new')}
          </Button>
        )}
      </div>
      {composing ? (
        <Suspense fallback={null}>
          <LazyDirectMessageDialog
            open
            onOpenChange={setComposing}
            store={store}
            searchEntries={searchEntries}
            onOpened={onSelect}
          />
        </Suspense>
      ) : null}
      {directs.length === 0 ? (
        <p className="px-2 text-xs text-c-ink-3">{t('console.workspace.directs.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {directs.map((direct) => (
            <li key={direct.roomId}>
              <button
                type="button"
                aria-current={direct.roomId === activeRoomId ? 'page' : undefined}
                onClick={() => onSelect(direct.roomId)}
                className={cx(
                  'flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                  'hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
                  direct.roomId === activeRoomId
                    ? 'bg-c-accent-soft text-c-accent-ink'
                    : 'text-c-ink-2'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{direct.name}</span>
                {direct.unread > 0 ? (
                  <span className="min-w-5 shrink-0 rounded-full bg-c-action px-1 text-center text-xs font-bold text-c-on-inverse tabular-nums">
                    <span className="sr-only">
                      {t('console.workspace.directs.label-unread', {
                        count: String(direct.unread),
                      })}
                    </span>
                    <span aria-hidden="true">{direct.unread}</span>
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
