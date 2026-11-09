import { CUSTOM_TOKEN_KEYS, type CustomThemeTokens } from './themeCodec'

export function applyCustomTokensToDocument(tokens: CustomThemeTokens | null): void {
  if (typeof document === 'undefined') return
  for (const key of CUSTOM_TOKEN_KEYS) {
    if (tokens === null) document.documentElement.style.removeProperty(key)
    else document.documentElement.style.setProperty(key, tokens[key])
  }
}
