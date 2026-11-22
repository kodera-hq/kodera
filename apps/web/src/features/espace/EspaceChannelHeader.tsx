import { Fragment, useEffect } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoomBoundary } from '../confidential/room-boundary'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import { StudioNavigation } from '../workspace/StudioNavigation'
import type { WorkspaceChannel } from '../workspace/workspace'
import { Button } from '../../ui/Button/Button'
import { PersonIcon } from '../../ui/icons/Person'
import { cleanText } from '../../ui/safeText'
import { AntennaIcon } from './AntennaIcon'
import { ChannelInviteDialog } from './ChannelInviteDialog'
import { confidentialMessages } from './confidentialMessages'
import {
  isNamedProfile,
  isProximityChannel,
  safeDisplayName,
  type CanvasMode,
  type EspaceStoreLike,
} from './liveViewModel'
import type { DirectSummary } from './matrix/directs'
import { HEADER_FACES, type RoomSummary } from './matrix/store'
import { MemberAvatar } from './MemberAvatar'
import { MessageSearch } from './MessageSearch'
import { PinnedMessages } from './PinnedMessages'

export interface EspaceChannelHeaderProps {
  org: string
  activeStore: EspaceStoreLike
  activeChannel: WorkspaceChannel | null | undefined
  activeChannelName: string
  activeRoom: RoomSummary | undefined
  activeRoomId: string | null
  directRoomId: string | null
  activeDirect: DirectSummary | undefined
  proximityChannelIds: ReadonlySet<string> | undefined
  roomBoundary: RoomBoundary | undefined
  effectiveCanvasMode: CanvasMode
  focusedDocs: boolean
  navigationUnsettled: boolean
  signedOut: boolean
  simulation: boolean
  demoPresenceLabel: string
  unnamedMember: string
  narrow: boolean
  membersOpen: boolean
  membersPanelId: string
  headingRef: RefObject<HTMLHeadingElement | null>
  inviteTrigger: RefObject<HTMLButtonElement | null>
  membersTrigger: RefObject<HTMLButtonElement | null>
  audioRooms: readonly ChannelSearchEntry[]
  onShowMessage: (eventId: string) => boolean
  onToggleMembers: () => void
  onOpenCalls: () => void
  onChooseAudioRoom: (entry: ChannelSearchEntry) => HTMLElement | null
}

