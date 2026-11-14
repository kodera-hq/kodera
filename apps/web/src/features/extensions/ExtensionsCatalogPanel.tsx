import { useTranslation } from 'react-i18next'
import { useId, useMemo, useState } from 'react'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { BrandIcon } from '@/ui/icons/BrandIcon'
import { EXTENSION_BRANDS } from './extensionBrand'
import { ModuleGlyph } from '@/ui/icons/ModuleGlyph'
import { WebhookSignatureTester } from './WebhookSignatureTester'
import {
  EXTENSION_CATEGORY_FILTERS,
  EXTENSION_SCHEMA_VERSION,
  OFFICIAL_EXTENSIONS_CATALOG,
  type ExtensionCategoryFilter,
  type ExtensionWebhookValidationResult,
  type OfficialExtensionDescriptor,
  type OfficialExtensionId,
  validateExtensionWebhookUrl,
} from './catalog'

export interface ExtensionsCatalogPanelProps {
  readonly extensions?: readonly OfficialExtensionDescriptor[] | undefined
  readonly defaultSelectedId?: OfficialExtensionId | undefined
  readonly defaultCategory?: ExtensionCategoryFilter | undefined
  readonly defaultWebhookUrl?: string | undefined
  readonly onSelectExtension?: ((extension: OfficialExtensionDescriptor) => void) | undefined
  readonly onWebhookValidated?:
    ((extensionId: OfficialExtensionId, normalizedUrl: string) => void) | undefined
}

const PANEL_COPY = {
  fr: {
    heading: "Catalogue d'extensions Kodera v1",
    schemaLabel: 'Schéma de manifeste :',
    schemaSuffix: '• Moindre privilège et signature HMAC-SHA256',
    filterGroupLabel: "Filtrer par catégorie d'extension",
    verifiedBadge: 'Schéma v1 vérifié',
    inspectorRegionLabel: 'Inspecteur de commande slash et de webhook',
    registeredCommands: 'Commandes slash enregistrées',
    webhookLabel:
      'URL de destination du webhook (HTTPS public uniquement, protection anti-SSRF)',
    verifyWebhookButton: "Vérifier l'URL du webhook",
    rejectedUrl: 'URL refusée',
    allowedEndpoint: 'Point de terminaison HTTPS autorisé :',
  },
  en: {
    heading: 'Kodera v1 extension catalogue',
    schemaLabel: 'Manifest schema:',
    schemaSuffix: '• Least privilege and HMAC-SHA256 signing',
    filterGroupLabel: 'Filter by extension category',
    verifiedBadge: 'Verified v1 schema',
    inspectorRegionLabel: 'Slash command and webhook inspector',
    registeredCommands: 'Registered slash commands',
    webhookLabel: 'Webhook destination URL (public HTTPS only, anti-SSRF guard)',
    verifyWebhookButton: 'Verify webhook URL',
    rejectedUrl: 'URL rejected',
    allowedEndpoint: 'Allowed HTTPS endpoint:',
  },
} as const

