// Test-only harness for the People screens: the real Core client and the
// `people.*` MSW overlays (src/mocks/overlays), so a screen test exercises the
// same requests the end-to-end suite does. Imported by tests only.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { HttpHandler } from 'msw'
import type { ReactElement } from 'react'
import { vi } from 'vitest'
import { authAdapter } from '../../auth/oidc'
import { server } from '../../mocks/server'
import { ToastProvider } from '../../ui/Toast/Toast'

export const ORG_ID = '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f'

export function signInSynthetic() {
  vi.stubEnv('VITE_CORE_API_URL', 'https://core.example.test/api/v1')
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: 1,
    credentialGeneration: 1,
    user: { realm: 'acme-sa' },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue('synthetic')
}

export function renderWithApi(ui: ReactElement, overlays: HttpHandler[][] = []) {
  // Last-named overlay wins, as in `resolveOverlays`.
  for (const handlers of overlays) server.use(...handlers)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider label="Notification" viewportLabel="Notifications" closeLabel="Fermer">
        {ui}
      </ToastProvider>
    </QueryClientProvider>
  )
}
