import tokens from '@kodera/design-tokens/tokens.json'

export const THEMES = ['light', 'dark', 'black'] as const
export type Theme = (typeof THEMES)[number]

type ThemeColours = Record<string, { $value?: string }>

/** A `c-*` class's colour in one theme, read from the token source: the preset
 * knows these roles only as `var()` references, which no ratio can be taken of. */
export function roleHex(className: string, theme: Theme): string {
  const colours = (tokens.color as unknown as Record<string, ThemeColours>)[`theme-${theme}`]
  const value = colours?.[className.replace(/^[a-z]+-c-/, '')]?.$value
  if (value === undefined) throw new Error(`${className} has no ${theme} value in the tokens`)
  return value
}
