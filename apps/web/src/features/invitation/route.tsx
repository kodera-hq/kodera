// `/invitations/accept/{organisation_id}/{slug}`, in every build (docs/specs/12-invitation-accept.md).
// Shell-less, outside any organisation: the person is not a member yet.

import { createRoute, lazyRouteComponent } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { rootRoute } from '../../app/root-route'
import { SessionLoading } from '../../app/SessionLoading'
import { forgetInvitationEntryIfHeld, readInvitationEntry } from './entry'

const LazyInvitationRoute = lazy(() => import('./InvitationRoute'))

export const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invitations/accept/$organisationId/$organisationSlug',
  // Acceptance has its own protected sign-in and mutation flow. Fetch it only when an
  // invitation is opened, as with workspace invite links below.
  component: InvitationEntryRoute,
})

function InvitationEntryRoute() {
  const { organisationId, organisationSlug } = invitationRoute.useParams()
  const opened = useRef(readInvitationEntry(organisationId, organisationSlug))
  const mounted = useRef(false)
  // This owner commits even while the screen's import is pending. Leaving that wait or
  // entering the back-forward cache must retire the secret before the screen can mount.
  useEffect(() => {
    mounted.current = true
    const entry = opened.current
    const forget = () => {
      if (entry !== undefined) forgetInvitationEntryIfHeld(entry)
    }
    window.addEventListener('pagehide', forget)
    return () => {
      mounted.current = false
      window.removeEventListener('pagehide', forget)
      window.setTimeout(() => {
        if (!mounted.current) forget()
      }, 0)
    }
  }, [])
  return (
    <Suspense fallback={<SessionLoading />}>
      <LazyInvitationRoute />
    </Suspense>
  )
}

// `/join#code`: a workspace invite link (docs/specs/messaging-media-and-notifications.md). The
// screen is its own chunk: most visits never open an invite link.
export const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/join',
  component: lazyRouteComponent(() => import('./JoinScreen')),
})
