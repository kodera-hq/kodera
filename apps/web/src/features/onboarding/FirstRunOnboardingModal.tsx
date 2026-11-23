import * as Modal from '@radix-ui/react-dialog'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { track } from '../../analytics/track'
import { isOrganisationSlug } from '../../api/organisationSlug'
import { Button } from '../../ui/Button/Button'
import { cx } from '../../ui/cx'
import { soundEngine } from '../sounds/SoundEngine'
import { ClaimWorkspaceSummary } from './ClaimWorkspaceSummary'
import {
  CONNECTOR_IDS,
  InstantClaimError,
  instantClaimWorkspace,
  isClaimConnectorId,
  localClaim,
  TEMPLATE_CHANNELS,
  type ClaimConnectorId,
  type ClaimCustomization,
  type ClaimedWorkspace,
  type InstantClaimPayload,
  type TemplateId,
} from './instantClaimClient'
import { onboardingCopy } from './onboardingMessages'
import {
  completeActivationTask,
  markOnboardingCompleted,
  type OnboardingStepId,
} from './onboardingState'
import {
  CONNECTOR_LABELS,
  getTemplatePersona,
  resolveCustomChannelDraft,
  resolveSelectionTemplateId,
  type StarterChannelDescriptor,
  type TemplateSelectionId,
} from './TemplatePersonaCatalog'
import { TerminalDeployCommand } from './TerminalDeployCommand'

export interface FirstRunOnboardingModalProps {
  readonly claimMode?: 'cloud' | 'preview' | undefined
  readonly onClaimed?: ((workspace: ClaimedWorkspace) => void) | undefined
  readonly initialThemeMode?: 'light' | 'dark' | 'black' | undefined
  readonly invitationUrl?: string | undefined
  readonly onConfigure?:
    | ((config: { name: string; hosting: string; template: string; theme: string }) => void)
    | undefined
  readonly open: boolean
  readonly initialStep?: OnboardingStepId | undefined
  readonly isDarkTheme: boolean
  readonly activeChannelId?: string | undefined
  readonly onSelectTheme: (dark: boolean) => void
  readonly onNavigateChannel?: ((channelId: string) => void) | undefined
  readonly onOpenAugmentStudio?: (() => void) | undefined
  readonly onComplete: () => void
  readonly onDismiss: () => void
}

interface TemplateCustomizationState {
  readonly templateId: TemplateId
  readonly excluded: readonly string[]
  readonly customChannels: readonly StarterChannelDescriptor[]
  readonly connectors: readonly ClaimConnectorId[] | null
}

export const STUDIO_CHANNELS = TEMPLATE_CHANNELS['audiovisual-production']

