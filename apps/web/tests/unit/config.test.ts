import { afterEach, describe, expect, it, vi } from 'vitest'

// `import.meta.env` is read once per call in src/config.ts, so each test sets
// exactly the variables it needs and restores the module between assertions.
const setEnv = (vars: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete (import.meta.env as Record<string, unknown>)[key]
    else (import.meta.env as Record<string, unknown>)[key] = value
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  delete (import.meta.env as Record<string, unknown>)['VITE_AUTH_MODE']
  delete (import.meta.env as Record<string, unknown>)['VITE_OIDC_CLIENT_ID']
  vi.resetModules()
})

describe('authMode', () => {
  it('reads "mock" from VITE_AUTH_MODE', async () => {
    setEnv({ VITE_AUTH_MODE: 'mock' })
    const { authMode } = await import('@/config')
    expect(authMode()).toBe('mock')
  })

  it('reads "oidc" from VITE_AUTH_MODE', async () => {
    setEnv({ VITE_AUTH_MODE: 'oidc' })
    const { authMode } = await import('@/config')
    expect(authMode()).toBe('oidc')
  })

  it('throws, naming the variable, when unset — a typo here is silently `undefined` otherwise', async () => {
    setEnv({ VITE_AUTH_MODE: undefined })
    const { authMode } = await import('@/config')
    expect(() => authMode()).toThrow('VITE_AUTH_MODE')
  })

  it('throws on a value that is neither "oidc" nor "mock"', async () => {
    setEnv({ VITE_AUTH_MODE: 'saml' })
    const { authMode } = await import('@/config')
    expect(() => authMode()).toThrow('VITE_AUTH_MODE')
  })
})

describe('oidcClientId', () => {
  it('reads VITE_OIDC_CLIENT_ID', async () => {
    setEnv({ VITE_OIDC_CLIENT_ID: 'console' })
    const { oidcClientId } = await import('@/config')
    expect(oidcClientId()).toBe('console')
  })

  it('throws, naming the variable, when unset', async () => {
    setEnv({ VITE_OIDC_CLIENT_ID: undefined })
    const { oidcClientId } = await import('@/config')
    expect(() => oidcClientId()).toThrow('VITE_OIDC_CLIENT_ID')
  })
})
