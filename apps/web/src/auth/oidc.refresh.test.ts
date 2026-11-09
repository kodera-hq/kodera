import { User, UserManager } from 'oidc-client-ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OidcAuthAdapter } from './oidc'

const issuer = 'https://id.example.test/realms/acme-sa'

beforeEach(() => {
  sessionStorage.clear()
  import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
  import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installed identity SDK refresh-token exchange', () => {
  it('renews against a controlled token endpoint and publishes the new expiry', async () => {
    // Only bootstrap the already authenticated session. signinSilent, metadata
    // lookup, refresh request and SDK response processing remain real.
    vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue()
    vi.spyOn(UserManager.prototype, 'signinCallback').mockImplementation(async function (
      this: UserManager
    ) {
      const now = Math.floor(Date.now() / 1000)
      const user = new User({
        access_token: 'synthetic-old-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        scope: 'openid',
        expires_at: now + 90,
        profile: { sub: 'synthetic-subject', iss: issuer, aud: 'console', iat: now, exp: now + 90 },
      })
      await this.storeUser(user)
      return user
    })
    let tokenRequest: URLSearchParams | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === `${issuer}/.well-known/openid-configuration`) {
          return Response.json({ issuer, token_endpoint: `${issuer}/token` })
        }
        if (url === `${issuer}/token`) {
          tokenRequest = new URLSearchParams(String(init?.body))
          return Response.json({
            access_token: 'synthetic-renewed-access',
            refresh_token: 'synthetic-rotated-refresh',
            token_type: 'Bearer',
            expires_in: 300,
            scope: 'openid',
          })
        }
        throw new Error('Unexpected synthetic provider request')
      })
    )
    const adapter = new OidcAuthAdapter()
    await adapter.signIn('acme-sa')
    await adapter.handleCallback()
    const previousExpiry = adapter.getExpiresAt()
    const renewed = vi.fn()
    adapter.onRenewed(renewed)
    try {
      await expect(adapter.renew()).resolves.toBe(true)
      expect(tokenRequest?.get('grant_type')).toBe('refresh_token')
      expect(tokenRequest?.get('refresh_token')).toBe('synthetic-refresh')
      expect(adapter.getAccessToken()).toBe('synthetic-renewed-access')
      expect(adapter.getExpiresAt()).toBeGreaterThan(previousExpiry!)
      expect(renewed).toHaveBeenCalledTimes(1)
    } finally {
      await adapter.signOut()
    }
  })
})
