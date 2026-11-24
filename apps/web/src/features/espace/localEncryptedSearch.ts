// Client-local encrypted full-text search engine for Espace timelines (`Track 7`, `H4.3a`).
//
// Unlocked E2EE rooms and verified workspace rooms are tokenized strictly on-device (`NFD`,
// accent-stripped, `>= 2` chars, `<= 64` unique terms/message, `<= 500` messages/room).
// Persisted shards in `'kodera.espace-vault.v1'` (`'search_index'` store) key their inverted
// postings dictionary via `HMAC-SHA-256(owner.indexKey, "kodera-local-fts-v1\0" + incarnation + "\0" + roomId + "\0" + token)`
// (128-bit hex blind tags) and seal the entire shard (`<= 512 KiB`) under `AES-256-GCM` (`owner.key`)
// with full principal + incarnation + roomId + boundaryTag + epoch AAD.
//
// Zero search queries or index terms ever leave the browser over HTTP or Matrix. Quarantine (`#180`),
// room leave/kick/403 (`forgetRoom`), vault revocation, and session logout synchronously evict
// in-memory postings before any async storage work settles.

import { registerEspaceVaultCleanup, registerLocalSessionCleanup } from '@/auth/localSession'
import {
  isRoomSearchPermitted,
  resolveRoomSearchBoundary,
  type ConfidentialChannelFlags,
  type RoomBoundaryReader,
  type UnlockedEncryptedRoomAuthority,
} from '../command-palette/omniboxIndex'
import {
  MAX_SEARCH_SHARD_BYTES,
  registerVaultSearchEviction,
  type EspaceVault,
  type SearchBoundaryTag,
} from './matrix/encryptedCache'
import type { MessageView } from './matrix/timeline'
import { MAX_RESULTS, queryTerms, searchMessages, type SearchResult } from './searchMatching'

export {
  isRoomSearchPermitted,
  MAX_SEARCH_SHARD_BYTES,
  resolveRoomSearchBoundary,
  type ConfidentialChannelFlags,
  type RoomBoundaryReader,
  type UnlockedEncryptedRoomAuthority,
}

export const MIN_SEARCH_TOKEN_LENGTH = 2
export const MAX_SEARCH_TOKEN_LENGTH = 64
export const MAX_TOKENS_PER_MESSAGE = 64
export const MAX_INDEXED_MESSAGES_PER_SHARD = 500
const MAX_SNIPPET_CHARS = 240
const BLIND_TAG_RE = /^[0-9a-f]{32}$/
const DIACRITICS = /\p{M}/gu
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/gu
const WHITESPACE = /\s+/gu

export interface VaultSearchShardDoc {
  readonly eventId: string
  readonly sender: string
  readonly senderName: string
  readonly timestamp: number
  readonly snippet: string
  readonly tokens?: readonly string[] | undefined
  readonly threadRootId?: string | undefined
}

export interface VaultSearchShardPayload {
  readonly v: 1
  readonly roomId: string
  readonly boundaryTag: SearchBoundaryTag
  readonly epoch: number
  readonly savedAt: number
  readonly postings: Readonly<Record<string, readonly string[]>>
  readonly docs: readonly VaultSearchShardDoc[]
}

export interface LocalEncryptedSearchHit {
  readonly roomId: string
  readonly eventId: string
  readonly sender: string
  readonly senderName: string
  readonly timestamp: number
  readonly snippet: string
  readonly boundaryTag: SearchBoundaryTag
  readonly epoch: number
  readonly threadRootId?: string | undefined
}

interface RamIndexedDoc {
  readonly eventId: string
  readonly sender: string
  readonly senderName: string
  readonly timestamp: number
  readonly snippet: string
  readonly threadRootId?: string | undefined
  readonly tokens: readonly string[]
}

interface RamRoomState {
  readonly roomId: string
  readonly boundaryTag: SearchBoundaryTag
  readonly epoch: number
  incarnation: string | null
  docsByEventId: Map<string, RamIndexedDoc>
  orderedDocs: RamIndexedDoc[]
  tokenPostings: Map<string, Set<string>>
  blindPostings: Map<string, Set<string>>
  timelineDigest: string
}

