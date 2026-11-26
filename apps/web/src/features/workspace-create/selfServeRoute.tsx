import { createRoute, redirect } from '@tanstack/react-router'
import { ApiProblem } from '../../api/client'
import { onCommunityHost } from '../../app/communityHost'
import { loadCurrentUser } from '../../app/currentUser'
import { SessionLoading } from '../../app/SessionLoading'
import { rootRoute } from '../../app/root-route'
import { authAdapter } from '../../auth/oidc'
import { rememberReturnTo } from '../../auth/return-to'
import { SelfServeCreateWorkspace } from './CreateWorkspace'
import type { SelfServePlanChoice } from './CreateWorkspace'

export const selfServeWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/new',
  pendingComponent: SessionLoading,
  validateSearch: (search: Record<string, unknown>): { plan?: 'sovereign' } =>
    search['plan'] === 'sovereign' ? { plan: 'sovereign' } : {},
  beforeLoad: async ({ location }) => {
    if (onCommunityHost()) {
      throw redirect({ to: '/$org/workspace', params: { org: 'community' } })
    }
    const restored = await authAdapter.restoreSession()
    if (!restored || authAdapter.getAccessToken() === undefined) {
      rememberReturnTo(location.href)
      if (import.meta.env.VITE_AUTH_MODE === 'oidc') {
        throw redirect({ to: '/login', search: { org: 'community' } })
      }
      throw redirect({ to: '/login' })
    }
  },
  loader: async () => {
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
