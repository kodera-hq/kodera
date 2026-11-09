import { createRoute } from '@tanstack/react-router'
import { orgRoute } from '../../app/org-route'
import { StatusScreen } from './StatusScreen'

// `/{org}/status` — "Applications" in the sidebar. Full screen: 02-status.md.
export const statusRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'status',
  component: StatusScreen,
})