export function ExtensionsCatalogPanel({
  extensions = OFFICIAL_EXTENSIONS_CATALOG,
  defaultSelectedId = 'io.kodera.ext.hello-webhook',
  defaultCategory = 'all',
  defaultWebhookUrl = '',
  onSelectExtension,
  onWebhookValidated,
}: ExtensionsCatalogPanelProps) {
  const { t, i18n } = useTranslation()
  const isEn = Boolean(i18n.resolvedLanguage?.startsWith('en'))
  const copy = isEn ? PANEL_COPY.en : PANEL_COPY.fr
  const headingId = useId()
  const webhookInputId = useId()

  const [selectedCategory, setSelectedCategory] = useState<ExtensionCategoryFilter>(defaultCategory)
  const [selectedId, setSelectedId] = useState<OfficialExtensionId>(defaultSelectedId)
  const [webhookUrlInput, setWebhookUrlInput] = useState<string>(defaultWebhookUrl)
  const [validationResult, setValidationResult] = useState<ExtensionWebhookValidationResult | null>(
    null
  )

  const filteredExtensions = useMemo<readonly OfficialExtensionDescriptor[]>(
    () =>
      selectedCategory === 'all'
        ? extensions
        : extensions.filter((ext) => ext.category === selectedCategory),
    [extensions, selectedCategory]
  )

  const selectedExtension = useMemo<OfficialExtensionDescriptor>(
    () =>
      filteredExtensions.find((ext) => ext.id === selectedId) ??
      filteredExtensions[0] ??
      extensions.find((ext) => ext.id === selectedId) ??
      extensions[0] ??
      OFFICIAL_EXTENSIONS_CATALOG[0]!,
    [extensions, filteredExtensions, selectedId]
  )

  const handleSelectCategory = (category: ExtensionCategoryFilter) => {
    setSelectedCategory(category)
    const matching =
      category === 'all' ? extensions : extensions.filter((ext) => ext.category === category)
    if (matching.length > 0 && !matching.some((ext) => ext.id === selectedId)) {
      const nextSelected = matching[0]!
      setSelectedId(nextSelected.id)
      setValidationResult(null)
      onSelectExtension?.(nextSelected)
    }
  }

  const handleSelect = (extension: OfficialExtensionDescriptor) => {
    setSelectedId(extension.id)
    setValidationResult(null)
    onSelectExtension?.(extension)
  }

  const handleValidateWebhook = () => {
    const res = validateExtensionWebhookUrl(webhookUrlInput)
    setValidationResult(res)
    if (res.ok) {
      onWebhookValidated?.(selectedExtension.id, res.normalizedUrl)
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="shrink-0 text-c-ink">
                <ModuleGlyph name="workspace" />
              </span>
              <div className="flex flex-col gap-1">
                <h2 id={headingId} className="text-lg font-semibold text-c-ink">
                  {copy.heading}
                </h2>
                <p className="text-sm font-regular text-c-ink-2">
                  {copy.schemaLabel}{' '}
                  <span className="font-mono font-medium text-c-ink">
                    {EXTENSION_SCHEMA_VERSION}
                  </span>{' '}
                  {copy.schemaSuffix}
                </p>
                {/* What the list is, said where it is drawn: starters to adapt, connected to no
                    account. Not an endorsement by the services they name. */}
                <p className="text-sm font-regular text-c-ink-2">
                  {t('console.onboarding.extensions.reference-note')}
                </p>
              </div>
            </div>
            <StatusPill state="neutral">
              {t('console.onboarding.extensions.count-reference', { count: extensions.length })}
            </StatusPill>
          </div>

          <div
            role="group"
            aria-label={copy.filterGroupLabel}
            className="flex flex-wrap items-center gap-2"
          >
            {EXTENSION_CATEGORY_FILTERS.map((filter) => {
              const isActive = selectedCategory === filter.id
              return (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={isActive}
                  data-testid={`extension-category-${filter.id}`}
                  onClick={() => handleSelectCategory(filter.id)}
                  className={
                    isActive
                      ? 'rounded-full border border-c-accent-ink bg-c-accent-soft px-3 py-1 text-xs font-semibold text-c-accent-ink focus-visible:ring focus-visible:outline-hidden'
                      : 'rounded-full border border-c-border-soft bg-c-surface px-3 py-1 text-xs font-medium text-c-ink-2 hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
                  }
                >
                  {isEn ? filter.labelEn : filter.label}
                </button>
              )
            })}
          </div>

          <ul
            aria-label={t('console.onboarding.extensions.list-label')}
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            {filteredExtensions.map((ext) => {
              const isSelected = ext.id === selectedExtension.id
              const displayName = isEn ? ext.nameEn : ext.name
              const displayDescription =
                ext.slug === 'frameio-review-bridge'
                  ? t('console.onboarding.studio.frameio')
                  : isEn
                    ? ext.descriptionEn
                    : ext.description
              return (
                <li key={ext.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => handleSelect(ext)}
                    className={
                      isSelected
                        ? 'flex w-full flex-col items-start gap-2 rounded-md border border-c-accent-ink bg-c-accent-soft p-3 text-left focus-visible:ring focus-visible:outline-hidden'
                        : 'flex w-full flex-col items-start gap-2 rounded-md border border-c-border-soft bg-c-surface p-3 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
                    }
                  >
                    <div className="flex w-full flex-wrap items-center justify-between gap-2">
                      <BrandIcon name={EXTENSION_BRANDS[ext.id]} decorative />
                      <span
                        className={
                          isSelected
                            ? 'text-sm font-semibold text-c-accent-ink'
                            : 'text-sm font-semibold text-c-ink'
                        }
                      >
                        {displayName}
                      </span>
                      <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-semibold text-c-ink">
                        {ext.slashCommand}
                      </span>
                    </div>

                    <div className="flex w-full flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs text-c-ink-3">{ext.id}</span>
                      {ext.verifiedManifest ? (
                        <span
                          data-testid={`extension-verified-${ext.slug}`}
                          className="rounded-full border border-c-ok-border bg-c-ok-soft px-2 py-1 text-xs font-medium text-c-ok-ink"
                        >
                          {copy.verifiedBadge}
                        </span>
                      ) : null}
                    </div>

                    <p className="text-xs font-regular text-c-ink-2">{displayDescription}</p>

                    <div className="flex flex-wrap items-center gap-1">
                      {ext.scopes.map((scope) => (
                        <span
                          key={`${ext.id}-${scope}`}
                          className="rounded-sm border border-c-border-soft bg-c-surface px-2 py-1 font-mono text-xs text-c-ink-2"
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>

          <div
            role="region"
            aria-label={copy.inspectorRegionLabel}
            className="flex flex-col gap-3 rounded-md border border-c-border bg-c-sunken p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <BrandIcon name={EXTENSION_BRANDS[selectedExtension.id]} decorative />
              <div className="flex flex-col gap-1">
                <span className="text-md font-semibold text-c-ink">
                  {isEn ? selectedExtension.nameEn : selectedExtension.name} (
                  {selectedExtension.slashCommand})
                </span>
                <span className="font-mono text-xs text-c-ink-3">
                  {selectedExtension.id} • v{selectedExtension.version}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedExtension.verifiedManifest ? (
                  <StatusPill state="success">{copy.verifiedBadge}</StatusPill>
                ) : null}
                <StatusPill state="info">{selectedExtension.slashCommand}</StatusPill>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-c-ink-2">{copy.registeredCommands}</span>
              {selectedExtension.commands.map((cmd) => (
                <div
                  key={cmd.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs"
                >
                  <span className="font-mono font-semibold text-c-ink">{cmd.usage}</span>
                  <span className="text-c-ink-2">
                    {isEn ? cmd.descriptionEn : cmd.description}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
              <div className="flex flex-col gap-1">
                <label htmlFor={webhookInputId} className="text-xs font-medium text-c-ink-2">
                  {copy.webhookLabel}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id={webhookInputId}
                    type="url"
                    value={webhookUrlInput}
                    onChange={(event) => {
                      setWebhookUrlInput(event.target.value)
                      setValidationResult(null)
                    }}
                    placeholder={selectedExtension.defaultWebhookExample}
                    className="h-8 flex-1 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                  />
                  <Button size="sm" variant="primary" onClick={handleValidateWebhook}>
                    {copy.verifyWebhookButton}
                  </Button>
                </div>
              </div>

              {validationResult !== null && !validationResult.ok ? (
                <div
                  role="alert"
                  data-testid="extension-webhook-error"
                  className="flex flex-col gap-1 rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
                >
                  <span>
                    {copy.rejectedUrl} ({validationResult.code}) : {validationResult.message}
                  </span>
                </div>
              ) : null}

              {validationResult !== null && validationResult.ok ? (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="extension-webhook-valid"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-ok-border bg-c-ok-soft px-3 py-2 text-xs font-medium text-c-ok-ink"
                >
                  <span>{copy.allowedEndpoint}</span>
                  <span className="font-mono text-c-ok-ink">{validationResult.normalizedUrl}</span>
                </div>
              ) : null}
            </div>
            <WebhookSignatureTester key={selectedExtension.id} extensionId={selectedExtension.id} />
          </div>
        </CardBody>
      </Card>
    </section>
  )
}
