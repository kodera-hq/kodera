// Session-scoped People state for interactive local workspaces only.
import { HttpResponse } from 'msw'
import type { components } from '../../api/schema'
import { problem } from '../problem'

type Membership = components['schemas']['Membership']
type Invitation = components['schemas']['Invitation']
type Batch = components['schemas']['InvitationBatchResult']
interface PeopleState {
  members: Membership[]
  invitations: Invitation[]
  versions: Record<string, number>
  replays: Record<string, { signature: string; response: Batch | Invitation }>
}
const memory = new Map<string, PeopleState>()
const prefix = 'kodera.demo.people.'
export function readPeopleState(id: string, initial: Membership[]): PeopleState {
  const fresh = (): PeopleState => ({
    members: initial,
    invitations: [],
    versions: {},
    replays: {},
  })
  try {
    const stored = sessionStorage.getItem(prefix + id)
    if (!stored) return fresh()
    const value: unknown = JSON.parse(stored)
    if (value && typeof value === 'object') {
      const state = value as PeopleState
      if (
        Array.isArray(state.members) &&
        state.members.every((member) => member.organisation_id === id) &&
        Array.isArray(state.invitations) &&
        state.invitations.every((invitation) => invitation.organisation_id === id) &&
        state.versions &&
        state.replays
      )
        return state
    }
  } catch {
    return memory.get(id) ?? fresh()
  }
  return fresh()
}
function savePeopleState(id: string, state: PeopleState) {
  memory.set(id, state)
  try {
    sessionStorage.setItem(prefix + id, JSON.stringify(state))
  } catch {
    /* Keep the in-memory fallback. */
  }
}
export function peopleEtag(state: PeopleState, id: string) {
  return `"${id}-${state.versions[id] ?? 1}"`
}
const responseHeaders = (etag?: string) => ({
  'X-Request-Id': crypto.randomUUID(),
  ...(etag ? { ETag: etag } : {}),
})
export function memberDetail(state: PeopleState, memberId: string, selfId: string) {
  const found = state.members.find((member) => member.id === memberId)
  if (!found) return problem('https://kodera.io/problems/not-found')
  const self = found.id === selfId
  const lastOwner =
    found.role === 'org_owner' &&
    state.members.filter((member) => member.role === 'org_owner' && member.state === 'active')
      .length <= 1
  return HttpResponse.json(
    {
      ...found,
      can_change_role: !self && !lastOwner,
      can_remove: !self && !lastOwner,
      blocked_reason: self ? 'self' : lastOwner ? 'last_owner' : null,
      invitation_id: null,
    },
    { headers: responseHeaders(peopleEtag(state, memberId)) }
  )
}
export async function mutateMember(
  id: string,
  state: PeopleState,
  memberId: string,
  selfId: string,
  request: Request
) {
  const found = state.members.find((member) => member.id === memberId)
  if (!found) return problem('https://kodera.io/problems/not-found')
  if (found.id === selfId) return problem('https://kodera.io/problems/forbidden')
  if (
    found.role === 'org_owner' &&
    state.members.filter((member) => member.role === 'org_owner' && member.state === 'active')
      .length <= 1
  )
    return problem('https://kodera.io/problems/last-owner-protected')
  const current = peopleEtag(state, memberId)
  const supplied = request.headers.get('If-Match')
  if (supplied !== null && supplied !== current)
    return problem('https://kodera.io/problems/precondition-failed', { currentEtag: current })
  if (request.method === 'DELETE') {
    state.members = state.members.filter((member) => member.id !== memberId)
    savePeopleState(id, state)
    const { email: _email, display_name: _name, ...removed } = { ...found, state: 'removed' }
    return HttpResponse.json(removed, { headers: responseHeaders() })
  }
  const body = (await request.json().catch(() => null)) as {
    role?: Membership['role']
    state?: Membership['state']
  } | null
  if (
    !body ||
    (body.role !== undefined &&
      !['org_owner', 'org_admin', 'org_billing', 'org_member'].includes(body.role)) ||
    (body.state !== undefined && !['active', 'suspended'].includes(body.state))
  )
    return problem('https://kodera.io/problems/malformed-request')
  if (body.role !== undefined) found.role = body.role
  if (body.state !== undefined) found.state = body.state
  found.updated_at = new Date().toISOString()
  state.versions[memberId] = (state.versions[memberId] ?? 1) + 1
  savePeopleState(id, state)
  return HttpResponse.json(found, { headers: responseHeaders(peopleEtag(state, memberId)) })
}
export async function invitePeople(
  id: string,
  realm: string,
  state: PeopleState,
  selfId: string,
  request: Request
) {
  const key = request.headers.get('Idempotency-Key')
  if (!key) return problem('https://kodera.io/problems/idempotency-key-missing')
  const body = (await request.json().catch(() => null)) as {
    invitations?: { email: string; role?: components['schemas']['InvitationRole'] }[]
  } | null
  if (!body || !Array.isArray(body.invitations))
    return problem('https://kodera.io/problems/malformed-request')
  const signature = JSON.stringify(body)
  const replay = state.replays[`invite:${key}`]
  if (replay)
    return replay.signature === signature
      ? HttpResponse.json(replay.response, { status: 201, headers: responseHeaders() })
      : problem('https://kodera.io/problems/idempotency-key-reuse')
  const result: Batch = { created: 0, skipped: 0, failed: 0, results: [] }
  for (const row of body.invitations) {
    const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : ''
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      (row.role !== undefined && !['org_admin', 'org_billing', 'org_member'].includes(row.role))
    ) {
      result.failed++
      result.results.push({ email, outcome: 'invalid_email', invitation: null })
      continue
    }
    if (state.members.some((member) => member.email?.toLowerCase() === email)) {
      result.skipped++
      result.results.push({ email, outcome: 'already_member', invitation: null })
      continue
    }
    if (
      state.invitations.some(
        (invitation) => invitation.email.toLowerCase() === email && invitation.state === 'pending'
      )
    ) {
      result.skipped++
      result.results.push({ email, outcome: 'already_invited', invitation: null })
      continue
    }
    const now = new Date().toISOString()
    const invitation: Invitation = {
      id: crypto.randomUUID(),
      organisation_id: id,
      email,
      role: row.role ?? 'org_member',
      state: 'pending',
      realm,
      invited_by: selfId,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      accepted_at: null,
      membership_id: null,
      sent_count: 1,
      last_sent_at: now,
      created_at: now,
    }
    state.invitations.push(invitation)
    result.created++
    result.results.push({ email, outcome: 'created', invitation })
  }
  state.replays[`invite:${key}`] = { signature, response: result }
  savePeopleState(id, state)
  return HttpResponse.json(result, { status: 201, headers: responseHeaders() })
}
export function mutateInvitation(
  id: string,
  state: PeopleState,
  invitationId: string,
  request: Request
) {
  const found = state.invitations.find((invitation) => invitation.id === invitationId)
  if (!found) return problem('https://kodera.io/problems/not-found')
  if (request.method === 'DELETE') {
    state.invitations = state.invitations.filter((invitation) => invitation.id !== invitationId)
    savePeopleState(id, state)
    return new HttpResponse(null, { status: 204, headers: responseHeaders() })
  }
  const key = request.headers.get('Idempotency-Key')
  if (!key) return problem('https://kodera.io/problems/idempotency-key-missing')
  const replayKey = `resend:${invitationId}:${key}`
  if (state.replays[replayKey])
    return HttpResponse.json(state.replays[replayKey].response, { headers: responseHeaders() })
  found.sent_count = (found.sent_count ?? 1) + 1
  found.last_sent_at = new Date().toISOString()
  state.replays[replayKey] = { signature: invitationId, response: { ...found } }
  savePeopleState(id, state)
  return HttpResponse.json(found, { headers: responseHeaders() })
}
