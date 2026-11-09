// A provider refusal through the installed identity SDK, end to end: the
// synthetic token endpoint answers a refresh with `invalid_grant`, and the
// session ends in place on the expired dialog (docs/specs/00-shell-and-login.md
// §4.7), never by leaving for /login.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { User, UserManager } from 'oidc-client-ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { SessionExpiryDialog } from '@/app/SessionExpiryDialog'
import { AuthProvider, useAuth } from './AuthProvider'
import { authAdapter } from './oidc'
import { SessionExpiryProvider } from './sessionExpiry'

const issuer = 'https://id.example.test/realms/acme-sa'

beforeEach(() => {
  sessionStorage.clear()
  import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
  import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'
})
afterEach(async () => {
  await authAdapter.signOut()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function signedInAgainstRefusingProvider(status: number, error: string) {
  const redirect = vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
  vi.spyOn(UserManager.prototype, 'signinCallback').mockImplementation(async function (
    this: UserManager
  ) {
    const now = Math.floor(Date.now() / 1000)
    const user = new User({
      access_token: 'synthetic-live-access',
      refresh_token: 'synthetic-revoked-refresh',
      token_type: 'Bearer',
      scope: 'openid',
      expires_at: now + 300,
      profile: { sub: 'synthetic-subject', iss: issuer, aud: 'console', iat: now, exp: now + 300 },
    })
    await this.storeUser(user)
    return user
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === `${issuer}/.well-known/openid-configuration`)
        return Response.json({ issuer, token_endpoint: `${issuer}/token` })
      if (url === `${issuer}/token`) return Response.json({ error }, { status })
      throw new Error('Unexpected synthetic provider request')
    })
  )
  await authAdapter.signIn('acme-sa')
  await authAdapter.handleCallback()
  return redirect
}

it('ends a refused credential through the installed SDK and drops its stored user', async () => {
  await signedInAgainstRefusingProvider(400, 'invalid_grant')
  const remove = vi.spyOn(UserManager.prototype, 'removeUser')
  await expect(authAdapter.renew()).resolves.toBe(false)
  expect(authAdapter.getAccessToken()).toBeUndefined()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(authAdapter.getSnapshot().status).toBe('ready')
})

it('keeps the live credential when the provider fails with an error body', async () => {
  await signedInAgainstRefusingProvider(500, 'unknown_error')
  await expect(authAdapter.renew()).resolves.toBe(false)
  expect(authAdapter.getAccessToken()).toBe('synthetic-live-access')
})

function SessionProbe() {
  return <p>{useAuth().isAuthenticated ? 'route kept' : 'sent to /login'}</p>
}

it('shows the expired dialog in place and signs in again to the same realm', async () => {
  const redirect = await signedInAgainstRefusingProvider(400, 'invalid_grant')
  render(
    <AuthProvider>
      <SessionExpiryProvider>
        <SessionProbe />
        <SessionExpiryDialog />
      </SessionExpiryProvider>
    </AuthProvider>
  )
  expect(screen.queryByText('Votre session a expiré')).toBeNull()
  // The focus check is one of the provider's own renewal triggers.
  await act(async () => {
    fireEvent.focus(window)
    await vi.waitFor(() => expect(authAdapter.getAccessToken()).toBeUndefined())
  })
  expect(await screen.findByRole('dialog', { name: 'Votre session a expiré' })).toBeVisible()
  // org-route.tsx renders <Navigate to="/login"> exactly when this is false.
  expect(screen.getByText('route kept')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Se reconnecter' }))
  await vi.waitFor(() => expect(redirect).toHaveBeenCalledTimes(2))
  expect(authAdapter.getSnapshot().status).toBe('pending')
})
