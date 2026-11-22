// The person's theme choice. Applying it is `public/theme.js`'s job alone — it
// runs before the first paint and follows the device while the choice is
// "system" — so this module only stores a choice and announces it.

export type ThemePreference = 'system' | 'light' | 'dark' | 'black'
/** A theme a page can wear, including backward-compatible stored Ciel tokens. */
export type AppliedTheme = 'light' | 'dark' | 'black' | 'ciel' | 'ciel-nuit'
/** Any value `readThemePreference()` may report from storage, matching `public/theme.js` 1-for-1. */
export type StoredThemePreference = ThemePreference | 'ciel' | 'ciel-nuit'
/** The light/dark/black axis a theme sits on, which a shareable theme code records (`themeCodec.ts`). */
export type ThemeMode = 'light' | 'dark' | 'black'

export const THEME_STORAGE_KEY = 'console:theme'
/** Announced with the new preference as `detail`; `public/theme.js` re-applies on it. */
export const THEME_CHANGE_EVENT = 'console:theme'

/**
 * Primary user choices: « Automatique » follows the device (Light Givre when light, Dark Precision
 * when dark), followed by Clair (`light`), Sombre (`dark`, defaultTheme) and Noir (`black`).
 * Legacy `ciel` and `ciel-nuit` values remain supported as backward-compatible token/storage values.
 */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark', 'black']

export const LEGACY_THEME_IDS: readonly ('ciel' | 'ciel-nuit')[] = ['ciel', 'ciel-nuit']

const STORED_PREFERENCES: readonly StoredThemePreference[] = [
  ...THEME_PREFERENCES,
  ...LEGACY_THEME_IDS,
]

const APPLIED: readonly AppliedTheme[] = ['light', 'dark', 'black', 'ciel', 'ciel-nuit']

export function isSelectableThemePreference(value: string): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value)
}

/**
 * The theme on the page now: the choice itself (including legacy `ciel` / `ciel-nuit`), or the
 * theme `public/theme.js` resolved « Automatique » to — Dark Precision (`dark`) when it cannot tell.
 */
export function appliedTheme(preference: StoredThemePreference): AppliedTheme {
  if (preference !== 'system') return preference
  const applied =
    typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme
  return APPLIED.find((theme) => theme === applied) ?? 'dark'
}

/** The mode a theme renders in: Ciel and Ciel Nuit are the light and dark sides of their family. */
export function themeMode(theme: AppliedTheme): ThemeMode {
  if (theme === 'ciel') return 'light'
  if (theme === 'ciel-nuit') return 'dark'
  return theme
}

/**
 * A choice the browser refused to store. `public/theme.js` keeps applying it
 * until the next load, so this module keeps it too for as long: read from
 * storage instead, a page opened again after the refusal would show the stored
 * (or default) choice while the page wears the refused one.
 */
let unsaved: StoredThemePreference | null = null

// Another tab's stored choice replaces this tab's unsaved one, as it does in
// `public/theme.js` — registered at import, so before any page's own listener.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === THEME_STORAGE_KEY) unsaved = null
  })
}

/** The choice in effect on this page: the one this load could not store, else the stored one. */
export function readThemePreference(): StoredThemePreference {
  if (unsaved !== null) return unsaved
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return STORED_PREFERENCES.find((preference) => preference === stored) ?? 'system'
  } catch {
    return 'system'
  }
}

/** Whether the choice in effect will survive a reload: false after a refused write. */
export function isThemePreferenceKept(): boolean {
  return unsaved === null
}

/**
 * Stores the choice for this browser and announces it, so the page changes at
 * once. Returns whether the browser kept it: storage can be refused (private
 * mode, a policy), and the page then applies the choice without remembering it.
 */
export function saveThemePreference(preference: ThemePreference): boolean {
  let stored = true
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    stored = false
  }
  unsaved = stored ? null : preference
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: preference }))
  return stored
}
