// The one QueryClient the running application uses — route loaders
// (`src/app/org-route.ts`) and `AppProviders` both read this SAME instance,
// so a loader's `ensureQueryData` populates exactly the cache the rendered
// tree reads from. Tests pass their own client to `AppProviders` instead of
// this singleton, so they never share state with each other or with this one.

import { createQueryClient } from './providers'

export const queryClient = createQueryClient()
