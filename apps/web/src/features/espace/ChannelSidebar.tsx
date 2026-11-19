// The workspace's navigation column: the organisation, the universal search, the studio's
// sections, then every category with its text channels and its audio rooms. Memoised, and it
// reads the store itself: unread marks, mentions and who is in a room draw it again; a keystroke
// in the composer does not. Only the audio room the member is in follows the call, so who is
// speaking draws that room's faces and nothing else of the column.

import { memo, useCallback, useState, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactNode, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { demoMessages } from '../../app/demoMessages'
import { ChannelRow } from '../../ui/ChannelRow/ChannelRow'
import { RoomRow } from '../../ui/RoomRow/RoomRow'
import { SidebarCategory } from '../../ui/SidebarCategory/SidebarCategory'
import { UniversalSearch } from '../command-palette/UniversalSearch'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import { OrganisationHeader } from '../workspace/OrganisationHeader'
import { NotificationCenter } from '../notifications/NotificationCenter'
import type { Notification } from '../notifications/notificationFeed'
import { usePassportServices } from '../profile/passportContext'
import { DirectMessages } from './DirectMessages'
import { StudioNavigation } from '../workspace/StudioNavigation'
import { categoryLabel, channelLabel } from '../workspace/workspace'
import type { Workspace, WorkspaceCategory, WorkspaceChannel } from '../workspace/workspace'
import { AntennaIcon } from './AntennaIcon'
import { ChannelContextMenu as ChannelMenu, type ChannelMenuTarget } from './ChannelContextMenu'
import type { CallSnapshot } from './audio/call'
import {
  isProximityChannel,
  noCallSnapshot,
  occupantsForRoom,
  roomForChannel,
  roomResolved,
  roomRowId,
  subscribeToNoCall,
  type AudioCallLike,
  type CanvasMode,
  type EspaceStoreLike,
} from './liveViewModel'
import type { RoomSummary } from './matrix/store'
import type { MentionCandidate } from './mentions'
import { useStoreSlice } from './useStoreSlice'
import { workspaceFilesOf } from './workspaceFiles'
import { cssProperty } from '../../ui/cssom'

/** What a right-click on a channel's row tells the view's owner. */
export type ChannelContextMenu = (info: ChannelMenuTarget) => void

/** The row a `contextmenu` event (pointer, context-menu key or `Shift+F10`) was fired on. */
function menuTargetOf(
  event: MouseEvent<HTMLElement>,
  channelId: string,
  label: string,
  kind: 'text' | 'audio'
): ChannelMenuTarget {
  return {
    channelId,
    label,
    kind,
    clientX: event.clientX,
    clientY: event.clientY,
    trigger: event.currentTarget,
  }
}

interface AudioRoomProps {
  id: string
  channel: WorkspaceChannel
  label: string
  categoryName: string | undefined
  /** The room, once the directory found it and the member has joined it. */
  room: RoomSummary | undefined
  /** Core says the room is ready, and the directory found it. */
  resolved: boolean
  /** The homeserver refused joining this room (`M_FORBIDDEN`): invite-only or denied. */
  refused: boolean
  /** The chat's sync is live: a room still missing is on its way. */
  live: boolean
  store: EspaceStoreLike
  call: AudioCallLike | null
  simulation: boolean
  speakingRef: RefObject<HTMLElement | null>
  onJoin: (
    channel: WorkspaceChannel,
    room: RoomSummary | undefined,
    categoryName: string | undefined
  ) => void
  onContextMenu: ChannelContextMenu | undefined
}

/**
 * One audio room's row. It follows the call only while the member is in this room: the call's
 * snapshot then, and nothing otherwise, so a room the member is not in is not drawn again each
 * time someone speaks in another.
 */
const noAvatarSub = () => () => undefined
const noAvatarVersion = () => 0

function AudioRoom({
  id,
  channel,
  label,
  categoryName,
  room,
  resolved,
  refused,
  live,
  store,
  call,
  simulation,
  speakingRef,
  onJoin,
  onContextMenu,
}: AudioRoomProps) {
  const { t, i18n } = useTranslation()
  const demoCopy = demoMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const avatars = usePassportServices()?.avatars
  useSyncExternalStore(avatars?.subscribe ?? noAvatarSub, avatars?.getVersion ?? noAvatarVersion)
  const roomId = room?.roomId
  const callInThisRoom = useCallback(
    (snapshot: CallSnapshot) =>
      roomId !== undefined &&
      snapshot.roomId === roomId &&
      (snapshot.status === 'connected' || snapshot.status === 'reconnecting')
        ? snapshot
        : null,
    [roomId]
  )
  const callSnapshot = useStoreSlice(
    call?.subscribe ?? subscribeToNoCall,
    call?.getSnapshot ?? noCallSnapshot,
    callInThisRoom
  )
  const inCall = callSnapshot !== null
  // Rings only in the room the member is in: who speaks reaches only the people in the call.
  // The member's own face follows their microphone, frame by frame, so it rings alone too;
  // the others' follow the call's speakers, which go stale while it reconnects.
  const occupants = occupantsForRoom(room, t('console.workspace.members.unnamed')).map(
    (occupant) =>
      callSnapshot === null
        ? occupant
        : occupant.id === callSnapshot.self
          ? { ...occupant, speakingRef }
          : callSnapshot.status === 'connected' && callSnapshot.speakers.includes(occupant.id)
            ? { ...occupant, speaking: true }
            : occupant
  )
  const unavailable = !resolved
    ? t('console.workspace.channel.label-preparing')
    : channel.lifecycle === 'archived'
      ? t('console.workspace.channel.label-archived')
      : room === undefined && refused
        ? t('console.workspace.audio.label-join-refused')
        : room === undefined && live
          ? t('console.workspace.audio.label-arriving')
          : undefined
  return (
    <RoomRow
      id={id}
      name={label}
      joinLabel={t('console.workspace.audio.action-join-room', { room: label })}
      occupancyLabel={(count) =>
        count === 0
          ? t('console.workspace.audio.label-empty')
          : t('console.workspace.audio.count-people', { count })
      }
      occupants={occupants.map((occupant) => {
        const mxc = room?.avatars?.[occupant.id]
        const src = mxc === undefined ? undefined : avatars?.get(mxc)
        return {
          ...occupant,
          onlineLabel: store.isOnline?.(occupant.id)
            ? simulation
              ? demoCopy.presence
              : t('console.workspace.presence.online')
            : undefined,
          ...(src === undefined
            ? {}
            : {
                src,
                onAvatarError: () => {
                  if (mxc !== undefined) avatars?.forget(mxc)
                },
              }),
        }
      })}
      occupantsLabel={t('console.workspace.audio.label-occupants', { room: label })}
      sharingLabel={t('console.workspace.audio.label-sharing-screen')}
      overflowLabel={(hidden) => t('console.workspace.audio.action-show-others', { count: hidden })}
      {...(inCall ? { connected: t('console.workspace.audio.status-connected') } : {})}
      {...(callSnapshot !== null && callSnapshot.listenOnly
        ? { listenOnly: t('console.workspace.audio.label-listen-only') }
        : {})}
      {...(unavailable === undefined ? {} : { unavailable })}
      onClick={() => onJoin(channel, room, categoryName)}
      onContextMenu={
        onContextMenu === undefined
          ? undefined
          : (e: MouseEvent<HTMLElement>) => {
              e.preventDefault()
              onContextMenu(menuTargetOf(e, channel.id, label, 'audio'))
            }
      }
    />
  )
}

export interface ChannelSidebarProps {
  store: EspaceStoreLike
  call: AudioCallLike | null
  workspace: Workspace
  org: string
  organisationName: string
  /** On a phone the column is the whole screen, drawn in a drawer. */
  narrow: boolean
  simulation: boolean
  /** The id of the column's heading, which names it and prefixes its rooms' ids. */
  headingId: string
  /** The column's width, as the member resized it; not applied on a phone. */
  width: number
  activeChannelId: string | undefined
  canvasMode: CanvasMode
  /** Optional presentation metadata; never an access grant. */
  categoryDescriptions: Readonly<Record<string, string>> | undefined
  /** Channels the server flags as the proximity room; see `isProximityChannel`. */
  proximityChannelIds: ReadonlySet<string> | undefined
  documents: readonly ChannelDoc[]
  searchEntries: readonly ChannelSearchEntry[]
  mentionCandidates: readonly MentionCandidate[]
  canInvite: boolean
  /** The member's own face in the room they are in rings from this (`useMicActivity`). */
  speakingRef: RefObject<HTMLElement | null>
  /** Writes in the channel's composer: the search's « @member » action. */
  insertRef: RefObject<((text: string) => void) | null>
  organisationActionSlot: ReactNode | undefined
  sidebarActionSlot: ReactNode | undefined
  sidebarFooterSlot: ReactNode | undefined
  onInvite: () => void
  onChooseFromSearch: (entry: ChannelSearchEntry) => HTMLElement | null
  onOpenChannel: (entry: ChannelSearchEntry) => HTMLElement | null
  onOpenDocument: ((doc: ChannelDoc) => HTMLElement | null) | undefined
  /** The search's « Docs » action: the canvas changes, and the chooser stays as it is. */
  onChangeCanvasMode: ((mode: CanvasMode) => void) | undefined
  /** The studio's sections: the canvas changes, and a phone's chooser closes on it. */
  onSwitchCanvas: ((mode: CanvasMode) => void) | undefined
  onSelectTextChannel: (channelId: string) => void
  /** The direct conversation shown, and how one is chosen; absent where there are none. */
  activeDirectRoomId?: string | null
  onSelectDirect?: (roomId: string) => void
  onJoinAudioRoom: AudioRoomProps['onJoin']
  onCreateInCategory: ((category: WorkspaceCategory) => void) | undefined
  onChannelContextMenu: ChannelContextMenu | undefined
  /**
   * The channel menu's actions (right-click, context-menu key, `Shift+F10` on a row). The column
   * draws the menu itself when any is given; each absent one is left out of it.
   */
  onChannelSettings?: ((target: ChannelMenuTarget) => void) | undefined
  onChannelToggleMute?: ((target: ChannelMenuTarget) => void) | undefined
  isChannelMuted?: ((channelId: string) => boolean) | undefined
  onChannelInvite?: ((target: ChannelMenuTarget) => void) | undefined
  onChannelCopyLink?: ((target: ChannelMenuTarget) => void) | undefined
  /** A channel's permissions, offered only where `canManageChannel` says the member may. */
  onChannelPermissions?: ((target: ChannelMenuTarget) => void) | undefined
  canManageChannel?: ((channelId: string) => boolean) | undefined
  onOpenNotification?: ((item: Notification) => void) | undefined
}

function ChannelSidebarView({
  store,
  call,
  workspace,
  org,
  organisationName,
  narrow,
  simulation,
  headingId,
  width,
  activeChannelId,
  canvasMode,
  categoryDescriptions,
  proximityChannelIds,
  documents,
  searchEntries,
  mentionCandidates,
  canInvite,
  speakingRef,
  insertRef,
  organisationActionSlot,
  sidebarActionSlot,
  sidebarFooterSlot,
  onInvite,
  onChooseFromSearch,
  onOpenChannel,
  onOpenDocument,
  onChangeCanvasMode,
  onSwitchCanvas,
  onSelectTextChannel,
  activeDirectRoomId,
  onSelectDirect,
  onJoinAudioRoom,
  onCreateInCategory,
  onChannelContextMenu,
  onChannelSettings,
  onChannelToggleMute,
  isChannelMuted,
  onChannelInvite,
  onChannelCopyLink,
  onChannelPermissions,
  canManageChannel,
  onOpenNotification,
}: ChannelSidebarProps) {
  /** An inbox entry pressed: its channel opens, or its direct conversation when it is one. */
  function openMentionedRoom(roomId: string) {
    for (const [channelId, room] of store.getSnapshot().channels) {
      if (room.state === 'resolved' && room.roomId === roomId) {
        onSelectTextChannel(channelId)
        return
      }
    }
    onSelectDirect?.(roomId)
  }
  const { t } = useTranslation()
  const [menuTarget, setMenuTarget] = useState<ChannelMenuTarget | null>(null)
  const ownsMenu =
    onChannelSettings !== undefined ||
    onChannelToggleMute !== undefined ||
    onChannelInvite !== undefined ||
    onChannelCopyLink !== undefined ||
    onChannelPermissions !== undefined
  // The row's right-click: the column's own menu, when it has actions, and the owner told.
  const channelContextMenu: ChannelContextMenu | undefined =
    !ownsMenu && onChannelContextMenu === undefined
      ? undefined
      : (target) => {
          if (ownsMenu) setMenuTarget(target)
          onChannelContextMenu?.(target)
        }
  // Unread marks, mentions, occupants and every room's latest message come from the store.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  function renderChannelOrRoomRow(channel: WorkspaceChannel, categoryName: string | undefined) {
    const label = channelLabel(channel, t)
    const room = roomForChannel(channel, snapshot.channels, snapshot.rooms)
    const resolved = roomResolved(channel, snapshot.channels)
    if (channel.kind === 'audio') {
      const resolvedEntry = snapshot.channels.get(channel.id)
      const refused =
        room === undefined &&
        resolvedEntry?.state === 'resolved' &&
        store.getJoinState?.(resolvedEntry.roomId) === 'refused'
      return (
        <AudioRoom
          key={channel.id}
          id={roomRowId(headingId, channel.id)}
          channel={channel}
          label={label}
          categoryName={categoryName}
          room={room}
          resolved={resolved}
          refused={refused}
          live={snapshot.status === 'live'}
          store={store}
          call={call}
          simulation={simulation}
          speakingRef={speakingRef}
          onJoin={onJoinAudioRoom}
          onContextMenu={channelContextMenu}
        />
      )
    }

    const unreadCount = room?.unread ?? 0
    const mentionCount = room?.mentions ?? 0
    const isSelected = canvasMode === 'chat' && channel.id === activeChannelId
    const isArchived = channel.lifecycle === 'archived'
    const readOnly = isArchived
      ? t('console.workspace.channel.label-archived')
      : !resolved
        ? t('console.workspace.channel.label-preparing')
        : undefined
    return (
      <ChannelRow
        key={channel.id}
        name={label}
        leading={isProximityChannel(channel, proximityChannelIds) ? <AntennaIcon /> : undefined}
        // The channel's own address, so a copied link or a middle-click opens it; a click opens
        // it in place.
        href={`/${encodeURIComponent(org)}/workspace/${encodeURIComponent(channel.id)}`}
        selected={isSelected}
        {...(unreadCount > 0 ? { unread: t('console.workspace.channel.label-unread') } : {})}
        {...(mentionCount > 0
          ? {
              mentions: {
                count: mentionCount,
                label: t('console.workspace.channel.count-mentions', { count: mentionCount }),
              },
            }
          : {})}
        {...(readOnly === undefined ? {} : { readOnly })}
        onClick={(e) => {
          e.preventDefault()
          onSelectTextChannel(channel.id)
        }}
        onContextMenu={
          channelContextMenu === undefined
            ? undefined
            : (e) => {
                e.preventDefault()
                channelContextMenu(menuTargetOf(e, channel.id, label, 'text'))
              }
        }
      />
    )
  }

  const activity = searchEntries
    .flatMap((channel) => {
      const resolved = snapshot.channels.get(channel.id)
      if (resolved?.state !== 'resolved') return []
      const room = snapshot.rooms.find((entry) => entry.roomId === resolved.roomId)
      if (!room) return []
      const messages = store.getTimeline(room.roomId).filter((message) => !message.redacted)
      const latest = messages.at(-1)
      const mention = messages.findLast((message) => message.mentionsMe)
      return room.unread || room.mentions || latest
        ? [
            {
              channel,
              unread: room.unread,
              mentions: room.mentions,
              body: (room.mentions ? mention?.body : undefined) ?? latest?.body ?? '',
              ts: latest?.ts ?? 0,
            },
          ]
        : []
    })
    .sort(
      (a, b) =>
        Number(b.mentions > 0) - Number(a.mentions > 0) ||
        Number(b.unread > 0) - Number(a.unread > 0) ||
        b.ts - a.ts
    )
  // One list for the dock's panel and for « Fichiers », so the two never disagree about what the
  // workspace holds (`workspaceFiles.ts`).
  const files = workspaceFilesOf(store, snapshot, searchEntries, documents).map((entry) => ({
    id: entry.id,
    title: entry.name,
    channel: entry.channel,
    ...(entry.document === undefined ? {} : { document: entry.document }),
  }))

  function renderCategory(category: WorkspaceCategory, index: number) {
    const catLabel = categoryLabel(category, t)
    return (
      <SidebarCategory
        key={category.id}
        label={catLabel}
        description={categoryDescriptions?.[category.id]}
        actions={
          onCreateInCategory === undefined ? undefined : (
            <button
              type="button"
              data-testid={
                index === 0
                  ? 'espace-sidebar-create-channel-btn'
                  : `espace-category-create-${category.id}`
              }
              aria-label={t('console.workspace.channel.create-in-category', { category: catLabel })}
              title={t('console.workspace.channel.create-in-category', { category: catLabel })}
              onClick={() => onCreateInCategory(category)}
              className="flex h-6 w-6 items-center justify-center rounded-sm font-mono text-sm font-semibold text-c-ink-3 hover:bg-c-muted hover:text-c-ink focus-visible:ring focus-visible:outline-hidden"
            >
              +
            </button>
          )
        }
      >
        {category.channels.map((channel) => renderChannelOrRoomRow(channel, catLabel))}
      </SidebarCategory>
    )
  }

  const audioRooms = searchEntries.filter((entry) => entry.kind === 'audio')
  const channelNavigation = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* On a phone the column is the whole screen: the top bar already carries the
              organisation and its switch, and a touch screen has no shortcut to show. */}
      <div className="flex flex-col gap-3">
        {/* The bell sits beside the organisation; a simulation has no notifications to show. */}
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
        <UniversalSearch
          entries={searchEntries}
          onChoose={onChooseFromSearch}
          shortcut={!narrow}
          actions={[
            ...(onChangeCanvasMode
              ? [{ id: 'docs', label: 'Docs', open: () => onChangeCanvasMode('docs') }]
              : []),
            ...(canInvite
              ? [
                  {
                    id: 'invite',
                    label: t('console.workspace.channel-invite.action-open'),
                    open: onInvite,
                  },
                ]
              : []),
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
        <StudioNavigation
          compact={narrow}
          section="primary"
          mode={canvasMode}
          onChange={onSwitchCanvas}
          rooms={audioRooms}
          onChoose={onOpenChannel}
          activity={activity}
          files={files}
          onOpenDocument={onOpenDocument}
        />
        {sidebarActionSlot ?? null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {workspace.uncategorised_channels.length > 0 ? (
          <ul className="flex flex-col gap-1 border-b border-c-border-soft pb-2">
            {workspace.uncategorised_channels.map((channel) =>
              renderChannelOrRoomRow(channel, undefined)
            )}
          </ul>
        ) : null}
        {workspace.categories.map((category, index) => renderCategory(category, index))}
        {simulation || onSelectDirect === undefined || store.getDirects === undefined ? null : (
          <DirectMessages
            store={store}
            activeRoomId={activeDirectRoomId ?? null}
            onSelect={onSelectDirect}
            searchEntries={searchEntries}
          />
        )}
      </div>
    </div>
  )

  return (
    <nav
      aria-labelledby={headingId}
      ref={cssProperty('width', narrow ? undefined : `${width}px`)}
      className="material-panel order-first flex w-shell-sidebar-width shrink-0 flex-col justify-between overflow-hidden border-r border-c-border-soft p-3 narrow:max-h-[calc(100vh*3/4)] narrow:w-full narrow:border-r-0"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {channelNavigation}
        <StudioNavigation
          compact={narrow}
          section="tools"
          mode={canvasMode}
          onChange={onSwitchCanvas}
          rooms={audioRooms}
          onChoose={onOpenChannel}
          activity={activity}
          files={files}
          onOpenDocument={onOpenDocument}
        />
      </div>
      {sidebarFooterSlot ?? null}
      <ChannelMenu
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onSettings={onChannelSettings}
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

export const ChannelSidebar = memo(ChannelSidebarView)
