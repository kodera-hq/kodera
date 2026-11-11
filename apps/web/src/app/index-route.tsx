// `/` — docs/specs/00-shell-and-login.md §3: redirects to `/login` when
// there is no session, else to the first organisation `/me` lists: its Home,
// or Espace (the workspace) for a member of an organisation that runs it or has no tenant yet
// (`landingIn`). No screen of its own: this route only
// ever redirects.

import { createRoute, redirect } from '@tanstack/react-router'
import { authAdapter } from '../auth/oidc'
import { loadCurrentUser } from './currentUser'
import { demoLandingFor, isDemoActive } from './interactiveDemo'
import { landingIn } from './organisationLanding'
import { SessionLoading } from './SessionLoading'
import { rootRoute } from './root-route'

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  pendingComponent: SessionLoading,
  pendingMs: 0,
  pendingMinMs: 0,
  beforeLoad: async () => {
    if (!(await authAdapter.restoreSession())) {
      if (isDemoActive('community'))
        throw redirect({ to: '/$org/workspace', params: { org: 'community' } })
      if (
        import.meta.env.VITE_AUTH_MODE === 'oidc' &&
        window.location.hostname === 'community.kodera.io'
      )
        throw redirect({ to: '/login', search: { org: 'community' } })
      throw redirect({ to: '/login' })
    }
    const { me, generation, credentialGeneration } = await loadCurrentUser()
    const current = authAdapter.getSnapshot()
    if (
      current.status !== 'ready' ||
      current.generation !== generation ||
      current.credentialGeneration !== credentialGeneration ||
      authAdapter.getAccessToken() === undefined
    )
      throw new DOMException('Credential authority ended.', 'AbortError')
    const demoRealm =
      current.user?.realm && isDemoActive(current.user.realm) ? current.user.realm : 'community'
    const communityHost =
      import.meta.env.VITE_AUTH_MODE === 'oidc' &&
      window.location.hostname === 'community.kodera.io'
    const first =
      (communityHost
        ? me.organisations.find(({ organisation }) => organisation.slug === 'community')
        : undefined) ??
      (isDemoActive(demoRealm)
        ? me.organisations.find(({ organisation }) => organisation.slug === demoRealm)
        : undefined) ??
      me.organisations[0]
    if (first === undefined) {
      throw redirect({ to: '/login' })
    }
    const to =
      demoLandingFor(first.organisation.slug) ??
      (await landingIn(first.organisation.id, first.role))
    throw redirect({ to, params: { org: first.organisation.slug } })
  },
})
