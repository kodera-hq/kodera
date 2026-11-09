// The workspace answers the scenario overlays and the unit tests share
// (docs/specs/11-workspace.md §7). Built from the contract's own `getWorkspace` example, so a pin
// bump that changes the starter workspace changes these with it.

import type { components } from '@/api/schema'
import { EXAMPLES } from '../generated/examples'

type Workspace = components['schemas']['Workspace']
type WorkspaceSetup = components['schemas']['WorkspaceSetup']

/** The starter workspace, `initialised`: the contract's example. */
export function readyWorkspace(): Workspace {
  return structuredClone(EXAMPLES.getWorkspace.body as Workspace)
}

/** The same organisation before `initialiseWorkspace`: no id, no rows, and `setup` as given. */
export function notInitialisedWorkspace(setup: WorkspaceSetup, canInitialise = false): Workspace {
  return {
    ...readyWorkspace(),
    state: 'not_initialised',
    setup,
    can_initialise: canInitialise,
    id: null,
    categories: [],
    uncategorised_channels: [],
  }
}

export const WORKSPACE_PATH = '*/api/v1/organisations/:organisation_id/workspace'
export const INITIALISE_PATH =
  '*/api/v1/organisations/:organisation_id/workspace/actions/initialise'
