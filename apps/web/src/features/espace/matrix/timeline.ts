// Espace's timeline, as a pure function of the raw Matrix events a room holds (messaging-pilot
// design §2.3). The store hands it what matrix-js-sdk synced; it returns what a screen draws.
// Nothing here talks to a server, so every rule is a unit test away: an edit replaces the text
// it points at, a redaction empties a message, reactions count per key, a thread reply stays in
// its thread.

/** A Matrix event as the client-server API delivers it, the part Espace reads. */
export interface RawEvent {
  event_id: string
  type: string
  sender: string
  origin_server_ts: number
  content: Record<string, unknown>
  unsigned?: { redacted_because?: unknown } & Record<string, unknown>
}

/** A raw event plus what only this device knows about it. */
export interface TimelineEvent extends RawEvent {
  /** Stable across sending: the local transaction id while unsent, then kept once sent. */
  key?: string
  /** This device's own message not yet acknowledged, or refused. */
  local?: 'pending' | 'failed'
  /** The sender's display name in the room, when the homeserver holds one. */
  sender_name?: string
}

export interface Reaction {
  key: string
  count: number
  /** The signed-in member reacted with this key. */
  mine: boolean
}

export interface MessageView {
  /** The row's identity: unchanged when a sent message gets its server id. */
  key: string
  eventId: string
  sender: string
  /** The sender's display name in the room; absent when it has none, and the id is all there is. */
  senderName?: string
  body: string
  /** Structured references supplied by workspace adapters. */
  document?: { id: string; title: string }
  attachment?: { name: string }
  ts: number
  /** Replaced by a later edit from its own sender. */
  edited: boolean
  /** Deleted: its text is gone for everyone. */
  redacted: boolean
  /** `pending` until the server acknowledges it; `failed` when it refused or never answered. */
  delivery: 'sent' | 'pending' | 'failed'
  /** The message this one answers, by its event id. */
  replyTo: string | null
  reactions: Reaction[]
  /** Another member's message that names the signed-in one in its `m.mentions`; absent otherwise. */
  mentionsMe?: true
}

type Relation = { rel_type?: unknown; event_id?: unknown; key?: unknown; 'm.in_reply_to'?: unknown }

function relation(event: RawEvent): Relation | null {
  const relates = event.content['m.relates_to']
  return relates !== null && typeof relates === 'object' ? (relates as Relation) : null
}

function isRedacted(event: RawEvent): boolean {
  return event.unsigned?.redacted_because !== undefined
}

function text(content: unknown): string | null {
  if (content === null || typeof content !== 'object') return null
  const body = (content as { body?: unknown }).body
  return typeof body === 'string' ? body : null
}

/** Whether the message's intentional mentions (`m.mentions.user_ids`) name `me`. */
function mentions(content: Record<string, unknown>, me: string): boolean {
  const value = content['m.mentions']
  if (value === null || typeof value !== 'object') return false
  const userIds = (value as { user_ids?: unknown }).user_ids
  return Array.isArray(userIds) && userIds.includes(me)
}

function collectRelations(events: readonly TimelineEvent[]) {
  // An edit counts only from the message's own sender (Matrix spec, m.replace), and the latest
  // one wins. A redacted edit no longer counts.
  const senders = new Map(events.map((event) => [event.event_id, event.sender]))
  const edits = new Map<string, { body: string; ts: number }>()
  const reactions = new Map<string, Map<string, Set<string>>>()

  for (const event of events) {
    const rel = relation(event)
    if (rel === null || isRedacted(event) || typeof rel.event_id !== 'string') continue
    if (event.type === 'm.room.message' && rel.rel_type === 'm.replace') {
      if (senders.get(rel.event_id) !== event.sender) continue
      const body = text(event.content['m.new_content'])
      const known = edits.get(rel.event_id)
      if (body !== null && (known === undefined || event.origin_server_ts >= known.ts)) {
        edits.set(rel.event_id, { body, ts: event.origin_server_ts })
      }
    } else if (event.type === 'm.reaction' && rel.rel_type === 'm.annotation') {
      if (typeof rel.key !== 'string' || rel.key === '') continue
      const byKey = reactions.get(rel.event_id) ?? new Map<string, Set<string>>()
      const who = byKey.get(rel.key) ?? new Set<string>()
      who.add(event.sender)
      byKey.set(rel.key, who)
      reactions.set(rel.event_id, byKey)
    }
  }

  return { edits, reactions }
}

