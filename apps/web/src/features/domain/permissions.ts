// Every decision the Domain area takes from a role, and the only file of the
// area that takes one (docs/specs/domain-addresses-list.md). The slices that
// add, check, activate or remove an address add their own functions here
// rather than comparing a role where they render.
//
// These are presentation rules: they decide what the console draws. The Core
// API authorises every request whatever the console drew.

import type { components } from '../../api/schema'

export type OrganisationRole = components['schemas']['OrganisationRole']

/**
 * Who may open the area (docs/specs/04-domain.md §5, "Permission denied":
 * "`member` does not see the area"). The same two roles `src/app/Sidebar.tsx`
 * shows the navigation item to. The contract lets a member read domains; the
 * console is stricter, and consistent with its own navigation.
 */
export const DOMAIN_MANAGER_ROLES: readonly OrganisationRole[] = ['org_owner', 'org_admin']

export function canManageDomains(role: OrganisationRole): boolean {
  return DOMAIN_MANAGER_ROLES.includes(role)
}
