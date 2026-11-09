// docs/specs/11-workspace.md §7: `getWorkspace` answers the starter workspace, `initialised` —
// the contract's example, named so a spec that means "the workspace exists" does not lean on the
// generated base answer staying that shape.

import { http, HttpResponse } from 'msw'
import { WORKSPACE_PATH, readyWorkspace } from '../fixtures/workspaceFixtures'

export const handlers = [
  http.get(WORKSPACE_PATH, () =>
    HttpResponse.json(readyWorkspace(), {
      headers: { 'X-Request-Id': crypto.randomUUID(), 'Cache-Control': 'no-store' },
    })
  ),
]
