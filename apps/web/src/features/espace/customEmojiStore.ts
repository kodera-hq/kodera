// Workspace custom WebP emoji store with CSP-safe blob: object URLs (img-src 'self' blob:)
// and deterministic URL.revokeObjectURL cleanup on removal, org switch, or logout.

import { useEffect, useSyncExternalStore } from 'react'
import {
  registerEspaceVaultCleanup,
  registerLocalSessionCleanup,
  registerOrganisationSwitchCleanup,
} from '../../auth/localSession'
import {
  fetchWorkspaceCustomEmojiBlob,
  listWorkspaceCustomEmojis,
  useExperiencePreferences,
  type WorkspaceCustomEmojiItem,
} from './experienceApi'

export const MAX_BLOB_CACHE_ENTRIES = 200
const EMPTY_ITEMS: readonly WorkspaceCustomEmojiItem[] = Object.freeze([])
const EMPTY_SET: ReadonlySet<string> = new Set()

interface OrgEmojiState {
  readonly items: readonly WorkspaceCustomEmojiItem[]
  readonly shortcodeSet: ReadonlySet<string>
  readonly byShortcode: ReadonlyMap<string, WorkspaceCustomEmojiItem>
  readonly loaded: boolean
}

const EMPTY_STATE: OrgEmojiState = Object.freeze({
  items: EMPTY_ITEMS,
  shortcodeSet: EMPTY_SET,
  byShortcode: new Map(),
  loaded: false,
})

const stateByOrg = new Map<string, OrgEmojiState>()
const inFlightListByOrg = new Map<string, Promise<readonly WorkspaceCustomEmojiItem[]>>()
const blobUrls = new Map<string, string>() // key: `${orgId}:${emojiId}:${sha256}` -> blob: URL
const emojiBlobRefCounts = new Map<string, number>()
const deferredEmojiRevokeUrls = new Set<string>()
const inFlightBlobs = new Map<string, Promise<string | null>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function safeCreateObjectURL(blob: Blob): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  try {
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

function safeRevokeObjectURL(url: string): void {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // Ignore already-revoked object URLs.
  }
}

function acquireEmojiBlobConsumer(url: string): void {
  emojiBlobRefCounts.set(url, (emojiBlobRefCounts.get(url) ?? 0) + 1)
}

function releaseEmojiBlobConsumer(url: string): void {
  const next = (emojiBlobRefCounts.get(url) ?? 0) - 1
  if (next <= 0) {
    emojiBlobRefCounts.delete(url)
    if (deferredEmojiRevokeUrls.delete(url)) {
      safeRevokeObjectURL(url)
    }
  } else {
    emojiBlobRefCounts.set(url, next)
  }
}

function retireOrDeferEmojiBlobUrl(url: string | undefined): void {
  if (!url) return
  if ((emojiBlobRefCounts.get(url) ?? 0) > 0) {
    deferredEmojiRevokeUrls.add(url)
    return
  }
  safeRevokeObjectURL(url)
}

function evictOneEmojiBlobEntry(): boolean {
  for (const [candidateKey, candidateUrl] of blobUrls.entries()) {
    if ((emojiBlobRefCounts.get(candidateUrl) ?? 0) === 0) {
      blobUrls.delete(candidateKey)
      safeRevokeObjectURL(candidateUrl)
      return true
    }
  }
  const oldestKey = blobUrls.keys().next().value
  if (oldestKey === undefined) return false
  const oldestUrl = blobUrls.get(oldestKey)
  blobUrls.delete(oldestKey)
  retireOrDeferEmojiBlobUrl(oldestUrl)
  return true
}

function blobCacheKey(organisationId: string, item: WorkspaceCustomEmojiItem): string {
  return `${organisationId}:${item.id}:${item.sha256}`
}

function buildOrgState(items: readonly WorkspaceCustomEmojiItem[]): OrgEmojiState {
  const byShortcode = new Map<string, WorkspaceCustomEmojiItem>()
  const codes = new Set<string>()
  for (const item of items) {
    byShortcode.set(item.shortcode, item)
    codes.add(item.shortcode)
  }
  return {
    items,
    shortcodeSet: codes,
    byShortcode,
    loaded: true,
  }
}

