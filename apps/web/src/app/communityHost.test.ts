// The public community's host is derived from the deployment's matrix domain (split-origin
// contract B5), never from one hard-coded production name: a self-hosted or staging base domain
// must land on its own community, and a look-alike host must not.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { communityHostname, onCommunityHost } from './communityHost'

describe('the community host', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is community.{matrix domain} for any base domain', () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    for (const domain of ['kodera.io', 'staging.kodera.io', 'example.org']) {
      vi.stubEnv('VITE_MATRIX_DOMAIN', domain)
      expect(communityHostname()).toBe(`community.${domain}`)
      expect(onCommunityHost(`community.${domain}`)).toBe(true)
    }
  })

  it('is recognised only in a real-identity build', () => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'example.org')
    vi.stubEnv('VITE_AUTH_MODE', 'mock')
    expect(onCommunityHost('community.example.org')).toBe(false)
  })

  it('refuses look-alike, foreign and unconfigured hosts', () => {
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'example.org')
    for (const host of [
      'community.kodera.io',
      'community.example.org.elsewhere.test',
      'matrix.community.example.org',
      'api.example.org',
      'example.org',
    ]) {
      expect(onCommunityHost(host), host).toBe(false)
    }
    vi.stubEnv('VITE_MATRIX_DOMAIN', '')
    expect(communityHostname()).toBeUndefined()
    expect(onCommunityHost('community.kodera.io')).toBe(false)
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'https://example.org')
    expect(communityHostname()).toBeUndefined()
  })
})
