import * as installedSdk from 'oidc-client-ts'
import { proveMemoryVariant, runCanonicalCase } from './test-support/oidcSdkContract'
import { OidcClient, WebStorageStateStore } from 'oidc-client-ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OidcAuthAdapter } from './oidc'

const issuer = 'https://id.example.test/realms/acme-sa'
const redirectUri = `${window.location.origin}/auth/callback`
let claims: Record<string, unknown>
// Synthetic token construction only. Production never decodes a JWT here.
function fixtureToken(profile: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(profile)}.synthetic-signature`
}
beforeEach(() => {
  sessionStorage.clear()
  history.replaceState(null, '', '/')
  vi.stubEnv('VITE_KEYCLOAK_URL', 'https://id.example.test')
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'console')
  const now = Math.floor(Date.now() / 1000)
  claims = { iss: issuer, sub: 'sdk-processed-subject', aud: 'console', iat: now, exp: now + 300 }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === `${issuer}/.well-known/openid-configuration`)
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
        })
      if (url === `${issuer}/token`)
        return Response.json({
          access_token: 'synthetic-access',
          id_token: fixtureToken(claims),
          token_type: 'Bearer',
          scope: 'openid',
          expires_in: 300,
        })
      throw new Error('Unexpected controlled provider request')
    })
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  history.replaceState(null, '', '/')
})
async function callback(realm = 'acme-sa') {
  const authority = `https://id.example.test/realms/${realm}`
  const client = new OidcClient({
    authority,
    client_id: 'console',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  })
  const request = await client.createSigninRequest({ request_type: 'si:r', skipUserInfo: true })
  sessionStorage.setItem('kodera.web.auth.realm', realm)
  const url = new URL(redirectUri)
  url.searchParams.set('state', request.state.id)
  url.searchParams.set('code', 'controlled-code')
  history.replaceState(null, '', url)
  return new OidcAuthAdapter()
}
describe('real installed SDK profile path', () => {
  it.each(['valid', 'wrong issuer', 'missing issuer'] as const)(
    'processes %s while exposing only the configured identity',
    async (mode) => {
      if (mode === 'wrong issuer') claims['iss'] = 'https://another.example.test/realms/acme-sa'
      if (mode === 'missing issuer') delete claims['iss']
      const adapter = await callback()
      try {
        // The SDK accepts these responses, so the adapter must enforce issuer identity.
        if (mode === 'valid') {
          await expect(adapter.handleCallback()).resolves.toBe('interactive')
          expect(adapter.getAccessToken()).toBe('synthetic-access')
          expect(adapter.getUser()?.identity).toEqual({ issuer, subject: 'sdk-processed-subject' })
        } else {
          await expect(adapter.handleCallback()).rejects.toThrow('Invalid sign-in identity')
          expect(adapter.getAccessToken()).toBeUndefined()
          expect(adapter.getUser()).toBeUndefined()
          expect(adapter.getSnapshot().status).toBe('unauthenticated')
        }
      } finally {
        await adapter.signOut()
      }
    }
  )
  it('keeps SDK subject validation: missing subject cannot complete callback', async () => {
    delete claims['sub']
    const adapter = await callback()
    try {
      await expect(adapter.handleCallback()).rejects.toThrow('subject')
      expect(adapter.getUser()).toBeUndefined()
    } finally {
      await adapter.signOut()
    }
  })
})

describe('installed SDK nonsecret state compatibility', () => {
  it.each(['round-trip', 'callback-reversed', 'authority-mismatch', 'client-mismatch'] as const)(
    'runs the same %s operation on public package and memory-pristine',
    async (id) => {
      await runCanonicalCase(installedSdk, id)
    },
    30000
  )
  it.each(['S03', 'S04', 'S05'] as const)(
    'rejects real source variant %s between fresh pristine probes',
    async (id) => {
      await proveMemoryVariant(id, installedSdk)
    },
    30000
  )
})

it('shares a real SDK staff authorization-code callback across concurrent and repeated delivery', async () => {
  const staffIssuer = 'https://id.example.test/realms/kodera-staff'
  claims['iss'] = staffIssuer
  let exchanges = 0
  const finishes = new Set<(response: Response) => void>()
  let cleaning = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${staffIssuer}/.well-known/openid-configuration`)
        return Response.json({
          issuer: staffIssuer,
          authorization_endpoint: `${staffIssuer}/authorize`,
          token_endpoint: `${staffIssuer}/token`,
        })
      if (url === `${staffIssuer}/token`) {
        exchanges += 1
        expect(init?.method).toBe('POST')
        expect(new URLSearchParams(String(init?.body)).get('grant_type')).toBe('authorization_code')
        if (cleaning) return response()
        return new Promise<Response>((resolve) => {
          finishes.add(resolve)
        })
      }
      throw new Error('Unexpected controlled staff provider request')
    })
  )
  const adapter = await callback('kodera-staff')
  const response = () =>
    Response.json({
      access_token: 'synthetic-staff-access',
      id_token: fixtureToken(claims),
      token_type: 'Bearer',
      scope: 'openid',
      expires_in: 300,
    })
  const first = adapter.handleCallback()
  const second = adapter.handleCallback()
  const settled = Promise.allSettled([first, second])
  try {
    expect(second).toBe(first)
    await vi.waitFor(() => expect(exchanges).toBe(1))
    finishes.forEach((finish) => finish(response()))
    await expect(first).resolves.toBe('interactive')
    await expect(second).resolves.toBe('interactive')
    await expect(adapter.handleCallback()).resolves.toBe('interactive')
    expect(exchanges).toBe(1)
    expect(adapter.getUser()?.identity?.issuer).toBe(staffIssuer)
    history.replaceState(
      null,
      '',
      `${redirectUri}?state=another-state&code=another-controlled-code`
    )
    await expect(adapter.handleCallback()).rejects.toThrow('No matching pending callback')
    expect(exchanges).toBe(1)
    await adapter.signOut()
    await expect(adapter.handleCallback()).rejects.toThrow('No pending sign-in')
    expect(exchanges).toBe(1)
  } finally {
    cleaning = true
    finishes.forEach((finish) => finish(response()))
    await settled
    await adapter.signOut()
  }
})
