// `/__mock-idp/authorize` — dynamically imported by `routeTree.ts` only when
// its literal `VITE_ENABLE_MSW` / `VITE_AUTH_MODE` condition is true, which
// is also what keeps this module (and `../auth/mock-idp` beneath it) out of
// a production bundle entirely, not just out of the route table
// (`scripts/check-production-bundle.sh`). Kept in its own module so that
// gate is the only thing deciding whether this file is ever reached — the
// component itself doesn't know.

import { createRoute } from '@tanstack/react-router'
import { MockIdpAuthorizePage } from '../auth/mock-idp'
import { rootRoute } from './root-route'

export const mockIdpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/__mock-idp/authorize',
  component: MockIdpAuthorizePage,
})
