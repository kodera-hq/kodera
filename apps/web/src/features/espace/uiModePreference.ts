import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ChannelMenuTarget } from './ChannelContextMenu'
import { useStableHandler } from './useStoreSlice'

export type WorkspaceUiMode = 'pro' | 'messages'

export const DEFAULT_UI_MODE: WorkspaceUiMode = 'pro'
export const UI_MODE_STORAGE_KEY = 'console:workspace-ui-mode'

export function normalizeUiMode(value: unknown): WorkspaceUiMode | null {
  return value === 'simple' ? 'messages' : value === 'messages' || value === 'pro' ? value : null
}

export function isWorkspaceUiMode(value: unknown): value is WorkspaceUiMode {
  return value === 'pro' || value === 'messages'
}

let unsavedMode: WorkspaceUiMode | null = null
const modeListeners = new Set<() => void>()

function emitModeChange(): void {
  for (const listener of [...modeListeners]) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', emitModeChange)
  window.addEventListener('storage', (event) => {
    if (event.key !== UI_MODE_STORAGE_KEY && event.key !== null) return
    unsavedMode = null
    if (event.key === UI_MODE_STORAGE_KEY) {
      try {
        if (event.newValue === null) {
          window.localStorage.removeItem(UI_MODE_STORAGE_KEY)
        } else if (
          normalizeUiMode(event.newValue) !== null &&
          window.localStorage.getItem(UI_MODE_STORAGE_KEY) !== event.newValue
        ) {
          window.localStorage.setItem(UI_MODE_STORAGE_KEY, event.newValue)
        }
      } catch {
        // Ignore storage write errors in restricted contexts.
      }
    }
    emitModeChange()
  })
}

export function getUiModeSnapshot(): WorkspaceUiMode {
  if (unsavedMode !== null) return unsavedMode
  try {
    return getUiModePreferenceSnapshot() ?? DEFAULT_UI_MODE
  } catch {
    return DEFAULT_UI_MODE
  }
}

function getUiModePreferenceSnapshot(): WorkspaceUiMode | null {
  if (unsavedMode !== null) return unsavedMode
  try {
    const url = new URL(window.location.href)
    return (
      normalizeUiMode(url.searchParams.get('ui_mode')) ??
      normalizeUiMode(window.localStorage.getItem(UI_MODE_STORAGE_KEY))
    )
  } catch {
    return null
  }
}

export function subscribeUiMode(listener: () => void): () => void {
  modeListeners.add(listener)
  return () => {
    modeListeners.delete(listener)
  }
}

export function setUiMode(next: WorkspaceUiMode | 'simple'): void {
  const resolved: WorkspaceUiMode = normalizeUiMode(next) ?? DEFAULT_UI_MODE
  let stored = true
  try {
    window.localStorage.setItem(UI_MODE_STORAGE_KEY, resolved)
  } catch {
    stored = false
  }
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.has('ui_mode')) {
      url.searchParams.set('ui_mode', resolved)
      window.history.replaceState(window.history.state, '', url)
    }
  } catch {
    /* Restricted browser contexts can keep the in-memory preference. */
  }
  unsavedMode = stored ? null : resolved
  emitModeChange()
}

export function toggleUiMode(): WorkspaceUiMode {
  const next: WorkspaceUiMode = getUiModeSnapshot() === 'messages' ? 'pro' : 'messages'
  setUiMode(next)
  return next
}

export const uiModePreference = {
  subscribe: subscribeUiMode,
  getSnapshot: getUiModeSnapshot,
  setMode: setUiMode,
  toggle: toggleUiMode,
} as const

export function useWorkspaceUiMode(
  defaultMode: WorkspaceUiMode = DEFAULT_UI_MODE
): WorkspaceUiMode {
  return (
    useSyncExternalStore(subscribeUiMode, getUiModePreferenceSnapshot, () => null) ?? defaultMode
  )
}

export function favoriteChannelsStorageKey(
  org: string,
  workspaceId: string,
  userId: string
): string {
  return `kodera.favorite-channels.${org}:${workspaceId}:${userId}`
}

