// 01-order.md §7: "Three packs available, Docs included in two, Enterprise
// quote-only." The base scenario every `plan`/`contacts`/`agreements` test
// starts from — realistic packs, capacity tiers, plans, prices for both billing
// periods, and the four legal documents `agreements` lists.
//
// Shaped like Core's catalogue (apps/server `apps/billing/catalogue/offer.toml`): one plan per
// tier, linked to it by the price row's `plan_code`; tiers named « Capacité S » to « Capacité L »
// with no description; each plan carries the design lane's text (French UI catalogue copy). The capacities and prices are Core's grid, below.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'
import { ownedOrderMe } from '../orderIdentity'

const BASE = '*/api/v1'

type Pack = components['schemas']['Pack']
type CapacityTier = components['schemas']['CapacityTier']
type Plan = components['schemas']['Plan']
type Price = components['schemas']['Price']
type LegalDocument = components['schemas']['LegalDocument']

const PACKS: Pack[] = [
  {
    code: 'visio',
    name: 'Visio',
    description: 'Réunions vidéo.',
    apps: ['visio'],
    profile_ref: 'visio/1.4',
    capacity_tier_codes: ['S', 'M', 'XL'],
    available: true,
  },
  {
    code: 'visio-docs',
    name: 'Visio + Docs',
    description: 'Réunions vidéo et documents collaboratifs, un seul login.',
    apps: ['visio', 'docs'],
    profile_ref: 'visio-docs/1.4',
    capacity_tier_codes: ['S', 'M', 'L', 'XL'],
    available: true,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Sur devis, au-delà de 666 personnes.',
    apps: ['visio', 'docs', 'drive'],
    profile_ref: 'enterprise/1.0',
    capacity_tier_codes: ['XL'],
    available: false,
  },
]

const TIERS: CapacityTier[] = [
  {
    code: 'S',
    name: 'Capacité S',
    description: null,
    seats_included: 80,
    concurrent_participants_included: 25,
    storage_included_bytes: 50_000_000_000,
    available: true,
  },
  {
    code: 'M',
    name: 'Capacité M',
    description: null,
    seats_included: 165,
    concurrent_participants_included: 50,
    storage_included_bytes: 100_000_000_000,
    available: true,
  },
  {
    code: 'L',
    name: 'Capacité L',
    description: null,
    seats_included: 250,
    concurrent_participants_included: 75,
    storage_included_bytes: 250_000_000_000,
    available: true,
  },
  {
    code: 'XL',
    name: 'Capacité XL',
    description: null,
    seats_included: 665,
    concurrent_participants_included: 200,
    storage_included_bytes: 500_000_000_000,
    available: true,
  },
]

function plan(code: string, name: string, description: string): Plan {
  return {
    code,
    version: 1,
    name,
    description,
    state: 'published',
    packs: ['visio', 'visio-docs'],
    support_tier: 'standard',
    published_at: '2026-01-01T00:00:00Z',
    retired_at: null,
  }
}

const PLANS: Plan[] = [
  plan(
    'team',
    'Team',
    'Pour une équipe ou une petite organisation. Assistance par e-mail les jours ouvrés ; Docs en option dès sa mise à disposition.'
  ),
  plan(
    'business',
    'Business',
    'Pour une organisation de taille moyenne, avec plusieurs équipes. Assistance par e-mail les jours ouvrés ; Docs en option dès sa mise à disposition.'
  ),
  plan(
    'business-plus',
    'Business Plus',
    'Pour une organisation qui tient de grandes réunions et des événements internes. Assistance par e-mail les jours ouvrés ; Docs inclus dès sa mise à disposition.'
  ),
  plan(
    'enterprise',
    'Enterprise',
    'Pour une grande organisation ou un organisme public. Assistance par e-mail les jours ouvrés ; Docs inclus dès sa mise à disposition.'
  ),
]

/** The plan each tier is sold under, as Core's price rows name it. */
const PLAN_OF_TIER: Record<string, string> = {
  S: 'team',
  M: 'business',
  L: 'business-plus',
  XL: 'enterprise',
}

let priceCounter = 0
function price(
  packCode: string,
  tierCode: string,
  billingPeriod: 'monthly' | 'yearly',
  amountMinor: number
): Price {
  priceCounter += 1
  return {
    id: `00000000-0000-4000-8000-${String(priceCounter).padStart(12, '0')}`,
    plan_code: PLAN_OF_TIER[tierCode] ?? 'team',
    plan_version: 1,
    pack_code: packCode,
    capacity_tier_code: tierCode,
    billing_period: billingPeriod,
    amount_excl_vat: { amount_minor: amountMinor, currency: 'EUR' },
    valid_from: '2026-01-01T00:00:00Z',
  }
}

/**
 * The yearly price from a monthly list price, as Core's grid sets it: the list less 10 %,
 * rounded down to the euro, twelve times. A yearly row is that annual total.
 */
