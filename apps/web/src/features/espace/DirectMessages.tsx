// The sidebar's direct conversations (docs/specs/messaging-media-and-notifications.md): the rooms
// `m.direct` lists, joined, and a field to start one with one to eight people by Matrix id.

import { useCallback, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { TextField } from '../../ui/TextField/TextField'
import type { EspaceStoreLike } from './liveViewModel'
import type { DirectSummary } from './matrix/directs'
import { useStoreSlice } from './useStoreSlice'

const NONE: readonly DirectSummary[] = []

export interface DirectMessagesProps {
  store: EspaceStoreLike
  activeRoomId: string | null
  onSelect: (roomId: string) => void
}

export function DirectMessages({ store, activeRoomId, onSelect }: DirectMessagesProps) {
  const { t } = useTranslation()
  const headingId = useId()
  const directsOf = useCallback(() => store.getDirects?.() ?? NONE, [store])
  const directs = useStoreSlice(store.subscribe, store.getSnapshot, directsOf)
  const [composing, setComposing] = useState(false)
  const [people, setPeople] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  function start() {
    if (store.openDirect === undefined) return
    const ids = people
      .split(/[\s,;]+/u)
      .map((id) => id.trim())
      .filter((id) => id !== '')
    setProblem('')
    setBusy(true)
    store.openDirect(ids).then(
      (roomId) => {
        setBusy(false)
        setComposing(false)
        setPeople('')
        onSelect(roomId)
      },
      (error: unknown) => {
        setBusy(false)
        setProblem(
          error instanceof Error && error.message === 'Invalid Matrix user ID'
            ? t('console.workspace.directs.problem-id')
            : t('console.workspace.directs.problem-open')
        )
      }
    )
  }

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
          <Button variant="secondary" size="sm" onClick={() => setComposing((open) => !open)}>
            {t('console.workspace.directs.action-new')}
          </Button>
        )}
      </div>
      {composing ? (
        <div className="flex flex-col gap-2 px-2">
          <TextField
            label={t('console.workspace.directs.field-people')}
            help={t('console.workspace.directs.help-people')}
            value={people}
            onChange={(event) => setPeople(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !busy) {
                event.preventDefault()
                start()
              }
            }}
          />
          <div>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || people.trim() === ''}
              onClick={start}
            >
              {t('console.workspace.directs.action-open')}
            </Button>
          </div>
        </div>
      ) : null}
      <p role="status" className="px-2 text-xs text-c-bad-ink empty:sr-only">
        {problem}
      </p>
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
