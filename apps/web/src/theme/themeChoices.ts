// The themes a member may choose, and how each one is named and previewed. One list, read by the
// appearance screen and by the workspace's own « Apparence & thèmes » panel, so the two can never
// offer different themes — the panel offered three of six for as long as the two lists were
// separate, and the default theme had no card at all.

import type { MessageKey } from '../i18n'
import type { AppliedTheme, ThemePreference } from './theme'

export const THEME_COPY: Record<ThemePreference, { label: MessageKey; hint: MessageKey }> = {
  system: {
    label: 'console.shell.appearance.label-system',
    hint: 'console.shell.appearance.hint-system',
  },
  light: {
    label: 'console.shell.appearance.label-light',
    hint: 'console.shell.appearance.hint-light',
  },
  dark: {
    label: 'console.shell.appearance.label-dark',
    hint: 'console.shell.appearance.hint-dark',
  },
  black: {
    label: 'console.shell.appearance.label-black',
    hint: 'console.shell.appearance.hint-black',
  },
}

/** The themes a preview draws: « Automatique » shows both a device can ask for — Light Givre or Dark Precision. */
export const THEME_PREVIEW: Record<ThemePreference, readonly AppliedTheme[]> = {
  system: ['light', 'dark'],
  light: ['light'],
  dark: ['dark'],
  black: ['black'],
}

/**
 * Whether a selectable theme is drawn on frosted glass rather than on flat surfaces. All active
 * picker themes (`light`, `dark`, `black`, and `system`) use flat surfaces by design.
 */
export const GLASS_THEMES: readonly ThemePreference[] = []
