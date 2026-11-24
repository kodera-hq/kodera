import { permitsPlaintext, type RoomBoundary } from '../confidential/room-boundary'
import type { SearchBoundaryTag } from '../espace/matrix/encryptedCache'
import type { MessageView } from '../espace/matrix/timeline'

export const MIN_OMNIBOX_QUERY_LENGTH = 2
export const MAX_INDEXED_MESSAGES_PER_ROOM = 500
export const DEFAULT_MESSAGE_LIMIT = 20
export const DEFAULT_COLLECTION_LIMIT = 15

export interface UnlockedEncryptedRoomAuthority {
  readonly unlocked: true
  readonly epoch: number
}

export interface RoomBoundaryReader {
  readonly getRoomBoundary?: ((roomId: string) => RoomBoundary) | undefined
  readonly isRoomQuarantined?: ((roomId: string) => boolean) | undefined
  readonly getUnlockedEncryptedRoomSearchAuthority?:
    | ((roomId: string) => UnlockedEncryptedRoomAuthority | null)
    | undefined
}

export interface ConfidentialChannelFlags {
  readonly isConfidential?: boolean | undefined
  readonly is_confidential?: boolean | undefined
}

export interface ResolvedRoomSearchBoundary {
  readonly boundaryTag: SearchBoundaryTag
  readonly epoch: number
}

export function resolveRoomSearchBoundary(
  store: RoomBoundaryReader,
  roomId: string,
  channel?: ConfidentialChannelFlags | null | undefined
): ResolvedRoomSearchBoundary | null {
  if (store.isRoomQuarantined?.(roomId) === true) return null
  if (store.getRoomBoundary === undefined) return null

  const boundary = store.getRoomBoundary(roomId)
  if (boundary === 'unknown' || boundary === 'invalid') return null

  const unlockedAuthority = store.getUnlockedEncryptedRoomSearchAuthority?.(roomId) ?? null
  if (
    unlockedAuthority !== null &&
    unlockedAuthority.unlocked &&
    typeof unlockedAuthority.epoch === 'number' &&
    Number.isSafeInteger(unlockedAuthority.epoch) &&
    unlockedAuthority.epoch >= 1
  ) {
    return {
      boundaryTag: 'confidential-e2ee',
      epoch: unlockedAuthority.epoch,
    }
  }

  if (channel?.isConfidential === true || channel?.is_confidential === true) return null
  if (!permitsPlaintext(boundary) || (boundary !== 'ordinary' && boundary !== 'community')) {
    return null
  }
  return {
    boundaryTag: boundary,
    epoch: 0,
  }
}

export function isRoomSearchPermitted(
  store: RoomBoundaryReader,
  roomId: string,
  channel?: ConfidentialChannelFlags | null | undefined
): boolean {
  return resolveRoomSearchBoundary(store, roomId, channel) !== null
}

const DIACRITICS = /\p{M}/gu
const SPACES = /\s+/gu

export function foldOmniboxText(value: string): string {
  return value.normalize('NFD').replace(DIACRITICS, '').toLowerCase().replace(SPACES, ' ').trim()
}

export interface IndexedMessageRecord {
  readonly message: MessageView
  readonly body: string
  readonly senderKey: string
  readonly haystack: string
}

export interface OmniboxRoomSource {
  readonly roomId: string
  readonly targetId: string
  readonly isDirect: boolean
  readonly label: string
  readonly channel?: ConfidentialChannelFlags | null | undefined
  readonly timeline: readonly MessageView[]
}

export interface OmniboxCollectionDescriptor {
  readonly id: string
  readonly title: string
  readonly propertiesText?: string | undefined
  readonly content?: string | undefined
  readonly cacheKey?: object | undefined
}

interface IndexedRoom {
  readonly roomId: string
  readonly targetId: string
  readonly isDirect: boolean
  readonly label: string
  readonly foldedLabel: string
  readonly records: readonly IndexedMessageRecord[]
}

interface IndexedCollectionRecord {
  readonly id: string
  readonly title: string
  readonly haystack: string
  readonly snippet: string
}

export interface OmniboxIndex {
  readonly rooms: readonly IndexedRoom[]
  readonly collections: readonly IndexedCollectionRecord[]
}

