// docs/specs/00-shell-and-login.md §7: `auth/discover` returns `realm: null`
// and two entries in `candidates[]` — the "one email, several organisations"
// case (§4.2), whose wireframe names ACME Construction and ACME Holding.

import { http, HttpResponse } from 'msw'

const BASE = '*/api/v1'

const CANDIDATES = [
  {
    realm: 'acme-sa',
    issuer: 'https://id.kodera.io/realms/acme-sa',
    openid_configuration_url:
      'https://id.kodera.io/realms/acme-sa/.well-known/openid-configuration',
    organisation: {
      id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
      slug: 'acme-sa',
      name: 'ACME Construction',
      realm: 'acme-sa',
    },
  },
  {
    realm: 'acme-holding',
    issuer: 'https://id.kodera.io/realms/acme-holding',
    openid_configuration_url:
      'https://id.kodera.io/realms/acme-holding/.well-known/openid-configuration',
    organisation: {
      id: '7a2e3f4d-9b5c-4d6e-af70-1b2c3d4e5f6a',
      slug: 'acme-holding',
      name: 'ACME Holding',
      realm: 'acme-holding',
    },
  },
]

export const handlers = [
  http.post(`${BASE}/auth/discover`, () =>
    HttpResponse.json(
      {
        realm: null,
        issuer: null,
        openid_configuration_url: null,
        organisation: null,
        candidates: CANDIDATES,
      },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID() } }
    )
  ),
]
