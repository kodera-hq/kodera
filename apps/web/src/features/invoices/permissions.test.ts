import { describe, expect, it } from 'vitest'
import { canViewInvoices } from './permissions'

describe('canViewInvoices', () => {
  it('allows the owner, administrators and the billing role', () => {
    expect(canViewInvoices('org_owner')).toBe(true)
    expect(canViewInvoices('org_admin')).toBe(true)
    expect(canViewInvoices('org_billing')).toBe(true)
  })

  it('refuses a plain member', () => {
    expect(canViewInvoices('org_member')).toBe(false)
  })
})
