// The organisation slug literal is the contract's, at every location the contract carries it.
//
// The rule is copied, not generated (`schema.d.ts` has no `pattern`), so a pin bump that
// changes it would leave the login screen validating the previous contract's rule with every
// screen still green, as contract 0.11.0 did when it moved the rule from 2–20 to 5–20. Reading
// the pinned document here is what makes the copy fail loudly instead.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ORGANISATION_SLUG_PATTERN, isOrganisationSlug } from './organisationSlug'
import { TENANT_SLUG_PATTERN } from './tenantSlug'

const CONTRACT_PATH = join(import.meta.dirname, '..', '..', 'contracts', 'core-api.openapi.yaml')

const contract = parse(readFileSync(CONTRACT_PATH, 'utf8')) as unknown

type Segments = readonly (string | number)[]

/** The value at `segments` in the parsed document, or `undefined`. */
function valueAt(segments: Segments): unknown {
  let node: unknown = contract
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string | number, unknown>)[segment]
  }
  return node
}

/** Every `pattern` keyword in the document that is a slug rule, with its path: one under a key
 * that names a slug (`slug`, `tenant_slug`, a `slug` parameter), or one spelled like a slug
 * rule wherever it sits. */
function slugShapedPatterns(): [Segments, string][] {
  const found: [Segments, string][] = []
  const visit = (node: unknown, path: Segments): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, [...path, index]))
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [key, child] of Object.entries(node)) {
      if (key === 'pattern' && typeof child === 'string') {
        const namesSlug = path.some((segment) => /slug/i.test(String(segment)))
        if (namesSlug || child.startsWith('^[a-z0-9][a-z0-9-]')) found.push([[...path, key], child])
      } else {
        visit(child, [...path, key])
      }
    }
  }
  visit(contract, [])
  return found
}

const LOCATIONS: readonly [string, Segments][] = [
  [
    'RealmDiscoveryRequest.slug',
    ['components', 'schemas', 'RealmDiscoveryRequest', 'properties', 'slug', 'pattern'],
  ],
  [
    'OrganisationSummary.slug',
    ['components', 'schemas', 'OrganisationSummary', 'properties', 'slug', 'pattern'],
  ],
  ['Organisation.slug', ['components', 'schemas', 'Organisation', 'properties', 'slug', 'pattern']],
  [
    'OrganisationCreateRequest.slug',
    ['components', 'schemas', 'OrganisationCreateRequest', 'properties', 'slug', 'pattern'],
  ],
  [
    'OrganisationBootstrap.slug',
    ['components', 'schemas', 'OrganisationBootstrap', 'properties', 'slug', 'pattern'],
  ],
  // Contract 0.12.0's realm discovery: the realm is the organisation's slug, so its realm
  // members carry the slug rule too.
  [
    'DiscoveryOrganisationSummary.slug',
    ['components', 'schemas', 'DiscoveryOrganisationSummary', 'properties', 'slug', 'pattern'],
  ],
  [
    'DiscoveryOrganisationSummary.realm',
    ['components', 'schemas', 'DiscoveryOrganisationSummary', 'properties', 'realm', 'pattern'],
  ],
  [
    'RealmDiscoveryCandidate.realm',
    ['components', 'schemas', 'RealmDiscoveryCandidate', 'properties', 'realm', 'pattern'],
  ],
  [
    'RealmDiscoveryResult.oneOf[1].realm',
    ['components', 'schemas', 'RealmDiscoveryResult', 'oneOf', 1, 'properties', 'realm', 'pattern'],
  ],
  [
    'PassportWorkspaceEntry.organisation_slug',
    [
      'components',
      'schemas',
      'PassportWorkspaceEntry',
      'properties',
      'organisation_slug',
      'pattern',
    ],
  ],
  [
    'SelfServeOrganisationCreateRequest.slug',
    [
      'components',
      'schemas',
      'SelfServeOrganisationCreateRequest',
      'properties',
      'slug',
      'pattern',
    ],
  ],
  [
    'SelfServeWorkspaceCreated.organisation_slug',
    [
      'components',
      'schemas',
      'SelfServeWorkspaceCreated',
      'properties',
      'organisation_slug',
      'pattern',
    ],
  ],
]

// Contract 0.50.0's workspace roles carry a slug rule of their own, on the `slug` of
// `WorkspaceRole`, `WorkspaceRoleCreate` and `WorkspaceRolePatch`: 1–64 characters, a
// leading letter then lowercase letters, digits, hyphens or underscores. The server's
// contract test (apps/server/tests/test_customer_read_contract.py) holds the same three
// locations to the same rule and to `minLength: 1` / `maxLength: 64` beside the pattern,
// so the two pins cannot drift apart unnoticed.
// `DocumentRoleGrant.slug` reuses this rule for document access grants.
const WORKSPACE_ROLE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const BOOKING_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9](?![\s\S])/
const EXTENSION_MARKETPLACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9](?![\s\S])/

