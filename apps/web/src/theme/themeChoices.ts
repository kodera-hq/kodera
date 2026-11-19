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
  ciel: {
    label: 'console.shell.appearance.label-ciel',
    hint: 'console.shell.appearance.hint-ciel',
  },
  'ciel-nuit': {
    label: 'console.shell.appearance.label-ciel-nuit',
    hint: 'console.shell.appearance.hint-ciel-nuit',
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

/** The themes a preview draws: « Automatique » shows both a device can ask for — Ciel or true black. */
export const THEME_PREVIEW: Record<ThemePreference, readonly AppliedTheme[]> = {
  system: ['ciel', 'black'],
  ciel: ['ciel'],
  'ciel-nuit': ['ciel-nuit'],
  light: ['light'],
  dark: ['dark'],
  black: ['black'],
}

/**
 * Whether a theme is drawn on frosted glass rather than on flat surfaces. The Ciel family's
 * materials carry a blur, a translucent tint and a specular edge (`@kodera/design-tokens`,
 * `docs/specs/ethereal-sky-glass.md`); the Givre family's are flat by design. A surface asks for
 * its material by level and gets whichever the active theme defines, so this is only for saying so
 * in words beside a theme's name.
 */
export const GLASS_THEMES: readonly ThemePreference[] = ['system', 'ciel', 'ciel-nuit']
