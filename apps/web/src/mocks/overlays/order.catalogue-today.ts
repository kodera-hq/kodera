// Core's catalogue as it launches, before Docs can be deployed (apps/server
// `apps/billing/catalogue/offer.toml`): the Visio + Docs pack is not on sale, so the public
// catalogue lists none of its prices, and Business Plus is sold Visio-only at 690 €. Listed after
// `order.catalogue-default`, whose tiers, plans and legal documents it keeps.

import { http, HttpResponse } from 'msw/http'
import type { components } from '@/api/schema'

type Pack = components['schemas']['Pack']
type Price = components['schemas']['Price']

const BASE = '*/api/v1'

const PACKS: Pack[] = [
  {
    code: 'visio',
    name: 'Visio',
    description:
      'Réunions vidéo et salles de réunion permanentes sur votre instance, hébergée dans l’Union européenne.',
    apps: ['visio'],
    profile_ref: 'visio/1.0',
    capacity_tier_codes: ['S', 'M', 'L', 'XL'],
    available: true,
  },
  {
    code: 'visio-docs',
    name: 'Visio + Docs',
    description:
      'Réunions vidéo, salles de réunion permanentes et documents collaboratifs sur votre instance, hébergée dans l’Union européenne.',
    apps: ['visio', 'docs'],
    profile_ref: 'visio-docs/1.0',
    capacity_tier_codes: ['S', 'M', 'L', 'XL'],
    available: false,
  },
]

const PLAN_OF_TIER: Record<string, string> = {
  S: 'team',
  M: 'business',
  L: 'business-plus',
  XL: 'enterprise',
}

/** The list less 10 %, rounded down to the euro, twelve times: Core's yearly rule. */
function yearly(listMinor: number): number {
  return Math.floor((listMinor * 0.9) / 100) * 100 * 12
}

let counter = 0
function price(tierCode: string, billingPeriod: 'monthly' | 'yearly', amountMinor: number): Price {
  counter += 1
  return {
    id: `00000000-0000-4000-8000-1000000000${String(counter).padStart(2, '0')}`,
    plan_code: PLAN_OF_TIER[tierCode] ?? 'team',
    plan_version: 1,
    pack_code: 'visio',
    capacity_tier_code: tierCode,
    billing_period: billingPeriod,
    amount_excl_vat: { amount_minor: amountMinor, currency: 'EUR' },
    valid_from: '2026-01-01T00:00:00Z',
  }
}

const PRICES: Price[] = [
  price('S', 'monthly', 17_900),
  price('S', 'yearly', yearly(17_900)),
  price('M', 'monthly', 34_900),
  price('M', 'yearly', yearly(34_900)),
  price('L', 'monthly', 69_000),
  price('L', 'yearly', yearly(69_000)),
  price('XL', 'yearly', yearly(149_000)),
]

const page = <T>(data: T[]) => ({ data, next_cursor: null, has_more: false })

const headers = () => ({ 'X-Request-Id': crypto.randomUUID() })

export const handlers = [
  http.get(`${BASE}/catalog/packs`, () => HttpResponse.json(page(PACKS), { headers: headers() })),
  // Only what can be ordered: no Visio + Docs price while that pack is not on sale.
  http.get(`${BASE}/catalog/prices`, ({ request }) => {
    const url = new URL(request.url)
    const packCode = url.searchParams.get('pack_code')
    const billingPeriod = url.searchParams.get('billing_period')
    const data = PRICES.filter(
      (row) =>
        (packCode === null || row.pack_code === packCode) &&
        (billingPeriod === null || row.billing_period === billingPeriod)
    )
    return HttpResponse.json(page(data), { headers: headers() })
  }),
]
