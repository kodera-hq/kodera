// `/invitations/accept/{organisation_id}/{slug}`, in every build (docs/specs/12-invitation-accept.md).
// Shell-less, outside any organisation: the person is not a member yet.

import { createRoute, lazyRouteComponent } from '@tanstack/react-router'
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

// `/join#code`: a workspace invite link (docs/specs/messaging-media-and-notifications.md). The
// screen is its own chunk: most visits never open an invite link.
export const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/join',
  component: lazyRouteComponent(() => import('./JoinScreen')),
})
