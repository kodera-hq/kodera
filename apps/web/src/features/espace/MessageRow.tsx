// One message of a channel's log or of a thread, with its reactions and its menu. Memoised: it is
// drawn again only when the message, or what is said about it (who its author is, its thread's
// replies, whether its thread is open), changes. A keystroke in the composer, a sound level in a
// call or a sidebar being resized draws no message again.

import { memo, useRef } from 'react'
import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { DropdownMenu } from '../../ui/DropdownMenu/DropdownMenu'
import { TimelineMessage } from '../../ui/TimelineMessage/TimelineMessage'
import type { ThreadParticipant } from '../../ui/TimelineMessage/TimelineMessage'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import { useLocalProfile } from '../profile/localProfile'
import { profileMessages } from '../profile/profileMessages'
import {
  UserProfilePopover,
  type MemberProfile,
  type MemberProfileRole,
} from '../profile/UserProfilePopover'
import { studioMessages } from '../workspace/studioMessages'
import { nameOf, sameItems } from './liveViewModel'
import type { MessageView } from './matrix/timeline'
import { MessageText } from './MessageText'
import { MessageAttachments } from '../messaging/attachments/MessageAttachments'
import { UnfurlCard } from '../messaging/unfurl/UnfurlCard'
import { ReactionPalette } from './ReactionPalette'

function uniqueThreadParticipants(replies: readonly MessageView[]): ThreadParticipant[] {
  const seen = new Set<string>()
  const result: ThreadParticipant[] = []
  for (const reply of replies) {
    if (seen.has(reply.sender)) continue
    seen.add(reply.sender)
    result.push({ id: reply.sender, name: nameOf(reply) })
  }
  return result
}

/** What a message's controls do. Each keeps its identity for as long as the room is shown. */
export interface MessageRowActions {
  onRetry: (message: MessageView) => void
  onReaction: (eventId: string, reaction: string) => void
  onReply: (message: MessageView) => void
  onEdit: (message: MessageView) => void
  onRemove: (eventId: string) => void
  onOpenThread: (eventId: string, button: HTMLButtonElement) => void
}

export interface MessageRowProps extends MessageRowActions {
  document?: ChannelDoc | undefined
  onOpenDocument?: ((doc: ChannelDoc) => void) | undefined
  profileRole: MemberProfileRole
  onMention: ((member: MemberProfile) => void) | undefined
  onlineLabel?: string | undefined
  message: MessageView
  placement: 'timeline' | 'thread'
  viewerId: string
  archived: boolean
  expanded: boolean
  repliedMessage: MessageView | undefined
  threadReplies: readonly MessageView[]
  menuContextKey: string
}

