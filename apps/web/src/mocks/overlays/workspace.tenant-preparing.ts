// docs/specs/11-workspace.md §7 (quick-workspace SPEC W2): the workspace exists, every room is
// `pending`, and the organisation's tenant is `ordered` — created in one step, its homeserver not
// prepared yet.

import { http, HttpResponse } from 'msw'
import { EXAMPLES } from '../generated/examples'
import { WORKSPACE_PATH, readyWorkspace } from '../fixtures/workspaceFixtures'

const headers = () => ({ 'X-Request-Id': crypto.randomUUID(), 'Cache-Control': 'no-store' })

function pendingWorkspace() {
  const workspace = readyWorkspace()
  for (const category of workspace.categories)
    for (const channel of category.channels) channel.room_state = 'pending'
  for (const channel of workspace.uncategorised_channels) channel.room_state = 'pending'
  return workspace
}

function orderedTenants() {
  const page = structuredClone(EXAMPLES.listTenants.body as { data: { status: string }[] })
  for (const tenant of page.data) tenant.status = 'ordered'
  return page
}

export const handlers = [
  http.get(WORKSPACE_PATH, () => HttpResponse.json(pendingWorkspace(), { headers: headers() })),
  http.get('*/api/v1/organisations/:organisation_id/tenants', () =>
    HttpResponse.json(orderedTenants(), { headers: headers() })
  ),
]
