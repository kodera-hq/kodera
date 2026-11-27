import type { components } from '../api/schema'
import type { AuthIdentity } from '../auth/AuthAdapter'
import { resolveCurrentIdentity } from './currentIdentity'

export {
  rememberSharedRealmSlug,
  forgetSharedRealmSlug,
  isKnownSharedRealmSlug,
  clearKnownSharedRealmSlugs,
} from '../auth/sharedRealmHints'

/** Community and shared-realm PME memberships are verified by Core; dedicated tenants remain issuer scoped. */
export function sessionCoversOrganisation(
  realm: string | undefined,
  slug: string,
  sharedCommunity = true,
  sharedRealmOrg = false
): boolean {
  return (
    realm !== undefined &&
    (sharedRealmOrg
      ? realm === 'community'
      : realm === slug || (sharedCommunity && slug === 'community'))
  )
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

/** Cardless freemium PME workspaces on the shared realm exempt forced MFA so creation-to-chat is < 5 s. */
export function isSharedRealmFreemiumMember(
  me: components['schemas']['Me'],
  identity: AuthIdentity | undefined,
  slug: string
): boolean {
  if (me.staff || slug === 'community') return false
  const resolved = resolveCurrentIdentity(me, identity, slug)
  return (
    resolved !== undefined &&
    resolved.membership.shared_realm === true &&
    resolved.membership.plan_tier === 'freemium_pme'
  )
}
