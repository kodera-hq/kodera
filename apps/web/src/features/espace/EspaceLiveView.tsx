import { transformOutsideCode } from '../messaging/formatting'
import { RichComposerInput } from '../messaging/RichComposerInput'
import { UniversalSearch } from '../command-palette/UniversalSearch'
import { demoMessages } from '../../app/demoMessages'
import type { ChannelDoc, ChannelDocsWorkspace } from '../docs/ChannelDocsEditor'
import { StudioNavigation } from '../workspace/StudioNavigation'
import { studioMessages } from '../workspace/studioMessages'
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { FormEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { AnyRouter } from '@tanstack/react-router'
import { Trans, useTranslation } from 'react-i18next'
import { getMatrixRegistrationStamp, type MatrixSession } from '../../auth/matrix'
import {
  EMPTY_DRAFT,
  useEspaceDraftMemory,
  type ChannelDraft,
  type DraftLease,
  type RoomTarget,
} from './EspaceDraftProvider'
import type { MessageKey } from '../../i18n'
import { calendarDay, formatDayDivider, formatTime, previousCalendarDay } from '../../i18n/format'
import { DropdownMenu } from '../../ui/DropdownMenu/DropdownMenu'
import { Button } from '../../ui/Button/Button'
import { Drawer } from '../../ui/Drawer/Drawer'
import { Tooltip } from '../../ui/Tooltip/Tooltip'
import { AudioDock } from '../../ui/AudioDock/AudioDock'
import { audioPreviewMessages } from './audio/previewMessages'
import { Avatar } from '../../ui/Avatar/Avatar'
import { ChannelInviteDialog } from './ChannelInviteDialog'
import { useLocalProfile } from '../profile/localProfile'
import {
  UserProfilePopover,
  type MemberProfile,
  type MemberProfileRole,
} from '../profile/UserProfilePopover'
import { profileMessages } from '../profile/profileMessages'
import {
  getWorkspaceSettingsEpoch,
  registerWorkspaceSettingsRuntime,
} from '../workspace/settingsRuntime'
import { PersonIcon } from '../../ui/icons/Person'
import { CloseIcon } from '../../ui/icons/Close'
import { ChannelRow } from '../../ui/ChannelRow/ChannelRow'
import { cx } from '../../ui/cx'
import { TOUCH_TARGET, TOUCH_TARGET_HEIGHT } from '../../ui/touchTarget'
import { MentionIcon, SendIcon } from '../../ui/icons/Composer'
import { InlineAlert } from '../../ui/InlineAlert/InlineAlert'
import { RoomRow } from '../../ui/RoomRow/RoomRow'
import type { RoomOccupant } from '../../ui/RoomRow/RoomRow'
import { SidebarCategory } from '../../ui/SidebarCategory/SidebarCategory'
import { ThreadPanel } from '../../ui/ThreadPanel/ThreadPanel'
import { TimelineDivider } from '../../ui/TimelineDivider/TimelineDivider'
import { TimelineMessage } from '../../ui/TimelineMessage/TimelineMessage'
import type { ThreadParticipant } from '../../ui/TimelineMessage/TimelineMessage'
import { useNarrowViewport } from '../../app/useNarrowViewport'
import { withdrawn } from '../workspace/ChannelSearch'
import type { ChannelSearchEntry } from '../workspace/ChannelSearch'
import { OrganisationHeader } from '../workspace/OrganisationHeader'
import { categoryLabel, channelLabel, currentChannel } from '../workspace/workspace'
import type { Workspace, WorkspaceCategory, WorkspaceChannel } from '../workspace/workspace'
import {
  createCallController,
  type CallProblem,
  type CallSnapshot,
  type CallStatus,
} from './audio/call'
import {
  createEspaceStore,
  HEADER_FACES,
  type ChannelRoom,
  type EspaceSnapshot,
  type History,
  type MemberView,
  type RoomSummary,
  type SendOptions,
} from './matrix/store'
import { serverNameOf } from './homeserver'
import { LeaveCallGuard } from './LeaveCallGuard'
import { useTimelineScroll } from './useTimelineScroll'
import { MentionInput } from './MentionInput'
import type { TFunction } from 'i18next'
import { mentionedIn } from './mentions'
import type { MentionCandidate } from './mentions'
import { useMarkRead } from './useMarkRead'
import { timelineRows } from './timelineRows'
import { useCalendarToday } from './useCalendarToday'
import { useTabTitle } from './useTabTitle'
import { useMicActivity } from './useMicActivity'
import { AudioSettings, type AudioSettingsCall } from './AudioSettings'
import { MessageText } from './MessageText'
import { ReactionPalette } from './ReactionPalette'
import { EmojiPalette } from './EmojiPalette'
import { replaceShortcodes } from './emoji'
import { channelAfter, channelMove, newestEditable } from './shortcuts'
import { keepFocusOnRouteTo, releaseRouteFocus } from '../../app/routeFocusHold'
import { soundEngine } from '../sounds/SoundEngine'
import type { MessageView } from './matrix/timeline'

/**
 * Whether a channel is the organisation's proximity room (« Autour de moi »). Only a flag set by
 * the server may say so, never the channel's name: a channel its members called « urgence » is an
 * ordinary channel. Core flags no channel yet, so the product passes no set and none qualifies.
 */
/** Something other than a message that belongs in a channel's timeline at a point in time. */
export interface TimelineInsert {
  readonly key: string
  /** Milliseconds since the epoch, compared with each message's `origin_server_ts`. */
  readonly ts: number
  readonly node: ReactNode
}

/**
 * Places each insert before the first row that is later than it, so a poll created between two
 * messages is drawn between them; inserts later than every row follow the last one. A day
 * divider carries its first message's time, so an insert never lands after its own day's divider
 * for a later day. The « new messages » divider has no time and never moves an insert.
 */
export function mergeTimelineInserts<
  R extends { kind: string; key: string; ts?: number; message?: { ts: number } },
>(
  rows: readonly R[],
  inserts: readonly TimelineInsert[]
): readonly ({ kind: 'insert'; key: string; node: ReactNode } | R)[] {
  if (inserts.length === 0) return rows
  const pending = [...inserts].sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key))
  const merged: ({ kind: 'insert'; key: string; node: ReactNode } | R)[] = []
  for (const row of rows) {
    const ts = row.message?.ts ?? row.ts
    while (ts !== undefined && pending.length > 0 && pending[0]!.ts < ts) {
      const insert = pending.shift()!
      merged.push({ kind: 'insert', key: `insert:${insert.key}`, node: insert.node })
    }
    merged.push(row)
  }
  for (const insert of pending) {
    merged.push({ kind: 'insert', key: `insert:${insert.key}`, node: insert.node })
  }
  return merged
}

export function isEmergencyChannel(
  channel: WorkspaceChannel | null | undefined,
  flaggedChannelIds: ReadonlySet<string> | undefined
): boolean {
  if (channel === null || channel === undefined || flaggedChannelIds === undefined) return false
  return flaggedChannelIds.has(channel.id)
}

function AntennaIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
    >
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <path d="M5.2 5.2a4 4 0 0 0 0 5.6" />
      <path d="M10.8 5.2a4 4 0 0 1 0 5.6" />
      <path d="M3 3a7 7 0 0 0 0 10" />
      <path d="M13 3a7 7 0 0 1 0 10" />
    </svg>
  )
}

export interface EspaceStoreLike {
  readonly simulation?: boolean
  getInitialDocuments?: () => ChannelDocsWorkspace
  publishDocument?: (roomId: string, doc: ChannelDoc) => Promise<void>
  /** Optional call capability supplied by local preview adapters. */
  audioCall?: AudioCallLike
  /** Local demos can register a newly created channel without replacing conversation state. */
  addChannel?: (channel: WorkspaceChannel) => void
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => EspaceSnapshot
  getUserId: () => string
  getTimeline: (roomId: string) => readonly MessageView[]
  getThread: (roomId: string, rootEventId: string) => readonly MessageView[]
  send: (roomId: string, body: string, options?: SendOptions) => Promise<void>
  edit: (roomId: string, eventId: string, body: string) => Promise<void>
  remove: (roomId: string, eventId: string) => Promise<void>
  toggleReaction: (roomId: string, eventId: string, key: string) => Promise<void>
  resend?: (roomId: string, key: string) => Promise<void>
  inviteToRoom?(roomId: string, userId: string): Promise<void>
  markRead?: (roomId: string) => Promise<void>
  /** The event the member has read up to: the place « Nouveaux messages » is drawn after. */
  getReadMarker?: (roomId: string) => string | null
  /** The first message the log shows after an event: where the unread messages start. */
  firstShownAfter?: (roomId: string, eventId: string) => string | null
  /** How far back a room's timeline reaches; a store without it cannot page back. */
  getHistory?: (roomId: string) => History
  /** Adds the room's previous page of messages; `getHistory` says how it went. */
  loadOlder?: (roomId: string) => Promise<void>
  start?: () => Promise<void>
  stop?: (status?: 'signed-out' | 'stopped') => void
  /** The member's Matrix access token, which the room-access call carries (see `audio/`). */
  accessToken?: () => string
  /** The token to use once `stale` was refused, shared with the store's own refresh. */
  renewAccessToken?: (stale: string) => Promise<string>
  /** Finds these channels' rooms by alias; the snapshot's `channels` carries the answers. */
  resolveChannels?: (channelIds: readonly string[]) => Promise<void> | void
  /** The room's members but the signed-in one, whom the composer offers to mention. */
  getRoster?: (roomId: string) => readonly MemberView[]
  getMemberRole?: (roomId: string, userId: string) => 'admin' | 'member'
  getProfileRole?: (roomId: string, userId: string) => MemberProfileRole
  isOnline?: (userId: string) => boolean
  getMembers?: (roomId: string) => readonly MemberView[]
  /** Loads the room's whole member list, once. */
  loadMembers?: (roomId: string) => void
  /** The room's members typing now, but the signed-in one: the typing line under the log. */
  getTyping?: (roomId: string) => readonly MemberView[]
  /** Tells the room the member is typing, or no longer is. */
  setTyping?: (roomId: string, typing: boolean) => void
}

const NO_CANDIDATES: readonly MentionCandidate[] = []
const NO_TYPING: readonly MemberView[] = []

/**
 * Who is typing, in words (gap report G9): one or two by name, as their messages are signed, and
 * any more as « Plusieurs personnes ». Empty when no one is.
 */
function typingLine(members: readonly MemberView[], t: TFunction): string {
  const names = members.map(({ userId, name }) => name ?? displayNameOf(userId))
  const [first, second] = names
  if (first === undefined) return ''
  if (second === undefined) return t('console.workspace.channel.typing-one', { name: first })
  if (names.length === 2) return t('console.workspace.channel.typing-two', { first, second })
  return t('console.workspace.channel.typing-many')
}

/** The audio call, as the view reads and drives it (`audio/call.ts`). */
export interface AudioCallLike {
  /** Preview adapters must label their controls without implying real media capture. */
  readonly mode?: 'local-preview'
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => CallSnapshot
  join: (roomId: string) => Promise<void>
  leave: () => Promise<void>
  setMuted: (muted: boolean) => Promise<void>
  setDeafened: (deafened: boolean) => Promise<void>
  /** Lets the call's sound play when the browser held it back; from the member's click. */
  startAudio: () => Promise<void>
  /** The member's own microphone level, 0 to 1, read on every frame (`CallController.micLevel`). */
  micLevel?: () => number
  /** The microphone and output chosen, and choosing them (`CallController`); the panel needs all. */
  getDeviceChoice?: AudioSettingsCall['getDeviceChoice']
  chooseInput?: AudioSettingsCall['chooseInput']
  chooseOutput?: AudioSettingsCall['chooseOutput']
}

