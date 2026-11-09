// 01-order.md §7: "`slug-availability` returns `available: false`,
// `reason: taken`, three `suggestions[]`." The identifier the buyer typed
// never says who holds it (the endpoint's own contract), only what to try
// instead.
//
// The `slug` parameter carries the whole tenant slug pattern (3–32
// characters, a DNS label), so a value that fails it is refused before any
// availability answer — `400 malformed-request`, as the contract's own note
// on `reason: invalid_format` says — and a suggestion, being a slug too, has
// to fit the same 32 characters.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { isTenantSlug } from '@/api/tenantSlug'
import { problem } from '../problem'

const BASE = '*/api/v1'

/** The tenant slug's upper bound (`SlugAvailability.suggestions[]` carries the same pattern). */
const SLUG_MAX_LENGTH = 32

/** `<slug>-<suffix>`, the slug cut short so the suggestion is itself a valid tenant slug. */
function suggest(slug: string, suffix: string): string {
  const base = slug.slice(0, SLUG_MAX_LENGTH - suffix.length - 1).replace(/-+$/, '')
  return `${base}-${suffix}`
}

export const handlers = [
  http.get(`${BASE}/slug-availability`, ({ request }) => {
    const slug = new URL(request.url).searchParams.get('slug') ?? ''
    if (!isTenantSlug(slug)) {
      return problem('https://kodera.io/problems/malformed-request', {
        detail: 'slug: not a tenant slug (3-32 characters, a DNS label).',
        instance: '/api/v1/slug-availability',
      })
    }
    const body: components['schemas']['SlugAvailability'] = {
      slug,
      available: false,
      reason: 'taken',
      suggestions: [suggest(slug, 'fr'), suggest(slug, 'group'), suggest(slug, '2027')],
    }
    return HttpResponse.json(body, { headers: { 'X-Request-Id': crypto.randomUUID() } })
  }),
]