export function FirstRunOnboardingModal({
  open,
  claimMode,
  onClaimed,
  isDarkTheme,
  initialThemeMode,
  onSelectTheme,
  onConfigure,
  invitationUrl,
  onComplete,
  onDismiss,
}: FirstRunOnboardingModalProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr'
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const heading = useId()
  const slugHint = useId()
  const customChannelInputId = useId()

  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [customSlug, setCustomSlug] = useState<string | null>(null)
  const [hosting, setHosting] = useState('cloud')
  const [template, setTemplate] = useState('audiovisual')
  const [theme, setTheme] = useState<string>(initialThemeMode ?? (isDarkTheme ? 'dark' : 'light'))
  const [copied, setCopied] = useState(false)
  const [result, setResult] = useState<ClaimedWorkspace | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState(false)
  const [localRefused, setLocalRefused] = useState(false)
  const [customizationState, setCustomizationState] = useState<TemplateCustomizationState | null>(
    null
  )
  const [customChannelDraft, setCustomChannelDraft] = useState('')
  const [customChannelKind, setCustomChannelKind] = useState<'text' | 'audio'>('text')

  const currentRequest = useRef<AbortController | null>(null)
  const requestEpoch = useRef(0)
  const intent = useRef({ signature: '', key: '' })
  const previewMode = (claimMode ?? (onConfigure ? 'preview' : 'cloud')) === 'preview'
  const localMode = hosting !== 'cloud' || previewMode
  const selectedTemplate = !previewMode && template === 'open-source' ? 'audiovisual' : template
  const slug =
    customSlug ??
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, localMode ? 20 : 32)
      .replace(/-$/gu, '')
  const validSlug = localMode
    ? isOrganisationSlug(slug)
    : /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u.test(slug)

  useEffect(
    () => () => {
      requestEpoch.current++
      currentRequest.current?.abort()
      currentRequest.current = null
    },
    [open]
  )

  const canonicalTemplate = resolveSelectionTemplateId(selectedTemplate)
  const persona = getTemplatePersona(canonicalTemplate)
  const activeCustomization: TemplateCustomizationState =
    customizationState?.templateId === canonicalTemplate
      ? customizationState
      : {
          templateId: canonicalTemplate,
          excluded: [],
          customChannels: [],
          connectors: null,
        }

  const excludedSet = new Set(activeCustomization.excluded)
  const allChannels: readonly StarterChannelDescriptor[] = [
    ...persona.starterChannels,
    ...activeCustomization.customChannels,
  ]
  const enabledChannels = allChannels.filter((channel) => !excludedSet.has(channel.templateKey))
  const enabledTextCount = enabledChannels.filter((channel) => channel.kind === 'text').length

  const rawConnectors = activeCustomization.connectors ?? persona.defaultConnectors
  const validatedConnectors = [...new Set(rawConnectors.filter(isClaimConnectorId))].slice(0, 10)

  const selectTemplateOption = (nextSelection: string) => {
    setTemplate(nextSelection)
    setCustomizationState(null)
    setCustomChannelDraft('')
    setCustomChannelKind('text')
  }

  const toggleChannel = (channel: StarterChannelDescriptor) => {
    const currentlyEnabled = !excludedSet.has(channel.templateKey)
    if (currentlyEnabled && channel.kind === 'text' && enabledTextCount <= 1) {
      return
    }
    const nextExcluded = currentlyEnabled
      ? [...activeCustomization.excluded, channel.templateKey]
      : activeCustomization.excluded.filter((key) => key !== channel.templateKey)
    setCustomizationState({
      ...activeCustomization,
      excluded: nextExcluded,
    })
  }

  const removeCustomChannel = (templateKey: string) => {
    const target = activeCustomization.customChannels.find((ch) => ch.templateKey === templateKey)
    if (target !== undefined && !excludedSet.has(templateKey) && target.kind === 'text') {
      if (enabledTextCount <= 1) return
    }
    setCustomizationState({
      ...activeCustomization,
      excluded: activeCustomization.excluded.filter((item) => item !== templateKey),
      customChannels: activeCustomization.customChannels.filter(
        (ch) => ch.templateKey !== templateKey
      ),
    })
  }

  const resolvedCustomKey = resolveCustomChannelDraft(customChannelDraft, allChannels)

  const addCustomChannel = () => {
    if (resolvedCustomKey === null || activeCustomization.customChannels.length >= 16) {
      return
    }
    const targetCategoryKey =
      customChannelKind === 'audio' ? persona.defaultAudioCategoryKey : persona.defaultCategoryKey
    setCustomizationState({
      ...activeCustomization,
      customChannels: [
        ...activeCustomization.customChannels,
        {
          categoryKey: targetCategoryKey,
          templateKey: resolvedCustomKey,
          name: resolvedCustomKey,
          kind: customChannelKind,
        },
      ],
    })
    setCustomChannelDraft('')
  }

  const toggleConnector = (connectorId: ClaimConnectorId) => {
    if (!isClaimConnectorId(connectorId)) return
    const exists = validatedConnectors.includes(connectorId)
    if (!exists && validatedConnectors.length >= 10) return
    const nextConnectors = exists
      ? validatedConnectors.filter((id) => id !== connectorId)
      : [...validatedConnectors, connectorId]
    setCustomizationState({
      ...activeCustomization,
      connectors: nextConnectors,
    })
  }

  const recordInitialActivation = (orgSlug: string) => {
    completeActivationTask(orgSlug, 'identity_template')
    completeActivationTask(orgSlug, 'theme_sonic')
  }

  const finish = async () => {
    if (currentRequest.current) return
    setRefused(false)
    setLocalRefused(false)

    const excludedStarterKeys = persona.starterChannels
      .map((ch) => ch.templateKey)
      .filter((key) => excludedSet.has(key))
    const activeCustomAdditions = activeCustomization.customChannels
      .filter((ch) => !excludedSet.has(ch.templateKey))
      .map((ch) => ({
        categoryKey: ch.categoryKey,
        name: ch.name,
        kind: ch.kind,
      }))
    const customization: ClaimCustomization | undefined =
      excludedStarterKeys.length > 0 || activeCustomAdditions.length > 0
        ? {
            includeAudioChannels: true,
            includeCollections: true,
            includeStarterDocs: true,
            ...(excludedStarterKeys.length > 0 ? { excludedChannelKeys: excludedStarterKeys } : {}),
            ...(activeCustomAdditions.length > 0
              ? { additionalChannels: activeCustomAdditions }
              : {}),
          }
        : undefined

    const payload: InstantClaimPayload = {
      organizationName: name.trim(),
      slug,
      hostingMode: hosting === 'cloud' ? 'cloud' : 'self-host',
      templateId: canonicalTemplate,
      themeId: theme === 'black' ? 'real-black' : theme === 'dark' ? 'ardoise' : 'givre',
      soundPackId: soundEngine.getPreferences().pack,
      enabledConnectors: validatedConnectors,
      ...(customization === undefined ? {} : { customization }),
    }
    // Local preview creation remains inside the registered demo capability.
    if (localMode) {
      if (!isOrganisationSlug(slug)) {
        setLocalRefused(true)
        return
      }
      try {
        const claimed = localClaim(payload)
        onClaimed?.(claimed)
        onConfigure?.({ name: name.trim(), hosting, template: selectedTemplate, theme })
        recordInitialActivation(payload.slug)
        setResult(claimed)
        markOnboardingCompleted()
        track('onboarding_completed', { mode: localMode ? 'local' : 'cloud' })
        onComplete()
      } catch {
        setLocalRefused(true)
      }
      return
    }
    const signature = JSON.stringify(payload)
    if (intent.current.signature !== signature)
      intent.current = { signature, key: crypto.randomUUID() }
    const controller = new AbortController()
    currentRequest.current = controller
    const epoch = ++requestEpoch.current
    setBusy(true)
    try {
      const claimed = await instantClaimWorkspace(payload, {
        signal: controller.signal,
        idempotencyKey: intent.current.key,
      })
      if (controller.signal.aborted || epoch !== requestEpoch.current) return
      recordInitialActivation(payload.slug)
      setResult(claimed)
      onClaimed?.(claimed)
      markOnboardingCompleted()
      track('onboarding_completed', { mode: localMode ? 'local' : 'cloud' })
      window.dispatchEvent(
        new CustomEvent('kodera:workspace-claimed', { detail: { slug: payload.slug } })
      )
    } catch (error) {
      if (controller.signal.aborted || epoch !== requestEpoch.current) return
      if (error instanceof InstantClaimError && error.kind === 'unavailable') {
        recordInitialActivation(payload.slug)
        setResult(localClaim(payload))
        onConfigure?.({ name: name.trim(), hosting, template: selectedTemplate, theme })
        markOnboardingCompleted()
        track('onboarding_completed', { mode: localMode ? 'local' : 'cloud' })
        onComplete()
      } else setRefused(true)
    } finally {
      if (epoch === requestEpoch.current) {
        currentRequest.current = null
        setBusy(false)
      }
    }
  }

  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setName('')
      setCustomSlug(null)
      setStep(0)
      setResult(null)
      setBusy(false)
      setRefused(false)
      setLocalRefused(false)
      setTheme(initialThemeMode ?? (isDarkTheme ? 'dark' : 'light'))
      setCopied(false)
      setCustomizationState(null)
      setCustomChannelDraft('')
      setCustomChannelKind('text')
    }
  }

  if (!open)
    return result ? (
      <ClaimWorkspaceSummary
        workspace={result}
        busy={busy}
        refused={refused}
        onRetry={
          (claimMode ?? (onConfigure ? 'preview' : 'cloud')) === 'cloud'
            ? () => void finish()
            : undefined
        }
      />
    ) : null

  const titles = [
    t('console.onboarding.studio.identity'),
    t('console.onboarding.studio.template'),
    t('console.onboarding.studio.finish'),
  ]
  const templates: readonly (readonly [TemplateSelectionId, string])[] = [
    ['audiovisual', copy.studioTemplate],
    ['studio-tech', copy.productTemplate],
    ['conseil-b2b', t('console.onboarding.studio.consulting')],
    ['association-coop', copy.associationTemplate],
    ['secteur-public', copy.publicTemplate],
    ['blank', copy.blankTemplate],
    ['proximity', t('console.onboarding.studio.proximity')],
    ...(previewMode ? ([['open-source', copy.communityTemplate]] as const) : []),
  ]

  const orderedConnectors: readonly ClaimConnectorId[] = [
    ...persona.defaultConnectors,
    ...CONNECTOR_IDS.filter((id) => !persona.defaultConnectors.includes(id)),
  ]

  const channelDisplayName = (channelName: string) =>
    channelName === 'stage-control'
      ? t('console.onboarding.studio.stage')
      : channelName === 'editing-room'
        ? t('console.onboarding.studio.editing')
        : channelName === 'proximity'
          ? // A label only: the channel is still named `proximity`.
            t('console.onboarding.studio.channel-proximity')
          : channelName

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <Modal.Portal>
        {/* A scrim darkens the page; a surface role replaces it, which reads as the screen
            changing colour on the way in. */}
        <Modal.Overlay className="fixed inset-0 z-40 bg-c-scrim" />
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <Modal.Content
            asChild
            aria-describedby={undefined}
            onEscapeKeyDown={() => markOnboardingCompleted()}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby={heading}
              data-testid="kodera-onboarding-modal"
              className="flex max-h-full w-full max-w-[680px] flex-col gap-4 overflow-auto rounded-lg border border-c-border bg-c-surface p-6"
            >
              <header className="flex items-center justify-between gap-3">
                <Modal.Title asChild>
                  <h2 id={heading} className="text-xl font-semibold">
                    {titles[step]}
                  </h2>
                </Modal.Title>
                <Button variant="tertiary" onClick={onDismiss}>
                  {t('console.onboarding.studio.close')}
                </Button>
              </header>
              <p role="status">{step + 1} / 3</p>
              {busy ? <p role="status">{copy.assigning}</p> : null}
              {refused ? <p role="alert">{copy.refused}</p> : null}
              {localRefused ? (
                <p role="alert">{localMode ? copy.localRefused : copy.cloudSlugHint}</p>
              ) : null}
              {result?.mode === 'cloud' ? (
                <ClaimWorkspaceSummary workspace={result} />
              ) : step === 0 ? (
                <div className="flex flex-col gap-4">
                  <div
                    className="logo-tile-black flex h-12 w-12 items-center justify-center rounded-lg font-semibold"
                    aria-hidden="true"
                  >
                    {name.trim().slice(0, 2).toUpperCase() || 'K'}
                  </div>
                  <label className="flex flex-col gap-2 text-sm">
                    {t('console.onboarding.studio.name')}
                    <input
                      className="w-full rounded-md border border-c-border bg-c-surface p-3 text-c-ink focus-visible:ring"
                      maxLength={80}
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value.replace(/[\p{Cc}\p{Cf}]/gu, ''))
                        setLocalRefused(false)
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm">
                    {copy.slug}
                    <input
                      className="w-full rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
                      value={slug}
                      maxLength={localMode ? 20 : 32}
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-invalid={localRefused}
                      aria-describedby={slugHint}
                      onChange={(event) => {
                        setCustomSlug(event.target.value.toLowerCase())
                        setLocalRefused(false)
                      }}
                    />
                  </label>
                  <p id={slugHint} className="text-xs text-c-ink-3">
                    {localMode ? copy.slugHint : copy.cloudSlugHint}
                  </p>
                  <label className="flex flex-col gap-2 text-sm">
                    {t('console.onboarding.studio.hosting')}
                    <select
                      className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink focus-visible:ring"
                      value={hosting}
                      onChange={(e) => setHosting(e.target.value)}
                    >
                      <option value="cloud">{t('console.onboarding.studio.cloud')}</option>
                      <option value="selfhost">{t('console.onboarding.studio.selfhost')}</option>
                    </select>
                  </label>
                </div>
              ) : step === 1 ? (
                <div className="flex flex-col gap-3">
                  <label className="flex flex-col gap-2 text-sm">
                    {t('console.onboarding.studio.template')}
                    <select
                      className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink focus-visible:ring"
                      value={selectedTemplate}
                      onChange={(e) => selectTemplateOption(e.target.value)}
                    >
                      {templates.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div
                    role="group"
                    aria-label={copy.personaGroupLabel}
                    className="grid grid-cols-2 gap-2 narrow:grid-cols-1"
                  >
                    {templates.map(([selectionId, label]) => {
                      const cardPersona = getTemplatePersona(
                        resolveSelectionTemplateId(selectionId)
                      )
                      const active = selectedTemplate === selectionId
                      return (
                        <button
                          key={selectionId}
                          type="button"
                          data-persona-card={cardPersona.templateId}
                          aria-pressed={active}
                          onClick={() => selectTemplateOption(selectionId)}
                          className={cx(
                            'flex min-h-10 flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors duration-fast focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none',
                            active
                              ? 'border-c-accent-ink bg-c-accent-soft text-c-ink'
                              : 'border-c-border bg-c-surface text-c-ink hover:bg-c-sunken'
                          )}
                        >
                          <span className="flex w-full items-center justify-between gap-2">
                            <span className="text-sm font-semibold">{label}</span>
                            <span className="rounded-full bg-c-sunken px-2 py-1 font-mono text-xs text-c-accent-ink">
                              {copy.setupBadge}
                            </span>
                          </span>
                          <span className="text-xs text-c-ink-2">
                            {cardPersona.summary[locale]}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3">
                    <span className="text-xs font-semibold text-c-ink">
                      {copy.starterChannelsGroup}
                    </span>
                    <div
                      role="group"
                      aria-label={copy.starterChannelsGroup}
                      className="flex flex-wrap gap-2"
                    >
                      {persona.starterChannels.map((channel) => {
                        const enabled = !excludedSet.has(channel.templateKey)
                        return (
                          <button
                            key={channel.templateKey}
                            type="button"
                            data-channel-chip={channel.templateKey}
                            aria-pressed={enabled}
                            onClick={() => toggleChannel(channel)}
                            className={cx(
                              'inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-fast focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none',
                              enabled
                                ? 'border-c-accent-ink bg-c-surface text-c-ink'
                                : 'border-c-border bg-c-muted text-c-ink-3'
                            )}
                          >
                            <span aria-hidden="true">{channel.kind === 'audio' ? '🔊' : '#'}</span>
                            <span>{channelDisplayName(channel.name)}</span>
                          </button>
                        )
                      })}
                      {activeCustomization.customChannels.map((channel) => {
                        const enabled = !excludedSet.has(channel.templateKey)
                        return (
                          <div key={channel.templateKey} className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              data-channel-chip={channel.templateKey}
                              aria-pressed={enabled}
                              onClick={() => toggleChannel(channel)}
                              className={cx(
                                'inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-fast focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none',
                                enabled
                                  ? 'border-c-accent-ink bg-c-surface text-c-ink'
                                  : 'border-c-border bg-c-muted text-c-ink-3'
                              )}
                            >
                              <span aria-hidden="true">
                                {channel.kind === 'audio' ? '🔊' : '#'}
                              </span>
                              <span>{channel.name}</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`${copy.removeCustomChannel} ${channel.name}`}
                              onClick={() => removeCustomChannel(channel.templateKey)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-c-border bg-c-surface text-xs text-c-ink-3 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none"
                            >
                              ×
                            </button>
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <label htmlFor={customChannelInputId} className="sr-only">
                        {copy.customChannelLabel}
                      </label>
                      <input
                        id={customChannelInputId}
                        type="text"
                        maxLength={64}
                        value={customChannelDraft}
                        placeholder={copy.customChannelPlaceholder}
                        onChange={(e) =>
                          setCustomChannelDraft(
                            e.target.value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addCustomChannel()
                          }
                        }}
                        className="min-h-8 min-w-0 flex-1 rounded-md border border-c-border-input bg-c-surface px-3 py-1 text-xs text-c-ink placeholder:text-c-placeholder focus-visible:ring focus-visible:outline-hidden"
                      />
                      <div
                        role="group"
                        aria-label={copy.customChannelKindGroup}
                        className="inline-flex items-center gap-1"
                      >
                        <button
                          type="button"
                          aria-pressed={customChannelKind === 'text'}
                          onClick={() => setCustomChannelKind('text')}
                          className={cx(
                            'min-h-8 rounded-md border px-2 py-1 text-xs font-medium focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none',
                            customChannelKind === 'text'
                              ? 'border-c-accent-ink bg-c-accent-soft text-c-ink'
                              : 'border-c-border bg-c-surface text-c-ink-2'
                          )}
                        >
                          # {copy.customChannelText}
                        </button>
                        <button
                          type="button"
                          aria-pressed={customChannelKind === 'audio'}
                          onClick={() => setCustomChannelKind('audio')}
                          className={cx(
                            'min-h-8 rounded-md border px-2 py-1 text-xs font-medium focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none',
                            customChannelKind === 'audio'
                              ? 'border-c-accent-ink bg-c-accent-soft text-c-ink'
                              : 'border-c-border bg-c-surface text-c-ink-2'
                          )}
                        >
                          🔊 {copy.customChannelAudio}
                        </button>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={
                          resolvedCustomKey === null ||
                          activeCustomization.customChannels.length >= 16
                        }
                        onClick={addCustomChannel}
                      >
                        {copy.addChannel}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3">
                    <span className="text-xs font-semibold text-c-ink">{copy.connectors}</span>
                    <div role="group" aria-label={copy.connectors} className="flex flex-wrap gap-2">
                      {orderedConnectors.map((connectorId) => {
                        const enabled = validatedConnectors.includes(connectorId)
                        return (
                          <button
                            key={connectorId}
                            type="button"
                            data-connector-chip={connectorId}
                            aria-pressed={enabled}
                            onClick={() => toggleConnector(connectorId)}
                            className={cx(
                              'inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-fast focus-visible:ring focus-visible:outline-hidden motion-reduce:transition-none',
                              enabled
                                ? 'border-c-accent-ink bg-c-accent-soft text-c-ink'
                                : 'border-c-border bg-c-surface text-c-ink-2 hover:bg-c-muted'
                            )}
                          >
                            <span>{CONNECTOR_LABELS[connectorId][locale]}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <section
                    aria-label={t('console.onboarding.studio.preview')}
                    className="flex flex-col gap-2 rounded-md border border-c-border p-4"
                  >
                    <ul>
                      {enabledChannels.map((channel) => (
                        <li key={channel.templateKey}>
                          {channel.kind === 'audio' ? '🔊 ' : '#'}
                          {channelDisplayName(channel.name)}
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-c-ink-2">
                      <strong>{copy.rolesHeading} :</strong>{' '}
                      {selectedTemplate === 'audiovisual'
                        ? t('console.onboarding.studio.roles')
                        : persona.recommendedRoles[locale].map((role) => `@${role}`).join(' · ')}
                    </p>
                    <p className="text-xs text-c-ink-2">
                      <strong>{copy.docsCollectionsHeading} :</strong>{' '}
                      {selectedTemplate === 'audiovisual'
                        ? t('console.onboarding.studio.pad')
                        : `${persona.starterDocsSummary[locale]} · ${persona.starterCollectionsSummary[locale]}`}
                    </p>
                    <p className="text-xs text-c-ink-3">
                      {selectedTemplate === 'audiovisual'
                        ? t('console.onboarding.studio.integrations-studio')
                        : validatedConnectors.length > 0
                          ? validatedConnectors
                              .map((id) => CONNECTOR_LABELS[id][locale])
                              .join(' · ')
                          : t('console.onboarding.studio.integrations-tech')}
                    </p>
                  </section>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-2 text-sm">
                    {t('console.onboarding.studio.theme')}
                    <select
                      className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
                      value={theme}
                      onChange={(e) => {
                        setTheme(e.target.value)
                        onSelectTheme(e.target.value !== 'light')
                      }}
                    >
                      <option value="light">{t('console.onboarding.studio.light')}</option>
                      <option value="dark">{t('console.onboarding.studio.dark')}</option>
                      <option value="black">{t('console.onboarding.studio.black')}</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-2 text-sm">
                    {t('console.onboarding.studio.sound')}
                    <select
                      className="rounded-md border border-c-border bg-c-surface p-3 text-c-ink"
                      defaultValue={soundEngine.getPreferences().pack}
                      onChange={(e) => {
                        if (e.target.value === 'givre' || e.target.value === 'atelier')
                          soundEngine.setPack(e.target.value)
                      }}
                    >
                      <option value="givre">{t('console.onboarding.studio.sound-givre')}</option>
                      <option value="atelier">
                        {t('console.onboarding.studio.sound-atelier')}
                      </option>
                    </select>
                  </label>
                  {invitationUrl ? (
                    <Button
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(invitationUrl)
                          .then(() => setCopied(true))
                          .catch(() => setCopied(false))
                      }}
                    >
                      {copied
                        ? t('console.onboarding.studio.copied')
                        : t('console.onboarding.studio.invite')}
                    </Button>
                  ) : (
                    <p>{t('console.onboarding.studio.invite-unavailable')}</p>
                  )}
                </div>
              )}
              {step === 2 &&
              hosting === 'selfhost' &&
              canonicalTemplate !== 'open-source-community' ? (
                <TerminalDeployCommand template={canonicalTemplate} />
              ) : null}
              {result?.mode === 'cloud' ? null : (
                <footer className="flex justify-between gap-3">
                  <Button disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>
                    {t('console.onboarding.studio.back')}
                  </Button>
                  <Button
                    disabled={!name.trim() || busy}
                    onClick={() => {
                      if (step === 0 && !validSlug) {
                        setLocalRefused(true)
                        return
                      }
                      if (step < 2) setStep(step + 1)
                      else void finish()
                    }}
                  >
                    {step === 2
                      ? t('console.onboarding.studio.open')
                      : t('console.onboarding.studio.next')}
                  </Button>
                </footer>
              )}
            </section>
          </Modal.Content>
        </div>
      </Modal.Portal>
    </Modal.Root>
  )
}
