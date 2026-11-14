// docs/specs/11-workspace.md §7: `setup` `failed` / `realm_job_failed`: an operator acts, the
// console offers no retry.

import { http, HttpResponse } from 'msw/http'
import { WORKSPACE_PATH, notInitialisedWorkspace } from '../fixtures/workspaceFixtures'

export const handlers = [
  http.get(WORKSPACE_PATH, () =>
    HttpResponse.json(
      notInitialisedWorkspace({ state: 'failed', reason: 'realm_job_failed' }, false),
      {
        headers: {
          'X-Request-Id': '019467a3-0f9b-7cc3-98c2-1fa48f28f562',
          'Cache-Control': 'no-store',
        },
      }
    )
  ),
]
