import { createRoute, lazyRouteComponent } from '@tanstack/react-router'
import { z } from '@/validation-policy'
import { onCommunityHost } from '../../app/communityHost'
import { rootRoute } from '../../app/root-route'

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
  // The sign-in form, its form library and its field components are a chunk of their own: a
  // signed-in visit, an invitation or a callback never draws them. The router fetches the
  // chunk while it resolves `/login`, so no fallback is painted in between.
  component: lazyRouteComponent(() => import('./LoginRoute'), 'LoginRoute'),
})
