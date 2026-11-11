import { createRoute } from '@tanstack/react-router'
import { z } from '@/validation-policy'
import { rootRoute } from '../../app/root-route'
import { CommunityWelcome } from './CommunityWelcome'
import { LoginScreen } from './LoginScreen'

// `/login` and `/login?org={slug}` (docs/specs/00-shell-and-login.md §3):
// realm discovery, top-level rather than under `/{org}` — there is no
// organisation yet at this point in the flow. `org` pre-fills the
// organisation-identifier fallback for a link sent from the welcome email or
// the hub's "Se connecter"; zod-validated so a malformed query string is a
// typed absence rather than a value the screen has to sniff (ADR-0005).
const loginSearchSchema = z.object({
  org: z.string().optional(),
})

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: loginSearchSchema,
  component: LoginRoute,
})

function LoginRoute() {
  const { org } = loginRoute.useSearch()
  if (org === 'community' && import.meta.env.VITE_AUTH_MODE === 'oidc') return <CommunityWelcome />
  return <LoginScreen {...(org === undefined ? {} : { initialSlug: org })} />
}