/** One mounted message; only activation reports a timeline opener to the view. */
function MessageRowView({
  document,
  onOpenDocument,
  message: msg,
  profileRole,
  onMention,
  onlineLabel,
  placement,
  viewerId,
  archived: isReadOnlyChannel,
  expanded,
  repliedMessage: repliedMsg,
  threadReplies,
  menuContextKey,
  onRetry,
  onReaction,
  onReply,
  onEdit,
  onRemove,
  onOpenThread,
}: MessageRowProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const actionsTrigger = useRef<HTMLButtonElement | null>(null)
  const inThread = placement === 'thread'
  const { profile, hasProfile } = useLocalProfile(viewerId)
  const copy = profileMessages(i18n.resolvedLanguage)
  const authorName =
    msg.sender === viewerId && profile.displayName ? profile.displayName : nameOf(msg)
  const presence =
    msg.sender === viewerId && hasProfile ? profile.presence : onlineLabel ? 'online' : 'offline'
  const member: MemberProfile = {
    userId: msg.sender,
    name: authorName,
    presence,
    role: profileRole,
    ...(msg.sender === viewerId ? { status: profile.status } : {}),
  }
  const isoTime = new Date(msg.ts).toISOString()
  const isOwn = msg.sender === viewerId
  return (
    <TimelineMessage
      document={
        document && onOpenDocument
          ? {
              title: document.title,
              subtitle: studioMessages[locale].documentStatus,
              openLabel: studioMessages[locale].openDocument,
              onOpen: () => onOpenDocument(document),
            }
          : undefined
      }
      author={authorName}
      avatarIdentity={msg.sender}
      avatarOnlineLabel={presence === 'offline' ? undefined : copy[presence]}
      profileTrigger={(trigger) => (
        <UserProfilePopover
          member={member}
          trigger={trigger}
          onMention={isOwn ? undefined : onMention}
        />
      )}
      dateTime={isoTime}
      timeLabel={formatTime(isoTime, locale)}
      focused={!inThread && expanded}
      {...(msg.mentionsMe === true
        ? { mention: t('console.workspace.message.label-mentions-you') }
        : {})}
      {...(msg.edited ? { edited: t('console.workspace.message.label-edited') } : {})}
      {...(msg.redacted ? { deleted: t('console.workspace.message.label-deleted') } : {})}
      {...(repliedMsg !== undefined
        ? {
            reply: {
              label: t('console.workspace.message.label-reply'),
              author: nameOf(repliedMsg),
              excerpt: repliedMsg.redacted
                ? t('console.workspace.message.label-deleted')
                : repliedMsg.body,
            },
          }
        : {})}
      {...(msg.delivery === 'pending'
        ? { delivery: { state: 'sending', label: t('console.workspace.message.status-sending') } }
        : msg.delivery === 'failed'
          ? {
              delivery: {
                state: 'failed',
                label: t('console.workspace.message.status-failed'),
                retryLabel: t('console.common.action-retry'),
                onRetry: () => onRetry(msg),
              },
            }
          : {})}
      reactions={msg.reactions.map((r) => ({
        key: r.key,
        emoji: r.key,
        count: r.count,
        mine: r.mine,
        label: t(
          r.mine
            ? 'console.workspace.message.reaction-mine'
            : 'console.workspace.message.reaction-label',
          { emoji: r.key, count: r.count }
        ),
        onToggle: () => onReaction(msg.eventId, r.key),
      }))}
      {...(!inThread && threadReplies.length > 0
        ? {
            thread: {
              label: t('console.workspace.thread.count-replies', { count: threadReplies.length }),
              expanded,
              participants: uniqueThreadParticipants(threadReplies),
              onOpen: (event: MouseEvent<HTMLButtonElement>) =>
                onOpenThread(msg.eventId, event.currentTarget),
            },
          }
        : {})}
      actions={
        isReadOnlyChannel ? undefined : (
          <div className="flex items-center gap-1">
            <ReactionPalette
              mine={new Set(msg.reactions.filter((r) => r.mine).map((r) => r.key))}
              onReact={(key) => onReaction(msg.eventId, key)}
            />
            <DropdownMenu
              key={menuContextKey}
              label={t('console.workspace.message.actions-label', {
                author: authorName,
                time: formatTime(isoTime, locale),
              })}
              trigger={
                <Button
                  ref={inThread ? undefined : actionsTrigger}
                  variant="tertiary"
                  size="sm"
                  aria-label={t('console.workspace.message.actions-label', {
                    author: authorName,
                    time: formatTime(isoTime, locale),
                  })}
                >
                  <span aria-hidden="true">···</span>
                </Button>
              }
              items={[
                {
                  label: t('console.workspace.message.action-react'),
                  onSelect: () => onReaction(msg.eventId, '👍'),
                },
                ...(!inThread
                  ? [
                      {
                        label: t('console.workspace.message.action-reply'),
                        onSelect: () => onReply(msg),
                      },
                      {
                        label: t('console.workspace.message.action-open-thread'),
                        onSelect: () => {
                          const trigger = actionsTrigger.current
                          if (trigger !== null) onOpenThread(msg.eventId, trigger)
                        },
                      },
                    ]
                  : []),
                ...(isOwn
                  ? [
                      {
                        label: t('console.workspace.message.action-edit'),
                        onSelect: () => onEdit(msg),
                      },
                      {
                        label: t('console.workspace.message.action-delete'),
                        destructive: true,
                        onSelect: () => onRemove(msg.eventId),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        )
      }
    >
      {msg.body === '' ? null : <MessageText body={msg.body} />}
      {msg.attachments === undefined ? null : <MessageAttachments refs={msg.attachments} />}
      {msg.redacted ? null : <UnfurlCard body={msg.body} />}
    </TimelineMessage>
  )
}

/**
 * A thread's replies are the same while each reply is: a store that rebuilds the array for an
 * unchanged thread has changed nothing a message draws.
 */
function sameRow(previous: MessageRowProps, next: MessageRowProps): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<
    keyof MessageRowProps
  >
  for (const key of keys) {
    if (key === 'threadReplies') {
      if (!sameItems(previous.threadReplies, next.threadReplies)) return false
    } else if (!Object.is(previous[key], next[key])) return false
  }
  return true
}

export const MessageRow = memo(MessageRowView, sameRow)
