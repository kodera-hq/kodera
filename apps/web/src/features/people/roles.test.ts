import { describe, expect, it } from 'vitest'
import { invitableRoles, mayRemove, roleChangeTargets } from './roles'

describe('people role rules (03-people.md §4.1, §4.2, ADR-0010)', () => {
  it('lets an owner invite members, administrators and billing, never owners', () => {
    expect(invitableRoles('org_owner')).toEqual(['org_member', 'org_admin', 'org_billing'])
  })

  it('lets an administrator invite members and administrators only', () => {
    expect(invitableRoles('org_admin')).toEqual(['org_member', 'org_admin'])
  })

  it('offers an owner every other role for any member', () => {
    expect(roleChangeTargets('org_owner', 'org_member')).toEqual([
      'org_owner',
      'org_admin',
      'org_billing',
    ])
    expect(roleChangeTargets('org_owner', 'org_billing')).toEqual([
      'org_owner',
      'org_admin',
      'org_member',
    ])
  })

  it('lets an administrator move only between administrator and member', () => {
    expect(roleChangeTargets('org_admin', 'org_member')).toEqual(['org_admin'])
    expect(roleChangeTargets('org_admin', 'org_admin')).toEqual(['org_member'])
    expect(roleChangeTargets('org_admin', 'org_billing')).toEqual([])
    expect(roleChangeTargets('org_admin', 'org_owner')).toEqual([])
  })

  it('lets an administrator remove only administrators and members', () => {
    expect(mayRemove('org_admin', 'org_member')).toBe(true)
    expect(mayRemove('org_admin', 'org_admin')).toBe(true)
    expect(mayRemove('org_admin', 'org_billing')).toBe(false)
    expect(mayRemove('org_admin', 'org_owner')).toBe(false)
    expect(mayRemove('org_owner', 'org_owner')).toBe(true)
  })

  it('grants nothing to members or billing callers', () => {
    expect(invitableRoles('org_member')).toEqual([])
    expect(roleChangeTargets('org_billing', 'org_member')).toEqual([])
    expect(mayRemove('org_member', 'org_member')).toBe(false)
  })
})
