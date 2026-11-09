import type { components } from '../../api/schema'

export interface BillingProfile {
  name: string
  address: components['schemas']['BillingAddress'] | null
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Validate only the displayed profile, bound to the requested organisation. */
export function readBillingProfile(value: unknown, organisationId: string): BillingProfile {
  const fail = (): never => {
    throw new Error('Billing profile is unavailable.')
  }
  if (!object(value) || value.id !== organisationId || !text(value.name)) return fail()
  if (value.legal_name != null && !text(value.legal_name)) return fail()
  const name = (value.legal_name ?? value.name) as string
  const address = value.billing_address
  if (address == null) return { name, address: null }
  if (
    !object(address) ||
    !text(address.line1) ||
    !text(address.postal_code) ||
    !text(address.city) ||
    typeof address.country !== 'string' ||
    !/^[A-Z]{2}$/.test(address.country) ||
    (address.line2 != null && typeof address.line2 !== 'string')
  )
    return fail()
  return {
    name,
    address: {
      line1: address.line1,
      postal_code: address.postal_code,
      city: address.city,
      country: address.country,
      ...(address.line2 === undefined ? {} : { line2: address.line2 as string | null }),
    },
  }
}
