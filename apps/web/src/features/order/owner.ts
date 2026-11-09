import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import type { components } from '../../api/schema'

export interface OrderOwner {
  readonly issuer: string
  readonly subject: string
  readonly organisationId: string
  readonly membershipId: string
  readonly identityId: string
  readonly generation: number
}

interface OrderOwnerInput {
  session: AuthSessionSnapshot
  /** Core snapshot with its captured generation; this resolver does not refetch. */
  me: components['schemas']['Me']
  meGeneration: number
  organisationId: string
  membershipId: string
}

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** Browser draft ownership only. Core remains authoritative for every operation. */
export function resolveOrderOwner({
  session,
  me,
  meGeneration,
  organisationId,
  membershipId,
}: OrderOwnerInput): OrderOwner | undefined {
  const active = session.user?.identity
  if (
    session.status !== 'ready' ||
    active === undefined ||
    session.generation !== meGeneration ||
    !isUuid(organisationId) ||
    !isUuid(membershipId)
  )
    return undefined

  const identities = me.identities.filter(
    (identity) => identity.issuer === active.issuer && identity.subject === active.subject
  )
  const identity = identities[0]
  if (
    identities.length !== 1 ||
    identity === undefined ||
    !isUuid(identity.id) ||
    me.identities.filter((candidate) => candidate.id === identity.id).length !== 1
  )
    return undefined

  const memberships = me.organisations.filter(
    (membership) => membership.organisation.id === organisationId
  )
  const membership = memberships[0]
  if (
    memberships.length !== 1 ||
    membership === undefined ||
    membership.membership_id !== membershipId ||
    membership.state !== 'active' ||
    membership.identity_id !== identity.id ||
    me.organisations.filter((candidate) => candidate.membership_id === membershipId).length !== 1
  )
    return undefined

  return Object.freeze({
    issuer: active.issuer,
    subject: active.subject,
    organisationId,
    membershipId,
    identityId: identity.id,
    generation: session.generation,
  })
}
