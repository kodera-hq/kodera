import { useTranslation } from 'react-i18next'
import { useId, useMemo, useState } from 'react'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { ModuleGlyph } from '@/ui/icons/ModuleGlyph'
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

export function ExtensionsCatalogPanel({
  extensions = OFFICIAL_EXTENSIONS_CATALOG,
  defaultSelectedId = 'io.kodera.ext.hello-webhook',
  defaultCategory = 'all',
  defaultWebhookUrl = '',
  onSelectExtension,
  onWebhookValidated,
}: ExtensionsCatalogPanelProps) {
  const { t } = useTranslation()
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
                  Catalogue d&apos;extensions Kodera v1
                </h2>
                <p className="text-sm font-regular text-c-ink-2">
                  Schéma de manifeste :{' '}
                  <span className="font-mono font-medium text-c-ink">
                    {EXTENSION_SCHEMA_VERSION}
                  </span>{' '}
                  • Moindre privilège et signature HMAC-SHA256
                </p>
              </div>
            </div>
            <StatusPill state="success">{extensions.length} extensions officielles</StatusPill>
          </div>

          <div
            role="group"
            aria-label="Filtrer par catégorie d'extension"
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
                  {filter.label}
                </button>
              )
            })}
          </div>

          <ul
            aria-label="Extensions officielles Kodera"
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
          >
            {filteredExtensions.map((ext) => {
              const isSelected = ext.id === selectedExtension.id
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
                      <span
                        className={
                          isSelected
                            ? 'text-sm font-semibold text-c-accent-ink'
                            : 'text-sm font-semibold text-c-ink'
                        }
                      >
                        {ext.name}
                      </span>
                      <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs font-semibold text-c-ink">
                        {ext.slashCommand}
                      </span>
                    </div>

                    <span className="font-mono text-xs text-c-ink-3">{ext.id}</span>

                    <p className="text-xs font-regular text-c-ink-2">
                      {ext.slug === 'frameio-review-bridge'
                        ? t('console.onboarding.studio.frameio')
                        : ext.description}
                    </p>

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
            aria-label="Inspecteur de commande slash et de webhook"
            className="flex flex-col gap-3 rounded-md border border-c-border bg-c-sunken p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-md font-semibold text-c-ink">
                  {selectedExtension.name} ({selectedExtension.slashCommand})
                </span>
                <span className="font-mono text-xs text-c-ink-3">
                  {selectedExtension.id} • v{selectedExtension.version}
                </span>
              </div>
              <StatusPill state="info">{selectedExtension.slashCommand}</StatusPill>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-c-ink-2">
                Commandes slash enregistrées
              </span>
              {selectedExtension.commands.map((cmd) => (
                <div
                  key={cmd.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-c-border-soft bg-c-surface px-3 py-2 text-xs"
                >
                  <span className="font-mono font-semibold text-c-ink">{cmd.usage}</span>
                  <span className="text-c-ink-2">{cmd.description}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
              <div className="flex flex-col gap-1">
                <label htmlFor={webhookInputId} className="text-xs font-medium text-c-ink-2">
                  URL de destination du webhook (HTTPS public uniquement, protection anti-SSRF)
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id={webhookInputId}
                    type="url"
                    value={webhookUrlInput}
                    onChange={(event) => setWebhookUrlInput(event.target.value)}
                    placeholder={selectedExtension.defaultWebhookExample}
                    className="h-8 flex-1 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
                  />
                  <Button size="sm" variant="primary" onClick={handleValidateWebhook}>
                    Vérifier l&apos;URL du webhook
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
                    URL refusée ({validationResult.code}) : {validationResult.message}
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
                  <span>Point de terminaison HTTPS autorisé :</span>
                  <span className="font-mono text-c-ok-ink">{validationResult.normalizedUrl}</span>
                </div>
              ) : null}
            </div>
          </div>
        </CardBody>
      </Card>
    </section>
  )
}
