import { lazy, memo, Suspense, useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { formatElapsed, type Locale } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { cssProperty } from '../../ui/cssom'
import { cx } from '../../ui/cx'
import { ActionIcon } from '../../ui/icons/ActionIcons'
import { KoderaIcon } from '../../ui/icons/KoderaIcons'
import { TOUCH_TARGET, TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { UniversalSearch } from '../command-palette/UniversalSearch'
import { paletteCopy } from '../command-palette/messages'
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
  type Workspace,
  type WorkspaceChannel,
} from '../workspace/workspace'
import { AntennaIcon } from './AntennaIcon'
import { ChannelContextMenu, type ChannelMenuTarget } from './ChannelContextMenu'
import {
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

export function WorkspaceUiModeToggle({
  mode,
  onSelect,
}: {
  readonly mode: WorkspaceUiMode
  readonly onSelect: (next: WorkspaceUiMode) => void
}) {
  const { i18n } = useTranslation()
  const copy = uiModeCopy(i18n.resolvedLanguage)
  return (
    <div
      role="group"
      aria-label={copy.modeToggleGroup}
      data-testid="workspace-ui-mode-toggle"
      className="grid grid-cols-2 gap-1 rounded-md border border-c-border-soft bg-c-sunken p-1"
    >
      {(['pro', 'simple'] as const).map((option) => {
        const active = mode === option
        return (
          <button
            key={option}
            type="button"
            data-testid={`workspace-ui-mode-${option}`}
            aria-pressed={active}
            onClick={() => {
              if (!active) onSelect(option)
            }}
            className={cx(
              'inline-flex min-h-[28px] min-w-12 items-center justify-center rounded-sm px-2 py-1 text-xs font-semibold transition-colors duration-fast motion-reduce:transition-none',
              TOUCH_TARGET_HEIGHT,
              'focus-visible:ring focus-visible:outline-hidden',
              active
                ? 'bg-c-accent-soft text-c-accent-ink ring-1 ring-c-accent-ink ring-inset'
                : 'text-c-ink-3 hover:bg-c-muted hover:text-c-ink-2'
            )}
          >
            {option === 'pro' ? copy.modePro : copy.modeSimple}
          </button>
        )
      })}
    </div>
  )
}

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
  readonly onChannelCopyLink?: ((target: ChannelMenuTarget) => void) | undefined
  readonly onChannelPermissions?: ((target: ChannelMenuTarget) => void) | undefined
  readonly canManageChannel?: ((channelId: string) => boolean) | undefined
  readonly onOpenNotification?: ((item: Notification) => void) | undefined
  readonly nowMs?: number | undefined
}

function SimpleMessagingSidebarView({
  store,
  workspace,
  org,
  organisationName,
  narrow,
  simulation,
  headingId,
  width,
  uiMode,
  onChangeUiMode,
  activeChannelId,
  activeDirectRoomId,
  favoriteChannels,
  proximityChannelIds,
  documents,
  searchEntries,
  dynamicEntries,
  mentionCandidates,
  insertRef,
  organisationActionSlot,
  sidebarActionSlot,
  sidebarFooterSlot,
  className,
  onChooseFromSearch,
  onOpenDocument,
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
  onChannelCopyLink,
  onChannelPermissions,
  canManageChannel,
  onOpenNotification,
  nowMs,
}: SimpleMessagingSidebarProps) {
  const { t, i18n } = useTranslation()
  const locale: Locale = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr'
  const copy = uiModeCopy(i18n.resolvedLanguage)
  const cmdCopy = paletteCopy(i18n.resolvedLanguage)
  const feedListLabelId = useId()
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
      const rawPreview = permitted ? (mentionMsg?.body ?? latest?.body ?? '') : ''
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
    const isFavorite = favoriteChannels.has(channel.id)
    const room = roomForChannel(channel, snapshot.channels, snapshot.rooms)
    const unread = room?.unread ?? 0
    const mentions = room?.mentions ?? 0
    const occupantCount = room?.occupancy?.participants.length ?? 0
    const messages = room ? store.getTimeline(room.roomId).filter((msg) => !msg.redacted) : []
    const latest = messages.at(-1)
    const ts = latest?.ts ?? 0
    if (ts > maxObservedTs) maxObservedTs = ts

    const hasActivity = isFavorite || unread > 0 || mentions > 0 || ts > 0 || occupantCount > 0
    if (!hasActivity) continue

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
      const rawBody = mentionMsg?.body ?? latest?.body ?? ''
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
      channel,
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
      ref={cssProperty('width', narrow ? undefined : `${width}px`)}
      className={cx(
        'material-panel order-first flex w-shell-sidebar-width shrink-0 flex-col justify-between overflow-hidden border-r border-c-border-soft p-3 narrow:max-h-[calc(100vh*3/4)] narrow:w-full narrow:border-r-0',
        className
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-2">
          {narrow && simulation ? null : (
            <div className="flex items-center gap-1">
              {narrow ? null : (
                <div className="min-w-0 flex-1">
                  <OrganisationHeader name={organisationName} slug={org} />
                </div>
              )}
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
          <h2 id={headingId} className="sr-only">
            {t('console.workspace.sidebar.title')}
          </h2>
          <WorkspaceUiModeToggle
            mode={uiMode}
            onSelect={(next) => onChangeUiMode(next, { fromToggle: true })}
          />
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <UniversalSearch
                entries={searchEntries}
                {...(dynamicEntries === undefined ? {} : { dynamicEntries })}
                onChoose={onChooseFromSearch}
                shortcut={!narrow}
                actions={[
                  {
                    id: 'ui-mode',
                    label: cmdCopy.switchToPro,
                    open: () => onChangeUiMode('pro'),
                  },
                ]}
                members={mentionCandidates.map((member) => ({
                  id: member.userId,
                  label: `@${member.label}`,
                  open: () => {
                    insertRef.current?.(`@${member.label} `)
                  },
                }))}
                directMessages={
                  simulation || onSelectDirect === undefined || store.getDirects === undefined
                    ? []
                    : store.getDirects().map((dm) => ({
                        id: dm.roomId,
                        label: dm.name,
                        open: () => onSelectDirect(dm.roomId),
                      }))
                }
                documents={(onOpenDocument ? documents : []).map((doc) => ({
                  id: doc.id,
                  label: doc.title,
                  open: () => onOpenDocument?.(doc),
                }))}
              />
            </div>
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
              {items.map((item) => {
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
                      item.channel !== undefined && (ownsMenu || onChannelContextMenu !== undefined)
                        ? (event) => {
                            event.preventDefault()
                            openMenu(
                              menuTargetOf(event, item.channel!.id, item.label, item.channel!.kind)
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
                        'flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-sm px-2 py-2 text-left focus-visible:ring focus-visible:outline-hidden',
                        TOUCH_TARGET_HEIGHT
                      )}
                    >
                      {item.kind === 'direct' && item.direct !== undefined ? (
                        <span aria-hidden="true" className="inline-flex shrink-0">
                          <MemberAvatar
                            name={item.label}
                            identity={item.direct.userIds[0] ?? item.direct.roomId}
                            mxc={item.direct.avatarMxc}
                            size="md"
                          />
                        </span>
                      ) : item.kind === 'audio' ? (
                        <span
                          aria-hidden="true"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-c-muted text-c-ink-2"
                        >
                          <KoderaIcon name="calls" className="h-4 w-4 shrink-0" />
                        </span>
                      ) : item.channel !== undefined &&
                        isProximityChannel(item.channel, proximityChannelIds) ? (
                        <span
                          aria-hidden="true"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-c-muted text-c-ink-2"
                        >
                          <AntennaIcon />
                        </span>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-c-muted font-mono text-sm font-medium text-c-ink-2"
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
                                  <ActionIcon name="sparkle" className="h-4 w-4 shrink-0" />
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
        onCopyLink={onChannelCopyLink}
        onPermissions={onChannelPermissions}
        canManage={canManageChannel}
      />
    </nav>
  )
}

export const SimpleMessagingSidebar = memo(SimpleMessagingSidebarView)
