// One message of a channel's log or of a thread, with its reactions and its menu. Memoised: it is
// drawn again only when the message, or what is said about it (who its author is, its thread's
// replies, whether its thread is open), changes. A keystroke in the composer, a sound level in a
// call or a sidebar being resized draws no message again.

import { lazy, memo, Suspense, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../i18n/format'
import { Button } from '../../ui/Button/Button'
import { DropdownMenu } from '../../ui/DropdownMenu/DropdownMenu'
import { TimelineMessage } from '../../ui/TimelineMessage/TimelineMessage'
import type { ThreadParticipant } from '../../ui/TimelineMessage/TimelineMessage'
import type { ChannelDoc } from '../docs/ChannelDocsEditor'
import { useLocalProfile } from '../profile/localProfile'
import { usePassportServices } from '../profile/passportContext'
import { useAvatarSrc } from './useAvatarSrc'
import { profileMessages } from '../profile/profileMessages'
import {
  UserProfilePopover,
  type MemberProfile,
  type MemberProfileRole,
} from '../profile/UserProfilePopover'
import { studioMessages } from '../workspace/studioMessages'
import { nameOf, sameItems } from './liveViewModel'
import type { MessageView } from './matrix/timeline'
import { MessageText, type MentionMember } from './MessageText'
import { isMatrixUserId } from './roomInvitations'
import { MessageAttachments } from '../messaging/attachments/MessageAttachments'
import { useMessagingOrganisation } from '../messaging/organisationContext'
import { UnfurlCard } from '../messaging/unfurl/UnfurlCard'
import { aiTranslationMessages } from './ai/aiTranslationMessages'
import { useCustomEmojis } from './customEmojiStore'
import { useExperiencePreferences } from './experienceApi'
import { experienceCopy } from './experienceMessages'
import { renderReactionGlyph } from './KoderaEmoji'
import { ReactionPalette } from './ReactionPalette'
import { ReminderCreateDialog } from './RemindersPanel'

const LazyMessageTranslationBlock = lazy(() =>
  import('./ai/MessageTranslationBlock').then((module) => ({
    default: module.MessageTranslationBlock,
  }))
)

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
  /** The message continues its author's run above it: no avatar, no header (`continuesRun`). */
  compact?: boolean | undefined
  placement: 'timeline' | 'thread'
  viewerId: string
  archived: boolean
  canWrite?: boolean | undefined
  canReact?: boolean | undefined
  expanded: boolean
  repliedMessage: MessageView | undefined
  threadReplies: readonly MessageView[]
  menuContextKey: string
  /** The message is one of the room's pins. */
  pinned?: boolean | undefined
  /** Pins or unpins it; absent where the member may not change the room's pins. */
  onPin?: ((eventId: string, pinned: boolean) => void) | undefined
  /** Authoritative room members for rendering `@Name` mention pills without spoofing. */
  mentionMembers?: readonly MentionMember[] | undefined
  /** Resolves a Matrix user ID to its authoritative room profile; never trusts sender HTML labels. */
  resolveMember?: ((userId: string) => MemberProfile) | undefined
  /** Matrix room ID when available, for personal reminders on non-confidential rooms. */
  roomId?: string | undefined
  /** Core channel UUID when rendered inside a non-DM workspace channel. */
  channelId?: string | undefined
  /** Whether room confidentiality boundary permits plaintext inline previews and personal reminders. */
  plaintextPermitted?: boolean | undefined
  /** Whether room confidentiality boundary permits sovereign AI message translation. */
  allowAiTranslate?: boolean | undefined
}

