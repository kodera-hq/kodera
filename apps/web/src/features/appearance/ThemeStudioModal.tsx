import { useId, useMemo, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { color } from '@kodera/design-tokens/tokens.json'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { cx } from '../../ui/cx'
import { WorkspaceDialog, WorkspaceDialogTitle } from '../../ui/WorkspaceDialog'
import {
  THEME_PREFERENCES,
  themeMode,
  type AppliedTheme,
  type ThemePreference,
} from '../../theme/theme'
import { applyCustomTokensToDocument } from './themeOverrides'
import { hasReadableTheme } from './themeContrast'
import { themeStudioMessages } from './themeStudioMessages'
export { applyCustomTokensToDocument } from './themeOverrides'
import {
  CUSTOM_TOKEN_KEYS,
  decodeShareableTheme,
  encodeShareableTheme,
  isCanonicalRgb,
  parseStoredThemes,
  themeIdFromName,
  type CommunityThemeDefinition,
  type CustomThemeTokens,
  type ThemeRefusal,
} from './themeCodec'

export type { CommunityThemeDefinition, CoreThemeMode, CustomThemeTokens } from './themeCodec'
export { decodeShareableTheme, encodeShareableTheme } from './themeCodec'

export const COMMUNITY_THEMES_STORAGE_KEY = 'kodera.community.themes.v1'

export const CURATED_COMMUNITY_PRESETS: readonly CommunityThemeDefinition[] = [
  {
    id: 'preset-real-black-oled',
    name: 'Absolute OLED Black',
    author: 'Kodera Design System',
    baseMode: 'black',
    tokens: {
      '--c-page': 'rgb(0, 0, 0)',
      '--c-surface': 'rgb(11, 12, 14)',
      '--c-sunken': 'rgb(6, 6, 7)',
      '--c-action': 'rgb(67, 97, 238)',
      '--c-ink': 'rgb(241, 244, 248)',
    },
  },
  {
    id: 'preset-cobalt-polaire',
    name: 'Polar Cobalt',
    author: 'Kodera Community',
    baseMode: 'light',
    tokens: {
      '--c-page': 'rgb(255, 255, 255)',
      '--c-surface': 'rgb(255, 255, 255)',
      '--c-sunken': 'rgb(238, 242, 246)',
      '--c-action': 'rgb(43, 75, 219)',
      '--c-ink': 'rgb(30, 41, 51)',
    },
  },
  {
    id: 'preset-terminal-ambre',
    name: 'Amber Terminal',
    author: 'Kodera Community',
    baseMode: 'black',
    tokens: {
      '--c-page': 'rgb(0, 0, 0)',
      '--c-surface': 'rgb(16, 14, 10)',
      '--c-sunken': 'rgb(10, 8, 5)',
      '--c-action': 'rgb(137, 92, 21)',
      '--c-ink': 'rgb(245, 230, 200)',
    },
  },
  {
    id: 'preset-foret-souveraine',
    name: 'Forest',
    author: 'Kodera Community',
    baseMode: 'dark',
    tokens: {
      '--c-page': 'rgb(8, 16, 12)',
      '--c-surface': 'rgb(14, 26, 20)',
      '--c-sunken': 'rgb(10, 19, 14)',
      '--c-action': 'rgb(28, 112, 66)',
      '--c-ink': 'rgb(235, 245, 239)',
    },
  },
] as const

type SelectableCoreTheme = Exclude<ThemePreference, 'system'>

/** The official themes offered in primary pickers: Clair, Sombre (Dark Precision) and Noir. */
const OFFICIAL_THEMES = THEME_PREFERENCES.filter(
  (preference): preference is SelectableCoreTheme => preference !== 'system'
)

const COLOR_PREFIX = String.fromCharCode(35)

function tokenValueToCanonicalRgb(raw: string): string {
  const channels = raw
    .slice(1)
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16))
  return channels?.length === 3 ? `rgb(${channels.join(', ')})` : 'rgb(0, 0, 0)'
}

export function officialTokensForTheme(theme: AppliedTheme): CustomThemeTokens {
  const palette = color[`theme-${theme}`]
  return {
    '--c-page': tokenValueToCanonicalRgb(palette.page.$value),
    '--c-surface': tokenValueToCanonicalRgb(palette.surface.$value),
    '--c-sunken': tokenValueToCanonicalRgb(palette.sunken.$value),
    '--c-action': tokenValueToCanonicalRgb(palette.action.$value),
    '--c-ink': tokenValueToCanonicalRgb(palette.ink.$value),
  }
}

