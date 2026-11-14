// docs/specs/11-workspace.md §7: `setup` `ready`, `not_initialised`, `can_initialise` true — an
// owner or an administrator may create the workspace. `initialiseWorkspace` answers `201` with
// `Location` and `{"state": "initialised"}` only, and every read after it is the starter
// workspace. The flag lives as long as the page: a reload starts again from `not_initialised`.

import { http, HttpResponse } from 'msw/http'
import {
  INITIALISE_PATH,
  WORKSPACE_PATH,
  notInitialisedWorkspace,
  readyWorkspace,
} from '../fixtures/workspaceFixtures'

let initialised = false

export const handlers = [
  http.get(WORKSPACE_PATH, () =>
    HttpResponse.json(
      initialised
        ? readyWorkspace()
        : notInitialisedWorkspace({ state: 'ready', reason: null }, true),
      { headers: { 'X-Request-Id': crypto.randomUUID(), 'Cache-Control': 'no-store' } }
    )
  ),
  http.post(INITIALISE_PATH, ({ params }) => {
    const created = !initialised
    initialised = true
    return HttpResponse.json(
      { state: 'initialised' },
      {
        status: created ? 201 : 200,
        headers: {
          'X-Request-Id': crypto.randomUUID(),
          Location: `/api/v1/organisations/${String(params['organisation_id'])}/workspace`,
        },
      }
    )
  }),
]
