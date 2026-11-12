// The one thin Kodera layer over matrix-js-sdk (messaging-pilot design §2.3): a later move to
// the Rust SDK touches this folder and nothing above it, and an ESLint rule keeps the SDK from
// being imported anywhere else. Screens read through `subscribe`, `getSnapshot` (the sidebar:
// one summary per room) and `getTimeline` (one room's messages), all with stable identities, so
// React re-renders only what an event changed. Tokens live in memory only (design §2.4): the
// SDK gets an in-memory store, never the browser's storage.

import {
  ATTACHMENTS_FIELD,
  attachmentsFallback,
  type AttachmentRef,
} from '../../messaging/attachments/attachmentRefs'
import {
  ClientEvent,
  createClient,
  EventStatus,
  EventType,
  HttpApiEvent,
  MatrixError,
  MemoryStore,
  MsgType,
  NotificationCountType,
  Preset,
  PendingEventOrdering,
  RoomEvent,
  RoomStateEvent,
  SyncState,
  Visibility,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomState,
} from 'matrix-js-sdk'
import { clearMatrixSession } from '@/auth/matrix'
import { channelRoomAlias, isChannelId, serverNameOf } from '../homeserver'
import { isMatrixUserId } from '../roomInvitations'
import {
  directMap,
  directPeople,
  directRooms,
  existingDirect,
  withDirect,
  type DirectSummary,
} from './directs'
import { NotRenewable, RefreshRefused, refreshingFetch } from './refresh'
export { RefreshRefused }
import {
  occupancyOf,
  threadView,
  timelineView,
  type MessageView,
  type Occupancy,
  type TimelineEvent,
} from './timeline'

export type SyncStatus = 'starting' | 'live' | 'reconnecting' | 'signed-out' | 'stopped'

/**
 * How far back a room's timeline reaches: `more` when older messages are on the homeserver,
 * `loading` while they are asked for, `failed` when the last ask did not answer, `start` when the
 * room's first event is in the timeline.
 */
export type History = 'more' | 'loading' | 'failed' | 'start'

export interface SendOptions {
  mentions?: string[]
  replyTo?: string
  threadRootId?: string
  /** Files already stored by Core, named by id (docs/specs/messaging-media-and-notifications.md). */
  attachments?: AttachmentRef[]
}

/** A joined room, as the sidebar draws it. */
export interface RoomSummary {
  roomId: string
  name: string
  /** The canonical alias, for display only: a channel's room is found by `channels`, never by this. */
  alias: string | null
  /** Text channel or audio room, from the room's `io.kodera.room.policy` (design §2.1). */
  kind: 'text' | 'audio'
  unread: number
  mentions: number
  /** Who is in an audio room, and who shares a screen; null for a text channel or no data. */
  occupancy: Occupancy | null
  /** The display names of the audio room's occupants that have one, by Matrix user id. */
  names?: Readonly<Record<string, string>>
  /**
   * A text channel's people, the signed-in member included and Kodera's own accounts left out:
   * from the homeserver's count (the sync's `m.joined_member_count`), right even while only some
   * members are loaded, or the loaded members' when the sync carried no count. Absent for an
   * audio room.
   */
  joined?: number
  /** A text channel's faces, up to three, other than the signed-in member and Kodera's own
   * accounts: its latest people to write, still in it, most recent first, then other loaded
   * joined members by name. Absent for an audio room. */
  faces?: readonly MemberView[]
}

/** How many faces a channel's header shows beside its member count (reference screen p02). */
export const HEADER_FACES = 3

/** Kodera's own Matrix accounts on a tenant's homeserver (deployment profiles's `espace_accounts.yml`):
 * the tenant agent, which creates every channel room and stays in it, and room-access, joined to
 * every audio room. Neither is a person to count, show or mention. */
const SERVICE_LOCALPARTS = ['kodera-agent', 'room-access'] as const

/** A joined member someone can mention, the signed-in member left out. */
export interface MemberView {
  userId: string
  /** The room's display name; absent when it has none, and the id is all there is. */
  name?: string
}

export interface InviteView {
  roomId: string
  name: string
  inviter: string | null
}

/**
 * A channel's room, as the room directory answers for the channel's alias (Core contract 0.25.2).
 * A channel the map does not hold is not resolved yet: not usable either.
 */
export type ChannelRoom =
  | { state: 'resolved'; roomId: string }
  /** The directory has no room under the alias (a 404): the room does not exist yet. */
  | { state: 'pending' }

export interface EspaceSnapshot {
  status: SyncStatus
  /** Joined rooms, spaces left out, by name. */
  rooms: readonly RoomSummary[]
  invites: readonly InviteView[]
  /** The rooms of the channels asked for with `resolveChannels`, by channel id. */
  channels: ReadonlyMap<string, ChannelRoom>
}

export interface EspaceSession {
  /** The homeserver's client-server base URL, e.g. `https://matrix.acme-sa.kodera.io`. */
  baseUrl: string
  userId: string
  deviceId: string
  accessToken: string
  refreshToken?: string
  /**
   * Buys a new access token with the refresh token; the sign-in layer owns it (E7). Rejects with
   * `RefreshRefused` when the homeserver refuses the refresh token, which ends the session; any
   * other rejection (the network) leaves the session to retry.
   */
  refresh?: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string }>
}

const POLICY = 'io.kodera.room.policy'
/** How long a stop waits for the first /sync to answer before halting anyway. */
const FIRST_SYNC_WAIT_MS = 10_000
const OCCUPANCY = 'io.kodera.room.occupancy'
const NONE: readonly MessageView[] = Object.freeze([])
const NO_MEMBERS: readonly MemberView[] = Object.freeze([])
const NO_CHANNELS: ReadonlyMap<string, ChannelRoom> = new Map()
/** The events asked for with each page back: the SDK's default. */
const OLDER_PAGE = 30
/** How long a first 404 from the directory stands before the alias is asked again. */
const PENDING_FOR_MS = 15_000
/** The longest a 404 stands, however many came before it. */
const PENDING_AT_MOST_MS = 120_000
/** How long after a first failed lookup (the network, a 5xx) the alias is asked again. */
const RETRY_AFTER_MS = 5_000
/** The longest wait after a failure, however many came before it. */
const RETRY_AT_MOST_MS = 60_000
/** How long the homeserver shows the member as typing after one notice (G9's typing line). */
const TYPING_TIMEOUT_MS = 10_000
/** While keys keep coming, the notice is sent again this often, before the last one runs out. */
const TYPING_RESEND_MS = 8_000

