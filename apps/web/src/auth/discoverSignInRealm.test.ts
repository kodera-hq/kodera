import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { discoverSignInRealm } from './discoverSignInRealm'
import {
  clearKnownSharedRealmSlugs,
  isKnownSharedRealmSlug,
  rememberSharedRealmSlug,
} from './sharedRealmHints'

const mutate = vi.hoisted(() => vi.fn())
vi.mock('../api/mutations', () => ({ mutate }))

beforeEach(() => {
  clearKnownSharedRealmSlugs()
  mutate.mockReset()
})
afterEach(() => clearKnownSharedRealmSlugs())

it.each([
  null,
  undefined,
  [],
  { realm: null },
  { realm: 'community', organisation: null },
  { realm: 'community', organisation: 'testing' },
  { realm: 'other-tenant', organisation: { slug: 'testing', realm: 'other-tenant' } },
  { realm: 'community', organisation: { slug: 'testing', realm: 'testing' } },
])('evicts stale hints for invalid discovery metadata: %j', async (result) => {
  rememberSharedRealmSlug('testing')
  mutate.mockResolvedValue(result)
  await expect(discoverSignInRealm('testing')).resolves.toEqual({ kind: 'not-found' })
  expect(isKnownSharedRealmSlug('testing')).toBe(false)
  expect(sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')).toBe('[]')
})

it('rejects malformed slugs and evicts their persisted hints without discovery', async () => {
  sessionStorage.setItem('kodera.web.auth.sharedRealmSlugs', '["BAD-ORG"]')
  await expect(discoverSignInRealm('BAD-ORG')).resolves.toEqual({ kind: 'not-found' })
  expect(mutate).not.toHaveBeenCalled()
  expect(sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')).toBe('[]')
})

it('forgets a shared-realm hint when discovery verifies a dedicated realm', async () => {
  rememberSharedRealmSlug('testing')
  mutate.mockResolvedValue({
    realm: 'testing',
    organisation: { slug: 'testing', realm: 'testing' },
  })
  await expect(discoverSignInRealm('testing')).resolves.toEqual({
    kind: 'resolved',
    realm: 'testing',
  })
  expect(isKnownSharedRealmSlug('testing')).toBe(false)
})

it.each([null, 'community', 'testing'])(
  'does not write hints when the caller has lost ownership (%s)',
  async (realm) => {
    const stored = sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')
    mutate.mockResolvedValue({ realm, organisation: { slug: 'testing', realm } })
    await discoverSignInRealm('testing', () => false)
    expect(sessionStorage.getItem('kodera.web.auth.sharedRealmSlugs')).toBe(stored)
    expect(isKnownSharedRealmSlug('testing')).toBe(false)
  }
)
