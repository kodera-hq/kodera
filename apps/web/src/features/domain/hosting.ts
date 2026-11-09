// Everything the Domain area says or decides about how an instance is hosted,
// and the ONLY file of the area that does (docs/specs/domain-addresses-list.md,
// "One module for what depends on how an instance is hosted").
//
// A second hosting model and a change of provider are being studied. Which
// addresses come with an instance, what an address is for, whether a bare
// domain may be used, which records a customer must publish and where those
// records point may all differ between two instances, and may all change. So:
//
// - every fact here is read from what the Core API returned, never known in
//   advance: this file writes no IP address, no host name of ours, no
//   provider's name and no place, and neither does any other file of the area;
// - the contract fields that describe records and hosting are named here and
//   nowhere else in the area. A screen asks this file a question ("which
//   addresses are provided?", "what is this address for?") and draws the
//   answer.
//
// `tests/unit/domain/hosting-boundary.test.ts` holds both rules. The slices
// that show the records to publish, advise on a bare domain or explain a
// failed check add their functions to this file; a later change of hosting
// then lands here and not in a screen.

import type { components } from '../../api/schema'
import type { MessageKey } from '../../i18n'
import type { DomainState } from './domainStatus'

type Domain = components['schemas']['Domain']

/** What an address is for: the application itself, or the calls it carries. */
export type AddressPurpose = Domain['role']

/**
 * The words under the application's name when the purpose needs saying.
 * Exhaustive: a purpose the contract adds is a compile error here.
 */
export const PURPOSE_LABEL_KEY: Record<AddressPurpose, MessageKey | null> = {
  web: null,
  media: 'console.domain.list.label-role-media',
}

export function isAddressPurpose(value: unknown): value is AddressPurpose {
  return typeof value === 'string' && Object.hasOwn(PURPOSE_LABEL_KEY, value)
}

/** An address that comes with the instance: the host a person reads, and the
 * key the API files it under — an application code today. */
export interface ProvidedAddress {
  app: string
  host: string
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url.host.length > 0 ? url.host : null
}

/**
 * The addresses provided with an instance, in the API's own order, read from
 * the instance's `default_urls`. An instance that reports none has none: the
 * console does not make one up from the organisation's identifier. A value
 * that is not an address refuses the whole instance — a list that silently
 * dropped an address would be a list nobody could trust to be complete.
 */
export function providedAddresses(tenant: { default_urls?: unknown }): ProvidedAddress[] {
  const urls = tenant.default_urls
  if (urls === undefined) return []
  if (typeof urls !== 'object' || urls === null || Array.isArray(urls)) {
    throw new Error('The provided addresses of the instance are unavailable.')
  }
  return Object.entries(urls).map(([app, value]) => {
    const host = hostOf(value)
    if (host === null) throw new Error('A provided address of the instance is unavailable.')
    return { app, host }
  })
}

/** One line of the list: an address of the organisation's own, or one that
 * came with its instance. */
export type AddressRow =
  | {
      origin: 'organisation'
      key: string
      host: string
      app: string | null
      purpose: AddressPurpose
      state: DomainState
      /** The address the API names as the main one; the console names none. */
      main: boolean
    }
  | {
      origin: 'provided'
      key: string
      host: string
      app: string
    }

/**
 * The list, in the order it is read: the organisation's own addresses as the
 * API lists them, then the provided ones — which are always there, and are
 * what still answers while an address of the organisation's is being set up
 * (docs/specs/04-domain.md §4.1).
 *
 * A provided address carries no state: the API reports none for it, and a
 * state drawn from anything else would be the console's invention.
 */
export function addressRows(
  provided: readonly ProvidedAddress[],
  domains: readonly Domain[]
): AddressRow[] {
  return [
    ...domains.map((domain): AddressRow => ({
      origin: 'organisation',
      key: domain.id,
      host: domain.fqdn,
      app: domain.app ?? null,
      purpose: domain.role,
      state: domain.state,
      main: domain.is_canonical === true,
    })),
    ...provided.map((address): AddressRow => ({
      origin: 'provided',
      key: `provided:${address.app}`,
      host: address.host,
      app: address.app,
    })),
  ]
}