function toMessageView(
  event: TimelineEvent,
  me: string,
  edits: ReadonlyMap<string, { body: string; ts: number }>,
  reactions: ReadonlyMap<string, Map<string, Set<string>>>
): MessageView {
  const rel = relation(event)
  const redacted = isRedacted(event)
  const edit = edits.get(event.event_id)
  const inReply = rel?.['m.in_reply_to']
  const replyTo =
    inReply !== null && typeof inReply === 'object'
      ? (inReply as { event_id?: unknown }).event_id
      : undefined
  return {
    key: event.key ?? event.event_id,
    eventId: event.event_id,
    sender: event.sender,
    ...(event.sender_name === undefined ? {} : { senderName: event.sender_name }),
    body: redacted ? '' : (edit?.body ?? text(event.content) ?? ''),
    ...(!redacted &&
    ['m.file', 'm.image', 'm.audio', 'm.video'].includes(String(event.content.msgtype))
      ? { attachment: { name: text(event.content) ?? '' } }
      : {}),
    ts: event.origin_server_ts,
    edited: !redacted && edit !== undefined,
    redacted,
    delivery: event.local ?? 'sent',
    replyTo: typeof replyTo === 'string' ? replyTo : null,
    ...(!redacted && event.sender !== me && mentions(event.content, me)
      ? { mentionsMe: true }
      : {}),
    reactions: redacted
      ? []
      : [...(reactions.get(event.event_id) ?? new Map<string, Set<string>>())].map(
          ([key, who]) => ({ key, count: who.size, mine: who.has(me) })
        ),
  }
}

/**
 * The messages of a room's main timeline, oldest first.
 *
 * A redacted event has lost its content, `m.relates_to` included. The store hands its relation
 * back when it saw the event before the redaction, so a deleted edit or thread reply stays out
 * of the main timeline; one never seen whole is shown as a deleted message.
 *
 * @param events the room's events in timeline order, as synced, local echoes last
 * @param me the signed-in member's Matrix user id
 */
export function timelineView(events: readonly TimelineEvent[], me: string): MessageView[] {
  const { edits, reactions } = collectRelations(events)
  const messages: MessageView[] = []
  for (const event of events) {
    if (event.type !== 'm.room.message') continue
    const rel = relation(event)
    // An edit is folded into its message; a thread reply belongs to its thread's panel.
    if (rel?.rel_type === 'm.replace' || rel?.rel_type === 'm.thread') continue
    messages.push(toMessageView(event, me, edits, reactions))
  }
  return messages
}

/**
 * The replies of a thread rooted at `rootEventId`, oldest first.
 *
 * @param events the room's events in timeline order, as synced, local echoes last
 * @param rootEventId the event id of the thread's parent message
 * @param me the signed-in member's Matrix user id
 */
export function threadView(
  events: readonly TimelineEvent[],
  rootEventId: string,
  me: string
): MessageView[] {
  const { edits, reactions } = collectRelations(events)
  const replies: MessageView[] = []
  for (const event of events) {
    if (event.type !== 'm.room.message') continue
    const rel = relation(event)
    if (rel?.rel_type !== 'm.thread' || rel.event_id !== rootEventId) continue
    replies.push(toMessageView(event, me, edits, reactions))
  }
  return replies
}

/** Who is in an audio room, from the room-access service's state event (design §2.2). */
export interface Occupancy {
  /** The members in the call, by Matrix user id, each once. */
  participants: string[]
  /** Those of them sharing a screen. */
  screenShare: string[]
}

const OCCUPANCY_VERSION = 1

/**
 * The `io.kodera.room.occupancy` content, or null when absent or not of that shape.
 *
 * The room-access service (kodera-core `room_access/`) is the producer and the source of truth:
 * `{"version": 1, "participants": [{"user_id", "devices", "screen_share", "camera"}, …],
 * "at_ms"}`. Fields this reader does not know are ignored, so the producer can add some; an
 * entry that is not of that shape is dropped and the others kept, rather than guessed at. Another
 * version is not read at all: its fields may no longer mean the same thing.
 */
export function occupancyOf(content: unknown): Occupancy | null {
  if (content === null || typeof content !== 'object') return null
  const { version, participants } = content as Record<string, unknown>
  if (version !== OCCUPANCY_VERSION || !Array.isArray(participants)) return null
  const inRoom: string[] = []
  const sharing: string[] = []
  for (const item of participants as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const {
      user_id: userId,
      devices,
      screen_share: screenShare,
      camera,
    } = item as Record<string, unknown>
    if (typeof userId !== 'string' || !userId.startsWith('@') || !userId.includes(':')) continue
    // In the call on at least one device: the producer counts each, and writes no entry with
    // none; an entry with 0, or no count, would put someone in the room who is not.
    if (!Number.isSafeInteger(devices) || (devices as number) < 1) continue
    if (screenShare !== undefined && typeof screenShare !== 'boolean') continue
    if (camera !== undefined && typeof camera !== 'boolean') continue
    if (inRoom.includes(userId)) continue
    inRoom.push(userId)
    if (screenShare === true) sharing.push(userId)
  }
  return { participants: inRoom, screenShare: sharing }
}