/** The call, when it can choose the member's devices: what « Réglages audio » drives. */
function deviceSettingsOf(call: AudioCallLike): AudioSettingsCall | null {
  const { getDeviceChoice, chooseInput, chooseOutput } = call
  if (getDeviceChoice === undefined || chooseInput === undefined || chooseOutput === undefined)
    return null
  return {
    getDeviceChoice,
    chooseInput: (input) => chooseInput.call(call, input),
    chooseOutput: (output) => chooseOutput.call(call, output),
  }
}

export interface EspaceLiveViewProps {
  /** Optional presentation metadata; never an access grant. */
  categoryDescriptions?: Readonly<Record<string, string>> | undefined
  org: string
  organisationName: string
  workspace: Workspace
  channelId: string | undefined
  session?: MatrixSession
  store?: EspaceStoreLike
  /** The audio call; by default one made from `session` and the store's token. */
  call?: AudioCallLike
  /**
   * Makes a channel the address. Given, the view shows the channel the address names, and only
   * that one: a click asks for the channel, and the router's commit shows it.
   */
  onNavigateChannel?: (channelId: string) => void | Promise<void>
  /** Whether the router is between two addresses: nothing is sent until it has settled. */
  navigationPending?: boolean
  onReconnect?: () => void
  readonly defaultMembersOpen?: boolean | undefined
  readonly focusedDocs?: boolean | undefined
  readonly activeCanvasMode?: 'chat' | 'docs' | undefined
  readonly onChangeCanvasMode?: ((mode: 'chat' | 'docs') => void) | undefined
  readonly documents?: readonly ChannelDoc[]
  readonly onOpenDocument?: ((doc: ChannelDoc) => void) | undefined
  readonly docsCanvasSlot?: ReactNode | undefined
  /** Channels the server flags as the proximity room; see `isEmergencyChannel`. */
  readonly emergencyChannelIds?: ReadonlySet<string> | undefined
  /** Draws the proximity panel above a flagged channel's timeline. */
  readonly renderEmergencyPanel?: ((channel: WorkspaceChannel) => ReactNode) | undefined
  readonly onCreateInCategory?: ((category: WorkspaceCategory) => void) | undefined
  /** Items drawn in the channel's timeline at their own time, between the messages (polls). */
  readonly timelineInserts?: readonly TimelineInsert[] | undefined
  readonly organisationActionSlot?: ReactNode | undefined
  readonly sidebarActionSlot?: ReactNode | undefined
  readonly sidebarFooterSlot?: ReactNode | undefined
  readonly onChannelContextMenu?:
    | ((info: {
        readonly channelId: string
        readonly label: string
        readonly kind: 'text' | 'audio'
        readonly clientX: number
        readonly clientY: number
      }) => void)
    | undefined
}

/** The audio room the dock names: the channel the member chose, as the sidebar labels it. */
interface CallChannel {
  channelId: string
  roomId: string
  roomName: string
  categoryName: string | undefined
}

const NO_CALL_SNAPSHOT: CallSnapshot = Object.freeze({
  status: 'idle',
  roomId: null,
  muted: false,
  deafened: false,
  listenOnly: false,
  speakers: [],
  participants: [],
  playbackBlocked: false,
})
const subscribeToNoCall = () => () => undefined
const noCallSnapshot = () => NO_CALL_SNAPSHOT

/**
 * The view's own store, for one session. A stopped store never syncs again, and in development
 * React mounts, unmounts and remounts the view's effects: the unmount stops the store, so the
 * remount asks for `live()` and gets a new one, which the view then reads. A store syncs only once
 * started, so one built and never started is inert.
 */
class OwnedStoreSlot {
  #store: EspaceStoreLike
  readonly #make: () => EspaceStoreLike
  readonly #listeners = new Set<() => void>()

