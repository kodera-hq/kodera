import { useMemo, useSyncExternalStore } from 'react'

export type ProfilePresence = 'online' | 'focused' | 'dnd' | 'offline'
export interface LocalProfile {
  displayName: string
  presence: ProfilePresence
  status: string
}
const EMPTY: LocalProfile = { displayName: '', presence: 'online', status: '' }
const PREFIX = 'kodera.profile.'
const EVENT = 'kodera:profile-change'
const fallback = new Map<string, string>()
const blockedWrites = new Set<string>()

function read(userId: string): string | null {
  if (blockedWrites.has(userId)) return fallback.get(userId) ?? null
  try {
    return localStorage.getItem(PREFIX + userId)
  } catch {
    return fallback.get(userId) ?? null
  }
}
function decode(raw: string | null): LocalProfile {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (!value || typeof value !== 'object') return EMPTY
    const profile = value as Partial<LocalProfile>
    return {
      displayName: typeof profile.displayName === 'string' ? profile.displayName.slice(0, 80) : '',
      status: typeof profile.status === 'string' ? profile.status.slice(0, 160) : '',
      presence: ['online', 'focused', 'dnd', 'offline'].includes(profile.presence ?? '')
        ? profile.presence!
        : 'online',
    }
  } catch {
    return EMPTY
  }
}
export function getLocalProfile(userId: string): LocalProfile {
  return decode(read(userId))
}
export function updateLocalProfile(userId: string, patch: Partial<LocalProfile>): void {
  if (!userId) return
  const value = JSON.stringify(decode(JSON.stringify({ ...getLocalProfile(userId), ...patch })))
  fallback.set(userId, value)
  try {
    localStorage.setItem(PREFIX + userId, value)
    blockedWrites.delete(userId)
  } catch {
    blockedWrites.add(userId)
    // The current session remains usable when persistent storage is unavailable.
  }
  window.dispatchEvent(new Event(EVENT))
}
function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}
export function useLocalProfile(userId: string) {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(userId),
    () => null
  )
  const profile = useMemo(() => decode(raw), [raw])
  return {
    profile,
    hasProfile: raw !== null,
    updateProfile: (patch: Partial<LocalProfile>) => updateLocalProfile(userId, patch),
  }
}
