import type { AuthSessionSnapshot } from '../../auth/AuthAdapter'
import type { components } from '../../api/schema'
import { resolveOrderOwner, type OrderOwner } from '../order/owner'
import { invitableRoles, type InvitationRole, type OrganisationRole } from './roles'

export const INVITATION_RECOVERY_KEY = 'kodera.web.people.invitationRecovery'
const TTL_MS = 600_000
const MAX_TEXT_BYTES = 65_536
// JSON can expand each permitted text byte to six bytes; metadata is bounded.
const MAX_ENVELOPE_LENGTH = MAX_TEXT_BYTES * 6 + 16_384
let consumedRaw: string | undefined
export interface InvitationOwner extends OrderOwner {
  readonly role: OrganisationRole
}
export interface InvitationDraft {
  text: string
  role: InvitationRole
  open: true
}
export interface InvitationSnapshot {
  readonly raw: string
  readonly draft: InvitationDraft
}
type Me = components['schemas']['Me']

export function resolveInvitationOwner(input: {
  session: AuthSessionSnapshot
  me: Me
  meGeneration: number
  organisationId: string
  membershipId: string
  credential: boolean
}): InvitationOwner | undefined {
  if (!input.credential) return undefined
  const owner = resolveOrderOwner(input)
  const membership = input.me.organisations.find(
    (entry) => entry.membership_id === input.membershipId
  )
  if (
    owner === undefined ||
    membership === undefined ||
    invitableRoles(membership.role).length === 0
  )
    return undefined
  return Object.freeze({ ...owner, role: membership.role })
}

/** Expired form saving retains committed provenance; reading still needs fresh authority. */
export function canSaveInvitation(owner: InvitationOwner, session: AuthSessionSnapshot): boolean {
  return (
    session.status === 'ready' &&
    session.generation === owner.generation &&
    session.user?.identity?.issuer === owner.issuer &&
    session.user.identity.subject === owner.subject
  )
}

const ownerKeys = ['issuer', 'subject', 'organisationId', 'membershipId', 'identityId'] as const
function persistedOwner(owner: InvitationOwner) {
  return {
    issuer: owner.issuer,
    subject: owner.subject,
    organisationId: owner.organisationId,
    membershipId: owner.membershipId,
    identityId: owner.identityId,
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function validOwner(value: unknown): value is ReturnType<typeof persistedOwner> {
  if (!record(value) || !exact(value, ownerKeys)) return false
  if (
    typeof value.issuer !== 'string' ||
    value.issuer.length === 0 ||
    value.issuer.length > 4096 ||
    typeof value.subject !== 'string' ||
    value.subject.length === 0 ||
    value.subject.length > 1024
  )
    return false
  return ['organisationId', 'membershipId', 'identityId'].every(
    (key) =>
      typeof value[key] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[key])
  )
}
function sameOwner(saved: ReturnType<typeof persistedOwner>, current: InvitationOwner): boolean {
  return ownerKeys.every((key) => saved[key] === current[key])
}
function validDraft(value: unknown, owner: InvitationOwner): value is InvitationDraft {
  return (
    record(value) &&
    exact(value, ['text', 'role', 'open']) &&
    value.open === true &&
    typeof value.text === 'string' &&
    new TextEncoder().encode(value.text).byteLength <= MAX_TEXT_BYTES &&
    invitableRoles(owner.role).includes(value.role as InvitationRole)
  )
}
function removeRaw(raw: string): boolean {
  try {
    if (window.sessionStorage.getItem(INVITATION_RECOVERY_KEY) !== raw) return true
    return clearInvitation()
  } catch {
    return false
  }
}
/** A refusal to erase recovery must be known before an operation can start. */
export function clearInvitation(): boolean {
  try {
    window.sessionStorage.removeItem(INVITATION_RECOVERY_KEY)
    return true
  } catch {
    try {
      // Invalidating the same slot adds no second store or private field.
      window.sessionStorage.setItem(INVITATION_RECOVERY_KEY, 'null')
      return true
    } catch {
      return false
    }
  }
}
export function saveInvitation(
  owner: InvitationOwner,
  draft: InvitationDraft,
  now = Date.now()
): void {
  try {
    const metadata = persistedOwner(owner)
    if (
      !validOwner(metadata) ||
      !validDraft(draft, owner) ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      clearInvitation()
      return
    }
    window.sessionStorage.setItem(
      INVITATION_RECOVERY_KEY,
      JSON.stringify({
        version: 1,
        purpose: 'people-invitation',
        savedAt: now,
        owner: metadata,
        draft,
      })
    )
    consumedRaw = undefined
  } catch {
    /* No alternate store and no private-value logs. */
  }
}
export function readInvitation(
  owner: InvitationOwner | undefined,
  now = Date.now()
): InvitationSnapshot | undefined {
  // Caller resolves the current SDK/Core authority before any private slot read.
  if (owner === undefined) return undefined
  let raw: string | null
  try {
    raw = window.sessionStorage.getItem(INVITATION_RECOVERY_KEY)
  } catch {
    return undefined
  }
  if (raw === null || raw === consumedRaw) return undefined
  try {
    const value: unknown = raw.length <= MAX_ENVELOPE_LENGTH ? JSON.parse(raw) : undefined
    if (
      !record(value) ||
      !exact(value, ['version', 'purpose', 'savedAt', 'owner', 'draft']) ||
      value.version !== 1 ||
      value.purpose !== 'people-invitation' ||
      typeof value.savedAt !== 'number' ||
      !Number.isSafeInteger(value.savedAt) ||
      value.savedAt < 0 ||
      value.savedAt > now ||
      now - value.savedAt >= TTL_MS ||
      !validOwner(value.owner) ||
      !sameOwner(value.owner, owner) ||
      !validDraft(value.draft, owner)
    ) {
      removeRaw(raw)
      return undefined
    }
    return { raw, draft: value.draft }
  } catch {
    removeRaw(raw)
    return undefined
  }
}
export function consumeInvitation(snapshot: InvitationSnapshot): void {
  // Even if both writes fail, ordinary close must not reopen this exact snapshot
  // in this document. Durable invalidation separately gates every actual batch.
  consumedRaw = snapshot.raw
  removeRaw(snapshot.raw)
}
