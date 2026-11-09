// Who may see the Invoices area (docs/specs/05-invoices.md §5, state matrix
// "Permission denied" row: "`member` does not see the area; direct URL shows
// the role banner naming the owner"). Checked once, from the role `GET /me`
// already returned to `orgRoute` — no extra Core API call.
//
// `org_billing` is included per docs/specs/README.md §5 ("`billing` reads
// and pays invoices and holds no right over people"), even though this
// area's own error copy (`console.invoices._.error-role`) names only the
// owner and administrators — see the report for this unit: the generic
// fallback copy (`error-role-generic`) is worded to cover both without
// contradicting either.

import type { components } from '../../api/schema'

export type OrganisationRole = components['schemas']['OrganisationRole']

const ALLOWED: ReadonlySet<OrganisationRole> = new Set<OrganisationRole>([
  'org_owner',
  'org_admin',
  'org_billing',
])

export function canViewInvoices(role: OrganisationRole): boolean {
  return ALLOWED.has(role)
}

/** Invoice reading does not grant payment-link operations. */
export function canPayInvoices(role: OrganisationRole): boolean {
  return role === 'org_owner' || role === 'org_billing'
}
