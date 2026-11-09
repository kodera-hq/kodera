// Shared builders for the Domain area's MSW overlays
// (`src/mocks/overlays/domain.*.ts`), its unit tests and its end-to-end spec.
// Outside `overlays/` for the reason `invoiceFixtures.ts` gives: that directory
// is globbed by file name and every file in it must export `handlers`.
//
// Every host name of ours in here comes from the contract's own examples — the
// instance's provided addresses, the record an address points at, the name of
// the proof record. None is written down: where an instance is hosted and what
// its addresses are called is not this file's to say
// (docs/specs/domain-addresses-list.md), and a repin that changes them changes
// these fixtures with it. `tests/unit/domain/hosting-boundary.test.ts` holds
// the rule. The customer's own names (`acme.fr`) are invented here, as they
// are everywhere in the mocks.

import type { components } from '../../api/schema'
import { EXAMPLES } from '../generated/examples'

export type Domain = components['schemas']['Domain']
export type Tenant = components['schemas']['Tenant']

const EXAMPLE_TENANT = (EXAMPLES.listTenants.body as { data: Tenant[] }).data[0] as Tenant
const EXAMPLE_DOMAIN = (EXAMPLES.listDomains.body as { data: Domain[] }).data[0] as Domain

/** The organisation and the instance of the generated examples (`ACME`). */
export const ORGANISATION_ID = EXAMPLE_TENANT.organisation_id
export const TENANT_ID = EXAMPLE_TENANT.id

/** The instance as the contract exemplifies it, provided addresses included. */
export function baseTenant(overrides: Partial<Tenant> = {}): Tenant {
  return { ...EXAMPLE_TENANT, ...overrides }
}

/** The provided addresses of `baseTenant()`, as the hosts a person reads:
 * what a test expects on screen without writing one of our names. */
export function providedHosts(tenant: Tenant = EXAMPLE_TENANT): string[] {
  return Object.values(tenant.default_urls ?? {}).map((url) => new URL(url).host)
}

/** A domain id whose last group is the row's index, so a test can name one. */
export function domainId(index: number): string {
  return `b3c4d5e6-f708-491a-8b2c-${String(index).padStart(12, '0')}`
}

/**
 * One address of the organisation's own. The proof record is named the way
 * the example names its own — the example's name with the address swapped —
 * and the pointing record keeps the example's value unless the caller says
 * otherwise.
 */
export function baseDomain(fqdn: string, overrides: Partial<Domain> = {}): Domain {
  return {
    ...EXAMPLE_DOMAIN,
    fqdn,
    verification: {
      ...EXAMPLE_DOMAIN.verification,
      record_name: EXAMPLE_DOMAIN.verification.record_name.replace(EXAMPLE_DOMAIN.fqdn, fqdn),
    },
    target: { ...EXAMPLE_DOMAIN.target, record_name: fqdn },
    ...overrides,
  }
}

/** The long name of `mixedAddresses`, cut with an ellipsis in its column. */
export const LONG_HOST = 'reunions.groupe-acme-construction-batiment-et-travaux-publics.fr'

/**
 * Six addresses, one of each kind the list has to tell apart: the main
 * address, live; the address that carries its calls, live; one waiting for its
 * proof; one proven and being finished; one that failed; and one with a very
 * long name, waiting for its pointing record.
 */
export function mixedAddresses(): Domain[] {
  const issued = {
    state: 'issued' as const,
    issued_at: '2026-12-03T09:40:00Z',
    expires_at: '2027-03-03T09:40:00Z',
    days_left: 90,
    issuer: null,
    failure_code: null,
  }
  return [
    baseDomain('visio.acme.fr', {
      id: domainId(1),
      state: 'live',
      is_canonical: true,
      certificate: issued,
    }),
    baseDomain('livekit.visio.acme.fr', {
      id: domainId(2),
      role: 'media',
      state: 'live',
      // A documentation address (RFC 5737), the kind the contract's own
      // examples use: it can never be anybody's.
      target: {
        record_name: 'livekit.visio.acme.fr',
        record_type: 'A',
        record_value: '203.0.113.20',
        observed_value: '203.0.113.20',
      },
      certificate: issued,
    }),
    baseDomain('docs.acme.fr', {
      id: domainId(3),
      app: 'docs',
      state: 'nonce_issued',
      verification: {
        ...baseDomain('docs.acme.fr').verification,
        verified_at: null,
        checked_at: null,
        attempts: 0,
        resolvers_agreeing: null,
      },
    }),
    baseDomain('reunions.acme.fr', { id: domainId(4), state: 'txt_verified' }),
    baseDomain('visio.acme-travaux.fr', {
      id: domainId(5),
      state: 'failed',
      verification: {
        ...baseDomain('visio.acme-travaux.fr').verification,
        verified_at: null,
        failure_code: 'nonce_expired',
        resolvers_agreeing: 0,
      },
    }),
    baseDomain(LONG_HOST, { id: domainId(6), state: 'dns_pending' }),
  ]
}

export interface DomainsPage {
  data: Domain[]
  next_cursor: string | null
  has_more: boolean
}

/** One page of `domains`, cut the way a cursor API cuts it: `limit` rows from
 * the offset the cursor names. The cursor is opaque to the console; here it is
 * simply `offset-<n>`. */
export function pageOf(
  domains: readonly Domain[],
  cursor: string | null,
  limit: number
): DomainsPage {
  const start = cursor === null ? 0 : Number(cursor.replace(/^offset-/, ''))
  const end = start + limit
  const hasMore = end < domains.length
  return {
    data: domains.slice(start, end),
    next_cursor: hasMore ? `offset-${String(end)}` : null,
    has_more: hasMore,
  }
}

/** What the console asked for: the cursor, and the page size with the
 * contract's own default of 50 when none is sent. */
export function pageRequest(url: string): { cursor: string | null; limit: number } {
  const params = new URL(url).searchParams
  const limit = Number(params.get('limit') ?? '50')
  return { cursor: params.get('cursor'), limit: Number.isInteger(limit) && limit > 0 ? limit : 50 }
}