export interface OmniboxMessageHit {
  readonly id: string
  readonly roomId: string
  readonly targetId: string
  readonly isDirect: boolean
  readonly roomLabel: string
  readonly eventId: string
  readonly senderLabel: string
  readonly snippet: string
  readonly ts: number
}

export interface OmniboxCollectionHit {
  readonly id: string
  readonly title: string
  readonly snippet: string
}

interface CachedMessageEntry {
  readonly body: string
  readonly senderKey: string
  readonly haystack: string
}

interface CachedTimelineEntry {
  readonly length: number
  readonly firstKey: string
  readonly firstBody: string
  readonly lastKey: string
  readonly lastBody: string
  readonly redactedCount: number
  readonly records: readonly IndexedMessageRecord[]
}

interface CachedCollectionEntry {
  readonly id: string
  readonly title: string
  readonly propsText: string
  readonly bodyPreview: string
  readonly record: IndexedCollectionRecord
}

const messageHaystacks = new WeakMap<MessageView, CachedMessageEntry>()
const timelineCache = new WeakMap<readonly MessageView[], CachedTimelineEntry>()
const collectionCache = new WeakMap<object, CachedCollectionEntry>()

function cleanSnippet(raw: string, maxLen = 88): string {
  const plain = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\x23{1,6}\s+/gm, ' ')
    .replace(/^[>\-*+]+\s+/gm, ' ')
    .replace(/[\x60*_~]/g, '')
    .replace(SPACES, ' ')
    .trim()
  return plain.length <= maxLen ? plain : `${plain.slice(0, maxLen - 1).trimEnd()}…`
}

function isTimelineCacheValid(
  timeline: readonly MessageView[],
  cached: CachedTimelineEntry
): boolean {
  const len = timeline.length
  if (cached.length !== len) return false
  const first = timeline[0]
  const last = timeline[len - 1]
  if (
    cached.firstKey !== (first?.key ?? '') ||
    cached.firstBody !== (typeof first?.body === 'string' ? first.body : '') ||
    cached.lastKey !== (last?.key ?? '') ||
    cached.lastBody !== (typeof last?.body === 'string' ? last.body : '')
  ) {
    return false
  }
  let redactedCount = 0
  let kept = 0
  for (let i = len - 1; i >= 0 && kept < MAX_INDEXED_MESSAGES_PER_ROOM; i--) {
    const msg = timeline[i]!
    if (msg.redacted) {
      redactedCount++
      continue
    }
    if (typeof msg.body !== 'string' || msg.body.trim() === '') continue
    const rec = cached.records[kept]
    const senderKey = msg.senderName ?? msg.sender ?? ''
    if (
      rec === undefined ||
      rec.message !== msg ||
      rec.body !== msg.body ||
      rec.senderKey !== senderKey
    ) {
      return false
    }
    kept++
  }
  return kept === cached.records.length && redactedCount === cached.redactedCount
}

function recordsForTimeline(timeline: readonly MessageView[]): readonly IndexedMessageRecord[] {
  const cached = timelineCache.get(timeline)
  if (cached !== undefined && isTimelineCacheValid(timeline, cached)) return cached.records
  const records: IndexedMessageRecord[] = []
  let redactedCount = 0
  for (let i = timeline.length - 1; i >= 0 && records.length < MAX_INDEXED_MESSAGES_PER_ROOM; i--) {
    const message = timeline[i]!
    if (message.redacted) {
      redactedCount++
      continue
    }
    if (typeof message.body !== 'string' || message.body.trim() === '') continue
    const senderKey = message.senderName ?? message.sender ?? ''
    const existing = messageHaystacks.get(message)
    let haystack: string
    if (
      existing !== undefined &&
      existing.body === message.body &&
      existing.senderKey === senderKey
    ) {
      haystack = existing.haystack
    } else {
      haystack = foldOmniboxText(`${message.body} ${senderKey}`)
      messageHaystacks.set(message, { body: message.body, senderKey, haystack })
    }
    records.push({ message, body: message.body, senderKey, haystack })
  }
  const first = timeline[0]
  const last = timeline[timeline.length - 1]
  timelineCache.set(timeline, {
    length: timeline.length,
    firstKey: first?.key ?? '',
    firstBody: typeof first?.body === 'string' ? first.body : '',
    lastKey: last?.key ?? '',
    lastBody: typeof last?.body === 'string' ? last.body : '',
    redactedCount,
    records,
  })
  return records
}

