import { announcedTitleKey, contentTitleKey } from './contentTitle'
// The `/$org` layout route: the auth guard, the slug → organisation
// resolution `GET /me` does once (ADR-0005 consequence — the browser URL
// keeps the slug, never the id), and the sidebar shell every area route
// renders inside. Every `src/features/<area>/routes.ts` attaches here rather
// than to `rootRoute` directly.

import {
  Navigate,
  Outlet,
  createRoute,
  notFound,
  redirect,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { trackOrganisationSwitched } from './analytics'
import type { components } from '../api/schema'
import { useAuth, useAuthLifetime } from '../auth/AuthProvider'
import { EspaceDraftProvider } from '../features/espace/EspaceDraftProvider'
import { cachedTenantSlug } from '../features/workspace/queries'
import type { AuthIdentity } from '../auth/AuthAdapter'
import { authAdapter } from '../auth/oidc'
import { rememberReturnTo } from '../auth/return-to'
import { beforeSignIn } from '../auth/beforeSignIn'
import { isOrderStepChange } from '../features/order/stepChange'
import { isMfaEnrolledLocally } from '../features/security/mfaState'
import { isCurrentIdentityMfaEnrolled } from './currentIdentity'
import { demoOrganisationMark } from './demoBranding'
import { NotFoundOrganisation } from './NotFoundOrganisation'
import { clearReauthenticationFromError } from './reauthenticationMarker'
import { RouteError } from './RouteError'
import { RouteFocus } from './RouteFocus'
import { loadCurrentUser } from './currentUser'
import { isPublicCommunityMember, sessionCoversOrganisation } from './communityAccess'
import { SessionLoading } from './SessionLoading'
import { rootRoute } from './root-route'
import { surfaceOf } from './railModules'
import { SessionExpiryDialog } from './SessionExpiryDialog'
import { Shell } from './Shell'

type Me = components['schemas']['Me']
type Membership = Me['organisations'][number]

function holdExpiredRoute(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException('Route reload superseded.', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

let expiredNavigation:
  | {
      readonly org: string
      readonly href: string
      readonly generation: number
      readonly credentialGeneration: number
    }
  | undefined

export const orgRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$org',
  pendingComponent: SessionLoading,
  pendingMs: 0,
  pendingMinMs: 0,
  // Runs before the loader, so an unauthenticated visit never issues the
  // `/me` request at all. A deep link already names the organisation, so it
  // goes straight to sign-in for that realm rather than through the generic
  // `/login` screen (§3 reserves that one for a direct visit to `/`, which
  // has no organisation to discover a realm from yet) — the realm-discovery
  // step this simplifies past (mapping a slug to its Keycloak realm via
  // `POST /auth/discover`) is Wave 1 work; treating the URL segment as the
  // realm is this unit's stand-in, true for every scenario the shell ships
  // with today.
  beforeLoad: async ({ params, location, matches, routeId, cause }) => {
    const session = authAdapter.getSnapshot()
    const retained = matches.some(
      (match) => match.routeId === routeId && match.status === 'success'
    )
    const retainedBranch = matches.every((match) => match.cause === 'stay')
    const navigation = expiredNavigation
    expiredNavigation = undefined
    const resumingExpiredNavigation =
      navigation !== undefined &&
      navigation.org === params.org &&
      navigation.href === location.href &&
      navigation.generation === session.generation &&
      navigation.credentialGeneration === session.credentialGeneration
    // Only a wholly retained successful branch proves that the same mounted
    // screen still owns the expiry dialog. A cached match can re-enter after
    // navigating away, and Browser Back can retain this parent while entering
    // another leaf; neither may park without a reconnect path.
    if (
      cause === 'stay' &&
      retained &&
      retainedBranch &&
      !resumingExpiredNavigation &&
      session.status === 'ready' &&
      sessionCoversOrganisation(session.user?.realm, params.org) &&
      authAdapter.getAccessToken() === undefined
    )
      return { holdExpiredRoute: true }
    // A Browser Back/Forward transition keeps this parent match (`stay`) but
    // enters a different leaf. Save while the old screen is still mounted,
    // then let the ordinary guard reauthenticate for the target location.
    // Cold entries and cached re-entries use `enter` for this parent and have
    // no mounted form authority to save.
    if (
      cause === 'stay' &&
      retained &&
      !resumingExpiredNavigation &&
      session.status === 'ready' &&
      sessionCoversOrganisation(session.user?.realm, params.org) &&
      authAdapter.getAccessToken() === undefined
    )
      beforeSignIn()
    // Tenant organisations require their own issuer. The shared community is the
    // narrow exception: Core verifies its persisted membership in the loader.
    const restored = await authAdapter.restoreSession()
    const needsSignIn =
      !restored ||
      authAdapter.getAccessToken() === undefined ||
      !sessionCoversOrganisation(authAdapter.getUser()?.realm, params.org)
    if (needsSignIn) {
      if (params.org === 'community' && import.meta.env.VITE_AUTH_MODE === 'oidc') {
        rememberReturnTo(location.href)
        throw redirect({ to: '/login', search: { org: 'community' } })
      }
      rememberReturnTo(location.href)
      // Awaited so the loader below never runs in the gap: `signIn` resolves
      // once the browser navigation to the identity provider has been
      // initiated, not once it has finished — nothing after that point in
      // this script matters, since the page is on its way out.
      await authAdapter.signIn(params.org)
    }
    return { holdExpiredRoute: false }
  },
  loader: async ({
    params,
    context,
    abortController,
  }): Promise<{
    me: Me
    membership: Membership
    meGeneration: number
    meCredentialGeneration: number
  }> => {
    // An invalidation can race the expiry/refusal notification. Keep the
    // already-mounted layout and its modal/draft boundary instead of letting
    // the real current-user loader turn the expected missing credential into
    // a route error. A later usable credential makes OrgLayout invalidate
    // again; that replacement load is the only one allowed to issue `/me`.
    if (context.holdExpiredRoute) await holdExpiredRoute(abortController.signal)
    const {
      me,
      generation: meGeneration,
      credentialGeneration: meCredentialGeneration,
    } = await loadCurrentUser()
    const current = authAdapter.getSnapshot()
    if (
      current.status !== 'ready' ||
      current.generation !== meGeneration ||
      current.credentialGeneration !== meCredentialGeneration ||
      authAdapter.getAccessToken() === undefined
    )
      throw new DOMException('Session ended.', 'AbortError')
    // The session works: a later 401 is a new expiry, not a failed return
    // from the error screen's sign-in round trip.
    clearReauthenticationFromError()
    const membership = me.organisations.find((entry) => entry.organisation.slug === params.org)
    // Unknown slug → the not-found screen, not a thrown error (§3): a stale
    // bookmark or a mistyped URL is not the same failure as the Core API
    // being unreachable.
    if (membership === undefined) {
      throw notFound()
    }
    return { me, membership, meGeneration, meCredentialGeneration }
  },
  notFoundComponent: NotFoundOrganisation,
  // `GET /me` failing is a whole-page failure (§5 `shell` Error row): there
  // is no identity to draw the shell with, so the error screen replaces it.
  errorComponent: RouteError,
  component: AuthenticatedOrgLayout,
})

function AuthenticatedOrgLayout() {
  const auth = useAuth()
  if (auth.status === 'pending') return <SessionLoading />
  return auth.isAuthenticated ? <OrgLayout /> : <Navigate to="/login" replace />
}

/** `security/mfa`'s own path, computed rather than hard-coded twice: the
 * guard below and `securityMfaRoute` (`src/features/security/routes.tsx`)
 * must agree on where "already there" means, and a route object is the one
 * place that segment is spelled once. */
function mfaEnrolPath(org: string): string {
  return `/${org}/security/mfa`
}

/** The active Core identity must report enrollment before console navigation.
 * Only the explicit mock/MSW build can also accept local demonstration state. */
function useMfaGuard(
  me: Me,
  identity: AuthIdentity | undefined,
  organisationSlug: string
): boolean {
  return (
    isPublicCommunityMember(me, identity, organisationSlug) ||
    isCurrentIdentityMfaEnrolled(me, identity, organisationSlug) ||
    isMfaEnrolledLocally()
  )
}

function OrgLayout() {
  const { membership, meGeneration, meCredentialGeneration } = orgRoute.useLoaderData()
  const client = useQueryClient()
  const tenantSlugFor = useCallback(
    (organisationId: string) => cachedTenantSlug(client, organisationId),
    [client]
  )
  return (
    <EspaceDraftProvider
      tenantSlugFor={tenantSlugFor}
      org={membership.organisation.slug}
      organisationId={membership.organisation.id}
      meGeneration={meGeneration}
      meCredentialGeneration={meCredentialGeneration}
    >
      <OrgLayoutContent />
    </EspaceDraftProvider>
  )
}

function OrgLayoutContent() {
  const { me, membership, meGeneration, meCredentialGeneration } = orgRoute.useLoaderData()
  const { org } = orgRoute.useParams()
  const { t } = useTranslation()
  const auth = useAuth()
  const lifetime = useAuthLifetime()
  const router = useRouter()
  const invalidatedAuthority = useRef<string | undefined>(undefined)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // The title the content header shows, and the one a route change announces
  // (§10, `RouteFocus`): the same, except in the order flow.
  const titleKey = contentTitleKey(pathname, membership.role)
  const announcedTitle = t(announcedTitleKey(pathname, membership.role))
  const authorityMismatch =
    auth.generation !== meGeneration || auth.credentialGeneration !== meCredentialGeneration
  const hasUsableToken = auth.status === 'ready' && lifetime.hasUsableCredential()
  const mfaEnrolled = useMfaGuard(me, auth.user?.identity, org)
  const onMfaScreen = pathname === mfaEnrolPath(org)

  useEffect(() => {
    const unsubscribe = router.subscribe('onBeforeNavigate', (event) => {
      expiredNavigation = undefined
      if (!event.pathChanged) return
      const orgPath = `/${encodeURIComponent(org)}`
      if (
        event.toLocation.pathname !== orgPath &&
        !event.toLocation.pathname.startsWith(`${orgPath}/`)
      )
        return
      const current = authAdapter.getSnapshot()
      if (
        current.status !== 'ready' ||
        !sessionCoversOrganisation(current.user?.realm, org) ||
        authAdapter.getAccessToken() !== undefined
      )
        return
      // Browser Back/Forward is an explicit navigation, just like the
      // reconnect action: stash the still-mounted screen synchronously and
      // return to the requested target after the full sign-in round trip.
      beforeSignIn()
      rememberReturnTo(event.toLocation.href)
      expiredNavigation = {
        org,
        href: event.toLocation.href,
        generation: current.generation,
        credentialGeneration: current.credentialGeneration,
      }
    })
    return () => {
      expiredNavigation = undefined
      unsubscribe()
    }
  }, [org, router])

  useEffect(() => {
    if (!authorityMismatch && !mfaEnrolled && !onMfaScreen) {
      void router.navigate({ to: '/$org/security/mfa', params: { org } })
    }
  }, [authorityMismatch, mfaEnrolled, onMfaScreen, org, router])

  useEffect(() => {
    if (!authorityMismatch) {
      invalidatedAuthority.current = undefined
      return
    }
    if (!hasUsableToken) return
    const authority = `${meGeneration}:${meCredentialGeneration}->${auth.generation}:${auth.credentialGeneration}`
    if (invalidatedAuthority.current === authority) return
    invalidatedAuthority.current = authority
    void router.invalidate()
  }, [
    auth.credentialGeneration,
    auth.generation,
    authorityMismatch,
    hasUsableToken,
    meCredentialGeneration,
    meGeneration,
    router,
  ])

  // §4.6: "the console keeps the destination area (`/other-org/status` if
  // the user was on `/acme-sa/status`, else `/other-org/home`)" — the segment
  // right after the slug, or `home` for the bare `/{org}` path a switch
  // should never actually land on but a safe fallback all the same.
  function switchOrganisation(slug: string) {
    trackOrganisationSwitched(me.organisations.length)
    const area = slug === 'community' ? 'workspace' : (pathname.split('/')[2] ?? 'home')
    void router.navigate({ href: `/${slug}/${area}` })
  }

  // `SessionExpiryDialog` (§4.7) is mounted regardless of the branch below:
  // a session can expire whether or not a factor is enrolled yet, and the
  // guide renders no `Shell` for the dialog to otherwise live inside of.
  // `RouteFocus` (§10) likewise, and with the same key in both branches, so it
  // is one component across them: leaving the guide for the shell is a route
  // change like any other. It is told when no page is drawn because the guard
  // above is redirecting: the guide is then where the person arrives, not a
  // page they navigated to.
  if (!mfaEnrolled) {
    // No `Shell`: the wireframe carries no sidebar, and a person "cannot
    // navigate away until a factor is enrolled" is simplest to guarantee by
    // giving them nothing to navigate away WITH. Renders nothing for the one
    // tick before the redirect above commits, rather than the wrong area's
    // content flashing first.
    //
    // The page's one `main`, its full height and its gutter are drawn here,
    // not by the guide: an enrolled person can still open the guide's URL,
    // inside `Shell`, whose `main` already holds it — a guide with its own
    // `main` put one landmark inside the other there, and its own
    // `min-h-screen` added a screen of empty scroll under the shell's bars.
    return (
      <>
        {authorityMismatch ? <SessionExpiryDialog /> : null}
        <div
          className={authorityMismatch ? undefined : 'contents'}
          hidden={authorityMismatch}
          aria-hidden={authorityMismatch || undefined}
        >
          {authorityMismatch ? null : <SessionExpiryDialog />}
          <main className="flex min-h-screen min-w-0 flex-col overflow-x-auto p-6 narrow:p-4">
            {onMfaScreen ? <Outlet /> : null}
          </main>
          <RouteFocus
            key="route-focus"
            title={announcedTitle}
            announcedByScreen={isOrderStepChange}
            redirecting={!onMfaScreen}
          />
        </div>
        {authorityMismatch && hasUsableToken ? <SessionLoading /> : null}
      </>
    )
  }

  const memberships = me.organisations.map((entry) => ({
    slug: entry.organisation.slug,
    name: entry.organisation.name,
    current: entry.organisation.slug === org,
  }))

  // `undefined` in every build a customer loads: no field of the Core
  // contract carries an organisation's branding, and only the demo seed ever
  // fills this registry (`src/app/demoBranding.ts`). Read here rather than
  // inside the sidebar so the one place the console pretends to know a
  // tenant's mark is the one place that already resolves the tenant.
  const organisationMark = demoOrganisationMark(membership.organisation.slug)

  // Keep the subtree mounted so an explicit reauthentication can restore a
  // draft, but remove every protected surface from rendering and the
  // accessibility tree as soon as its loader authority becomes stale.
  return (
    <>
      {authorityMismatch ? <SessionExpiryDialog /> : null}
      <div
        className={authorityMismatch ? undefined : 'contents'}
        hidden={authorityMismatch}
        aria-hidden={authorityMismatch || undefined}
      >
        <Shell
          sessionExpiry={authorityMismatch ? undefined : <SessionExpiryDialog />}
          org={org}
          organisationId={membership.organisation.id}
          organisation={{ name: membership.organisation.name, slug: membership.organisation.slug }}
          {...(organisationMark === undefined ? {} : { organisationMark })}
          memberships={memberships}
          onSwitchOrganisation={switchOrganisation}
          role={membership.role}
          contentTitleKey={titleKey}
          surface={surfaceOf(pathname)}
          user={{
            displayName: me.display_name ?? me.email,
            // The catalogue only names two roles in the customer's own words
            // (console.shell.account.status-role-*): owner and admin both read
            // as "Administratrice / Administrateur" — the distinction between
            // them is a billing/ownership concern, not one this menu shows.
            role:
              membership.role === 'org_owner' || membership.role === 'org_admin'
                ? 'org_admin'
                : 'member',
          }}
          onSignOut={() => void auth.signOut().catch(() => {})}
          onOpenAccountPlace={(to) => void router.navigate({ to, params: { org } })}
        >
          <Outlet />
        </Shell>
        <RouteFocus
          key="route-focus"
          title={announcedTitle}
          announcedByScreen={isOrderStepChange}
        />
      </div>
      {authorityMismatch && hasUsableToken ? <SessionLoading /> : null}
    </>
  )
}