const WORKSPACE_ROLE_LOCATIONS: readonly [string, Segments][] = [
  ['WorkspaceRole.slug', ['components', 'schemas', 'WorkspaceRole', 'properties', 'slug']],
  [
    'WorkspaceRoleCreate.slug',
    ['components', 'schemas', 'WorkspaceRoleCreate', 'properties', 'slug'],
  ],
  [
    'WorkspaceRolePatch.slug',
    ['components', 'schemas', 'WorkspaceRolePatch', 'properties', 'slug'],
  ],
  ['DocumentRoleGrant.slug', ['components', 'schemas', 'DocumentRoleGrant', 'properties', 'slug']],
]

const BOOKING_SLUG_LOCATIONS: readonly [string, Segments][] = [
  [
    'GET /booking/{booking_slug}',
    ['paths', '/booking/{booking_slug}', 'get', 'parameters', 0, 'schema'],
  ],
  [
    'POST /booking/{booking_slug}/reservations',
    ['paths', '/booking/{booking_slug}/reservations', 'post', 'parameters', 0, 'schema'],
  ],
  [
    'POST /booking/{booking_slug}/reservations/{reservation_id}/actions/cancel',
    [
      'paths',
      '/booking/{booking_slug}/reservations/{reservation_id}/actions/cancel',
      'post',
      'parameters',
      0,
      'schema',
    ],
  ],
  ['BookingPage.slug', ['components', 'schemas', 'BookingPage', 'properties', 'slug']],
  [
    'BookingPageCreateRequest.slug',
    ['components', 'schemas', 'BookingPageCreateRequest', 'properties', 'slug'],
  ],
  ['PublicBookingPage.slug', ['components', 'schemas', 'PublicBookingPage', 'properties', 'slug']],
  [
    'PublicBookingReservation.slug',
    ['components', 'schemas', 'PublicBookingReservation', 'properties', 'slug'],
  ],
]

const EXTENSION_MARKETPLACE_SLUG_LOCATIONS: readonly [string, Segments][] = [
  [
    'POST /organisations/{organisation_id}/workspace/channels/{channel_id}/widgets/{widget_id}/actions',
    [
      'paths',
      '/organisations/{organisation_id}/workspace/channels/{channel_id}/widgets/{widget_id}/actions',
      'post',
      'parameters',
      2,
      'schema',
    ],
  ],
  [
    'ExtensionMarketplaceManifest.slug',
    ['components', 'schemas', 'ExtensionMarketplaceManifest', 'properties', 'slug'],
  ],
  [
    'ExtensionMarketplaceListing.slug',
    ['components', 'schemas', 'ExtensionMarketplaceListing', 'properties', 'slug'],
  ],
  [
    'ExtensionMarketplacePublishRequest.slug',
    ['components', 'schemas', 'ExtensionMarketplacePublishRequest', 'properties', 'slug'],
  ],
  [
    'ExtensionMarketplaceInstallResult.slug',
    ['components', 'schemas', 'ExtensionMarketplaceInstallResult', 'properties', 'slug'],
  ],
  [
    'ExtensionWidgetCard.widgetId',
    ['components', 'schemas', 'ExtensionWidgetCard', 'properties', 'widgetId'],
  ],
  [
    'ExtensionManifestWidget.id',
    ['components', 'schemas', 'ExtensionManifestWidget', 'properties', 'id'],
  ],
  [
    'ChannelWidgetActionResult.widgetId',
    ['components', 'schemas', 'ChannelWidgetActionResult', 'properties', 'widgetId'],
  ],
]

describe('ORGANISATION_SLUG_PATTERN', () => {
  it.each(LOCATIONS)('is the pattern the pinned contract carries on %s', (_name, segments) => {
    const declared = valueAt(segments)
    // A location the contract no longer has would compare `undefined` with the literal and
    // fail too, which is the right outcome: the list above is part of what is pinned.
    expect(typeof declared).toBe('string')
    expect(ORGANISATION_SLUG_PATTERN.source).toBe(declared)
  })

  it('carries no flag the contract does not', () => {
    expect(ORGANISATION_SLUG_PATTERN.flags).toBe('')
  })

  it('is carried by the pinned contract at exactly the locations listed', () => {
    const carrying = slugShapedPatterns()
      .filter(([, pattern]) => pattern === ORGANISATION_SLUG_PATTERN.source)
      .map(([path]) => path.join('/'))
      .sort()
    expect(carrying).toEqual(LOCATIONS.map(([, segments]) => segments.join('/')).sort())
  })

  it('leaves the pinned contract no slug-shaped rule other than the organisation, tenant, workspace-role, booking-page, and extension-marketplace ones', () => {
    // A sixth rule is a contract change the console has not taken yet, not something to
    // discover in production.
    const known = new Set([
      ORGANISATION_SLUG_PATTERN.source,
      TENANT_SLUG_PATTERN.source,
      WORKSPACE_ROLE_SLUG_PATTERN.source,
      BOOKING_SLUG_PATTERN.source,
      EXTENSION_MARKETPLACE_SLUG_PATTERN.source,
    ])
    // Contract 0.29.0 reserves `synth-` on organisation creation only, which the console never
    // sends (staff intake does). Discovery still answers synthetic realms, so the console's own
    // rule must not refuse them: the reservation is listed here by its exact path, not mirrored.
    const createOnly = new Set([
      'components/schemas/OrganisationCreateRequest/properties/slug/allOf/0/not/pattern: ^synth-',
    ])
    const unknown = slugShapedPatterns()
      .filter(([, pattern]) => !known.has(pattern))
      .map(([path, pattern]) => `${path.join('/')}: ${pattern}`)
      .filter((row) => !createOnly.has(row))
    expect(unknown).toEqual([])
  })
})

