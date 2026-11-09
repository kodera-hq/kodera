// docs/specs/11-workspace.md §7: `setup` `pending` / `awaiting_owner_confirmation`: the claim is
// consumed and the owner's contact is not yet confirmed.

import { http, HttpResponse } from 'msw'
import { WORKSPACE_PATH, notInitialisedWorkspace } from '../fixtures/workspaceFixtures'

export const handlers = [
  http.get(WORKSPACE_PATH, () =>
    HttpResponse.json(
      notInitialisedWorkspace({ state: 'pending', reason: 'awaiting_owner_confirmation' }, false),
      {
        headers: {
          'X-Request-Id': '019467a3-0f9b-7cc3-98c2-1fa48f28f562',
          'Cache-Control': 'no-store',
        },
      }
    )
  ),
]
