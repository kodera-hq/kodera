import { hasReadableTheme } from './themeContrast'
import { CUSTOM_TOKEN_KEYS, type CoreThemeMode, type CustomThemeTokens } from './themeCodec'

export function applyCustomTokensToDocument(
  tokens: CustomThemeTokens | null,
  mode: CoreThemeMode = 'light'
): void {
  if (typeof document === 'undefined' || (tokens !== null && !hasReadableTheme(tokens, mode)))
    return
  for (const key of CUSTOM_TOKEN_KEYS) {
    if (tokens === null) document.documentElement.style.removeProperty(key)
    else document.documentElement.style.setProperty(key, tokens[key])
  }
}