  constructor(make: () => EspaceStoreLike) {
    this.#make = make
    this.#store = make()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): EspaceStoreLike => this.#store

  /** The store to start: the current one, or a new one in place of a stopped one. */
  live(): EspaceStoreLike {
    if (this.#store.getSnapshot().status === 'stopped') {
      this.#store = this.#make()
      for (const listener of this.#listeners) listener()
    }
    return this.#store
  }
}
const subscribeToNoSlot = () => () => undefined
const noSlotStore = () => null

/** A message the member acts on, in the room it was shown in: never another room's. */
interface ThreadOpener extends RoomTarget {
  store: EspaceStoreLike
  generation: number
  viewerId: string
  element: HTMLButtonElement
}

/**
 * What the member has started in one channel: the composer's text, the reply or the edit under
 * way, the open thread and its text. Kept per room and per member, on one store: nothing typed or
 * chosen for one room is shown, or sent, in another, even when a channel's room changes.
 */
const LIVE_CALL: ReadonlySet<CallStatus> = new Set(['connecting', 'connected', 'reconnecting'])

const CALL_PROBLEM: Record<CallProblem, MessageKey> = {
  forbidden: 'console.workspace.audio.problem-forbidden',
  unavailable: 'console.workspace.audio.problem-unavailable',
  malformed: 'console.workspace.audio.problem-unavailable',
  network: 'console.workspace.audio.problem-network',
  unauthenticated: 'console.workspace.audio.problem-unauthenticated',
  removed: 'console.workspace.audio.problem-removed',
  'room-closed': 'console.workspace.audio.problem-room-closed',
  elsewhere: 'console.workspace.audio.problem-elsewhere',
  'connection-lost': 'console.workspace.audio.problem-connection-lost',
  microphone: 'console.workspace.audio.problem-microphone',
  'microphone-denied': 'console.workspace.audio.problem-microphone-denied',
  'microphone-missing': 'console.workspace.audio.problem-microphone-missing',
  'microphone-in-use': 'console.workspace.audio.problem-microphone-in-use',
  'microphone-stuck': 'console.workspace.audio.problem-microphone-stuck',
}

/** A problem the member can act on by joining again. */
const RETRYABLE: ReadonlySet<CallProblem> = new Set([
  'unavailable',
  'malformed',
  'network',
  'connection-lost',
])

const NO_MESSAGES: readonly MessageView[] = []

/** The top of the message log: how far back it reaches, and the way to read further. */
function HistoryEdge({
  history,
  channel,
  onLoadOlder,
}: {
  history: History
  channel: string
  onLoadOlder: () => void
}) {
  const { t } = useTranslation()
  if (history === 'start') {
    return (
      <p className="py-2 text-center text-xs text-c-ink-3">
        {t('console.workspace.channel.label-history-start', { channel })}
      </p>
    )
  }
  if (history === 'loading') {
    return (
      <p className="py-2 text-center text-xs text-c-ink-3">
        {t('console.workspace.channel.status-loading-older')}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 py-2 text-xs text-c-ink-3">
      {history === 'failed' ? <span>{t('console.workspace.channel.error-load-older')}</span> : null}
      <Button variant="secondary" size="sm" onClick={onLoadOlder}>
        {history === 'failed'
          ? t('console.common.action-retry')
          : t('console.workspace.channel.action-load-older')}
      </Button>
    </div>
  )
}

/** The name drawn for a member the room holds no display name for: its id's localpart. */
function displayNameOf(userId: string): string {
  if (!userId.startsWith('@')) return userId
  const localpart = userId.slice(1).split(':')[0] ?? userId
  return localpart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** A message's author as drawn: the room's display name, else the id's localpart. */
function nameOf(message: MessageView): string {
  return message.senderName ?? displayNameOf(message.sender)
}

/**
 * A channel's room: the one whose id the room directory gave for the channel's alias (Core
 * contract 0.25.2), among the rooms the member has joined. Never by name, and never by a part
 * of an alias: a channel whose room is not resolved has none.
 */
function roomForChannel(
  channel: WorkspaceChannel,
  channels: ReadonlyMap<string, ChannelRoom>,
  rooms: readonly RoomSummary[]
): RoomSummary | undefined {
  const found = channels.get(channel.id)
  if (found?.state !== 'resolved') return undefined
  return rooms.find((room) => room.roomId === found.roomId)
}

/**
 * Mid-composition, a key is the input method's: `Escape` cancels its conversion, not an edit.
 * `keyCode` is deprecated, and read for Safari, whose composition keys carry 229 but no
 * `isComposing`.
 */
function composing(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

/** Whether a channel's room exists: Core says it is ready, and the directory found it. */
function roomResolved(channel: WorkspaceChannel, channels: ReadonlyMap<string, ChannelRoom>) {
  return channel.room_state === 'ready' && channels.get(channel.id)?.state === 'resolved'
}

/** The channels whose room Core says is ready: the ones worth asking the directory for. */
function readyChannelIds(workspace: Workspace): string[] {
  return [
    ...workspace.categories.flatMap((category) => category.channels),
    ...workspace.uncategorised_channels,
  ]
    .filter((channel) => channel.room_state === 'ready')
    .map((channel) => channel.id)
}

function occupantsForRoom(room: RoomSummary | undefined): RoomOccupant[] {
  if (room?.occupancy === null || room?.occupancy === undefined) return []
  const sharing = new Set(room.occupancy.screenShare)
  return room.occupancy.participants.map((userId) => ({
    id: userId,
    name: room.names?.[userId] ?? displayNameOf(userId),
    sharingScreen: sharing.has(userId),
  }))
}

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

interface LiveMessageRowProps {
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
  onRetry: (message: MessageView) => void
  onReaction: (eventId: string, reaction: string) => void
  onReply: (message: MessageView) => void
  onEdit: (message: MessageView) => void
  onRemove: (eventId: string) => void
  onOpenThread: (eventId: string, button: HTMLButtonElement) => void
}

/** One mounted message; only activation reports a timeline opener to the view. */
function LiveMessageRow({
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
}: LiveMessageRowProps) {
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
      <MessageText body={msg.body} />
    </TimelineMessage>
  )
}

const subscribeToNoDraft = () => () => undefined
const noDraftSnapshot = () => 0

/** A view-local external store: only committed lifecycle work publishes values. */
function createCommittedValue<T>(initial: T) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    commit(next: T) {
      if (Object.is(current, next)) return
      current = next
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue
        try {
          listener()
        } catch {
          /* A removed/throwing observer cannot skip another. */
        }
      }
    },
  }
}

interface CommittedView {
  session: MatrixSession | undefined
  store: EspaceStoreLike | undefined
  organisationId: string
  stamp: object | null
}

export function EspaceLiveView(props: EspaceLiveViewProps) {
  const memory = useEspaceDraftMemory()
  const { t } = useTranslation()
  useSyncExternalStore(
    memory?.subscribe ?? subscribeToNoDraft,
    memory?.getSnapshot ?? noDraftSnapshot
  )
  const stamp = memory === null ? null : getMatrixRegistrationStamp()
  const [registration, setRegistration] = useState({ stamp, generation: 0 })
  if (registration.stamp !== stamp)
    setRegistration({ stamp, generation: registration.generation + 1 })
  const [committedView] = useState(() => createCommittedValue<CommittedView | null>(null))
  const committed = useSyncExternalStore(committedView.subscribe, committedView.getSnapshot)
  const sameView =
    committed !== null &&
    committed.session === props.session &&
    committed.store === props.store &&
    committed.organisationId === props.workspace.organisation_id &&
    committed.stamp === stamp
  const allowed =
    memory === null ||
    (sameView && memory.canKeepView(props.session, props.workspace, props.store)) ||
    memory.canPresent(props.session, props.workspace, props.store)
  useLayoutEffect(() => {
    memory?.observeView(props.session, props.workspace, props.store)
    if (allowed && !sameView)
      committedView.commit({
        session: props.session,
        store: props.store,
        organisationId: props.workspace.organisation_id,
        stamp,
      })
  }, [memory, props.session, props.workspace, props.store, stamp, allowed, sameView, committedView])
  useLayoutEffect(() => () => committedView.commit(null), [committedView])
  if (!allowed)
    return <InlineAlert kind="error">{t('console.workspace.live.problem-unavailable')}</InlineAlert>
  return <MountedEspaceLiveView key={registration.generation} {...props} />
}

function MountedEspaceLiveView({
  categoryDescriptions,
  org,
  organisationName,
  workspace,
  channelId,
  session,
  store: injectedStore,
  call: injectedCall,
  onNavigateChannel,
  navigationPending = false,
  onReconnect,
  defaultMembersOpen = false,
  focusedDocs = false,
  activeCanvasMode = 'chat',
  onChangeCanvasMode,
  docsCanvasSlot,
  documents = [],
  onOpenDocument,
  emergencyChannelIds,
  renderEmergencyPanel,
  onCreateInCategory,
  timelineInserts,
  organisationActionSlot,
  sidebarActionSlot,
  sidebarFooterSlot,
  onChannelContextMenu,
}: EspaceLiveViewProps) {
  const memory = useEspaceDraftMemory()
  const { t, i18n } = useTranslation()
  const demoCopy = demoMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const simulation = injectedStore?.simulation === true
  const demoGuidanceId = useId()
  const composerInputId = useId()
  /** « Mentionner »: writes « @ » in the channel's composer and opens its member list. */
  const startMention = useRef<() => void>(null)
  const insertInComposer = useRef<(text: string) => void>(null)
  const composerBox = useRef<HTMLDivElement>(null)
  const threadInputId = useId()
  const sidebarHeadingId = useId()
  const narrow = useNarrowViewport()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [channelsOpen, setChannelsOpen] = useState(false)
  const channelChooserReturnFocus = useRef<HTMLElement | null>(null)
  function changeChannelChooser(open: boolean) {
    if (open) channelChooserReturnFocus.current = null
    setChannelsOpen(open)
  }
  function closeChannelChooser() {
    if (!narrow || !channelsOpen) return
    channelChooserReturnFocus.current = headingRef.current
    setChannelsOpen(false)
  }
  // The Console always mounts the view under its router; a view rendered on its own has no
  // navigation to guard. Outside one, the hook gives `null`, whatever its type says.
  const inRouter = Boolean(useRouter({ warn: false }) as AnyRouter | null)

  const ownedSlot = useMemo<OwnedStoreSlot | null>(() => {
    if (injectedStore !== undefined) return null
    if (session === undefined) return null
    return new OwnedStoreSlot(() =>
      createEspaceStore({
        baseUrl: session.baseUrl,
        userId: session.userId,
        deviceId: session.deviceId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        refresh: session.refresh,
      })
    )
  }, [injectedStore, session])
  const ownedStore = useSyncExternalStore(
    ownedSlot?.subscribe ?? subscribeToNoSlot,
    ownedSlot?.getSnapshot ?? noSlotStore
  )

  useEffect(() => {
    if (ownedSlot === null) return
    const store = ownedSlot.live()
    void store.start?.()?.catch(() => undefined)
    return () => {
      store.stop?.()
    }
  }, [ownedSlot])

  const resolvedStore = injectedStore ?? ownedStore
  if (resolvedStore === null) {
    throw new Error('EspaceLiveView requires either a store or a MatrixSession')
  }
  const activeStore: EspaceStoreLike = resolvedStore
  const settingsEpoch = useMemo(() => {
    void activeStore
    return getWorkspaceSettingsEpoch()
  }, [activeStore])

  const snapshot = useSyncExternalStore(activeStore.subscribe, activeStore.getSnapshot)
  useTabTitle(snapshot.rooms)

  // The store asks the directory; the view only says which channels it shows.
  const readyChannels = readyChannelIds(workspace).join(' ')
  useEffect(() => {
    void activeStore.resolveChannels?.(readyChannels === '' ? [] : readyChannels.split(' '))
  }, [activeStore, readyChannels])

  // One call per view, on the homeserver the session names, with the store's own token.
  const ownedCall = useMemo<AudioCallLike | null>(() => {
    if (injectedCall !== undefined || activeStore.audioCall !== undefined || session === undefined)
      return null
    const { accessToken, renewAccessToken } = activeStore
    if (accessToken === undefined || renewAccessToken === undefined) return null
    return createCallController({
      homeserver: session.baseUrl,
      // Signed in as `@{sub}:{server name}` (`src/auth/matrix.ts`); an ID without one fails closed.
      serverName: serverNameOf(session.userId) ?? '',
      tokens: { current: accessToken, renew: renewAccessToken },
    })
  }, [injectedCall, session, activeStore])

  useEffect(() => {
    if (ownedCall === null) return
    // Leaving, not disposing: React mounts, unmounts and remounts an effect in development.
    return () => {
      void ownedCall.leave()
    }
  }, [ownedCall])

  const activeCall = injectedCall ?? activeStore.audioCall ?? ownedCall
  useEffect(() => {
    if (!activeStore.audioCall) return
    const call = activeStore.audioCall
    return () => {
      void call.leave()
    }
  }, [activeStore])
  const callSnapshot = useSyncExternalStore(
    activeCall?.subscribe ?? subscribeToNoCall,
    activeCall?.getSnapshot ?? noCallSnapshot
  )
  // The member's own microphone, read only while it is on in a call that is through.
  const micActivity = useMicActivity(
    activeCall?.micLevel,
    callSnapshot.status === 'connected' &&
      !callSnapshot.muted &&
      callSnapshot.muting !== true &&
      !callSnapshot.listenOnly
  )
  const deviceSettings = useMemo(
    () => (activeCall === null ? null : deviceSettingsOf(activeCall)),
    [activeCall]
  )

  // A member signed out of the workspace's homeserver is no longer in its calls either.
  const signedOut = snapshot.status === 'signed-out'
  useEffect(() => {
    if (signedOut && activeCall !== null) void activeCall.leave()
  }, [signedOut, activeCall])

  const initialChannel = currentChannel(workspace, channelId)
  const addressedChannel = channelId ?? initialChannel?.id
  // With a router, the channel shown is the one the committed address names, never the one a
  // click asked for: a navigation given up on the way (Back before it commits) shows nothing else.
  // Without one, a click chooses in place, until the address changes.
  const [clickedChannelId, setClickedChannelId] = useState<string | null>(null)
  // The channel a click asked the router for, until its navigation settles.
  const [requestedChannelId, setRequestedChannelId] = useState<string | null>(null)
  const [addressedChannelId, setAddressedChannelId] = useState(channelId)
  if (addressedChannelId !== channelId) {
    setAddressedChannelId(channelId)
    setClickedChannelId(null)
    setRequestedChannelId(null)
  }
  const [wasPending, setWasPending] = useState(navigationPending)
  if (wasPending !== navigationPending) {
    setWasPending(navigationPending)
    if (!navigationPending) setRequestedChannelId(null)
  }
  const selectedChannelId =
    (onNavigateChannel === undefined ? clickedChannelId : null) ?? addressedChannel
  // Between two addresses, the channel the member means is not known: nothing is sent.
  const navigationUnsettled =
    navigationPending || (requestedChannelId !== null && requestedChannelId !== addressedChannel)

  const activeChannel = useMemo(
    () => currentChannel(workspace, selectedChannelId),
    [workspace, selectedChannelId]
  )
  const activeRoom = useMemo(
    () =>
      activeChannel !== null && activeChannel !== undefined
        ? roomForChannel(activeChannel, snapshot.channels, snapshot.rooms)
        : undefined,
    [activeChannel, snapshot.channels, snapshot.rooms]
  )
  // No room, no messages and nowhere to send them: never a channel id taken for a room id.
  const activeRoomId = activeRoom?.roomId ?? null
  /** « 18 membres »: a text channel's people (`RoomSummary.joined`). */
  const memberCount =
    activeRoom?.joined === undefined
      ? null
      : t('console.workspace.channel.members-count', { count: activeRoom.joined })
  /** Under the channel's name: its topic, then its member count (p02 « topic · 18 membres »). */
  const headerLine = [
    ...(activeChannel !== null && activeChannel !== undefined && activeChannel.topic !== ''
      ? [{ key: 'topic', text: activeChannel.topic }]
      : []),
    ...(memberCount === null ? [] : [{ key: 'members', text: memberCount }]),
  ]
  /** Beside it, a few of those members' faces, drawn only with the count they illustrate. */
  const faces = activeRoom?.faces ?? []
  // The first sync lazy-loads only the people who wrote lately: when the header shows fewer faces
  // than the people it counts, the room's member list is asked for, once, to fill them in.
  const facesMissing =
    activeRoom?.joined !== undefined && faces.length < Math.min(HEADER_FACES, activeRoom.joined - 1)
  useEffect(() => {
    if (activeRoomId !== null && facesMissing) activeStore.loadMembers?.(activeRoomId)
  }, [activeStore, activeRoomId, facesMissing])
  const [membersOpen, setMembersOpen] = useState<boolean>(defaultMembersOpen)
  const [leftSidebarWidth, setLeftSidebarWidth] = useState<number>(256)
  const [rightSidebarWidth, setRightSidebarWidth] = useState<number>(280)
  const membersPanelId = useId()
  const membersTrigger = useRef<HTMLButtonElement>(null)
  function closeMembers() {
    setMembersOpen(false)
    membersTrigger.current?.focus()
  }
  function startLeftSidebarResize(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = leftSidebarWidth
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const delta = moveEvent.clientX - startX
      setLeftSidebarWidth(Math.max(180, Math.min(420, startWidth + delta)))
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }
  function startRightSidebarResize(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = rightSidebarWidth
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const delta = startX - moveEvent.clientX
      setRightSidebarWidth(Math.max(220, Math.min(560, startWidth + delta)))
    }
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }
  const viewerId = activeStore.getUserId()
  const { profile: localProfile, hasProfile } = useLocalProfile(viewerId)
  const profileCopy = profileMessages(i18n.resolvedLanguage)
  const roomMembers = useMemo(() => {
    void snapshot
    return activeRoomId === null ? undefined : activeStore.getMembers?.(activeRoomId)
  }, [activeRoomId, activeStore, snapshot])
  const rawRoster = useMemo(() => {
    void snapshot
    return activeRoomId === null ? [] : (activeStore.getRoster?.(activeRoomId) ?? roomMembers ?? [])
  }, [activeRoomId, activeStore, roomMembers, snapshot])
  const roster =
    rawRoster.some((member) => member.userId === viewerId) || !hasProfile
      ? rawRoster
      : [
          ...rawRoster,
          { userId: viewerId, name: localProfile.displayName || displayNameOf(viewerId) },
        ]
  function memberProfile(member: MemberView): MemberProfile {
    return {
      userId: member.userId,
      name:
        member.userId === viewerId && localProfile.displayName
          ? localProfile.displayName
          : (member.name ?? displayNameOf(member.userId)),
      presence:
        member.userId === viewerId && hasProfile
          ? localProfile.presence
          : activeStore.isOnline?.(member.userId)
            ? 'online'
            : 'offline',
      role:
        activeRoomId === null
          ? 'member'
          : (activeStore.getProfileRole?.(activeRoomId, member.userId) ??
            activeStore.getMemberRole?.(activeRoomId, member.userId) ??
            'member'),
      ...(member.userId === viewerId ? { status: localProfile.status } : {}),
    }
  }
  useEffect(
    () =>
      registerWorkspaceSettingsRuntime(
        {
          org,
          userId: viewerId,
          displayName:
            localProfile.displayName ||
            roomMembers?.find((member) => member.userId === viewerId)?.name ||
            displayNameOf(viewerId),
          members: [
            ...rawRoster.filter((member) => member.userId !== viewerId),
            {
              userId: viewerId,
              name:
                localProfile.displayName ||
                rawRoster.find((member) => member.userId === viewerId)?.name ||
                displayNameOf(viewerId),
            },
          ],
          call: deviceSettings,
          invite:
            activeRoomId !== null && activeStore.inviteToRoom
              ? (userId) => activeStore.inviteToRoom!(activeRoomId, userId)
              : undefined,
          memberRole: (userId) =>
            activeRoomId === null
              ? 'member'
              : (activeStore.getMemberRole?.(activeRoomId, userId) ?? 'member'),
        },
        settingsEpoch
      ),
    [
      org,
      viewerId,
      localProfile.displayName,
      roomMembers,
      rawRoster,
      settingsEpoch,
      deviceSettings,
      activeRoomId,
      activeStore,
    ]
  )
  useEffect(() => {
    if (membersOpen && activeRoomId !== null) activeStore.loadMembers?.(activeRoomId)
  }, [membersOpen, activeRoomId, activeStore])
  const typing =
    activeRoomId === null ? NO_TYPING : (activeStore.getTyping?.(activeRoomId) ?? NO_TYPING)
  // Leaving the room, or the view, says the member no longer types there.
  useEffect(() => {
    if (activeRoomId === null) return
    return () => activeStore.setTyping?.(activeRoomId, false)
  }, [activeStore, activeRoomId])
  const mentionCandidates = useMemo(
    () =>
      roomMembers?.map(({ userId, name }) => ({ userId, label: name ?? displayNameOf(userId) })) ??
      NO_CANDIDATES,
    [roomMembers]
  )