/**
 * The wait before the next ask of an alias that has answered `attempts` times without a room:
 * it doubles from `first` up to `atMost`, then is drawn between half of it and all of it, so a
 * homeserver that is down is not asked for every channel at once, every few seconds.
 */
export function backoff(
  first: number,
  atMost: number,
  attempts: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(atMost, first * 2 ** Math.max(0, attempts - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

type Relation = { rel_type: string; event_id: string }

function relationOf(content: Record<string, unknown>): Relation | null {
  const relates = content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined
  return typeof relates?.rel_type === 'string' && typeof relates.event_id === 'string'
    ? { rel_type: relates.rel_type, event_id: relates.event_id }
    : null
}

/**
 * A member's display name in the room, or nothing when the member has none: the localpart is
 * the identity provider's subject, an id no one reads (M1). Two members of one name are told
 * apart by the first characters of their id, not by the whole id the SDK appends.
 */
function displayName(room: Room, userId: string, disambiguate = true): string | undefined {
  const member = room.getMember(userId)
  const name = member?.rawDisplayName
  if (member === null || name === undefined || name === '' || name === userId) return undefined
  return disambiguate && member.disambiguate ? `${name} (${userId.slice(1, 5)})` : name
}

/**
 * A face beside a channel's count. It shows initials: the name as written, without the id that
 * tells two of it apart. A name that is only the id's localpart is no name: the homeserver gives
 * an account without one its localpart, the identity provider's subject (M1), and its first
 * character would draw a face of « 9 ». The header draws a person glyph for a face with no name.
 */
function faceOf(room: Room, userId: string): MemberView {
  const name = displayName(room, userId, false)
  const localpart = userId.slice(1).split(':')[0]
  return name === undefined || name === localpart ? { userId } : { userId, name }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `next`, but with every element equal to the previous one's reused, and the previous array
 * itself when nothing changed: a screen memoised on identity re-renders only what moved. */
function reuse<T extends object>(
  previous: readonly T[] | undefined,
  next: T[],
  id: (item: T) => string
): readonly T[] {
  if (previous === undefined) return next
  const byId = new Map(previous.map((item) => [id(item), item]))
  let changed = previous.length !== next.length
  const merged = next.map((item, index) => {
    const old = byId.get(id(item))
    if (old !== undefined && same(old, item)) {
      if (previous[index] !== old) changed = true
      return old
    }
    changed = true
    return item
  })
  return changed ? merged : previous
}

const clients = new WeakMap<EspaceStore, MatrixClient>()

/** The SDK client behind a store, for tests that play the tenant agent or the room-access
 * service (creating rooms, writing their state). Product code never needs it. */
export function matrixClientForTests(store: EspaceStore): MatrixClient {
  return clients.get(store)!
}

export class EspaceStore {
  readonly #client: MatrixClient
  readonly #me: string
  /** Kodera's own accounts on the member's homeserver (`SERVICE_LOCALPARTS`). */
  readonly #services: ReadonlySet<string>
  #snapshot: EspaceSnapshot = { status: 'starting', rooms: [], invites: [], channels: NO_CHANNELS }
  readonly #timelines = new Map<string, readonly MessageView[]>()
  readonly #threads = new Map<string, Map<string, readonly MessageView[]>>()
  readonly #eventsByRoom = new Map<string, TimelineEvent[]>()
  /** Relations seen before a redaction erased them (see timelineView). */
  readonly #relations = new Map<string, Relation>()
  readonly #dirty = new Set<string>()
  readonly #listeners = new Set<() => void>()
  /** Rooms whose full member list was asked for: the first sync lazy-loads only the senders'. */
  readonly #membersAsked = new Set<string>()
  readonly #members = new Map<string, readonly MemberView[]>()
  #status: SyncStatus = 'starting'
  #scheduled = false
  #starting: Promise<void> | null = null
  #stopped = false
  /** startClient has returned: a stop from now on halts at once. */
  #started = false
  readonly #detach: (() => void)[] = []
  #accessToken: string
  #refreshToken: string | undefined
  readonly #refresh: EspaceSession['refresh']
  /** The refresh in flight: the SDK's requests and the room-access call share it. */
  #renewing: Promise<string> | null = null
  /** The channels the screen asked for: the only ones asked again after a 404 or a failure. */
  #watched = new Set<string>()
  /** Each answer the directory gave, by channel id, and until when it stands. */
  readonly #lookups = new Map<string, { room: ChannelRoom; until: number }>()
  /**
   * Asks in a row that found no room, per channel, and of which kind: what `backoff` doubles on.
   * A failure says the homeserver is unwell, a 404 that the room is not made yet; an answer of the
   * other kind starts the count over, so a homeserver back up does not hold a new room's 404 at
   * the longest wait.
   */
  readonly #misses = new Map<string, { kind: 'failure' | 'pending'; count: number }>()
  /** The lookups on their way: a second ask for the same channel waits for the first. */
  readonly #asking = new Map<string, Promise<void>>()
  readonly #askAgain = new Map<string, ReturnType<typeof setTimeout>>()
  /** Channels whose found room was missing from a live sync and was asked for once more. */
  readonly #rechecked = new Set<string>()
  /** Channels already reported as impossible to look up: one warning each. */
  readonly #warned = new Set<string>()
  /** Rooms whose older messages are being asked for, and those whose last ask failed. */
  readonly #paging = new Map<string, 'loading' | 'failed'>()
  /** How far back each joined room's timeline reaches, as of the last rebuild. */
  readonly #histories = new Map<string, History>()
  /** Who is typing in each room, but the signed-in member: the same array until it changes. */
  readonly #typing = new Map<string, readonly MemberView[]>()
  /**
   * The user ids each room's last `m.typing` named. The SDK sets `typing` only on the members it
   * has loaded, and the first sync lazy-loads only the senders of its last few messages, so the
   * event itself is the one full list.
   */
  readonly #typingIds = new Map<string, readonly string[]>()
  /** Rooms whose `m.typing` this store reads (see #readTyping). */
  readonly #typingRead = new WeakSet<Room>()
  /** A typing list changed since the last rebuild: the snapshot is new, the timelines are not. */
  #typingChanged = false
  readonly #online = new Set<string>()
  readonly #rosters = new Map<string, readonly MemberView[]>()
  #presenceSeen = false
  #presenceChanged = false
  /** When the member's last « typing » notice went to each room it still stands in. */
  readonly #typingSent = new Map<string, number>()
  /** `m.direct` changed since the last rebuild: the direct conversations are read again. */
  #directsChanged = false
  #directs: { snapshot: EspaceSnapshot; list: readonly DirectSummary[] } | null = null

  constructor(session: EspaceSession, base: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.#accessToken = session.accessToken
    this.#refreshToken = session.refreshToken
    this.#refresh = session.refresh
    this.#me = session.userId
    const server = session.userId.slice(session.userId.indexOf(':') + 1)
    this.#services = new Set(SERVICE_LOCALPARTS.map((localpart) => `@${localpart}:${server}`))
    this.#client = createClient({
      baseUrl: session.baseUrl,
      userId: session.userId,
      deviceId: session.deviceId,
      accessToken: this.#accessToken,
      // In memory: the SDK's default store writes to localStorage.
      store: new MemoryStore(),
      // The SDK is never handed the refresh token (see refresh.ts).
      fetchFn:
        this.#refresh === undefined || this.#refreshToken === undefined
          ? base
          : refreshingFetch(base, {
              current: () => this.#accessToken,
              refresh: () => this.#renew(),
            }),
    })
    clients.set(this, this.#client)
  }

  /**
   * Buys and installs the next access token, once however many callers ask together: Synapse
   * rotates the refresh token, so two refreshes at once would spend it twice and end the session.
   */
  #renew(): Promise<string> {
    const refresh = this.#refresh
    const refreshToken = this.#refreshToken
    // A stopped store starts no renewal: a store started since may hold this refresh token, and
    // buying with it would leave that one a spent token. (One already on its way still finishes.)
    if (this.#stopped || refresh === undefined || refreshToken === undefined) {
      return Promise.reject(new NotRenewable())
    }
    this.#renewing ??= this.#buy(refresh, refreshToken).finally(() => {
      this.#renewing = null
    })
    return this.#renewing
  }

  async #buy(
    refresh: NonNullable<EspaceSession['refresh']>,
    refreshToken: string
  ): Promise<string> {
    try {
      const next = await refresh(refreshToken)
      this.#accessToken = next.accessToken
      this.#refreshToken = next.refreshToken ?? this.#refreshToken
      this.#client.setAccessToken(this.#accessToken)
      return this.#accessToken
    } catch (error) {
      if (error instanceof RefreshRefused) {
        this.stop('signed-out')
      }
      throw error
    }
  }

  /**
   * The member's access token in use now. The room-access call on the homeserver's origin
   * (messaging-pilot design §2.7) carries it; nothing else outside this folder needs it.
   */
  accessToken = (): string => this.#accessToken

  /**
   * The access token to use after `stale` was refused: the one bought since, or a new one. Rejects
   * with `RefreshRefused` when the session is over, `NotRenewable` when it has no refresh token or the
   * store is stopped,
   * and anything else when the homeserver could not be asked.
   */
  renewAccessToken = (stale: string): Promise<string> =>
    stale === this.#accessToken ? this.#renew() : Promise.resolve(this.#accessToken)

  /** Starts syncing, once. Workspace channels are not end-to-end encrypted (design §2.5): no crypto. */
  start(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error('This Espace store was stopped.'))
    this.#starting ??= this.#begin()
    return this.#starting
  }

  async #begin(): Promise<void> {
    const emitter = this.#client as unknown as {
      on: (event: string, handler: (...args: never[]) => void) => void
      off: (event: string, handler: (...args: never[]) => void) => void
    }
    const on = (event: string, handler: (...args: never[]) => void) => {
      emitter.on(event, handler)
      this.#detach.push(() => emitter.off(event, handler))
    }
    const touch = (room?: Room | null) => {
      if (room) this.#dirty.add(room.roomId)
      this.#schedule()
    }
    on(ClientEvent.Event, (event: MatrixEvent) => {
      if (this.#stopped || event.getType() !== 'm.presence') return
      const userId = event.getSender()
      if (typeof userId !== 'string') return
      const content = event.getContent()
      this.#presenceSeen = true
      if (
        content.presence !== 'offline' &&
        content.presence !== 'unavailable' &&
        (content.presence === 'online' || content.currently_active === true)
      )
        this.#online.add(userId)
      else this.#online.delete(userId)
      this.#presenceChanged = true
      this.#schedule()
    })
    on(ClientEvent.AccountData, (event: MatrixEvent) => {
      if (this.#stopped || event.getType() !== 'm.direct') return
      this.#directsChanged = true
      this.#schedule()
    })
    on(ClientEvent.Sync, (state: SyncState) => {
      this.#status = this.#statusOf(state)
      // The first full sync: every room is new.
      if (state === SyncState.Prepared) {
        for (const room of this.#client.getRooms()) this.#dirty.add(room.roomId)
      }
      this.#schedule()
    })
    on(ClientEvent.Room, (room: Room) => {
      this.#readTyping(room)
      touch(room)
    })
    on(RoomEvent.Timeline, (_event: MatrixEvent, room: Room | undefined) => touch(room))
    on(RoomEvent.LocalEchoUpdated, (_event: MatrixEvent, room: Room) => touch(room))
    on(RoomEvent.Redaction, (_event: MatrixEvent, room: Room) => touch(room))
    on(RoomEvent.Receipt, (_event: MatrixEvent, room: Room) => touch(room))
    on(RoomEvent.Name, (room: Room) => touch(room))
    on(RoomEvent.MyMembership, (room: Room) => touch(room))
    on(RoomStateEvent.Events, (_event: MatrixEvent, state: RoomState) =>
      touch(this.#client.getRoom(state.roomId))
    )
    on(HttpApiEvent.SessionLoggedOut, () => this.stop('signed-out'))
    await this.#client.startClient({
      initialSyncLimit: 50,
      lazyLoadMembers: true,
      pendingEventOrdering: PendingEventOrdering.Detached,
    })
    this.#started = true
    // Stopped while starting (React mounts, unmounts and remounts an effect): only now has the
    // client a sync to stop.
    if (this.#stopped) this.#halt()
  }

  #halt(): void {
    const finish = () => {
      this.#client.stopClient()
      for (const detach of this.#detach.splice(0)) detach()
    }
    // startClient returns before the first /sync answers, and matrix-js-sdk 43 leaves that
    // request's abort unhandled. So a stop in between waits for the answer, or a few seconds
    // when it never comes (the homeserver unreachable).
    if (!this.#started || this.#client.getSyncState() !== null) return finish()
    const client = this.#client as unknown as {
      once: (event: string, handler: () => void) => void
      off: (event: string, handler: () => void) => void
    }
    let done = false
    const once = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      client.off(ClientEvent.Sync, once)
      finish()
    }
    const timer = setTimeout(once, FIRST_SYNC_WAIT_MS)
    client.once(ClientEvent.Sync, once)
  }

  stop(status: SyncStatus = 'stopped'): void {
    if (this.#stopped) return
    // The view going, another organisation or a new session: the others stop seeing the member
    // type. A signed-out session has no token left to say it with.
    if (status !== 'signed-out') {
      for (const roomId of this.#typingSent.keys()) {
        this.#client.sendTyping(roomId, false, TYPING_TIMEOUT_MS).catch(() => undefined)
      }
    }
    this.#stopped = true
    // While starting, the end of the start halts; a start that failed has no sync to stop.
    if (this.#starting === null || this.#started) this.#halt()
    else this.#starting.catch(() => this.#halt())
    if (status === 'signed-out') {
      clearMatrixSession()
    }
    for (const timer of this.#askAgain.values()) clearTimeout(timer)
    this.#askAgain.clear()
    this.#status = status
    this.#snapshot = { ...this.#snapshot, status }
    this.#emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): EspaceSnapshot => this.#snapshot

  getUserId = (): string => this.#me

  /** One room's messages, oldest first; the same array until one of them changes. */
  getTimeline = (roomId: string): readonly MessageView[] => this.#timelines.get(roomId) ?? NONE

  /** How far back one room's timeline reaches; it changes with the snapshot, as messages do. */
  getHistory = (roomId: string): History => this.#histories.get(roomId) ?? 'more'

  /**
   * The event the member has read up to in the room: its fully-read marker (`m.fully_read`
   * room account data), which `markRead` moves. It can be any event, a reaction or a member
   * joining as well as a message: `firstShownAfter` says where the unread messages start. None
   * for a room never read, or not known.
   */
  getReadMarker = (roomId: string): string | null => {
    const marker = this.#client
      .getRoom(roomId)
      ?.getAccountData('m.fully_read')
      ?.getContent<{ event_id?: unknown }>().event_id
    return typeof marker === 'string' ? marker : null
  }

  /**
   * The first message the log shows after an event, in the room's own order: where the unread
   * messages start when the member has read up to that event. The event itself may be one the
   * log leaves out (a reaction, an edit, a thread reply, a member joining). None while the event
   * is older than the loaded ones (older messages may bring it in), or when no shown message
   * follows it.
   */
  firstShownAfter = (roomId: string, eventId: string): string | null => {
    const events = this.#client.getRoom(roomId)?.getLiveTimeline().getEvents() ?? []
    const at = events.findIndex((event) => event.getId() === eventId)
    if (at === -1) return null
    const shown = new Set(this.getTimeline(roomId).map((message) => message.eventId))
    for (const event of events.slice(at + 1)) {
      const id = event.getId()
      if (id !== undefined && shown.has(id)) return id
    }
    return null
  }

  /** One thread's replies, oldest first; the same array until one of them changes. */
  getThread = (roomId: string, rootEventId: string): readonly MessageView[] => {
    const byRoom = this.#threads.get(roomId)
    const cached = byRoom?.get(rootEventId)
    if (cached !== undefined) return cached
    const events = this.#eventsByRoom.get(roomId)
    if (events === undefined) return NONE
    const computed = threadView(events, rootEventId, this.#me)
    if (computed.length === 0) return NONE
    let map = byRoom
    if (map === undefined) {
      map = new Map()
      this.#threads.set(roomId, map)
    }
    map.set(rootEventId, computed)
    return computed
  }

  #statusOf(state: SyncState | null): SyncStatus {
    switch (state) {
      case SyncState.Prepared:
      case SyncState.Syncing:
      case SyncState.Catchup:
        return 'live'
      // The SDK keeps retrying from an error: the screen says it is reconnecting.
      case SyncState.Reconnecting:
      case SyncState.Error:
        return 'reconnecting'
      case SyncState.Stopped:
        return 'stopped'
      default:
        return 'starting'
    }
  }

  #schedule(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      this.#rebuild()
    })
  }

  #rebuild(): void {
    const all = this.#client.getRooms().filter((room) => !room.isSpaceRoom())
    // getSnapshot is also the subscription token for the timeline and thread getters.
    // A room's messages can change without changing its sidebar summary: publishing only
    // the latter leaves useSyncExternalStore's readers on the previous message content.
    let messageDataChanged = false
    for (const roomId of this.#dirty) {
      const room = this.#client.getRoom(roomId)
      if (room === null || room.getMyMembership() !== 'join') {
        // Nothing of the room's typing reaches a member out of it: back in, no one is typing
        // until its next `m.typing` says who is. (A room still being set up was never joined.)
        if (this.#timelines.has(roomId)) this.#typingIds.set(roomId, [])
        messageDataChanged ||=
          this.#timelines.has(roomId) || this.#threads.has(roomId) || this.#eventsByRoom.has(roomId)
        this.#timelines.delete(roomId)
        this.#threads.delete(roomId)
        this.#eventsByRoom.delete(roomId)
        this.#histories.delete(roomId)
        this.#members.delete(roomId)
        continue
      }
      messageDataChanged = true
      const events = this.#events(room)
      this.#eventsByRoom.set(roomId, events)
      this.#histories.set(roomId, this.#historyOf(room))
      const next = timelineView(events, this.#me)
      this.#timelines.set(
        roomId,
        reuse(this.#timelines.get(roomId), next, (m) => m.key)
      )
      const prevThreads = this.#threads.get(roomId)
      const nextThreads = new Map<string, readonly MessageView[]>()
      for (const msg of next) {
        const replies = threadView(events, msg.eventId, this.#me)
        if (replies.length > 0 || prevThreads?.has(msg.eventId)) {
          nextThreads.set(
            msg.eventId,
            reuse(prevThreads?.get(msg.eventId), replies, (m) => m.key)
          )
        }
      }
      this.#threads.set(roomId, nextThreads)
    }
    this.#dirty.clear()
    // Summaries are cheap; unread counts arrive with every sync, so all are recomputed and the
    // unchanged ones reused.
    const rooms = reuse(
      this.#snapshot.rooms,
      all
        .filter((room) => room.getMyMembership() === 'join')
        .map((room) => this.#summary(room))
        .sort((a, b) => a.name.localeCompare(b.name)),
      (r) => r.roomId
    )
    const invites = reuse(
      this.#snapshot.invites,
      all
        .filter((room) => room.getMyMembership() === 'invite')
        .map((room) => ({
          roomId: room.roomId,
          name: room.name,
          inviter: room.currentState.getMember(this.#me)?.events.member?.getSender() ?? null,
        })),
      (r) => r.roomId
    )
    const status = this.#stopped ? this.#snapshot.status : this.#status
    if (status === 'live') this.#recheck(rooms, invites)
    const typingChanged = this.#typingChanged
    this.#typingChanged = false
    const directsChanged = this.#directsChanged
    this.#directsChanged = false
    if (
      messageDataChanged ||
      typingChanged ||
      directsChanged ||
      this.#presenceChanged ||
      rooms !== this.#snapshot.rooms ||
      invites !== this.#snapshot.invites ||
      status !== this.#snapshot.status
    ) {
      this.#snapshot = { ...this.#snapshot, status, rooms, invites }
    }
    this.#presenceChanged = false
    // A timeline may have changed even when the summary did not.
    this.#emit()
  }

  #summary(room: Room): RoomSummary {
    const policy = room.currentState.getStateEvents(POLICY, '')?.getContent() as
      { kind?: unknown } | undefined
    const kind = policy?.kind === 'audio' ? 'audio' : 'text'
    const occupancy =
      kind === 'audio'
        ? occupancyOf(room.currentState.getStateEvents(OCCUPANCY, '')?.getContent())
        : null
    const names: Record<string, string> = {}
    for (const userId of occupancy?.participants ?? []) {
      const name = displayName(room, userId)
      if (name !== undefined) names[userId] = name
      // Someone in the call who never wrote here is not among the lazy-loaded members.
      else if (room.getMember(userId) === null) this.loadMembers(room.roomId)
    }
    return {
      roomId: room.roomId,
      name: room.name,
      alias: room.getCanonicalAlias(),
      kind,
      unread: room.getUnreadNotificationCount(NotificationCountType.Total),
      mentions: room.getUnreadNotificationCount(NotificationCountType.Highlight),
      occupancy,
      names,
      ...(kind === 'text'
        ? { joined: this.#peopleCount(room), faces: this.#headerFaces(room) }
        : {}),
    }
  }

  /** The room's joined count, Kodera's own accounts taken out of it. */
  #peopleCount(room: Room): number {
    const count = room.getJoinedMemberCount()
    const loaded = room.getJoinedMembers()
    let services = loaded.filter((member) => this.#services.has(member.userId)).length
    // A count above the loaded members is the homeserver's, and it holds the tenant agent that
    // created the room even while the agent's member event is not loaded.
    const creator = room.getCreator()
    if (
      count > loaded.length &&
      creator !== null &&
      this.#services.has(creator) &&
      room.getMember(creator) === null
    )
      services += 1
    return count - services
  }

  /**
   * The faces beside a channel's member count (`RoomSummary.faces`): the latest people to write in
   * the room's loaded log, then other joined members by name until there are three. A channel where
   * only the member has written still shows who else is in it, once `loadMembers` has brought
   * the members the first sync did not lazy-load.
   */
  #headerFaces(room: Room): MemberView[] {
    const faces = this.#latestWriters(room)
    if (faces.length >= HEADER_FACES) return faces
    const shown = new Set(faces.map((face) => face.userId))
    for (const member of this.#joinedOthers(room)) {
      if (faces.length >= HEADER_FACES) break
      if (shown.has(member.userId)) continue
      faces.push(faceOf(room, member.userId))
    }
    return faces
  }

  /** The latest people to write in the room's loaded log, still in it. */
  #latestWriters(room: Room): MemberView[] {
    const faces: MemberView[] = []
    const seen = new Set<string>()
    const events = room.getLiveTimeline().getEvents()
    for (let index = events.length - 1; index >= 0 && faces.length < HEADER_FACES; index -= 1) {
      const event = events[index]
      const sender = event?.getSender()
      if (event?.getType() !== EventType.RoomMessage || sender === undefined || seen.has(sender))
        continue
      seen.add(sender)
      if (sender === this.#me || this.#services.has(sender)) continue
      if (room.getMember(sender)?.membership !== 'join') continue
      faces.push(faceOf(room, sender))
    }
    return faces
  }

  #historyOf(room: Room): History {
    const paging = this.#paging.get(room.roomId)
    if (paging !== undefined) return paging
    // The homeserver has no older page, or the room's creation is already in the timeline: a
    // small room's whole history fits the first sync, and asking for more would only say so.
    if (room.oldState.paginationToken === null) return 'start'
    const first = room.getLiveTimeline().getEvents()[0]
    return first?.getType() === 'm.room.create' ? 'start' : 'more'
  }

  /**
   * Loads the room's whole member list, once, so that members who never wrote in it have their
   * names too. A failure lets a later call ask again.
   */
  loadMembers = (roomId: string): void => {
    const room = this.#client.getRoom(roomId)
    if (room === null || this.#membersAsked.has(roomId)) return
    this.#membersAsked.add(roomId)
    room.loadMembersIfNeeded().then(
      () => {
        this.#dirty.add(roomId)
        this.#schedule()
      },
      () => this.#membersAsked.delete(roomId)
    )
  }

  /** The room's loaded joined members but the signed-in one and Kodera's own accounts, named,
   * sorted by name. */
  #joinedOthers(room: Room): MemberView[] {
    return room
      .getJoinedMembers()
      .filter((member) => member.userId !== this.#me && !this.#services.has(member.userId))
      .map((member): MemberView => {
        const name = displayName(room, member.userId)
        return name === undefined ? { userId: member.userId } : { userId: member.userId, name }
      })
      .sort((a, b) => (a.name ?? a.userId).localeCompare(b.name ?? b.userId))
  }

  /** The panel's joined human roster includes the viewer; mention suggestions do not. */
  getRoster = (roomId: string): readonly MemberView[] => {
    const room = this.#client.getRoom(roomId)
    if (room === null || room.getMyMembership() !== 'join') return NO_MEMBERS
    const next = room
      .getJoinedMembers()
      .filter((member) => !this.#services.has(member.userId))
      .map((member) => faceOf(room, member.userId))
      .sort((a, b) => (a.name ?? a.userId).localeCompare(b.name ?? b.userId))
    const roster = reuse(this.#rosters.get(roomId), next, (member) => member.userId)
    this.#rosters.set(roomId, roster)
    return roster
  }

  getMemberRole = (roomId: string, userId: string): 'admin' | 'member' => {
    const room = this.#client.getRoom(roomId)
    const powers = room?.currentState.getStateEvents('m.room.power_levels', '')?.getContent()
    const level: unknown = powers?.users?.[userId] ?? powers?.users_default ?? 0
    return typeof level === 'number' && level >= 50 ? 'admin' : 'member'
  }

  /** Sync events only: no extra request, and no stale presence from an earlier session. */
  isOnline = (userId: string): boolean =>
    !this.#stopped && this.#presenceSeen && this.#online.has(userId)

  /**
   * The room's joined members but the signed-in one, by name: whom the composer offers to
   * mention. The same array until one of them changes; until `loadMembers` answers, only the
   * members the sync brought.
   */
  getMembers = (roomId: string): readonly MemberView[] => {
    const room = this.#client.getRoom(roomId)
    if (room === null || room.getMyMembership() !== 'join') return NO_MEMBERS
    const next = this.#joinedOthers(room)
    const previous = this.#members.get(roomId)
    if (previous !== undefined && same(previous, next)) return previous
    this.#members.set(roomId, next)
    return next
  }

  /**
   * The room's members typing now, but the signed-in one, by name: the typing line under the log
   * (gap report G9). The same array until one of them changes. A member is typing from the
   * homeserver's `m.typing` until it says otherwise, or its own timeout runs out; one the client
   * has not loaded yet is named by id, as their messages would be.
   */
  getTyping = (roomId: string): readonly MemberView[] => {
    const room = this.#client.getRoom(roomId)
    if (room === null || room.getMyMembership() !== 'join') return NO_MEMBERS
    const ids =
      this.#typingIds.get(roomId) ??
      room
        .getJoinedMembers()
        .filter((member) => member.typing)
        .map((member) => member.userId)
    const next = ids
      .filter((userId) => userId !== this.#me)
      .map((userId): MemberView => {
        const name = displayName(room, userId)
        return name === undefined ? { userId } : { userId, name }
      })
      .sort((a, b) => (a.name ?? a.userId).localeCompare(b.name ?? b.userId))
    const previous = this.#typing.get(roomId)
    if (previous !== undefined && same(previous, next)) return previous
    this.#typing.set(roomId, next)
    return next
  }

  /**
   * Reads the room's `m.typing` as the sync hands it over. The SDK keeps no list of its own: it
   * flags the members it has loaded and drops the rest, and the event it re-emits carries no room
   * id. So the room's own handler is wrapped, once, for as long as the store runs.
   */
  #readTyping(room: Room): void {
    if (this.#typingRead.has(room)) return
    this.#typingRead.add(room)
    const target = room as unknown as { addEphemeralEvents: (events: MatrixEvent[]) => void }
    const original = target.addEphemeralEvents
    target.addEphemeralEvents = (events: MatrixEvent[]) => {
      original.call(room, events)
      for (const event of events) {
        if (event.getType() !== EventType.Typing) continue
        const ids: unknown = event.getContent().user_ids
        if (!Array.isArray(ids)) continue
        this.#typingIds.set(
          room.roomId,
          ids.filter((id): id is string => typeof id === 'string')
        )
        this.#typingMoved()
      }
    }
    this.#detach.push(() => {
      target.addEphemeralEvents = original
    })
  }

  /** Someone started or stopped typing: a new snapshot, without rebuilding any timeline. */
  #typingMoved(): void {
    this.#typingChanged = true
    this.#schedule()
  }

  /**
   * Tells the room the member is typing, or no longer is. A « typing » notice lasts
   * `TYPING_TIMEOUT_MS` and is sent again at most every `TYPING_RESEND_MS`, so a keystroke is not
   * a request; « no longer » goes only after a « typing » that still stands. The notice is a
   * courtesy to the others: one the homeserver refuses changes nothing the member does, so its
   * failure is not shown.
   */
  setTyping = (roomId: string, typing: boolean, now = Date.now()): void => {
    if (this.#stopped) return
    const sent = this.#typingSent.get(roomId)
    if (typing) {
      if (sent !== undefined && now - sent < TYPING_RESEND_MS) return
      this.#typingSent.set(roomId, now)
    } else {
      if (sent === undefined) return
      this.#typingSent.delete(roomId)
    }
    this.#client.sendTyping(roomId, typing, TYPING_TIMEOUT_MS).catch(() => undefined)
  }

  /** The live timeline then this device's unsent events, as Matrix events plus what this device knows. */
  #events(room: Room): TimelineEvent[] {
    return [...room.getLiveTimeline().getEvents(), ...room.getPendingEvents()].map((event) => {
      const id = event.getId() ?? ''
      const content = event.getOriginalContent() as Record<string, unknown>
      const relation = relationOf(content)
      if (relation !== null && !event.isRedacted()) this.#relations.set(id, relation)
      const remembered = event.isRedacted() ? this.#relations.get(id) : undefined
      const local =
        event.status === EventStatus.NOT_SENT
          ? ('failed' as const)
          : event.status !== null
            ? ('pending' as const)
            : undefined
      const txn = event.getTxnId() ?? (event.getUnsigned().transaction_id as string | undefined)
      const senderName = displayName(room, event.getSender() ?? '')
      return {
        event_id: id,
        type: event.getType(),
        sender: event.getSender() ?? '',
        origin_server_ts: event.getTs(),
        content: remembered === undefined ? content : { 'm.relates_to': remembered },
        unsigned: event.isRedacted()
          ? { redacted_because: event.getUnsigned().redacted_because ?? {} }
          : {},
        ...(txn === undefined ? {} : { key: txn }),
        ...(local === undefined ? {} : { local }),
        ...(senderName === undefined ? {} : { sender_name: senderName }),
      }
    })
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }

  /**
   * A room the directory gave that a live sync does not know (neither joined nor invited) may
   * have been replaced under the alias: the alias is asked once more, once per disappearance.
   */
  #recheck(rooms: readonly RoomSummary[], invites: readonly InviteView[]): void {
    const known = new Set([...rooms, ...invites].map((room) => room.roomId))
    for (const [channelId, { room }] of this.#lookups) {
      if (room.state !== 'resolved') continue
      if (known.has(room.roomId)) {
        this.#rechecked.delete(channelId)
        continue
      }
      if (this.#rechecked.has(channelId)) continue
      this.#rechecked.add(channelId)
      this.#lookups.delete(channelId)
      if (this.#watched.has(channelId)) void this.#lookUp(channelId)
    }
  }

  /**
   * Finds the rooms of these channels by their alias, `#kodera-ch-{channel id}:{server name}`, in
   * the room directory (Core contract 0.25.2); the snapshot's `channels` follows. A client never
   * matches a room by its name. A room found is kept for the store's life; a 404 stands for a
   * short while, and a failure not at all. The channels left out of a later call are not asked
   * again. Settles once every lookup this call started has answered.
   */
  resolveChannels = async (channelIds: readonly string[]): Promise<void> => {
    if (this.#stopped) return
    this.#watched = new Set(channelIds)
    for (const [channelId, timer] of this.#askAgain) {
      if (!this.#watched.has(channelId)) {
        clearTimeout(timer)
        this.#askAgain.delete(channelId)
      }
    }
    for (const channelId of this.#misses.keys()) {
      if (!this.#watched.has(channelId)) this.#misses.delete(channelId)
    }
    await Promise.all([...this.#watched].map((channelId) => this.#lookUp(channelId)))
  }

  /**
   * @param due asked by the timer `#later` set: the answer kept is due, whatever the wall clock
   *   says (a clock stepped back, or a timer firing a little early, would otherwise stall it)
   */
  #lookUp(channelId: string, due = false): Promise<void> {
    const asking = this.#asking.get(channelId)
    if (asking !== undefined) return asking
    if (this.#stopped) return Promise.resolve()
    const known = this.#lookups.get(channelId)
    if (!due && known !== undefined && known.until > Date.now()) {
      // A 404 still standing: asked again when it ages, as every watched pending channel is.
      if (known.room.state === 'pending')
        this.#later(channelId, Math.min(known.until - Date.now(), PENDING_AT_MOST_MS))
      return Promise.resolve()
    }
    const alias = this.#aliasOf(channelId)
    if (alias === undefined) return Promise.resolve()
    // Asked now: a later ask already planned would only repeat this one.
    clearTimeout(this.#askAgain.get(channelId))
    this.#askAgain.delete(channelId)
    const lookup = this.#ask(channelId, alias).finally(() => this.#asking.delete(channelId))
    this.#asking.set(channelId, lookup)
    return lookup
  }

  async #ask(channelId: string, alias: string): Promise<void> {
    let room: ChannelRoom | null
    try {
      const answer = (await this.#client.getRoomIdForAlias(alias)) as { room_id?: unknown }
      room =
        typeof answer.room_id === 'string' && answer.room_id.startsWith('!')
          ? { state: 'resolved', roomId: answer.room_id }
          : null
    } catch (error) {
      // The directory's own 404: anything else (a proxy's 404 page among them) is a failure.
      room =
        error instanceof MatrixError && error.httpStatus === 404 && error.errcode === 'M_NOT_FOUND'
          ? { state: 'pending' }
          : null
    }
    if (this.#stopped) return
    let misses = 0
    if (room?.state === 'resolved' || !this.#watched.has(channelId)) {
      // Found, or no longer watched (it starts over if watched again).
      this.#misses.delete(channelId)
    } else {
      const kind = room === null ? 'failure' : 'pending'
      const before = this.#misses.get(channelId)
      misses = before?.kind === kind ? before.count + 1 : 1
      this.#misses.set(channelId, { kind, count: misses })
    }
    if (room === null) {
      // Nothing is kept: the next ask goes to the homeserver.
      this.#lookups.delete(channelId)
      this.#later(channelId, backoff(RETRY_AFTER_MS, RETRY_AT_MOST_MS, misses))
      return
    }
    const resolved = room.state === 'resolved'
    const wait = resolved ? 0 : backoff(PENDING_FOR_MS, PENDING_AT_MOST_MS, misses)
    this.#lookups.set(channelId, {
      room,
      until: resolved ? Number.POSITIVE_INFINITY : Date.now() + wait,
    })
    if (!resolved) this.#later(channelId, wait)
    const current = this.#snapshot.channels.get(channelId)
    if (current !== undefined && same(current, room)) return
    const channels = new Map(this.#snapshot.channels)
    channels.set(channelId, room)
    this.#snapshot = { ...this.#snapshot, channels }
    this.#emit()
  }

  /** Asks for a watched channel's room again after `ms`. */
  #later(channelId: string, ms: number): void {
    if (this.#stopped || !this.#watched.has(channelId) || this.#askAgain.has(channelId)) return
    this.#askAgain.set(
      channelId,
      setTimeout(
        () => {
          this.#askAgain.delete(channelId)
          if (this.#watched.has(channelId)) void this.#lookUp(channelId, true)
        },
        Math.max(0, ms)
      )
    )
  }

  /**
   * The channel's alias on the member's own server (signed in as `@{sub}:{server name}`), or
   * undefined, said once per channel: a channel id Core should never send, or a session without
   * a server name, is a regression to see, not to swallow.
   */
  #aliasOf(channelId: string): string | undefined {
    const serverName = serverNameOf(this.#me)
    const alias = serverName === undefined ? undefined : channelRoomAlias(channelId, serverName)
    if (alias === undefined && !this.#warned.has(channelId)) {
      this.#warned.add(channelId)
      console.warn(
        isChannelId(channelId)
          ? `Espace: the session's user ID carries no usable server name; channel ${channelId} cannot be looked up.`
          : `Espace: channel id ${JSON.stringify(channelId)} is not a lower-case UUID; its room is not looked up.`
      )
    }
    return alias
  }

  async send(roomId: string, body: string, options: SendOptions = {}): Promise<void> {
    const relatesTo =
      options.threadRootId !== undefined
        ? {
            rel_type: 'm.thread',
            event_id: options.threadRootId,
            is_falling_back: options.replyTo === undefined,
            'm.in_reply_to': { event_id: options.replyTo ?? options.threadRootId },
          }
        : options.replyTo !== undefined
          ? {
              'm.in_reply_to': { event_id: options.replyTo },
            }
          : undefined
    const attachments = options.attachments ?? []
    await this.#client.sendMessage(roomId, {
      msgtype: MsgType.Text,
      // Other clients show the files' names when the message has no text of its own.
      body: body === '' && attachments.length > 0 ? attachmentsFallback(attachments) : body,
      ...(attachments.length === 0 ? {} : { [ATTACHMENTS_FIELD]: attachments }),
      ...(options.mentions === undefined ? {} : { 'm.mentions': { user_ids: options.mentions } }),
      ...(relatesTo === undefined ? {} : { 'm.relates_to': relatesTo }),
    } as never)
  }

  async edit(roomId: string, eventId: string, body: string): Promise<void> {
    await this.#client.sendMessage(roomId, {
      msgtype: MsgType.Text,
      body: `* ${body}`,
      'm.new_content': { msgtype: MsgType.Text, body },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    } as never)
  }

  async remove(roomId: string, eventId: string): Promise<void> {
    await this.#client.redactEvent(roomId, eventId)
  }

  async react(roomId: string, eventId: string, key: string): Promise<void> {
    await this.#client.sendEvent(
      roomId,
      'm.reaction' as never,
      {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
      } as never
    )
  }

  async unreact(roomId: string, eventId: string, key: string): Promise<void> {
    const room = this.#client.getRoom(roomId)
    if (room === null) return
    const match = [...room.getLiveTimeline().getEvents(), ...room.getPendingEvents()].find(
      (event) => {
        if (event.getType() !== 'm.reaction' || event.isRedacted()) return false
        if (event.getSender() !== this.#me) return false
        const relates = (event.getOriginalContent() as Record<string, unknown>)['m.relates_to'] as
          { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined
        return (
          relates?.rel_type === 'm.annotation' &&
          relates.event_id === eventId &&
          relates.key === key
        )
      }
    )
    const reactionId = match?.getId()
    if (reactionId !== undefined) {
      await this.#client.redactEvent(roomId, reactionId)
    }
  }

  async toggleReaction(roomId: string, eventId: string, key: string): Promise<void> {
    const messages = this.#timelines.get(roomId) ?? NONE
    let target = messages.find((m) => m.eventId === eventId)
    if (target === undefined) {
      for (const replies of this.#threads.get(roomId)?.values() ?? []) {
        target = replies.find((m) => m.eventId === eventId)
        if (target !== undefined) break
      }
    }
    const existing = target?.reactions.find((r) => r.key === key)
    if (existing?.mine === true) {
      await this.unreact(roomId, eventId, key)
    } else {
      await this.react(roomId, eventId, key)
    }
  }

  /**
   * The member's direct conversations, from `m.direct`, joined rooms only, by name. The same list
   * for the same snapshot, so a screen that reads it redraws only when it changes.
   */
  getDirects = (): readonly DirectSummary[] => {
    const snapshot = this.#snapshot
    if (this.#directs?.snapshot === snapshot) return this.#directs.list
    const rooms = directRooms(
      directMap(this.#client.getAccountData(EventType.Direct)?.getContent())
    )
    const list: DirectSummary[] = []
    for (const [roomId, userIds] of rooms) {
      const summary = snapshot.rooms.find((room) => room.roomId === roomId)
      const room = this.#client.getRoom(roomId)
      if (summary === undefined || room === null) continue
      const names = userIds.map((userId) => displayName(room, userId) ?? userId)
      list.push({ roomId, userIds, name: names.join(', '), unread: summary.unread })
    }
    list.sort((a, b) => a.name.localeCompare(b.name))
    const previous = this.#directs?.list
    const same =
      previous !== undefined &&
      previous.length === list.length &&
      previous.every(
        (item, at) =>
          item.roomId === list[at]!.roomId &&
          item.name === list[at]!.name &&
          item.unread === list[at]!.unread
      )
    this.#directs = { snapshot, list: same ? previous : list }
    return this.#directs.list
  }

  /**
   * The direct conversation with these people: the joined one already held, else a new private
   * room, invited and listed in `m.direct` under each of them. Resolves to its room id.
   */
  async openDirect(userIds: readonly string[]): Promise<string> {
    if (this.#stopped) throw new Error('Espace is stopped')
    const people = directPeople(userIds, this.#me)
    const map = directMap(this.#client.getAccountData(EventType.Direct)?.getContent())
    const held = existingDirect(
      directRooms(map),
      people,
      (roomId) => this.#client.getRoom(roomId)?.getMyMembership() === 'join'
    )
    if (held !== undefined) return held
    const { room_id: roomId } = await this.#client.createRoom({
      is_direct: true,
      invite: people,
      preset: Preset.TrustedPrivateChat,
      visibility: Visibility.Private,
    })
    await this.#client.setAccountData(EventType.Direct, withDirect(map, roomId, people) as never)
    return roomId
  }

  async inviteToRoom(roomId: string, userId: string): Promise<void> {
    if (!isMatrixUserId(userId)) throw new Error('Invalid Matrix user ID')
    await this.#client.invite(roomId, userId)
  }

  async join(roomId: string): Promise<void> {
    await this.#client.joinRoom(roomId)
  }

  /**
   * Adds the room's previous page of events to its timeline, once however many callers ask
   * together. A failure is kept in `getHistory` for the screen to offer again; the SDK
   * itself waits a few seconds before a new ask after one.
   */
  loadOlder = async (roomId: string): Promise<void> => {
    const room = this.#client.getRoom(roomId)
    if (room === null || this.#paging.get(roomId) === 'loading') return
    if (this.#historyOf(room) === 'start') return
    this.#paging.set(roomId, 'loading')
    this.#dirty.add(roomId)
    this.#schedule()
    try {
      await this.#client.scrollback(room, OLDER_PAGE)
      this.#paging.delete(roomId)
    } catch {
      this.#paging.set(roomId, 'failed')
    }
    this.#dirty.add(roomId)
    this.#schedule()
  }

  /** Marks everything in the room as read, up to its last event: the read receipt and the
   * fully-read marker together, as Matrix clients do on opening a room. */
  async markRead(roomId: string): Promise<void> {
    const room = this.#client.getRoom(roomId)
    const last = room
      ?.getLiveTimeline()
      .getEvents()
      .filter((event) => event.getId()?.startsWith('$'))
      .at(-1)
    const eventId = last?.getId()
    if (last === undefined || eventId === undefined) return
    await this.#client.setRoomReadMarkers(roomId, eventId, last)
  }

  #unsent(roomId: string, key: string): { room: Room; event: MatrixEvent } | null {
    const room = this.#client.getRoom(roomId)
    const event = room
      ?.getPendingEvents()
      .find((candidate) => (candidate.getTxnId() ?? candidate.getId()) === key)
    return room && event && event.status === EventStatus.NOT_SENT ? { room, event } : null
  }

  /** Sends a failed message again, by its row key. */
  async resend(roomId: string, key: string): Promise<void> {
    const unsent = this.#unsent(roomId, key)
    if (unsent !== null) await this.#client.resendEvent(unsent.event, unsent.room)
  }

  /** Drops a failed message, by its row key. */
  cancel(roomId: string, key: string): void {
    const unsent = this.#unsent(roomId, key)
    if (unsent !== null) this.#client.cancelPendingEvent(unsent.event)
  }
}

export function createEspaceStore(
  session: EspaceSession,
  base: typeof fetch = globalThis.fetch.bind(globalThis)
): EspaceStore {
  return new EspaceStore(session, base)
}
