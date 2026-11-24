// Ephemeral written channel message translation card (H3.2).
// Linear Dark Precision surface rendered beneath a message without mutating Matrix event bodies.

import { useEffect, useId, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiProblem, requestChannelMessageTranslation } from './aiTranslationApi'
import {
  SUPPORTED_TRANSLATION_LANGUAGES,
  aiTranslationMessages,
  isSupportedTranslationLanguage,
  type SupportedTranslationLanguage,
} from './aiTranslationMessages'

export interface MessageTranslationBlockProps {
  readonly organisationId: string
  readonly channelId: string
  readonly eventId: string
  readonly sourceText: string
  readonly initialTargetLanguage?: SupportedTranslationLanguage | undefined
  readonly onClose?: (() => void) | undefined
}

type TranslationErrorKind = 'forbidden' | 'budget' | 'generic'

type TranslationOutcome =
  | { readonly key: string; readonly kind: 'ready'; readonly translatedText: string }
  | { readonly key: string; readonly kind: 'error'; readonly errorKind: TranslationErrorKind }

export function MessageTranslationBlock({
  organisationId,
  channelId,
  eventId,
  sourceText,
  initialTargetLanguage,
  onClose,
}: MessageTranslationBlockProps) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage === 'en' ? 'en' : 'fr'
  const copy = aiTranslationMessages[locale]
  const selectId = useId()

  const [targetLanguage, setTargetLanguage] = useState<SupportedTranslationLanguage>(
    initialTargetLanguage ?? locale
  )
  const [collapsed, setCollapsed] = useState(false)
  const [reloadCount, setReloadCount] = useState(0)
  const [outcome, setOutcome] = useState<TranslationOutcome | null>(null)

  const trimmedSource = sourceText.trim()
  const requestKey = `${organisationId}:${channelId}:${eventId}:${targetLanguage}:${String(reloadCount)}:${sourceText}`

  useEffect(() => {
    if (trimmedSource === '') {
      return
    }

    const controller = new AbortController()

    requestChannelMessageTranslation({
      organisationId,
      channelId,
      text: sourceText,
      targetLanguage,
      eventId,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return
        setOutcome({
          key: requestKey,
          kind: 'ready',
          translatedText: result.translatedText,
        })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        let errorKind: TranslationErrorKind = 'generic'
        if (err instanceof ApiProblem) {
          if (err.status === 403) {
            errorKind = 'forbidden'
          } else if (err.status === 429) {
            errorKind = 'budget'
          }
        }
        setOutcome({
          key: requestKey,
          kind: 'error',
          errorKind,
        })
      })

    return () => {
      controller.abort()
    }
  }, [organisationId, channelId, eventId, sourceText, trimmedSource, targetLanguage, requestKey])

  const handleLanguageChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value
    if (isSupportedTranslationLanguage(next)) {
      setCollapsed(false)
      setTargetLanguage(next)
    }
  }

  const handleToggleVisibility = () => {
    if (onClose !== undefined) {
      onClose()
      return
    }
    setCollapsed((prev) => !prev)
  }

  const currentOutcome = outcome?.key === requestKey ? outcome : null
  const isEmptyInput = trimmedSource === ''
  const isLoading = !isEmptyInput && currentOutcome === null
  const effectiveErrorKind: TranslationErrorKind | null = isEmptyInput
    ? 'generic'
    : currentOutcome?.kind === 'error'
      ? currentOutcome.errorKind
      : null

  const errorMessage =
    effectiveErrorKind === 'forbidden'
      ? copy.forbiddenNotice
      : effectiveErrorKind === 'budget'
        ? copy.budgetNotice
        : copy.errorNotice

  return (
    <div
      data-testid="message-translation-block"
      aria-live="polite"
      className="mt-2 flex max-w-[600px] flex-col gap-2 rounded-md border border-c-border-soft border-l-2 border-l-c-accent-ink bg-c-sunken px-3 py-2 text-xs text-c-ink-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          data-testid="message-translation-hide-toggle"
          aria-expanded={!collapsed}
          onClick={handleToggleVisibility}
          className="inline-flex items-center gap-1 rounded-sm text-left text-xs font-medium text-c-ink-3 hover:text-c-ink focus-visible:ring focus-visible:outline-hidden"
        >
          <span>{collapsed ? copy.sovereignShow : copy.sovereignHide}</span>
        </button>
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="sr-only">
            {copy.targetLanguageLabel}
          </label>
          <select
            id={selectId}
            data-testid="message-translation-language"
            aria-label={copy.targetLanguageLabel}
            value={targetLanguage}
            onChange={handleLanguageChange}
            className="rounded-sm border border-c-border bg-c-surface px-2 py-1 font-mono text-xs font-medium text-c-ink focus-visible:ring focus-visible:outline-hidden"
          >
            {SUPPORTED_TRANSLATION_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {copy.languages[code]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {collapsed ? null : isLoading ? (
        <p data-testid="message-translation-loading" className="text-xs text-c-ink-3">
          {copy.translating}
        </p>
      ) : effectiveErrorKind !== null ? (
        <div
          role="alert"
          data-testid="message-translation-error"
          className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-c-bad-soft px-2 py-1 text-xs text-c-bad-ink"
        >
          <span>{errorMessage}</span>
          {effectiveErrorKind === 'generic' && !isEmptyInput ? (
            <button
              type="button"
              onClick={() => setReloadCount((prev) => prev + 1)}
              className="rounded-sm px-2 py-1 font-medium hover:underline focus-visible:ring focus-visible:outline-hidden"
            >
              {copy.retry}
            </button>
          ) : null}
        </div>
      ) : currentOutcome?.kind === 'ready' ? (
        <p
          data-testid="message-translation-text"
          lang={targetLanguage}
          className="whitespace-pre-wrap break-words text-sm text-c-ink"
        >
          {currentOutcome.translatedText}
        </p>
      ) : null}
    </div>
  )
}
