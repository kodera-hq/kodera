// docs/specs/03-people.md §4.1, §4.2 and Core ADR-0010: which roles the UI
// offers a caller. These are UI safety constraints only — the Core API
// re-checks every write and remains the authority.

import type { components } from '../../api/schema'

export type OrganisationRole = components['schemas']['OrganisationRole']
export type InvitationRole = components['schemas']['InvitationRole']

/** Display order everywhere a role is chosen. */
const ORDER: readonly OrganisationRole[] = ['org_owner', 'org_admin', 'org_billing', 'org_member']

/** Owner is never granted by invitation or import; billing is owner-only. */
export function invitableRoles(caller: OrganisationRole): InvitationRole[] {
  if (caller === 'org_owner') return ['org_member', 'org_admin', 'org_billing']
  if (caller === 'org_admin') return ['org_member', 'org_admin']
  return []
}

/** The roles a row menu or the detail drawer offers, current role omitted. */
export function roleChangeTargets(
  caller: OrganisationRole,
  current: OrganisationRole
): OrganisationRole[] {
  if (caller === 'org_owner') return ORDER.filter((role) => role !== current)
  if (caller === 'org_admin' && (current === 'org_admin' || current === 'org_member')) {
    return current === 'org_admin' ? ['org_member'] : ['org_admin']
  }
  return []
}

/** An administrator may not alter owner or billing memberships. */
export function mayRemove(caller: OrganisationRole, target: OrganisationRole): boolean {
  if (caller === 'org_owner') return true
  if (caller === 'org_admin') return target === 'org_admin' || target === 'org_member'
  return false
}
