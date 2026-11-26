// The public community's host is derived from the deployment's matrix domain (split-origin
// contract B5), never from one hard-coded production name: a self-hosted or staging base domain
// must land on its own community, and a look-alike host must not.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { communityHostname, communityWorkspaceCreationHref, onCommunityHost } from './communityHost'

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

  it('uses the public app by default only on the real Kodera Community host', () => {
    vi.stubEnv('VITE_APP_ORIGIN', undefined)
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
    expect(communityWorkspaceCreationHref('community.kodera.io')).toBe(
      'https://app.kodera.io/workspaces/new#community-sign-in'
    )
    expect(communityWorkspaceCreationHref('app.kodera.io')).toBeUndefined()
    vi.stubEnv('VITE_AUTH_MODE', 'mock')
    expect(communityWorkspaceCreationHref('community.kodera.io')).toBeUndefined()
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'example.org')
    expect(communityWorkspaceCreationHref('community.example.org')).toBeUndefined()
    vi.stubEnv('VITE_APP_ORIGIN', 'https://work.example.org')
    expect(communityWorkspaceCreationHref('community.example.org')).toBe(
      'https://work.example.org/workspaces/new#community-sign-in'
    )
  })

  it.each([
    'http://app.kodera.io',
    'https://community.kodera.io',
    'https://app.kodera.io.example.org',
    'https://app.kodera.io/path',
    'https://user@app.kodera.io',
    'https://app.kodera.io?state=abc',
  ])('omits the continuation for an invalid app origin %s', (origin) => {
    vi.stubEnv('VITE_MATRIX_DOMAIN', 'kodera.io')
    vi.stubEnv('VITE_AUTH_MODE', 'oidc')
    vi.stubEnv('VITE_APP_ORIGIN', origin)
    expect(communityWorkspaceCreationHref('community.kodera.io')).toBeUndefined()
  })
})
