// Bounded projection of public Core JSON. This parser does not prove freshness,
// network provenance, worker ownership or permission to send a request.
const ME_BYTES = 262_144
const ENTRIES = 64
const encoder = new TextEncoder()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NIL = '00000000-0000-0000-0000-000000000000'
const ROLES = ['org_owner', 'org_admin', 'org_billing', 'org_member']
const STATES = ['invited', 'active', 'suspended', 'removed']

export interface DevicePrincipalSelection {
  readonly issuer: string
  readonly subject: string
  readonly organisationSlug: string
}
export interface DevicePrincipal extends DevicePrincipalSelection {
  readonly ownerId: string
  readonly identityId: string
  readonly organisationId: string
  readonly membershipId: string
}
export class DevicePrincipalError extends Error {
  constructor(readonly code: 'invalid-response' | 'ineligible') {
    super('Confidential device principal refused.')
    this.name = 'DevicePrincipalError'
  }
}
function fail(code: 'invalid-response' | 'ineligible' = 'invalid-response'): never {
  throw new DevicePrincipalError(code)
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail()
  if (encoder.encode(value).byteLength > maximum) fail()
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value) || value === NIL) fail()
  return value
}
function subject(value: unknown): string {
  const result = text(value, 255)
  for (let index = 0; index < result.length; index++) {
    if (result.charCodeAt(index) > 127) fail()
  }
  return result
}
function slug(value: unknown): string {
  const result = text(value, 64)
  if (/^[a-z0-9][a-z0-9-]{3,18}[a-z0-9]$/.exec(result)?.[0] !== result) fail()
  return result
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ENTRIES) fail()
  return value
}

/** Only the fixed dispatcher's bounded actual response can create a live cell. */
export function parseDevicePrincipal(
  json: string,
  selection: DevicePrincipalSelection,
  expected?: DevicePrincipal
): DevicePrincipal {
  try {
    text(json, ME_BYTES)
    const issuer = text(selection.issuer, 2048)
    const sdkSubject = subject(selection.subject)
    const organisationSlug = slug(selection.organisationSlug)
    const me = object(JSON.parse(json) as unknown)
    const ownerId = id(me.id)
    text(me.email, 320)
    if (me.display_name !== undefined && me.display_name !== null) text(me.display_name, 800, 0)
    if (typeof me.staff !== 'boolean') fail()
    if (me.staff) fail('ineligible')

    const identityIds = new Set<string>()
    let identityId: string | undefined
    for (const value of rows(me.identities)) {
      const identity = object(value)
      const candidateId = id(identity.id)
      const candidateIssuer = text(identity.issuer, 2048)
      const candidateSubject = subject(identity.subject)
      text(identity.realm, 64)
      text(identity.email, 320)
      if (identityIds.has(candidateId)) fail('ineligible')
      identityIds.add(candidateId)
      if (candidateIssuer === issuer && candidateSubject === sdkSubject) {
        if (identityId !== undefined) fail('ineligible')
        identityId = candidateId
      }
    }
    if (identityId === undefined) fail('ineligible')

    const membershipIds = new Set<string>()
    let selected: { organisationId: string; membershipId: string } | undefined
    for (const value of rows(me.organisations)) {
      const membership = object(value)
      const organisation = object(membership.organisation)
      const organisationId = id(organisation.id)
      const membershipId = id(membership.membership_id)
      const candidateSlug = slug(organisation.slug)
      text(organisation.name, 800)
      if (organisation.realm !== undefined && organisation.realm !== null) text(organisation.realm, 64)
      if (typeof membership.role !== 'string' || !ROLES.includes(membership.role) ||
          typeof membership.state !== 'string' || !STATES.includes(membership.state)) fail()
      if (membership.identity_id !== undefined) id(membership.identity_id)
      if (membershipIds.has(membershipId)) fail('ineligible')
      membershipIds.add(membershipId)
      if (candidateSlug === organisationSlug) {
        if (selected !== undefined || membership.state !== 'active' || membership.identity_id !== identityId)
          fail('ineligible')
        selected = { organisationId, membershipId }
      }
    }
    if (selected === undefined) fail('ineligible')
    const principal = Object.freeze({ ownerId, identityId, ...selected, issuer, subject: sdkSubject, organisationSlug })
    if (expected !== undefined && (
      principal.ownerId !== expected.ownerId || principal.identityId !== expected.identityId ||
      principal.organisationId !== expected.organisationId || principal.membershipId !== expected.membershipId ||
      principal.issuer !== expected.issuer || principal.subject !== expected.subject ||
      principal.organisationSlug !== expected.organisationSlug
    )) fail('ineligible')
    return principal
  } catch (error) {
    if (error instanceof DevicePrincipalError) throw error
    throw new DevicePrincipalError('invalid-response')
  }
}
