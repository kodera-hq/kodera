import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { ModuleGlyph } from '@/ui/icons/ModuleGlyph'
import { TerminalDeployCommand } from './TerminalDeployCommand'
import {
  PROVIDER_API_ORIGINS,
  REDACTED_TOKEN_PREVIEW,
  SELF_HOST_PROVIDERS,
  safeValidateSelfHostSpec,
} from './plan'
import type {
  SelfHostCloudProvider,
  SelfHostDeploymentPlan,
  SelfHostValidationErrorCode,
} from './types'

export interface SelfHostDeployerPanelProps {
  readonly defaultProvider?: SelfHostCloudProvider | undefined
  readonly defaultRegion?: string | undefined
  readonly defaultFqdn?: string | undefined
  readonly defaultAcmeEmail?: string | undefined
  readonly onPlanValidated?: ((plan: SelfHostDeploymentPlan) => void) | undefined
}

interface ValidationErrorState {
  readonly code: SelfHostValidationErrorCode
  readonly message: string
}

const SELF_HOST_PANEL_COPY = {
  fr: {
    heading: "Assistant d'auto-hébergement 1-clic (Aperçu de validation locale)",
    targetPrefix: 'Cible',
    endpointLabel: 'Point de terminaison API :',
    statusBadge: 'Validation locale uniquement',
    privacyNoteAria: 'Divulgation de confidentialité et de non-transmission du jeton',
    privacyTitle: 'Aucun appel réseau ni stockage du jeton API dans le navigateur',
    privacyLead:
      'Cet écran valide localement vos paramètres et génère la matrice DNS ainsi que l’aperçu',
    privacyMid: 'sans transmettre votre jeton API à',
    privacyTail:
      'ni provisionner de serveur distant depuis le navigateur. Le jeton reste masqué',
    providerHeading: "Fournisseur d'infrastructure VPS",
    providerGroupAria: 'Fournisseur cloud',
    regionLabel: (examples: string) => `Région du fournisseur (${examples})`,
    fqdnLabel: 'Domaine public (FQDN)',
    fqdnPlaceholder: 'chat.organisation.fr',
    emailLabel: "E-mail administrateur ACME (TLS Let's Encrypt)",
    emailPlaceholder: 'ops@organisation.fr',
    tokenLabel: 'Jeton API fournisseur éphémère (16 à 512 caractères ASCII)',
    tokenPlaceholder: 'Saisi en mémoire locale uniquement',
    helperNote:
      "Vérifie le domaine public, l'adresse ACME, la région et le format du jeton sans exposer le secret.",
    validateAction: 'Valider la configuration localement',
    validationRefused: (code: string, msg: string) => `Validation refusée (${code}) : ${msg}`,
    planRegionAria: 'Plan de déploiement validé',
    planValidatedFor: (fqdn: string, provider: string, region: string) =>
      `Configuration validée pour ${fqdn} (${provider} • ${region})`,
    tokenBadge: (redacted: string) => `Jeton : ${redacted}`,
    dnsMatrixHeading: (count: number) => `Matrice d'enregistrements DNS requis (${count})`,
    envHeading: 'Aperçu des variables publiques deploy/community',
    envAria: 'Variables deploy/community',
  },
  en: {
    heading: '1-click self-hosting assistant (Local validation preview)',
    targetPrefix: 'Target',
    endpointLabel: 'API endpoint:',
    statusBadge: 'Local validation only',
    privacyNoteAria: 'Privacy and token non-transmission disclosure',
    privacyTitle: 'No network call or browser storage of the API token',
    privacyLead: 'This screen locally validates your parameters and builds the DNS matrix and',
    privacyMid: 'preview without sending your API token to',
    privacyTail: 'or provisioning any remote server from the browser. The token stays masked',
    providerHeading: 'VPS infrastructure provider',
    providerGroupAria: 'Cloud provider',
    regionLabel: (examples: string) => `Provider region (${examples})`,
    fqdnLabel: 'Public domain (FQDN)',
    fqdnPlaceholder: 'chat.organisation.eu',
    emailLabel: "ACME administrator email (Let's Encrypt TLS)",
    emailPlaceholder: 'ops@organisation.eu',
    tokenLabel: 'Ephemeral provider API token (16 to 512 ASCII characters)',
    tokenPlaceholder: 'Held in local memory only',
    helperNote:
      'Checks the public domain, ACME email, region, and token format without exposing the secret.',
    validateAction: 'Validate configuration locally',
    validationRefused: (code: string, msg: string) => `Validation refused (${code}): ${msg}`,
    planRegionAria: 'Validated deployment plan',
    planValidatedFor: (fqdn: string, provider: string, region: string) =>
      `Configuration validated for ${fqdn} (${provider} • ${region})`,
    tokenBadge: (redacted: string) => `Token: ${redacted}`,
    dnsMatrixHeading: (count: number) => `Required DNS records matrix (${count})`,
    envHeading: 'Public deploy/community environment preview',
    envAria: 'deploy/community variables',
  },
} as const

