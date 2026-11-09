import { describe, expect, it } from 'vitest'
import { DOMAIN_MANAGER_ROLES, canManageDomains } from './permissions'
import type { OrganisationRole } from './permissions'

describe('who may open the Domain area', () => {
  const verdicts: Record<OrganisationRole, boolean> = {
    org_owner: true,
    org_admin: true,
    org_billing: false,
    org_member: false,
  }

  it.each(Object.entries(verdicts) as [OrganisationRole, boolean][])('%s: %s', (role, allowed) => {
    expect(canManageDomains(role)).toBe(allowed)
  })

  it('is the list the route gate is given', () => {
    expect([...DOMAIN_MANAGER_ROLES].sort()).toEqual(['org_admin', 'org_owner'])
  })
})
