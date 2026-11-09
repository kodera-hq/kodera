import { TerminalDeployCommand } from './TerminalDeployCommand'
import { useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { ModuleGlyph } from '@/ui/icons/ModuleGlyph'
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

export function SelfHostDeployerPanel({
  defaultProvider = 'scaleway',
  defaultRegion = 'fr-par-1',
  defaultFqdn = 'chat.acme-corp.eu',
  defaultAcmeEmail = 'ops@acme-corp.eu',
  onPlanValidated,
}: SelfHostDeployerPanelProps) {
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
    const result = safeValidateSelfHostSpec({
      provider,
      region,
      fqdn,
      acmeEmail,
      rawToken,
    })

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
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <TerminalDeployCommand />
      <Card>
        <CardBody className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="shrink-0 text-c-ink">
                <ModuleGlyph name="console" />
              </span>
              <div className="flex flex-col gap-1">
                <h2 id={headingId} className="text-lg font-semibold text-c-ink">
                  Assistant d&apos;auto-hébergement 1-clic (Aperçu de validation locale)
                </h2>
                <p className="text-sm font-regular text-c-ink-2">
                  Cible <span className="font-mono font-medium text-c-ink">deploy/community</span> •
                  Point de terminaison API :{' '}
                  <span className="font-mono text-xs text-c-ink">
                    {PROVIDER_API_ORIGINS[provider]}
                  </span>
                </p>
              </div>
            </div>
            <StatusPill state="info">Validation locale uniquement</StatusPill>
          </div>

          <div
            role="note"
            aria-label="Divulgation de confidentialité et de non-transmission du jeton"
            className="flex flex-col gap-1 rounded-md border border-c-border bg-c-sunken p-3"
          >
            <span className="text-xs font-semibold text-c-ink">
              Aucun appel réseau ni stockage du jeton API dans le navigateur
            </span>
            <p className="text-xs font-regular text-c-ink-2">
              Cet écran valide localement vos paramètres et génère la matrice DNS ainsi que
              l&apos;aperçu <span className="font-mono text-c-ink">deploy/community</span> sans
              transmettre votre jeton API à <span className="font-mono text-c-ink">kodera.io</span>{' '}
              ni provisionner de serveur distant depuis le navigateur. Le jeton reste masqué (
              <span className="font-mono text-c-ink">{REDACTED_TOKEN_PREVIEW}</span>).
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-c-ink-2">
              Fournisseur d&apos;infrastructure VPS
            </span>
            <div role="group" aria-label="Fournisseur cloud" className="grid grid-cols-2 gap-2">
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

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={regionInputId} className="text-xs font-medium text-c-ink-2">
                Région du fournisseur ({selectedProviderMeta.regionExamples.join(', ')})
              </label>
              <input
                id={regionInputId}
                type="text"
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                placeholder={selectedProviderMeta.defaultRegion}
                className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={fqdnInputId} className="text-xs font-medium text-c-ink-2">
                Domaine public (FQDN)
              </label>
              <input
                id={fqdnInputId}
                type="text"
                value={fqdn}
                onChange={(event) => setFqdn(event.target.value)}
                placeholder="chat.organisation.fr"
                className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={emailInputId} className="text-xs font-medium text-c-ink-2">
                E-mail administrateur ACME (TLS Let&apos;s Encrypt)
              </label>
              <input
                id={emailInputId}
                type="email"
                value={acmeEmail}
                onChange={(event) => setAcmeEmail(event.target.value)}
                placeholder="ops@organisation.fr"
                className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={tokenInputId} className="text-xs font-medium text-c-ink-2">
                Jeton API fournisseur éphémère (16 à 512 caractères ASCII)
              </label>
              <input
                ref={tokenInputRef}
                id={tokenInputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Saisi en mémoire locale uniquement"
                className="h-8 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-regular text-c-ink-3">
              Vérifie le domaine public, l&apos;adresse ACME, la région et le format du jeton sans
              exposer le secret.
            </span>
            <Button size="sm" variant="primary" onClick={handleValidate}>
              Valider la configuration localement
            </Button>
          </div>

          {validationError !== null ? (
            <div
              role="alert"
              data-testid="selfhost-validation-error"
              className="flex flex-col gap-1 rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
            >
              <span>
                Validation refusée ({validationError.code}) : {validationError.message}
              </span>
            </div>
          ) : null}

          {validatedPlan !== null ? (
            <div
              role="region"
              aria-label="Plan de déploiement validé"
              className="flex flex-col gap-4 border-t border-c-border-soft pt-3"
            >
              <div
                role="status"
                aria-live="polite"
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-ok-border bg-c-ok-soft px-3 py-2 text-xs font-medium text-c-ok-ink"
              >
                <span>
                  Configuration validée pour {validatedPlan.fqdn} ({validatedPlan.provider} •{' '}
                  {validatedPlan.region})
                </span>
                <span className="font-mono text-xs text-c-ok-ink">
                  Jeton : {validatedPlan.redactedTokenPreview}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-c-ink-2">
                  Matrice d&apos;enregistrements DNS requis ({validatedPlan.dnsRecords.length})
                </span>
                <div className="flex flex-col gap-1 rounded-md border border-c-border bg-c-sunken p-3">
                  {validatedPlan.dnsRecords.map((record) => (
                    <div
                      key={`${record.type}-${record.name}`}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-c-border-soft py-1 font-mono text-xs text-c-ink"
                    >
                      <span className="font-semibold text-c-ink">{record.type}</span>
                      <span className="text-c-ink">{record.name}</span>
                      <span className="text-c-ink-3">
                        {record.target} (TTL {record.ttl}s)
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs font-semibold text-c-ink-2">
                  Aperçu des variables publiques deploy/community
                </span>
                <dl
                  aria-label="Variables deploy/community"
                  className="grid grid-cols-1 gap-2 rounded-md border border-c-border bg-c-sunken p-3 font-mono text-xs"
                >
                  {Object.entries(validatedPlan.composeEnvPreview).map(([key, value]) => (
                    <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="font-semibold text-c-ink-2">{key}</dt>
                      <dd className="text-c-ink">{value}</dd>
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
