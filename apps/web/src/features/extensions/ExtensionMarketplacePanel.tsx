import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/ui/Button/Button'
import { Card, CardBody } from '@/ui/Card/Card'
import { LinkButton } from '@/ui/LinkButton/LinkButton'
import { StatusPill } from '@/ui/StatusPill/StatusPill'
import { SandboxedWidgetCard, type SandboxedWidgetActionInvocation } from './SandboxedWidgetCard'
import type { MigratorChannelOption } from './WorkspaceMigratorPanel'
import {
  defaultExtensionMarketplaceTransport,
  formatEuroMinor,
  MARKETPLACE_WAIVER_STATEMENTS,
  type ExtensionMarketplaceTransport,
  type MarketplaceCheckoutResponse,
  type MarketplaceListingRecord,
} from './marketplaceClient'
import type { WidgetCard } from './widgetSchema'

export interface ExtensionMarketplacePanelProps {
  readonly organisationId?: string | undefined
  readonly channels?: readonly MigratorChannelOption[] | undefined
  readonly transport?: ExtensionMarketplaceTransport | undefined
  readonly initialListings?: readonly MarketplaceListingRecord[] | undefined
  readonly initialBillingEnabled?: boolean | undefined
}

const MARKETPLACE_COPY = {
  fr: {
    heading: "Marketplace d'extensions Web",
    subtitle:
      "Installez des connecteurs gratuits en un clic ou réglez les extensions payantes sur le Web via Stripe Connect.",
    webOnlyBadge: 'Règlement Web uniquement',
    billingDisabledNotice:
      "La facturation payante est désactivée sur cette instance. Les extensions gratuites restent disponibles à l'installation immédiate.",
    emptyState: "Aucune extension publiée dans la marketplace de cet espace pour le moment.",
    loading: 'Chargement des offres de la marketplace…',
    loadError: 'Impossible de charger les offres de la marketplace.',
    actionError: "L'opération sur la marketplace a été refusée.",
    confidentialChannelError:
      'Les actions de widget sont refusées dans les salons confidentiels ou chiffrés de bout en bout.',
    freeBadge: 'Gratuit',
    oneTimeSuffix: 'HT • achat unique',
    installedBadge: 'Installée',
    entitledBadge: 'Droits actifs',
    pendingBadge: 'Paiement en attente',
    secretLabel: 'Secret de signature HMAC (32 caractères ASCII minimum)',
    secretPlaceholder: 'whsec_votre_secret_partage_32_caracteres_min',
    secretTooShort: 'Saisissez un secret ASCII imprimable de 32 caractères minimum.',
    waiverLabel:
      "Je demande l'exécution immédiate du service numérique et renonce à mon droit de rétractation de 14 jours (art. L221-28).",
    installFreeCta: 'Installer gratuitement',
    installEntitledCta: "Finaliser l'installation",
    checkoutCta: 'Acheter sur le Web (Stripe Connect)',
    openCheckoutLink: 'Ouvrir le paiement sécurisé',
    paidUnavailableCta: 'Paiement désactivé',
    widgetChannelLabel: "Salon d'essai pour le widget interactif",
    chooseChannel: 'Choisir un salon non confidentiel',
    widgetPreviewTitle: 'Aperçu du widget bac à sable',
    actionDelivered: 'Action transmise au connecteur.',
    refreshButton: 'Actualiser',
  },
  en: {
    heading: 'Web extension marketplace',
    subtitle:
      'Install free connectors in one step or settle paid extensions on the web through Stripe Connect.',
    webOnlyBadge: 'Web settlement only',
    billingDisabledNotice:
      'Paid billing is disabled on this deployment. Free extensions remain available for immediate installation.',
    emptyState: 'No extension is published in this workspace marketplace yet.',
    loading: 'Loading marketplace listings…',
    loadError: 'Could not load marketplace listings.',
    actionError: 'The marketplace operation was refused.',
    confidentialChannelError:
      'Widget actions are refused in confidential or end-to-end encrypted channels.',
    freeBadge: 'Free',
    oneTimeSuffix: 'excl. VAT • one-time',
    installedBadge: 'Installed',
    entitledBadge: 'Active entitlement',
    pendingBadge: 'Payment pending',
    secretLabel: 'HMAC signing secret (at least 32 printable ASCII characters)',
    secretPlaceholder: 'whsec_your_shared_signing_secret_32_chars_min',
    secretTooShort: 'Enter a printable ASCII secret of at least 32 characters.',
    waiverLabel:
      'I request immediate performance of the digital service and waive my 14-day withdrawal right (Art. L221-28).',
    installFreeCta: 'Install for free',
    installEntitledCta: 'Complete installation',
    checkoutCta: 'Purchase on web (Stripe Connect)',
    openCheckoutLink: 'Open checkout session',
    paidUnavailableCta: 'Billing disabled',
    widgetChannelLabel: 'Target channel for interactive widget actions',
    chooseChannel: 'Choose a non-confidential channel',
    widgetPreviewTitle: 'Sandboxed widget preview',
    actionDelivered: 'Widget action delivered to connector.',
    refreshButton: 'Refresh',
  },
} as const

