import { createRoute } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { z } from '@/validation-policy'
import { onCommunityHost } from '../../app/communityHost'
import { rootRoute } from '../../app/root-route'
import { SessionLoading } from '../../app/SessionLoading'
import { LoginScreen } from './LoginScreen'

// The Community welcome has no callback tokens or entry state to capture. Fetch
// its presentation only when this login destination is opened.
const CommunityWelcome = lazy(() =>
  import('./CommunityWelcome').then(({ CommunityWelcome }) => ({ default: CommunityWelcome }))
)

// `/login` and `/login?org={slug}` (docs/specs/00-shell-and-login.md §3):
// realm discovery, top-level rather than under `/{org}` — there is no
// organisation yet at this point in the flow. `org` pre-fills the
// organisation-identifier fallback for a link sent from the welcome email or
// the hub's "Se connecter"; zod-validated so a malformed query string is a
// typed absence rather than a value the screen has to sniff (ADR-0005).
export const loginSearchSchema = z.object({
  org: z.string().optional(),
  mode: z.enum(['tenant']).optional().catch(undefined),
})

export function shouldRenderCommunityWelcome(
  org: string | undefined,
  mode: 'tenant' | undefined,
  hostname?: string
): boolean {
  return (
    org === 'community' || (org === undefined && mode !== 'tenant' && onCommunityHost(hostname))
  )
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: loginSearchSchema,
  component: LoginRoute,
})

function LoginRoute() {
  const { org, mode } = loginRoute.useSearch()
  if (import.meta.env.VITE_AUTH_MODE === 'oidc' && shouldRenderCommunityWelcome(org, mode)) {
    return (
      <Suspense fallback={<SessionLoading />}>
        <CommunityWelcome />
      </Suspense>
    )
  }
  return <LoginScreen {...(org === undefined ? {} : { initialSlug: org })} />
}
