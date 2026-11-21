// The one thin Kodera layer over matrix-js-sdk (messaging-pilot design §2.3): a later move to
// the Rust SDK touches this folder and nothing above it, and an ESLint rule keeps the SDK from
// being imported anywhere else. Screens read through `subscribe`, `getSnapshot` (the sidebar:
// one summary per room) and `getTimeline` (one room's messages), all with stable identities, so
// React re-renders only what an event changed. Tokens live in memory only (design §2.4): the
// SDK gets an in-memory store, never the browser's storage. What a room last showed is kept on
// the device (`timelineCache.ts`): sent message views only, no token, wiped at sign-out.

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
  HistoryVisibility,
  HttpApiEvent,
  MatrixError,
  MemoryStore,
  Method,
  MsgType,
  NotificationCountType,
  Preset,
  PushRuleKind,
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
import { track } from '../../../analytics/track'
import { clearMatrixSession } from '@/auth/matrix'
import { cleanText } from '../../../ui/safeText'
import { AVATAR_TYPES, inspectRasterImage, MAX_AVATAR_BYTES } from '../../profile/avatarImage'
import { channelRoomAlias, isChannelId, serverNameOf } from '../homeserver'
import { isNamedProfile, safeDisplayName } from '../memberName'
import { isMatrixUserId } from '../roomInvitations'
import {
  directMap,
  directPeople,
  directRooms,
  existingDirect,
  isMatrixRoomId,
  withDirect,
  type DirectSummary,
} from './directs'
import { NotRenewable, RefreshRefused, refreshingFetch } from './refresh'
export { RefreshRefused }
import {
  isValidReactionKey,
  occupancyOf,
  threadView,
  roomViews,
  type MessageView,
  type Occupancy,
  type TimelineEvent,
} from './timeline'
import { openTimelineCache, type TimelineCache } from './timelineCache'
import { AvatarCache, isMxcUrl } from './avatarCache'
import { HTML_FORMAT, markdownToHtml, type MentionTarget } from '../../messaging/markdownHtml'
import { passportOf, PASSPORT_KEY, type Passport } from '../../profile/passport'
import {
  RoomBoundaryTracker,
  ConfidentialRoomUnavailable,
  permitsPlaintext,
  type RoomBoundary,
} from '../../confidential/room-boundary'

const PRE_V12_ROOM_VERSIONS: ReadonlySet<string> = new Set([
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
])

/**
 * Whether `userId` holds infinite creator authority in a Matrix Room v12+ (`m.room.create` sender
 * or `content.additional_creators`), checked directly on `m.room.create` because `matrix-js-sdk`
 * leaves `member.powerLevel` at numeric `0` until an `m.room.power_levels` state event exists.
 */
function isV12RoomCreator(room: Room | null | undefined, userId: string): boolean {
  const createEvent = room?.currentState.getStateEvents('m.room.create', '')
  if (createEvent === null || createEvent === undefined) return false
  const content = createEvent.getContent() as Record<string, unknown> | undefined
  const roomVersion =
    typeof content?.room_version === 'string' && content.room_version !== ''
      ? content.room_version
      : '1'
  if (PRE_V12_ROOM_VERSIONS.has(roomVersion)) return false
  const primaryCreator =
    createEvent.getSender() || (typeof content?.creator === 'string' ? content.creator : undefined)
  if (primaryCreator === userId) return true
  const additional = content?.additional_creators
  return (
    Array.isArray(additional) &&
    additional.some((creator) => typeof creator === 'string' && creator === userId)
  )
}

export type SyncStatus = 'starting' | 'live' | 'reconnecting' | 'signed-out' | 'stopped'

/**
 * How far back a room's timeline reaches: `more` when older messages are on the homeserver,
 * `loading` while they are asked for, `failed` when the last ask did not answer, `start` when the
 * room's first event is in the timeline.
 */
export type History = 'more' | 'loading' | 'failed' | 'start'

export interface SendOptions {
  mentions?: string[]
  /** The message names the whole room (« @salon »): `m.mentions.room`. */
  mentionsRoom?: boolean
  /** The named members as the text writes them, linked as pills in the message's HTML. */
  mentionTargets?: readonly MentionTarget[]
  replyTo?: string
  threadRootId?: string
  /** Files already stored by Core, named by id (docs/specs/messaging-media-and-notifications.md). */
  attachments?: AttachmentRef[]
}

/** What an edit names, read from its new text as `SendOptions` reads a message's. */
export type EditOptions = Pick<SendOptions, 'mentions' | 'mentionsRoom' | 'mentionTargets'>

/** A joined room, as the sidebar draws it. */
export interface RoomSummary {
  roomId: string
  name: string
  /** The canonical alias, for display only: a channel's room is found by `channels`, never by this. */
  alias: string | null
  /** Transport classification; only authenticated room decryption can establish confidentiality. */
  confidentiality?: RoomBoundary
  /** Text channel or audio room, from the room's `io.kodera.room.policy` (design §2.1). */
  kind: 'text' | 'audio'
  unread: number
  mentions: number
  /** Who is in an audio room, and who shares a screen; null for a text channel or no data. */
  occupancy: Occupancy | null
  /** The display names of the audio room's occupants that have one, by Matrix user id. */
  names?: Readonly<Record<string, string>>
  /** The avatars of the audio room's occupants that have one, `mxc://` addresses by user id. */
  avatars?: Readonly<Record<string, string>>
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
  /** The member's avatar in the room, an `mxc://` address (`avatarCache.ts` draws it). */
  avatarMxc?: string
}

/** A newcomer's arrival in a room: their join event, when, who they are, and whether waved at. */
export interface ArrivalView extends MemberView {
  eventId: string
  ts: number
  /** The signed-in member already sent a 👋 reaction on this join event. */
  waved?: boolean
}

export interface InviteView {
  roomId: string
  name: string
  inviter: string | null
  /** Invitation metadata only; never establishes room protection. */
  direct?: boolean
}

/**
 * A channel's room, as the room directory answers for the channel's alias (Core contract 0.25.2).
 * A channel the map does not hold is not resolved yet: not usable either.
 */
export type ChannelRoom =
  | { state: 'resolved'; roomId: string }
  /** The directory has no room under the alias (a 404): the room does not exist yet. */
  | { state: 'pending' }

export type RoomJoinState = 'joining' | 'refused'

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
const NO_PINS: readonly string[] = Object.freeze([])

/** The room's pinned events (`m.room.pinned_events`), in the order the room keeps them. */
export function pinnedOf(content: unknown): readonly string[] {
  if (content === null || typeof content !== 'object') return NO_PINS
  const pinned = (content as { pinned?: unknown }).pinned
  if (!Array.isArray(pinned)) return NO_PINS
  const ids = pinned.filter((id): id is string => typeof id === 'string' && id.startsWith('$'))
  return ids.length === 0 ? NO_PINS : [...new Set(ids)]
}
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
function backoff(
  first: number,
  atMost: number,
  attempts: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(atMost, first * 2 ** Math.max(0, attempts - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export { backoff }

function isJoinRefused(error: unknown): boolean {
  return (
    error instanceof MatrixError && (error.errcode === 'M_FORBIDDEN' || error.httpStatus === 403)
  )
}

function isJoinPermanentClientError(error: unknown): boolean {
  return (
    error instanceof MatrixError &&
    typeof error.httpStatus === 'number' &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500 &&
    !error.isRateLimitError()
  )
}

function rateLimitWaitMs(error: MatrixError, attempts: number): number {
  try {
    const retryAfter = error.getRetryAfterMs()
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(Math.max(100, Math.ceil(retryAfter)), RETRY_AT_MOST_MS)
    }
  } catch {
    // Fall back to `data.retry_after_ms` or standard backoff when the header/body is non-integer.
  }
  const raw = (error.data as { retry_after_ms?: unknown } | undefined)?.retry_after_ms
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.max(100, Math.ceil(raw)), RETRY_AT_MOST_MS)
  }
  return backoff(RETRY_AFTER_MS, RETRY_AT_MOST_MS, attempts)
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
  if (member === null) return undefined
  const clean = cleanText(member.rawDisplayName, 80)
  if (!isNamedProfile(clean, userId)) return undefined
  return disambiguate && member.disambiguate ? `${clean} (${userId.slice(1, 5)})` : clean
}

