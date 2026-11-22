import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ThreadPanel } from '../../ui/ThreadPanel/ThreadPanel'
import type { MemberProfile } from '../profile/UserProfilePopover'
import type { DraftChannel } from './draftChannel'
import { NO_MESSAGES, profileRoleIn, type EspaceStoreLike } from './liveViewModel'
import type { MessageView } from './matrix/timeline'
import type { MentionCandidate } from './mentions'
import { ThreadComposer } from './MessageComposer'
import { MessageRow, type MessageRowActions } from './MessageRow'

export interface EspaceThreadPaneProps {
  activeStore: EspaceStoreLike
  activeRoomId: string | null
  directRoomId: string | null
  activeChannelName: string
  threadRootMessage: MessageView
  activeThreadReplies: readonly MessageView[]
  openThreadRootId: string | null
  draft: DraftChannel
  draftGeneration: number
  viewerId: string
  isArchivedChannel: boolean
  canWrite: boolean
  canReact: boolean
  simulation: boolean
  demoPresenceLabel: string
  navigationUnsettled: boolean
  threadInputId: string
  demoGuidanceId: string
  mentionCandidates: readonly MentionCandidate[]
  mentionMembers: readonly { userId: string; name: string }[] | undefined
  resolveMember: (userId: string) => MemberProfile
  onMention: ((member: MemberProfile) => void) | undefined
  onLoadMembers: () => void
  onClose: () => void
  returnFocusTo: RefObject<HTMLElement | null>
  rowActions: MessageRowActions
}

export function EspaceThreadPane({
  activeStore,
  activeRoomId,
  directRoomId,
  activeChannelName,
  threadRootMessage,
  activeThreadReplies,
  openThreadRootId,
  draft,
  draftGeneration,
  viewerId,
  isArchivedChannel,
  canWrite,
  canReact,
  simulation,
  demoPresenceLabel,
  navigationUnsettled,
  threadInputId,
  demoGuidanceId,
  mentionCandidates,
  mentionMembers,
  resolveMember,
  onMention,
  onLoadMembers,
  onClose,
  returnFocusTo,
  rowActions,
}: EspaceThreadPaneProps) {
  const { t } = useTranslation()
  const onlineLabelFor = (sender: string) =>
    activeStore.isOnline?.(sender)
      ? simulation
        ? demoPresenceLabel
        : t('console.workspace.presence.online')
      : undefined

  return (
    <div className="row-span-3 row-start-1 flex min-h-0 narrow:contents">
      <ThreadPanel
        label={t('console.workspace.thread.title')}
        title={t('console.workspace.thread.title')}
        channel={directRoomId === null ? `# ${activeChannelName}` : `@${activeChannelName}`}
        closeLabel={t('console.common.action-close')}
        onClose={onClose}
        returnFocusTo={returnFocusTo}
        parent={
          <MessageRow
            profileRole={profileRoleIn(activeStore, activeRoomId, threadRootMessage.sender)}
            onMention={onMention}
            mentionMembers={mentionMembers}
            resolveMember={resolveMember}
            key={threadRootMessage.key}
            onlineLabel={onlineLabelFor(threadRootMessage.sender)}
            message={threadRootMessage}
            placement="thread"
            viewerId={viewerId}
            archived={isArchivedChannel}
            canWrite={canWrite}
            canReact={canReact}
            expanded={false}
            repliedMessage={undefined}
            threadReplies={NO_MESSAGES}
            menuContextKey={`${draftGeneration}:${viewerId}:${activeRoomId}:${threadRootMessage.key}`}
            {...rowActions}
          />
        }
        repliesLabel={t('console.workspace.thread.label-replies')}
        composer={
          !canWrite || activeRoomId === null || openThreadRootId === null ? undefined : (
            <ThreadComposer
              store={activeStore}
              roomId={activeRoomId}
              rootEventId={openThreadRootId}
              draft={draft}
              simulation={simulation}
              navigationUnsettled={navigationUnsettled}
              inputId={threadInputId}
              guidanceId={demoGuidanceId}
              members={mentionCandidates}
              onMentionStart={onLoadMembers}
            />
          )
        }
      >
        {activeThreadReplies.map((reply) => (
          <MessageRow
            profileRole={profileRoleIn(activeStore, activeRoomId, reply.sender)}
            onMention={onMention}
            mentionMembers={mentionMembers}
            resolveMember={resolveMember}
            key={reply.key}
            onlineLabel={onlineLabelFor(reply.sender)}
            message={reply}
            placement="thread"
            viewerId={viewerId}
            archived={isArchivedChannel}
            canWrite={canWrite}
            canReact={canReact}
            expanded={false}
            repliedMessage={undefined}
            threadReplies={NO_MESSAGES}
            menuContextKey={`${draftGeneration}:${viewerId}:${activeRoomId}:${reply.key}`}
            {...rowActions}
          />
        ))}
      </ThreadPanel>
    </div>
  )
}
