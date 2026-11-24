import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { ExtensionMarketplacePanel } from './ExtensionMarketplacePanel'
import { ExtensionsCatalogPanel } from './ExtensionsCatalogPanel'
import type {
  ExtensionMarketplaceTransport,
  MarketplaceCheckoutResponse,
  MarketplaceListingRecord,
  WidgetActionResponse,
} from './marketplaceClient'

const FREE_LISTING: MarketplaceListingRecord = {
  id: '01950000-0000-7000-8000-000000000001',
  workspaceId: '01950000-0000-7000-8000-000000000010',
  slug: 'release-gate',
  title: 'Release Gate',
  summary: 'Interactive release approval widget and slash command.',
  pricingMode: 'free',
  priceExclVatMinor: 0,
  currency: 'EUR',
  publishedAt: '2026-06-01T10:00:00Z',
  entitlementState: null,
  entitlementId: null,
  installed: false,
  installationId: null,
  manifest: {
    schemaVersion: 'kodera.extension.v1',
    slug: 'release-gate',
    name: 'Release Gate',
    version: '0.2.0',
    description: 'Interactive release approval widget and slash command.',
    scopes: ['commands:register', 'messages:write', 'widgets:write'],
    events: ['command.invoked', 'widget.action'],
    commands: [{ name: '/release', description: 'Show release card' }],
    widgets: [
      {
        id: 'deploy-status',
        title: 'Deploy Status',
        description: 'Approve or abort release rollout',
        defaultCard: {
          schemaVersion: 'kodera.widget.v1',
          widgetId: 'deploy-status',
          title: 'Deploy Status',
          blocks: [
            { type: 'status_pill', label: 'Pending', state: 'warning' },
            {
              type: 'button_row',
              actions: [{ actionId: 'approve', label: 'Approve', variant: 'primary' }],
            },
          ],
        },
      },
    ],
    endpoint: 'https://ext.kodera.example.org/webhooks/kodera',
  },
}

const PAID_LISTING: MarketplaceListingRecord = {
  ...FREE_LISTING,
  id: '01950000-0000-7000-8000-000000000002',
  slug: 'incident-pager',
  title: 'Incident Pager Pro',
  summary: 'Paid incident escalation workflows settled on the web.',
  pricingMode: 'recurring',
  priceExclVatMinor: 1900,
  manifest: {
    ...FREE_LISTING.manifest,
    slug: 'incident-pager',
    name: 'Incident Pager Pro',
    widgets: [],
  },
}

function makeTransport(
  overrides: Partial<ExtensionMarketplaceTransport> = {}
): ExtensionMarketplaceTransport {
  return {
    listListings: vi.fn(async () => ({
      billingEnabled: false,
      listings: [FREE_LISTING, PAID_LISTING],
    })),
    publishListing: vi.fn(async () => FREE_LISTING),
    checkoutListing: vi.fn(
      async (): Promise<MarketplaceCheckoutResponse> => ({
        entitlementId: '01950000-0000-7000-8000-000000000099',
        listingId: PAID_LISTING.id,
        pricingMode: 'recurring',
        state: 'pending',
        checkoutRequired: true,
        checkoutSessionId: 'cs_test_123',
        checkoutUrl: 'https://checkout.stripe.example.org/c/pay/cs_test_123',
        grossExclVatMinor: 1900,
        vatAmountMinor: 380,
        totalInclVatMinor: 2280,
        applicationFeeAmountMinor: 190,
        currency: 'EUR',
        replayed: false,
      })
    ),
    installListing: vi.fn(async () => ({
      installationId: '01950000-0000-7000-8000-000000000077',
      entitlementId: '01950000-0000-7000-8000-000000000088',
      listingId: FREE_LISTING.id,
      slug: FREE_LISTING.slug,
      endpoint: FREE_LISTING.manifest.endpoint,
      events: FREE_LISTING.manifest.events,
      keyGeneration: '01950000-0000-7000-8000-000000000066',
      replayed: false,
    })),
    invokeWidgetAction: vi.fn(
      async (): Promise<WidgetActionResponse> => ({
        receiptId: '01950000-0000-7000-8000-000000000055',
        installationId: '01950000-0000-7000-8000-000000000077',
        channelId: 'ch-deployments',
        widgetId: 'deploy-status',
        actionId: 'approve',
        state: 'delivered',
        responseStatus: 200,
        card: {
          schemaVersion: 'kodera.widget.v1',
          widgetId: 'deploy-status',
          title: 'Deploy Status',
          blocks: [{ type: 'status_pill', label: 'Approved', state: 'success' }],
        },
        replayed: false,
      })
    ),
    ...overrides,
  }
}

