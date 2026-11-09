// docs/specs/11-workspace.md: a tenant that runs the `messaging` app beside Visio and Docs, so
// the module rail draws « Messages ». No pack on sale includes messaging and the demo is Visio-only,
// so this overlay is what keeps the rail's path to the workspace covered in a real browser.

import { http, HttpResponse } from 'msw'
import { operationalComponents, tenantsListBody, tenantStatusBody } from './support/status-fixtures'

const BASE = '*/api/v1'

export const handlers = [
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () =>
    HttpResponse.json(tenantsListBody('active'))
  ),
  http.get(`${BASE}/tenants/:tenant_id/status`, () => {
    const body = tenantStatusBody({ status: 'active', components: operationalComponents() })
    return HttpResponse.json({
      ...body,
      apps: [
        ...body.apps,
        {
          code: 'messaging',
          name: 'Espace',
          url: 'https://espace.acme.fr',
          default_url: 'https://acme.espace.kodera.io',
          custom_domain: 'espace.acme.fr',
          state: 'live',
          version: '0.1',
        },
      ],
    })
  }),
]
