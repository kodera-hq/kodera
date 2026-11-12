// Display helpers shared by the People list and the member drawer.

import type { TFunction } from 'i18next'
import type { Locale } from '../../i18n/format'
import type { MessageKey } from '../../i18n'
import type { Membership, MembershipState } from './queries'
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

/** A membership's stored state, in words. Never private: Core says it of every row. */
export const STATE_LABEL: Record<MembershipState, MessageKey> = {
  invited: 'console.people.list.status-invited',
  active: 'console.people.list.status-active',
  suspended: 'console.people.list.status-suspended',
  removed: 'console.people.list.status-removed',
}

/**
 * Whether the caller manages the organisation's people: an owner or an administrator. Core
 * discloses every row's private member facts to them, and to no other role (contract 0.42.0,
 * « Directory privacy »), so this also decides which projection of the list is drawn: the
 * directory, with addresses and sign-ins, or the colleagues' list, with names, roles and states.
 */
export function managesPeople(callerRole: OrganisationRole): boolean {
  return callerRole === 'org_owner' || callerRole === 'org_admin'
}

/**
 * Whether Core discloses a row's private member facts to the caller: the address, the last
 * sign-in, the kind of account, the second factor, the identity. It does on the caller's own row,
 * and on every row for a caller who manages people. On any other row they are withheld, omitted
 * or `null` alike, and a withheld fact says nothing about the person: a missing address is not «
 * no address », a missing sign-in is not « never signed in ». What is drawn for such a row is
 * decided here, from who is asking, never from the fact's absence.
 */
export function seesPrivateFacts(
  callerRole: OrganisationRole,
  callerMembershipId: string | undefined,
  membershipId: string
): boolean {
  return managesPeople(callerRole) || membershipId === callerMembershipId
}

/** A non-empty address, or nothing: withheld, omitted, `null` and empty are one case. */
export function disclosedEmail(membership: Pick<Membership, 'email'>): string | undefined {
  const email = membership.email?.trim()
  return email === undefined || email.length === 0 ? undefined : email
}

/**
 * The name a person is known by: the one they chose, else their address when Core discloses one
 * (a pending invitation has no name yet; the address stands in for it). Empty when Core gives
 * neither, as for a colleague's pending invitation read by a member: `personLabel` then.
 */
export function personName(membership: Pick<Membership, 'display_name' | 'email'>): string {
  const name = membership.display_name?.trim()
  if (name !== undefined && name.length > 0) return name
  return disclosedEmail(membership) ?? ''
}

/**
 * What a person is called on screen, never empty: their name, else their disclosed address, else
 * the words the catalogue keeps for a person with neither (« Personne sans nom affiché »). A row,
 * a button or a dialog title drawn with no words at all reads as a fault. The words say what the
 * caller is shown, not what the person has: a withheld address is not a missing one.
 */
export function personLabel(
  membership: Pick<Membership, 'display_name' | 'email'>,
  t: TFunction
): string {
  const name = personName(membership)
  return name.length > 0 ? name : t('console.people.list.label-unnamed')
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
