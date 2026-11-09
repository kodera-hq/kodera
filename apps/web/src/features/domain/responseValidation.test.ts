import { describe, expect, it } from 'vitest'
import {
  ORGANISATION_ID,
  TENANT_ID,
  baseDomain,
  baseTenant,
  mixedAddresses,
  providedHosts,
} from '../../mocks/fixtures/domainFixtures'
import { requireDomainsPage, requireFirstTenant } from './responseValidation'

const onePage = (data: unknown[]) => ({ data, has_more: false, next_cursor: null })

describe('requireFirstTenant', () => {
  it('keeps the identifier and the provided addresses of the first instance', () => {
    const tenant = requireFirstTenant(onePage([baseTenant()]), ORGANISATION_ID)
    expect(tenant?.id).toBe(TENANT_ID)
    expect(tenant?.provided.map((address) => address.host)).toEqual(providedHosts())
  })

  it('answers null for an organisation with no instance yet', () => {
    expect(requireFirstTenant(onePage([]), ORGANISATION_ID)).toBeNull()
  })

  it.each([
    ['no body', undefined],
    ['no collection', {}],
    ['a collection that is not a list', { data: 'none' }],
    ['no pagination envelope', { data: [] }],
    ['empty non-final page', { data: [], has_more: true, next_cursor: 'next' }],
    ['non-boolean continuation', { data: [], has_more: 'false', next_cursor: null }],
    ['continuation without cursor', { data: [baseTenant()], has_more: true }],
    ['continuation with blank cursor', { data: [baseTenant()], has_more: true, next_cursor: '' }],
    [
      'continuation with oversized cursor',
      { data: [baseTenant()], has_more: true, next_cursor: 'c'.repeat(513) },
    ],
    ['final page with cursor', { data: [], has_more: false, next_cursor: 'next' }],
    ['a row that is not an object', onePage(['tenant'])],
    ['no identifier', onePage([baseTenant({ id: '' })])],
    ['another organisation’s instance', onePage([baseTenant({ organisation_id: 'someone-else' })])],
  ])('refuses %s', (_name, value) => {
    expect(() => requireFirstTenant(value, ORGANISATION_ID)).toThrow(
      'Tenant list response is unavailable.'
    )
  })

  it('keeps the first tenant from a valid non-final page', () => {
    expect(
      requireFirstTenant(
        { data: [baseTenant()], has_more: true, next_cursor: 'next' },
        ORGANISATION_ID
      )?.id
    ).toBe(TENANT_ID)
  })

  it('refuses an instance whose provided addresses cannot be read', () => {
    const broken = { ...baseTenant(), default_urls: { visio: 'not an address' } }
    expect(() => requireFirstTenant(onePage([broken]), ORGANISATION_ID)).toThrow(
      'A provided address of the instance is unavailable.'
    )
  })
})

describe('requireDomainsPage', () => {
  it('keeps a page of addresses as it arrived', () => {
    const page = onePage(mixedAddresses())
    expect(requireDomainsPage(page, TENANT_ID)).toBe(page)
  })

  it('keeps an empty page, and a page that says more exists', () => {
    expect(requireDomainsPage(onePage([]), TENANT_ID).data).toEqual([])
    const more = { data: [baseDomain('visio.acme.fr')], has_more: true, next_cursor: 'c-2' }
    expect(requireDomainsPage(more, TENANT_ID).next_cursor).toBe('c-2')
  })

  it('keeps an address with no application and one the API did not flag', () => {
    const { is_canonical: _unused, ...unflagged } = baseDomain('acme.fr', { app: null })
    expect(requireDomainsPage(onePage([unflagged]), TENANT_ID).data).toHaveLength(1)
  })

  const row = (overrides: Record<string, unknown>) =>
    onePage([{ ...baseDomain('visio.acme.fr'), ...overrides }])

  it.each([
    ['no body', undefined],
    ['no collection', { has_more: false }],
    ['no `has_more`', { data: [] }],
    ['more promised and no cursor', { data: [], has_more: true, next_cursor: null }],
    ['more promised and an empty cursor', { data: [], has_more: true, next_cursor: '' }],
    [
      'a cursor past the contract’s bound',
      { data: [], has_more: true, next_cursor: 'c'.repeat(513) },
    ],
    ['a cursor with nothing more to read', { data: [], has_more: false, next_cursor: 'c-2' }],
    ['a row that is not an object', onePage([null])],
    ['a row with no identifier', row({ id: ' ' })],
    ['another instance’s address', row({ tenant_id: 'someone-else' })],
    ['an address with no name', row({ fqdn: '' })],
    ['a name past the contract’s bound', row({ fqdn: `${'a'.repeat(251)}.fr` })],
    ['a state the contract does not have', row({ state: 'verified' })],
    ['a purpose the contract does not have', row({ role: 'mail' })],
    ['an application the contract does not have', row({ app: 'mail' })],
    ['a main-address flag that is not a yes or a no', row({ is_canonical: 'yes' })],
  ])('refuses %s', (_name, value) => {
    expect(() => requireDomainsPage(value, TENANT_ID)).toThrow(
      'Domain list response is unavailable.'
    )
  })

  it('keeps a name at the contract’s bound of 253 characters', () => {
    const longest = `${'a'.repeat(250)}.fr`
    expect(longest).toHaveLength(253)
    expect(requireDomainsPage(row({ fqdn: longest }), TENANT_ID).data).toHaveLength(1)
  })

  it('refuses the whole page for one unusable row', () => {
    const page = onePage([...mixedAddresses(), { ...baseDomain('x.acme.fr'), state: 'bogus' }])
    expect(() => requireDomainsPage(page, TENANT_ID)).toThrow(
      'Domain list response is unavailable.'
    )
  })
})

it('rejects more domains than the default page size permits', () => {
  const rows = Array.from({ length: 51 }, () => baseDomain('visio.acme.fr'))
  expect(() => requireDomainsPage(onePage(rows), TENANT_ID)).toThrow(
    'Domain list response is unavailable.'
  )
})

it('checks the actual requested page size, including its boundary', () => {
  const rows = [baseDomain('visio.acme.fr'), baseDomain('docs.acme.fr')]
  expect(() => requireDomainsPage(onePage(rows), TENANT_ID, 1)).toThrow(
    'Domain list response is unavailable.'
  )
  expect(requireDomainsPage(onePage(rows), TENANT_ID, 2).data).toHaveLength(2)
})

it('accepts exactly the default page-size boundary', () => {
  const rows = Array.from({ length: 50 }, () => baseDomain('visio.acme.fr'))
  expect(requireDomainsPage(onePage(rows), TENANT_ID).data).toHaveLength(50)
})
