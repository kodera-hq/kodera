import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredTenantDomain, isTenantDomain } from './tenantAddress'

afterEach(() => vi.unstubAllEnvs())

describe('isTenantDomain', () => {
  it('accepts a DNS name of two labels or more, up to 253 characters', () => {
    expect(isTenantDomain('staging.kodera.io')).toBe(true)
    expect(isTenantDomain('kodera.io')).toBe(true)
    expect(isTenantDomain(`${'a'.repeat(62)}.`.repeat(4) + 'i')).toBe(true)
  })

  it.each([
    ['one label', 'localhost'],
    ['a scheme', 'https://kodera.io'],
    ['a leading dot', '.kodera.io'],
    ['a trailing dot', 'kodera.io.'],
    ['a port', 'kodera.io:443'],
    ['a wildcard', '*.kodera.io'],
    ['upper case', 'Kodera.io'],
    ['a numeric last label', '10.0.0.1'],
    ['a path', 'kodera.io/x'],
    ['more than 253 characters', `${'a'.repeat(62)}.`.repeat(4) + 'io'],
  ])('refuses %s', (_why, value) => {
    expect(isTenantDomain(value)).toBe(false)
  })
})

describe('configuredTenantDomain', () => {
  it('is VITE_TENANT_DOMAIN when it is a DNS name', () => {
    vi.stubEnv('VITE_TENANT_DOMAIN', 'staging.kodera.io')
    expect(configuredTenantDomain()).toBe('staging.kodera.io')
  })

  it('is undefined when unset, so the order names no domain', () => {
    vi.stubEnv('VITE_TENANT_DOMAIN', '')
    expect(configuredTenantDomain()).toBeUndefined()
  })

  it('is undefined when malformed, rather than previewing a wrong address', () => {
    vi.stubEnv('VITE_TENANT_DOMAIN', 'https://staging.kodera.io')
    expect(configuredTenantDomain()).toBeUndefined()
  })
})