export function ExtensionMarketplacePanel({
  organisationId,
  channels = [],
  transport = defaultExtensionMarketplaceTransport,
  initialListings,
  initialBillingEnabled = false,
}: ExtensionMarketplacePanelProps) {
  const { i18n } = useTranslation()
  const isEn = Boolean(i18n.resolvedLanguage?.startsWith('en'))
  const locale = isEn ? 'en' : 'fr'
  const copy = isEn ? MARKETPLACE_COPY.en : MARKETPLACE_COPY.fr

  const headingId = useId()
  const secretInputId = useId()
  const channelSelectId = useId()
  const waiverInputId = useId()

  const [listings, setListings] = useState<readonly MarketplaceListingRecord[]>(
    initialListings ?? []
  )
  const [billingEnabled, setBillingEnabled] = useState<boolean>(initialBillingEnabled)
  const [loadedOrgId, setLoadedOrgId] = useState<string | null>(
    initialListings !== undefined ? (organisationId ?? '') : null
  )
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [statusBanner, setStatusBanner] = useState<string | null>(null)
  const [signingSecret, setSigningSecret] = useState<string>('')
  const [waiverAccepted, setWaiverAccepted] = useState<boolean>(false)
  const [busyListingId, setBusyListingId] = useState<string | null>(null)
  const [checkoutByListing, setCheckoutByListing] = useState<
    Readonly<Record<string, MarketplaceCheckoutResponse>>
  >({})
  const [selectedChannelId, setSelectedChannelId] = useState<string>('')
  const [liveCards, setLiveCards] = useState<Readonly<Record<string, WidgetCard>>>({})
  const [pendingWidgetAction, setPendingWidgetAction] = useState<string | null>(null)

  const loading =
    refreshing ||
    (Boolean(organisationId) && initialListings === undefined && loadedOrgId !== organisationId)

  const reloadListings = async () => {
    if (!organisationId) return
    setRefreshing(true)
    setErrorBanner(null)
    try {
      const res = await transport.listListings(organisationId)
      setListings(res.listings)
      setBillingEnabled(res.billingEnabled)
      setLoadedOrgId(organisationId)
    } catch {
      setErrorBanner(copy.loadError)
      setLoadedOrgId(organisationId)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!organisationId || initialListings !== undefined) return
    let cancelled = false
    void transport
      .listListings(organisationId)
      .then((res) => {
        if (cancelled) return
        setListings(res.listings)
        setBillingEnabled(res.billingEnabled)
        setErrorBanner(null)
        setLoadedOrgId(organisationId)
      })
      .catch(() => {
        if (!cancelled) {
          setErrorBanner(copy.loadError)
          setLoadedOrgId(organisationId)
        }
      })
    return () => {
      cancelled = true
    }
  }, [organisationId, initialListings, transport, copy.loadError])

  const handleInstall = async (listing: MarketplaceListingRecord) => {
    if (!organisationId) return
    const trimmed = signingSecret.trim()
    if (trimmed.length < 32 || trimmed.length > 512) {
      setErrorBanner(copy.secretTooShort)
      return
    }
    setBusyListingId(listing.id)
    setErrorBanner(null)
    setStatusBanner(null)
    try {
      const installed = await transport.installListing(organisationId, listing.id, {
        signingSecret: trimmed,
      })
      setListings((prev) =>
        prev.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                entitlementState: 'active',
                entitlementId: installed.entitlementId,
                installed: true,
                installationId: installed.installationId,
              }
            : item
        )
      )
      setSigningSecret('')
    } catch {
      setErrorBanner(copy.actionError)
    } finally {
      setBusyListingId(null)
    }
  }

  const handleCheckout = async (listing: MarketplaceListingRecord) => {
    if (!organisationId) return
    setBusyListingId(listing.id)
    setErrorBanner(null)
    setStatusBanner(null)
    try {
      const returnUrl =
        typeof window !== 'undefined' ? window.location.href : 'https://kodera.io/extensions'
      const result = await transport.checkoutListing(organisationId, listing.id, {
        customerKind: 'b2c',
        buyerCountry: 'FR',
        returnUrl,
        locale,
        withdrawalWaiverAccepted: waiverAccepted,
        withdrawalWaiverAt: waiverAccepted ? new Date().toISOString() : undefined,
        withdrawalWaiverStatement: waiverAccepted
          ? MARKETPLACE_WAIVER_STATEMENTS[locale]
          : undefined,
      })
      setCheckoutByListing((prev) => ({ ...prev, [listing.id]: result }))
      setListings((prev) =>
        prev.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                entitlementState: result.state,
                entitlementId: result.entitlementId,
              }
            : item
        )
      )
    } catch {
      setErrorBanner(copy.actionError)
    } finally {
      setBusyListingId(null)
    }
  }

  const handleWidgetAction = async (
    listing: MarketplaceListingRecord,
    invocation: SandboxedWidgetActionInvocation
  ) => {
    if (!organisationId || !listing.installationId || !selectedChannelId) return
    const targetChannel = channels.find((ch) => ch.id === selectedChannelId)
    if (targetChannel?.isConfidential) {
      setErrorBanner(copy.confidentialChannelError)
      return
    }
    setPendingWidgetAction(invocation.actionId)
    setErrorBanner(null)
    setStatusBanner(null)
    try {
      const res = await transport.invokeWidgetAction(
        organisationId,
        selectedChannelId,
        invocation.widgetId,
        {
          installationId: listing.installationId,
          actionId: invocation.actionId,
          payload: invocation.value !== undefined ? { value: invocation.value } : {},
        }
      )
      if (res.card !== null) {
        setLiveCards((prev) => ({
          ...prev,
          [`${listing.id}:${invocation.widgetId}`]: res.card as WidgetCard,
        }))
      }
      setStatusBanner(copy.actionDelivered)
    } catch {
      setErrorBanner(copy.actionError)
    } finally {
      setPendingWidgetAction(null)
    }
  }

  const hasPaidListing = listings.some((item) => item.pricingMode !== 'free')

  return (
    <section
      aria-labelledby={headingId}
      data-testid="extension-marketplace-panel"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-md font-semibold text-c-ink">
            {copy.heading}
          </h3>
          <p className="text-sm font-regular text-c-ink-2">{copy.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill state="info">{copy.webOnlyBadge}</StatusPill>
          {organisationId ? (
            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              onClick={() => void reloadListings()}
            >
              {copy.refreshButton}
            </Button>
          ) : null}
        </div>
      </div>

      {!billingEnabled ? (
        <div
          role="status"
          data-testid="marketplace-billing-disabled-banner"
          className="rounded-md border border-c-border bg-c-sunken px-3 py-2 text-xs font-medium text-c-ink-2"
        >
          {copy.billingDisabledNotice}
        </div>
      ) : null}

      {errorBanner !== null ? (
        <div
          role="alert"
          data-testid="marketplace-error-banner"
          className="rounded-md border border-c-bad bg-c-bad-soft px-3 py-2 text-xs font-medium text-c-bad-ink"
        >
          {errorBanner}
        </div>
      ) : null}

      {statusBanner !== null ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="marketplace-status-banner"
          className="rounded-md border border-c-ok-border bg-c-ok-soft px-3 py-2 text-xs font-medium text-c-ok-ink"
        >
          {statusBanner}
        </div>
      ) : null}

      <Card>
        <CardBody className="flex flex-col gap-3 p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor={secretInputId} className="text-xs font-medium text-c-ink-2">
                {copy.secretLabel}
              </label>
              <input
                id={secretInputId}
                type="password"
                autoComplete="off"
                value={signingSecret}
                onChange={(ev) => setSigningSecret(ev.target.value)}
                placeholder={copy.secretPlaceholder}
                data-testid="marketplace-signing-secret"
                className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 font-mono text-sm text-c-ink placeholder:text-c-placeholder focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor={channelSelectId} className="text-xs font-medium text-c-ink-2">
                {copy.widgetChannelLabel}
              </label>
              <select
                id={channelSelectId}
                value={selectedChannelId}
                onChange={(ev) => setSelectedChannelId(ev.target.value)}
                disabled={channels.length === 0}
                data-testid="marketplace-widget-channel"
                className="h-10 rounded-md border border-c-border-input bg-c-surface px-3 text-sm text-c-ink focus-visible:border-c-accent-ink focus-visible:ring focus-visible:outline-hidden"
              >
                <option value="">{copy.chooseChannel}</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {billingEnabled && hasPaidListing ? (
            <label
              htmlFor={waiverInputId}
              className="flex items-start gap-2 rounded-md border border-c-border-soft bg-c-sunken p-3 text-xs text-c-ink-2"
            >
              <input
                id={waiverInputId}
                type="checkbox"
                checked={waiverAccepted}
                onChange={(ev) => setWaiverAccepted(ev.target.checked)}
                data-testid="marketplace-waiver-checkbox"
                className="mt-1 h-4 w-4 shrink-0 rounded-sm border border-c-border-input focus-visible:ring"
              />
              <span>{copy.waiverLabel}</span>
            </label>
          ) : null}
        </CardBody>
      </Card>

      {loading ? (
        <p role="status" className="text-sm text-c-ink-3">
          {copy.loading}
        </p>
      ) : listings.length === 0 ? (
        <p
          role="status"
          data-testid="marketplace-empty-state"
          className="rounded-md border border-c-border-soft bg-c-sunken p-4 text-sm text-c-ink-2"
        >
          {copy.emptyState}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4">
          {listings.map((listing) => {
            const isFree = listing.pricingMode === 'free'
            const checkout = checkoutByListing[listing.id]
            const isBusy = busyListingId === listing.id
            const canInstall = isFree || listing.entitlementState === 'active'
            const priceText = isFree
              ? copy.freeBadge
              : `${formatEuroMinor(listing.priceExclVatMinor, locale)} ${copy.oneTimeSuffix}`

            return (
              <li key={listing.id} data-testid={`marketplace-listing-${listing.slug}`}>
                <Card>
                  <CardBody className="flex flex-col gap-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-md font-semibold text-c-ink">{listing.title}</span>
                          <span className="rounded-sm bg-c-muted px-2 py-1 font-mono text-xs text-c-ink-2">
                            {listing.slug} • v{listing.manifest.version}
                          </span>
                        </div>
                        <p className="text-sm font-regular text-c-ink-2">{listing.summary}</p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill state={isFree ? 'success' : 'info'}>{priceText}</StatusPill>
                        {listing.installed ? (
                          <StatusPill state="success">{copy.installedBadge}</StatusPill>
                        ) : listing.entitlementState === 'active' ? (
                          <StatusPill state="info">{copy.entitledBadge}</StatusPill>
                        ) : listing.entitlementState === 'pending' ? (
                          <StatusPill state="warning">{copy.pendingBadge}</StatusPill>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {listing.installed ? null : canInstall ? (
                        <Button
                          size="sm"
                          variant={isFree ? 'primary' : 'secondary'}
                          loading={isBusy}
                          disabled={!organisationId}
                          data-testid={`marketplace-install-${listing.slug}`}
                          onClick={() => void handleInstall(listing)}
                        >
                          {isFree ? copy.installFreeCta : copy.installEntitledCta}
                        </Button>
                      ) : billingEnabled ? (
                        <Button
                          size="sm"
                          variant="primary"
                          loading={isBusy}
                          disabled={!organisationId || !waiverAccepted}
                          data-testid={`marketplace-checkout-${listing.slug}`}
                          onClick={() => void handleCheckout(listing)}
                        >
                          {copy.checkoutCta}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled
                          data-testid={`marketplace-paid-disabled-${listing.slug}`}
                        >
                          {copy.paidUnavailableCta}
                        </Button>
                      )}

                      {checkout?.checkoutUrl ? (
                        <LinkButton
                          href={checkout.checkoutUrl}
                          size="sm"
                          variant="secondary"
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`marketplace-checkout-link-${listing.slug}`}
                        >
                          {copy.openCheckoutLink}
                        </LinkButton>
                      ) : null}
                    </div>

                    {listing.manifest.widgets.length > 0 ? (
                      <div className="flex flex-col gap-2 border-t border-c-border-soft pt-3">
                        <span className="text-xs font-semibold text-c-ink-2">
                          {copy.widgetPreviewTitle}
                        </span>
                        {listing.manifest.widgets.map((widget) => {
                          const cardKey = `${listing.id}:${widget.id}`
                          const activeCard = liveCards[cardKey] ?? widget.defaultCard
                          if (activeCard === undefined) return null
                          return (
                            <SandboxedWidgetCard
                              key={widget.id}
                              card={activeCard}
                              pendingActionId={pendingWidgetAction}
                              disabled={
                                !listing.installed || !organisationId || !selectedChannelId
                              }
                              onAction={(inv) => void handleWidgetAction(listing, inv)}
                            />
                          )
                        })}
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