  const viewEpoch = memory?.getViewEpoch()
  const draftOrganisationId = workspace.organisation_id
  const [committedLease] = useState(() => createCommittedValue<DraftLease | null>(null))
  const lease = useSyncExternalStore(committedLease.subscribe, committedLease.getSnapshot)
  useLayoutEffect(() => {
    if (memory === null || activeRoomId === null) {
      committedLease.commit(null)
      return
    }
    const next = memory.attachView(
      activeStore,
      { organisation_id: draftOrganisationId },
      activeRoomId
    )
    committedLease.commit(next)
    return () => {
      next.release()
      if (committedLease.getSnapshot() === next) committedLease.commit(null)
    }
  }, [memory, activeStore, draftOrganisationId, activeRoomId, viewEpoch, committedLease])
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ChannelDraft>>(() => new Map())
  // Another store is another session, perhaps another member's: it starts with no draft.
  const [draftContext, setDraftContext] = useState({ store: activeStore, generation: 0 })
  if (draftContext.store !== activeStore) {
    setDraftContext({ store: activeStore, generation: draftContext.generation + 1 })
    setDrafts(new Map())
  }
  // A draft belongs to the room it was typed for and to the member who typed it.
  const draftKey = activeRoomId === null ? null : `${viewerId}\n${activeRoomId}`
  const draft =
    memory === null
      ? ((draftKey === null ? undefined : drafts.get(draftKey)) ?? EMPTY_DRAFT)
      : (lease?.read() ?? EMPTY_DRAFT)
  function updateDraft(
    patch: Partial<ChannelDraft> | ((previous: ChannelDraft) => Partial<ChannelDraft>)
  ) {
    if (memory !== null) {
      lease?.update(patch)
      return
    }
    if (draftKey === null) return
    const key = draftKey
    setDrafts((previous) =>
      new Map(previous).set(key, {
        ...(previous.get(key) ?? EMPTY_DRAFT),
        ...(typeof patch === 'function' ? patch(previous.get(key) ?? EMPTY_DRAFT) : patch),
      })
    )
  }
  function mentionMember(member: MemberProfile) {
    activeStore.loadMembers?.(activeRoomId!)
    const input = document.getElementById(composerInputId) as HTMLInputElement | null
    const needsSpace =
      input !== null &&
      (input.selectionStart ?? 0) > 0 &&
      !/\s$/.test(input.value.slice(0, input.selectionStart ?? 0))
    insertInComposer.current?.(`${needsSpace ? ' ' : ''}@${member.name} `)
  }
  function command(effect: () => unknown, patch?: Partial<ChannelDraft>) {
    if (memory !== null) return lease?.command(effect, patch) ?? false
    if (patch !== undefined) updateDraft(patch)
    effect()
    return true
  }
  /** The target's message, while its room is the one shown; nothing for another room's. */
  function inShownRoom(target: RoomTarget | null): string | null {
    return target !== null && target.roomId === activeRoomId ? target.eventId : null
  }
  function targetInShownRoom(eventId: string): RoomTarget | null {
    return activeRoomId === null ? null : { roomId: activeRoomId, eventId }
  }
  const replyToEventId = inShownRoom(draft.replyTo)
  const editingEventId = inShownRoom(draft.editing)
  const openThreadRootId = inShownRoom(draft.threadRoot)
  // The text of an edit whose room is no longer the channel's is not shown, so never sent.
  const staleEdit = draft.editing !== null && editingEventId === null
  const composerText = staleEdit ? '' : draft.text
  const threadText = draft.threadText
  const [callChannel, setCallChannel] = useState<CallChannel | null>(null)
  const threadOpener = useRef<ThreadOpener | null>(null)

  function ownsThreadOpener(opener: ThreadOpener) {
    return (
      opener.store === activeStore &&
      opener.generation === draftContext.generation &&
      opener.viewerId === viewerId &&
      opener.roomId === activeRoomId &&
      opener.eventId === openThreadRootId &&
      opener.element.isConnected
    )
  }

  // Read only at explicit close. ThreadPanel calls onClose before reading this
  // target; the following commit retires the record after that focus handoff.
  const threadFocusTarget = {
    get current() {
      const opener = threadOpener.current
      return opener !== null && ownsThreadOpener(opener) ? opener.element : null
    },
  }

  useEffect(() => {
    const opener = threadOpener.current
    if (
      opener !== null &&
      (!ownsThreadOpener(opener) ||
        !activeStore
          .getTimeline(opener.roomId)
          .some((message) => message.eventId === opener.eventId))
    ) {
      threadOpener.current = null
    }
  })
  useEffect(
    () => () => {
      threadOpener.current = null
    },
    []
  )

  /** Opens a message's thread; a reply typed under another thread is not carried to it. */
  function openThread(eventId: string, element: HTMLButtonElement) {
    if (activeRoomId === null || draftKey === null) return
    setMembersOpen(false)
    command(() => {
      threadOpener.current = {
        store: activeStore,
        generation: draftContext.generation,
        viewerId,
        roomId: activeRoomId,
        eventId,
        element,
      }
      updateDraft((previous) => ({
        threadRoot: { roomId: activeRoomId, eventId },
        ...(previous.threadRoot?.roomId === activeRoomId && previous.threadRoot.eventId === eventId
          ? {}
          : { threadText: '' }),
      }))
    })
  }

  const timeline = activeRoomId !== null ? activeStore.getTimeline(activeRoomId) : NO_MESSAGES
  const history = activeRoomId !== null ? activeStore.getHistory?.(activeRoomId) : undefined
  const {
    ref: logRef,
    onScroll: onLogScroll,
    older: showOlder,
  } = useTimelineScroll({
    roomId: activeRoomId,
    timeline,
    history,
    loadOlder: activeStore.loadOlder,
  })
  // Where the member had read up to when this room opened. Noted before `useMarkRead` moves the
  // marker (it runs after this draw), and kept for the visit: « Nouveaux messages » stays where it
  // was while the member reads, instead of vanishing as soon as the room is marked read. Noted
  // only for a room that counted something unread: in a room already read, a message that
  // arrives while the member is on it is not one they missed.
  const readMarkerOf = (room: RoomSummary | undefined) =>
    room === undefined || (room.unread === 0 && room.mentions === 0)
      ? null
      : (activeStore.getReadMarker?.(room.roomId) ?? null)
  const [readAtOpen, setReadAtOpen] = useState(() => ({
    store: activeStore,
    roomId: activeRoomId,
    eventId: readMarkerOf(activeRoom),
  }))
  if (readAtOpen.store !== activeStore || readAtOpen.roomId !== activeRoomId) {
    setReadAtOpen({ store: activeStore, roomId: activeRoomId, eventId: readMarkerOf(activeRoom) })
  }
  /** A day divider's label: « Aujourd’hui », « Hier », or the date, with its year if not this one. */
  const today = useCalendarToday()
  function dayLabel(day: string, ts: number): string {
    if (day === today) return t('console.workspace.channel.label-day-today')
    if (day === previousCalendarDay(today))
      return t('console.workspace.channel.label-day-yesterday')
    const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
    return formatDayDivider(ts, locale, day.slice(0, 4) !== today.slice(0, 4))
  }
  // Resolved on every draw, so a marker older than the loaded messages is found once older
  // messages bring it in. A walk over the loaded events: about a millisecond for 500 messages.
  const unreadFrom =
    activeRoomId === null || readAtOpen.eventId === null
      ? null
      : (activeStore.firstShownAfter?.(activeRoomId, readAtOpen.eventId) ?? null)
  const rows = timelineRows(timeline, { dayOf: calendarDay, unreadFrom, me: viewerId })
  useMarkRead({ room: activeRoom, newestKey: timeline.at(-1)?.key, store: activeStore })

  const liveMentionTracker = useRef<{
    store: EspaceStoreLike
    roomId: string | null
    primed: boolean
    seenKeys: Set<string>
    lastTailKey: string | null
  } | null>(null)
  const activeChannelId = activeChannel?.id
  useEffect(() => {
    if (activeRoomId === null || activeChannelId === undefined) {
      liveMentionTracker.current = {
        store: activeStore,
        roomId: null,
        primed: false,
        seenKeys: new Set(),
        lastTailKey: null,
      }
      return
    }
    const current = liveMentionTracker.current
    if (current === null || current.store !== activeStore || current.roomId !== activeRoomId) {
      liveMentionTracker.current = {
        store: activeStore,
        roomId: activeRoomId,
        primed: snapshot.status === 'live',
        seenKeys: new Set(timeline.map((msg) => msg.key)),
        lastTailKey: timeline.at(-1)?.key ?? null,
      }
      return
    }
    if (!current.primed) {
      for (const msg of timeline) current.seenKeys.add(msg.key)
      current.lastTailKey = timeline.at(-1)?.key ?? null
      if (snapshot.status === 'live') current.primed = true
      return
    }
    if (snapshot.status !== 'live') return

    const prevTailIndex =
      current.lastTailKey === null
        ? -1
        : timeline.findIndex((msg) => msg.key === current.lastTailKey)
    const candidates =
      prevTailIndex >= 0
        ? timeline.slice(prevTailIndex + 1)
        : history === 'loading'
          ? NO_MESSAGES
          : timeline

    for (const msg of candidates) {
      if (current.seenKeys.has(msg.key)) continue
      if (!msg.redacted && msg.mentionsMe === true && msg.sender !== viewerId) {
        void soundEngine.play('msg_mention', {
          channelId: activeChannelId,
          senderId: msg.sender,
          currentUserId: viewerId,
        })
      }
    }
    for (const msg of timeline) current.seenKeys.add(msg.key)
    current.lastTailKey = timeline.at(-1)?.key ?? null
  }, [activeStore, activeRoomId, activeChannelId, snapshot.status, timeline, history, viewerId])