export function subscribeCustomEmojis(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setWorkspaceCustomEmojisSnapshot(
  organisationId: string,
  items: readonly WorkspaceCustomEmojiItem[]
): void {
  const activeKeys = new Set(items.map((item) => blobCacheKey(organisationId, item)))
  const orgPrefix = `${organisationId}:`
  for (const [key, url] of blobUrls.entries()) {
    if (key.startsWith(orgPrefix) && !activeKeys.has(key)) {
      retireOrDeferEmojiBlobUrl(url)
      blobUrls.delete(key)
    }
  }
  stateByOrg.set(organisationId, buildOrgState(items))
  emit()
}

export async function refreshWorkspaceCustomEmojis(
  organisationId: string,
  force = false
): Promise<readonly WorkspaceCustomEmojiItem[]> {
  const current = stateByOrg.get(organisationId)
  if (!force && current?.loaded) return current.items
  const inflight = inFlightListByOrg.get(organisationId)
  if (inflight !== undefined && !force) return inflight

  const task = (async () => {
    try {
      const items = await listWorkspaceCustomEmojis(organisationId)
      setWorkspaceCustomEmojisSnapshot(organisationId, items)
      return items
    } catch {
      return stateByOrg.get(organisationId)?.items ?? EMPTY_ITEMS
    } finally {
      inFlightListByOrg.delete(organisationId)
    }
  })()

  inFlightListByOrg.set(organisationId, task)
  return task
}

export async function ensureCustomEmojiBlobUrl(
  organisationId: string,
  item: WorkspaceCustomEmojiItem
): Promise<string | null> {
  const key = blobCacheKey(organisationId, item)
  const cached = blobUrls.get(key)
  if (cached !== undefined) {
    // Refresh LRU position
    blobUrls.delete(key)
    blobUrls.set(key, cached)
    return cached
  }
  const existing = inFlightBlobs.get(key)
  if (existing !== undefined) return existing

  const task = (async () => {
    try {
      const blob = await fetchWorkspaceCustomEmojiBlob(organisationId, item.id)
      const currentOrg = stateByOrg.get(organisationId)
      if (currentOrg !== undefined && !currentOrg.byShortcode.has(item.shortcode)) {
        return null
      }
      const url = safeCreateObjectURL(blob)
      if (url === null) return null
      while (blobUrls.size >= MAX_BLOB_CACHE_ENTRIES) {
        if (!evictOneEmojiBlobEntry()) break
      }
      blobUrls.set(key, url)
      emit()
      return url
    } catch {
      return null
    } finally {
      inFlightBlobs.delete(key)
    }
  })()

  inFlightBlobs.set(key, task)
  return task
}

export function getCustomEmojiByShortcode(
  organisationId: string | null,
  shortcode: string
): WorkspaceCustomEmojiItem | undefined {
  if (!organisationId) return undefined
  return stateByOrg.get(organisationId)?.byShortcode.get(shortcode)
}

export function getCustomEmojiBlobUrl(
  organisationId: string | null,
  item: WorkspaceCustomEmojiItem | undefined
): string | null {
  if (!organisationId || !item) return null
  return blobUrls.get(blobCacheKey(organisationId, item)) ?? null
}

export function clearOrganisationCustomEmojis(organisationId: string): void {
  const prefix = `${organisationId}:`
  for (const [key, url] of blobUrls.entries()) {
    if (key.startsWith(prefix)) {
      safeRevokeObjectURL(url)
      deferredEmojiRevokeUrls.delete(url)
      emojiBlobRefCounts.delete(url)
      blobUrls.delete(key)
    }
  }
  stateByOrg.delete(organisationId)
  inFlightListByOrg.delete(organisationId)
  emit()
}

export function clearAllCustomEmojiBlobs(): void {
  for (const url of blobUrls.values()) {
    safeRevokeObjectURL(url)
  }
  for (const url of deferredEmojiRevokeUrls.values()) {
    safeRevokeObjectURL(url)
  }
  blobUrls.clear()
  deferredEmojiRevokeUrls.clear()
  emojiBlobRefCounts.clear()
  inFlightBlobs.clear()
  stateByOrg.clear()
  inFlightListByOrg.clear()
  emit()
}

export const clearCustomEmojiBlobs = clearAllCustomEmojiBlobs

registerLocalSessionCleanup(clearAllCustomEmojiBlobs)
registerEspaceVaultCleanup(clearAllCustomEmojiBlobs)
registerOrganisationSwitchCleanup(clearOrganisationCustomEmojis)

export function useCustomEmojis(
  organisationId: string | null,
  options?: { autoFetch?: boolean }
): {
  readonly items: readonly WorkspaceCustomEmojiItem[]
  readonly shortcodeSet: ReadonlySet<string>
  readonly enabled: boolean
} {
  const prefs = useExperiencePreferences(organisationId)
  const enabled = prefs.labsFlags.custom_emojis
  const state = useSyncExternalStore(subscribeCustomEmojis, () =>
    organisationId && enabled ? (stateByOrg.get(organisationId) ?? EMPTY_STATE) : EMPTY_STATE
  )
  const autoFetch = options?.autoFetch ?? false
  useEffect(() => {
    if (organisationId && enabled && autoFetch && !stateByOrg.get(organisationId)?.loaded) {
      void refreshWorkspaceCustomEmojis(organisationId)
    }
  }, [organisationId, enabled, autoFetch])

  return {
    items: enabled ? state.items : EMPTY_ITEMS,
    shortcodeSet: enabled ? state.shortcodeSet : EMPTY_SET,
    enabled,
  }
}

export function useCustomEmojiBlobUrl(
  organisationId: string | null,
  shortcode: string
): string | null {
  const { enabled } = useCustomEmojis(organisationId)
  const item = enabled ? getCustomEmojiByShortcode(organisationId, shortcode) : undefined
  const url = useSyncExternalStore(subscribeCustomEmojis, () =>
    enabled ? getCustomEmojiBlobUrl(organisationId, item) : null
  )
  useEffect(() => {
    if (!url) return
    acquireEmojiBlobConsumer(url)
    return () => {
      releaseEmojiBlobConsumer(url)
    }
  }, [url])
  useEffect(() => {
    if (organisationId && enabled && item && url === null) {
      void ensureCustomEmojiBlobUrl(organisationId, item)
    }
  }, [organisationId, enabled, item, url])
  return url
}
