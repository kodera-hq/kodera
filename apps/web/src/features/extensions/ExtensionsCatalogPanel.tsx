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
  readonly channels?: readonly { id: string; label: string }[] | undefined
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
    targetChannel: 'Salon de destination',
    chooseChannel: 'Choisir un salon',
    channelHint: 'Ce choix prépare la configuration. Aucune connexion n’est encore activée.',
    noChannels: 'Ouvrez un espace avec un salon accessible pour choisir la destination.',
    heading: "Catalogue d'extensions Kodera v1",
    schemaLabel: 'Schéma de manifeste :',
    schemaSuffix: '• Moindre privilège et signature HMAC-SHA256',
    filterGroupLabel: "Filtrer par catégorie d'extension",
    searchLabel: 'Rechercher un connecteur',
    searchEmpty: 'Aucun connecteur ne correspond à cette recherche ni à ce filtre.',
    connect: 'Connecter',
    connected: 'Configuration ouverte',
    setupHeading: 'Configurer',
    setupStep1: '1. Ouvrez le service et créez-y un webhook sortant.',
    setupStep2: '2. Collez ci-dessous l’URL de destination et vérifiez-la.',
    setupStep3: '3. Signez vos appels avec le secret partagé (HMAC-SHA256).',
    technical: 'Détails techniques & sécurité',
    nothingChosen: 'Choisissez un connecteur pour voir sa configuration.',
    verifiedBadge: 'Schéma v1 vérifié',
    inspectorRegionLabel: 'Inspecteur de commande slash et de webhook',
    registeredCommands: 'Commandes slash enregistrées',
    webhookLabel: 'URL de destination du webhook (HTTPS public uniquement, protection anti-SSRF)',
    verifyWebhookButton: "Vérifier l'URL du webhook",
    rejectedUrl: 'URL refusée',
    allowedEndpoint: 'Point de terminaison HTTPS autorisé :',
  },
  en: {
    targetChannel: 'Destination channel',
    chooseChannel: 'Choose a channel',
    channelHint: 'This choice prepares setup. No connection has been activated yet.',
    noChannels: 'Open a workspace with an available channel to choose a destination.',
    heading: 'Kodera v1 extension catalogue',
    schemaLabel: 'Manifest schema:',
    schemaSuffix: '• Least privilege and HMAC-SHA256 signing',
    filterGroupLabel: 'Filter by extension category',
    searchLabel: 'Search for a connector',
    searchEmpty: 'No connector matches this search or this filter.',
    connect: 'Connect',
    connected: 'Setup open',
    setupHeading: 'Set up',
    setupStep1: '1. Open the service and create an outgoing webhook there.',
    setupStep2: '2. Paste its destination URL below and verify it.',
    setupStep3: '3. Sign your calls with the shared secret (HMAC-SHA256).',
    technical: 'Technical details & security',
    nothingChosen: 'Choose a connector to see how to set it up.',
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
  channels = [],
  extensions = OFFICIAL_EXTENSIONS_CATALOG,
  // No connector is chosen on arrival. A card drawn as chosen that nobody chose reads as a stray
  // selection box, and it opened a setup panel for a service the member had not asked about.
  defaultSelectedId,
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
  const searchInputId = useId()
  const channelInputId = useId()
  const [channelId, setChannelId] = useState('')

  const [selectedCategory, setSelectedCategory] = useState<ExtensionCategoryFilter>(defaultCategory)
  const [selectedId, setSelectedId] = useState<OfficialExtensionId | null>(
    defaultSelectedId ?? null
  )
  const [term, setTerm] = useState('')
  const [webhookUrlInput, setWebhookUrlInput] = useState<string>(defaultWebhookUrl)
  const [validationResult, setValidationResult] = useState<ExtensionWebhookValidationResult | null>(
    null
  )

  const filteredExtensions = useMemo<readonly OfficialExtensionDescriptor[]>(() => {
    const needle = term.trim().toLocaleLowerCase()
    return extensions.filter(
      (ext) =>
        (selectedCategory === 'all' || ext.category === selectedCategory) &&
        (needle === '' ||
          `${ext.name} ${ext.nameEn} ${ext.description} ${ext.descriptionEn} ${ext.slashCommand}`
            .toLocaleLowerCase()
            .includes(needle))
    )
  }, [extensions, selectedCategory, term])

  /** The connector whose setup is open, or `undefined` while none has been chosen. */
  const selectedExtension = useMemo<OfficialExtensionDescriptor | undefined>(
    () => (selectedId === null ? undefined : extensions.find((ext) => ext.id === selectedId)),
    [extensions, selectedId]
  )

  // Filtering narrows the list; it does not choose for the member. Choosing the first row of a
  // new filter opened a setup panel nobody asked for, and the row it chose was not always in the
  // filter the member had just picked.
  const handleSelectCategory = (category: ExtensionCategoryFilter) => {
    setSelectedCategory(category)
  }

  const handleSelect = (extension: OfficialExtensionDescriptor) => {
    setSelectedId(extension.id)
    setValidationResult(null)
    onSelectExtension?.(extension)
  }

  const handleValidateWebhook = () => {
    if (selectedExtension === undefined) return
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

          <div className="flex flex-col gap-1">
            <label htmlFor={searchInputId} className="text-xs font-medium text-c-ink-2">
              {copy.searchLabel}
            </label>
            <input
              id={searchInputId}
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
            />
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
              const isSelected = ext.id === selectedExtension?.id
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
                    aria-label={`${displayName} — ${copy.connect}`}
                    onClick={() => handleSelect(ext)}
                    className={
                      isSelected
                        ? 'flex w-full flex-col items-start gap-2 rounded-md border border-c-accent-ink bg-c-accent-soft p-3 text-left focus-visible:ring focus-visible:outline-hidden'
                        : 'flex w-full flex-col items-start gap-2 rounded-md border border-c-border-soft bg-c-surface p-3 text-left hover:bg-c-muted focus-visible:ring focus-visible:outline-hidden'
                    }
                  >
                    <span className="flex w-full flex-wrap items-center justify-between gap-2">
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
                    </span>

                    {/* What it does, before what it is made of: the manifest id and the scopes it
                        asks for are in « Détails techniques & sécurité » below. */}
                    <p className="text-sm font-regular text-c-ink-2">{displayDescription}</p>

                    <span className="flex w-full flex-wrap items-center justify-between gap-2">
                      <span
                        className={
                          isSelected
                            ? 'text-xs font-semibold text-c-accent-ink'
                            : 'text-xs font-semibold text-c-ink-2'
                        }
                      >
                        {isSelected ? copy.connected : copy.connect}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {filteredExtensions.length === 0 ? (
            <p role="status" className="text-sm text-c-ink-3">
              {copy.searchEmpty}
            </p>
          ) : null}

          {/* The setup of the connector the member chose, and nothing before they choose one. */}
          {selectedExtension === undefined ? (
            <p className="rounded-md border border-c-border-soft bg-c-sunken p-4 text-sm text-c-ink-2">
              {copy.nothingChosen}
            </p>
          ) : (
            <div
              role="region"
              aria-label={copy.inspectorRegionLabel}
              className="flex flex-col gap-3 rounded-md border border-c-border bg-c-sunken p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <BrandIcon name={EXTENSION_BRANDS[selectedExtension.id]} decorative />
                <div className="flex flex-col gap-1">
                  <span className="text-md font-semibold text-c-ink">
                    {copy.setupHeading} {isEn ? selectedExtension.nameEn : selectedExtension.name}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill state="info">{selectedExtension.slashCommand}</StatusPill>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor={channelInputId} className="text-sm font-medium text-c-ink">
                  {copy.targetChannel}
                </label>
                <select
                  id={channelInputId}
                  value={channels.some((channel) => channel.id === channelId) ? channelId : ''}
                  onChange={(event) => setChannelId(event.target.value)}
                  disabled={channels.length === 0}
                  className="min-h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink focus-visible:ring focus-visible:outline-hidden"
                >
                  <option value="">{copy.chooseChannel}</option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      #{channel.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-c-ink-3">
                  {channels.length === 0 ? copy.noChannels : copy.channelHint}
                </p>
              </div>
              {/* The manifest, the scopes and the signature: what a developer needs and what an
                administrator reads once. Out of the way of setting a connector up, not hidden —
                a `details` keeps every word in the page and findable. */}
              <details className="border-t border-c-border-soft pt-3">
                <summary className="cursor-pointer text-sm font-medium text-c-ink-2 focus-visible:ring focus-visible:outline-hidden">
                  {copy.technical}
                </summary>
                {/* The three steps, in the order the member carries them out. */}
                <ol className="flex flex-col gap-1 text-sm text-c-ink-2">
                  <li>{copy.setupStep1}</li>
                  <li>{copy.setupStep2}</li>
                  <li>{copy.setupStep3}</li>
                </ol>

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
                      <span className="font-mono text-c-ok-ink">
                        {validationResult.normalizedUrl}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col gap-3 pt-3">
                  {selectedExtension.verifiedManifest ? (
                    <StatusPill state="success">
                      <span data-testid={`extension-verified-${selectedExtension.slug}`}>
                        {copy.verifiedBadge}
                      </span>
                    </StatusPill>
                  ) : null}
                  <p className="text-sm font-regular text-c-ink-2">
                    {copy.schemaLabel}{' '}
                    <span className="font-mono font-medium text-c-ink">
                      {EXTENSION_SCHEMA_VERSION}
                    </span>{' '}
                    {copy.schemaSuffix}
                  </p>
                  <span className="font-mono text-xs text-c-ink-3">
                    {selectedExtension.id} • v{selectedExtension.version}
                  </span>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-c-ink-2">
                      {copy.registeredCommands}
                    </span>
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
                  <div className="flex flex-wrap items-center gap-1">
                    {selectedExtension.scopes.map((scope) => (
                      <span
                        key={`${selectedExtension.id}-${scope}`}
                        className="rounded-sm border border-c-border-soft bg-c-surface px-2 py-1 font-mono text-xs text-c-ink-2"
                      >
                        {scope}
                      </span>
                    ))}
                  </div>
                  <WebhookSignatureTester
                    key={selectedExtension.id}
                    extensionId={selectedExtension.id}
                  />
                </div>
              </details>
            </div>
          )}
        </CardBody>
      </Card>
    </section>
  )
}
