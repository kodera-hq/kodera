import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState, type ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { server } from '@/mocks/server'
import { ConfirmationStep } from '../order/ConfirmationStep'
import { emptyDraft, type OrderDraft } from '../order/draft'
import { PlanStep } from '../order/PlanStep'
import { isAllowedCheckoutRedirectUrl } from './checkoutUrl'
import { WorkspacePackSummaryCard } from './WorkspacePackSummaryCard'

vi.mock('../support/HelpLink', async () => {
  const { helpHref } = await import('../support/helpHref')
  return {
    HelpLink: ({
      org,
      search,
      children,
    }: {
      org: string
      search?: Parameters<typeof helpHref>[1]
      children: ReactNode
    }) => <a href={helpHref(org, search)}>{children}</a>,
  }
})

const BASE = 'https://core.test/api/v1'
const ORDER_ID = 'a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f'
const INVOICE_ID = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'
const ownerRole = 'org_owner' as const

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(async () => {
  vi.stubEnv('VITE_CORE_API_URL', BASE)
  await i18n.changeLanguage('fr')
})
afterEach(async () => {
  server.resetHandlers()
  vi.unstubAllEnvs()
  await i18n.changeLanguage('fr')
})
afterAll(() => server.close())

describe('Stripe Checkout redirect URL allowlist validation', () => {
  it('accepts only HTTPS checkout.stripe.com URLs in production mode', () => {
    expect(
      isAllowedCheckoutRedirectUrl('https://checkout.stripe.com/c/pay/cs_live_123', {
        allowSyntheticTestHosts: false,
      })
    ).toBe(true)

    for (const unsafeUrl of [
      'http://checkout.stripe.com/c/pay/cs_live_123',
      'https://checkout.stripe.com:8443/c/pay/cs_live_123',
      'https://user:secret@checkout.stripe.com/c/pay/cs_live_123',
      'https://checkout.stripe.com.evil.example/c/pay/cs_live_123',
      'https://evil-checkout.stripe.com/c/pay/cs_live_123',
      'https://pay.example.invalid/xJ8kQ2mR7t',
      'https://evil.example.org/pay',
      'javascript:alert(1)',
      'https://checkout.stripe.com/c/pay/cs live',
      '',
    ]) {
      expect(
        isAllowedCheckoutRedirectUrl(unsafeUrl, { allowSyntheticTestHosts: false })
      ).toBe(false)
    }
  })

  it('withholds untrusted checkout redirect hosts on ConfirmationStep and falls back to bank transfer', async () => {
    const futureExpiry = new Date(Date.now() + 3_600_000).toISOString()
    server.use(
      http.get(`${BASE}/orders/:order_id`, () =>
        HttpResponse.json({
          id: ORDER_ID,
          organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
          state: 'pending_payment',
          pack_code: 'workspace',
          capacity_tier_code: 'M',
          billing_period: 'yearly',
          invoice_id: INVOICE_ID,
          created_at: '2026-11-13T10:00:00Z',
        })
      ),
      http.get(`${BASE}/invoices/:invoice_id`, () =>
        HttpResponse.json({
          id: INVOICE_ID,
          organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
          number: 'FA-2026-0100',
          state: 'issued',
          currency: 'EUR',
          vat_regime: 'fr_standard',
          lines: [
            {
              description: 'Business Workspace',
              quantity: 1,
              unit_amount_excl_vat: { amount_minor: 376800, currency: 'EUR' },
              total_excl_vat: { amount_minor: 376800, currency: 'EUR' },
              vat_rate_bp: 2000,
            },
          ],
          total_excl_vat: { amount_minor: 376800, currency: 'EUR' },
          vat_amount: { amount_minor: 75360, currency: 'EUR' },
          total_incl_vat: { amount_minor: 452160, currency: 'EUR' },
          created_at: '2026-11-13T10:00:00Z',
        })
      ),
      http.post(`${BASE}/invoices/:invoice_id/payment-link`, () =>
        HttpResponse.json(
          {
            id: 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081',
            invoice_id: INVOICE_ID,
            provider: 'stripe',
            url: 'https://phishing-checkout.example.org/pay',
            state: 'active',
            amount: { amount_minor: 452160, currency: 'EUR' },
            expires_at: futureExpiry,
            created_at: '2026-11-13T10:00:00Z',
          },
          { status: 201 }
        )
      )
    )

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ConfirmationStep
          org="acme-sa"
          role={ownerRole}
          orderId={ORDER_ID}
          firstName="Marie"
          onGoToStatus={vi.fn()}
        />
      </QueryClientProvider>
    )

    expect(
      await screen.findByText(
        'Le paiement en ligne est momentanément indisponible. Réglez par virement avec les coordonnées de la facture, ou réessayez.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Payer en ligne' })).toBeNull()
  })
})