  /** `keepFocus`: the new address leaves the focus where it is (`RouteFocus`), as a click does not. */
  function selectTextChannel(nextChannelId: string, keepFocus = false) {
    closeChannelChooser()
    if (onNavigateChannel === undefined) {
      setClickedChannelId(nextChannelId)
      return
    }
    setRequestedChannelId(nextChannelId)
    const path = `/${encodeURIComponent(org)}/workspace/${encodeURIComponent(nextChannelId)}`
    if (keepFocus) keepFocusOnRouteTo(path)
    const settled = () => {
      setRequestedChannelId((current) => (current === nextChannelId ? null : current))
      // Once the navigation is over, the address it reached has been drawn, and one it never
      // reached (superseded, refused) holds nothing. A task later, after that draw.
      if (keepFocus) setTimeout(() => releaseRouteFocus(path), 0)
    }
    void Promise.resolve(onNavigateChannel(nextChannelId)).then(settled, settled)
  }

  function joinAudioRoom(
    channel: WorkspaceChannel,
    room: RoomSummary | undefined,
    categoryName: string | undefined
  ) {
    if (activeCall === null || room === undefined) return
    closeChannelChooser()
    setCallChannel({
      channelId: channel.id,
      roomId: room.roomId,
      roomName: channelLabel(channel, t),
      categoryName,
    })
    // Called from the click: the call unlocks audio playback while the gesture still counts.
    void activeCall.join(room.roomId)
  }

  /** The members the text names, as `m.mentions` carries them; nothing when it names none. */
  function mentioning(text: string): SendOptions {
    const userIds = mentionedIn(text, mentionCandidates)
    return userIds.length === 0 ? {} : { mentions: userIds }
  }
  function loadMembers() {
    if (activeRoomId !== null) activeStore.loadMembers?.(activeRoomId)
  }

  const [attachmentRoom, setAttachmentRoom] = useState<string | null>(null)
  const [composerRoom, setComposerRoom] = useState(activeRoomId)
  if (composerRoom !== activeRoomId) {
    setComposerRoom(activeRoomId)
    setAttachmentRoom(null)
  }
  const attachmentStaged = activeRoomId !== null && attachmentRoom === activeRoomId
  const inviteTrigger = useRef<HTMLButtonElement>(null)
  const canInvite =
    activeRoom !== undefined && activeChannel != null && !focusedDocs && !navigationUnsettled
  const openInvitation = () => inviteTrigger.current?.click()

