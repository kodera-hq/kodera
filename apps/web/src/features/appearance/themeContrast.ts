import { color } from '@kodera/design-tokens/tokens.json'
import {
  CUSTOM_TOKEN_KEYS,
  isCanonicalRgb,
  type CoreThemeMode,
  type CustomThemeTokens,
} from './themeCodec'

function luminance(rgb: readonly number[]): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

export function contrastRatio(first: string, second: string): number {
  if (!isCanonicalRgb(first) || !isCanonicalRgb(second)) return 0
  const a = luminance(first.slice(4, -1).split(', ').map(Number))
  const b = luminance(second.slice(4, -1).split(', ').map(Number))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function tokenRgb(value: string): string {
  const channels = value
    .slice(1)
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16))
  return channels?.length === 3 ? `rgb(${channels.join(', ')})` : ''
}

/** Overrides also share surfaces with retained secondary text and material tokens. */
export function hasReadableTheme(tokens: CustomThemeTokens, mode: CoreThemeMode): boolean {
  if (!CUSTOM_TOKEN_KEYS.every((key) => isCanonicalRgb(tokens[key]))) return false
  const base = color[`theme-${mode}`]
  const label = tokenRgb(base['on-inverse'].$value)
  const inks = [tokens['--c-ink'], tokenRgb(base['ink-2'].$value), tokenRgb(base['ink-3'].$value)]
  const grounds = [tokens['--c-page'], tokens['--c-surface'], tokens['--c-sunken']]
  const retainedGrounds = [
    base.page.$value,
    base.surface.$value,
    base.sunken.$value,
    'elevated' in base ? base.elevated.$value : base.surface.$value,
    base.muted.$value,
  ].map(tokenRgb)
  return (
    grounds.every((ground) => inks.every((ink) => contrastRatio(ink, ground) >= 4.5)) &&
    retainedGrounds.every((ground) => contrastRatio(tokens['--c-ink'], ground) >= 4.5) &&
    contrastRatio(label, tokens['--c-action']) >= 4.5
  )
}
