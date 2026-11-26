import { createRoute, redirect } from '@tanstack/react-router'
import { ApiProblem } from '../../api/client'
import { onCommunityHost, workspaceAppOrigin } from '../../app/communityHost'
import { loadCurrentUser } from '../../app/currentUser'
import { SessionLoading } from '../../app/SessionLoading'
import { rootRoute } from '../../app/root-route'
import { authAdapter } from '../../auth/oidc'
import { rememberReturnTo } from '../../auth/return-to'
import { Handoff } from '../login/Handoff'
import { SelfServeCreateWorkspace } from './CreateWorkspace'
import type { SelfServePlanChoice } from './CreateWorkspace'

export const selfServeWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/new',
  pendingComponent: SessionLoading,
  validateSearch: (
    search: Record<string, unknown>
  ): { plan?: 'sovereign'; signIn?: 'community' } => ({
    ...(search['plan'] === 'sovereign' ? { plan: 'sovereign' } : {}),
    ...(search['signIn'] === 'community' ? { signIn: 'community' } : {}),
  }),
  beforeLoad: async ({ location, preload, search }) => {
    if (onCommunityHost()) {
      throw redirect({ to: '/$org/workspace', params: { org: 'community' } })
    }
    const restored = await authAdapter.restoreSession()
    if (search.signIn === 'community' && window.location.origin === workspaceAppOrigin()) {
      if (restored && authAdapter.getUser()?.realm === 'community') {
        throw redirect({
          to: '/workspaces/new',
          search: search.plan ? { plan: search.plan } : {},
          replace: true,
        })
      }
      // Only the app owns this PKCE transaction. Return to the form without replaying the handoff.
      if (!preload) rememberReturnTo('/workspaces/new')
      return { communityHandoff: true }
    }
    if (!restored || authAdapter.getAccessToken() === undefined) {
      rememberReturnTo(location.href)
      if (import.meta.env.VITE_AUTH_MODE === 'oidc') {
        throw redirect({ to: '/login', search: { org: 'community' } })
      }
      throw redirect({ to: '/login' })
    }
    return { communityHandoff: false }
  },
  loader: async ({ context }) => {
    if (context.communityHandoff) return { existingSovereignOrgSlug: undefined }
    try {
      const { me } = await loadCurrentUser()
      const ownedOrg = me.organisations.find(
        (entry) =>
          entry.organisation.slug !== 'community' &&
          entry.role === 'org_owner' &&
          entry.state === 'active'
      )
      return { existingSovereignOrgSlug: ownedOrg?.organisation.slug }
    } catch (error) {
      // A newly registered Community identity may not have a Core membership yet.
      // Every other refusal or transport failure belongs to the route error boundary.
      if (
        !(error instanceof ApiProblem) ||
        error.status !== 403 ||
        error.type !== 'https://kodera.io/problems/identity-unknown'
      )
        throw error
      return { existingSovereignOrgSlug: undefined }
    }
  },
  component: SelfServeWorkspaceScreen,
})

function SelfServeWorkspaceScreen() {
  const search = selfServeWorkspaceRoute.useSearch()
  const { existingSovereignOrgSlug } = selfServeWorkspaceRoute.useLoaderData()
  const { communityHandoff } = selfServeWorkspaceRoute.useRouteContext()
  if (communityHandoff) return <Handoff realm="community" organisationName="Kodera Community" />
  const initialPlan: SelfServePlanChoice = search.plan === 'sovereign' ? 'sovereign' : 'freemium'
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-shell-document-max-width flex-col justify-center px-6 py-12">
      <SelfServeCreateWorkspace
        initialPlan={initialPlan}
        existingSovereignOrgSlug={existingSovereignOrgSlug}
      />
    </main>
  )
}