function resolveInitialTokensForTheme(theme: AppliedTheme): CustomThemeTokens {
  const base = officialTokensForTheme(theme)
  if (typeof document === 'undefined') return base
  const rootStyle = document.documentElement.style
  const resolved: Record<string, string> = { ...base }
  for (const key of CUSTOM_TOKEN_KEYS) {
    const inlineVal = rootStyle.getPropertyValue(key).trim()
    if (isCanonicalRgb(inlineVal)) {
      resolved[key] = inlineVal
    }
  }
  return resolved as unknown as CustomThemeTokens
}

function canonicalRgbToSwatchValue(rgb: string): string {
  if (!isCanonicalRgb(rgb)) {
    return `${COLOR_PREFIX}${'0'.repeat(6)}`
  }
  const channels = rgb
    .slice(4, -1)
    .split(', ')
    .map((part) => Math.max(0, Math.min(255, Number.parseInt(part, 10) || 0)))
  return `${COLOR_PREFIX}${channels.map((ch) => ch.toString(16).padStart(2, '0')).join('')}`
}

function swatchValueToCanonicalRgb(val: string): string | null {
  if (val.charCodeAt(0) !== 35 || val.length !== 7) return null
  const body = val.slice(1)
  if (!/^[0-9a-fA-F]{6}$/.test(body)) return null
  const r = Number.parseInt(body.slice(0, 2), 16)
  const g = Number.parseInt(body.slice(2, 4), 16)
  const b = Number.parseInt(body.slice(4, 6), 16)
  return `rgb(${r}, ${g}, ${b})`
}

export function applyCoreThemeToDocument(theme: AppliedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', themeMode(theme) !== 'light')
  document.documentElement.dataset.theme = theme
}

function loadSavedCommunityThemes(): readonly CommunityThemeDefinition[] {
  if (typeof window === 'undefined') return []
  try {
    return parseStoredThemes(window.localStorage.getItem(COMMUNITY_THEMES_STORAGE_KEY))
  } catch {
    return []
  }
}

const REFUSAL_MESSAGE: Readonly<Record<ThemeRefusal, MessageKey>> = {
  'too-long': 'console.appearance.theme.error-too-long',
  prefix: 'console.appearance.theme.error-prefix',
  base64: 'console.appearance.theme.error-base64',
  utf8: 'console.appearance.theme.error-utf8',
  json: 'console.appearance.theme.error-json',
  'duplicate-field': 'console.appearance.theme.error-duplicate-field',
  'unknown-field': 'console.appearance.theme.error-unknown-field',
  'missing-field': 'console.appearance.theme.error-missing-field',
  'field-type': 'console.appearance.theme.error-field-type',
  version: 'console.appearance.theme.error-version',
  id: 'console.appearance.theme.error-id',
  name: 'console.appearance.theme.error-name',
  author: 'console.appearance.theme.error-author',
  'base-mode': 'console.appearance.theme.error-base-mode',
  colour: 'console.appearance.theme.error-colour',
}

export interface ThemeStudioModalProps {
  readonly open: boolean
  /** The theme on the page: a share code records only its mode (`themeMode`). */
  readonly currentThemeMode: AppliedTheme
  readonly onSelectCoreTheme: (theme: SelectableCoreTheme) => void
  readonly onShareToChannel?: ((themeName: string, shareCode: string) => Promise<void>) | undefined
  readonly returnFocusTo?: RefObject<HTMLElement | null> | undefined
  readonly onClose: () => void
}

