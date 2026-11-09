// docs/specs/00-shell-and-login.md §7: `auth/discover` resolves to exactly one
// organisation, `acme-sa` — the "known domain" case (§4.1), which sends the
// browser straight to that organisation's realm.
//
// Until contract 0.12.0 this was the generated base example. The reshaped
// `RealmDiscoveryResult` carries three examples, and the generator answers with
// the one `EXAMPLE_CHOICES` (scripts/api/spec.ts) names `zero` — chosen by its
// shape, not its place in the list — so the base handler answers "no
// organisation" and a spec that means "one organisation" names this overlay
// instead. The body is the contract's single-match branch: top-level metadata
// set, `candidates` empty.

import { http, HttpResponse } from 'msw'

const BASE = '*/api/v1'

export const handlers = [
  http.post(`${BASE}/auth/discover`, () =>
    HttpResponse.json(
      {
        realm: 'acme-sa',
        issuer: 'https://id.kodera.io/realms/acme-sa',
        openid_configuration_url:
          'https://id.kodera.io/realms/acme-sa/.well-known/openid-configuration',
        organisation: {
          id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
          slug: 'acme-sa',
          name: 'ACME SAS',
          realm: 'acme-sa',
        },
        candidates: [],
      },
      { status: 200, headers: { 'X-Request-Id': crypto.randomUUID(), 'Cache-Control': 'no-store' } }
    )
  ),
]
