// docs/specs/11-workspace.md §7: `getWorkspace` answers `500 internal-error`, so the page draws
// its error state with a retry.

import { http } from 'msw/http'
import { problem } from '../problem'
import { WORKSPACE_PATH } from '../fixtures/workspaceFixtures'

export const handlers = [
  http.get(WORKSPACE_PATH, () => problem('https://kodera.io/problems/internal-error')),
]