export function ThemeStudioModal({
  open,
  currentThemeMode,
  onSelectCoreTheme,
  onShareToChannel,
  returnFocusTo,
  onClose,
}: ThemeStudioModalProps) {
  const { t, i18n } = useTranslation()
  const copy = themeStudioMessages[i18n.resolvedLanguage === 'en' ? 'en' : 'fr']
  const [sharing, setSharing] = useState(false)
  const themeNameInputId = useId()
  const shareInputId = useId()
  const importInputId = useId()

  const [importedId, setImportedId] = useState<string | null>(null)
  const [customName, setCustomName] = useState<string>(copy.defaultName)
  const [customTokens, setCustomTokens] = useState<CustomThemeTokens | null>(null)
  const tokens = useMemo(
    () => customTokens ?? resolveInitialTokensForTheme(currentThemeMode),
    [customTokens, currentThemeMode]
  )
  const [savedThemes, setSavedThemes] =
    useState<readonly CommunityThemeDefinition[]>(loadSavedCommunityThemes)
  const [importCode, setImportCode] = useState<string>('')
  const [statusMessage, setStatusMessageText] = useState<string | null>(null)
  const [statusIsRefusal, setStatusIsRefusal] = useState(false)
  const setStatusMessage = (message: string) => {
    setStatusIsRefusal(false)
    setStatusMessageText(message)
  }

  const currentDefinition = useMemo<CommunityThemeDefinition>(
    () => ({
      id: importedId ?? themeIdFromName(customName),
      name: customName.trim() || copy.fallbackName,
      author: 'Kodera Community',
      baseMode: themeMode(currentThemeMode),
      tokens,
    }),
    [customName, currentThemeMode, tokens, importedId, copy.fallbackName]
  )

  // Only what the strict decoder accepts back is ever offered as a code or saved.
  const encoded = useMemo(() => encodeShareableTheme(currentDefinition), [currentDefinition])
  const readable = hasReadableTheme(tokens, currentDefinition.baseMode)
  const shareCode = encoded.ok && readable ? encoded.code : ''
  const refuseContrast = () => {
    setStatusIsRefusal(true)
    setStatusMessageText(copy.contrastRefused)
  }
  const showRefusal = (reason: ThemeRefusal) => {
    setStatusIsRefusal(true)
    setStatusMessageText(t(REFUSAL_MESSAGE[reason]))
  }

  const handleChooseCoreMode = (mode: SelectableCoreTheme) => {
    setImportedId(null)
    setCustomTokens(null)
    applyCustomTokensToDocument(null)
    onSelectCoreTheme(mode)
    setStatusMessage(copy.modes[mode].done)
  }

  const handleApplyPreset = (preset: CommunityThemeDefinition) => {
    if (!hasReadableTheme(preset.tokens, preset.baseMode)) {
      refuseContrast()
      return
    }
    onSelectCoreTheme(preset.baseMode)
    setImportedId(preset.id)
    setCustomName(preset.name)
    setCustomTokens(preset.tokens)
    applyCustomTokensToDocument(preset.tokens, preset.baseMode)
    setStatusMessage(copy.applied(preset.name))
  }

  const handleUpdateToken = (key: keyof CustomThemeTokens, value: string) => {
    const next: CustomThemeTokens = {
      ...tokens,
      [key]: value,
    }
    setCustomTokens(next)
    // A half-typed or foreign colour stays in the field and never reaches the document.
    if (CUSTOM_TOKEN_KEYS.every((tokenKey) => isCanonicalRgb(next[tokenKey]))) {
      if (hasReadableTheme(next, themeMode(currentThemeMode)))
        applyCustomTokensToDocument(next, themeMode(currentThemeMode))
      else refuseContrast()
    }
  }

  const handleResetColors = () => {
    setImportedId(null)
    setCustomTokens(null)
    applyCustomTokensToDocument(null)
    setStatusMessage(copy.resetDone)
  }

  const handleSaveTheme = () => {
    if (!readable) {
      refuseContrast()
      return
    }
    if (!encoded.ok) {
      showRefusal(encoded.reason)
      return
    }
    const nextList = [
      currentDefinition,
      ...savedThemes.filter(
        (item) => item.name !== currentDefinition.name && item.id !== currentDefinition.id
      ),
    ]
    try {
      window.localStorage.setItem(COMMUNITY_THEMES_STORAGE_KEY, JSON.stringify(nextList))
    } catch {
      setStatusIsRefusal(true)
      setStatusMessageText(copy.saveFailed)
      return
    }
    setSavedThemes(nextList)
    applyCustomTokensToDocument(currentDefinition.tokens, currentDefinition.baseMode)
    setStatusMessage(copy.saveDone(currentDefinition.name))
  }

  const handleShareToChannel = async () => {
    if (!onShareToChannel || sharing) return
    if (!readable) {
      refuseContrast()
      return
    }
    if (!encoded.ok) {
      showRefusal(encoded.reason)
      return
    }
    setSharing(true)
    setStatusMessageText(null)
    try {
      await onShareToChannel(currentDefinition.name, shareCode)
      setStatusMessage(copy.shared)
    } catch {
      setStatusIsRefusal(true)
      setStatusMessageText(copy.failed)
    } finally {
      setSharing(false)
    }
  }

  const handleImportApply = () => {
    const decoded = decodeShareableTheme(importCode)
    if (!decoded.ok) {
      showRefusal(decoded.reason)
      return
    }
    if (!hasReadableTheme(decoded.theme.tokens, decoded.theme.baseMode)) {
      refuseContrast()
      return
    }
    onSelectCoreTheme(decoded.theme.baseMode)
    setImportedId(decoded.theme.id)
    setCustomName(decoded.theme.name)
    setCustomTokens(decoded.theme.tokens)
    applyCustomTokensToDocument(decoded.theme.tokens, decoded.theme.baseMode)
    setStatusMessage(copy.importDone(decoded.theme.name))
  }

  return (
    <WorkspaceDialog
      open={open}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
      data-testid="kodera-theme-studio-modal"
      className="flex max-h-[calc(100vh-32px)] min-h-0 w-full max-w-[960px] flex-col gap-4 overflow-y-auto overscroll-contain rounded-lg border border-c-border p-6 shadow-pop shadow-c-shadow-2"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-c-border-soft pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="logo-tile-black flex h-8 w-8 items-center justify-center rounded-md font-mono text-sm font-bold"
          >
            K
          </span>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <WorkspaceDialogTitle className="text-lg font-semibold text-c-ink">
                {copy.title}
              </WorkspaceDialogTitle>
              <StatusPill state="info">{copy.badge}</StatusPill>
            </div>
            <span className="text-xs font-regular text-c-ink-2">{copy.intro}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            data-testid="theme-studio-reset-btn"
            onClick={handleResetColors}
          >
            {copy.reset}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid="theme-studio-close-btn"
            onClick={onClose}
          >
            {copy.close}
          </Button>
        </div>
      </header>

      <section aria-label={copy.official} className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-c-ink-2">{copy.officialTitle}</span>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {OFFICIAL_THEMES.map((mode) => {
            const item = { mode, ...copy.modes[mode] }
            const isSelected = currentThemeMode === item.mode
            return (
              <button
                key={item.mode}
                type="button"
                data-testid={`theme-studio-base-${item.mode}`}
                aria-pressed={isSelected}
                onClick={() => handleChooseCoreMode(item.mode)}
                className={cx(
                  'flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:ring focus-visible:outline-hidden',
                  isSelected
                    ? 'border-c-accent-ink bg-c-accent-soft text-c-accent-ink'
                    : 'border-c-border bg-c-sunken text-c-ink hover:bg-c-muted'
                )}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{item.label}</span>
                  <StatusPill state={isSelected ? 'success' : 'neutral'}>
                    {isSelected ? copy.active : item.badge}
                  </StatusPill>
                </div>
                <p className="text-xs font-regular text-c-ink-2">{item.desc}</p>
              </button>
            )
          })}
        </div>
      </section>

      <section aria-label={copy.presets} className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-c-ink-2">{copy.presetsTitle}</span>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {CURATED_COMMUNITY_PRESETS.map((definition, index) => {
            const preset = { ...definition, name: copy.presetNames[index] ?? definition.name }
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`theme-preset-${preset.id}`}
                onClick={() => handleApplyPreset(preset)}
                className="flex flex-col items-start gap-1 rounded-md border border-c-border-soft bg-c-sunken p-3 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden"
              >
                <span className="text-sm font-semibold text-c-ink">{preset.name}</span>
                <span className="font-mono text-xs text-c-ink-3">{preset.author}</span>
              </button>
            )
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section
          aria-label={copy.editor}
          className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-sunken p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-c-ink">{copy.editorTitle}</span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="theme-studio-save-btn"
              onClick={handleSaveTheme}
            >
              {copy.save}
            </Button>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={themeNameInputId} className="text-xs font-medium text-c-ink-2">
              {copy.name}
            </label>
            <input
              id={themeNameInputId}
              type="text"
              data-testid="theme-studio-name-input"
              value={customName}
              maxLength={64}
              onChange={(e) => {
                setCustomName(e.target.value)
                setImportedId(null)
              }}
              className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            />
          </div>

          <div className="grid grid-cols-1 gap-2">
            {CUSTOM_TOKEN_KEYS.map((tokenKey) => (
              <div key={tokenKey} className="flex items-center justify-between gap-2">
                <label
                  htmlFor={`token-${tokenKey}`}
                  className="font-mono text-xs font-medium text-c-ink-2"
                >
                  {tokenKey}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={copy.swatchLabel(tokenKey)}
                    data-testid={`theme-swatch-${tokenKey}`}
                    value={canonicalRgbToSwatchValue(tokens[tokenKey])}
                    onChange={(e) => {
                      const converted = swatchValueToCanonicalRgb(e.target.value)
                      if (converted !== null) {
                        handleUpdateToken(tokenKey, converted)
                      }
                    }}
                    className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-c-border-input bg-c-surface p-[2px] focus-visible:ring focus-visible:outline-hidden"
                  />
                  <input
                    id={`token-${tokenKey}`}
                    type="text"
                    data-testid={`theme-token-${tokenKey}`}
                    value={tokens[tokenKey]}
                    onChange={(e) => handleUpdateToken(tokenKey, e.target.value)}
                    className="h-8 w-[160px] rounded-md border border-c-border-input bg-c-surface px-2 font-mono text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                  />
                </div>
              </div>
            ))}
          </div>

          {savedThemes.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-c-border-soft pt-2">
              <span className="text-xs font-semibold text-c-ink-2">
                {copy.saved} ({savedThemes.length})
              </span>
              <div className="flex flex-wrap gap-1">
                {savedThemes.map((saved) => (
                  <button
                    key={saved.id}
                    type="button"
                    data-testid={`theme-saved-${saved.id}`}
                    onClick={() => handleApplyPreset(saved)}
                    className="rounded-sm border border-c-border-soft bg-c-surface px-2 py-1 text-xs font-medium text-c-ink hover:bg-c-muted"
                  >
                    {saved.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        <section
          aria-label={copy.shareSection}
          className="flex flex-col gap-3 rounded-lg border border-c-border bg-c-sunken p-4"
        >
          <span className="text-sm font-semibold text-c-ink">{copy.shareTitle}</span>

          <div className="flex flex-col gap-1">
            <label htmlFor={shareInputId} className="text-xs font-medium text-c-ink-2">
              {copy.code}
            </label>
            <input
              id={shareInputId}
              type="text"
              readOnly
              data-testid="theme-share-code-input"
              value={shareCode}
              className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-xs text-c-ink"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              data-testid="theme-share-to-channel-btn"
              disabled={!onShareToChannel || sharing}
              onClick={() => void handleShareToChannel()}
            >
              {sharing ? copy.sharing : copy.share}
            </Button>
          </div>

          {!onShareToChannel ? <p className="text-xs text-c-ink-3">{copy.unavailable}</p> : null}
          <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
            <label htmlFor={importInputId} className="text-xs font-medium text-c-ink-2">
              {copy.importLabel}
            </label>
            <div className="flex items-center gap-2">
              <input
                id={importInputId}
                type="text"
                data-testid="theme-import-code-input"
                placeholder={copy.importPlaceholder}
                value={importCode}
                onChange={(e) => setImportCode(e.target.value)}
                className="h-8 flex-1 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
              <Button
                size="sm"
                variant="secondary"
                data-testid="theme-import-apply-btn"
                onClick={handleImportApply}
              >
                {copy.importApply}
              </Button>
            </div>
          </div>

          {statusMessage !== null ? (
            <div
              role={statusIsRefusal ? 'alert' : 'status'}
              aria-live={statusIsRefusal ? 'assertive' : 'polite'}
              data-testid="theme-studio-status"
              data-refusal={statusIsRefusal ? 'true' : undefined}
              className={cx(
                'rounded-md border px-3 py-2 text-xs font-medium',
                statusIsRefusal
                  ? 'border-c-bad-ink bg-c-bad-soft text-c-bad-ink'
                  : 'border-c-ok-border bg-c-ok-soft text-c-ok-ink'
              )}
            >
              {statusMessage}
            </div>
          ) : null}
        </section>
      </div>
    </WorkspaceDialog>
  )
}
