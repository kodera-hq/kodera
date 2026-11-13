// What the live view's parts share: the store and the call as they read them, and the pure rules
// that turn a workspace, a snapshot and a message into what is drawn. No component lives here, so
// each part (`MessageTimeline`, `MessageComposer`, `ChannelSidebar`, `VoiceCallDock`) imports the
// rules without importing another part.

import type { DirectSummary } from './matrix/directs'
import type { KeyboardEvent, ReactNode } from 'react'
import type { ChannelDoc, ChannelDocsWorkspace } from '../docs/ChannelDocsEditor'
import type { MemberProfileRole } from '../profile/UserProfilePopover'
import type { RoomOccupant } from '../../ui/RoomRow/RoomRow'
import type { Workspace, WorkspaceChannel } from '../workspace/workspace'
import type { AudioSettingsCall } from './AudioSettings'
import type { CallSnapshot, CallStatus } from './audio/call'
import type {
  ChannelRoom,
  EspaceSnapshot,
  History,
  MemberView,
  RoomSummary,
  SendOptions,
} from './matrix/store'
import type { MessageView } from './matrix/timeline'

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

/**
 * Whether a channel is the organisation's proximity room (« Autour de moi »). Only a flag set by
 * the server may say so, never the channel's name: a channel its members called « proximity » is an
 * ordinary channel. Core flags no channel yet, so the product passes no set and none qualifies.
 */
export function isProximityChannel(
  channel: WorkspaceChannel | null | undefined,
  flaggedChannelIds: ReadonlySet<string> | undefined
): boolean {
  if (channel === null || channel === undefined || flaggedChannelIds === undefined) return false
  return flaggedChannelIds.has(channel.id)
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
  /** The member's direct conversations (`m.direct`); absent where there are none, as in the demo. */
  getDirects?: () => readonly DirectSummary[]
  /** Opens, or starts, the direct conversation with these people; resolves to its room id. */
  openDirect?: (userIds: readonly string[]) => Promise<string>
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
  /** The room's pinned events (`m.room.pinned_events`), oldest pin first. */
  getPinned?: (roomId: string) => readonly string[]
  /** Whether the member may change the room's pins. */
  canPin?: (roomId: string) => boolean
  /** Pins or unpins one of the room's events. */
  setPinned?: (roomId: string, eventId: string, pinned: boolean) => Promise<void>
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
  /** The browser's noise suppression on the member's microphone (`CallController`). */
  setNoiseSuppression?: (on: boolean) => Promise<void>
  /** The member's camera and shared screen, and drawing the call's video (`CallController`). */
  setCameraEnabled?: (on: boolean) => Promise<void>
  setScreenShareEnabled?: (on: boolean) => Promise<void>
  attachVideo?: (key: string, element: HTMLVideoElement) => () => void
}

/** The audio room the dock names: the channel the member chose, as the sidebar labels it. */
export interface CallChannel {
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
/** What a view with no call reads in the call's place: an idle one that never changes. */
export const subscribeToNoCall = () => () => undefined
export const noCallSnapshot = () => NO_CALL_SNAPSHOT

/** A call the member is in, or on the way into or back into. */
export const LIVE_CALL: ReadonlySet<CallStatus> = new Set([
  'connecting',
  'connected',
  'reconnecting',
])

export const NO_MESSAGES: readonly MessageView[] = []

/** The DOM id of an audio room's row in the sidebar, where the search sends focus. */
export function roomRowId(sidebarHeadingId: string, channelId: string): string {
  return `${sidebarHeadingId}-room-${channelId}`
}

/** The name drawn for a member the room holds no display name for: its id's localpart. */
export function displayNameOf(userId: string): string {
  if (!userId.startsWith('@')) return userId
  const localpart = userId.slice(1).split(':')[0] ?? userId
  return localpart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** A message's author as drawn: the room's display name, else the id's localpart. */
export function nameOf(message: MessageView): string {
  return message.senderName ?? displayNameOf(message.sender)
}

/**
 * A channel's room: the one whose id the room directory gave for the channel's alias (Core
 * contract 0.25.2), among the rooms the member has joined. Never by name, and never by a part
 * of an alias: a channel whose room is not resolved has none.
 */
export function roomForChannel(
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
export function composing(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

/** Whether a channel's room exists: Core says it is ready, and the directory found it. */
export function roomResolved(
  channel: WorkspaceChannel,
  channels: ReadonlyMap<string, ChannelRoom>
) {
  return channel.room_state === 'ready' && channels.get(channel.id)?.state === 'resolved'
}

/** The channels whose room Core says is ready: the ones worth asking the directory for. */
export function readyChannelIds(workspace: Workspace): string[] {
  return [
    ...workspace.categories.flatMap((category) => category.channels),
    ...workspace.uncategorised_channels,
  ]
    .filter((channel) => channel.room_state === 'ready')
    .map((channel) => channel.id)
}

export function occupantsForRoom(room: RoomSummary | undefined): RoomOccupant[] {
  if (room?.occupancy === null || room?.occupancy === undefined) return []
  const sharing = new Set(room.occupancy.screenShare)
  return room.occupancy.participants.map((userId) => ({
    id: userId,
    name: room.names?.[userId] ?? displayNameOf(userId),
    sharingScreen: sharing.has(userId),
  }))
}

/**
 * A member's role in a room as their profile card names it: the store's own profile role, else
 * its power-level role, else a plain member.
 */
export function profileRoleIn(
  store: EspaceStoreLike,
  roomId: string | null,
  userId: string
): MemberProfileRole {
  return roomId === null
    ? 'member'
    : (store.getProfileRole?.(roomId, userId) ?? store.getMemberRole?.(roomId, userId) ?? 'member')
}

/** The same items in the same order: what a getter that rebuilds its array has not changed. */
export function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false
  }
  return true
}