function yearly(listMinor: number): number {
  return Math.floor((listMinor * 0.9) / 100) * 100 * 12
}

// Core's grid (apps/server `apps/billing/catalogue/offer.toml`), in the state where Docs is on
// sale: Docs is +99 € on Team and Business; Business Plus is sold with Docs only, at 790 € (its
// Visio-only 690 € rows close when Docs ships); Enterprise is sold yearly only, Docs included,
// on a 1 490 € list price. So no demo or test shows a price Core does not sell.
const PRICES: Price[] = [
  price('visio', 'S', 'monthly', 17_900),
  price('visio', 'S', 'yearly', yearly(17_900)),
  price('visio', 'M', 'monthly', 34_900),
  price('visio', 'M', 'yearly', yearly(34_900)),
  price('visio', 'XL', 'yearly', yearly(149_000)),
  price('visio-docs', 'S', 'monthly', 27_800),
  price('visio-docs', 'S', 'yearly', yearly(27_800)),
  price('visio-docs', 'M', 'monthly', 44_800),
  price('visio-docs', 'M', 'yearly', yearly(44_800)),
  price('visio-docs', 'L', 'monthly', 79_000),
  price('visio-docs', 'L', 'yearly', yearly(79_000)),
  price('visio-docs', 'XL', 'yearly', yearly(149_000)),
]

const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    code: 'cgv',
    version: '2.1',
    locale: 'fr',
    title: 'Conditions générales de vente',
    pack_code: null,
    html_url: 'https://kodera.io/legal/cgv/2.1',
    sha256: '0000000000000000000000000000000000000000000000000000000000000001',
    download: {
      url: 'https://kodera.io/legal/cgv/2.1.pdf',
      expires_at: '2027-01-01T00:00:00Z',
      content_type: 'application/pdf',
    },
    published_at: '2026-01-01T00:00:00Z',
  },
  {
    code: 'dpa',
    version: '1.4',
    locale: 'fr',
    title: 'Contrat de sous-traitance (RGPD)',
    pack_code: 'visio-docs',
    html_url: 'https://kodera.io/legal/dpa/1.4',
    sha256: '0000000000000000000000000000000000000000000000000000000000000002',
    download: {
      url: 'https://kodera.io/legal/dpa/1.4.pdf',
      expires_at: '2027-01-01T00:00:00Z',
      content_type: 'application/pdf',
    },
    published_at: '2026-01-01T00:00:00Z',
  },
  {
    code: 'sla',
    version: '1.2',
    locale: 'fr',
    title: 'Engagement de service',
    pack_code: null,
    html_url: 'https://kodera.io/legal/sla/1.2',
    sha256: '0000000000000000000000000000000000000000000000000000000000000003',
    download: {
      url: 'https://kodera.io/legal/sla/1.2.pdf',
      expires_at: '2027-01-01T00:00:00Z',
      content_type: 'application/pdf',
    },
    published_at: '2026-01-01T00:00:00Z',
  },
  {
    code: 'aup',
    version: '1.0',
    locale: 'fr',
    title: "Charte d'usage",
    pack_code: null,
    html_url: 'https://kodera.io/legal/aup/1.0',
    sha256: '0000000000000000000000000000000000000000000000000000000000000004',
    download: {
      url: 'https://kodera.io/legal/aup/1.0.pdf',
      expires_at: '2027-01-01T00:00:00Z',
      content_type: 'application/pdf',
    },
    published_at: '2026-01-01T00:00:00Z',
  },
]

const requestId = (): string => crypto.randomUUID()
const page = <T>(data: T[]) => ({ data, next_cursor: null, has_more: false })

export const handlers = [
  http.get(`${BASE}/me`, () => HttpResponse.json(ownedOrderMe())),
  http.get(`${BASE}/catalog/plans`, () =>
    HttpResponse.json(page(PLANS), { headers: { 'X-Request-Id': requestId() } })
  ),
  http.get(`${BASE}/catalog/packs`, () =>
    HttpResponse.json(page(PACKS), { headers: { 'X-Request-Id': requestId() } })
  ),
  http.get(`${BASE}/catalog/capacity-tiers`, () =>
    HttpResponse.json(page(TIERS), { headers: { 'X-Request-Id': requestId() } })
  ),
  http.get(`${BASE}/catalog/prices`, ({ request }) => {
    const url = new URL(request.url)
    const packCode = url.searchParams.get('pack_code')
    const billingPeriod = url.searchParams.get('billing_period')
    const data = PRICES.filter(
      (row) =>
        (packCode === null || row.pack_code === packCode) &&
        (billingPeriod === null || row.billing_period === billingPeriod)
    )
    return HttpResponse.json(page(data), { headers: { 'X-Request-Id': requestId() } })
  }),
  http.get(`${BASE}/legal-documents`, () =>
    HttpResponse.json(page(LEGAL_DOCUMENTS), { headers: { 'X-Request-Id': requestId() } })
  ),
]
