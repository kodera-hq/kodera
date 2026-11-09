import { createRoute } from '@tanstack/react-router'
import { AreaStub } from '../../app/AreaStub'
import { orgRoute } from '../../app/org-route'
import { RequireRole } from '../../app/RequireRole'

// `/{org}/federation` — "Federation is a tab, not a navigation item" (§4.5):
// the delivered design resolves this deep link to
// `/{org}/domain?tab=federation`. That redirect is the domain screen's own
// behaviour and belongs to the unit that builds it; this stub keeps the
// route reachable and visibly itself until then. Full spec: 07-federation.md.
export const federationRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'federation',
  component: () => (
    <RequireRole allow={['org_owner', 'org_admin']} titleKey="console.federation.overview.title">
      <AreaStub titleKey="console.federation.overview.title" />
    </RequireRole>
  ),
})
