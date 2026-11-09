import { describe, expect, it } from 'vitest'
import { readBillingProfile } from './billingProfile'

const address = {
  line1: '12 rue de la Paix',
  line2: null,
  postal_code: '75002',
  city: 'Paris',
  country: 'FR',
}
const organisation = { id: 'org-1', name: 'ACME', legal_name: 'ACME SAS', billing_address: address }

describe('billing profile consumer validation', () => {
  it('reads only the current organisation name and served billing address', () => {
    expect(readBillingProfile(organisation, 'org-1')).toEqual({ name: 'ACME SAS', address })
  })
  it('uses the display name and explicit empty address when optional fields are absent', () => {
    expect(readBillingProfile({ id: 'org-1', name: 'ACME' }, 'org-1')).toEqual({
      name: 'ACME',
      address: null,
    })
  })
  it.each([
    null,
    { ...organisation, id: 'other' },
    { ...organisation, name: null },
    { ...organisation, legal_name: [] },
    ...['line1', 'postal_code', 'city', 'country'].map((field) => ({
      ...organisation,
      billing_address: { ...address, [field]: null },
    })),
    { ...organisation, billing_address: { ...address, country: 'France' } },
    { ...organisation, billing_address: { ...address, line2: {} } },
  ])('refuses a foreign or unusable profile without exposing its values', (input) => {
    expect(() => readBillingProfile(input, 'org-1')).toThrow('Billing profile is unavailable.')
  })
})
