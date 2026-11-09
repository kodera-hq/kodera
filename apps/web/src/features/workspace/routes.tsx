import { createRoute } from '@tanstack/react-router'
import { orgRoute } from '../../app/org-route'
import { WorkspaceScreen } from './WorkspaceScreen'

// `/{org}/workspace` — the organisation's workspace (docs/specs/11-workspace.md). Every
// organisation role reads it, so no role gate; Core filters what each one sees. It is a rail
// surface of its own, « Espace », not a console area: the rail offers it (`src/app/railModules.ts`)
// and no console navigation does. `Shell` draws it in the
// workspace's layout (`surfaceOf`); on a phone that layout has no tab bar, and the top bar leads
// back to the console instead.
//
// The screen belongs to the parent route and the two children draw nothing: choosing a channel
// changes the address without unmounting the screen.
export const workspaceRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'workspace',
  component: WorkspaceScreen,
})

/** `/{org}/workspace`: the first channel the caller may see. */
export const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
})

/** `/{org}/workspace/{channelId}`: one channel, linkable. */
export const workspaceChannelRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '$channelId',
})