export function buildOmniboxIndex(input: {
  readonly store: RoomBoundaryReader
  readonly rooms: readonly OmniboxRoomSource[]
  readonly collections?: readonly OmniboxCollectionDescriptor[] | undefined
}): OmniboxIndex {
  const rooms: IndexedRoom[] = []
  for (const room of input.rooms) {
    if (!isRoomSearchPermitted(input.store, room.roomId, room.channel)) continue
    const records = recordsForTimeline(room.timeline)
    if (records.length === 0) continue
    rooms.push({
      roomId: room.roomId,
      targetId: room.targetId,
      isDirect: room.isDirect,
      label: room.label,
      foldedLabel: foldOmniboxText(room.label),
      records,
    })
  }
  const collections: IndexedCollectionRecord[] = []
  for (const item of input.collections ?? []) {
    const key = item.cacheKey ?? item
    const bodyPreview = (item.content ?? '').slice(0, 800)
    const propsText = item.propertiesText ?? ''
    const existing = collectionCache.get(key)
    let indexed: IndexedCollectionRecord
    if (
      existing !== undefined &&
      existing.id === item.id &&
      existing.title === item.title &&
      existing.propsText === propsText &&
      existing.bodyPreview === bodyPreview
    ) {
      indexed = existing.record
    } else {
      indexed = {
        id: item.id,
        title: item.title,
        haystack: foldOmniboxText(`${item.title} ${propsText} ${bodyPreview}`),
        snippet: cleanSnippet(propsText || bodyPreview),
      }
      collectionCache.set(key, {
        id: item.id,
        title: item.title,
        propsText,
        bodyPreview,
        record: indexed,
      })
    }
    collections.push(indexed)
  }
  return { rooms, collections }
}

export function queryOmnibox(
  index: OmniboxIndex,
  rawQuery: string,
  limits?: { readonly messages?: number; readonly collections?: number }
): {
  readonly messages: readonly OmniboxMessageHit[]
  readonly collections: readonly OmniboxCollectionHit[]
} {
  const folded = foldOmniboxText(rawQuery)
  if (folded.length < MIN_OMNIBOX_QUERY_LENGTH) return { messages: [], collections: [] }
  const terms = folded.split(' ')
  const messageCap = limits?.messages ?? DEFAULT_MESSAGE_LIMIT
  const collectionCap = limits?.collections ?? DEFAULT_COLLECTION_LIMIT

  const rawMatches: { readonly room: IndexedRoom; readonly message: MessageView }[] = []
  for (const room of index.rooms) {
    for (const record of room.records) {
      const liveSenderKey = record.message.senderName ?? record.message.sender ?? ''
      if (
        record.message.redacted ||
        record.message.body !== record.body ||
        liveSenderKey !== record.senderKey
      ) {
        continue
      }
      let bodyMatched = false
      let allMatched = true
      for (const term of terms) {
        if (record.haystack.includes(term)) bodyMatched = true
        else if (!room.foldedLabel.includes(term)) {
          allMatched = false
          break
        }
      }
      if (allMatched && bodyMatched) rawMatches.push({ room, message: record.message })
    }
  }
  rawMatches.sort((a, b) => b.message.ts - a.message.ts)

  const messages: OmniboxMessageHit[] = rawMatches
    .slice(0, messageCap)
    .map(({ room, message }) => ({
      id: `omnibox:message:${room.roomId}:${message.eventId}`,
      roomId: room.roomId,
      targetId: room.targetId,
      isDirect: room.isDirect,
      roomLabel: room.label,
      eventId: message.eventId,
      senderLabel: message.senderName?.trim() || message.sender,
      snippet: cleanSnippet(message.body),
      ts: message.ts,
    }))

  const collections: OmniboxCollectionHit[] = []
  for (const item of index.collections) {
    if (terms.every((term) => item.haystack.includes(term))) {
      collections.push({ id: item.id, title: item.title, snippet: item.snippet })
      if (collections.length >= collectionCap) break
    }
  }
  return { messages, collections }
}
