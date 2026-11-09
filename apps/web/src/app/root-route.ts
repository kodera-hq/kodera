// The root of the route tree, in its own module rather than in
// `src/app/routeTree.ts`: every area's `routes.ts` needs a parent to attach
// to, and importing it from the file that also imports every area would be
// circular. `src/app/org-route.ts` is the same move for the `/$org` layout,
// which is what every area route actually parents onto.

import { createRootRoute } from '@tanstack/react-router'
import { RouteError } from './RouteError'

// A failure no route below catches lands here: the console's own French
// screen (`./RouteError.tsx`), never the router's English default.
export const rootRoute = createRootRoute({ errorComponent: RouteError })
