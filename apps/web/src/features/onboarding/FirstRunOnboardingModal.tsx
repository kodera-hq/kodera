import { isOrganisationSlug } from '../../api/organisationSlug'
import {
  instantClaimWorkspace,
  InstantClaimError,
  localClaim,
  TEMPLATE_CHANNELS,
  type InstantClaimPayload,
  type ClaimedWorkspace,
  type TemplateId,
} from './instantClaimClient'
import { onboardingCopy } from './onboardingMessages'
import { ClaimWorkspaceSummary } from './ClaimWorkspaceSummary'
import { TerminalDeployCommand } from './TerminalDeployCommand'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/Button/Button'
import { soundEngine } from '../sounds/SoundEngine'
import type { OnboardingStepId } from './onboardingState'
import { markOnboardingCompleted } from './onboardingState'

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
  const copy = onboardingCopy(i18n.resolvedLanguage)
  const heading = useId()
  const modal = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement
    const controls = () =>
      Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary'
        ) ?? []
      )
    modal.current?.querySelector<HTMLElement>('input')?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const items = controls()
      const first = items[0]
      const last = items[items.length - 1]
      if (!modal.current?.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', trap)
    return () => {
      window.removeEventListener('keydown', trap)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [open])

  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [hosting, setHosting] = useState('cloud')
  const [template, setTemplate] = useState('audiovisual')
  const [theme, setTheme] = useState<string>(initialThemeMode ?? (isDarkTheme ? 'dark' : 'light'))
  const [copied, setCopied] = useState(false)
  const [result, setResult] = useState<ClaimedWorkspace | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState(false)
  const [localRefused, setLocalRefused] = useState(false)
  const currentRequest = useRef<AbortController | null>(null)
  const requestEpoch = useRef(0)
  const intent = useRef({ signature: '', key: '' })
  useEffect(
    () => () => {
      requestEpoch.current++
      currentRequest.current?.abort()
      currentRequest.current = null
    },
    [open]
  )
  const canonicalTemplate: TemplateId =
    (
      {
        audiovisual: 'audiovisual-production',
        'studio-tech': 'tech-studio',
        'conseil-b2b': 'b2b-advisory',
        'secteur-public': 'public-sector',
        'cellule-crise': 'crisis-cell',
      } as const
    )[template as 'audiovisual'] ?? 'tech-studio'
  const finish = async () => {
    if (currentRequest.current) return
    setRefused(false)
    setLocalRefused(false)
    const localMode =
      hosting !== 'cloud' || (claimMode ?? (onConfigure ? 'preview' : 'cloud')) === 'preview'
    const slug = name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '')
      .slice(0, localMode ? 20 : 32)
      .replace(/-$/gu, '')
    const payload: InstantClaimPayload = {
      organizationName: name.trim(),
      slug,
      hostingMode: hosting === 'cloud' ? 'cloud' : 'self-host',
      templateId: canonicalTemplate,
      themeId: theme === 'black' ? 'real-black' : theme === 'dark' ? 'ardoise' : 'givre',
      soundPackId: soundEngine.getPreferences().pack,
      enabledConnectors:
        canonicalTemplate === 'audiovisual-production' ? ['frameio-review-bridge'] : [],
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
        onConfigure?.({ name: name.trim(), hosting, template, theme })
        setResult(claimed)
        markOnboardingCompleted()
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
      setResult(claimed)
      onClaimed?.(claimed)
      markOnboardingCompleted()
      window.dispatchEvent(
        new CustomEvent('kodera:workspace-claimed', { detail: { slug: payload.slug } })
      )
    } catch (error) {
      if (controller.signal.aborted || epoch !== requestEpoch.current) return
      if (error instanceof InstantClaimError && error.kind === 'unavailable') {
        setResult(localClaim(payload))
        onConfigure?.({ name: name.trim(), hosting, template, theme })
        markOnboardingCompleted()
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
      setStep(0)
      setResult(null)
      setBusy(false)
      setRefused(false)
      setLocalRefused(false)
      setTheme(initialThemeMode ?? (isDarkTheme ? 'dark' : 'light'))
      setCopied(false)
    }
  }
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        markOnboardingCompleted()
        onDismiss()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open, onDismiss])
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
  const templates = [
    ['audiovisual', t('console.onboarding.studio.studio')],
    ['studio-tech', t('console.onboarding.studio.tech')],
    ['conseil-b2b', t('console.onboarding.studio.consulting')],
    ['secteur-public', t('console.onboarding.studio.public')],
    ['cellule-crise', t('console.onboarding.studio.crisis')],
  ]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-c-sunken p-4">
      <section
        ref={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        data-testid="kodera-onboarding-modal"
        className="flex max-h-full w-full max-w-[680px] flex-col gap-4 overflow-auto rounded-lg border border-c-border bg-c-surface p-6"
      >
        <header className="flex items-center justify-between gap-3">
          <h2 id={heading} className="text-xl font-semibold">
            {titles[step]}
          </h2>
          <Button variant="tertiary" onClick={onDismiss}>
            {t('console.onboarding.studio.close')}
          </Button>
        </header>
        <p role="status">{step + 1} / 3</p>
        {busy ? <p role="status">{copy.assigning}</p> : null}
        {refused ? <p role="alert">{copy.refused}</p> : null}
        {localRefused ? <p role="alert">{copy.localRefused}</p> : null}
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
                className="w-full rounded-md border border-c-border p-3"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value.replace(/[\p{Cc}\p{Cf}]/gu, ''))}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm">
              {t('console.onboarding.studio.hosting')}
              <select value={hosting} onChange={(e) => setHosting(e.target.value)}>
                <option value="cloud">{t('console.onboarding.studio.cloud')}</option>
                <option value="selfhost">{t('console.onboarding.studio.selfhost')}</option>
              </select>
            </label>
          </div>
        ) : step === 1 ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-2 text-sm">
              {t('console.onboarding.studio.template')}
              <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                {templates.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <section
              aria-label={t('console.onboarding.studio.preview')}
              className="rounded-md border border-c-border p-4"
            >
              <ul>
                {TEMPLATE_CHANNELS[canonicalTemplate].map((channel, index) => (
                  <li key={channel}>
                    {template === 'audiovisual' && index > 3 ? '🔊 ' : '#'}
                    {channel === 'stage-control'
                      ? t('console.onboarding.studio.stage')
                      : channel === 'editing-room'
                        ? t('console.onboarding.studio.editing')
                        : channel}
                  </li>
                ))}
              </ul>
              {template === 'audiovisual' ? (
                <>
                  <p>{t('console.onboarding.studio.roles')}</p>
                  <p>{t('console.onboarding.studio.pad')}</p>
                  <p>{t('console.onboarding.studio.integrations-studio')}</p>
                </>
              ) : (
                <p>{t('console.onboarding.studio.integrations-tech')}</p>
              )}
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
                <option value="atelier">{t('console.onboarding.studio.sound-atelier')}</option>
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
        {step === 2 && hosting === 'selfhost' ? (
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
    </div>
  )
}
