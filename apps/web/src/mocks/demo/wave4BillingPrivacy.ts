// Demo MSW handlers for Core API 0.44.0 Wave 4 billing (VIES status, Factur-X credit
// notes), workspace quota usage observation, and GDPR Art. 20 / Art. 17 self-service.
// Read-only demo observations answer deterministic Groupe Vercelli figures, while
// archive builds and destructive erasures answer truthful demo refusals (`503` / `403`).

import { http, HttpResponse, type HttpHandler } from 'msw'
import type { components } from '@/api/schema'
import { problem } from '../problem'
import * as seed from './seed'

type BillingVatStatus = components['schemas']['BillingVatStatus']
type WorkspaceQuotaUsage = components['schemas']['WorkspaceQuotaUsage']

export const WAVE4_BILLING_PRIVACY_DEMO_ROUTES: readonly string[] = [
  'GET /credit-notes/:credit_note_id',
  'GET /credit-notes/:credit_note_id/download',
  'GET /organisations/:organisation_id/billing/vat-status',
  'POST /organisations/:organisation_id/billing/vat-status',
  'GET /organisations/:organisation_id/workspace/quotas/usage',
  'POST /organisations/:organisation_id/workspace/privacy/exports',
  'GET /organisations/:organisation_id/workspace/privacy/exports/:request_id',
  'GET /organisations/:organisation_id/workspace/privacy/exports/:request_id/download',
  'POST /organisations/:organisation_id/workspace/privacy/deletions',
  'GET /organisations/:organisation_id/workspace/privacy/deletions/:request_id',
  'POST /me/privacy/exports',
  'GET /me/privacy/exports/:request_id',
  'GET /me/privacy/exports/:request_id/download',
  'POST /me/privacy/deletions',
  'GET /me/privacy/deletions/:request_id',
]

export function wave4BillingPrivacyDemoHandlers(
  base: string,
  headers: () => Record<string, string>
): HttpHandler[] {
  const missing = () => problem('https://kodera.io/problems/not-found')
  const demoHold = () => problem('https://kodera.io/problems/service-unavailable')

  return [
    http.get(`${base}/credit-notes/:credit_note_id`, missing),
    http.get(`${base}/credit-notes/:credit_note_id/download`, missing),
    http.get(`${base}/organisations/:organisation_id/billing/vat-status`, () => {
      const body: BillingVatStatus = {
        vat_number: null,
        country_code: 'FR',
        status: 'not_checked',
        checked_at: null,
        next_check_at: null,
        evidence_id: null,
      }
      return HttpResponse.json(body, { headers: headers() })
    }),
    http.post(`${base}/organisations/:organisation_id/billing/vat-status`, async ({ request }) => {
      const payload = (await request.json().catch(() => null)) as
        | { country_code?: unknown; vat_number?: unknown }
        | null
      const countryCode =
        typeof payload?.country_code === 'string' && /^[A-Z]{2}$/.test(payload.country_code)
          ? payload.country_code
          : 'FR'
      const vatNumber =
        typeof payload?.vat_number === 'string' && payload.vat_number.trim().length > 0
          ? payload.vat_number.trim()
          : null
      const body: BillingVatStatus = {
        vat_number: vatNumber,
        country_code: countryCode,
        status: 'unavailable',
        checked_at: new Date().toISOString(),
        next_check_at: null,
        evidence_id: null,
      }
      return HttpResponse.json(body, { headers: headers() })
    }),
    http.get(`${base}/organisations/:organisation_id/workspace/quotas/usage`, () => {
      const subscribedTier =
        seed.CAPACITY_TIERS.find((tier) => tier.code === seed.CURRENT_TIER_CODE) ??
        seed.CAPACITY_TIERS[0]!
      const body: WorkspaceQuotaUsage = {
        usage: {
          seats: 42,
          mediaBytes: 12_000_000_000,
          pages: 18,
        },
        limits: {
          seats: subscribedTier.seats_included,
          mediaBytes: subscribedTier.storage_included_bytes,
          pages: 500,
        },
        measuredAt: new Date().toISOString(),
      }
      return HttpResponse.json(body, { headers: headers() })
    }),
    http.post(`${base}/organisations/:organisation_id/workspace/privacy/exports`, demoHold),
    http.get(
      `${base}/organisations/:organisation_id/workspace/privacy/exports/:request_id`,
      missing
    ),
    http.get(
      `${base}/organisations/:organisation_id/workspace/privacy/exports/:request_id/download`,
      missing
    ),
    http.post(`${base}/organisations/:organisation_id/workspace/privacy/deletions`, demoHold),
    http.get(
      `${base}/organisations/:organisation_id/workspace/privacy/deletions/:request_id`,
      missing
    ),
    http.post(`${base}/me/privacy/exports`, demoHold),
    http.get(`${base}/me/privacy/exports/:request_id`, missing),
    http.get(`${base}/me/privacy/exports/:request_id/download`, missing),
    http.post(`${base}/me/privacy/deletions`, demoHold),
    http.get(`${base}/me/privacy/deletions/:request_id`, missing),
  ]
}