export function readFavoriteChannels(
  org: string,
  workspaceId: string,
  userId: string
): Set<string> {
  try {
    const raw = window.localStorage.getItem(favoriteChannelsStorageKey(org, workspaceId, userId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? new Set(
          parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
        )
      : new Set()
  } catch {
    return new Set()
  }
}

export function writeFavoriteChannels(
  org: string,
  workspaceId: string,
  userId: string,
  channels: ReadonlySet<string>
): void {
  try {
    const key = favoriteChannelsStorageKey(org, workspaceId, userId)
    if (channels.size === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify([...channels]))
  } catch {
    // Storage unavailable: keep session favorite state in memory.
  }
}

export function useFavoriteChannels(org: string, workspaceId: string, viewerId: string) {
  const scopeKey = `${org}:${workspaceId}:${viewerId}`
  const [favoriteState, setFavoriteState] = useState<{
    scope: string
    channels: ReadonlySet<string>
  }>(() => ({
    scope: scopeKey,
    channels: readFavoriteChannels(org, workspaceId, viewerId),
  }))

  if (favoriteState.scope !== scopeKey) {
    setFavoriteState({
      scope: scopeKey,
      channels: readFavoriteChannels(org, workspaceId, viewerId),
    })
  }

  useEffect(() => {
    const storageKey = favoriteChannelsStorageKey(org, workspaceId, viewerId)
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return
      setFavoriteState({
        scope: scopeKey,
        channels: readFavoriteChannels(org, workspaceId, viewerId),
      })
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [org, workspaceId, viewerId, scopeKey])

  const favoriteChannels = favoriteState.channels
  const isChannelFavorite = useCallback(
    (id: string) => favoriteChannels.has(id),
    [favoriteChannels]
  )
  const toggleChannelFavorite = useStableHandler((target: ChannelMenuTarget | string) => {
    const channelId = typeof target === 'string' ? target : target.channelId
    setFavoriteState((previous) => {
      const current =
        previous.scope === scopeKey
          ? previous.channels
          : readFavoriteChannels(org, workspaceId, viewerId)
      const next = new Set(current)
      if (next.has(channelId)) next.delete(channelId)
      else next.add(channelId)
      writeFavoriteChannels(org, workspaceId, viewerId, next)
      return { scope: scopeKey, channels: next }
    })
  })

  return { favoriteChannels, isChannelFavorite, toggleChannelFavorite }
}

const UI_MODE_MESSAGES = {
  fr: {
    modeToggleGroup: 'Mode d’affichage de l’espace',
    modePro: 'Mode Espace Pro',
    modeSimple: 'Mode Messages',
    title: 'Messages',
    search: 'Filtrer les conversations',
    all: 'Tous',
    unread: 'Non lus',
    directs: 'Directs',
    channels: 'Salons',
    back: 'Retour aux conversations',
    conversationsLabel: 'Conversations récentes',
    newMessage: 'Nouveau message',
    emptyFeed: 'Aucune conversation active. Démarrez un message direct ou épinglez un salon.',
    confidentialExcerpt: 'Salon protégé · aperçu masqué',
    noMessagesYet: 'Aucun message récent',
    justNow: 'à l’instant',
    pinnedBadge: 'Favori',
    favoriteAdd: 'Épingler aux favoris',
    favoriteRemove: 'Retirer des favoris',
    activeCallSingle: '1 personne en appel',
    activeCallMany: '{count} personnes en appel',
    callAction: 'Appeler {name}',
  },
  en: {
    modeToggleGroup: 'Workspace view mode',
    modePro: 'Workspace Pro mode',
    modeSimple: 'Messages mode',
    title: 'Messages',
    search: 'Filter conversations',
    all: 'All',
    unread: 'Unread',
    directs: 'Directs',
    channels: 'Channels',
    back: 'Back to conversations',
    conversationsLabel: 'Recent conversations',
    newMessage: 'New message',
    emptyFeed: 'No active conversations yet. Start a direct message or pin a channel.',
    confidentialExcerpt: 'Protected room · preview hidden',
    noMessagesYet: 'No recent messages',
    justNow: 'now',
    pinnedBadge: 'Favorite',
    favoriteAdd: 'Pin to favorites',
    favoriteRemove: 'Remove from favorites',
    activeCallSingle: '1 person in call',
    activeCallMany: '{count} people in call',
    callAction: 'Call {name}',
  },
} as const

export function uiModeCopy(locale?: string) {
  return UI_MODE_MESSAGES[locale?.startsWith('en') ? 'en' : 'fr']
}