export function SelfHostDeployerPanel({
  defaultProvider = 'scaleway',
  defaultRegion = 'fr-par-1',
  defaultFqdn = 'chat.acme-corp.eu',
  defaultAcmeEmail = 'ops@acme-corp.eu',
  onPlanValidated,
}: SelfHostDeployerPanelProps) {
  const { i18n } = useTranslation()
  const locale = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'fr'
  const copy = SELF_HOST_PANEL_COPY[locale]

  const headingId = useId()
  const regionInputId = useId()
  const fqdnInputId = useId()
  const emailInputId = useId()
  const tokenInputId = useId()

  const tokenInputRef = useRef<HTMLInputElement | null>(null)

  const [provider, setProvider] = useState<SelfHostCloudProvider>(defaultProvider)
  const [region, setRegion] = useState<string>(defaultRegion)
  const [fqdn, setFqdn] = useState<string>(defaultFqdn)
  const [acmeEmail, setAcmeEmail] = useState<string>(defaultAcmeEmail)
  const [validatedPlan, setValidatedPlan] = useState<SelfHostDeploymentPlan | null>(null)
  const [validationError, setValidationError] = useState<ValidationErrorState | null>(null)

  const selectedProviderMeta = useMemo(
    () => SELF_HOST_PROVIDERS.find((item) => item.id === provider) ?? SELF_HOST_PROVIDERS[0]!,
    [provider]
  )

  const handleSelectProvider = (nextProvider: SelfHostCloudProvider) => {
    setProvider(nextProvider)
    const found = SELF_HOST_PROVIDERS.find((item) => item.id === nextProvider)
    if (found !== undefined) {
      setRegion(found.defaultRegion)
    }
    setValidationError(null)
  }

  const handleValidate = () => {
    const rawToken = tokenInputRef.current?.value ?? ''
    const result = safeValidateSelfHostSpec(
      {
        provider,
        region,
        fqdn,
        acmeEmail,
        rawToken,
      },
      locale
    )

    if (!result.ok) {
      setValidatedPlan(null)
      setValidationError({
        code: result.code,
        message: result.message,
      })
      return
    }

    setValidationError(null)
    setValidatedPlan(result.plan)
    onPlanValidated?.(result.plan)
  }

  return (
    <section aria-labelledby={headingId} className="flex w-full min-w-0 flex-col gap-4">
      <TerminalDeployCommand />
      <Card className="min-w-0 overflow-hidden">
        <CardBody className="flex min-w-0 flex-col gap-4 p-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="shrink-0 pt-1 text-c-ink">
                <ModuleGlyph name="console" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <h2 id={headingId} className="text-lg font-semibold break-words text-c-ink">
                  {copy.heading}
                </h2>
                <p className="text-sm font-regular break-words text-c-ink-2">
                  {copy.targetPrefix}{' '}
                  <span className="font-mono font-medium text-c-ink">deploy/community</span> •{' '}
                  {copy.endpointLabel}{' '}
                  <span className="font-mono text-xs break-all text-c-ink">
                    {PROVIDER_API_ORIGINS[provider]}
                  </span>
                </p>
              </div>
            </div>
            <StatusPill state="info">{copy.statusBadge}</StatusPill>
          </div>

          <div
            role="note"
            aria-label={copy.privacyNoteAria}
            className="flex min-w-0 flex-col gap-1 rounded-md border border-c-border bg-c-sunken p-3"
          >
            <span className="text-xs font-semibold break-words text-c-ink">
              {copy.privacyTitle}
            </span>
            <p className="text-xs font-regular break-words text-c-ink-2">
              {copy.privacyLead}{' '}
              <span className="font-mono text-c-ink">deploy/community</span> {copy.privacyMid}{' '}
              <span className="font-mono text-c-ink">kodera.io</span> {copy.privacyTail} (
              <span className="font-mono text-c-ink">{REDACTED_TOKEN_PREVIEW}</span>).
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-semibold text-c-ink-2">{copy.providerHeading}</span>
            <div
              role="group"
              aria-label={copy.providerGroupAria}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {SELF_HOST_PROVIDERS.map((item) => {
                const isSelected = item.id === provider
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleSelectProvider(item.id)}
                    className={
                      isSelected
                        ? 'flex min-w-0 flex-col items-start gap-1 rounded-md border border-c-accent-ink bg-c-accent-soft p-3 text-left focus-visible:ring focus-visible:outline-hidden'
                        : 'flex min-w-0 flex-col items-start gap-1 rounded-md border border-c-border-soft bg-c-surface p-3 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
                    }
                  >
                    <span
                      className={
                        isSelected
                          ? 'text-sm font-semibold text-c-accent-ink'
                          : 'text-sm font-semibold text-c-ink'
                      }
                    >
                      {item.label}
                    </span>
                    <span className="w-full truncate font-mono text-xs text-c-ink-3">
                      {item.apiOrigin}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label
                htmlFor={regionInputId}
                className="text-xs font-medium break-words text-c-ink-2"
              >
                {copy.regionLabel(selectedProviderMeta.regionExamples.join(', '))}
              </label>
              <input
                id={regionInputId}
                type="text"
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                placeholder={selectedProviderMeta.defaultRegion}
                className="h-8 w-full min-w-0 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={fqdnInputId} className="text-xs font-medium break-words text-c-ink-2">
                {copy.fqdnLabel}
              </label>
              <input
                id={fqdnInputId}
                type="text"
                value={fqdn}
                onChange={(event) => setFqdn(event.target.value)}
                placeholder={copy.fqdnPlaceholder}
                className="h-8 w-full min-w-0 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-1">
              <label
                htmlFor={emailInputId}
                className="text-xs font-medium break-words text-c-ink-2"
              >
                {copy.emailLabel}
              </label>
              <input
                id={emailInputId}
                type="email"
                value={acmeEmail}
                onChange={(event) => setAcmeEmail(event.target.value)}
                placeholder={copy.emailPlaceholder}
                className="h-8 w-full min-w-0 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex min-w-0 flex-col gap-1">
              <label
                htmlFor={tokenInputId}
                className="text-xs font-medium break-words text-c-ink-2"
              >
                {copy.tokenLabel}
              </label>
              <input
                ref={tokenInputRef}
                id={tokenInputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={copy.tokenPlaceholder}
                className="h-8 w-full min-w-0 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-xs font-regular break-words text-c-ink-3">
              {copy.helperNote}
            </span>
            <Button
              size="sm"
              variant="primary"
              className="h-auto min-h-8 max-w-full py-2"
              onClick={handleValidate}
            >
              <span className="whitespace-normal">{copy.validateAction}</span>
            </Button>
          </div>

          {validationError !== null ? (
            <div
              role="alert"
              data-testid="selfhost-validation-error"
              className="flex min-w-0 flex-col gap-1 rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium break-words text-c-bad-ink"
            >
              <span>{copy.validationRefused(validationError.code, validationError.message)}</span>
            </div>
          ) : null}

          {validatedPlan !== null ? (
            <div
              role="region"
              aria-label={copy.planRegionAria}
              className="flex min-w-0 flex-col gap-4 border-t border-c-border-soft pt-3"
            >
              <div
                role="status"
                aria-live="polite"
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-c-ok-border bg-c-ok-soft px-3 py-2 text-xs font-medium break-words text-c-ok-ink"
              >
                <span>
                  {copy.planValidatedFor(
                    validatedPlan.fqdn,
                    validatedPlan.provider,
                    validatedPlan.region
                  )}
                </span>
                <span className="font-mono text-xs text-c-ok-ink">
                  {copy.tokenBadge(validatedPlan.redactedTokenPreview)}
                </span>
              </div>

              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs font-semibold text-c-ink-2">
                  {copy.dnsMatrixHeading(validatedPlan.dnsRecords.length)}
                </span>
                <div className="flex min-w-0 flex-col gap-1 rounded-md border border-c-border bg-c-sunken p-3">
                  {validatedPlan.dnsRecords.map((record) => (
                    <div
                      key={`${record.type}-${record.name}`}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-c-border-soft py-1 font-mono text-xs text-c-ink"
                    >
                      <span className="font-semibold text-c-ink">{record.type}</span>
                      <span className="min-w-0 break-all text-c-ink">{record.name}</span>
                      <span className="min-w-0 break-all text-c-ink-3">
                        {record.target} (TTL {record.ttl}s)
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs font-semibold text-c-ink-2">{copy.envHeading}</span>
                <dl
                  aria-label={copy.envAria}
                  className="grid min-w-0 grid-cols-1 gap-2 rounded-md border border-c-border bg-c-sunken p-3 font-mono text-xs"
                >
                  {Object.entries(validatedPlan.composeEnvPreview).map(([key, value]) => (
                    <div
                      key={key}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                    >
                      <dt className="min-w-0 font-semibold break-all text-c-ink-2">{key}</dt>
                      <dd className="min-w-0 break-all text-c-ink">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </section>
  )
}
