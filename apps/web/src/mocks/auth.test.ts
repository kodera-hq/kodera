import { OidcClient, WebStorageStateStore } from 'oidc-client-ts'
import { OidcAuthAdapter } from '@/auth/oidc'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { authHandlers } from '@/mocks/auth'
import { registerInteractiveDemo } from '@/app/interactiveDemo'
import { createLocalWorkspaceStore } from './demo/workspaceStore'

// VITE_KEYCLOAK_URL is required to build the handlers (they answer under it),
// so it has to be set before the module is imported — see config.test.ts for
// the same pattern.
import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  const payload = parts[1]
  if (payload === undefined) throw new Error('not a JWT')
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  return JSON.parse(json) as Record<string, unknown>
}

describe('mock identity provider handlers', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  afterEach(() => {
    server.resetHandlers()
    history.replaceState(null, '', '/')
    sessionStorage.clear()
    registerInteractiveDemo(undefined)
  })
  afterAll(() => server.close())

  it('completes the installed SDK authorization exchange and renews without an interactive iframe', async () => {
    registerInteractiveDemo({ slug: 'community', createStore: createLocalWorkspaceStore })
    server.use(...authHandlers())
    const client = new OidcClient({
      authority: 'https://id.example.test/realms/community',
      client_id: 'console',
      redirect_uri: `${window.location.origin}/auth/callback`,
      response_type: 'code',
      scope: 'openid profile email',
      stateStore: new WebStorageStateStore({ store: sessionStorage }),
    })
    const request = await client.createSigninRequest({ request_type: 'si:r', skipUserInfo: true })
    sessionStorage.setItem('kodera.web.auth.realm', 'community')
    history.replaceState(
      null,
      '',
      `/auth/callback?state=${request.state.id}&code=mock-authorization-code`
    )
    const adapter = new OidcAuthAdapter()
    try {
      await expect(adapter.handleCallback()).resolves.toBe('interactive')
      await expect(adapter.renew()).resolves.toBe(true)
      expect(adapter.getUser()?.realm).toBe('community')
      expect(adapter.getExpiresAt()).toBeGreaterThan(Date.now() + 3_500_000)
      expect(document.querySelector('iframe')).toBeNull()
    } finally {
      await adapter.signOut()
    }
  })

  it('serves the discovery document under the configured realm', async () => {
    server.use(...authHandlers())
    const response = await fetch(
      'https://id.example.test/realms/acme-sa/.well-known/openid-configuration'
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['issuer']).toBe('https://id.example.test/realms/acme-sa')
    expect(body['token_endpoint']).toBe(
      'https://id.example.test/realms/acme-sa/protocol/openid-connect/token'
    )
    // The mock IdP's own page, never Keycloak's — this is the seam ADR-0007
    // fakes, everything else runs through the real library.
    expect(body['authorization_endpoint']).toContain('/__mock-idp/authorize')
    expect(body['authorization_endpoint']).toContain('realm=acme-sa')
  })

  it('answers the token endpoint with a signed-looking, unverified, short-lived JWT', async () => {
    server.use(...authHandlers())
    const response = await fetch(
      'https://id.example.test/realms/acme-sa/protocol/openid-connect/token',
      { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }) }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      access_token: string
      id_token: string
      token_type: string
      expires_in: number
    }
    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBe(300)

    const claims = decodeJwtPayload(body.id_token)
    expect(claims['iss']).toBe('https://id.example.test/realms/acme-sa')
    expect(typeof claims['sub']).toBe('string')
    expect(claims['sub']).not.toBe('')
    const now = Math.floor(Date.now() / 1000)
    expect(claims['exp']).toBeGreaterThan(now)
    expect(claims['exp']).toBeLessThanOrEqual(now + 300)
  })
  it('gives the interactive demo one hour while other realms keep short-lived tokens', async () => {
    registerInteractiveDemo({ slug: 'vercelli', createStore: createLocalWorkspaceStore })
    server.use(...authHandlers())
    for (const [realm, duration] of [
      ['vercelli', 3600],
      ['acme-sa', 300],
    ] as const) {
      const response = await fetch(
        `https://id.example.test/realms/${realm}/protocol/openid-connect/token`,
        { method: 'POST' }
      )
      const body = (await response.json()) as {
        access_token: string
        id_token: string
        expires_in: number
      }
      expect(body.expires_in).toBe(duration)
      for (const token of [body.access_token, body.id_token]) {
        const claims = decodeJwtPayload(token)
        expect(Number(claims['exp']) - Number(claims['iat'])).toBe(duration)
      }
    }
  })
})