  function submitChannelComposer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // A « :nom: » still in the text, pasted for instance, goes as its emoji. The mentions are read
    // from the text as typed, so a member whose name holds a code is still named.
    const typed = composerText.trim()
    const trimmed = transformOutsideCode(typed, replaceShortcodes)
    if (trimmed === '' || activeRoomId === null || navigationUnsettled || attachmentStaged) return
    activeStore.setTyping?.(activeRoomId, false)
    if (draft.editing !== null) {
      // An edit started in another room is dropped, never sent here, as an edit or as a message.
      command(
        () => {
          if (editingEventId !== null) void activeStore.edit(activeRoomId, editingEventId, trimmed)
        },
        { editing: null, text: '' }
      )
      return
    }
    const options: SendOptions = mentioning(typed)
    // A reply goes as one only while its banner shows: to a message of this room, still in the
    // loaded timeline. Otherwise the text goes to this room on its own.
    if (replyBannerTarget !== undefined) {
      options.replyTo = replyBannerTarget.eventId
    }
    command(
      () => {
        void activeStore.send(activeRoomId, trimmed, options)
      },
      { replyTo: null, text: '' }
    )
  }

  function submitThreadComposer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const typed = threadText.trim()
    const trimmed = transformOutsideCode(typed, replaceShortcodes)
    if (trimmed === '' || activeRoomId === null || openThreadRootId === null) return
    if (navigationUnsettled) return
    const rootId = openThreadRootId
    command(
      () => {
        void activeStore.send(activeRoomId, trimmed, {
          ...mentioning(typed),
          threadRootId: rootId,
        })
      },
      { threadText: '' }
    )
  }

  function renderChannelOrRoomRow(channel: WorkspaceChannel, categoryName: string | undefined) {
    const label = channelLabel(channel, t)
    const room = roomForChannel(channel, snapshot.channels, snapshot.rooms)
    const resolved = roomResolved(channel, snapshot.channels)
    if (channel.kind === 'audio') {
      const inCall =
        room !== undefined &&
        callSnapshot.roomId === room.roomId &&
        (callSnapshot.status === 'connected' || callSnapshot.status === 'reconnecting')
      // Rings only in the room the member is in: who speaks reaches only the people in the call.
      // The member's own face follows their microphone, frame by frame, so it rings alone too;
      // the others' follow the call's speakers, which go stale while it reconnects.
      const occupants = occupantsForRoom(room).map((occupant) =>
        !inCall
          ? occupant
          : occupant.id === callSnapshot.self
            ? { ...occupant, speakingRef: micActivity.speakingRef }
            : callSnapshot.status === 'connected' && callSnapshot.speakers.includes(occupant.id)
              ? { ...occupant, speaking: true }
              : occupant
      )
      const unavailable = !resolved
        ? t('console.workspace.channel.label-preparing')
        : channel.lifecycle === 'archived'
          ? t('console.workspace.channel.label-archived')
          : room === undefined && snapshot.status === 'live'
            ? t('console.workspace.audio.label-arriving')
            : undefined
      return (
        <RoomRow
          key={channel.id}
          id={roomRowId(channel.id)}
          name={label}
          joinLabel={t('console.workspace.audio.action-join-room', { room: label })}
          occupancyLabel={(count) =>
            count === 0
              ? t('console.workspace.audio.label-empty')
              : t('console.workspace.audio.count-people', { count })
          }
          occupants={occupants.map((occupant) => ({
            ...occupant,
            onlineLabel: activeStore.isOnline?.(occupant.id)
              ? simulation
                ? demoCopy.presence
                : t('console.workspace.presence.online')
              : undefined,
          }))}
          occupantsLabel={t('console.workspace.audio.label-occupants', { room: label })}
          sharingLabel={t('console.workspace.audio.label-sharing-screen')}
          overflowLabel={(hidden) =>
            t('console.workspace.audio.action-show-others', { count: hidden })
          }
          {...(inCall ? { connected: t('console.workspace.audio.status-connected') } : {})}
          {...(inCall && callSnapshot.listenOnly
            ? { listenOnly: t('console.workspace.audio.label-listen-only') }
            : {})}
          {...(unavailable === undefined ? {} : { unavailable })}
          onClick={() => joinAudioRoom(channel, room, categoryName)}
          onContextMenu={
            onChannelContextMenu === undefined
              ? undefined
              : (e) => {
                  e.preventDefault()
                  onChannelContextMenu({
                    channelId: channel.id,
                    label,
                    kind: 'audio',
                    clientX: e.clientX,
                    clientY: e.clientY,
                  })
                }
          }
        />
      )
    }

    const unreadCount = room?.unread ?? 0
    const mentionCount = room?.mentions ?? 0
    const isSelected = channel.id === activeChannel?.id
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
        leading={isEmergencyChannel(channel, emergencyChannelIds) ? <AntennaIcon /> : undefined}
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
          selectTextChannel(channel.id)
        }}
        onContextMenu={
          onChannelContextMenu === undefined
            ? undefined
            : (e) => {
                e.preventDefault()
                onChannelContextMenu({
                  channelId: channel.id,
                  label,
                  kind: 'text',
                  clientX: e.clientX,
                  clientY: e.clientY,
                })
              }
        }
      />
    )
  }

  /** The DOM id of an audio room's row, where the search sends focus. */
  function roomRowId(channelId: string): string {
    return `${sidebarHeadingId}-room-${channelId}`
  }

  const searchEntries: ChannelSearchEntry[] = [
    ...workspace.categories.flatMap((category) =>
      category.channels.map((channel) => ({
        id: channel.id,
        label: channelLabel(channel, t),
        kind: channel.kind,
        category: categoryLabel(category, t),
      }))
    ),
    ...workspace.uncategorised_channels.map((channel) => ({
      id: channel.id,
      label: channelLabel(channel, t),
      kind: channel.kind,
    })),
  ]

  const activity = searchEntries
    .flatMap((channel) => {
      const resolved = snapshot.channels.get(channel.id)
      if (resolved?.state !== 'resolved') return []
      const room = snapshot.rooms.find((entry) => entry.roomId === resolved.roomId)
      if (!room) return []
      const messages = activeStore.getTimeline(room.roomId).filter((message) => !message.redacted)
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
  const files = searchEntries.flatMap((channel) => {
    const resolved = snapshot.channels.get(channel.id)
    const attachments =
      resolved?.state === 'resolved'
        ? activeStore
            .getTimeline(resolved.roomId)
            .filter((message) => !message.redacted && message.attachment)
            .map((message) => ({
              id: `${channel.id}:${message.eventId}`,
              title: message.attachment!.name,
              channel,
            }))
        : []
    return [
      ...documents
        .filter((doc) => doc.channelId === channel.id)
        .map((doc) => ({ id: doc.id, title: doc.title, channel, document: doc })),
      ...attachments,
    ]
  })
  const openStudioDocument = onOpenDocument
    ? (doc: ChannelDoc) => {
        onOpenDocument(doc)
        requestAnimationFrame(() => headingRef.current?.focus())
        if (narrow) {
          channelChooserReturnFocus.current = headingRef.current
          setChannelsOpen(false)
        }
        return headingRef.current
      }
    : undefined
  const openStudioChannel = (entry: ChannelSearchEntry) => {
    if (entry.kind === 'text') onChangeCanvasMode?.('chat')
    return openFromSearch(entry)
  }

  // A text channel opens, and focus goes to its heading. An audio room is not joined: focus goes
  // to its row, whose own action joins it — unless its category is folded away or the room cannot
  // be joined yet, when the search keeps focus.
  function openFromSearch(entry: ChannelSearchEntry): HTMLElement | null {
    if (entry.kind === 'text') {
      selectTextChannel(entry.id)
      return headingRef.current
    }
    // A room that cannot be joined yet draws a disabled row, which cannot take focus either.
    const row = document.getElementById(roomRowId(entry.id))
    return row instanceof HTMLButtonElement && !row.disabled && row.closest('[hidden]') === null
      ? row
      : null
  }

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
              onClick={() => {
                closeChannelChooser()
                onCreateInCategory(category)
              }}
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

  function retryMessage(msg: MessageView) {
    if (activeRoomId === null) return
    command(() => {
      if (activeStore.resend !== undefined) void activeStore.resend(activeRoomId, msg.key)
      else void activeStore.send(activeRoomId, msg.body)
    })
  }

  function reactToMessage(eventId: string, reaction: string) {
    if (activeRoomId !== null)
      command(() => {
        void activeStore.toggleReaction(activeRoomId, eventId, reaction)
      })
  }

  function replyToMessage(msg: MessageView) {
    updateDraft({
      editing: null,
      replyTo: targetInShownRoom(msg.eventId),
      ...(draft.editing === null ? {} : { text: '' }),
    })
  }

  function editMessage(msg: MessageView) {
    // The new message being written gives way to the edit, which the room is not told about.
    if (activeRoomId !== null) activeStore.setTyping?.(activeRoomId, false)
    updateDraft({ replyTo: null, editing: targetInShownRoom(msg.eventId), text: msg.body })
  }

  function removeMessage(eventId: string) {
    if (activeRoomId !== null)
      command(() => {
        void activeStore.remove(activeRoomId, eventId)
      })
  }

  const threadRootMessage =
    openThreadRootId !== null
      ? timeline.find((candidate) => candidate.eventId === openThreadRootId)
      : undefined
  const activeThreadReplies =
    openThreadRootId !== null && activeRoomId !== null
      ? activeStore.getThread(activeRoomId, openThreadRootId)
      : []
  const replyBannerTarget =
    replyToEventId !== null
      ? timeline.find((candidate) => candidate.eventId === replyToEventId)
      : undefined

  const activeChannelName =
    activeChannel !== null && activeChannel !== undefined ? channelLabel(activeChannel, t) : ''
  const isArchivedChannel = activeChannel?.lifecycle === 'archived'
  const canWrite = !isArchivedChannel && activeRoomId !== null
  // In place of the composer, why the member cannot write here; nothing while the sync starts.
  const paneNotice = isArchivedChannel
    ? t('console.workspace.channel.label-archived')
    : canWrite || activeChannel === null || activeChannel === undefined
      ? undefined
      : !roomResolved(activeChannel, snapshot.channels)
        ? t('console.workspace.channel.label-preparing')
        : snapshot.status === 'live'
          ? t('console.workspace.channel.label-arriving')
          : undefined
  // Keyboard shortcuts (spec « Keyboard shortcuts »). What a shortcut did is said here, politely:
  // the focus stays where the member had it. Counted, so the same words twice are said twice.
  const [announcement, setAnnouncementState] = useState({ count: 0, text: '' })
  const setAnnouncement = (text: string) =>
    setAnnouncementState((current) => ({ count: current.count + 1, text }))
  const channelColumn = useRef<HTMLElement>(null)
  // A key moved the channel. The focus stays where it was, but a channel with no composer (archived,
  // still being prepared) takes the composer away: the focus would fall to the page, with
  // `RouteFocus` held from rescuing it, so the channel's heading takes it instead.
  const movedByKey = useRef(false)
  const shownChannelId = activeChannel?.id
  useEffect(() => {
    if (!movedByKey.current) return
    movedByKey.current = false
    const focused = document.activeElement
    if (focused === null || focused === document.body) headingRef.current?.focus()
  }, [shownChannelId])
  const textChannelIds = useMemo(
    () =>
      [
        ...workspace.categories.flatMap((category) => category.channels),
        ...workspace.uncategorised_channels,
      ]
        .filter((channel) => channel.kind === 'text')
        .map((channel) => channel.id),
    [workspace]
  )
  // Read at the key press, so the listener is not added again on every render.
  const onChannelKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const move = channelMove(event)
    if (move === null || event.defaultPrevented || withdrawn(channelColumn.current)) return
    // From the thread panel or a popover (the reaction or emoji palette), the channel's change
    // would take away the very thing the focus is in: the key is theirs.
    const from = event.target instanceof Element ? event.target : null
    if (from?.closest('aside, [data-popover]')) return
    event.preventDefault()
    const unread = (id: string) => {
      const channel = currentChannel(workspace, id)
      const room =
        channel === null || channel === undefined
          ? undefined
          : roomForChannel(channel, snapshot.channels, snapshot.rooms)
      return room !== undefined && (room.unread > 0 || room.mentions > 0)
    }
    // From the channel already asked for, while the address has not caught up: two quick presses
    // go two channels on.
    const next = channelAfter(
      textChannelIds,
      requestedChannelId ?? activeChannel?.id,
      move.step,
      move.unread ? unread : undefined
    )
    if (next === null) {
      if (move.unread) setAnnouncement(t('console.workspace.shortcuts.announce-no-unread'))
      return
    }
    movedByKey.current = true
    selectTextChannel(next, true)
    const channel = currentChannel(workspace, next)
    if (channel !== null && channel !== undefined)
      setAnnouncement(
        t('console.workspace.shortcuts.announce-channel', { channel: channelLabel(channel, t) })
      )
  })
  useEffect(() => {
    const listen = (event: globalThis.KeyboardEvent) => onChannelKey(event)
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [])

  /** `ArrowUp` in the empty channel composer: the newest own message, edited. */
  function composerKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.shiftKey || composerText !== '' || draft.editing !== null) return
    if (composing(event) || navigationUnsettled) return
    const newest = newestEditable(timeline, viewerId)
    if (newest === undefined) return
    event.preventDefault()
    editMessage(newest)
    // A screen reader passes `ArrowUp` through to re-read the line: the field turning into an
    // edit is said, or the next `Enter` would save over the message unawares.
    setAnnouncement(t('console.workspace.shortcuts.announce-editing'))
  }

  /** `Escape` in the channel's column: the edit, else the reply, else the unread, given up. */
  function columnKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || composing(event)) return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (draft.editing !== null) {
      event.preventDefault()
      updateDraft({ editing: null, text: '' })
      return
    }
    if (replyBannerTarget !== undefined) {
      event.preventDefault()
      updateDraft({ replyTo: null })
      return
    }
    const unread = activeRoom !== undefined && (activeRoom.unread > 0 || activeRoom.mentions > 0)
    if (activeRoomId === null || (!unread && unreadFrom === null)) return
    event.preventDefault()
    setReadAtOpen({ store: activeStore, roomId: activeRoomId, eventId: null })
    if (unread) activeStore.markRead?.(activeRoomId).catch(() => undefined)
    setAnnouncement(
      t('console.workspace.shortcuts.announce-marked-read', { channel: activeChannelName })
    )
  }

  // The dock says where the media connection stands, not the chat's sync.
  const callLive = LIVE_CALL.has(callSnapshot.status) && callChannel !== null
  const callOver = callSnapshot.status === 'ended' || callSnapshot.status === 'failed'
  const dockStatus =
    callSnapshot.status === 'reconnecting'
      ? 'reconnecting'
      : callSnapshot.status === 'connecting'
        ? 'connecting'
        : 'connected'
  const dockStatusLabel =
    dockStatus === 'reconnecting'
      ? t('console.workspace.audio.status-reconnecting')
      : dockStatus === 'connecting'
        ? t('console.workspace.audio.status-connecting')
        : callSnapshot.listenOnly
          ? t('console.workspace.audio.status-listen-only')
          : t('console.workspace.audio.status-connected')
  const callProblem = callSnapshot.problem
  // Leaving the view ends the call, so leaving it asks first. Not while signed out: the call is
  // already left then, and « Se reconnecter » leaves the page on purpose.
  const guardCall = LIVE_CALL.has(callSnapshot.status) && !signedOut

  const channelNavigation = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* On a phone the column is the whole screen: the top bar already carries the
              organisation and its switch, and a touch screen has no shortcut to show. */}
      <div className="flex flex-col gap-3">
        {narrow ? null : <OrganisationHeader name={organisationName} slug={org} />}
        {organisationActionSlot ?? null}
        <h2 id={sidebarHeadingId} className="sr-only">
          {t('console.workspace.sidebar.title')}
        </h2>
        <UniversalSearch
          entries={searchEntries}
          onChoose={openFromSearch}
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
                    open: openInvitation,
                  },
                ]
              : []),
            ...mentionCandidates.map((member) => ({
              id: `member:${member.userId}`,
              label: `@${member.label}`,
              open: () => {
                insertInComposer.current?.(`@${member.label} `)
              },
            })),
          ]}
          documents={(onOpenDocument ? documents : []).map((doc) => ({
            id: doc.id,
            label: doc.title,
            open: () => openStudioDocument?.(doc),
          }))}
        />
        <StudioNavigation
          compact={narrow}
          section="primary"
          mode={activeCanvasMode ?? 'chat'}
          onChange={
            onChangeCanvasMode
              ? (mode) => {
                  onChangeCanvasMode(mode)
                  if (narrow) {
                    channelChooserReturnFocus.current = headingRef.current
                    setChannelsOpen(false)
                  }
                }
              : undefined
          }
          rooms={searchEntries.filter((entry) => entry.kind === 'audio')}
          onChoose={openStudioChannel}
          activity={activity}
          files={files}
          onOpenDocument={openStudioDocument}
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
      </div>
    </div>
  )
  // The call controls stay outside the mobile chooser, so mute and leave never require reopening it.
  const callControls = (
    <>
      <div aria-live="polite" className="flex flex-col gap-2">
        {callProblem === undefined ? null : (
          <div className="flex flex-col gap-2 px-2">
            <InlineAlert kind="warning" inLiveRegion>
              {t(CALL_PROBLEM[callProblem])}
            </InlineAlert>
            {callOver ? (
              <div className="flex flex-wrap gap-2">
                {RETRYABLE.has(callProblem) && callChannel !== null && activeCall !== null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void activeCall.join(callChannel.roomId)}
                  >
                    {t('console.workspace.audio.action-retry')}
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" onClick={() => void activeCall?.leave()}>
                  {t('console.workspace.audio.action-dismiss')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {callLive && activeCall !== null && callSnapshot.playbackBlocked ? (
          <div className="flex flex-col gap-2 px-2">
            <InlineAlert kind="warning" inLiveRegion>
              {t('console.workspace.audio.label-playback-blocked')}
            </InlineAlert>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                // From the click itself: the browser lets the sound play from a gesture only.
                onClick={() => void activeCall.startAudio()}
              >
                {t('console.workspace.audio.action-start-audio')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {callLive && activeCall !== null ? (
        <>
          {activeCall.mode === 'local-preview' ? (
            <p role="status" className="px-3 py-2 text-xs text-c-ink-3">
              {audioPreviewMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr'].notice}
            </p>
          ) : null}
          <AudioDock
            key={callSnapshot.roomId}
            layout="studio"
            localParticipantId={viewerId}
            previewCamera={activeCall.mode === 'local-preview'}
            participants={callSnapshot.participants.map((id) => ({
              id,
              name:
                snapshot.rooms.find((room) => room.roomId === callSnapshot.roomId)?.names?.[id] ??
                displayNameOf(id),
              roleLabel:
                profileCopy[
                  activeStore.getProfileRole?.(callSnapshot.roomId ?? '', id) ?? 'member'
                ],
              speaking: dockStatus === 'connected' && callSnapshot.speakers.includes(id),
            }))}
            participantsLabel={
              studioMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr'].participants
            }
            cameraUnavailable={
              studioMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr'].cameraGap
            }
            label={t('console.workspace.audio.label-dock')}
            room={callChannel.roomName}
            {...(callChannel.categoryName === undefined
              ? {}
              : { category: callChannel.categoryName })}
            status={dockStatus}
            statusLabel={
              activeCall.mode === 'local-preview'
                ? audioPreviewMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr'].status
                : dockStatusLabel
            }
            muted={callSnapshot.muted}
            deafened={callSnapshot.deafened}
            {...(activeCall.micLevel === undefined ? {} : { meterRef: micActivity.meterRef })}
            {...(deviceSettings === null
              ? {}
              : {
                  settings: (
                    <AudioSettings
                      call={deviceSettings}
                      inputMissing={callSnapshot.inputMissing === true}
                      meterRef={micActivity.panelMeterRef}
                    />
                  ),
                })}
            onToggleMute={() => void activeCall.setMuted(!callSnapshot.muted)}
            onToggleDeafen={() => void activeCall.setDeafened(!callSnapshot.deafened)}
            onLeave={() => void activeCall.leave()}
            labels={{
              mute: t('console.workspace.audio.action-mute'),
              deafen: t('console.workspace.audio.action-deafen'),
              leave: t('console.workspace.audio.action-leave'),
            }}
          />
        </>
      ) : null}
    </>
  )
  const sidebar = (
    <nav
      aria-labelledby={sidebarHeadingId}
      style={narrow ? undefined : { width: `${leftSidebarWidth}px` }}
      className="order-first flex w-shell-sidebar-width shrink-0 flex-col justify-between overflow-hidden border-r border-c-border-soft bg-c-sunken p-3 narrow:max-h-[calc(100vh*3/4)] narrow:w-full narrow:border-r-0"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {channelNavigation}
        <StudioNavigation
          compact={narrow}
          section="tools"
          mode={activeCanvasMode ?? 'chat'}
          onChange={
            onChangeCanvasMode
              ? (mode) => {
                  onChangeCanvasMode(mode)
                  if (narrow) {
                    channelChooserReturnFocus.current = headingRef.current
                    setChannelsOpen(false)
                  }
                }
              : undefined
          }
          rooms={searchEntries.filter((entry) => entry.kind === 'audio')}
          onChoose={openStudioChannel}
          activity={activity}
          files={files}
          onOpenDocument={openStudioDocument}
        />
      </div>
      {sidebarFooterSlot ?? null}
    </nav>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="studio-workspace">
      <div className="flex min-h-0 flex-1 narrow:flex-col">
        {narrow ? (
          <div className="order-first flex shrink-0 flex-col gap-3 border-b border-c-border-soft pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <OrganisationHeader name={organisationName} slug={org} />
              </div>
              <Drawer
                open={channelsOpen}
                onOpenChange={changeChannelChooser}
                side="bottom"
                title={t('console.workspace.sidebar.title')}
                closeLabel={t('console.common.action-close')}
                returnFocusTo={channelChooserReturnFocus}
                trigger={
                  <Button variant="secondary" size="sm" className="shrink-0">
                    {t('console.workspace.sidebar.title')}
                  </Button>
                }
              >
                {sidebar}
              </Drawer>
            </div>
          </div>
        ) : null}
        {inRouter ? <LeaveCallGuard live={guardCall} /> : null}
        {narrow ? null : (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <div
            data-testid="espace-sidebar-primary-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('console.workspace.layout.resize-channels')}
            aria-valuenow={leftSidebarWidth}
            aria-valuemin={180}
            aria-valuemax={420}
            // A focusable splitter (role="separator" with a value) is interactive in WAI-ARIA.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onMouseDown={startLeftSidebarResize}
            onDoubleClick={() => setLeftSidebarWidth(256)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                setLeftSidebarWidth((w) => Math.max(180, w - 16))
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                setLeftSidebarWidth((w) => Math.min(420, w + 16))
              }
            }}
            className="w-1 shrink-0 cursor-col-resize bg-c-border-soft transition-colors hover:bg-c-action focus-visible:bg-c-action focus-visible:outline-hidden"
          />
        )}
        {/* `Escape` from anything in the column that did not use it (spec « Keyboard shortcuts »). */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <section
          ref={channelColumn}
          onKeyDown={columnKeyDown}
          className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-c-surface px-6 py-5 narrow:overflow-visible narrow:bg-transparent narrow:p-0"
        >
          <p aria-live="polite" aria-atomic="true" className="sr-only">
            {announcement.count === 0 ? null : (
              <span key={announcement.count}>{announcement.text}</span>
            )}
          </p>
          <header className="flex items-center gap-3 border-b border-c-border-soft pb-4 narrow:flex-wrap">
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
                  <span aria-hidden="true" className="text-c-ink-3">
                    {isEmergencyChannel(activeChannel, emergencyChannelIds) ? <AntennaIcon /> : '#'}
                  </span>
                  <span className="min-w-0 truncate">{activeChannelName}</span>
                </h1>
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
                  {/* Reference screen p02: who is here, at a glance, beside the count that says it
                    in words, so the faces are not read. Someone with no name gets a person
                    glyph, never a character of their id. */}
                  {memberCount !== null && faces.length > 0 ? (
                    <span className="flex shrink-0 gap-1 narrow:hidden">
                      {faces.map((face) => (
                        <Avatar
                          key={face.userId}
                          name={face.name ?? displayNameOf(face.userId)}
                          identity={face.userId}
                          onlineLabel={
                            activeStore.isOnline?.(face.userId)
                              ? simulation
                                ? demoCopy.presence
                                : t('console.workspace.presence.online')
                              : undefined
                          }
                          anonymous={face.name === undefined}
                          size="xs"
                          className="ring-2 ring-c-surface"
                        />
                      ))}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            {activeRoom !== undefined && activeChannel != null && !focusedDocs ? (
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
                onClick={() => setMembersOpen((open) => !open)}
              />
            )}
            <StudioNavigation
              compact={narrow}
              section="call-entry"
              mode={activeCanvasMode ?? 'chat'}
              rooms={searchEntries.filter((entry) => entry.kind === 'audio')}
              onChoose={(entry) => {
                if (narrow) {
                  setChannelsOpen(true)
                  return null
                }
                return openFromSearch(entry)
              }}
            />
            {activeCanvasMode === 'docs' ? (
              <span className="text-sm font-bold text-c-ink">
                {t('console.workspace.canvas.mode-docs')}
              </span>
            ) : null}
          </header>

          {snapshot.status === 'signed-out' ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <InlineAlert kind="warning">
                {t('console.workspace.message.session-expired')}
              </InlineAlert>
              {onReconnect === undefined ? null : (
                <Button variant="secondary" size="sm" onClick={onReconnect}>
                  {t('console.workspace.message.action-reconnect')}
                </Button>
              )}
            </div>
          ) : null}

          {activeChannel != null && docsCanvasSlot !== undefined ? (
            <div
              hidden={activeCanvasMode !== 'docs'}
              data-testid="espace-inline-docs-canvas"
              className={activeCanvasMode === 'docs' ? 'flex min-h-0 flex-1 flex-col' : ''}
            >
              {docsCanvasSlot}
            </div>
          ) : null}
          {activeChannel == null || activeCanvasMode === 'docs' ? null : (
            <>
              {isEmergencyChannel(activeChannel, emergencyChannelIds) &&
              renderEmergencyPanel !== undefined ? (
                <div data-testid="espace-emergency-room-surface" className="flex flex-col gap-3">
                  <div data-testid="emergency-room-panel">
                    {renderEmergencyPanel(activeChannel)}
                  </div>
                </div>
              ) : null}
              <div
                ref={logRef}
                onScroll={onLogScroll}
                role="log"
                aria-label={t('console.workspace.channel.log-label', {
                  channel: activeChannelName,
                })}
                aria-busy={history === 'loading' ? true : undefined}
                // Conversation history begins under the header, matching the document canvas.
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-2"
              >
                {history === undefined || (history === 'start' && timeline.length === 0) ? null : (
                  <HistoryEdge
                    history={history}
                    channel={activeChannelName}
                    onLoadOlder={showOlder}
                  />
                )}
                {history === 'start' || (timeline.length === 0 && history === undefined) ? (
                  <div className="flex flex-col gap-2 py-8">
                    <span
                      aria-hidden="true"
                      className="flex h-12 w-12 items-center justify-center rounded-full bg-c-muted text-xl text-c-ink-3"
                    >
                      #
                    </span>
                    <h2 className="text-xl font-bold text-c-ink">
                      {t('console.workspace.channel.welcome-title', { channel: activeChannelName })}
                    </h2>
                    {timeline.length === 0 ? (
                      <p className="text-sm text-c-ink-3">
                        {t('console.workspace.channel.live-empty', { channel: activeChannelName })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {(timeline.length === 0 ? [] : rows).length === 0 &&
                (timelineInserts ?? []).length === 0
                  ? null
                  : mergeTimelineInserts(
                      timeline.length === 0 ? [] : rows,
                      timelineInserts ?? []
                    ).map((row) =>
                      row.kind === 'insert' ? (
                        <div key={row.key} data-testid="espace-timeline-insert">
                          {row.node}
                        </div>
                      ) : row.kind === 'day' ? (
                        <TimelineDivider key={row.key}>{dayLabel(row.day, row.ts)}</TimelineDivider>
                      ) : row.kind === 'new' ? (
                        <TimelineDivider key={row.key} tone="new">
                          {t('console.workspace.channel.label-new-messages')}
                        </TimelineDivider>
                      ) : (
                        <LiveMessageRow
                          profileRole={memberProfile({ userId: row.message.sender }).role}
                          onMention={
                            isArchivedChannel || navigationUnsettled ? undefined : mentionMember
                          }
                          key={row.key}
                          onlineLabel={
                            activeStore.isOnline?.(row.message.sender)
                              ? simulation
                                ? demoCopy.presence
                                : t('console.workspace.presence.online')
                              : undefined
                          }
                          document={documents.find(
                            (doc) =>
                              doc.id === row.message.document?.id &&
                              doc.channelId === activeChannel?.id
                          )}
                          onOpenDocument={openStudioDocument}
                          message={row.message}
                          placement="timeline"
                          viewerId={viewerId}
                          archived={isArchivedChannel}
                          expanded={openThreadRootId === row.message.eventId}
                          repliedMessage={
                            row.message.replyTo === null
                              ? undefined
                              : timeline.find(
                                  (candidate) => candidate.eventId === row.message.replyTo
                                )
                          }
                          threadReplies={
                            activeRoomId === null
                              ? []
                              : activeStore.getThread(activeRoomId, row.message.eventId)
                          }
                          menuContextKey={`${draftContext.generation}:${viewerId}:${activeRoomId}:${row.message.key}`}
                          onRetry={retryMessage}
                          onReaction={reactToMessage}
                          onReply={replyToMessage}
                          onEdit={editMessage}
                          onRemove={removeMessage}
                          onOpenThread={openThread}
                        />
                      )
                    )}
              </div>

              {!canWrite ? (
                paneNotice === undefined ? null : (
                  <p className="border-t border-c-border-soft pt-3 text-sm text-c-ink-3">
                    {paneNotice}
                  </p>
                )
              ) : (
                <>
                  {/* Where one can write, so where others may be writing. Its own polite region,
                  apart from the log's: a name typing is said once, and a message arriving is not
                  held behind it. */}
                  <p aria-live="polite" aria-atomic="true" className="min-h-5 text-xs text-c-ink-3">
                    {typingLine(typing, t)}
                  </p>
                  <form
                    onSubmit={submitChannelComposer}
                    className="flex flex-col gap-2 border-t border-c-border-soft pt-3"
                  >
                    {replyBannerTarget !== undefined ? (
                      <div className="flex items-center justify-between gap-2 rounded-md bg-c-sunken px-3 py-2 text-xs text-c-ink-2">
                        <span>
                          <Trans
                            i18nKey="console.workspace.message.reply-banner"
                            components={{
                              author: <strong>{nameOf(replyBannerTarget)}</strong>,
                            }}
                          />
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => updateDraft({ replyTo: null })}
                        >
                          {t('console.workspace.composer.reply-cancel')}
                        </Button>
                      </div>
                    ) : null}
                    {editingEventId !== null ? (
                      <div className="flex items-center justify-between gap-2 rounded-md bg-c-sunken px-3 py-2 text-xs text-c-ink-2">
                        <span>{t('console.workspace.composer.edit-label')}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => updateDraft({ editing: null, text: '' })}
                        >
                          {t('console.workspace.composer.edit-cancel')}
                        </Button>
                      </div>
                    ) : null}
                    {/* Reference screen p02: the field above its tools, one bordered box, which greys
                    and rings as a whole, as TextField does. The dark workspace reference sets it
                    in a muted well (docs/specs/workspace-dark-roles.md); its input edge stays, at
                    3.21 / 3.71 / 3.26 : 1 on that well, since a text field needs a boundary
                    (WCAG 1.4.11). */}
                    {simulation ? (
                      <p id={demoGuidanceId} className="mb-2 text-xs text-c-ink-2">
                        {demoCopy.composer}
                      </p>
                    ) : null}
                    <div
                      ref={composerBox}
                      className={cx(
                        'composer-frame-focus flex items-center gap-1 rounded-lg border px-2 focus-within:ring',
                        navigationUnsettled
                          ? 'border-c-border bg-c-disabled'
                          : 'border-c-border-input bg-c-muted focus-within:border-c-accent-ink'
                      )}
                    >
                      <label htmlFor={composerInputId} className="sr-only">
                        {t('console.workspace.composer.label-message', {
                          channel: activeChannelName,
                        })}
                      </label>
                      <RichComposerInput
                        scope={activeRoomId ?? 'none'}
                        onInvite={canInvite ? openInvitation : undefined}
                        onStagingChange={(staged) =>
                          setAttachmentRoom(staged ? activeRoomId : null)
                        }
                        id={composerInputId}
                        aria-describedby={simulation ? demoGuidanceId : undefined}
                        value={composerText}
                        onValueChange={(text) => {
                          updateDraft({
                            text,
                            ...(staleEdit ? { editing: null } : {}),
                          })
                          // A new message being written, not an edit of a sent one.
                          if (activeRoomId !== null)
                            activeStore.setTyping?.(
                              activeRoomId,
                              text.trim() !== '' && editingEventId === null
                            )
                        }}
                        members={mentionCandidates}
                        listLabel={t('console.workspace.composer.label-mention-list')}
                        emojiListLabel={t('console.workspace.composer.label-emoji-list')}
                        onMentionStart={loadMembers}
                        mentionRef={startMention}
                        insertRef={insertInComposer}
                        onKeyDown={composerKeyDown}
                        {...(narrow
                          ? {}
                          : {
                              'aria-keyshortcuts':
                                'Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown',
                            })}
                        placeholder={
                          simulation
                            ? demoCopy.placeholder
                            : t('console.workspace.composer.placeholder-message', {
                                channel: activeChannelName,
                              })
                        }
                        // Read-only, not `disabled`, while the address is undecided: a disabled
                        // field drops the focus to the page, and a channel shortcut pressed while
                        // writing must leave it in the field. Sending is refused at submit.
                        readOnly={navigationUnsettled}
                        aria-disabled={navigationUnsettled || undefined}
                        className={cx(
                          'min-w-0 flex-1 bg-transparent px-1 py-2 text-md outline-hidden',
                          navigationUnsettled
                            ? 'text-c-on-disabled placeholder:text-c-on-disabled'
                            : 'text-c-ink placeholder:text-c-placeholder',
                          'aria-disabled:cursor-not-allowed',
                          TOUCH_TARGET_HEIGHT
                        )}
                      />
                      <div className="flex shrink-0 items-center gap-1">
                        {/* p02's `.icon-btn`, drawn as the thread panel's close button is. */}
                        <Tooltip content={t('console.workspace.composer.action-mention')} names>
                          <button
                            type="button"
                            aria-label={t('console.workspace.composer.action-mention')}
                            disabled={navigationUnsettled}
                            onClick={() => startMention.current?.()}
                            className={cx(
                              'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-c-ink-3',
                              'hover:bg-c-sunken hover:text-c-ink',
                              'disabled:cursor-not-allowed disabled:text-c-on-disabled disabled:hover:bg-transparent',
                              TOUCH_TARGET,
                              'focus-visible:ring focus-visible:outline-hidden'
                            )}
                          >
                            <MentionIcon />
                          </button>
                        </Tooltip>
                        <EmojiPalette
                          disabled={navigationUnsettled}
                          anchorRef={composerBox}
                          onPick={(emoji) => insertInComposer.current?.(emoji)}
                        />
                        {/* Icons only (owner decision): the name, « Envoyer » or « Enregistrer »
                          while editing, is the accessible name and the tooltip. Enter still sends. */}
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          icon={<SendIcon />}
                          iconOnly
                          aria-label={t(
                            editingEventId !== null
                              ? 'console.workspace.composer.action-save'
                              : 'console.workspace.composer.action-send'
                          )}
                          disabled={navigationUnsettled || attachmentStaged}
                          className="ml-auto"
                        />
                      </div>
                    </div>
                  </form>
                </>
              )}
            </>
          )}
        </section>

        {!narrow && !focusedDocs && membersOpen && activeRoomId !== null ? (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <div
            data-testid="espace-sidebar-secondary-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('console.workspace.layout.resize-side-panel')}
            aria-valuenow={rightSidebarWidth}
            aria-valuemin={220}
            aria-valuemax={560}
            // A focusable splitter (role="separator" with a value) is interactive in WAI-ARIA.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            onMouseDown={startRightSidebarResize}
            onDoubleClick={() => setRightSidebarWidth(280)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault()
                setRightSidebarWidth((w) => Math.min(560, w + 16))
              } else if (event.key === 'ArrowRight') {
                event.preventDefault()
                setRightSidebarWidth((w) => Math.max(220, w - 16))
              }
            }}
            className="w-1 shrink-0 cursor-col-resize bg-c-border-soft transition-colors hover:bg-c-action focus-visible:bg-c-action focus-visible:outline-hidden"
          />
        ) : null}

        {!focusedDocs && membersOpen && activeRoomId !== null ? (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <aside
            id={membersPanelId}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault()
                closeMembers()
              }
            }}
            aria-label={t('console.workspace.members.title')}
            style={narrow ? undefined : { width: `${rightSidebarWidth}px` }}
            className="flex w-shell-sidebar-width shrink-0 flex-col gap-3 overflow-y-auto border-l border-c-border-soft bg-c-sunken p-4 narrow:w-full"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-c-ink">
                {t('console.workspace.members.title')}
              </h2>
              <Button
                variant="tertiary"
                size="sm"
                icon={<CloseIcon />}
                iconOnly
                aria-label={t('console.common.action-close')}
                onClick={closeMembers}
              />
            </div>
            <div
              data-testid="espace-members-presence-summary"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs font-medium text-c-ink-2"
            >
              <span className="text-c-ok-ink">
                {simulation
                  ? demoCopy.roster
                  : t('console.workspace.members.online-count', {
                      count: roster.filter((member) => memberProfile(member).presence !== 'offline')
                        .length,
                    })}
              </span>
              <span className="text-c-ink-3">
                {simulation ? demoCopy.presence : profileCopy.offline} (
                {roster.filter((member) => memberProfile(member).presence === 'offline').length})
              </span>
            </div>
            {(['maintainer', 'core', 'admin', 'partner', 'member', 'offline'] as const).map(
              (group) => {
                const members = roster
                  .map(memberProfile)
                  .filter((member) =>
                    group === 'offline'
                      ? member.presence === 'offline'
                      : member.presence !== 'offline' && member.role === group
                  )
                if (members.length === 0) return null
                const label =
                  group === 'offline'
                    ? profileCopy.offlineGroup
                    : group === 'admin'
                      ? t('console.workspace.members.admins')
                      : profileCopy[group]
                return (
                  <section key={group} aria-label={label} className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold text-c-ink-3">
                      {label} · {members.length}
                    </h3>
                    <ul className="flex flex-col gap-1">
                      {members.map((member) => (
                        <li key={member.userId}>
                          <UserProfilePopover
                            member={member}
                            onMention={
                              isArchivedChannel || navigationUnsettled || member.userId === viewerId
                                ? undefined
                                : mentionMember
                            }
                            trigger={
                              <button
                                type="button"
                                className="flex w-full min-w-0 items-center gap-3 rounded-lg p-2 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
                              >
                                <Avatar
                                  name={member.name}
                                  identity={member.userId}
                                  size="lg"
                                  presenceGround="sunken"
                                  onlineLabel={
                                    member.presence === 'offline'
                                      ? undefined
                                      : member.presence === 'online'
                                        ? simulation
                                          ? demoCopy.presence
                                          : t('console.workspace.presence.online')
                                        : profileCopy[member.presence]
                                  }
                                />
                                <span className="flex min-w-0 flex-1 flex-col gap-1">
                                  <span className="truncate text-sm font-medium text-c-ink-2">
                                    {member.name}
                                  </span>
                                  <span className="truncate text-xs text-c-ink-3">
                                    {member.status || profileCopy[member.presence]}
                                  </span>
                                </span>
                              </button>
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              }
            )}
          </aside>
        ) : null}
        {threadRootMessage !== undefined &&
        activeChannel !== null &&
        activeChannel !== undefined ? (
          <>
            <p className="text-xs text-c-ink-2">{t('console.onboarding.studio.thread-poll')}</p>
            <ThreadPanel
              label={t('console.workspace.thread.title')}
              title={t('console.workspace.thread.title')}
              channel={`# ${activeChannelName}`}
              closeLabel={t('console.common.action-close')}
              onClose={() => updateDraft({ threadRoot: null })}
              returnFocusTo={threadFocusTarget}
              parent={
                <LiveMessageRow
                  profileRole={memberProfile({ userId: threadRootMessage.sender }).role}
                  onMention={isArchivedChannel || navigationUnsettled ? undefined : mentionMember}
                  key={threadRootMessage.key}
                  onlineLabel={
                    activeStore.isOnline?.(threadRootMessage.sender)
                      ? simulation
                        ? demoCopy.presence
                        : t('console.workspace.presence.online')
                      : undefined
                  }
                  message={threadRootMessage}
                  placement="thread"
                  viewerId={viewerId}
                  archived={isArchivedChannel}
                  expanded={false}
                  repliedMessage={undefined}
                  threadReplies={[]}
                  menuContextKey={`${draftContext.generation}:${viewerId}:${activeRoomId}:${threadRootMessage.key}`}
                  onRetry={retryMessage}
                  onReaction={reactToMessage}
                  onReply={replyToMessage}
                  onEdit={editMessage}
                  onRemove={removeMessage}
                  onOpenThread={openThread}
                />
              }
              repliesLabel={t('console.workspace.thread.label-replies')}
              composer={
                isArchivedChannel ? undefined : (
                  <form onSubmit={submitThreadComposer} className="flex items-center gap-2 pt-2">
                    <label htmlFor={threadInputId} className="sr-only">
                      {t('console.workspace.thread.composer-label')}
                    </label>
                    <MentionInput
                      id={threadInputId}
                      value={threadText}
                      onValueChange={(text) => updateDraft({ threadText: text })}
                      members={mentionCandidates}
                      listLabel={t('console.workspace.composer.label-mention-list')}
                      emojiListLabel={t('console.workspace.composer.label-emoji-list')}
                      onMentionStart={loadMembers}
                      placeholder={
                        simulation
                          ? demoCopy.placeholder
                          : t('console.workspace.thread.composer-placeholder')
                      }
                      aria-describedby={simulation ? demoGuidanceId : undefined}
                      disabled={navigationUnsettled}
                      className={cx(
                        'min-w-0 flex-1 rounded-lg border border-c-border-input bg-c-muted px-3 py-2 text-md text-c-ink',
                        'focus-visible:ring focus-visible:outline-hidden',
                        'disabled:cursor-not-allowed disabled:bg-c-disabled disabled:text-c-on-disabled'
                      )}
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      icon={<SendIcon />}
                      iconOnly
                      aria-label={t('console.workspace.thread.action-reply')}
                      disabled={navigationUnsettled}
                    />
                  </form>
                )
              }
            >
              {activeThreadReplies.map((reply) => (
                <LiveMessageRow
                  profileRole={memberProfile({ userId: reply.sender }).role}
                  onMention={isArchivedChannel || navigationUnsettled ? undefined : mentionMember}
                  key={reply.key}
                  onlineLabel={
                    activeStore.isOnline?.(reply.sender)
                      ? simulation
                        ? demoCopy.presence
                        : t('console.workspace.presence.online')
                      : undefined
                  }
                  message={reply}
                  placement="thread"
                  viewerId={viewerId}
                  archived={isArchivedChannel}
                  expanded={false}
                  repliedMessage={undefined}
                  threadReplies={[]}
                  menuContextKey={`${draftContext.generation}:${viewerId}:${activeRoomId}:${reply.key}`}
                  onRetry={retryMessage}
                  onReaction={reactToMessage}
                  onReply={replyToMessage}
                  onEdit={editMessage}
                  onRemove={removeMessage}
                  onOpenThread={openThread}
                />
              ))}
            </ThreadPanel>
          </>
        ) : null}

        {narrow ? null : sidebar}
      </div>
      <div className="shrink-0">{callControls}</div>
    </div>
  )
}
