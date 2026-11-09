import { http, HttpResponse } from 'msw'
import { tenantStatusBody } from './support/status-fixtures'

export const handlers = [
  http.get('*/api/v1/tenants/:tenant_id/status', () => {
    const body = tenantStatusBody()
    return HttpResponse.json({
      ...body,
      apps: body.apps.map((app) => ({
        ...app,
        url: `https://${app.code}.a-very-long-organisation-name-for-responsive-address-acceptance.example.test`,
        default_url: `https://a-very-long-organisation-name-for-responsive-address-acceptance.${app.code}.kodera.io`,
      })),
    })
  }),
]
