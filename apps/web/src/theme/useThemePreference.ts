import { useEffect, useState } from 'react'
import {
  readThemePreference,
  saveThemePreference,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './theme'

/** Follow the same preference and events as the before-paint theme script. */
export function useThemePreference() {
  const [preference, setPreference] = useState(readThemePreference)
  useEffect(() => {
    const follow = () => setPreference(readThemePreference())
    const storage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) follow()
    }
    window.addEventListener(THEME_CHANGE_EVENT, follow)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, follow)
      window.removeEventListener('storage', storage)
    }
  }, [])
  const choose = (next: ThemePreference) => {
    saveThemePreference(next)
    setPreference(next)
  }
  return { preference, choose }
}
