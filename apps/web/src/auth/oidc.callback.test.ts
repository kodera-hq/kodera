import * as installedSdk from 'oidc-client-ts'
import {
  proveMemoryVariant,
  proveSupportRefusals,
  runCanonicalCase,
} from './test-support/oidcSdkContract'
import { OidcClient, WebStorageStateStore } from 'oidc-client-ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OidcAuthAdapter } from './oidc'

const issuer = 'https://id.example.test/realms/acme-sa'
let exchange: ReturnType<typeof vi.fn<() => never>>
let notify: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  sessionStorage.clear()
  import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'
  import.meta.env['VITE_OIDC_CLIENT_ID'] = 'console'
  history.replaceState(null, '', '/')
  exchange = vi.fn(() => {
    throw new Error('A child must not exchange the code')
  })
  notify = vi.spyOn(window.parent, 'postMessage')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
        })
      }
      return exchange()
    })
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

async function silentCallbackUrl() {
  const redirectUri = `${window.location.origin}/auth/callback`
  const client = new OidcClient({
    authority: issuer,
    client_id: 'console',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  })
  const request = await client.createSigninRequest({ request_type: 'si:s', prompt: 'none' })
  const url = new URL(redirectUri)
  url.searchParams.set('state', request.state.id)
  url.searchParams.set('code', 'synthetic-code')
  sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
  history.replaceState(null, '', url)
  return url.href
}

describe('installed SDK callback dispatch', () => {
  it('notifies the parent for stored silent state without exchanging in the child', async () => {
    const url = await silentCallbackUrl()
    // An untrusted query label cannot override the SDK's stored transaction.
    history.replaceState(null, '', `${url}&request_type=si:r`)
    const adapter = new OidcAuthAdapter()
    try {
      await expect(adapter.handleCallback()).resolves.toBe('silent')
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ url: `${url}&request_type=si:r` }),
        window.location.origin
      )
      expect(exchange).not.toHaveBeenCalled()
      expect(adapter.getAccessToken()).toBeUndefined()
    } finally {
      await adapter.signOut()
    }
  })

  it('deduplicates silent notification across concurrent and repeated callback effects', async () => {
    await silentCallbackUrl()
    const adapter = new OidcAuthAdapter()
    try {
      await expect(
        Promise.all([adapter.handleCallback(), adapter.handleCallback()])
      ).resolves.toEqual(['silent', 'silent'])
      await expect(adapter.handleCallback()).resolves.toBe('silent')
      expect(notify).toHaveBeenCalledTimes(1)
      expect(exchange).not.toHaveBeenCalled()
    } finally {
      await adapter.signOut()
    }
  })

  it('does not reuse a completed callback result for a different URL', async () => {
    await silentCallbackUrl()
    const adapter = new OidcAuthAdapter()
    try {
      await adapter.handleCallback()
      history.replaceState(null, '', '/auth/callback?code=untrusted&state=unknown')
      await expect(adapter.handleCallback()).rejects.toThrow()
      expect(notify).toHaveBeenCalledTimes(1)
      expect(exchange).not.toHaveBeenCalled()
    } finally {
      await adapter.signOut()
    }
  })

  it('refuses missing state without notifying or exchanging', async () => {
    sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
    history.replaceState(null, '', '/auth/callback?code=untrusted&state=unknown')
    const adapter = new OidcAuthAdapter()
    try {
      await expect(adapter.handleCallback()).rejects.toThrow()
      expect(notify).not.toHaveBeenCalled()
      expect(exchange).not.toHaveBeenCalled()
      expect(adapter.getAccessToken()).toBeUndefined()
    } finally {
      await adapter.signOut()
    }
  })
})

describe('installed SDK public request metadata compatibility', () => {
  it.each([
    'inspect-preserved',
    'missing-state',
    'unknown-state',
    'explicit-remove',
    'metadata-reversed',
  ] as const)(
    'runs the same %s operation on public package and memory-pristine',
    async (id) => {
      await runCanonicalCase(installedSdk, id)
    },
    30000
  )
  it.each(['S01', 'S02'] as const)(
    'rejects real source variant %s between fresh pristine probes',
    async (id) => {
      await proveMemoryVariant(id, installedSdk)
    },
    30000
  )
  it('refuses finite loader, classifier and owned-effect false kills', async () => {
    await proveSupportRefusals()
  }, 30000)
})

it('B09 ordinary callback cannot notify protected owner-claim purpose', async () => {
  const protectedUri = `${window.location.origin}/auth/claim-callback`
  const context = {
    purpose: 'owner-claim',
    intentId: 'intent-one',
    organisationId: '11111111-1111-4111-8111-111111111111',
    organisationSlug: 'claim-org',
    realm: 'acme-sa',
  }
  const client = new OidcClient({
    authority: issuer,
    client_id: 'console',
    redirect_uri: protectedUri,
    response_type: 'code',
    scope: 'openid',
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  })
  const request = await client.createSigninRequest({ request_type: 'si:p', state: context })
  const url = new URL(protectedUri)
  url.searchParams.set('state', request.state.id)
  url.searchParams.set('code', 'SYN')
  const inspected = await client.readSigninResponseState(url.href, false)
  expect(inspected.state.request_type, 'B_ORDINARY_VALID_STATE').toBe('si:p')
  expect(inspected.state.data, 'B_ORDINARY_VALID_PURPOSE').toEqual(context)
  sessionStorage.setItem('kodera.web.auth.realm', 'acme-sa')
  sessionStorage.setItem('kodera.web.auth.returnTo', '/preserved')
  history.replaceState(null, '', url)
  const popup = vi
    .spyOn(installedSdk.UserManager.prototype, 'signinPopupCallback')
    .mockResolvedValue()
  const adapter = new OidcAuthAdapter()
  let failed = false
  let primaryFailed = false
  let primary: unknown
  try {
    try {
      await adapter.handleCallback()
    } catch {
      failed = true
    }
    expect(popup.mock.calls.length, 'B_ORDINARY_PROTECTED_NOTIFY_COUNT').toBe(0)
    expect(exchange).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('kodera.web.auth.returnTo')).toBe('/preserved')
    expect(adapter.getAccessToken()).toBeUndefined()
    expect(adapter.getSnapshot().status).not.toBe('ready')
    expect(failed).toBe(true)
  } catch (error: unknown) {
    primaryFailed = true
    primary = error
  }
  const cleanup: unknown[] = []
  try {
    await adapter.signOut()
  } catch (error: unknown) {
    cleanup.push(error)
  }
  try {
    popup.mockRestore()
  } catch (error: unknown) {
    cleanup.push(error)
  }
  try {
    sessionStorage.clear()
  } catch (error: unknown) {
    cleanup.push(error)
  }
  try {
    history.replaceState(null, '', '/')
  } catch (error: unknown) {
    cleanup.push(error)
  }
  if (primaryFailed && cleanup.length)
    throw new AggregateError([primary, ...cleanup], 'B_PRIMARY_AND_CLEANUP')
  if (primaryFailed) throw primary
  if (cleanup.length) throw new AggregateError(cleanup, 'B_OWNED_CLEANUP')
})
