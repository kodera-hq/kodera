import { coreApi as marketplaceCoreClient } from '@/api/client'
import type { WidgetCard } from './widgetSchema'

export type MarketplacePricingMode = 'free' | 'one_time' | 'recurring'
export type MarketplaceEntitlementState = 'pending' | 'active' | 'revoked' | 'refunded'

export interface MarketplaceManifestCommand {
  readonly name: string
  readonly description: string
}

export interface MarketplaceManifestWidget {
  readonly id: string
  readonly title: string
  readonly description?: string | undefined
  readonly defaultCard?: WidgetCard | undefined
}

export interface MarketplaceExtensionManifest {
  readonly schemaVersion: 'kodera.extension.v1'
  readonly slug: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly scopes: readonly string[]
  readonly events: readonly string[]
  readonly commands: readonly MarketplaceManifestCommand[]
  readonly widgets: readonly MarketplaceManifestWidget[]
  readonly endpoint: string
}

export interface MarketplaceListingRecord {
  readonly id: string
  readonly workspaceId: string
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly pricingMode: MarketplacePricingMode
  readonly priceExclVatMinor: number
  readonly currency: 'EUR'
  readonly manifest: MarketplaceExtensionManifest
  readonly publishedAt: string | null
  readonly entitlementState: MarketplaceEntitlementState | null
  readonly entitlementId: string | null
  readonly installed: boolean
  readonly installationId: string | null
}

export interface MarketplaceListResponse {
  readonly billingEnabled: boolean
  readonly listings: readonly MarketplaceListingRecord[]
}

export interface MarketplacePublishInput {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly manifest: MarketplaceExtensionManifest
  readonly pricingMode?: MarketplacePricingMode | undefined
  readonly priceExclVatMinor?: number | undefined
}

export interface MarketplaceCheckoutInput {
  readonly customerKind?: 'b2c' | 'b2b' | undefined
  readonly buyerCountry?: string | undefined
  readonly returnUrl?: string | undefined
  readonly locale?: 'fr' | 'en' | undefined
  readonly withdrawalWaiverAccepted?: boolean | undefined
  readonly withdrawalWaiverAt?: string | undefined
  readonly withdrawalWaiverStatement?: string | undefined
}

export interface MarketplaceCheckoutResponse {
  readonly entitlementId: string
  readonly listingId: string
  readonly pricingMode: MarketplacePricingMode
  readonly state: MarketplaceEntitlementState
  readonly checkoutRequired: boolean
  readonly checkoutSessionId: string | null
  readonly checkoutUrl: string | null
  readonly grossExclVatMinor: number
  readonly vatAmountMinor: number
  readonly totalInclVatMinor: number
  readonly applicationFeeAmountMinor: number
  readonly currency: 'EUR'
  readonly replayed: boolean
}

export interface MarketplaceInstallInput {
  readonly signingSecret: string
  readonly endpoint?: string | undefined
}

export interface MarketplaceInstallResponse {
  readonly installationId: string
  readonly entitlementId: string
  readonly listingId: string
  readonly slug: string
  readonly endpoint: string
  readonly events: readonly string[]
  readonly keyGeneration: string
  readonly replayed: boolean
}

export interface WidgetActionInput {
  readonly installationId: string
  readonly actionId: string
  readonly payload?: Readonly<Record<string, unknown>> | undefined
}

export interface WidgetActionResponse {
  readonly receiptId: string
  readonly installationId: string
  readonly channelId: string
  readonly widgetId: string
  readonly actionId: string
  readonly state: 'in_flight' | 'delivered' | 'refused' | 'failed'
  readonly responseStatus: number | null
  readonly card: WidgetCard | null
  readonly replayed: boolean
}

export interface ExtensionMarketplaceTransport {
  listListings(organisationId: string): Promise<MarketplaceListResponse>
  publishListing(
    organisationId: string,
    input: MarketplacePublishInput
  ): Promise<MarketplaceListingRecord>
  checkoutListing(
    organisationId: string,
    listingId: string,
    input: MarketplaceCheckoutInput
  ): Promise<MarketplaceCheckoutResponse>
  installListing(
    organisationId: string,
    listingId: string,
    input: MarketplaceInstallInput
  ): Promise<MarketplaceInstallResponse>
  invokeWidgetAction(
    organisationId: string,
    channelId: string,
    widgetId: string,
    input: WidgetActionInput
  ): Promise<WidgetActionResponse>
}

type RawClientRequest = (
  method: 'get' | 'post',
  path: string,
  init: Record<string, unknown>
) => Promise<{ data?: unknown; response: Response }>

function requestFn(): RawClientRequest {
  return marketplaceCoreClient().request as unknown as RawClientRequest
}

export function formatEuroMinor(minor: number, locale: 'fr' | 'en' = 'fr'): string {
  const euros = minor / 100
  return new Intl.NumberFormat(locale === 'en' ? 'en-IE' : 'fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(euros)
}

export const MARKETPLACE_WAIVER_STATEMENTS = {
  fr: "Je demande l'exécution immédiate du service numérique et renonce expressément à mon droit de rétractation de 14 jours conformément à l'article L221-28 du Code de la consommation.",
  en: 'I request immediate performance of the digital service and expressly waive my 14-day withdrawal right under Article L221-28 of the French Consumer Code.',
} as const

export const defaultExtensionMarketplaceTransport: ExtensionMarketplaceTransport = {
  async listListings(organisationId) {
    const { data } = await requestFn()(
      'get',
      '/organisations/{organisation_id}/workspace/extensions/marketplace',
      {
        params: { path: { organisation_id: organisationId } },
      }
    )
    return (
      (data as MarketplaceListResponse | undefined) ?? {
        billingEnabled: false,
        listings: [],
      }
    )
  },

  async publishListing(organisationId, input) {
    const { data } = await requestFn()(
      'post',
      '/organisations/{organisation_id}/workspace/extensions/marketplace',
      {
        params: { path: { organisation_id: organisationId } },
        headers: { 'Content-Type': 'application/json' },
        body: input,
      }
    )
    return data as MarketplaceListingRecord
  },

  async checkoutListing(organisationId, listingId, input) {
    const { data } = await requestFn()(
      'post',
      '/organisations/{organisation_id}/workspace/extensions/marketplace/{listing_id}/checkout',
      {
        params: { path: { organisation_id: organisationId, listing_id: listingId } },
        headers: { 'Content-Type': 'application/json' },
        body: input,
      }
    )
    return data as MarketplaceCheckoutResponse
  },

  async installListing(organisationId, listingId, input) {
    const { data } = await requestFn()(
      'post',
      '/organisations/{organisation_id}/workspace/extensions/marketplace/{listing_id}/install',
      {
        params: { path: { organisation_id: organisationId, listing_id: listingId } },
        headers: { 'Content-Type': 'application/json' },
        body: input,
      }
    )
    return data as MarketplaceInstallResponse
  },

  async invokeWidgetAction(organisationId, channelId, widgetId, input) {
    const { data } = await requestFn()(
      'post',
      '/organisations/{organisation_id}/workspace/channels/{channel_id}/widgets/{widget_id}/actions',
      {
        params: {
          path: {
            organisation_id: organisationId,
            channel_id: channelId,
            widget_id: widgetId,
          },
        },
        headers: { 'Content-Type': 'application/json' },
        body: input,
      }
    )
    return data as WidgetActionResponse
  },
}
