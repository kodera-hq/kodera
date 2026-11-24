import { useEffect, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { User, UserManager } from 'oidc-client-ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type * as ApiClient from '../api/client'
import type { components } from '../api/schema'
import { AuthProvider } from '../auth/AuthProvider'
import { authAdapter } from '../auth/oidc'
import { RENEWAL_LEAD_MS, SessionExpiryProvider } from '../auth/sessionExpiry'
import { concealsProtectedSurface, orgRoute } from './org-route'
import { queryClient } from './queryClient'
import { rootRoute } from './root-route'

const get = vi.hoisted(() => vi.fn())
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>()
  return { ...actual, coreApi: () => ({ GET: get }) }
})

vi.mock('./Shell', () => ({
  Shell: (props: { children: ReactNode; sessionExpiry?: ReactNode }) => (
    <div data-testid="protected-shell">
      {props.sessionExpiry}
      <main>{props.children}</main>
    </div>
  ),
}))

const issuer = 'https://id.example.test/realms/community'
const identityId = '3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d'
const communityLifespanS = 260

const communityMe: components['schemas']['Me'] = {
  id: '11111111-2222-4333-8444-555555555555',
  email: 'member@example.test',
  display_name: 'Community Member',
  locale: 'fr',
  staff: false,
  identities: [
    {
      id: identityId,
      issuer,
      realm: 'community',
      subject: 'community-subject',
      email: 'member@example.test',
      mfa_enrolled: false,
    },
  ],
  organisations: [
    {
      identity_id: identityId,
      membership_id: '7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c',
      state: 'active',
      role: 'org_member',
      organisation: {
        id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
        slug: 'community',
        name: 'Kodera Community',
        realm: 'community',
      },
    },
  ],
}

function communityOidcUser(accessToken: string): User {
  const now = Math.floor(Date.now() / 1000)
  return new User({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_at: now + communityLifespanS,
    profile: {
      iss: issuer,
      sub: 'community-subject',
      aud: 'console',
      iat: now,
      exp: now + communityLifespanS,
    },
  })
}

afterEach(async () => {
  vi.useRealTimers()
  await authAdapter.signOut()
  queryClient.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  get.mockReset()
})

describe('concealsProtectedSurface', () => {
  it('revalidates same-generation usable renewals in place and conceals all other authority gaps', () => {
    expect(
      concealsProtectedSurface({
        authorityMismatch: false,
        sameGeneration: true,
        hasUsableToken: true,
      })
    ).toBe(false)
    expect(
      concealsProtectedSurface({
        authorityMismatch: false,
        sameGeneration: true,
        hasUsableToken: false,
      })
    ).toBe(true)
    expect(
      concealsProtectedSurface({
        authorityMismatch: false,
        sameGeneration: false,
        hasUsableToken: true,
      })
    ).toBe(true)
    expect(
      concealsProtectedSurface({
        authorityMismatch: true,
        sameGeneration: true,
        hasUsableToken: true,
      })
    ).toBe(false)
    expect(
      concealsProtectedSurface({
        authorityMismatch: true,
        sameGeneration: true,
        hasUsableToken: false,
      })
    ).toBe(true)
    expect(
      concealsProtectedSurface({
        authorityMismatch: true,
        sameGeneration: false,
        hasUsableToken: true,
      })
    ).toBe(true)
    expect(
      concealsProtectedSurface({
        authorityMismatch: true,
        sameGeneration: false,
        hasUsableToken: false,
      })
    ).toBe(true)
  })
})

it('renews a 260s Community OIDC credential silently with zero SessionLoading renders, zero hidden shells, and zero child unmounts', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(1_000_000_000_000)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubEnv('VITE_AUTH_MODE', 'oidc')
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockResolvedValueOnce(
    communityOidcUser('community-token-1')
  )
  await authAdapter.signIn('community')
  await authAdapter.handleCallback()

  get.mockResolvedValueOnce({ data: communityMe })
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function WorkspaceComposer() {
    useEffect(() => {
      mounted()
      return unmounted
    }, [])
    return <input aria-label="Message composer" defaultValue="live message" />
  }

  const workspace = createRoute({
    getParentRoute: () => orgRoute,
    path: 'workspace',
    component: WorkspaceComposer,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([orgRoute.addChildren([workspace])]),
    history: createMemoryHistory({ initialEntries: ['/community/workspace'] }),
  })

  const { container } = render(
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

  const composer = await screen.findByRole('textbox', { name: 'Message composer' })
  expect(composer).toBeVisible()
  composer.focus()
  expect(composer).toHaveFocus()
  expect(mounted).toHaveBeenCalledTimes(1)
  expect(get).toHaveBeenCalledTimes(1)

  let sessionLoadingAppearances = 0
  let hiddenShellAppearances = 0
  let expiryDialogAppearances = 0
  const checkDomInvariants = () => {
    if (container.querySelector('main[aria-busy="true"]') !== null) {
      sessionLoadingAppearances += 1
    }
    const shell = container.querySelector('[data-testid="protected-shell"]')
    if (shell?.closest('[hidden]') !== null && shell?.closest('[hidden]') !== undefined) {
      hiddenShellAppearances += 1
    }
    if (container.querySelector('[role="dialog"]') !== null) {
      expiryDialogAppearances += 1
    }
  }
  const observer = new MutationObserver(checkDomInvariants)
  observer.observe(container, {
    attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'aria-busy'],
    childList: true,
    subtree: true,
  })

  let resolveRenewalMe!: (value: { data: components['schemas']['Me'] }) => void
  get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRenewalMe = resolve
      })
  )
  const silentSpy = vi
    .spyOn(UserManager.prototype, 'signinSilent')
    .mockImplementationOnce(async () => communityOidcUser('community-token-2'))
    .mockImplementationOnce(async () => communityOidcUser('community-token-3'))

  // Advance to the scheduled lead renewal (110s into the 260s token, 30s ahead of the 120s SDK warning).
  const expectedFirstRenewalMs = communityLifespanS * 1000 - RENEWAL_LEAD_MS
  expect(expectedFirstRenewalMs).toBe(110_000)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(expectedFirstRenewalMs)
  })
  await waitFor(() => expect(silentSpy).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))

  // While `/me` is in-flight for the rotated same-session credential, the shell stays visible.
  checkDomInvariants()
  expect(screen.getByTestId('protected-shell')).toBeVisible()
  expect(composer).toBeVisible()
  expect(composer).toHaveFocus()
  expect(container.querySelector('main[aria-busy="true"]')).toBeNull()
  expect(container.querySelector('[hidden]')).toBeNull()

  await act(async () => {
    resolveRenewalMe({ data: communityMe })
  })
  await waitFor(() => expect(router.state.status).toBe('idle'))

  // Run a second full 110s periodic silent-renewal cycle end-to-end.
  get.mockResolvedValueOnce({ data: communityMe })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(expectedFirstRenewalMs)
  })
  await waitFor(() => expect(silentSpy).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(router.state.status).toBe('idle'))

  observer.disconnect()
  expect(sessionLoadingAppearances).toBe(0)
  expect(hiddenShellAppearances).toBe(0)
  expect(expiryDialogAppearances).toBe(0)
  expect(mounted).toHaveBeenCalledTimes(1)
  expect(unmounted).not.toHaveBeenCalled()
  expect(composer).toBeVisible()
  expect(composer).toHaveFocus()
})
