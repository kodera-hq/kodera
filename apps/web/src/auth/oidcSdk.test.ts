// The loader of the identity SDK (`./oidcSdk.ts`) on its own: in hand before any test under the
// unit suite, absent until asked for in a build, fetched once, and asked for again after a fetch
// that failed.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as installedSdk from 'oidc-client-ts'

afterEach(() => {
  vi.doUnmock('oidc-client-ts')
  vi.unstubAllEnvs()
})

async function asABuildRunsIt() {
  vi.resetModules()
  vi.stubEnv('MODE', 'production')
  return import('./oidcSdk')
}

describe('under the unit suite', () => {
  it('is loaded before a test can construct an adapter', async () => {
    vi.resetModules()
    const { oidcSdk, oidcSdkLoaded } = await import('./oidcSdk')
    expect(oidcSdkLoaded()).toBe(true)
    expect(oidcSdk().UserManager).toBe(installedSdk.UserManager)
  })
})

describe('in a build', () => {
  it('is absent until asked for, and says so to a caller that did not wait', async () => {
    const { oidcSdk, oidcSdkLoaded } = await asABuildRunsIt()
    expect(oidcSdkLoaded()).toBe(false)
    expect(() => oidcSdk()).toThrow('The identity SDK was used before it was loaded.')
  })

  it('is fetched once for any number of callers', async () => {
    const imported = vi.fn()
    vi.doMock('oidc-client-ts', async () => {
      imported()
      return vi.importActual('oidc-client-ts')
    })
    const { loadOidcSdk, oidcSdk, oidcSdkLoaded } = await asABuildRunsIt()
    await Promise.all([loadOidcSdk(), loadOidcSdk()])
    await loadOidcSdk()
    expect(imported).toHaveBeenCalledTimes(1)
    expect(oidcSdkLoaded()).toBe(true)
    expect(oidcSdk().UserManager).toBeTypeOf('function')
  })

  it('reports a fetch that failed and asks again the next time', async () => {
    vi.doMock('oidc-client-ts', () => {
      throw new Error('chunk unavailable')
    })
    const { loadOidcSdk, oidcSdkLoaded } = await asABuildRunsIt()
    await expect(loadOidcSdk()).rejects.toThrow()
    expect(oidcSdkLoaded()).toBe(false)

    vi.doUnmock('oidc-client-ts')
    await expect(loadOidcSdk()).resolves.toBeUndefined()
    expect(oidcSdkLoaded()).toBe(true)
  })
})
