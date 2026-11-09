// `/claim/{organisation_id}/{slug}`: registered only when the first-owner journey is built in
// (`src/app/routeTree.ts`). Shell-less, outside any organisation: the person is not a member yet.

import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../app/root-route'
import { ClaimScreen } from './ClaimScreen'

export const claimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/claim/$organisationId/$organisationSlug',
  component: function ClaimRoute() {
    const { organisationId, organisationSlug } = claimRoute.useParams()
    return <ClaimScreen organisationId={organisationId} organisationSlug={organisationSlug} />
  },
})
