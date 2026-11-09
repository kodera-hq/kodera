import { createRoute, redirect } from '@tanstack/react-router'
import { orgRoute } from '../../app/org-route'
import { HelpScreen } from './HelpScreen'
import { helpSearchSchema } from './helpTopic'

// `/{org}/help` — "Aide" in the sidebar; the area folder is named `support`
// after its spec (06-support.md), the route after the word a customer reads.
// Every support action in the console lands here, with the context it
// already carried in the query string (`./helpTopic.ts`).
export const supportRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'help',
  validateSearch: helpSearchSchema,
  component: function SupportRouteComponent() {
    return <HelpScreen search={supportRoute.useSearch()} />
  },
})

/** Preserve the externally shared support URL while keeping the existing Help destination. */
export const supportAliasRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'support',
  validateSearch: helpSearchSchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/$org/help', params: { org: params.org }, search })
  },
})
