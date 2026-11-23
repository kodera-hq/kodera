import { WorkspaceUiModeToggle } from './WorkspaceUiModeToggle'
import { lazy, memo, Suspense, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { formatElapsed, type Locale } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { ActionIcon } from '../../ui/icons/ActionIcons'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import { TOUCH_TARGET, TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import {
  isRoomSearchPermitted,
  type ConfidentialChannelFlags,
} from '../command-palette/omniboxIndex'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import { NotificationCenter } from '../notifications/NotificationCenter'
import type { Notification } from '../notifications/notificationFeed'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import { OrganisationHeader } from '../workspace/OrganisationHeader'
import {
  categoryLabel,
  channelLabel,
  isArrivalsChannel,
  arrivalsFirst,
  type Workspace,
  type WorkspaceChannel,
} from '../workspace/workspace'
import { AntennaIcon } from './AntennaIcon'
import { ChannelContextMenu, type ChannelMenuTarget } from './ChannelContextMenu'
import {
  nameOf,
  isProximityChannel,
  roomForChannel,
  roomRowId,
  type EspaceStoreLike,
} from './liveViewModel'
import type { DirectSummary } from './matrix/directs'
import type { RoomSummary } from './matrix/store'
import { MemberAvatar } from './MemberAvatar'
import type { MentionCandidate } from './mentions'
import { PendingInvitations } from './PendingInvitations'
import { excerptOf } from './searchMatching'
import { uiModeCopy, type WorkspaceUiMode } from './uiModePreference'

const LazyDirectMessageDialog = lazy(() =>
  import('./DirectMessageDialog').then((module) => ({ default: module.DirectMessageDialog }))
)

export interface SimpleFeedItem {
  readonly key: string
  readonly kind: 'direct' | 'text' | 'audio'
  readonly label: string
  readonly isFavorite: boolean
  readonly mentions: number
  readonly unread: number
  readonly lastActivityTs: number
  readonly selected: boolean
  readonly quarantined: boolean
  readonly excerpt: string
  readonly direct?: DirectSummary | undefined
  readonly channel?: WorkspaceChannel | undefined
  readonly categoryName?: string | undefined
  readonly room?: RoomSummary | undefined
  readonly rowDomId?: string | undefined
}

export function compareSimpleFeedItems(a: SimpleFeedItem, b: SimpleFeedItem): number {
  return (
    Number(Boolean(b.channel && isArrivalsChannel(b.channel))) -
      Number(Boolean(a.channel && isArrivalsChannel(a.channel))) ||
    Number(b.isFavorite) - Number(a.isFavorite) ||
    Number(b.mentions > 0) - Number(a.mentions > 0) ||
    Number(b.unread > 0) - Number(a.unread > 0) ||
    b.lastActivityTs - a.lastActivityTs ||
    a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' })
  )
}

function formatRelativeActivity(
  ts: number,
  nowMs: number,
  locale: Locale,
  justNowLabel: string
): string {
  if (ts <= 0) return ''
  const elapsedSec = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (elapsedSec < 45) return justNowLabel
  return formatElapsed(elapsedSec, locale)
}

function menuTargetOf(
  event: MouseEvent<HTMLElement>,
  channelId: string,
  label: string,
  kind: 'text' | 'audio'
): ChannelMenuTarget {
  const primaryButton =
    event.currentTarget.querySelector<HTMLElement>('[data-primary-row-button]') ??
    event.currentTarget
  return {
    channelId,
    label,
    kind,
    clientX: event.clientX,
    clientY: event.clientY,
    trigger: primaryButton,
  }
}

export interface SimpleMessagingSidebarProps {
  readonly store: EspaceStoreLike
  readonly workspace: Workspace
  readonly org: string
  readonly organisationName: string
  readonly narrow: boolean
  readonly simulation: boolean
  readonly headingId: string
  readonly width: number
  readonly uiMode: WorkspaceUiMode
  readonly onChangeUiMode: (mode: WorkspaceUiMode, options?: { fromToggle?: boolean }) => void
  readonly activeChannelId: string | undefined
  readonly activeDirectRoomId: string | null
  readonly favoriteChannels: ReadonlySet<string>
  readonly proximityChannelIds: ReadonlySet<string> | undefined
  readonly documents: readonly ChannelDoc[]
  readonly searchEntries: readonly ChannelSearchEntry[]
  readonly dynamicEntries?: ((query: string) => readonly ChannelSearchEntry[]) | undefined
  readonly mentionCandidates: readonly MentionCandidate[]
  readonly insertRef: RefObject<((text: string) => void) | null>
  readonly organisationActionSlot: ReactNode | undefined
  readonly sidebarActionSlot: ReactNode | undefined
  readonly sidebarFooterSlot: ReactNode | undefined
  readonly className?: string | undefined
  readonly onChooseFromSearch: (entry: ChannelSearchEntry) => HTMLElement | null
  readonly onOpenDocument: ((doc: ChannelDoc) => HTMLElement | null) | undefined
  readonly onSelectTextChannel: (channelId: string) => void
  readonly onSelectDirect: ((roomId: string) => void) | undefined
  readonly onStartQuickCall: (item: {
    readonly kind: 'direct' | 'text' | 'audio'
    readonly channel?: WorkspaceChannel | undefined
    readonly direct?: DirectSummary | undefined
    readonly room?: RoomSummary | undefined
    readonly categoryName?: string | undefined
  }) => void
  readonly onChannelContextMenu?: ((target: ChannelMenuTarget) => void) | undefined
  readonly onChannelSettings?: ((target: ChannelMenuTarget) => void) | undefined
  readonly onChannelToggleFavorite?: ((target: ChannelMenuTarget) => void) | undefined
  readonly isChannelFavorite?: ((channelId: string) => boolean) | undefined
  readonly onChannelToggleMute?: ((target: ChannelMenuTarget) => void) | undefined
  readonly isChannelMuted?: ((channelId: string) => boolean) | undefined
  readonly onChannelInvite?: ((target: ChannelMenuTarget) => void) | undefined
  readonly canInviteChannel?: ((channelId: string) => boolean) | undefined
  readonly onChannelCopyLink?: ((target: ChannelMenuTarget) => void) | undefined
  readonly onChannelPermissions?: ((target: ChannelMenuTarget) => void) | undefined
  readonly canManageChannel?: ((channelId: string) => boolean) | undefined
  readonly onOpenNotification?: ((item: Notification) => void) | undefined
  readonly nowMs?: number | undefined
}

function SimpleMessagingSidebarView({
  store,
  workspace: incomingWorkspace,
  org,
  organisationName,
  narrow,
  simulation,
  headingId,
  uiMode,
  onChangeUiMode,
  activeChannelId,
  activeDirectRoomId,
  favoriteChannels,
  proximityChannelIds,
  searchEntries,
  organisationActionSlot,
  sidebarActionSlot,
  sidebarFooterSlot,
  className,
  onSelectTextChannel,
  onSelectDirect,
  onStartQuickCall,
  onChannelContextMenu,
  onChannelSettings,
  onChannelToggleFavorite,
  isChannelFavorite,
  onChannelToggleMute,
  isChannelMuted,
  onChannelInvite,
  canInviteChannel,
  onChannelCopyLink,
  onChannelPermissions,
  canManageChannel,
  onOpenNotification,
  nowMs,
}: SimpleMessagingSidebarProps) {
  const workspace = arrivalsFirst(incomingWorkspace)
  const { t, i18n } = useTranslation()
  const locale: Locale = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr'
  const copy = uiModeCopy(i18n.resolvedLanguage)
  const feedListLabelId = useId()
  const [filter, setFilter] = useState<'all' | 'unread' | 'directs' | 'channels'>('all')
  const [search, setSearch] = useState('')
  const [composingDm, setComposingDm] = useState(false)
  const [menuTarget, setMenuTarget] = useState<ChannelMenuTarget | null>(null)
  const [clockMs, setClockMs] = useState(() => Date.now())
  useEffect(() => {
    if (nowMs !== undefined) return
    const timer = window.setInterval(() => setClockMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [nowMs])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const ownsMenu =
    onChannelSettings !== undefined ||
    onChannelToggleFavorite !== undefined ||
    onChannelToggleMute !== undefined ||
    onChannelInvite !== undefined ||
    onChannelCopyLink !== undefined ||
    onChannelPermissions !== undefined

  const openMenu = (target: ChannelMenuTarget) => {
    if (ownsMenu) setMenuTarget(target)
    onChannelContextMenu?.(target)
  }

  function openMentionedRoom(roomId: string) {
    for (const [channelId, room] of store.getSnapshot().channels) {
      if (room.state === 'resolved' && room.roomId === roomId) {
        onSelectTextChannel(channelId)
        return
      }
    }
    onSelectDirect?.(roomId)
  }

  const items: SimpleFeedItem[] = []
  let maxObservedTs = 0

  if (!simulation && store.getDirects !== undefined) {
    for (const dm of store.getDirects()) {
      const room = snapshot.rooms.find((candidate) => candidate.roomId === dm.roomId)
      const permitted = isRoomSearchPermitted(store, dm.roomId, undefined)
      const messages = store.getTimeline(dm.roomId).filter((msg) => !msg.redacted)
      const latest = messages.at(-1)
      const ts = latest?.ts ?? 0
      if (ts > maxObservedTs) maxObservedTs = ts
      const unread = room?.unread ?? dm.unread ?? 0
      const mentions = room?.mentions ?? 0
      const mentionMsg =
        permitted && mentions > 0 ? messages.findLast((msg) => msg.mentionsMe) : undefined
      const previewMessage = mentionMsg ?? latest
      const rawPreview =
        permitted && previewMessage ? `${nameOf(previewMessage)}: ${previewMessage.body}` : ''
      items.push({
        key: `direct:${dm.roomId}`,
        kind: 'direct',
        label: dm.name,
        isFavorite: favoriteChannels.has(`direct:${dm.roomId}`) || favoriteChannels.has(dm.roomId),
        mentions,
        unread,
        lastActivityTs: ts,
        selected: activeDirectRoomId === dm.roomId,
        quarantined: !permitted,
        excerpt: !permitted
          ? copy.confidentialExcerpt
          : rawPreview
            ? excerptOf(rawPreview, 76)
            : copy.noMessagesYet,
        direct: dm,
        room,
      })
    }
  }

  const channelEntries: { channel: WorkspaceChannel; categoryName: string | undefined }[] = [
    ...workspace.uncategorised_channels.map((channel) => ({ channel, categoryName: undefined })),
    ...workspace.categories.flatMap((category) => {
      const catName = categoryLabel(category, t)
      return category.channels.map((channel) => ({ channel, categoryName: catName }))
    }),
  ]

  for (const { channel, categoryName } of channelEntries) {
    const label = channelLabel(channel, t)
    const isFavorite =
      channel.id === workspace.arrivals_channel_id ||
      isArrivalsChannel(channel) ||
      favoriteChannels.has(channel.id)
    const room = roomForChannel(channel, snapshot.channels, snapshot.rooms)
    const unread = room?.unread ?? 0
    const mentions = room?.mentions ?? 0
    const occupantCount = room?.occupancy?.participants.length ?? 0
    const messages = room ? store.getTimeline(room.roomId).filter((msg) => !msg.redacted) : []
    const latest = messages.at(-1)
    const ts = latest?.ts ?? 0
    if (ts > maxObservedTs) maxObservedTs = ts

    const hasActivity = isFavorite || unread > 0 || mentions > 0 || ts > 0 || occupantCount > 0
    if (!hasActivity && channel.lifecycle !== 'active') continue

    const flags = channel as WorkspaceChannel & ConfidentialChannelFlags
    const permitted =
      room !== undefined
        ? isRoomSearchPermitted(store, room.roomId, flags)
        : store.getRoomBoundary !== undefined &&
          flags.isConfidential !== true &&
          flags.is_confidential !== true

    let excerpt: string
    if (!permitted) {
      excerpt = copy.confidentialExcerpt
    } else if (channel.kind === 'audio' && occupantCount > 0) {
      excerpt =
        occupantCount === 1
          ? copy.activeCallSingle
          : copy.activeCallMany.replace('{count}', String(occupantCount))
    } else {
      const mentionMsg = mentions > 0 ? messages.findLast((msg) => msg.mentionsMe) : undefined
      const previewMessage = mentionMsg ?? latest
      const rawBody = previewMessage ? `${nameOf(previewMessage)}: ${previewMessage.body}` : ''
      excerpt = rawBody ? excerptOf(rawBody, 76) : copy.noMessagesYet
    }

    items.push({
      key: `channel:${channel.id}`,
      kind: channel.kind,
      label,
      isFavorite,
      mentions,
      unread,
      lastActivityTs: ts,
      selected: activeDirectRoomId === null && channel.id === activeChannelId,
      quarantined: !permitted,
      excerpt,
      channel:
        channel.id === workspace.arrivals_channel_id
          ? { ...channel, template_key: 'arrivals' }
          : channel,
      categoryName,
      room,
      ...(channel.kind === 'audio' ? { rowDomId: roomRowId(headingId, channel.id) } : {}),
    })
  }

  items.sort(compareSimpleFeedItems)
  const referenceNow = nowMs ?? (maxObservedTs > 0 ? Math.max(clockMs, maxObservedTs) : 0)

  return (
    <nav
      aria-labelledby={headingId}
      data-testid="simple-messaging-sidebar"
      className={cx(
        'messages-master material-panel order-first flex shrink-0 flex-col justify-between overflow-hidden border-r border-c-border-soft p-3',
        className
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-2">
          {narrow && simulation ? null : (
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <OrganisationHeader
                  name={workspace.display_name || organisationName}
                  slug={org}
                  logoUrl={workspace.logo_url}
                />
              </div>
              {simulation ? null : (
                <NotificationCenter
                  store={store}
                  onSelectInvite={onSelectDirect}
                  onOpenRoom={openMentionedRoom}
                  onOpenNotification={onOpenNotification}
                />
              )}
            </div>
          )}
          {organisationActionSlot ?? null}
          <div className="flex items-center justify-between gap-2">
            <h2 id={headingId} className="text-lg font-semibold">
              {copy.title}
            </h2>
            <WorkspaceUiModeToggle
              mode={uiMode}
              onSelect={(next) => onChangeUiMode(next, { fromToggle: true })}
            />
          </div>
          <div className="flex items-center gap-2">
            {simulation || onSelectDirect === undefined ? null : (
              <Button
                variant="secondary"
                size="sm"
                icon={<ActionIcon name="plus" />}
                iconOnly
                data-testid="simple-sidebar-new-message"
                aria-label={copy.newMessage}
                disabled={store.openDirect === undefined}
                onClick={() => setComposingDm(true)}
              />
            )}
          </div>
          {composingDm && onSelectDirect !== undefined ? (
            <Suspense fallback={null}>
              <LazyDirectMessageDialog
                open
                onOpenChange={setComposingDm}
                store={store}
                searchEntries={searchEntries}
                onOpened={onSelectDirect}
              />
            </Suspense>
          ) : null}
          {sidebarActionSlot ?? null}
        </div>

        <label className="flex flex-col gap-2">
          <span className="sr-only">{copy.search}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={copy.search}
            className="min-h-10 rounded-full border border-c-border-soft bg-c-sunken px-3 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
          />
        </label>
        <div role="group" aria-label={copy.conversationsLabel} className="flex gap-1">
          {(['all', 'unread', 'directs', 'channels'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className="min-h-8 rounded-full px-3 text-xs text-c-ink-2 hover:bg-c-muted aria-pressed:bg-c-accent-soft aria-pressed:text-c-accent-ink narrow:min-h-[44px]"
            >
              {copy[key]}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {simulation || onSelectDirect === undefined ? null : (
            <PendingInvitations store={store} onSelect={onSelectDirect} />
          )}
          <span id={feedListLabelId} className="sr-only">
            {copy.conversationsLabel}
          </span>
          {items.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-c-ink-3">{copy.emptyFeed}</p>
          ) : (
            <ul aria-labelledby={feedListLabelId} className="flex flex-col gap-1">
              {items
                .filter(
                  (item) =>
                    (filter === 'all' ||
                      (filter === 'unread' && item.unread > 0) ||
                      (filter === 'directs' && item.kind === 'direct') ||
                      (filter === 'channels' && item.kind !== 'direct')) &&
                    `${item.label} ${item.quarantined ? '' : item.excerpt}`
                      .toLocaleLowerCase(locale)
                      .includes(search.trim().toLocaleLowerCase(locale))
                )
                .map((item) => {
                  const relativeTs = formatRelativeActivity(
                    item.lastActivityTs,
                    referenceNow,
                    locale,
                    copy.justNow
                  )
                  const badgeCount = item.mentions > 0 ? item.mentions : item.unread
                  return (
                    <li
                      key={item.key}
                      data-testid={`simple-feed-row-${item.key}`}
                      onContextMenu={
                        item.channel !== undefined &&
                        (ownsMenu || onChannelContextMenu !== undefined)
                          ? (event) => {
                              event.preventDefault()
                              openMenu(
                                menuTargetOf(
                                  event,
                                  item.channel!.id,
                                  item.label,
                                  item.channel!.kind
                                )
                              )
                            }
                          : undefined
                      }
                      className={cx(
                        'group flex items-center gap-1 rounded-md px-1 py-[2px] transition-colors duration-fast motion-reduce:transition-none',
                        item.selected
                          ? 'bg-c-accent-soft text-c-accent-ink'
                          : 'text-c-ink hover:bg-c-muted'
                      )}
                    >
                      <button
                        type="button"
                        data-primary-row-button=""
                        id={item.rowDomId}
                        aria-current={item.selected ? 'page' : undefined}
                        onClick={() => {
                          if (item.kind === 'direct' && item.direct !== undefined) {
                            onSelectDirect?.(item.direct.roomId)
                          } else if (item.kind === 'audio' && item.channel !== undefined) {
                            onStartQuickCall({
                              kind: 'audio',
                              channel: item.channel,
                              room: item.room,
                              categoryName: item.categoryName,
                            })
                          } else if (item.channel !== undefined) {
                            onSelectTextChannel(item.channel.id)
                          }
                        }}
                        className={cx(
                          'flex min-h-[64px] min-w-0 flex-1 items-center gap-3 rounded-sm px-2 py-2 text-left focus-visible:ring focus-visible:outline-hidden',
                          TOUCH_TARGET_HEIGHT
                        )}
                      >
                        {item.kind === 'direct' && item.direct !== undefined ? (
                          <span aria-hidden="true" className="inline-flex shrink-0">
                            <MemberAvatar
                              name={item.label}
                              identity={item.direct.userIds[0] ?? item.direct.roomId}
                              mxc={item.direct.avatarMxc}
                              size="lg"
                              className="h-[44px] w-[44px]"
                              onlineLabel={
                                item.direct.userIds.some((id) => store.isOnline?.(id))
                                  ? t('console.workspace.presence.online')
                                  : undefined
                              }
                            />
                          </span>
                        ) : item.kind === 'audio' ? (
                          <span
                            aria-hidden="true"
                            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-c-muted text-c-ink-2"
                          >
                            <KoderaIcon name="calls" className="h-4 w-4 shrink-0" />
                          </span>
                        ) : item.channel !== undefined &&
                          isProximityChannel(item.channel, proximityChannelIds) ? (
                          <span
                            aria-hidden="true"
                            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-c-muted text-c-ink-2"
                          >
                            <AntennaIcon />
                          </span>
                        ) : (
                          <span
                            aria-hidden="true"
                            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-c-muted font-mono text-sm font-medium text-c-ink-2"
                          >
                            #
                          </span>
                        )}

                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex min-w-0 items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1">
                              <span className="truncate text-sm font-semibold">{item.label}</span>
                              {item.isFavorite ? (
                                <>
                                  <span
                                    aria-hidden="true"
                                    title={copy.pinnedBadge}
                                    className="inline-flex shrink-0 text-c-accent-ink"
                                  >
                                    <KoderaIcon name="pin" className="h-4 w-4 shrink-0" />
                                  </span>
                                  <span className="sr-only">{copy.pinnedBadge}</span>
                                </>
                              ) : null}
                            </span>
                            {relativeTs ? (
                              <span className="shrink-0 text-xs text-c-ink-3 tabular-nums">
                                {relativeTs}
                              </span>
                            ) : null}
                          </span>

                          <span className="flex min-w-0 items-center justify-between gap-2">
                            <span
                              data-testid={
                                item.quarantined ? 'simple-feed-quarantined-excerpt' : undefined
                              }
                              className={cx(
                                'flex min-w-0 flex-1 items-center gap-1 truncate text-xs',
                                item.selected ? 'text-c-accent-ink' : 'text-c-ink-3'
                              )}
                            >
                              {item.quarantined ? (
                                <KoderaIcon name="shield" className="h-4 w-4 shrink-0" />
                              ) : null}
                              <span className="truncate">{item.excerpt}</span>
                            </span>
                            {badgeCount > 0 ? (
                              <span className="min-w-5 shrink-0 rounded-full bg-c-action px-2 text-center text-xs font-bold text-c-on-inverse tabular-nums">
                                <span className="sr-only">
                                  {item.mentions > 0
                                    ? t('console.workspace.channel.count-mentions', {
                                        count: item.mentions,
                                      })
                                    : t('console.workspace.directs.label-unread', {
                                        count: String(item.unread),
                                      })}
                                </span>
                                <span aria-hidden="true">{badgeCount}</span>
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid={`simple-feed-call-${item.key}`}
                        aria-label={copy.callAction.replace('{name}', item.label)}
                        title={copy.callAction.replace('{name}', item.label)}
                        onClick={(event) => {
                          event.stopPropagation()
                          onStartQuickCall({
                            kind: item.kind,
                            channel: item.channel,
                            direct: item.direct,
                            room: item.room,
                            categoryName: item.categoryName,
                          })
                        }}
                        className={cx(
                          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm transition-colors duration-fast motion-reduce:transition-none',
                          TOUCH_TARGET,
                          'hover:bg-c-muted-2 hover:text-c-ink focus-visible:ring focus-visible:outline-hidden',
                          item.selected ? 'text-c-accent-ink' : 'text-c-ink-3'
                        )}
                      >
                        <KoderaIcon name="calls" className="h-4 w-4 shrink-0" />
                      </button>
                    </li>
                  )
                })}
            </ul>
          )}
        </div>
      </div>

      {sidebarFooterSlot ?? null}
      <ChannelContextMenu
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onSettings={onChannelSettings}
        onToggleFavorite={onChannelToggleFavorite}
        isFavorite={isChannelFavorite}
        onToggleMute={onChannelToggleMute}
        isMuted={isChannelMuted}
        onInvite={onChannelInvite}
        canInvite={canInviteChannel}
        onCopyLink={onChannelCopyLink}
        onPermissions={onChannelPermissions}
        canManage={canManageChannel}
      />
    </nav>
  )
}

export const SimpleMessagingSidebar = memo(SimpleMessagingSidebarView)
