// Display helpers shared by the People list and the member drawer.

import type { Locale } from '../../i18n/format'
import type { MessageKey } from '../../i18n'
import type { Membership } from './queries'
import type { OrganisationRole } from './roles'

export const ROLE_LABEL: Record<OrganisationRole, MessageKey> = {
  org_owner: 'console.people.list.status-role-owner',
  org_admin: 'console.people.list.status-role-admin',
  org_billing: 'console.people.list.status-role-billing',
  org_member: 'console.people.list.status-role-member',
}

/** The row menu's verb for each target role (§4.1). */
export const ROLE_ACTION: Record<OrganisationRole, MessageKey> = {
  org_owner: 'console.people.list.action-make-owner',
  org_admin: 'console.people.list.action-make-admin',
  org_billing: 'console.people.list.action-make-billing',
  org_member: 'console.people.list.action-make-member',
}

/** A pending invitation has no name yet; the address stands in for it. */
export function personName(membership: Pick<Membership, 'display_name' | 'email'>): string {
  const name = membership.display_name?.trim()
  if (name !== undefined && name.length > 0) return name
  return membership.email ?? ''
}

/** "aujourd'hui", "hier", "il y a 31 jours" — whole days against `now`. */
export function formatLastSeen(iso: string, now: number, locale: Locale): string {
  const day = 86_400_000
  const startOf = (ms: number) => Math.floor(ms / day)
  const days = startOf(Date.parse(iso)) - startOf(now)
  return new Intl.RelativeTimeFormat(locale === 'en' ? 'en-GB' : 'fr-FR', {
    numeric: 'auto',
  }).format(days, 'day')
}