describe('the workspace-role slug rule', () => {
  it.each(WORKSPACE_ROLE_LOCATIONS)(
    'is the rule the pinned contract carries on %s, bounded 1 to 64',
    (_name, segments) => {
      const schema = valueAt(segments)
      // The bounds are asserted beside the pattern because the contract carries them
      // beside it, and the server pin judges both.
      expect(schema).toMatchObject({
        pattern: WORKSPACE_ROLE_SLUG_PATTERN.source,
        minLength: 1,
        maxLength: 64,
      })
    }
  )

  it('is carried by the pinned contract at exactly the locations listed', () => {
    const carrying = slugShapedPatterns()
      .filter(([, pattern]) => pattern === WORKSPACE_ROLE_SLUG_PATTERN.source)
      .map(([path]) => path.join('/'))
      .sort()
    expect(carrying).toEqual(
      WORKSPACE_ROLE_LOCATIONS.map(([, segments]) => [...segments, 'pattern'].join('/')).sort()
    )
  })
})

describe('the booking-page slug rule', () => {
  it.each(BOOKING_SLUG_LOCATIONS)(
    'is the rule the pinned contract carries on %s, bounded 3 to 80',
    (_name, segments) => {
      const schema = valueAt(segments)
      expect(schema).toMatchObject({
        pattern: BOOKING_SLUG_PATTERN.source,
        minLength: 3,
        maxLength: 80,
      })
    }
  )

  it('is carried by the pinned contract at exactly the locations listed', () => {
    const carrying = slugShapedPatterns()
      .filter(([, pattern]) => pattern === BOOKING_SLUG_PATTERN.source)
      .map(([path]) => path.join('/'))
      .sort()
    expect(carrying).toEqual(
      BOOKING_SLUG_LOCATIONS.map(([, segments]) => [...segments, 'pattern'].join('/')).sort()
    )
  })
})

describe('the extension-marketplace slug rule', () => {
  it.each(EXTENSION_MARKETPLACE_SLUG_LOCATIONS)(
    'is the rule the pinned contract carries on %s, bounded 2 to 63',
    (_name, segments) => {
      const schema = valueAt(segments)
      expect(schema).toMatchObject({
        pattern: EXTENSION_MARKETPLACE_SLUG_PATTERN.source,
        minLength: 2,
        maxLength: 63,
      })
    }
  )

  it('is carried by the pinned contract at exactly the locations listed', () => {
    const carrying = slugShapedPatterns()
      .filter(([, pattern]) => pattern === EXTENSION_MARKETPLACE_SLUG_PATTERN.source)
      .map(([path]) => path.join('/'))
      .sort()
    expect(carrying).toEqual(
      EXTENSION_MARKETPLACE_SLUG_LOCATIONS.map(([, segments]) =>
        [...segments, 'pattern'].join('/')
      ).sort()
    )
  })
})

describe('isOrganisationSlug', () => {
  it('accepts 5 to 20 lowercase alphanumerics with internal hyphens', () => {
    expect(isOrganisationSlug('acme-sa')).toBe(true)
    expect(isOrganisationSlug('abcde')).toBe(true)
    expect(isOrganisationSlug('a'.repeat(20))).toBe(true)
    expect(isOrganisationSlug('a---b')).toBe(true)
    expect(isOrganisationSlug('12345')).toBe(true)
  })

  it('refuses what the contract refuses', () => {
    expect(isOrganisationSlug('')).toBe(false)
    expect(isOrganisationSlug('acme')).toBe(false)
    expect(isOrganisationSlug('a'.repeat(21))).toBe(false)
    expect(isOrganisationSlug('-acme-sa')).toBe(false)
    expect(isOrganisationSlug('acme-sa-')).toBe(false)
    expect(isOrganisationSlug('ACME-SA')).toBe(false)
    expect(isOrganisationSlug('acmé-sa')).toBe(false)
    expect(isOrganisationSlug('acme sa')).toBe(false)
    // `(?![\s\S])` is why: with `$` this one would pass.
    expect(isOrganisationSlug('acme-sa\n')).toBe(false)
  })
})