export function foldSearchText(raw: string): string {
  return raw.normalize('NFD').replace(DIACRITICS, '').toLowerCase()
}

export function tokenizeSearchText(
  raw: string,
  maxTokens: number = MAX_TOKENS_PER_MESSAGE
): string[] {
  if (typeof raw !== 'string' || raw.length === 0 || maxTokens <= 0) return []
  const folded = foldSearchText(raw)
  const parts = folded.split(TOKEN_SPLIT)
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (part.length < MIN_SEARCH_TOKEN_LENGTH) continue
    const token = part.length > MAX_SEARCH_TOKEN_LENGTH ? part.slice(0, MAX_SEARCH_TOKEN_LENGTH) : part
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
    if (out.length >= maxTokens) break
  }
  return out
}

function buildSnippet(body: string): string {
  const collapsed = body.replace(WHITESPACE, ' ').trim()
  return collapsed.length <= MAX_SNIPPET_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…`
}

function computeTimelineDigest(
  boundaryTag: SearchBoundaryTag,
  epoch: number,
  messages: readonly MessageView[]
): string {
  const first = messages[0]
  const last = messages[messages.length - 1]
  let redactedCount = 0
  for (let i = Math.max(0, messages.length - MAX_INDEXED_MESSAGES_PER_SHARD); i < messages.length; i += 1) {
    if (messages[i]?.redacted) redactedCount += 1
  }
  return `${boundaryTag}:${epoch}:${messages.length}:${first?.eventId ?? ''}:${first?.body?.length ?? 0}:${last?.eventId ?? ''}:${last?.body?.length ?? 0}:${redactedCount}`
}

function isValidShardDoc(value: unknown): value is VaultSearchShardDoc {
  if (!value || typeof value !== 'object') return false
  const doc = value as Record<string, unknown>
  return (
    typeof doc.eventId === 'string' &&
    doc.eventId.length > 0 &&
    doc.eventId.length <= 255 &&
    typeof doc.sender === 'string' &&
    doc.sender.length > 0 &&
    doc.sender.length <= 255 &&
    typeof doc.senderName === 'string' &&
    doc.senderName.length <= 255 &&
    typeof doc.timestamp === 'number' &&
    Number.isFinite(doc.timestamp) &&
    typeof doc.snippet === 'string' &&
    doc.snippet.length <= MAX_SNIPPET_CHARS + 16 &&
    (doc.tokens === undefined ||
      (Array.isArray(doc.tokens) &&
        doc.tokens.length <= MAX_TOKENS_PER_MESSAGE &&
        doc.tokens.every(
          (tok) =>
            typeof tok === 'string' &&
            tok.length >= MIN_SEARCH_TOKEN_LENGTH &&
            tok.length <= MAX_SEARCH_TOKEN_LENGTH
        ))) &&
    (doc.threadRootId === undefined ||
      (typeof doc.threadRootId === 'string' && doc.threadRootId.length <= 255))
  )
}

function isValidShardPayload(
  value: unknown,
  expectedRoomId: string,
  expectedBoundary: SearchBoundaryTag,
  expectedEpoch: number
): value is VaultSearchShardPayload {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  if (
    p.v !== 1 ||
    p.roomId !== expectedRoomId ||
    p.boundaryTag !== expectedBoundary ||
    p.epoch !== expectedEpoch ||
    typeof p.savedAt !== 'number' ||
    !Number.isFinite(p.savedAt) ||
    !Array.isArray(p.docs) ||
    p.docs.length > MAX_INDEXED_MESSAGES_PER_SHARD ||
    !p.docs.every(isValidShardDoc) ||
    !p.postings ||
    typeof p.postings !== 'object' ||
    Array.isArray(p.postings)
  ) {
    return false
  }
  for (const [tag, ids] of Object.entries(p.postings as Record<string, unknown>)) {
    if (!BLIND_TAG_RE.test(tag) || !Array.isArray(ids)) return false
    if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 255)) {
      return false
    }
  }
  return true
}

function scrubRamRoomState(state: RamRoomState): void {
  for (const set of state.tokenPostings.values()) set.clear()
  state.tokenPostings.clear()
  for (const set of state.blindPostings.values()) set.clear()
  state.blindPostings.clear()
  state.docsByEventId.clear()
  state.orderedDocs.length = 0
}

export class LocalEncryptedSearchEngine {
  readonly #rooms = new Map<string, RamRoomState>()
  readonly #roomSeq = new Map<string, number>()
  #allSeq = 0
  readonly #unsubVaultEviction: () => void

  constructor() {
    this.#unsubVaultEviction = registerVaultSearchEviction((event) => {
      if (event.kind === 'all') {
        this.clearAll()
      } else if (event.kind === 'room' && event.roomId !== undefined) {
        this.evictRoom(event.roomId)
      }
    })
  }

  dispose(): void {
    this.#unsubVaultEviction()
    this.clearAll()
  }

  get indexedRoomCount(): number {
    return this.#rooms.size
  }

  hasRoom(roomId: string): boolean {
    return this.#rooms.has(roomId)
  }

  #bumpRoomSeq(roomId: string): number {
    const next = (this.#roomSeq.get(roomId) ?? 0) + 1
    this.#roomSeq.set(roomId, next)
    return next
  }

  /** Synchronously scrubs a single room's RAM postings and cancels in-flight shard writes. */
  evictRoom(roomId: string): void {
    this.#bumpRoomSeq(roomId)
    const existing = this.#rooms.get(roomId)
    if (existing !== undefined) {
      this.#rooms.delete(roomId)
      scrubRamRoomState(existing)
    }
  }

  /** Synchronously scrubs all rooms' RAM postings across the engine. */
  clearAll(): void {
    this.#allSeq += 1
    for (const [roomId, state] of this.#rooms) {
      this.#bumpRoomSeq(roomId)
      scrubRamRoomState(state)
    }
    this.#rooms.clear()
  }

  #extractBoundedDocs(messages: readonly MessageView[]): RamIndexedDoc[] {
    const kept: RamIndexedDoc[] = []
    for (let i = messages.length - 1; i >= 0 && kept.length < MAX_INDEXED_MESSAGES_PER_SHARD; i -= 1) {
      const msg = messages[i]
      if (
        msg === undefined ||
        msg.redacted ||
        typeof msg.eventId !== 'string' ||
        msg.eventId.length === 0 ||
        typeof msg.body !== 'string' ||
        msg.body.trim().length === 0
      ) {
        continue
      }
      const senderName = (msg.senderName?.trim() || msg.sender).slice(0, 255)
      const tokens = tokenizeSearchText(`${msg.body} ${senderName}`, MAX_TOKENS_PER_MESSAGE)
      if (tokens.length === 0) continue
      kept.push({
        eventId: msg.eventId,
        sender: msg.sender,
        senderName,
        timestamp: msg.ts,
        snippet: buildSnippet(msg.body),
        tokens,
      })
    }
    // `kept` is already newest-first.
    return kept
  }

  /**
   * Synchronously indexes a permitted room's decrypted timeline in RAM (`zero` network calls).
   * Refuses locked, quarantined (`#180`), unknown, or invalid rooms and immediately evicts stale RAM state.
   */
  indexRoomSync(input: {
    readonly store: RoomBoundaryReader
    readonly roomId: string
    readonly channel?: ConfidentialChannelFlags | null | undefined
    readonly messages: readonly MessageView[]
  }): boolean {
    const resolved = resolveRoomSearchBoundary(input.store, input.roomId, input.channel)
    if (resolved === null) {
      this.evictRoom(input.roomId)
      return false
    }

    const digest = computeTimelineDigest(resolved.boundaryTag, resolved.epoch, input.messages)
    const current = this.#rooms.get(input.roomId)
    if (
      current !== undefined &&
      current.boundaryTag === resolved.boundaryTag &&
      current.epoch === resolved.epoch &&
      current.timelineDigest === digest
    ) {
      return true
    }

    const docs = this.#extractBoundedDocs(input.messages)
    if (docs.length === 0) {
      this.evictRoom(input.roomId)
      return true
    }

    const docsByEventId = new Map<string, RamIndexedDoc>()
    const tokenPostings = new Map<string, Set<string>>()
    for (const doc of docs) {
      docsByEventId.set(doc.eventId, doc)
      for (const token of doc.tokens) {
        let bucket = tokenPostings.get(token)
        if (bucket === undefined) {
          bucket = new Set()
          tokenPostings.set(token, bucket)
        }
        bucket.add(doc.eventId)
      }
    }

    if (current !== undefined) {
      scrubRamRoomState(current)
    }

    this.#rooms.set(input.roomId, {
      roomId: input.roomId,
      boundaryTag: resolved.boundaryTag,
      epoch: resolved.epoch,
      incarnation: null,
      docsByEventId,
      orderedDocs: docs,
      tokenPostings,
      blindPostings: new Map(),
      timelineDigest: digest,
    })
    return true
  }

  /**
   * Indexes a permitted room's decrypted timeline in RAM and seals its blind-tagged shard (`<= 512 KiB`)
   * into `EspaceVault`'s `'search_index'` store when `vault` is supplied.
   */
  async indexRoom(input: {
    readonly store: RoomBoundaryReader
    readonly roomId: string
    readonly channel?: ConfidentialChannelFlags | null | undefined
    readonly messages: readonly MessageView[]
    readonly vault?: EspaceVault | null | undefined
  }): Promise<boolean> {
    const resolved = resolveRoomSearchBoundary(input.store, input.roomId, input.channel)
    if (resolved === null) {
      this.evictRoom(input.roomId)
      if (input.vault && !input.vault.isClosed) {
        await input.vault.deleteSearchIndexShard(input.roomId).catch(() => undefined)
      }
      return false
    }

    const startAllSeq = this.#allSeq
    const startRoomSeq = this.#bumpRoomSeq(input.roomId)
    const docs = this.#extractBoundedDocs(input.messages)
    if (docs.length === 0) {
      const prior = this.#rooms.get(input.roomId)
      if (prior !== undefined) {
        this.#rooms.delete(input.roomId)
        scrubRamRoomState(prior)
      }
      if (input.vault && !input.vault.isClosed) {
        await input.vault.deleteSearchIndexShard(input.roomId).catch(() => undefined)
      }
      return true
    }

    // Fit within `MAX_SEARCH_SHARD_BYTES` (`512 KiB`) by dropping oldest tail messages if needed.
    let keptDocs = docs
    const vault = input.vault ?? null

    const buildStateAndPersist = async (subset: RamIndexedDoc[]): Promise<{
      docsByEventId: Map<string, RamIndexedDoc>
      tokenPostings: Map<string, Set<string>>
      blindPostings: Map<string, Set<string>>
      incarnation: string | null
      shardPayload: VaultSearchShardPayload | null
    }> => {
      const docsByEventId = new Map<string, RamIndexedDoc>()
      const tokenPostings = new Map<string, Set<string>>()
      for (const doc of subset) {
        docsByEventId.set(doc.eventId, doc)
        for (const token of doc.tokens) {
          let set = tokenPostings.get(token)
          if (set === undefined) {
            set = new Set()
            tokenPostings.set(token, set)
          }
          set.add(doc.eventId)
        }
      }

      if (vault === null || vault.isClosed) {
        return {
          docsByEventId,
          tokenPostings,
          blindPostings: new Map(),
          incarnation: null,
          shardPayload: null,
        }
      }

      const blindPostings = new Map<string, Set<string>>()
      const rawPostings: Record<string, string[]> = {}
      const incarnation = vault.incarnation
      for (const [token, eventIds] of tokenPostings) {
        const tag = await vault.computeBlindTermTag(input.roomId, token)
        blindPostings.set(tag, new Set(eventIds))
        rawPostings[tag] = [...eventIds]
      }
      const shardDocs: VaultSearchShardDoc[] = subset.map((d) => ({
        eventId: d.eventId,
        sender: d.sender,
        senderName: d.senderName,
        timestamp: d.timestamp,
        snippet: d.snippet,
        tokens: [...d.tokens],
        ...(d.threadRootId === undefined ? {} : { threadRootId: d.threadRootId }),
      }))
      const shardPayload: VaultSearchShardPayload = {
        v: 1,
        roomId: input.roomId,
        boundaryTag: resolved.boundaryTag,
        epoch: resolved.epoch,
        savedAt: Date.now(),
        postings: rawPostings,
        docs: shardDocs,
      }
      return { docsByEventId, tokenPostings, blindPostings, incarnation, shardPayload }
    }

    let built = await buildStateAndPersist(keptDocs)
    while (
      built.shardPayload !== null &&
      new TextEncoder().encode(JSON.stringify(built.shardPayload)).byteLength > MAX_SEARCH_SHARD_BYTES &&
      keptDocs.length > 1
    ) {
      keptDocs = keptDocs.slice(0, Math.max(1, Math.floor(keptDocs.length * 0.75)))
      built = await buildStateAndPersist(keptDocs)
    }

    // Re-check live authority and eviction fences after async WebCrypto calls!
    const rechecked = resolveRoomSearchBoundary(input.store, input.roomId, input.channel)
    if (
      this.#allSeq !== startAllSeq ||
      this.#roomSeq.get(input.roomId) !== startRoomSeq ||
      rechecked === null ||
      rechecked.boundaryTag !== resolved.boundaryTag ||
      rechecked.epoch !== resolved.epoch
    ) {
      return false
    }

    if (vault !== null && !vault.isClosed && built.shardPayload !== null) {
      await vault.putSearchIndexShard({
        roomId: input.roomId,
        boundaryTag: resolved.boundaryTag,
        epoch: resolved.epoch,
        savedAt: built.shardPayload.savedAt,
        payload: built.shardPayload,
      })
      if (
        this.#allSeq !== startAllSeq ||
        this.#roomSeq.get(input.roomId) !== startRoomSeq ||
        resolveRoomSearchBoundary(input.store, input.roomId, input.channel) === null
      ) {
        this.evictRoom(input.roomId)
        await vault.deleteSearchIndexShard(input.roomId).catch(() => undefined)
        return false
      }
    }

    const existing = this.#rooms.get(input.roomId)
    if (existing !== undefined) scrubRamRoomState(existing)
    this.#rooms.set(input.roomId, {
      roomId: input.roomId,
      boundaryTag: resolved.boundaryTag,
      epoch: resolved.epoch,
      incarnation: vault !== null && !vault.isClosed ? vault.incarnation : built.incarnation,
      docsByEventId: built.docsByEventId,
      orderedDocs: keptDocs,
      tokenPostings: built.tokenPostings,
      blindPostings: built.blindPostings,
      timelineDigest: computeTimelineDigest(resolved.boundaryTag, resolved.epoch, input.messages),
    })
    return true
  }

  /** Hydrates a permitted room's encrypted search shard from `EspaceVault` into RAM on cold start. */
  async hydrateRoomFromVault(input: {
    readonly store: RoomBoundaryReader
    readonly roomId: string
    readonly channel?: ConfidentialChannelFlags | null | undefined
    readonly vault: EspaceVault
  }): Promise<boolean> {
    const resolved = resolveRoomSearchBoundary(input.store, input.roomId, input.channel)
    if (resolved === null || input.vault.isClosed) {
      this.evictRoom(input.roomId)
      return false
    }

    const startAllSeq = this.#allSeq
    const startRoomSeq = this.#bumpRoomSeq(input.roomId)
    const loaded = await input.vault.readSearchIndexShard(input.roomId, {
      boundaryTag: resolved.boundaryTag,
      epoch: resolved.epoch,
    })
    if (loaded === null) return false

    if (
      this.#allSeq !== startAllSeq ||
      this.#roomSeq.get(input.roomId) !== startRoomSeq ||
      resolveRoomSearchBoundary(input.store, input.roomId, input.channel) === null
    ) {
      return false
    }

    if (
      !isValidShardPayload(loaded.payload, input.roomId, resolved.boundaryTag, resolved.epoch)
    ) {
      await input.vault.deleteSearchIndexShard(input.roomId).catch(() => undefined)
      return false
    }

    const docsByEventId = new Map<string, RamIndexedDoc>()
    const orderedDocs: RamIndexedDoc[] = []
    const tokenPostings = new Map<string, Set<string>>()
    for (const d of loaded.payload.docs) {
      const persistedTokens =
        d.tokens !== undefined && d.tokens.length > 0
          ? [...d.tokens]
          : tokenizeSearchText(`${d.snippet} ${d.senderName}`, MAX_TOKENS_PER_MESSAGE)
      const ramDoc: RamIndexedDoc = {
        eventId: d.eventId,
        sender: d.sender,
        senderName: d.senderName,
        timestamp: d.timestamp,
        snippet: d.snippet,
        ...(d.threadRootId === undefined ? {} : { threadRootId: d.threadRootId }),
        tokens: persistedTokens,
      }
      docsByEventId.set(d.eventId, ramDoc)
      orderedDocs.push(ramDoc)
      for (const t of persistedTokens) {
        let bucket = tokenPostings.get(t)
        if (bucket === undefined) {
          bucket = new Set()
          tokenPostings.set(t, bucket)
        }
        bucket.add(d.eventId)
      }
    }

    const blindPostings = new Map<string, Set<string>>()
    for (const [tag, ids] of Object.entries(loaded.payload.postings)) {
      const validIds = ids.filter((id) => docsByEventId.has(id))
      if (validIds.length > 0) blindPostings.set(tag, new Set(validIds))
    }

    const existing = this.#rooms.get(input.roomId)
    if (existing !== undefined) scrubRamRoomState(existing)
    this.#rooms.set(input.roomId, {
      roomId: input.roomId,
      boundaryTag: resolved.boundaryTag,
      epoch: resolved.epoch,
      incarnation: loaded.incarnation,
      docsByEventId,
      orderedDocs,
      tokenPostings,
      blindPostings,
      timelineDigest: `hydrated:${loaded.incarnation}:${loaded.savedAt}`,
    })
    return true
  }

  async #rekeyRoomForVault(state: RamRoomState, vault: EspaceVault): Promise<void> {
    if (vault.isClosed) return
    const nextBlind = new Map<string, Set<string>>()
    const rawPostings: Record<string, string[]> = {}
    for (const [token, ids] of state.tokenPostings) {
      const tag = await vault.computeBlindTermTag(state.roomId, token)
      nextBlind.set(tag, new Set(ids))
      rawPostings[tag] = [...ids]
    }
    state.blindPostings = nextBlind
    state.incarnation = vault.incarnation
    const payload: VaultSearchShardPayload = {
      v: 1,
      roomId: state.roomId,
      boundaryTag: state.boundaryTag,
      epoch: state.epoch,
      savedAt: Date.now(),
      postings: rawPostings,
      docs: state.orderedDocs.map((d) => ({
        eventId: d.eventId,
        sender: d.sender,
        senderName: d.senderName,
        timestamp: d.timestamp,
        snippet: d.snippet,
        tokens: [...d.tokens],
        ...(d.threadRootId === undefined ? {} : { threadRootId: d.threadRootId }),
      })),
    }
    await vault
      .putSearchIndexShard({
        roomId: state.roomId,
        boundaryTag: state.boundaryTag,
        epoch: state.epoch,
        savedAt: payload.savedAt,
        payload,
      })
      .catch(() => undefined)
  }

  /**
   * Queries indexed rooms using blind `HMAC-SHA-256` term tags when `vault` is supplied (re-keying
   * surviving rooms transparently if another room's purge rotated `vault.incarnation`), with live
   * `#180` boundary re-verification and zero network egress.
   */
  async search(input: {
    readonly store: RoomBoundaryReader
    readonly query: string
    readonly roomIds?: readonly string[] | undefined
    readonly channelsByRoomId?: ReadonlyMap<string, ConfidentialChannelFlags> | undefined
    readonly vault?: EspaceVault | null | undefined
    readonly limit?: number | undefined
  }): Promise<readonly LocalEncryptedSearchHit[]> {
    const searchStartAllSeq = this.#allSeq
    const queryTokens = tokenizeSearchText(input.query, 16)
    if (queryTokens.length === 0) return []
    const limit = input.limit ?? MAX_RESULTS
    const candidates =
      input.roomIds !== undefined
        ? input.roomIds
            .map((id) => this.#rooms.get(id))
            .filter((s): s is RamRoomState => s !== undefined)
        : [...this.#rooms.values()]

    const roomSeqSnapshot = new Map<string, number>()
    for (const s of candidates) {
      roomSeqSnapshot.set(s.roomId, this.#roomSeq.get(s.roomId) ?? 0)
    }

    const hits: LocalEncryptedSearchHit[] = []
    const vault = input.vault ?? null

    const isRoomStillCurrent = (
      state: RamRoomState,
      expectedRoomSeq: number,
      channel: ConfidentialChannelFlags | undefined
    ): boolean => {
      if (this.#allSeq !== searchStartAllSeq) return false
      if ((this.#roomSeq.get(state.roomId) ?? 0) !== expectedRoomSeq) return false
      if (this.#rooms.get(state.roomId) !== state) return false
      const liveBoundary = resolveRoomSearchBoundary(input.store, state.roomId, channel)
      return (
        liveBoundary !== null &&
        liveBoundary.boundaryTag === state.boundaryTag &&
        liveBoundary.epoch === state.epoch
      )
    }

    for (const state of candidates) {
      if (this.#allSeq !== searchStartAllSeq) return []
      const expectedRoomSeq = roomSeqSnapshot.get(state.roomId) ?? 0
      const channel = input.channelsByRoomId?.get(state.roomId)
      if (!isRoomStillCurrent(state, expectedRoomSeq, channel)) {
        if (resolveRoomSearchBoundary(input.store, state.roomId, channel) === null) {
          this.evictRoom(state.roomId)
        }
        continue
      }

      let matchedIds: Set<string> | null = null
      let evictedMidAwait = false
      if (vault !== null && !vault.isClosed) {
        if (state.incarnation !== vault.incarnation && state.tokenPostings.size > 0) {
          await this.#rekeyRoomForVault(state, vault)
          if (this.#allSeq !== searchStartAllSeq) return []
          if (!isRoomStillCurrent(state, expectedRoomSeq, channel)) continue
        }
        if (state.incarnation === vault.incarnation && state.blindPostings.size > 0) {
          for (const token of queryTokens) {
            if (!isRoomStillCurrent(state, expectedRoomSeq, channel)) {
              evictedMidAwait = true
              break
            }
            const blindTag = await vault.computeBlindTermTag(state.roomId, token)
            if (this.#allSeq !== searchStartAllSeq) return []
            if (!isRoomStillCurrent(state, expectedRoomSeq, channel)) {
              evictedMidAwait = true
              break
            }
            const termMatches = new Set<string>()
            const exactPosting = state.blindPostings.get(blindTag)
            if (exactPosting !== undefined) {
              for (const id of exactPosting) termMatches.add(id)
            }
            // Consistent prefix matching across vault-backed and RAM-only searches:
            for (const [indexedToken] of state.tokenPostings) {
              if (indexedToken !== token && indexedToken.startsWith(token)) {
                const prefixTag = await vault.computeBlindTermTag(state.roomId, indexedToken)
                if (this.#allSeq !== searchStartAllSeq) return []
                if (!isRoomStillCurrent(state, expectedRoomSeq, channel)) {
                  evictedMidAwait = true
                  break
                }
                const prefixPosting = state.blindPostings.get(prefixTag)
                if (prefixPosting !== undefined) {
                  for (const id of prefixPosting) termMatches.add(id)
                }
              }
            }
            if (evictedMidAwait) break
            if (termMatches.size === 0) {
              matchedIds = new Set()
              break
            }
            if (matchedIds === null) {
              matchedIds = termMatches
            } else {
              for (const id of [...matchedIds]) {
                if (!termMatches.has(id)) matchedIds.delete(id)
              }
            }
            if (matchedIds.size === 0) break
          }
        }
      }
      if (this.#allSeq !== searchStartAllSeq) return []
      if (evictedMidAwait || !isRoomStillCurrent(state, expectedRoomSeq, channel)) continue

      if (matchedIds === null) {
        for (const token of queryTokens) {
          const exact = state.tokenPostings.get(token)
          const prefixIds = new Set<string>()
          if (exact !== undefined) {
            for (const id of exact) prefixIds.add(id)
          }
          for (const [indexedToken, ids] of state.tokenPostings) {
            if (indexedToken.startsWith(token)) {
              for (const id of ids) prefixIds.add(id)
            }
          }
          if (prefixIds.size === 0) {
            matchedIds = new Set()
            break
          }
          if (matchedIds === null) {
            matchedIds = prefixIds
          } else {
            for (const id of [...matchedIds]) {
              if (!prefixIds.has(id)) matchedIds.delete(id)
            }
          }
          if (matchedIds.size === 0) break
        }
      }

      if (matchedIds === null || matchedIds.size === 0) continue
      if (!isRoomStillCurrent(state, expectedRoomSeq, channel)) continue

      for (const doc of state.orderedDocs) {
        if (!matchedIds.has(doc.eventId)) continue
        hits.push({
          roomId: state.roomId,
          eventId: doc.eventId,
          sender: doc.sender,
          senderName: doc.senderName,
          timestamp: doc.timestamp,
          snippet: doc.snippet,
          boundaryTag: state.boundaryTag,
          epoch: state.epoch,
          ...(doc.threadRootId === undefined ? {} : { threadRootId: doc.threadRootId }),
        })
      }
    }

    if (this.#allSeq !== searchStartAllSeq) return []
    const verifiedHits = hits.filter((hit) => {
      const state = this.#rooms.get(hit.roomId)
      const expectedSeq = roomSeqSnapshot.get(hit.roomId)
      if (state === undefined || expectedSeq === undefined) return false
      return isRoomStillCurrent(state, expectedSeq, input.channelsByRoomId?.get(hit.roomId))
    })
    verifiedHits.sort((a, b) => b.timestamp - a.timestamp || a.eventId.localeCompare(b.eventId))
    return verifiedHits.slice(0, limit)
  }
}

export const workspaceLocalEncryptedSearch = new LocalEncryptedSearchEngine()

registerEspaceVaultCleanup(() => {
  workspaceLocalEncryptedSearch.clearAll()
})
registerLocalSessionCleanup(() => {
  workspaceLocalEncryptedSearch.clearAll()
})

export interface SearchableStoreLike extends RoomBoundaryReader {
  readonly getTimeline: (roomId: string) => readonly MessageView[]
  readonly getSearchVault?: (() => Promise<EspaceVault | undefined>) | undefined
}

/**
 * Synchronous local search helper for channel header `MessageSearch`:
 * enforces `#180` quarantine + unlocked E2EE room authority when `getRoomBoundary` or
 * `isRoomQuarantined` is present on `store`, keeps decrypted E2EE shards synced in
 * `workspaceLocalEncryptedSearch`, and issues zero network calls.
 */
export function searchRoomTimelineLocally(
  store: SearchableStoreLike,
  roomId: string,
  query: string,
  channel?: ConfidentialChannelFlags | null | undefined
): SearchResult {
  if (queryTerms(query).length === 0) return { messages: [], more: false }
  if (store.isRoomQuarantined?.(roomId) === true) {
    workspaceLocalEncryptedSearch.evictRoom(roomId)
    return { messages: [], more: false }
  }
  if (store.getRoomBoundary !== undefined) {
    if (!isRoomSearchPermitted(store, roomId, channel)) {
      workspaceLocalEncryptedSearch.evictRoom(roomId)
      return { messages: [], more: false }
    }
    const timeline = store.getTimeline(roomId)
    workspaceLocalEncryptedSearch.indexRoomSync({
      store,
      roomId,
      channel,
      messages: timeline,
    })
    if (store.getSearchVault !== undefined) {
      void store.getSearchVault().then((vault) => {
        if (vault !== undefined && !vault.isClosed) {
          void workspaceLocalEncryptedSearch.indexRoom({
            store,
            roomId,
            channel,
            messages: timeline,
            vault,
          })
        }
      })
    }
    return searchMessages(timeline, query)
  }
  // Stateless UI preview adapter without boundary tracker (e.g. local pins/find component preview).
  return searchMessages(store.getTimeline(roomId), query)
}
