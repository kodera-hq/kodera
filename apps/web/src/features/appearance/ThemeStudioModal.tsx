import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageKey } from '../../i18n'
import { Button } from '../../ui/Button/Button'
import { StatusPill } from '../../ui/StatusPill/StatusPill'
import { cx } from '../../ui/cx'
import { WorkspaceDialog, WorkspaceDialogTitle } from '../../ui/WorkspaceDialog'
import { applyCustomTokensToDocument } from './themeOverrides'
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
  type CoreThemeMode,
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
      '--c-action': 'rgb(216, 155, 60)',
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
      '--c-action': 'rgb(53, 169, 106)',
      '--c-ink': 'rgb(235, 245, 239)',
    },
  },
] as const

export function applyCoreThemeToDocument(mode: CoreThemeMode): void {
  if (typeof document === 'undefined') return
  const isDarkOrBlack = mode === 'dark' || mode === 'black'
  document.documentElement.classList.toggle('dark', isDarkOrBlack)
  document.documentElement.dataset.theme = mode
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
  readonly currentThemeMode: CoreThemeMode
  readonly onSelectCoreTheme: (mode: CoreThemeMode) => void
  readonly onShareToChannel?: ((themeName: string, shareCode: string) => Promise<void>) | undefined
  readonly onClose: () => void
}

export function ThemeStudioModal({
  open,
  currentThemeMode,
  onSelectCoreTheme,
  onShareToChannel,
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
  const [tokens, setTokens] = useState<CustomThemeTokens>(CURATED_COMMUNITY_PRESETS[0]!.tokens)
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
      baseMode: currentThemeMode,
      tokens,
    }),
    [customName, currentThemeMode, tokens, importedId, copy.fallbackName]
  )

  // Only what the strict decoder accepts back is ever offered as a code or saved.
  const encoded = useMemo(() => encodeShareableTheme(currentDefinition), [currentDefinition])
  const shareCode = encoded.ok ? encoded.code : ''
  const showRefusal = (reason: ThemeRefusal) => {
    setStatusIsRefusal(true)
    setStatusMessageText(t(REFUSAL_MESSAGE[reason]))
  }

  const handleChooseCoreMode = (mode: CoreThemeMode) => {
    applyCustomTokensToDocument(null)
    onSelectCoreTheme(mode)
    setStatusMessage(copy.modes[mode].done)
  }

  const handleApplyPreset = (preset: CommunityThemeDefinition) => {
    onSelectCoreTheme(preset.baseMode)
    setImportedId(preset.id)
    setCustomName(preset.name)
    setTokens(preset.tokens)
    applyCustomTokensToDocument(preset.tokens)
    setStatusMessage(copy.applied(preset.name))
  }

  const handleUpdateToken = (key: keyof CustomThemeTokens, value: string) => {
    const next: CustomThemeTokens = {
      ...tokens,
      [key]: value,
    }
    setTokens(next)
    // A half-typed or foreign colour stays in the field and never reaches the document.
    if (CUSTOM_TOKEN_KEYS.every((tokenKey) => isCanonicalRgb(next[tokenKey]))) {
      applyCustomTokensToDocument(next)
    }
  }

  const handleResetColors = () => {
    applyCustomTokensToDocument(null)
    setStatusMessage(copy.resetDone)
  }

  const handleSaveTheme = () => {
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
    applyCustomTokensToDocument(currentDefinition.tokens)
    setStatusMessage(copy.saveDone(currentDefinition.name))
  }

  const handleShareToChannel = async () => {
    if (!onShareToChannel || sharing) return
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
    onSelectCoreTheme(decoded.theme.baseMode)
    setImportedId(decoded.theme.id)
    setCustomName(decoded.theme.name)
    setTokens(decoded.theme.tokens)
    applyCustomTokensToDocument(decoded.theme.tokens)
    setStatusMessage(copy.importDone(decoded.theme.name))
  }

  return (
    <WorkspaceDialog
      open={open}
      onClose={onClose}
      data-testid="kodera-theme-studio-modal"
      className="flex h-[90%] w-full max-w-[960px] flex-col gap-4 overflow-y-auto rounded-lg border border-c-border bg-c-surface p-6 shadow-pop shadow-c-shadow-2"
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
          {(['light', 'dark', 'black'] as const).map((mode) => {
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
                <input
                  id={`token-${tokenKey}`}
                  type="text"
                  data-testid={`theme-token-${tokenKey}`}
                  value={tokens[tokenKey]}
                  onChange={(e) => handleUpdateToken(tokenKey, e.target.value)}
                  className="h-8 w-1/2 rounded-md border border-c-border-input bg-c-surface px-2 font-mono text-xs text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                />
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
