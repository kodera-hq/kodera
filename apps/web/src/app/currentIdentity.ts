import type { components } from '../api/schema'
import type { AuthIdentity } from '../auth/AuthAdapter'

type Me = components['schemas']['Me']
type Identity = Me['identities'][number]
type Membership = Me['organisations'][number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface CurrentIdentity {
  readonly identity: Identity
  readonly membership: Membership
}

/**
 * Resolve only the SDK-processed issuer/subject and its one current Core
 * relationship. This is a UI guard; Core remains the authorization authority.
 */
export function resolveCurrentIdentity(
  me: Me,
  active: AuthIdentity | undefined,
  organisationSlug: string
): CurrentIdentity | undefined {
  if (
    active === undefined ||
    typeof active.issuer !== 'string' ||
    active.issuer.length === 0 ||
    typeof active.subject !== 'string' ||
    active.subject.length === 0
  )
    return undefined

  const identities = me.identities.filter(
    (identity) => identity.issuer === active.issuer && identity.subject === active.subject
  )
  if (identities.length !== 1) return undefined
  const identity = identities[0]!
  if (!UUID.test(identity.id)) return undefined
  if (me.identities.filter((candidate) => candidate.id === identity.id).length !== 1)
    return undefined

  const memberships = me.organisations.filter(
    (candidate) => candidate.organisation.slug === organisationSlug
  )
  if (memberships.length !== 1) return undefined
  const membership = memberships[0]!
  if (
    !UUID.test(membership.membership_id) ||
    !UUID.test(membership.organisation.id) ||
    membership.identity_id !== identity.id ||
    membership.state !== 'active' ||
    me.organisations.filter((candidate) => candidate.membership_id === membership.membership_id)
      .length !== 1
  )
    return undefined

  return Object.freeze({ identity, membership })
}

export function isCurrentIdentityMfaEnrolled(
  me: Me,
  active: AuthIdentity | undefined,
  organisationSlug: string
): boolean {
  return resolveCurrentIdentity(me, active, organisationSlug)?.identity.mfa_enrolled === true
}
