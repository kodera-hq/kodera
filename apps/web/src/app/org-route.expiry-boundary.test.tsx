import { useEffect, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { ErrorResponse, User, UserManager } from 'oidc-client-ts'
import { afterEach, expect, it, vi } from 'vitest'
import '@/i18n'
import type * as ApiClient from '../api/client'
import type { components } from '../api/schema'
import { AuthProvider } from '../auth/AuthProvider'
import { onBeforeSignIn } from '../auth/beforeSignIn'
import { authAdapter } from '../auth/oidc'
import { SessionExpiryProvider } from '../auth/sessionExpiry'
import { orgRoute } from './org-route'
import { queryClient } from './queryClient'
import { rootRoute } from './root-route'

const get = vi.hoisted(() => vi.fn())
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>()
  return { ...actual, coreApi: () => ({ GET: get }) }
})

vi.mock('./Shell', () => ({
  Shell: (props: { children: ReactNode; sessionExpiry?: ReactNode }) => (
    <>
      {props.sessionExpiry}
      <main>{props.children}</main>
    </>
  ),
}))

const issuer = 'https://id.example.test/realms/acme-sa'
const identityId = '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d'
const me: components['schemas']['Me'] = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'owner@example.test',
  display_name: 'Owner',
  locale: 'fr',
  staff: false,
  identities: [
    {
      id: identityId,
      issuer,
      realm: 'acme-sa',
      subject: 'owner-subject',
      email: 'owner@example.test',
      mfa_enrolled: true,
    },
  ],
  organisations: [
    {
      identity_id: identityId,
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
}

function oidcUser(accessToken: string): User {
  return new User({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    profile: { iss: issuer, sub: 'owner-subject', aud: 'console', iat: 0, exp: 9999999999 },
  })
}

afterEach(async () => {
  await authAdapter.signOut()
  queryClient.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  get.mockReset()
})

it('keeps the expired route mounted until a fresh same-identity /me read succeeds', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(oidcUser('credential-a'))
  await authAdapter.signIn('acme-sa')
  await authAdapter.handleCallback()

  get.mockResolvedValueOnce({ data: me })
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function DraftProbe() {
    useEffect(() => {
      mounted()
      return unmounted
    }, [])
    return <input aria-label="Unsent draft" defaultValue="keep me" />
  }
  const home = createRoute({
    getParentRoute: () => orgRoute,
    path: 'home',
    component: DraftProbe,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgRoute.addChildren([home])]),
    history: createMemoryHistory({ initialEntries: ['/acme-sa/home'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        adapter={authAdapter}
        onSessionEnded={() => queryClient.clear()}
        onCredentialChanged={() => {
          void queryClient.cancelQueries({ queryKey: ['me'] })
          queryClient.removeQueries({ queryKey: ['me'] })
        }}
      >
        <SessionExpiryProvider>
          <RouterProvider router={router} />
        </SessionExpiryProvider>
      </AuthProvider>
    </QueryClientProvider>
  )

  const draft = await screen.findByRole('textbox', { name: 'Unsent draft' })
  expect(draft).toBeVisible()
  expect(get).toHaveBeenCalledTimes(1)
  expect(mounted).toHaveBeenCalledTimes(1)

  vi.spyOn(UserManager.prototype, 'signinSilent').mockRejectedValueOnce(
    new ErrorResponse({ error: 'invalid_grant' })
  )
  await act(async () => {
    await expect(authAdapter.renew()).resolves.toBe(false)
  })
  expect(await screen.findByRole('dialog', { name: 'Votre session a expiré' })).toBeVisible()
  expect(draft).not.toBeVisible()
  expect(unmounted).not.toHaveBeenCalled()

  const expiredInvalidation = router.invalidate()
  await waitFor(() => expect(router.state.status).toBe('pending'))
  expect(router.state.matches.find((match) => match.routeId === orgRoute.id)?.status).toBe(
    'success'
  )
  expect(screen.getByRole('dialog', { name: 'Votre session a expiré' })).toBeVisible()
  expect(draft).not.toBeVisible()
  expect(unmounted).not.toHaveBeenCalled()
  expect(get).toHaveBeenCalledTimes(1)

  let resolveFresh!: (value: { data: components['schemas']['Me'] }) => void
  get.mockImplementationOnce(() => {
    expect(authAdapter.getAccessToken()).toBe('credential-b')
    return new Promise((resolve) => (resolveFresh = resolve))
  })
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(oidcUser('credential-b'))
  await act(async () => {
    await authAdapter.signIn('acme-sa')
    await authAdapter.handleCallback()
  })
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  const reconnectingDraft = screen.queryByRole('textbox', { name: 'Unsent draft' })
  if (reconnectingDraft !== null) expect(reconnectingDraft).not.toBeVisible()

  await act(async () => resolveFresh({ data: me }))
  await expiredInvalidation
  expect(await screen.findByRole('textbox', { name: 'Unsent draft' })).toBeVisible()
})

it('reauthenticates an expired Browser Back across params and removes its navigation listener', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  const redirect = vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(oidcUser('credential-a'))
  await authAdapter.signIn('acme-sa')
  await authAdapter.handleCallback()

  get.mockResolvedValue({ data: me })
  const member = createRoute({
    getParentRoute: () => orgRoute,
    path: 'people/$memberId',
    component: () => <input aria-label="Member draft" defaultValue="keep me" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgRoute.addChildren([member])]),
    history: createMemoryHistory({ initialEntries: ['/acme-sa/people/member-a'] }),
  })
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider
        adapter={authAdapter}
        onSessionEnded={() => queryClient.clear()}
        onCredentialChanged={() => {
          void queryClient.cancelQueries({ queryKey: ['me'] })
          queryClient.removeQueries({ queryKey: ['me'] })
        }}
      >
        <SessionExpiryProvider>
          <RouterProvider router={router} />
        </SessionExpiryProvider>
      </AuthProvider>
    </QueryClientProvider>
  )

  expect(await screen.findByRole('textbox', { name: 'Member draft' })).toBeVisible()
  await act(async () => {
    await router.navigate({
      to: '/$org/people/$memberId',
      params: { org: 'acme-sa', memberId: 'member-b' },
    })
  })
  expect(router.state.location.pathname).toBe('/acme-sa/people/member-b')

  vi.spyOn(UserManager.prototype, 'signinSilent').mockRejectedValueOnce(
    new ErrorResponse({ error: 'invalid_grant' })
  )
  await act(async () => {
    await expect(authAdapter.renew()).resolves.toBe(false)
  })
  expect(await screen.findByRole('dialog', { name: 'Votre session a expiré' })).toBeVisible()

  const save = vi.fn()
  const stopSaving = onBeforeSignIn(save)
  const restore = vi.spyOn(authAdapter, 'restoreSession')
  redirect.mockClear()
  const generation = authAdapter.getSnapshot().generation
  act(() => router.history.back())
  await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1))
  expect(save).toHaveBeenCalledTimes(1)
  expect(restore).toHaveBeenCalledTimes(1)
  expect(authAdapter.getSnapshot().generation).toBe(generation + 1)
  expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/acme-sa/people/member-a')
  await waitFor(() => expect(router.state.status).not.toBe('pending'))

  rendered.unmount()
  const fromLocation = router.state.location
  const nextPath = '/acme-sa/people/member-c'
  const toLocation = router.parseLocation({
    href: nextPath,
    pathname: nextPath,
    search: '',
    hash: '',
    state: fromLocation.state,
  })
  vi.spyOn(authAdapter, 'getSnapshot').mockReturnValue({
    status: 'ready',
    generation: generation + 1,
    credentialGeneration: authAdapter.getSnapshot().credentialGeneration,
    user: {
      realm: 'acme-sa',
      identity: { issuer, subject: 'owner-subject' },
    },
  })
  vi.spyOn(authAdapter, 'getAccessToken').mockReturnValue(undefined)
  router.emit({
    type: 'onBeforeNavigate',
    fromLocation,
    toLocation,
    pathChanged: true,
    hrefChanged: true,
    hashChanged: false,
  })
  expect(save).toHaveBeenCalledTimes(1)
  stopSaving()
})
