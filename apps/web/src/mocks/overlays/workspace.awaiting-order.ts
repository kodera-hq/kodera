// Core's gate on the first workspace (lead's ruling, kodera-core placeOrder): `can_initialise`
// stays false, and `initialiseWorkspace` refuses, until the organisation has placed an order,
// which carries the accepted CGV and DPA. The order answers with the contract's own example.
// The flags live as long as the page.

import { http, HttpResponse } from 'msw/http'
import { EXAMPLES } from '../generated/examples'
import { problem } from '../problem'
import {
  INITIALISE_PATH,
  WORKSPACE_PATH,
  notInitialisedWorkspace,
  readyWorkspace,
} from '../fixtures/workspaceFixtures'

let ordered = false
let initialised = false
const headers = () => ({ 'X-Request-Id': crypto.randomUUID(), 'Cache-Control': 'no-store' })

export const handlers = [
  http.get('*/api/v1/organisations/:organisation_id/orders', () =>
    HttpResponse.json(
      {
        data: ordered ? [EXAMPLES.listOrders.body.data[0]] : [],
        next_cursor: null,
        has_more: false,
      },
      { headers: headers() }
    )
  ),
  http.post('*/api/v1/organisations/:organisation_id/orders', () => {
    ordered = true
    const example = EXAMPLES.placeOrder
    return HttpResponse.json(example.body as object, {
      status: example.status,
      headers: { ...example.headers },
    })
  }),
  http.get(WORKSPACE_PATH, () =>
    HttpResponse.json(
      initialised
        ? readyWorkspace()
        : notInitialisedWorkspace({ state: 'ready', reason: null }, ordered),
      { headers: headers() }
    )
  ),
  http.post(INITIALISE_PATH, ({ params }) => {
    if (!ordered) return problem('https://kodera.io/problems/invalid-state-transition')
    initialised = true
    return HttpResponse.json(
      { state: 'initialised' },
      {
        status: 201,
        headers: {
          ...headers(),
          Location: `/api/v1/organisations/${String(params['organisation_id'])}/workspace`,
        },
      }
    )
  }),
]
