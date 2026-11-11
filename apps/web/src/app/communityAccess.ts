import type { components } from '../api/schema'
import type { AuthIdentity } from '../auth/AuthAdapter'
import { resolveCurrentIdentity } from './currentIdentity'

/** Community membership is verified by Core; tenant organisations remain issuer scoped. */
export function sessionCoversOrganisation(realm: string | undefined, slug: string): boolean {
  return realm !== undefined && (realm === slug || slug === 'community')
}

/** Verified-email public membership does not imply MFA enrollment or staff privileges. */
export function isPublicCommunityMember(
  me: components['schemas']['Me'],
  identity: AuthIdentity | undefined,
  slug: string
): boolean {
  return (
    !me.staff &&
    slug === 'community' &&
    resolveCurrentIdentity(me, identity, slug)?.membership.role === 'org_member'
  )
}