describe('ExtensionMarketplacePanel & ExtensionsCatalogPanel tab mount', () => {
  it('allows free connector installation when billingEnabled is false while gating paid listings', async () => {
    const user = userEvent.setup()
    const transport = makeTransport()

    render(
      <ExtensionsCatalogPanel
        organisationId="01950000-0000-7000-8000-000000000000"
        channels={[
          { id: 'ch-deployments', label: 'deployments', isConfidential: false },
          { id: 'ch-secops', label: 'secops', isConfidential: true },
        ]}
        marketplaceTransport={transport}
      />
    )

    // Switch from default Catalogue tab to Marketplace tab:
    await user.click(screen.getByTestId('extensions-tab-marketplace'))
    expect(await screen.findByTestId('extension-marketplace-panel')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-billing-disabled-banner')).toBeInTheDocument()

    // Paid listing shows disabled CTA when billingEnabled is false:
    expect(screen.getByTestId('marketplace-paid-disabled-incident-pager')).toBeDisabled()

    // Free listing installs cleanly with a 32+ char signing secret:
    await user.type(
      screen.getByTestId('marketplace-signing-secret'),
      'whsec_0123456789abcdef0123456789abcdef'
    )
    await user.click(screen.getByTestId('marketplace-install-release-gate'))
    expect(transport.installListing).toHaveBeenCalledWith(
      '01950000-0000-7000-8000-000000000000',
      FREE_LISTING.id,
      { signingSecret: 'whsec_0123456789abcdef0123456789abcdef' }
    )

    // Confidential channel selection refuses widget action client-side before network call:
    await user.selectOptions(screen.getByTestId('marketplace-widget-channel'), 'ch-secops')
    await user.click(screen.getByTestId('widget-action-deploy-status-approve'))
    expect(transport.invokeWidgetAction).not.toHaveBeenCalled()
    expect(screen.getByTestId('marketplace-error-banner')).toBeInTheDocument()

    // Non-confidential channel dispatches widget action and updates sandboxed card:
    await user.selectOptions(screen.getByTestId('marketplace-widget-channel'), 'ch-deployments')
    await user.click(screen.getByTestId('widget-action-deploy-status-approve'))
    expect(transport.invokeWidgetAction).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Approved')).toBeInTheDocument()
  })

  it('initiates web-only Stripe Connect checkout after Art. L221-28 waiver when billingEnabled is true', async () => {
    const user = userEvent.setup()
    const transport = makeTransport({
      listListings: vi.fn(async () => ({
        billingEnabled: true,
        listings: [PAID_LISTING],
      })),
    })

    render(
      <ExtensionMarketplacePanel
        organisationId="01950000-0000-7000-8000-000000000000"
        transport={transport}
      />
    )

    const checkoutBtn = await screen.findByTestId('marketplace-checkout-incident-pager')
    expect(checkoutBtn).toBeDisabled()

    await user.click(screen.getByTestId('marketplace-waiver-checkbox'))
    expect(checkoutBtn).toBeEnabled()

    await user.click(checkoutBtn)
    expect(transport.checkoutListing).toHaveBeenCalledTimes(1)

    const checkoutLink = await screen.findByTestId('marketplace-checkout-link-incident-pager')
    expect(checkoutLink).toHaveAttribute(
      'href',
      'https://checkout.stripe.example.org/c/pay/cs_test_123'
    )
    expect(checkoutLink).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