export function EspaceChannelHeader({
  org,
  activeStore,
  activeChannel,
  activeChannelName,
  activeRoom,
  activeRoomId,
  directRoomId,
  activeDirect,
  proximityChannelIds,
  roomBoundary,
  effectiveCanvasMode,
  focusedDocs,
  navigationUnsettled,
  signedOut,
  simulation,
  demoPresenceLabel,
  unnamedMember,
  narrow,
  membersOpen,
  membersPanelId,
  headingRef,
  inviteTrigger,
  membersTrigger,
  audioRooms,
  onShowMessage,
  onToggleMembers,
  onOpenCalls,
  onChooseAudioRoom,
}: EspaceChannelHeaderProps) {
  const { t, i18n } = useTranslation()
  const protectionCopy = confidentialMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']

  const memberCount =
    activeRoom?.joined === undefined
      ? null
      : t('console.workspace.channel.members-count', { count: activeRoom.joined })
  const directPeer = activeDirect?.userIds
  const directPresence =
    directPeer?.length === 1
      ? activeStore.isOnline?.(directPeer[0]!)
        ? t('console.workspace.presence.online')
        : t('console.workspace.directs.header-offline')
      : undefined
  const headerLine =
    directRoomId !== null
      ? directPresence === undefined
        ? []
        : [{ key: 'presence', text: directPresence }]
      : [
          ...(activeChannel !== null && activeChannel !== undefined && activeChannel.topic !== ''
            ? [{ key: 'topic', text: activeChannel.topic }]
            : []),
          ...(memberCount === null ? [] : [{ key: 'members', text: memberCount }]),
        ]
  const faces = activeRoom?.faces ?? []
  const facesMissing =
    activeRoom?.joined !== undefined && faces.length < Math.min(HEADER_FACES, activeRoom.joined - 1)
  useEffect(() => {
    if (activeRoomId !== null && facesMissing) activeStore.loadMembers?.(activeRoomId)
  }, [activeStore, activeRoomId, facesMissing])

  return (
    <header
      hidden={effectiveCanvasMode === 'files' || effectiveCanvasMode === 'integrations'}
      className="flex items-center gap-3 border-b border-c-border-soft pb-4 narrow:flex-wrap narrow:gap-2 narrow:pb-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 narrow:basis-full">
        {activeChannel === null || activeChannel === undefined ? (
          <h1
            ref={headingRef}
            tabIndex={-1}
            data-route-heading=""
            className="text-lg font-semibold text-c-ink"
          >
            {t(
              activeChannel === null
                ? 'console.workspace.channel.title-not-found'
                : 'console.workspace._.title'
            )}
          </h1>
        ) : (
          <h1
            ref={headingRef}
            tabIndex={-1}
            data-route-heading=""
            className="flex min-w-0 items-center gap-2 text-lg font-semibold text-c-ink"
          >
            {directRoomId !== null ? (
              <>
                <span aria-hidden="true" className="inline-flex shrink-0">
                  <MemberAvatar
                    mxc={activeDirect?.avatarMxc}
                    name={activeChannelName}
                    identity={activeDirect?.userIds[0] ?? directRoomId}
                    size="xs"
                  />
                </span>
                <span aria-hidden="true" className="font-medium text-c-ink-3">
                  @
                </span>
              </>
            ) : isProximityChannel(activeChannel, proximityChannelIds) ? (
              <span aria-hidden="true" className="text-c-ink-3">
                <AntennaIcon />
              </span>
            ) : (
              <span aria-hidden="true" className="font-mono font-medium text-c-ink-3">
                #
              </span>
            )}
            <span className="min-w-0 truncate">{activeChannelName}</span>
          </h1>
        )}
        {roomBoundary === undefined ? null : (
          <p role="status" className="text-xs text-c-ink-3">
            {protectionCopy[roomBoundary]}
          </p>
        )}
        {headerLine.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 text-sm text-c-ink-3">
              {headerLine.map((part, index) => (
                <Fragment key={part.key}>
                  {index > 0 ? (
                    <>
                      {' '}
                      <span aria-hidden="true">·</span>{' '}
                    </>
                  ) : null}
                  <span>{part.text}</span>
                </Fragment>
              ))}
            </p>
            {memberCount !== null && faces.length > 0 ? (
              <span className="flex shrink-0 gap-1 narrow:hidden">
                {faces.map((face) => {
                  const named = isNamedProfile(cleanText(face.name, 80), face.userId)
                  return (
                    <MemberAvatar
                      key={face.userId}
                      mxc={face.avatarMxc}
                      name={safeDisplayName(face.name, face.userId, unnamedMember)}
                      identity={face.userId}
                      onlineLabel={
                        activeStore.isOnline?.(face.userId)
                          ? simulation
                            ? demoPresenceLabel
                            : t('console.workspace.presence.online')
                          : undefined
                      }
                      anonymous={!named}
                      size="xs"
                      className="ring-2 ring-c-surface"
                    />
                  )
                })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {directRoomId === null &&
      activeRoom !== undefined &&
      activeChannel != null &&
      !focusedDocs &&
      effectiveCanvasMode === 'chat' ? (
        <ChannelInviteDialog
          key={`${org}:${activeRoom.roomId}`}
          triggerRef={inviteTrigger}
          org={org}
          channel={activeChannel}
          room={activeRoom}
          store={activeStore}
          unavailable={navigationUnsettled || signedOut}
        />
      ) : null}
      {activeRoomId === null || focusedDocs || effectiveCanvasMode !== 'chat' ? null : (
        <>
          <MessageSearch store={activeStore} roomId={activeRoomId} onShow={onShowMessage} />
          <PinnedMessages store={activeStore} roomId={activeRoomId} onShow={onShowMessage} />
        </>
      )}
      {activeRoomId === null || focusedDocs ? null : (
        <Button
          variant="tertiary"
          size="sm"
          icon={<PersonIcon />}
          iconOnly
          aria-label={t('console.workspace.members.title')}
          ref={membersTrigger}
          aria-controls={membersPanelId}
          aria-expanded={membersOpen}
          onClick={onToggleMembers}
        />
      )}
      <StudioNavigation
        compact={narrow}
        section="call-entry"
        mode={effectiveCanvasMode}
        onOpenCalls={onOpenCalls}
        rooms={audioRooms}
        onChoose={onChooseAudioRoom}
      />
      {effectiveCanvasMode === 'docs' ? (
        <span className="text-sm font-bold text-c-ink">
          {t('console.workspace.canvas.mode-docs')}
        </span>
      ) : null}
    </header>
  )
}
