// The tenant slug literal is the contract's, at every location the contract carries it.
//
// The rule is copied, not generated (`schema.d.ts` has no `pattern`), so a pin bump that
// changes it would leave the form and the mocks validating the previous contract's rule
// with every screen still green. Reading the pinned document here is what makes the copy
// fail loudly instead.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { TENANT_SLUG_PATTERN, isTenantSlug } from './tenantSlug'

const CONTRACT_PATH = join(import.meta.dirname, '..', '..', 'contracts', 'core-api.openapi.yaml')

const contract = parse(readFileSync(CONTRACT_PATH, 'utf8')) as unknown

/** The `pattern` keyword at `segments` in the parsed document, or `undefined`. */
function patternAt(segments: readonly (string | number)[]): unknown {
  let node: unknown = contract
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string | number, unknown>)[segment]
  }
  return node
}

const LOCATIONS: readonly [string, readonly (string | number)[]][] = [
  [
    'the `slug` parameter of GET /slug-availability',
    ['paths', '/slug-availability', 'get', 'parameters', 0, 'schema', 'pattern'],
  ],
  [
    'OrderRequest.tenant.slug',
    [
      'components',
      'schemas',
      'OrderRequest',
      'properties',
      'tenant',
      'properties',
      'slug',
      'pattern',
    ],
  ],
  ['Tenant.slug', ['components', 'schemas', 'Tenant', 'properties', 'slug', 'pattern']],
  [
    'SlugAvailability.slug',
    ['components', 'schemas', 'SlugAvailability', 'properties', 'slug', 'pattern'],
  ],
  [
    'SlugAvailability.suggestions[]',
    ['components', 'schemas', 'SlugAvailability', 'properties', 'suggestions', 'items', 'pattern'],
  ],
  [
    'SupportTicket.tenant_context.tenant_slug',
    [
      'components',
      'schemas',
      'SupportTicket',
      'properties',
      'tenant_context',
      'properties',
      'tenant_slug',
      'pattern',
    ],
  ],
]

describe('TENANT_SLUG_PATTERN', () => {
  it.each(LOCATIONS)('is the pattern the pinned contract carries on %s', (_name, segments) => {
    const declared = patternAt(segments)
    // A location the contract no longer has would compare `undefined` with the literal and
    // fail too, which is the right outcome: the list above is part of what is pinned.
    expect(typeof declared).toBe('string')
    expect(TENANT_SLUG_PATTERN.source).toBe(declared)
  })

  it('carries no flag the contract does not', () => {
    expect(TENANT_SLUG_PATTERN.flags).toBe('')
  })
})

describe('isTenantSlug', () => {
  it('accepts a DNS label of 3 to 32 characters', () => {
    expect(isTenantSlug('abc')).toBe(true)
    expect(isTenantSlug('acme-construction')).toBe(true)
    // A DNS label admits consecutive hyphens, and so does the contract.
    expect(isTenantSlug('acme--fr')).toBe(true)
    expect(isTenantSlug('a'.repeat(32))).toBe(true)
    expect(isTenantSlug('1-2')).toBe(true)
  })

  it('refuses what the contract refuses', () => {
    expect(isTenantSlug('')).toBe(false)
    expect(isTenantSlug('ab')).toBe(false)
    expect(isTenantSlug('a'.repeat(33))).toBe(false)
    expect(isTenantSlug('-abc')).toBe(false)
    expect(isTenantSlug('abc-')).toBe(false)
    expect(isTenantSlug('ACME')).toBe(false)
    expect(isTenantSlug('acmé')).toBe(false)
    expect(isTenantSlug('acme fr')).toBe(false)
    // `(?![\s\S])` is why: with `$` this one would pass.
    expect(isTenantSlug('acme\n')).toBe(false)
  })
})
