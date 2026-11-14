// docs/specs/11-workspace.md §7: `setup` `pending`, no reason: the realm job is queued.

import { http, HttpResponse } from 'msw/http'
import { WORKSPACE_PATH, notInitialisedWorkspace } from '../fixtures/workspaceFixtures'

export const handlers = [
  http.get(WORKSPACE_PATH, () =>
    HttpResponse.json(notInitialisedWorkspace({ state: 'pending', reason: null }, false), {
      headers: {
        'X-Request-Id': '019467a3-0f9b-7cc3-98c2-1fa48f28f562',
        'Cache-Control': 'no-store',
      },
    })
  ),
]