/**
 * A face beside a channel's count. It shows initials: the name as written, without the id that
 * tells two of it apart. A name that is only the id's localpart is no name: the homeserver gives
 * an account without one its localpart, the identity provider's subject (M1), and its first
 * character would draw a face of « 9 ». The header draws a person glyph for a face with no name.
 */
function faceOf(room: Room, userId: string): MemberView {
  return memberOf(room, userId, false)
}

/** The member's avatar in the room, when it is an address the cache resolves. */
function avatarOf(room: Room, userId: string): string | undefined {
  const mxc = room.getMember(userId)?.getMxcAvatarUrl()
  return isMxcUrl(mxc) ? mxc : undefined
}

/** A member as a screen draws them: their name in the room, when they have one, and avatar. */
function memberOf(room: Room, userId: string, disambiguate = true): MemberView {
  const name = displayName(room, userId, disambiguate)
  const avatarMxc = avatarOf(room, userId)
  return {
    userId,
    ...(name === undefined ? {} : { name }),
    ...(avatarMxc === undefined ? {} : { avatarMxc }),
  }
}

async function readBoundedAvatarBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader)
    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
  }
  try {
    if (response.body !== null) {
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            return null
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      const out = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      return out
    }
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) return null
    return new Uint8Array(buffer)
  } catch {
    return null
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** `next`, but with every element equal to the previous one's reused, and the previous array
 * itself when nothing changed: a screen memoised on identity re-renders only what moved. */
const PINNED_EVENTS = 'm.room.pinned_events'

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

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
  readonly #boundaries = new RoomBoundaryTracker()
  readonly #joinedTelemetry = new Set<string>()
  readonly #me: string
  /** Kodera's own accounts on the member's homeserver (`SERVICE_LOCALPARTS`). */
  readonly #services: ReadonlySet<string>
  #snapshot: EspaceSnapshot = { status: 'starting', rooms: [], invites: [], channels: NO_CHANNELS }
  readonly #timelines = new Map<string, readonly MessageView[]>()
  /** What this device kept of each room, shown until the room's first sync replaces it. */
  readonly #cached = new Map<string, readonly MessageView[]>()
  readonly #cache: TimelineCache | undefined
  readonly #threads = new Map<string, Map<string, readonly MessageView[]>>()
  /** Each joined room's pinned events: the same array until the room's pins change. */
  readonly #pins = new Map<string, readonly string[]>()
  readonly #eventsByRoom = new Map<string, TimelineEvent[]>()
  /** Relations seen before a redaction erased them (see `timelineView`, `./timeline.ts`). */
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
  readonly #fetch: typeof fetch
  /** The refresh in flight: the SDK's requests and the room-access call share it. */
  #renewing: Promise<string> | null = null
  /** Local profile overrides and lazy-sync hydration for the signed-in member. */
  #ownProfile: { displayName?: string | undefined; avatarUrl?: string | undefined } = {}
  #ownProfileFetched = false
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
  /** One content-free teardown dispatch per already active ordinary-room typing notice. */
  readonly #typingCleanup = new Set<string>()
  /** Serialize local m.direct updates so accepting and creating rooms preserve one another. */
  #directWrites: Promise<void> = Promise.resolve()
  readonly #inviteActions = new Map<string, Promise<void>>()
  /** `m.direct` changed since the last rebuild: the direct conversations are read again. */
  #directsChanged = false
  #directs: { snapshot: EspaceSnapshot; list: readonly DirectSummary[] } | null = null
  /** Members' avatars as `blob:` addresses, fetched with the member's token (`avatarCache.ts`). */
  readonly #avatars: AvatarCache
  /** Passports read from members' profiles, by user id; `null` once asked and none found. */
  readonly #passports = new Map<string, Passport | null>()
  readonly #passportsAsked = new Set<string>()
  #pushRulesChecked = false
  readonly #arrivals = new Map<string, { snapshot: EspaceSnapshot; list: readonly ArrivalView[] }>()
  /** Rooms whose join is under way or was refused (`M_FORBIDDEN`). */
  readonly #joins = new Map<string, RoomJoinState>()
  #joinsChanged = false
  /** Rooms whose auto-join reached a settled state (joined, banned, or join request completed). */
  readonly #joinSettled = new Set<string>()
  /** Rooms whose `POST /join` succeeded while `/sync` has not yet delivered `membership === 'join'`. */
  readonly #awaitingJoinSync = new Set<string>()
  /** Invited room IDs observed on `/sync`, so each fresh invitation can clear a prior refusal once. */
  readonly #seenInvites = new Set<string>()
  #wantedJoins: readonly string[] = []
  readonly #inFlightJoins = new Map<string, Promise<void>>()
  readonly #joinFailures = new Map<string, number>()
  readonly #joinTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #joinRateLimitedUntil = 0
  #joinCooldownTimer: ReturnType<typeof setTimeout> | null = null
  #pumpingJoins = false

  constructor(
    session: EspaceSession,
    base: typeof fetch = globalThis.fetch.bind(globalThis),
    options: EspaceStoreOptions = {}
  ) {
    // No cache given: this browser's, where it has IndexedDB. `null`: none.
    this.#cache =
      options.cache === undefined ? openTimelineCache(session.userId) : (options.cache ?? undefined)
    this.#accessToken = session.accessToken
    this.#refreshToken = session.refreshToken
    this.#refresh = session.refresh
    this.#me = session.userId
    const server = session.userId.slice(session.userId.indexOf(':') + 1)
    this.#services = new Set(SERVICE_LOCALPARTS.map((localpart) => `@${localpart}:${server}`))
    // Fence the actual transport, inside refresh retries and after any SDK await/scheduler.
    const fenced: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), session.baseUrl)
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase()
      const timeline =
        /^\/_matrix\/client\/(?:v3|r0|unstable)\/rooms\/([^/]+)\/(send|redact|typing|read_markers|receipt|messages|state\/m\.room\.pinned_events)(?:\/|$)/.exec(
          url.pathname
        )
      if (timeline && (timeline[2] === 'messages' || (method !== 'GET' && method !== 'HEAD'))) {
        const roomId = decodeURIComponent(timeline[1]!)
        const cleanup = this.#typingCleanup.delete(roomId)
        const ownTyping =
          /^\/_matrix\/client\/(?:v3|r0|unstable)\/rooms\/[^/]+\/typing\/([^/]+)$/.exec(
            url.pathname
          )
        // No Request body reads or JSON parsing: only this exact content-free stop is eligible.
        const mayFinishTyping =
          cleanup &&
          timeline[2] === 'typing' &&
          method === 'PUT' &&
          url.origin === new URL(session.baseUrl).origin &&
          url.search === '' &&
          ownTyping !== null &&
          decodeURIComponent(ownTyping[1]!) === this.#me &&
          init?.body === '{"typing":false}' &&
          permitsPlaintext(this.getRoomBoundary(roomId))
        if (!mayFinishTyping) this.#requirePlaintextRoom(roomId)
      }
      return base(input, init)
    }
    this.#fetch =
      this.#refresh === undefined || this.#refreshToken === undefined
        ? fenced
        : refreshingFetch(fenced, {
            current: () => this.#accessToken,
            refresh: () => this.#renew(),
          })
    this.#client = createClient({
      baseUrl: session.baseUrl,
      userId: session.userId,
      deviceId: session.deviceId,
      accessToken: this.#accessToken,
      // In memory: the SDK's default store writes to localStorage.
      store: new MemoryStore(),
      // The SDK is never handed the refresh token (see refresh.ts).
      fetchFn: this.#fetch,
    })
    clients.set(this, this.#client)
    this.#avatars = new AvatarCache((mxc) => this.fetchAvatar(mxc))
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
      if (this.#stopped) return
      if (event.getType() === PASSPORT_KEY) {
        this.#passports.set(this.#me, passportOf(event.getContent()))
        this.#snapshot = { ...this.#snapshot }
        this.#schedule()
        return
      }
      if (event.getType() !== 'm.direct') return
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
    on(RoomEvent.MyMembership, (room: Room) => {
      const membership = room.getMyMembership()
      const stored = this.#client.getRoom(room.roomId) !== null
      if (membership === 'join') {
        this.#joinSettled.add(room.roomId)
        this.#clearJoinTimer(room.roomId)
        if (stored) {
          this.#awaitingJoinSync.delete(room.roomId)
          if (this.#joins.delete(room.roomId)) this.#joinsChanged = true
        }
      } else if (membership === 'invite') {
        this.#joinSettled.delete(room.roomId)
        this.#clearJoinTimer(room.roomId)
        if (stored) {
          this.#awaitingJoinSync.delete(room.roomId)
          if (this.#joins.get(room.roomId) === 'refused') {
            this.#joins.delete(room.roomId)
            this.#joinsChanged = true
          }
        }
      } else if (membership === 'ban') {
        this.#joinSettled.add(room.roomId)
        this.#awaitingJoinSync.delete(room.roomId)
        this.#clearJoinTimer(room.roomId)
        this.#setJoinState(room.roomId, 'refused')
      } else if (membership === 'leave' && !this.#inFlightJoins.has(room.roomId)) {
        this.#awaitingJoinSync.delete(room.roomId)
        this.#clearJoinTimer(room.roomId)
        if (this.#joins.get(room.roomId) === 'joining' && this.#joinSettled.has(room.roomId)) {
          this.#joins.delete(room.roomId)
          this.#joinsChanged = true
        }
      }
      touch(room)
    })
    on(RoomStateEvent.Events, (_event: MatrixEvent, state: RoomState) =>
      touch(this.#client.getRoom(state.roomId))
    )
    on(HttpApiEvent.SessionLoggedOut, () => this.stop('signed-out'))
    // What the device kept is shown while the first sync is on its way; it does not hold it up.
    void this.#cache?.loadAll().then((rooms) => this.#hydrate(rooms))
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

  #hydrate(rooms: ReadonlyMap<string, readonly MessageView[]>): void {
    if (this.#stopped) return
    let changed = false
    for (const [roomId, messages] of rooms) {
      if (this.#timelines.has(roomId)) continue
      const boundary = this.getRoomBoundary(roomId)
      if (boundary !== 'unknown' && !permitsPlaintext(boundary)) {
        this.#cache?.forget(roomId)
        continue
      }
      this.#cached.set(roomId, messages)
      changed = true
    }
    if (!changed) return
    // The snapshot is the token for the timeline getters: a new one makes the screens read again.
    this.#snapshot = { ...this.#snapshot }
    this.#emit()
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
    if (this.#stopped) {
      if (status === 'signed-out') this.#typingCleanup.clear()
      return
    }
    // The view going, another organisation or a new session: the others stop seeing the member
    // type. A signed-out session has no token left to say it with.
    if (status !== 'signed-out') {
      for (const roomId of this.#typingSent.keys()) {
        if (!permitsPlaintext(this.getRoomBoundary(roomId))) continue
        this.#typingCleanup.add(roomId)
        this.#client
          .sendTyping(roomId, false, TYPING_TIMEOUT_MS)
          .catch(() => undefined)
          .finally(() => this.#typingCleanup.delete(roomId))
      }
    }
    this.#stopped = true
    // While starting, the end of the start halts; a start that failed has no sync to stop.
    if (this.#starting === null || this.#started) this.#halt()
    else this.#starting.catch(() => this.#halt())
    if (status === 'signed-out') {
      this.#cached.clear()
      void this.#cache?.wipe()
      clearMatrixSession()
    } else {
      void this.#cache?.close()
    }
    for (const timer of this.#askAgain.values()) clearTimeout(timer)
    this.#askAgain.clear()
    for (const timer of this.#joinTimers.values()) clearTimeout(timer)
    this.#joinTimers.clear()
    if (this.#joinCooldownTimer !== null) {
      clearTimeout(this.#joinCooldownTimer)
      this.#joinCooldownTimer = null
    }
    this.#joinRateLimitedUntil = 0
    this.#avatars.close()
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
  getTimeline = (roomId: string): readonly MessageView[] =>
    permitsPlaintext(this.getRoomBoundary(roomId))
      ? (this.#timelines.get(roomId) ?? this.#cached.get(roomId) ?? NONE)
      : NONE

  /** How far back one room's timeline reaches; it changes with the snapshot, as messages do. */
  getHistory = (roomId: string): History =>
    permitsPlaintext(this.getRoomBoundary(roomId))
      ? (this.#histories.get(roomId) ?? 'more')
      : 'start'

  /**
   * The event the member has read up to in the room: its fully-read marker (`m.fully_read`
   * room account data), which `markRead` moves. It can be any event, a reaction or a member
   * joining as well as a message: `firstShownAfter` says where the unread messages start. None
   * for a room never read, or not known.
   */
  getReadMarker = (roomId: string): string | null => {
    if (!permitsPlaintext(this.getRoomBoundary(roomId))) return null
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
    if (!permitsPlaintext(this.getRoomBoundary(roomId))) return null
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

  /**
   * The people who joined the room in its loaded timeline (`m.room.member`, `membership` turning
   * to `join`), oldest first, Kodera's own accounts and the member left out: the welcome channel
   * greets each with a card (`ArrivalCard`). The same array for the same snapshot.
   */
  getArrivals = (roomId: string): readonly ArrivalView[] => {
    const cached = this.#arrivals.get(roomId)
    if (cached?.snapshot === this.#snapshot) return cached.list
    const room = this.#client.getRoom(roomId)
    const liveEvents = room?.getLiveTimeline().getEvents() ?? []
    const wavedEventIds = new Set<string>()
    if (room !== null) {
      for (const event of [...liveEvents, ...room.getPendingEvents()]) {
        if (event.getType() !== 'm.reaction' || event.isRedacted()) continue
        if (event.getSender() !== this.#me) continue
        const relates = (event.getOriginalContent() as Record<string, unknown>)['m.relates_to'] as
          { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined
        if (
          relates?.rel_type === 'm.annotation' &&
          typeof relates.event_id === 'string' &&
          relates.key === '👋'
        ) {
          wavedEventIds.add(relates.event_id)
        }
      }
    }
    const seenUsers = new Set<string>()
    const list: ArrivalView[] = []
    for (const event of liveEvents) {
      if (event.getType() !== EventType.RoomMember) continue
      const userId = event.getStateKey()
      const eventId = event.getId()
      if (userId === undefined || eventId === undefined || room === null) continue
      if (userId === this.#me || this.#services.has(userId) || seenUsers.has(userId)) continue
      if (event.getContent().membership !== 'join') continue
      if (event.getPrevContent().membership === 'join') continue
      seenUsers.add(userId)
      const ts = event.getTs()
      list.push({
        eventId,
        ts: Number.isFinite(ts) ? ts : 0,
        ...(wavedEventIds.has(eventId) ? { waved: true } : {}),
        ...memberOf(room, userId),
      })
    }
    const previous = cached?.list
    const same =
      previous !== undefined &&
      previous.length === list.length &&
      previous.every(
        (item, at) =>
          item.eventId === list[at]!.eventId &&
          item.name === list[at]!.name &&
          item.avatarMxc === list[at]!.avatarMxc &&
          item.waved === list[at]!.waved
      )
    const next = same ? previous : list
    this.#arrivals.set(roomId, { snapshot: this.#snapshot, list: next })
    return next
  }

  /** One thread's replies, oldest first; the same array until one of them changes. */
  getThread = (roomId: string, rootEventId: string): readonly MessageView[] => {
    if (!permitsPlaintext(this.getRoomBoundary(roomId))) return NONE
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
          this.#timelines.has(roomId) ||
          this.#threads.has(roomId) ||
          this.#eventsByRoom.has(roomId) ||
          this.#pins.has(roomId) ||
          this.#histories.has(roomId)
        this.#timelines.delete(roomId)
        // Out of the room: what this device kept of it goes too.
        if (this.#cached.delete(roomId)) messageDataChanged = true
        this.#cache?.forget(roomId)
        this.#threads.delete(roomId)
        this.#pins.delete(roomId)
        this.#eventsByRoom.delete(roomId)
        this.#paging.delete(roomId)
        this.#histories.delete(roomId)
        this.#members.delete(roomId)
        continue
      }
      messageDataChanged = true
      const plaintext = permitsPlaintext(this.getRoomBoundary(roomId))
      if (!plaintext) {
        this.#timelines.delete(roomId)
        this.#cached.delete(roomId)
        this.#cache?.forget(roomId)
        this.#threads.delete(roomId)
        this.#pins.delete(roomId)
        this.#eventsByRoom.delete(roomId)
        this.#paging.delete(roomId)
        this.#histories.delete(roomId)
        continue
      }
      const events = this.#events(room)
      this.#eventsByRoom.set(roomId, events)
      this.#histories.set(roomId, this.#historyOf(room))
      // One pass over the room for its timeline and all its threads (`roomViews`).
      const { timeline: next, threads: repliesByRoot } = roomViews(events, this.#me)
      const timeline = reuse(this.#timelines.get(roomId), next, (m) => m.key)
      this.#timelines.set(roomId, timeline)
      this.#cached.delete(roomId)
      this.#cache?.save(roomId, timeline)
      const pins = pinnedOf(room.currentState.getStateEvents(PINNED_EVENTS, '')?.getContent())
      const knownPins = this.#pins.get(roomId)
      this.#pins.set(roomId, knownPins !== undefined && sameIds(knownPins, pins) ? knownPins : pins)
      const prevThreads = this.#threads.get(roomId)
      const nextThreads = new Map<string, readonly MessageView[]>()
      for (const msg of next) {
        const replies = repliesByRoot.get(msg.eventId) ?? []
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
    const joinedSummaries = all
      .filter((room) => room.getMyMembership() === 'join')
      .map((room) => this.#summary(room))
      .sort((a, b) => a.name.localeCompare(b.name))
    const rooms = reuse(this.#snapshot.rooms, joinedSummaries, (r) => r.roomId)
    const invites = reuse(
      this.#snapshot.invites,
      all
        .filter((room) => room.getMyMembership() === 'invite')
        .map((room) => ({
          roomId: room.roomId,
          name: room.name,
          inviter: room.currentState.getMember(this.#me)?.events.member?.getSender() ?? null,
          direct: this.#isDirectInvite(room),
        })),
      (r) => r.roomId
    )
    for (const room of rooms) {
      this.#joinSettled.add(room.roomId)
      this.#awaitingJoinSync.delete(room.roomId)
      this.#clearJoinTimer(room.roomId)
      if (this.#joins.delete(room.roomId)) this.#joinsChanged = true
    }
    const currentInviteIds = new Set(invites.map((invite) => invite.roomId))
    for (const seenId of this.#seenInvites) {
      if (!currentInviteIds.has(seenId)) this.#seenInvites.delete(seenId)
    }
    for (const invite of invites) {
      if (!this.#seenInvites.has(invite.roomId)) {
        this.#seenInvites.add(invite.roomId)
        this.#joinSettled.delete(invite.roomId)
        this.#awaitingJoinSync.delete(invite.roomId)
        this.#clearJoinTimer(invite.roomId)
        if (this.#joins.get(invite.roomId) === 'refused') {
          this.#joins.delete(invite.roomId)
          this.#joinsChanged = true
        }
      }
    }
    const status = this.#stopped ? this.#snapshot.status : this.#status
    if (status === 'live') {
      this.#loadOwnProfileIfMissing()
      this.#ensureMentionRules()
      this.#syncWantedJoins(rooms)
      this.#recheck(rooms, invites)
    }
    const typingChanged = this.#typingChanged
    this.#typingChanged = false
    const directsChanged = this.#directsChanged
    this.#directsChanged = false
    const joinsChanged = this.#joinsChanged
    this.#joinsChanged = false
    if (
      messageDataChanged ||
      typingChanged ||
      directsChanged ||
      joinsChanged ||
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
    if (this.#joinedTelemetry.delete(room.roomId)) {
      track('channel_joined', { kind: kind === 'audio' ? 'voice' : 'chat' })
    }
    const occupancy =
      kind === 'audio'
        ? occupancyOf(room.currentState.getStateEvents(OCCUPANCY, '')?.getContent())
        : null
    const names: Record<string, string> = {}
    const avatars: Record<string, string> = {}
    for (const userId of occupancy?.participants ?? []) {
      const name = displayName(room, userId)
      const avatar = avatarOf(room, userId)
      if (avatar !== undefined) avatars[userId] = avatar
      if (name !== undefined) names[userId] = name
      // Someone in the call who never wrote here is not among the lazy-loaded members.
      else if (room.getMember(userId) === null) this.loadMembers(room.roomId)
    }
    return {
      roomId: room.roomId,
      name: room.name,
      alias: room.getCanonicalAlias(),
      confidentiality: this.getRoomBoundary(room.roomId),
      kind,
      unread: room.getUnreadNotificationCount(NotificationCountType.Total),
      mentions: room.getUnreadNotificationCount(NotificationCountType.Highlight),
      occupancy,
      names,
      ...(Object.keys(avatars).length === 0 ? {} : { avatars }),
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
    if (!permitsPlaintext(this.getRoomBoundary(room.roomId))) return []
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
      .map((member): MemberView => memberOf(room, member.userId))
      .sort(
        (a, b) =>
          Number(a.name === undefined) - Number(b.name === undefined) ||
          (a.name ?? a.userId).localeCompare(b.name ?? b.userId)
      )
  }

  /** The panel's joined human roster includes the viewer; mention suggestions do not. */
  getRoster = (roomId: string): readonly MemberView[] => {
    const room = this.#client.getRoom(roomId)
    if (room === null || room.getMyMembership() !== 'join') return NO_MEMBERS
    const next = room
      .getJoinedMembers()
      .filter((member) => !this.#services.has(member.userId))
      .map((member) => faceOf(room, member.userId))
      .sort(
        (a, b) =>
          Number(a.name === undefined) - Number(b.name === undefined) ||
          (a.name ?? a.userId).localeCompare(b.name ?? b.userId)
      )
    const roster = reuse(this.#rosters.get(roomId), next, (member) => member.userId)
    this.#rosters.set(roomId, roster)
    return roster
  }

  /** The room's pinned events, oldest pin first; the same array until they change. */
  getPinned = (roomId: string): readonly string[] =>
    permitsPlaintext(this.getRoomBoundary(roomId)) ? (this.#pins.get(roomId) ?? NO_PINS) : NO_PINS

  /** Whether the room's power levels let the member change its pins. */
  canPin = (roomId: string): boolean => {
    const room = this.#client.getRoom(roomId)
    if (
      !this.#isPlaintextRoomAllowed(roomId) ||
      room === null ||
      room.getMyMembership() !== 'join' ||
      this.#isMutedInRoom(room)
    )
      return false
    return room.currentState.maySendStateEvent(PINNED_EVENTS, this.#me)
  }

  /** Marks a room as confidential out-of-band so plaintext is permanently refused. */
  markConfidentialRoom = (roomId: string): void => {
    this.#boundaries.markProtected(roomId)
    this.#timelines.delete(roomId)
    this.#cached.delete(roomId)
    this.#cache?.forget(roomId)
    this.#threads.delete(roomId)
    this.#pins.delete(roomId)
    this.#eventsByRoom.delete(roomId)
    this.#paging.delete(roomId)
    this.#histories.delete(roomId)
    if (!this.#stopped) {
      this.#dirty.add(roomId)
      this.#schedule()
    }
  }

  #pendingRoomEvents(
    room: NonNullable<ReturnType<MatrixClient['getRoom']>>
  ): readonly MatrixEvent[] {
    try {
      return room.getPendingEvents()
    } catch {
      return []
    }
  }

  /** No caller can opt a marked room back into plaintext, even after a state downgrade. */
  getRoomBoundary = (roomId: string): RoomBoundary => {
    const room = this.#client.getRoom(roomId)
    if (
      room !== null &&
      [...room.getLiveTimeline().getEvents(), ...this.#pendingRoomEvents(room)].some(
        (event) => event.getType() === 'm.room.encrypted'
      )
    ) {
      this.#boundaries.markProtected(roomId)
    }
    const value = (type: string) => {
      const event = room?.currentState.getStateEvents(type as never, '')
      return event ? { sender: event.getSender(), content: event.getContent() } : undefined
    }
    const server = serverNameOf(this.#me)
    return this.#boundaries.observe(
      roomId,
      value('m.room.create'),
      value('m.room.encryption'),
      server === undefined ? '' : `@kodera-agent:${server}`,
      server?.startsWith('community.') === true &&
        room?.currentState.getStateEvents('m.room.join_rules', '')?.getContent().join_rule ===
          'public'
    )
  }

  #isMutedInRoom(room: NonNullable<ReturnType<MatrixClient['getRoom']>>): boolean {
    const server = serverNameOf(this.#me)
    if (server === undefined) return false
    const policyEvent = room.currentState.getStateEvents(POLICY as never, '')
    if (policyEvent?.getSender() !== `@kodera-agent:${server}`) return false
    const content = policyEvent.getContent() as Record<string, unknown> | undefined
    const muted = content?.muted_until
    if (muted === null || typeof muted !== 'object' || Array.isArray(muted)) return false
    if (!Object.hasOwn(muted, this.#me)) return false
    const until = (muted as Record<string, unknown>)[this.#me]
    if (typeof until !== 'string') return true
    const parsed = Date.parse(until)
    return Number.isNaN(parsed) || parsed > Date.now()
  }

  #isPlaintextRoomAllowed(roomId: string): boolean {
    return !this.#stopped && permitsPlaintext(this.getRoomBoundary(roomId))
  }

  #requirePlaintextRoom(roomId: string): void {
    if (!this.#isPlaintextRoomAllowed(roomId)) throw new ConfidentialRoomUnavailable()
  }

  #requireUnmutedPlaintextRoom(roomId: string): void {
    this.#requirePlaintextRoom(roomId)
    const room = this.#client.getRoom(roomId)
    if (room !== null && this.#isMutedInRoom(room)) {
      throw new Error('The member is muted in this room. No content was sent.')
    }
  }

  /** Whether the room's power levels let the member post messages (`m.room.message`). */
  canSendMessage = (roomId: string): boolean => {
    const room = this.#client.getRoom(roomId)
    if (
      !this.#isPlaintextRoomAllowed(roomId) ||
      room === null ||
      room.getMyMembership() !== 'join' ||
      this.#isMutedInRoom(room)
    )
      return false
    return room.currentState.maySendEvent(EventType.RoomMessage, this.#me)
  }

  /** Whether the room's power levels let the member react to messages (`m.reaction`). */
  canReact = (roomId: string): boolean => {
    const room = this.#client.getRoom(roomId)
    if (
      !this.#isPlaintextRoomAllowed(roomId) ||
      room === null ||
      room.getMyMembership() !== 'join' ||
      this.#isMutedInRoom(room)
    )
      return false
    return room.currentState.maySendEvent(EventType.Reaction, this.#me)
  }

  /** State of an in-flight or refused join for `roomId`, or `undefined` otherwise. */
  getJoinState = (roomId: string): RoomJoinState | undefined => this.#joins.get(roomId)

  /** Pins or unpins one event; the room's next state answers with the new list. */
  async setPinned(roomId: string, eventId: string, pinned: boolean): Promise<void> {
    this.#requireUnmutedPlaintextRoom(roomId)
    const current = this.getPinned(roomId)
    if (current.includes(eventId) === pinned) return
    const next = pinned ? [...current, eventId] : current.filter((id) => id !== eventId)
    await this.#client.sendStateEvent(
      roomId,
      PINNED_EVENTS as Parameters<MatrixClient['sendStateEvent']>[1],
      { pinned: next } as Parameters<MatrixClient['sendStateEvent']>[2],
      ''
    )
  }

  getMemberRole = (roomId: string, userId: string): 'admin' | 'member' => {
    const room = this.#client.getRoom(roomId)
    // Room v12+ creators (`m.room.create` sender and `additional_creators`) hold infinite power
    // even when no `m.room.power_levels` state event exists yet and `member.powerLevel` is still `0`.
    if (isV12RoomCreator(room, userId)) return 'admin'
    const memberLevel: unknown = room?.getMember(userId)?.powerLevel
    const powers = room?.currentState.getStateEvents('m.room.power_levels', '')?.getContent()
    const level: unknown =
      typeof memberLevel === 'number' && !Number.isNaN(memberLevel)
        ? memberLevel
        : (powers?.users?.[userId] ?? powers?.users_default ?? 0)
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
    if (this.#stopped || !permitsPlaintext(this.getRoomBoundary(roomId))) return
    const room = this.#client.getRoom(roomId)
    if (typing && room !== null && this.#isMutedInRoom(room)) return
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
      const senderAvatar = avatarOf(room, event.getSender() ?? '')
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
        ...(senderAvatar === undefined ? {} : { sender_avatar: senderAvatar }),
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
      if (
        this.#joins.has(room.roomId) ||
        this.#awaitingJoinSync.has(room.roomId) ||
        this.#inFlightJoins.has(room.roomId)
      )
        continue
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
      room = isMatrixRoomId(answer.room_id) ? { state: 'resolved', roomId: answer.room_id } : null
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
    this.#requireUnmutedPlaintextRoom(roomId)
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
    // The Markdown the member typed, as HTML other Matrix clients draw; `body` stays the text.
    const html = body === '' ? null : markdownToHtml(body, options.mentionTargets ?? [])
    const mentions =
      options.mentions === undefined && options.mentionsRoom !== true
        ? undefined
        : {
            user_ids: options.mentions ?? [],
            ...(options.mentionsRoom === true ? { room: true } : {}),
          }
    await this.#client.sendMessage(roomId, {
      msgtype: MsgType.Text,
      // Other clients show the files' names when the message has no text of its own.
      body: body === '' && attachments.length > 0 ? attachmentsFallback(attachments) : body,
      ...(html === null ? {} : { format: HTML_FORMAT, formatted_body: html }),
      ...(attachments.length === 0 ? {} : { [ATTACHMENTS_FIELD]: attachments }),
      ...(mentions === undefined ? {} : { 'm.mentions': mentions }),
      ...(relatesTo === undefined ? {} : { 'm.relates_to': relatesTo }),
    } as never)
  }

  /**
   * Replaces the text of one of the member's messages (Matrix spec, m.replace).
   *
   * `m.new_content` carries the message's whole new `m.mentions`, so a name the edit removes
   * stops being a mention. The edit's own fallback carries only who the edit newly names: a
   * member the message already named is not notified a second time (spec, "Mentioning the
   * replaced event"). An edit of a message that named no one and still names no one carries no
   * `m.mentions`, as `send` does.
   */
  async edit(
    roomId: string,
    eventId: string,
    body: string,
    options: EditOptions = {}
  ): Promise<void> {
    this.#requireUnmutedPlaintextRoom(roomId)
    const html = markdownToHtml(body, options.mentionTargets ?? [])
    const userIds = [...new Set(options.mentions ?? [])]
    const room = options.mentionsRoom === true
    const before = this.#mentionsOf(roomId, eventId)
    const newly = userIds.filter((userId) => !before.userIds.has(userId))
    const named = userIds.length > 0 || room || before.userIds.size > 0 || before.room
    await this.#client.sendMessage(roomId, {
      msgtype: MsgType.Text,
      body: `* ${body}`,
      ...(named
        ? { 'm.mentions': { user_ids: newly, ...(room && !before.room ? { room: true } : {}) } }
        : {}),
      'm.new_content': {
        msgtype: MsgType.Text,
        body,
        ...(html === null ? {} : { format: HTML_FORMAT, formatted_body: html }),
        ...(named ? { 'm.mentions': { user_ids: userIds, ...(room ? { room: true } : {}) } } : {}),
      },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    } as never)
  }

  /** Who a message already names, in its original content or its latest edit. */
  #mentionsOf(roomId: string, eventId: string): { userIds: Set<string>; room: boolean } {
    const event = this.#client.getRoom(roomId)?.findEventById(eventId)
    const userIds = new Set<string>()
    let room = false
    for (const content of [event?.getOriginalContent(), event?.getContent()]) {
      const value: unknown = content?.['m.mentions']
      if (value === null || typeof value !== 'object') continue
      const { user_ids: ids, room: everyone } = value as { user_ids?: unknown; room?: unknown }
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') userIds.add(id)
      if (everyone === true) room = true
    }
    return { userIds, room }
  }

  async remove(roomId: string, eventId: string): Promise<void> {
    this.#requireUnmutedPlaintextRoom(roomId)
    await this.#client.redactEvent(roomId, eventId)
  }

  async react(roomId: string, eventId: string, key: string): Promise<void> {
    this.#requireUnmutedPlaintextRoom(roomId)
    if (!isValidReactionKey(key)) {
      throw new Error('Invalid reaction key. No content was sent.')
    }
    await this.#client.sendEvent(
      roomId,
      'm.reaction' as never,
      {
        'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
      } as never
    )
  }

  async unreact(roomId: string, eventId: string, key: string): Promise<void> {
    this.#requireUnmutedPlaintextRoom(roomId)
    const room = this.#client.getRoom(roomId)
    if (room === null) return
    const match = [...room.getLiveTimeline().getEvents(), ...this.#pendingRoomEvents(room)].find(
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

  #hasOwnReaction(roomId: string, eventId: string, key: string): boolean {
    const room = this.#client.getRoom(roomId)
    if (room === null) return false
    return [...room.getLiveTimeline().getEvents(), ...this.#pendingRoomEvents(room)].some(
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
    const mine =
      target !== undefined
        ? target.reactions.some((r) => r.key === key && r.mine)
        : this.#hasOwnReaction(roomId, eventId, key)
    if (mine) {
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
      const names = userIds.map((userId) => safeDisplayName(displayName(room, userId), userId))
      const avatarMxc = userIds.length === 1 ? avatarOf(room, userIds[0]!) : undefined
      list.push({
        roomId,
        userIds,
        name: names.join(', '),
        unread: summary.unread,
        ...(avatarMxc === undefined ? {} : { avatarMxc }),
      })
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
          item.unread === list[at]!.unread &&
          item.avatarMxc === list[at]!.avatarMxc
      )
    this.#directs = { snapshot, list: same ? previous : list }
    return this.#directs.list
  }

  #isDirectInvite(room: Room): boolean {
    const event = room.currentState.getMember(this.#me)?.events.member
    const inviter = event?.getSender()
    if (inviter !== undefined && this.#services.has(inviter)) return false
    if (event?.getContent().is_direct === true) return true
    const members = room.currentState
      .getMembers()
      .filter((member) => member.membership === 'join' || member.membership === 'invite')
    // Older clients omit is_direct. Only an unnamed, unaliased two-person room qualifies.
    return (
      inviter !== undefined &&
      inviter !== this.#me &&
      !this.#services.has(inviter) &&
      !room.getCanonicalAlias() &&
      !room.currentState.getStateEvents(EventType.RoomName, '') &&
      members.length === 2 &&
      members.some((member) => member.userId === inviter) &&
      members.some((member) => member.userId === this.#me)
    )
  }

  /** Explicit membership consent only: no message, key or protection state is sent or inferred. */
  acceptInvite(roomId: string): Promise<void> {
    return this.#actOnInvite(roomId, true)
  }

  declineInvite(roomId: string): Promise<void> {
    return this.#actOnInvite(roomId, false)
  }

  #actOnInvite(roomId: string, accept: boolean): Promise<void> {
    const pending = this.#inviteActions.get(roomId)
    if (pending !== undefined) return pending
    const action = (async () => {
      if (this.#stopped) throw new Error('Espace is stopped')
      const room = this.#client.getRoom(roomId)
      const invite = this.#snapshot.invites.find((item) => item.roomId === roomId)
      if (room === null || invite === undefined || room.getMyMembership() !== 'invite')
        throw new Error('Invitation unavailable')
      if (!accept) {
        await this.#client.leave(roomId)
        return
      }
      const direct = this.#isDirectInvite(room)
      const inviter = invite.inviter
      // Record before joining so a failed account-data write leaves an actionable invitation.
      // getDirects still excludes this room until authoritative joined membership arrives.
      if (direct && inviter !== null && inviter !== this.#me && isMatrixUserId(inviter)) {
        await this.#recordDirect(roomId, [inviter])
      }
      if (this.#stopped) throw new Error('Espace is stopped')
      await this.#client.joinRoom(roomId)
    })().finally(() => this.#inviteActions.delete(roomId))
    this.#inviteActions.set(roomId, action)
    return action
  }

  #recordDirect(roomId: string, people: readonly string[]): Promise<void> {
    const write = this.#directWrites
      .catch(() => undefined)
      .then(async () => {
        if (this.#stopped) throw new Error('Espace is stopped')
        const map = directMap(this.#client.getAccountData(EventType.Direct)?.getContent())
        await this.#client.setAccountData(
          EventType.Direct,
          withDirect(map, roomId, people) as never
        )
        this.#directsChanged = true
        this.#schedule()
      })
    this.#directWrites = write
    return write
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
    // `private_chat`, not `trusted_private_chat`: the latter gives every invitee the creator's
    // power level, so anyone in a group conversation could remove the others or change the room.
    // No `initial_state`: the Kodera room policy admits a member-created room only as a plain
    // direct message and refuses any creation that carries initial state
    // (packages/synapse-policy, `_is_direct_message`), so it is set as the first event instead.
    const { room_id: roomId } = await this.#client.createRoom({
      is_direct: true,
      invite: people,
      preset: Preset.PrivateChat,
      visibility: Visibility.Private,
    })
    if (!isMatrixRoomId(roomId)) throw new Error('Invalid Matrix room ID')
    // Someone invited later reads only what is sent from their invitation on. Nothing has been
    // sent yet, so nobody reads anything before it.
    await this.#client.sendStateEvent(
      roomId,
      EventType.RoomHistoryVisibility,
      { history_visibility: HistoryVisibility.Invited },
      ''
    )
    await this.#recordDirect(roomId, people)
    return roomId
  }

  /** Names and IDs returned by the homeserver directory, never inferred from Core identities. */
  async searchMembers(term: string): Promise<readonly MemberView[]> {
    if (this.#stopped) return NO_MEMBERS
    const query = term.trim().slice(0, 80)
    if (query.length < 2) return NO_MEMBERS
    const response = await this.#client.searchUserDirectory({ term: query, limit: 30 })
    if (this.#stopped || !Array.isArray(response.results)) return NO_MEMBERS
    const members = new Map<string, MemberView>()
    for (const result of response.results.slice(0, 30)) {
      const id = result?.user_id
      if (
        typeof id !== 'string' ||
        id.length > 255 ||
        !isMatrixUserId(id) ||
        id === this.#me ||
        SERVICE_LOCALPARTS.some((localpart) => id.startsWith(`@${localpart}:`))
      )
        continue
      const name = cleanText(result.display_name, 80)
      members.set(id, { userId: id, ...(name === '' ? {} : { name }) })
    }
    return [...members.values()]
  }

  async inviteToRoom(roomId: string, userId: string): Promise<void> {
    if (!isMatrixUserId(userId)) throw new Error('Invalid Matrix user ID')
    await this.#client.invite(roomId, userId)
  }

  #loadOwnProfileIfMissing(): void {
    if (this.#ownProfileFetched || this.#stopped) return
    const user = this.#client.getUser(this.#me)
    if (user?.displayName && user?.avatarUrl) {
      this.#ownProfileFetched = true
      return
    }
    this.#ownProfileFetched = true
    void this.#client
      .getProfileInfo(this.#me)
      .then((info) => {
        if (this.#stopped) return
        const displayName =
          typeof info.displayname === 'string' && info.displayname !== ''
            ? info.displayname
            : undefined
        const avatarUrl =
          typeof info.avatar_url === 'string' && info.avatar_url !== ''
            ? info.avatar_url
            : undefined
        let changed = false
        if (!('displayName' in this.#ownProfile) && displayName !== undefined) {
          this.#ownProfile = { ...this.#ownProfile, displayName }
          changed = true
        }
        if (!('avatarUrl' in this.#ownProfile) && avatarUrl !== undefined) {
          this.#ownProfile = { ...this.#ownProfile, avatarUrl }
          changed = true
        }
        if (changed) {
          this.#snapshot = { ...this.#snapshot }
          this.#emit()
        }
      })
      .catch(() => undefined)
  }

  /**
   * The member's own Matrix profile, as the homeserver holds it (`m.room.member` global profile):
   * what every other client in every room draws for them. Read from the store's own state, so no
   * extra request is made to draw the settings panel.
   */
  getOwnProfile = (): { displayName: string | undefined; avatarUrl: string | undefined } => {
    const user = this.#client.getUser(this.#me)
    return {
      displayName:
        'displayName' in this.#ownProfile
          ? this.#ownProfile.displayName
          : (user?.displayName ?? undefined),
      avatarUrl:
        'avatarUrl' in this.#ownProfile
          ? this.#ownProfile.avatarUrl
          : (user?.avatarUrl ?? undefined),
    }
  }

  /**
   * The member's own avatar as bytes, fetched from their homeserver's media endpoint with their
   * own token. The bytes, not the address: the console's policy names no remote image source
   * (`img-src 'self' blob:`), so what is drawn is a blob this page holds. `null` where there is no
   * avatar, where the address is malformed or cross-origin, where the homeserver refuses, or where
   * what came back is not a bounded raster PNG, JPEG or WebP image.
   */
  async fetchOwnAvatar(size = 96): Promise<Blob | null> {
    const mxcUrl = this.getOwnProfile().avatarUrl
    return mxcUrl === undefined ? null : this.fetchAvatar(mxcUrl, size)
  }

  /** Any member's avatar as bytes, as `fetchOwnAvatar` fetches the member's own. */
  async fetchAvatar(mxcUrl: string, size = 96): Promise<Blob | null> {
    if (this.#stopped) return null
    if (!mxcUrl.startsWith('mxc://')) return null
    const href = this.#client.mxcUrlToHttp(mxcUrl, size, size, 'crop', undefined, true, true)
    if (!href) return null
    let parsed: URL
    let expectedOrigin: string
    try {
      parsed = new URL(href)
      expectedOrigin = new URL(this.#client.baseUrl).origin
    } catch {
      return null
    }
    if (
      expectedOrigin === 'null' ||
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.origin !== expectedOrigin
    ) {
      return null
    }
    let response: Response
    try {
      const token = this.#accessToken || this.#client.getAccessToken()
      response = await this.#fetch(parsed.href, {
        redirect: 'error',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })
    } catch {
      return null
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const declaredMime =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!(AVATAR_TYPES as readonly string[]).includes(declaredMime)) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const bytes = await readBoundedAvatarBytes(response, MAX_AVATAR_BYTES)
    if (bytes === null) return null
    const inspected = inspectRasterImage(bytes)
    if (!inspected.ok) return null
    return new Blob([bytes], { type: inspected.mime })
  }

  /** Names the member on their homeserver, for every room at once. */
  async setProfileDisplayName(displayName: string): Promise<void> {
    if (this.#stopped) throw new Error('Espace is stopped')
    const trimmed = displayName.trim()
    if (trimmed === '') throw new Error('Empty display name')
    const next = trimmed.slice(0, 80)
    await this.#client.setDisplayName(next)
    if (this.#stopped) return
    this.#ownProfile = { ...this.#ownProfile, displayName: next }
    this.#snapshot = { ...this.#snapshot }
    this.#emit()
  }

  /**
   * Uploads the picture and makes it the member's avatar. The file is sent to the member's own
   * homeserver and nowhere else; its address is an `mxc://` one, which only a Matrix client
   * resolves.
   */
  async setProfileAvatar(file: Blob, filename: string): Promise<string> {
    if (this.#stopped) throw new Error('Espace is stopped')
    const { content_uri: uri } = await this.#client.uploadContent(file, {
      name: filename,
      type: file.type || 'image/png',
      includeFilename: true,
    })
    if (this.#stopped) throw new Error('Espace is stopped')
    await this.#client.setAvatarUrl(uri)
    if (!this.#stopped) {
      this.#ownProfile = { ...this.#ownProfile, avatarUrl: uri }
      this.#snapshot = { ...this.#snapshot }
      this.#emit()
    }
    return uri
  }

  /** Members' avatars as `blob:` addresses this page holds (`avatarCache.ts`). */
  getAvatarCache = (): AvatarCache => this.#avatars

  /**
   * A member's Kodera Passport (`passport.ts`): the member's own from their account data, another
   * member's from their profile, asked once per session. `undefined` while not known.
   */
  getPassport = (userId: string): Passport | undefined => {
    if (userId === this.#me) {
      const own = this.#passports.get(userId)
      if (own !== undefined && own !== null) return own
      const data = this.#client.getAccountData(PASSPORT_KEY as never)?.getContent()
      return data === undefined ? undefined : passportOf(data)
    }
    const known = this.#passports.get(userId)
    if (known !== undefined) return known ?? undefined
    this.#loadPassport(userId)
    return undefined
  }

  #loadPassport(userId: string): void {
    if (this.#stopped || this.#passportsAsked.has(userId) || !isMatrixUserId(userId)) return
    this.#passportsAsked.add(userId)
    void this.#client
      .getProfileInfo(userId)
      .then((info) => {
        if (this.#stopped) return
        const value = (info as Record<string, unknown>)[PASSPORT_KEY]
        this.#passports.set(userId, value === undefined ? null : passportOf(value))
        this.#snapshot = { ...this.#snapshot }
        this.#emit()
      })
      .catch(() => {
        if (!this.#stopped) this.#passports.set(userId, null)
      })
  }

  /**
   * Saves the member's passport: to their account data, and as a field of their global profile
   * where the homeserver keeps custom fields, so others read it too. Only the account data has to
   * succeed; a homeserver without extended profiles keeps the passport the member's own.
   */
  async setPassport(passport: Passport): Promise<void> {
    if (this.#stopped) throw new Error('Espace is stopped')
    const next = passportOf(passport)
    await this.#client.setAccountData(PASSPORT_KEY as never, next as never)
    if (this.#stopped) return
    this.#passports.set(this.#me, next)
    this.#snapshot = { ...this.#snapshot }
    this.#emit()
    const { onboarded: _onboarded, ...shared } = next
    await this.#client.setExtendedProfileProperty(PASSPORT_KEY, shared).catch(() => undefined)
  }

  /**
   * Makes sure a mention reaches the member mentioned, once per session and silently: a homeserver
   * older than intentional mentions has no `.m.rule.is_user_mention` / `.m.rule.is_room_mention`,
   * and then Kodera adds its own override rules on `m.mentions` with the same effect. A rule the
   * member turned off is theirs and is left off; a refusal changes nothing the member does.
   */
  #ensureMentionRules(): void {
    if (this.#pushRulesChecked || this.#stopped) return
    this.#pushRulesChecked = true
    void (async () => {
      // The homeserver's own answer: the SDK's `getPushRules` fills in defaults on this device.
      const rules = await this.#client.http.authedRequest<{
        global?: { override?: { rule_id: string }[] }
      }>(Method.Get, '/pushrules/')
      const override = rules.global?.override
      // No override list at all is no ruleset to complete: a homeserver serves its defaults.
      if (!Array.isArray(override) || override.length === 0) return
      const ids = new Set(override.map((rule) => rule.rule_id))
      const wanted = [
        {
          standard: '.m.rule.is_user_mention',
          ruleId: 'io.kodera.rule.is_user_mention',
          conditions: [
            {
              kind: 'event_property_contains',
              key: 'content.m\\.mentions.user_ids',
              value: this.#me,
            },
          ],
          actions: ['notify', { set_tweak: 'highlight' }, { set_tweak: 'sound', value: 'default' }],
        },
        {
          standard: '.m.rule.is_room_mention',
          ruleId: 'io.kodera.rule.is_room_mention',
          conditions: [
            { kind: 'event_property_is', key: 'content.m\\.mentions.room', value: true },
            { kind: 'sender_notification_permission', key: 'room' },
          ],
          actions: ['notify', { set_tweak: 'highlight' }],
        },
      ]
      for (const rule of wanted) {
        if (this.#stopped || ids.has(rule.standard) || ids.has(rule.ruleId)) continue
        await this.#client.addPushRule('global', PushRuleKind.Override, rule.ruleId, {
          conditions: rule.conditions,
          actions: rule.actions,
        } as never)
      }
    })().catch(() => undefined)
  }

  /** Removes the member's avatar; their initials stand for them again. */
  async clearProfileAvatar(): Promise<void> {
    if (this.#stopped) throw new Error('Espace is stopped')
    await this.#client.setAvatarUrl('')
    if (this.#stopped) return
    this.#ownProfile = { ...this.#ownProfile, avatarUrl: undefined }
    this.#snapshot = { ...this.#snapshot }
    this.#emit()
  }

  #setJoinState(roomId: string, state: RoomJoinState): void {
    if (this.#joins.get(roomId) === state) return
    this.#joins.set(roomId, state)
    this.#joinsChanged = true
  }

  #clearJoinTimer(roomId: string): void {
    const timer = this.#joinTimers.get(roomId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#joinTimers.delete(roomId)
    }
  }

  #syncWantedJoins(rooms: readonly RoomSummary[]): void {
    const joined = new Set(rooms.map((room) => room.roomId))
    for (const roomId of this.#wantedJoins) {
      if (joined.has(roomId) || this.#joinSettled.has(roomId)) continue
      if (this.#client.getRoom(roomId)?.getMyMembership() === 'ban') {
        this.#joinSettled.add(roomId)
        this.#setJoinState(roomId, 'refused')
        continue
      }
      if (!this.#joins.has(roomId)) {
        this.#joins.set(roomId, 'joining')
        this.#joinsChanged = true
      }
    }
    void this.#pumpJoins()
  }

  /**
   * Queues resolved active workspace rooms for a one-shot join once the sync is `live`, in the
   * priority order given (current channel first, then remaining active channels one by one so
   * Synapse's `rc_joins.local` burst limit is respected).
   */
  ensureJoined = (roomIds: readonly string[]): void => {
    if (this.#stopped) return
    this.#wantedJoins = [...new Set(roomIds)]
    const wanted = new Set(this.#wantedJoins)
    for (const [roomId, timer] of this.#joinTimers) {
      if (!wanted.has(roomId)) {
        clearTimeout(timer)
        this.#joinTimers.delete(roomId)
        if (
          this.#joins.get(roomId) === 'joining' &&
          !this.#inFlightJoins.has(roomId) &&
          !this.#awaitingJoinSync.has(roomId)
        ) {
          this.#joins.delete(roomId)
          this.#joinsChanged = true
        }
      }
    }
    for (const [roomId, state] of this.#joins) {
      if (
        state === 'joining' &&
        !wanted.has(roomId) &&
        !this.#inFlightJoins.has(roomId) &&
        !this.#awaitingJoinSync.has(roomId)
      ) {
        this.#joins.delete(roomId)
        this.#joinsChanged = true
      }
    }
    if (this.#status === 'live') {
      this.#syncWantedJoins(this.#snapshot.rooms)
    }
    if (this.#joinsChanged) this.#schedule()
  }

  join = (roomId: string): Promise<void> => {
    if (this.#stopped) return Promise.reject(new Error('This Espace store was stopped.'))
    const existing = this.#inFlightJoins.get(roomId)
    if (existing !== undefined) return existing
    const synced = this.#client.getRoom(roomId)
    if (synced?.getMyMembership() === 'join' || this.#awaitingJoinSync.has(roomId)) {
      this.#joinSettled.add(roomId)
      this.#clearJoinTimer(roomId)
      if (synced?.getMyMembership() === 'join') {
        this.#awaitingJoinSync.delete(roomId)
        if (this.#joins.delete(roomId)) {
          this.#joinsChanged = true
          this.#schedule()
        }
      }
      return Promise.resolve()
    }
    this.#clearJoinTimer(roomId)
    if (this.#joins.get(roomId) !== 'joining') {
      this.#joins.set(roomId, 'joining')
      this.#joinsChanged = true
      this.#schedule()
    }
    const request = this.#client
      .joinRoom(roomId)
      .then(() => {
        if (this.#stopped) return
        this.#joinedTelemetry.add(roomId)
        this.#schedule()
        this.#joinSettled.add(roomId)
        this.#joinFailures.delete(roomId)
        const room = this.#client.getRoom(roomId)
        if (room?.getMyMembership() === 'join') {
          this.#awaitingJoinSync.delete(roomId)
          if (this.#joins.delete(roomId)) this.#joinsChanged = true
          this.#dirty.add(roomId)
          this.#rebuild()
        } else {
          this.#awaitingJoinSync.add(roomId)
          this.#setJoinState(roomId, 'joining')
          if (this.#joinsChanged) this.#rebuild()
        }
      })
      .catch((error: unknown) => {
        if (!this.#stopped && isJoinRefused(error)) {
          this.#joinSettled.add(roomId)
          this.#awaitingJoinSync.delete(roomId)
          this.#joinFailures.delete(roomId)
          this.#setJoinState(roomId, 'refused')
          this.#rebuild()
        }
        throw error
      })
      .finally(() => {
        this.#inFlightJoins.delete(roomId)
      })
    this.#inFlightJoins.set(roomId, request)
    return request
  }

  async #pumpJoins(): Promise<void> {
    if (this.#pumpingJoins || this.#stopped) return
    this.#pumpingJoins = true
    try {
      while (!this.#stopped && this.#status === 'live') {
        const remainingCooldown = this.#joinRateLimitedUntil - Date.now()
        if (remainingCooldown > 0 || this.#joinCooldownTimer !== null) {
          if (this.#joinCooldownTimer === null) {
            this.#scheduleJoinCooldown(remainingCooldown)
          }
          break
        }
        const nextRoomId = this.#wantedJoins.find((roomId) => {
          if (this.#joinSettled.has(roomId) || this.#joinTimers.has(roomId)) return false
          if (this.#joins.get(roomId) !== 'joining') return false
          const membership = this.#client.getRoom(roomId)?.getMyMembership()
          return membership !== 'join' && !this.#awaitingJoinSync.has(roomId)
        })
        if (nextRoomId === undefined) break
        try {
          await this.join(nextRoomId)
        } catch (error: unknown) {
          if (this.#stopped || isJoinRefused(error)) continue
          if (isJoinPermanentClientError(error)) {
            this.#joinSettled.add(nextRoomId)
            this.#joinFailures.delete(nextRoomId)
            if (this.#joins.delete(nextRoomId)) {
              this.#joinsChanged = true
              this.#schedule()
            }
            continue
          }
          const attempts = (this.#joinFailures.get(nextRoomId) ?? 0) + 1
          this.#joinFailures.set(nextRoomId, attempts)
          if (error instanceof MatrixError && error.isRateLimitError()) {
            this.#scheduleJoinCooldown(rateLimitWaitMs(error, attempts))
            break
          }
          this.#scheduleJoinRetry(nextRoomId, backoff(RETRY_AFTER_MS, RETRY_AT_MOST_MS, attempts))
        }
      }
    } finally {
      this.#pumpingJoins = false
    }
  }

  #scheduleJoinCooldown(ms: number): void {
    if (this.#stopped) return
    const wait = Math.max(0, ms)
    const until = Date.now() + wait
    if (until > this.#joinRateLimitedUntil) {
      this.#joinRateLimitedUntil = until
    }
    if (this.#joinCooldownTimer !== null) {
      clearTimeout(this.#joinCooldownTimer)
    }
    const delay = Math.max(0, this.#joinRateLimitedUntil - Date.now())
    this.#joinCooldownTimer = setTimeout(() => {
      this.#joinCooldownTimer = null
      this.#joinRateLimitedUntil = 0
      if (!this.#stopped && this.#status === 'live') {
        void this.#pumpJoins()
      }
    }, delay)
  }

  #scheduleJoinRetry(roomId: string, ms: number): void {
    if (this.#stopped || this.#joinTimers.has(roomId) || !this.#wantedJoins.includes(roomId)) return
    this.#joinTimers.set(
      roomId,
      setTimeout(
        () => {
          this.#joinTimers.delete(roomId)
          if (this.#stopped || !this.#wantedJoins.includes(roomId)) return
          if (this.#status === 'live') void this.#pumpJoins()
        },
        Math.max(0, ms)
      )
    )
  }

  /**
   * Adds the room's previous page of events to its timeline, once however many callers ask
   * together. A failure is kept in `getHistory` for the screen to offer again; the SDK
   * itself waits a few seconds before a new ask after one.
   */
  loadOlder = async (roomId: string): Promise<void> => {
    if (!this.#isPlaintextRoomAllowed(roomId)) return
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
    if (!this.#isPlaintextRoomAllowed(roomId)) return
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
    this.#requirePlaintextRoom(roomId)
    const unsent = this.#unsent(roomId, key)
    if (unsent !== null) await this.#client.resendEvent(unsent.event, unsent.room)
  }

  /** Drops a failed message, by its row key. */
  cancel(roomId: string, key: string): void {
    const unsent = this.#unsent(roomId, key)
    if (unsent !== null) this.#client.cancelPendingEvent(unsent.event)
  }
}

export interface EspaceStoreOptions {
  /** Where the rooms' last messages are kept; `null` keeps none. Defaults to this browser's. */
  cache?: TimelineCache | null
}

export function createEspaceStore(
  session: EspaceSession,
  base: typeof fetch = globalThis.fetch.bind(globalThis),
  options: EspaceStoreOptions = {}
): EspaceStore {
  return new EspaceStore(session, base, options)
}
