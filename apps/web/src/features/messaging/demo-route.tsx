// `/__demo-messaging` — dynamically imported by `src/app/routeTree.ts` only
// when its literal `VITE_ENABLE_MSW` / `VITE_AUTH_MODE` condition is true,
// which is also what keeps this module (and `./MessagingDemoSurface` and
// `./demo-fixture` beneath it) out of a production bundle entirely, not just
// out of the route table (`scripts/check-production-bundle.sh`). Kept in its
// own module, like `src/app/mock-idp-route.tsx`, so that gate is the only
// thing deciding whether this file is ever reached — the surface itself does
// not know.
//
// The `__` prefix is the same convention the mock identity provider's route
// uses: a path no customer-facing area will ever claim, and one distinctive
// enough to grep the emitted JavaScript for.
//
// Outside the `/$org` layout on purpose. This is a preview of an application
// kodera.io *integrates* — Tchap, from La Suite — not a console area, so
// it borrows neither the sidebar nor the organisation guard. Putting it on
// the shell's module rail is follow-up work, deliberately left out of this
// change because the rail is being written in parallel.

import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../app/root-route'
import { MessagingDemoSurface } from './MessagingDemoSurface'

export const messagingDemoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/__demo-messaging',
  component: MessagingDemoSurface,
})
