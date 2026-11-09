import { useSyncExternalStore } from 'react'

export type ThemeShare = (name: string, code: string) => Promise<void>
let active: ThemeShare | undefined
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getSnapshot = () => active
const getServerSnapshot = () => undefined

/** Only a mounted, writable text channel registers a publisher. */
export function registerThemeShare(publish: ThemeShare) {
  active = publish
  for (const listener of listeners) listener()
  return () => {
    if (active !== publish) return
    active = undefined
    for (const listener of listeners) listener()
  }
}
export function useActiveThemeShare() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
