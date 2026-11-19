// Shared directory semantics for contract examples, People scenarios and the walkable demo.
import { HttpResponse } from 'msw/http'
import type { components } from '../api/schema'
import { PROBLEM_TITLES } from './generated/problems'

type Membership = components['schemas']['Membership']
type CallerRole = components['schemas']['OrganisationRole'] | 'staff_operator' | 'staff_support'

const cursors = new Map<string, { binding: string; offset: number }>()
const administrators = new Set<CallerRole>(['org_owner', 'org_admin'])
const queryKeys = new Set(['q', 'role', 'state', 'limit', 'cursor'])
const roles = new Set(['org_owner', 'org_admin', 'org_billing', 'org_member'])
const states = new Set(['invited', 'active', 'suspended', 'removed'])

// Directory query validation uses 400; body validation uses this type with 422 elsewhere.
function invalidQuery(): Response {
  const type = 'https://kodera.io/problems/validation-error'
  const requestId = crypto.randomUUID()
  return HttpResponse.json(
    { type, title: PROBLEM_TITLES[type], status: 400, request_id: requestId },
    {
      status: 400,
      headers: {
        'Content-Type': 'application/problem+json',
        'X-Request-Id': requestId,
        'Cache-Control': 'no-store',
      },
    }
  )
}

export function membershipDirectoryResponse(
  members: readonly Membership[],
  request: Request,
  callerRole: CallerRole,
  callerMembershipId: string,
  headers: Record<string, string> = {},
  defaultLimit = 50
): Response {
  const url = new URL(request.url)
  if (
    url.search.slice(1).length > 4096 ||
    [...url.searchParams].some(
      ([key, value]) =>
        !queryKeys.has(key) ||
        url.searchParams.getAll(key).length !== 1 ||
        (key !== 'q' && value === '')
    )
  ) {
    return invalidQuery()
  }
  const raw = url.searchParams.get('q') ?? ''
  const q = raw.trim().toLowerCase()
  if ([...raw].length > 200 || raw.includes('\0')) {
    return invalidQuery()
  }
  const role = url.searchParams.get('role')
  const state = url.searchParams.get('state')
  const rawLimit = url.searchParams.get('limit') ?? String(defaultLimit)
  if (
    !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
    rawLimit.trim() !== rawLimit ||
    Number(rawLimit) > 200 ||
    (role !== null && !roles.has(role)) ||
    (state !== null && !states.has(state))
  ) {
    return invalidQuery()
  }
  const limit = Number(rawLimit)
  const binding = JSON.stringify([
    url.pathname,
    callerRole,
    callerMembershipId,
    role,
    state,
    limit,
    q,
  ])
  const cursor = url.searchParams.get('cursor')
  const continuation = cursor === null ? undefined : cursors.get(cursor)
  if (cursor !== null && continuation?.binding !== binding) {
    return invalidQuery()
  }
  // Project before filtering: a withheld email cannot affect even the presence of a row.
  const rows = members
    .filter((m) => m.state !== 'removed')
    .map((m): Membership => {
      if (administrators.has(callerRole) || m.id === callerMembershipId) return m
      const {
        email: _email,
        identity_id: _identity,
        account_kind: _kind,
        mfa_enrolled: _mfa,
        last_seen_at: _seen,
        ...publicFacts
      } = m
      return publicFacts
    })
    .filter(
      (m) =>
        (role === null || m.role === role) &&
        (state === null || m.state === state) &&
        (q === '' ||
          (m.display_name ?? '').toLowerCase().includes(q) ||
          (m.email ?? '').toLowerCase().includes(q))
    )
  const start = continuation?.offset ?? 0
  const data = rows.slice(start, start + limit)
  const has_more = start + limit < rows.length
  const next_cursor = has_more ? crypto.randomUUID() : null
  if (next_cursor !== null) {
    cursors.set(next_cursor, { binding, offset: start + limit })
    if (cursors.size > 256) cursors.delete(cursors.keys().next().value!)
  }
  return HttpResponse.json(
    { data, has_more, next_cursor },
    { headers: { 'Cache-Control': 'no-store', ...headers } }
  )
}