/** One mounted message; only activation reports a timeline opener to the view. */
function MessageRowView({
  document,
  onOpenDocument,
  message: msg,
  compact = false,
  profileRole,
  onMention,
  onlineLabel,
  placement,
  viewerId,
  archived: isReadOnlyChannel,
  canWrite = true,
  canReact = true,
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
  pinned = false,
  onPin,
  mentionMembers,
  resolveMember,
  roomId,
  channelId,
  plaintextPermitted = true,
  allowAiTranslate = false,
}: MessageRowProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const organisationId = useMessagingOrganisation()
  const prefs = useExperiencePreferences(organisationId)
  const { shortcodeSet } = useCustomEmojis(organisationId)
  const expCopy = experienceCopy(i18n.resolvedLanguage)
  const [translationOpen, setTranslationOpen] = useState(false)
  const [reminderDialogOpen, setReminderDialogOpen] = useState(false)
  const [activeMessageKey, setActiveMessageKey] = useState(msg.key)
  if (activeMessageKey !== msg.key) {
    setActiveMessageKey(msg.key)
    setTranslationOpen(false)
    setReminderDialogOpen(false)
  }
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
    ...(msg.avatarMxc === undefined ? {} : { avatarMxc: msg.avatarMxc }),
  }
  const avatarSrc = useAvatarSrc(usePassportServices()?.avatars, msg.avatarMxc)
  // Authoritative room members lead; sender-authored HTML pills cannot override an authoritative
  // member's name or hijack another room member's display name.
  const authoritativeByUser = new Map<string, string>()
  const authoritativeByLowerName = new Map<string, string>()
  const effectiveMembers: MentionMember[] = []
  const registerAuthoritative = (userId: string, name: string | undefined) => {
    const clean = name?.trim()
    if (!clean || authoritativeByUser.has(userId)) return
    authoritativeByUser.set(userId, clean)
    if (!authoritativeByLowerName.has(clean.toLowerCase())) {
      authoritativeByLowerName.set(clean.toLowerCase(), userId)
    }
    effectiveMembers.push({ userId, name: clean })
  }
  for (const item of mentionMembers ?? []) registerAuthoritative(item.userId, item.name)
  registerAuthoritative(msg.sender, authorName)
  for (const candidate of msg.mentionPills ?? []) {
    if (!isMatrixUserId(candidate.userId)) continue
    const label = candidate.label.trim()
    if (label === '') continue
    const owner = authoritativeByLowerName.get(label.toLowerCase())
    if (owner !== undefined && owner !== candidate.userId) continue
    const knownName = authoritativeByUser.get(candidate.userId)
    if (knownName !== undefined) continue
    effectiveMembers.push({ userId: candidate.userId, name: label })
  }
  const [pill, setPill] = useState<{ userId: string; anchor: HTMLElement } | null>(null)
  const pillMember: MemberProfile | null =
    pill === null
      ? null
      : pill.userId === msg.sender
        ? member
        : (resolveMember?.(pill.userId) ?? {
            userId: pill.userId,
            name: authoritativeByUser.get(pill.userId) ?? pill.userId,
            presence: 'offline',
            role: 'member',
          })
  const isoTime = new Date(msg.ts).toISOString()
  const isOwn = msg.sender === viewerId
  const allowWrite = !isReadOnlyChannel && canWrite
  const allowReact = !isReadOnlyChannel && canReact
  const canTranslate =
    organisationId !== null &&
    allowAiTranslate &&
    channelId !== undefined &&
    channelId !== '' &&
    !msg.redacted &&
    msg.body.trim() !== ''
  const canRemind =
    organisationId !== null &&
    plaintextPermitted &&
    prefs.labsFlags.personal_reminders &&
    !msg.redacted &&
    Boolean((channelId && channelId !== '') || (roomId && roomId !== ''))
  const hasMenuItems = allowReact || !inThread || isOwn || canTranslate || canRemind
  return (
    <TimelineMessage
      own={isOwn}
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
      {...(avatarSrc === undefined ? {} : { avatarSrc })}
      avatarOnlineLabel={presence === 'offline' ? undefined : copy[presence]}
      profileTrigger={(trigger) => (
        <UserProfilePopover
          member={member}
          trigger={trigger}
          onMention={isOwn || !allowWrite ? undefined : onMention}
        />
      )}
      dateTime={isoTime}
      timeLabel={formatTime(isoTime, locale)}
      focused={!inThread && expanded}
      compact={compact}
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
        emoji: renderReactionGlyph(r.key, organisationId, shortcodeSet),
        count: r.count,
        mine: r.mine,
        label: t(
          r.mine
            ? 'console.workspace.message.reaction-mine'
            : 'console.workspace.message.reaction-label',
          { emoji: r.key, count: r.count }
        ),
        // Where the member may not react, the counts stay readable but nothing can be pressed.
        ...(allowReact ? { onToggle: () => onReaction(msg.eventId, r.key) } : {}),
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
        isReadOnlyChannel || (!allowReact && !hasMenuItems) ? undefined : (
          <div className="flex items-center gap-1">
            {allowReact ? (
              <ReactionPalette
                mine={new Set(msg.reactions.filter((r) => r.mine).map((r) => r.key))}
                onReact={(key) => onReaction(msg.eventId, key)}
              />
            ) : null}
            {!hasMenuItems ? null : (
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
                  ...(allowReact
                    ? [
                        {
                          label: t('console.workspace.message.action-react'),
                          onSelect: () => onReaction(msg.eventId, '👍'),
                        },
                      ]
                    : []),
                  ...(!inThread && allowWrite
                    ? [
                        {
                          label: t('console.workspace.message.action-reply'),
                          onSelect: () => onReply(msg),
                        },
                      ]
                    : []),
                  ...(!inThread
                    ? [
                        {
                          label: t('console.workspace.message.action-open-thread'),
                          onSelect: () => {
                            const trigger = actionsTrigger.current
                            if (trigger !== null) onOpenThread(msg.eventId, trigger)
                          },
                        },
                      ]
                    : []),
                  ...(!inThread && onPin !== undefined && !msg.redacted
                    ? [
                        {
                          label: t(
                            pinned
                              ? 'console.workspace.message.action-unpin'
                              : 'console.workspace.message.action-pin'
                          ),
                          onSelect: () => onPin(msg.eventId, !pinned),
                        },
                      ]
                    : []),
                  ...(canTranslate
                    ? [
                        {
                          label: aiTranslationMessages[locale].menuTranslate,
                          onSelect: () => setTranslationOpen(true),
                        },
                      ]
                    : []),
                  ...(canRemind
                    ? [
                        {
                          label: expCopy.reminders.menuAction,
                          onSelect: () => setReminderDialogOpen(true),
                        },
                      ]
                    : []),
                  ...(isOwn && allowWrite
                    ? [
                        {
                          label: t('console.workspace.message.action-edit'),
                          onSelect: () => onEdit(msg),
                        },
                      ]
                    : []),
                  ...(isOwn
                    ? [
                        {
                          label: t('console.workspace.message.action-delete'),
                          destructive: true,
                          onSelect: () => onRemove(msg.eventId),
                        },
                      ]
                    : []),
                ]}
              />
            )}
          </div>
        )
      }
    >
      {msg.body === '' ? null : (
        <MessageText
          body={msg.body}
          members={effectiveMembers}
          onMentionClick={(userId, anchor) => {
            if (isMatrixUserId(userId)) setPill({ userId, anchor })
          }}
        />
      )}
      {pill === null || pillMember === null ? null : (
        <UserProfilePopover
          member={pillMember}
          anchor={pill.anchor}
          onAnchorClose={() => setPill(null)}
          onMention={pill.userId === viewerId || !allowWrite ? undefined : onMention}
        />
      )}
      {msg.attachments === undefined ? null : (
        <MessageAttachments refs={msg.attachments} plaintextPermitted={plaintextPermitted} />
      )}
      {msg.redacted ? null : <UnfurlCard body={msg.body} />}
      {reminderDialogOpen && canRemind && organisationId !== null ? (
        <ReminderCreateDialog
          open={reminderDialogOpen}
          onOpenChange={setReminderDialogOpen}
          organisationId={organisationId}
          channelId={channelId}
          roomId={roomId}
          targetEventId={msg.eventId}
        />
      ) : null}
      {translationOpen && canTranslate && organisationId !== null && channelId !== undefined ? (
        <Suspense fallback={null}>
          <LazyMessageTranslationBlock
            key={`${msg.eventId}:${menuContextKey}`}
            organisationId={organisationId}
            channelId={channelId}
            eventId={msg.eventId}
            sourceText={msg.body}
            onClose={() => setTranslationOpen(false)}
          />
        </Suspense>
      ) : null}
    </TimelineMessage>
  )
}

/**
 * A thread's replies are the same while each reply is: a store that rebuilds the array for an
 * unchanged thread has changed nothing a message draws.
 */
function sameMentionMembers(
  left: readonly MentionMember[] | undefined,
  right: readonly MentionMember[] | undefined
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]!.userId !== right[i]!.userId || left[i]!.name !== right[i]!.name) return false
  }
  return true
}

function sameRow(previous: MessageRowProps, next: MessageRowProps): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<
    keyof MessageRowProps
  >
  for (const key of keys) {
    if (key === 'threadReplies') {
      if (!sameItems(previous.threadReplies, next.threadReplies)) return false
    } else if (key === 'mentionMembers') {
      if (!sameMentionMembers(previous.mentionMembers, next.mentionMembers)) return false
    } else if (!Object.is(previous[key], next[key])) return false
  }
  return true
}

export const MessageRow = memo(MessageRowView, sameRow)
