// docs/specs/00-shell-and-login.md §7: `entitlements` returns `federation`
// and `custom_domain` with `enabled: false` and
// `required_pack_code: visio-docs-pro`.

import { http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'

const BASE = '*/api/v1'

const ENTITLEMENTS: components['schemas']['Entitlement'][] = [
  {
    code: 'federation',
    enabled: false,
    required_pack_code: 'visio-docs-pro',
    required_capacity_tier_code: null,
    limit: null,
    used: null,
  },
  {
    code: 'custom_domain',
    enabled: false,
    required_pack_code: 'visio-docs-pro',
    required_capacity_tier_code: null,
    limit: null,
    used: null,
  },
]

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/entitlements`, () =>
    HttpResponse.json(
      { data: ENTITLEMENTS, next_cursor: null, has_more: false },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  ),
]
