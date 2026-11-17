// The bell beside the organisation's name: the member's notifications, how many are unread, and
// this browser's Web Push switch (docs/specs/messaging-media-and-notifications.md).

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Popover } from '../../ui/Popover/Popover'
import { Switch } from '../../ui/Switch/Switch'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import type { EspaceStoreLike } from '../espace/liveViewModel'
import { PendingInvitations } from '../espace/PendingInvitations'
import { NotificationFeed, POLL_MS, type Notification } from './notificationFeed'
import { currentSubscription, disablePush, enablePush, pushSupported } from './push'

const feed = new NotificationFeed()
const subscribeToNone = () => () => undefined
const noSnapshot = () => undefined

function BellIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

function usePolling(source: NotificationFeed) {
  useEffect(() => {
    void source.refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void source.refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [source])
}

function PushSwitch() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [problem, setProblem] = useState(false)
  useEffect(() => {
    let live = true
    void currentSubscription().then(
      (subscription) => live && setEnabled(subscription !== null),
      () => live && setEnabled(false)
    )
    return () => {
      live = false
    }
  }, [])
  if (!pushSupported()) {
    return (
      <p className="text-xs text-c-ink-3">
        {t('console.workspace.notifications.push-unsupported')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <Switch
        label={t('console.workspace.notifications.push-label')}
        checked={enabled === true}
        disabled={enabled === null}
        onCheckedChange={(next) => {
          setProblem(false)
          const change = next
            ? enablePush({
                title: t('console.workspace.notifications.push-title'),
                body: t('console.workspace.notifications.push-body'),
              })
            : disablePush()
          void change.then(
            () => setEnabled(next),
            () => {
              setProblem(true)
              setEnabled(!next)
            }
          )
        }}
      />
      <p className="text-xs text-c-ink-3">{t('console.workspace.notifications.push-hint')}</p>
      {problem ? (
        <p role="status" className="text-xs text-c-bad-ink">
          {t('console.workspace.notifications.push-problem')}
        </p>
      ) : null}
    </div>
  )
}

function when(iso: string, language: string | undefined): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso)
  )
}

function NotificationItem({ item }: { item: Notification }) {
  const { t, i18n } = useTranslation()
  const label = {
    mention: t('console.workspace.notifications.kind-mention'),
    invitation: t('console.workspace.notifications.kind-invitation'),
    moderation: t('console.workspace.notifications.kind-moderation'),
    document: t('console.workspace.notifications.kind-document'),
  }[item.kind]
  return (
    <li className="flex items-start gap-2 py-2">
      <span
        aria-hidden="true"
        className={cx(
          'mt-2 h-2 w-2 shrink-0 rounded-full',
          item.readAt === null ? 'bg-c-accent-ink' : 'bg-transparent'
        )}
      />
      <span className="flex min-w-0 flex-col">
        <span
          className={cx(
            'text-sm',
            item.readAt === null ? 'font-semibold text-c-ink' : 'text-c-ink-2'
          )}
        >
          {label}
          {item.readAt === null ? (
            <span className="sr-only"> {t('console.workspace.notifications.label-unread')}</span>
          ) : null}
        </span>
        <span className="text-xs text-c-ink-3">{when(item.createdAt, i18n.resolvedLanguage)}</span>
      </span>
    </li>
  )
}

export function NotificationCenter({
  source = feed,
  store,
  onSelectInvite,
}: {
  source?: NotificationFeed
  store?: EspaceStoreLike
  onSelectInvite?: ((roomId: string) => void) | undefined
}) {
  const { t } = useTranslation()
  usePolling(source)
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const matrix = useSyncExternalStore(
    store?.subscribe ?? subscribeToNone,
    store?.getSnapshot ?? noSnapshot
  )
  const unread = snapshot.unread + (matrix?.invites.length ?? 0)
  const label =
    unread === 0
      ? t('console.workspace.notifications.action-open')
      : t('console.workspace.notifications.action-open-unread', { count: String(unread) })
  return (
    <Popover
      label={t('console.workspace.notifications.title')}
      align="start"
      trigger={
        <button
          type="button"
          aria-label={label}
          className={cx(
            'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3',
            'hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
            TOUCH_TARGET
          )}
        >
          <BellIcon />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 min-w-5 rounded-full bg-c-action px-1 text-center text-xs font-bold text-c-on-inverse tabular-nums"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      }
    >
      <div className="flex w-[320px] flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-c-ink">
            {t('console.workspace.notifications.title')}
          </h2>
          <Button
            variant="secondary"
            size="sm"
            disabled={snapshot.unread === 0}
            onClick={() => void source.markAllRead()}
          >
            {t('console.workspace.notifications.action-mark-read')}
          </Button>
        </div>
        {snapshot.status === 'unavailable' ? (
          <p role="status" className="text-sm text-c-ink-2">
            {t('console.workspace.notifications.problem-unavailable')}
          </p>
        ) : null}
        {store === undefined || onSelectInvite === undefined ? null : (
          <PendingInvitations store={store} onSelect={onSelectInvite} />
        )}
        {snapshot.items.length === 0 &&
        (matrix?.invites.length ?? 0) === 0 &&
        snapshot.status === 'ready' ? (
          <p className="text-sm text-c-ink-2">{t('console.workspace.notifications.empty')}</p>
        ) : (
          <ul className="max-h-[320px] divide-y divide-c-border-soft overflow-y-auto">
            {snapshot.items.map((item) => (
              <NotificationItem key={item.id} item={item} />
            ))}
          </ul>
        )}
        <PushSwitch />
      </div>
    </Popover>
  )
}
