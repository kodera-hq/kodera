// `/invitations/accept/{organisation_id}/{slug}`, in every build (docs/specs/12-invitation-accept.md).
// Shell-less, outside any organisation: the person is not a member yet.

import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../app/root-route'
import { AcceptScreen } from './AcceptScreen'

export const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invitations/accept/$organisationId/$organisationSlug',
  component: function InvitationRoute() {
    const { organisationId, organisationSlug } = invitationRoute.useParams()
    return <AcceptScreen organisationId={organisationId} organisationSlug={organisationSlug} />
  },
})
