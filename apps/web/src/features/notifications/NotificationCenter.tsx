// The bell beside the organisation's name: the member's notifications, how many are unread, and
// this browser's Web Push switch (docs/specs/messaging-media-and-notifications.md).

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { Popover } from '../../ui/Popover/Popover'
import { Switch } from '../../ui/Switch/Switch'
import { TOUCH_TARGET } from '../../ui/touchTarget'
import type { EspaceStoreLike } from '../espace/liveViewModel'
import type { RoomSummary } from '../espace/matrix/store'
import { PendingInvitations } from '../espace/PendingInvitations'
import { NotificationFeed, POLL_MS, type Notification } from './notificationFeed'
import { currentSubscription, disablePush, enablePush, pushSupported } from './push'

const feed = new NotificationFeed()
const subscribeToNone = () => () => undefined
const noSnapshot = () => undefined
const NO_ROOMS: readonly RoomSummary[] = []

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

export function PushSwitch() {
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

function NotificationItem({
  item,
  onOpen,
}: {
  item: Notification
  /** Opens what the notification is about; without it the item is only read. */
  onOpen: ((item: Notification) => void) | undefined
}) {
  const { t, i18n } = useTranslation()
  const label = {
    mention: t('console.workspace.notifications.kind-mention'),
    invitation: t('console.workspace.notifications.kind-invitation'),
    moderation: t('console.workspace.notifications.kind-moderation'),
    document: t('console.workspace.notifications.kind-document'),
  }[item.kind]
  const content = (
    <>
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
    </>
  )
  return (
    <li className="py-1">
      {onOpen === undefined ? (
        <span className="flex items-start gap-2 px-2 py-1">{content}</span>
      ) : (
        <button type="button" onClick={() => onOpen(item)} className={JUMP}>
          {content}
        </button>
      )}
    </li>
  )
}

/** An inbox line that jumps somewhere: the whole line is the button. */
const JUMP = cx(
  'flex w-full items-start gap-2 rounded-sm px-2 py-1 text-left',
  'hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden',
  TOUCH_TARGET
)

/**
 * The rooms where someone mentioned the member and they have not read it yet, from the
 * homeserver's highlight counts: each line opens its room at the unread messages.
 */
function MentionedRooms({
  rooms,
  onOpenRoom,
}: {
  rooms: readonly RoomSummary[]
  onOpenRoom: (roomId: string) => void
}) {
  const { t } = useTranslation()
  if (rooms.length === 0) return null
  return (
    <ul
      aria-label={t('console.workspace.notifications.label-mentioned-rooms')}
      className="flex flex-col"
    >
      {rooms.map((room) => (
        <li key={room.roomId} className="py-1">
          <button type="button" onClick={() => onOpenRoom(room.roomId)} className={JUMP}>
            <span
              aria-hidden="true"
              className="mt-2 h-2 w-2 shrink-0 rounded-full bg-c-accent-ink"
            />
            <span className="min-w-0 flex-1 text-sm font-semibold break-words text-c-ink">
              {t('console.workspace.notifications.mention-room', {
                channel: room.name,
                count: String(room.mentions),
              })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function NotificationCenter({
  source = feed,
  store,
  onSelectInvite,
  onOpenRoom,
  onOpenNotification,
}: {
  source?: NotificationFeed
  store?: EspaceStoreLike
  onSelectInvite?: ((roomId: string) => void) | undefined
  /** Opens a room the member was mentioned in: the inbox lists those rooms when it is given. */
  onOpenRoom?: ((roomId: string) => void) | undefined
  /** Opens what one of Core's notifications is about; it is marked read as it is opened. */
  onOpenNotification?: ((item: Notification) => void) | undefined
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  usePolling(source)
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const matrix = useSyncExternalStore(
    store?.subscribe ?? subscribeToNone,
    store?.getSnapshot ?? noSnapshot
  )
  const rooms = matrix?.rooms ?? NO_ROOMS
  const mentioned = useMemo(
    () => (onOpenRoom === undefined ? NO_ROOMS : rooms.filter((room) => room.mentions > 0)),
    [rooms, onOpenRoom]
  )
  const unread = snapshot.unread + (matrix?.invites.length ?? 0) + mentioned.length
  const jumpToRoom =
    onOpenRoom === undefined
      ? undefined
      : (roomId: string) => {
          setOpen(false)
          onOpenRoom(roomId)
        }
  const openNotification =
    onOpenNotification === undefined
      ? undefined
      : (item: Notification) => {
          setOpen(false)
          void source.markRead([item.id])
          onOpenNotification(item)
        }
  const label =
    unread === 0
      ? t('console.workspace.notifications.action-open')
      : t('console.workspace.notifications.action-open-unread', { count: String(unread) })
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
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
        {jumpToRoom === undefined ? null : (
          <MentionedRooms rooms={mentioned} onOpenRoom={jumpToRoom} />
        )}
        {snapshot.items.length === 0 &&
        (matrix?.invites.length ?? 0) === 0 &&
        mentioned.length === 0 &&
        snapshot.status === 'ready' ? (
          <p className="text-sm text-c-ink-2">{t('console.workspace.notifications.empty')}</p>
        ) : (
          <ul className="max-h-[320px] divide-y divide-c-border-soft overflow-y-auto">
            {snapshot.items.map((item) => (
              <NotificationItem key={item.id} item={item} onOpen={openNotification} />
            ))}
          </ul>
        )}
        <PushSwitch />
      </div>
    </Popover>
  )
}
