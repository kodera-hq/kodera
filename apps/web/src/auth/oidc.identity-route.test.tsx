import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { User, UserManager } from 'oidc-client-ts'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { AuthProvider } from './AuthProvider'
import { authAdapter } from './oidc'
import { orgRoute } from '../app/org-route'
import { rootRoute } from '../app/root-route'

// Keep the real organisation loader/component and router state. The rendering
// probe shows precisely which retained loader authority Shell receives.
vi.mock('../app/Shell', () => ({
  Shell: (props: { role: string; user: { displayName: string }; children: ReactNode }) => (
    <main>
      <p>
        {props.user.displayName}:{props.role}
      </p>
      {props.children}
    </main>
  ),
}))
vi.mock('../app/SessionExpiryDialog', () => ({ SessionExpiryDialog: () => null }))
vi.mock('../app/currentUser', () => ({
  loadCurrentUser: async () => ({
    generation: 1,
    credentialGeneration: 1,
    me: {
      id: '11111111-2222-4333-8444-555555555555',
      email: 'old@example.test',
      display_name: 'Old owner',
      locale: 'fr',
      staff: false,
      identities: [
        {
          id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
          issuer: 'https://id.example.test/realms/acme-sa',
          realm: 'acme-sa',
          subject: 'old-subject',
          email: 'old@example.test',
          mfa_enrolled: true,
        },
      ],
      organisations: [
        {
          identity_id: '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
          membership_id: '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c',
          state: 'active',
          role: 'org_owner',
          organisation: {
            id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
            slug: 'acme-sa',
            name: 'Acme',
            realm: 'acme-sa',
          },
        },
      ],
    },
  }),
}))
const issuer = 'https://id.example.test/realms/acme-sa'
const user = (subject: string) =>
  new User({
    access_token: subject,
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    profile: { iss: issuer, sub: subject, aud: 'console', iat: 0, exp: 9999999999 },
  })
afterEach(async () => {
  await authAdapter.signOut()
  vi.unstubAllEnvs()
})
it('removes old organisation loader authority when renewal returns another subject', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  sessionStorage.clear()
  vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(user('old-subject'))
  await authAdapter.signIn('acme-sa')
  await authAdapter.handleCallback()
  const home = createRoute({
    getParentRoute: () => orgRoute,
    path: 'home',
    component: () => <p>Old protected content</p>,
  })
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: 'login',
    component: () => <p>Sign in again</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgRoute.addChildren([home]), login]),
    history: createMemoryHistory({ initialEntries: ['/acme-sa/home'] }),
  })
  render(
    // The organisation layout reads the workspace tenant from the query cache, as in the app.
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider adapter={authAdapter}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  )
  expect(await screen.findByText('Old owner:org_owner')).toBeInTheDocument()
  expect(screen.getByText('Old protected content')).toBeInTheDocument()
  vi.spyOn(UserManager.prototype, 'signinSilent').mockResolvedValueOnce(user('new-subject'))
  await act(async () => {
    await authAdapter.renew()
  })
  await waitFor(() => expect(screen.queryByText('Old owner:org_owner')).not.toBeInTheDocument())
  expect(screen.queryByText('Old protected content')).not.toBeInTheDocument()
  expect(await screen.findByText('Sign in again')).toBeInTheDocument()
  expect(authAdapter.getSnapshot().status).toBe('unauthenticated')
})