describe('Unified `workspace` pack & Core snapshot minor-unit rendering', () => {
  it('renders unified workspace apps (`messaging`, `visio`, `docs`) and capacity guides on PlanStep', async () => {
    server.use(
      http.get(`${BASE}/catalog/packs`, () =>
        HttpResponse.json({
          data: [
            {
              code: 'visio',
              name: 'Visio legacy',
              apps: ['visio'],
              available: false,
            },
            {
              code: 'workspace',
              name: 'Kodera Workspace',
              apps: ['messaging', 'visio', 'docs'],
              available: true,
            },
          ],
          next_cursor: null,
          has_more: false,
        })
      ),
      http.get(`${BASE}/catalog/capacity-tiers`, () =>
        HttpResponse.json({
          data: [
            {
              code: 'M',
              name: 'Capacité M',
              description: null,
              seats_included: 165,
              concurrent_participants_included: 50,
              storage_included_bytes: 100_000_000_000,
              available: true,
            },
          ],
          next_cursor: null,
          has_more: false,
        })
      ),
      http.get(`${BASE}/catalog/plans`, () =>
        HttpResponse.json({
          data: [
            {
              code: 'business',
              version: 1,
              name: 'Business',
              description: 'Espace collaboratif unifié.',
              state: 'published',
              packs: ['workspace'],
            },
          ],
          next_cursor: null,
          has_more: false,
        })
      ),
      http.get(`${BASE}/catalog/prices`, ({ request }) => {
        const params = new URL(request.url).searchParams
        const period = params.get('billing_period') === 'monthly' ? 'monthly' : 'yearly'
        return HttpResponse.json({
          data: [
            {
              id: `00000000-0000-4000-8000-00000000001${period === 'monthly' ? '2' : '1'}`,
              plan_code: 'business',
              plan_version: 1,
              pack_code: 'workspace',
              capacity_tier_code: 'M',
              billing_period: period,
              amount_excl_vat: {
                amount_minor: period === 'monthly' ? 34_900 : 376_800,
                currency: 'EUR',
              },
              valid_from: '2026-01-01T00:00:00Z',
            },
          ],
          next_cursor: null,
          has_more: false,
        })
      })
    )

    const onUpdate = vi.fn()
    function PlanHarness() {
      const [draft, setDraft] = useState<OrderDraft>({ ...emptyDraft(), billingPeriod: 'yearly' })
      return (
        <PlanStep
          draft={draft}
          update={(patch) => {
            onUpdate(patch)
            setDraft((prev) => ({ ...prev, ...patch }))
          }}
          role={ownerRole}
          organisationId="org-1"
          onContinue={vi.fn()}
          onRequestQuote={vi.fn()}
        />
      )
    }

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <PlanHarness />
      </QueryClientProvider>
    )

    const appsList = await screen.findByRole('list', { name: 'Applications incluses' })
    expect(within(appsList).getByText('Messagerie')).toBeVisible()
    expect(within(appsList).getByText('Visio')).toBeVisible()
    expect(within(appsList).getByText('Docs')).toBeVisible()

    const card = await screen.findByRole('radio', { name: /^Business,/ })
    expect(within(card).getByText('165 sièges inclus')).toBeVisible()
    expect(within(card).getByText('50 participants simultanés')).toBeVisible()
    expect(within(card).getByText(/100\sGo de stockage inclus/)).toBeVisible()

    await userEvent.click(card)
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ capacityTierCode: 'M', packCode: 'workspace' })
    )
    expect(appsList.querySelectorAll('[style]')).toHaveLength(0)
    expect(card.querySelectorAll('[style]')).toHaveLength(0)
  })

  it('renders Core minor-unit snapshots in FR and EN without client-side VAT calculation', async () => {
    // Deliberately pass non-20% custom snapshot integers so any client-side
    // percentage recalculation would diverge from Core's authoritative amounts.
    const snapshot = {
      price_id: '00000000-0000-4000-8000-000000000099',
      plan_code: 'business',
      plan_version: 1,
      pack_code: 'workspace',
      capacity_tier_code: 'M',
      billing_period: 'yearly' as const,
      unit_amount_excl_vat: { amount_minor: 376_800, currency: 'EUR' as const },
      quantity: 1,
      vat_regime: 'eu_reverse_charge' as const,
      vat_rate_bp: 0,
      total_excl_vat: { amount_minor: 376_800, currency: 'EUR' as const },
      vat_amount: { amount_minor: 123, currency: 'EUR' as const },
      total_incl_vat: { amount_minor: 376_923, currency: 'EUR' as const },
    }

    const { container, rerender } = render(
      <WorkspacePackSummaryCard
        packCode="workspace"
        pack={{
          code: 'workspace',
          name: 'Workspace',
          apps: ['messaging', 'visio', 'docs'],
          available: true,
        }}
        capacityTier={{
          code: 'M',
          name: 'Capacité M',
          seats_included: 165,
          concurrent_participants_included: 50,
          storage_included_bytes: 100_000_000_000,
          available: true,
        }}
        priceSnapshot={snapshot}
      />
    )

    expect(screen.getByText('Pack unifié Workspace')).toBeVisible()
    expect(screen.getByText(/Autoliquidation UE/)).toBeVisible()
    expect(screen.getByText(/^3\s768\s€$/)).toBeVisible()
    expect(screen.getByText(/^1,23\s€$/)).toBeVisible()
    expect(screen.getByText(/^3\s769,23\s€$/)).toBeVisible()
    expect(container.querySelectorAll('[style]')).toHaveLength(0)

    await i18n.changeLanguage('en')
    rerender(
      <WorkspacePackSummaryCard
        packCode="workspace"
        pack={{
          code: 'workspace',
          name: 'Workspace',
          apps: ['messaging', 'visio', 'docs'],
          available: true,
        }}
        capacityTier={{
          code: 'M',
          name: 'Capacity M',
          seats_included: 165,
          concurrent_participants_included: 50,
          storage_included_bytes: 100_000_000_000,
          available: true,
        }}
        priceSnapshot={snapshot}
      />
    )

    expect(screen.getByText('Unified Workspace pack')).toBeVisible()
    expect(screen.getByText('Messaging')).toBeVisible()
    expect(screen.getByText('165 seats included')).toBeVisible()
    expect(screen.getByText('50 concurrent participants included')).toBeVisible()
    expect(screen.getByText('100 GB included storage')).toBeVisible()
    expect(screen.getByText('EU reverse charge (0% VAT)')).toBeVisible()
  })
})
