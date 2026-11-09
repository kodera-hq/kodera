// The entry point. Boot order matters: i18n before anything renders (a
// missing key throws outside production — src/i18n/index.ts), then
// MSW before the router's first request (docs/dev/TESTING.md) — and only when
// `VITE_ENABLE_MSW === '1'`, behind a dynamic `import()` so the worker code
// never ships in a build that never boots it.
//
// That condition is written as a literal `import.meta.env.VITE_ENABLE_MSW`
// comparison, not `config.mswEnabled()`: Vite's env-replace plugin inlines
// the build-time value only where the expression appears textually, so a
// production build turns the `if` below into a compile-time-false condition
// the minifier removes together with the `import()` it guards — which is
// what keeps `src/mocks/browser.ts` (and `src/mocks/auth.ts` beneath it) out
// of the production bundle entirely (`scripts/check-production-bundle.sh`).
// A value computed through a function call cannot be folded the same way
// (console PR #35 review at 75deb37 — see `src/app/routeTree.ts` for the
// fuller version of this reasoning, and `src/config.ts` for why this file
// reads `import.meta.env` directly instead of going through it here).

import './validation-policy'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProviders } from './app/providers'
import { queryClient } from './app/queryClient'
import { createAppRouter } from './app/routeTree'
import { authAdapter } from './auth/oidc'
import { authMode } from './config'
import { holdInvitationEntry } from './features/invitation/entry'
import { holdClaimEntry } from './features/owner-claim/entry'
import i18n from './i18n'
import './index.css'

/** What `src/entry-bootstrap.ts` hands over: a claim only when the first-owner journey is built
 * in, an invitation and the protected callback in every build. */
export type BootEntry =
  | {
      readonly kind: 'claim' | 'invitation'
      readonly organisationId: string
      readonly organisationSlug: string
      readonly secret: string
    }
  | { readonly kind: 'claim-callback' }

export async function boot(entry?: BootEntry): Promise<void> {
  if (entry?.kind === 'claim-callback') {
    // The protected sign-in's popup (a claim or an invitation) only hands its answer back to the
    // page that opened it.
    const claimAuth = authAdapter.ownerClaimAuth
    if (claimAuth === undefined) throw new Error('Protected sign-in is unavailable.')
    await claimAuth.notifyCallback()
    return
  }
  if (entry?.kind === 'invitation') holdInvitationEntry(entry)
  if (import.meta.env.VITE_FIRST_OWNER_JOURNEY === '1' && entry?.kind === 'claim') {
    holdClaimEntry(entry)
  }
  if (import.meta.env.VITE_ENABLE_MSW === '1') {
    const { startMockWorker } = await import('./mocks/browser')
    await startMockWorker()
    // Gated exactly like the mock identity provider's own route
    // (`src/auth/mock-idp-gate.ts`): a function that can forge a signed-out
    // session on demand must never reach a build that talks to a real
    // identity provider.
    if (authMode() === 'mock') {
      const { installTestHooks } = await import('./auth/testHooks')
      installTestHooks()
    }
  }

  document.title = i18n.t('console.common.app-title')

  const rootElement = document.getElementById('root')
  if (rootElement === null) {
    throw new Error('#root element not found in index.html')
  }

  const router = await createAppRouter()

  createRoot(rootElement).render(
    <StrictMode>
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>
  )
}
