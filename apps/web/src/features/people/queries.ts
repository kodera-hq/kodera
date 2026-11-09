// docs/specs/03-people.md §6: the People reads and writes, through the
// generated Core client. Writes go through `mutate` (Idempotency-Key on a
// POST, If-Match on a PATCH, `ApiProblem` on a refusal); the CSV upload is
// the contract's only multipart body and posts through the client directly.

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { coreApi } from '../../api/client'
import { offers } from '../../app/capabilities'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'
import { fetchMembership } from './memberActions'
import type { InvitationRole, OrganisationRole } from './roles'

export type Membership = components['schemas']['Membership']
export type MembershipDetail = components['schemas']['MembershipDetail']
export type MembershipState = components['schemas']['MembershipState']
export type Invitation = components['schemas']['Invitation']
export type InvitationBatchResult = components['schemas']['InvitationBatchResult']
export type EnrolmentToken = components['schemas']['EnrolmentToken']
export type EnrolmentTokenCreated = components['schemas']['EnrolmentTokenCreated']
export type MemberImport = components['schemas']['MemberImport']

export const PAGE_SIZE = 25

interface CursorPage<T> {
  data: T[]
  next_cursor?: string | null
  has_more: boolean
}

function required<T>(data: T | undefined, call: string): T {
  if (data === undefined) throw new Error(`${call} resolved with no body.`)
  return data
}

function page<T>(data: { data?: T[]; next_cursor?: string | null; has_more?: boolean }) {
  if (!Array.isArray(data.data) || typeof data.has_more !== 'boolean') {
    throw new Error('People pagination response is unavailable.')
  }
  return { data: data.data, next_cursor: data.next_cursor ?? null, has_more: data.has_more }
}

export type MemberFilter = 'all' | 'admins' | 'pending'

const FILTER_QUERY: Record<MemberFilter, { role?: OrganisationRole; state?: MembershipState }> = {
  all: {},
  admins: { role: 'org_admin' },
  pending: { state: 'invited' },
}

export const peopleKeys = {
  all: (organisationId: string) => ['people', organisationId] as const,
  members: (organisationId: string, filter: MemberFilter) =>
    ['people', organisationId, 'members', filter] as const,
  count: (organisationId: string, group: string) =>
    ['people', organisationId, 'count', group] as const,
  member: (organisationId: string, membershipId: string) =>
    ['people', organisationId, 'member', membershipId] as const,
  invitations: (organisationId: string) => ['people', organisationId, 'invitations'] as const,
  tokens: (organisationId: string) => ['people', organisationId, 'enrolment-tokens'] as const,
  memberImport: (importId: string) => ['people', 'member-import', importId] as const,
}

export function useMembershipsQuery(organisationId: string, filter: MemberFilter) {
  return useInfiniteQuery({
    queryKey: peopleKeys.members(organisationId, filter),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<CursorPage<Membership>> => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/memberships', {
        params: {
          path: { organisation_id: organisationId },
          query: {
            limit: PAGE_SIZE,
            ...FILTER_QUERY[filter],
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        },
      })
      return page(required(data, 'GET /organisations/{id}/memberships'))
    },
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
  })
}

/** §4.1: the subtitle counts three groups, one call each, never summed here. */
export const COUNT_GROUPS = {
  members: { state: 'active' },
  admins: { role: 'org_admin' },
  invitations: { state: 'invited' },
} as const satisfies Record<string, { role?: OrganisationRole; state?: MembershipState }>

export function useMembershipCountQuery(organisationId: string, group: keyof typeof COUNT_GROUPS) {
  return useQuery({
    queryKey: peopleKeys.count(organisationId, group),
    queryFn: async () => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/memberships/count', {
        params: { path: { organisation_id: organisationId }, query: COUNT_GROUPS[group] },
      })
      return required(data, 'GET /organisations/{id}/memberships/count').count
    },
  })
}

export interface Tagged<T> {
  value: T
  etag: string
}

export function useMembershipQuery(organisationId: string, membershipId: string) {
  return useQuery({
    queryKey: peopleKeys.member(organisationId, membershipId),
    queryFn: () => fetchMembership(organisationId, membershipId),
  })
}

export function useInvitationsQuery(organisationId: string) {
  return useInfiniteQuery({
    queryKey: peopleKeys.invitations(organisationId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<CursorPage<Invitation>> => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/invitations', {
        params: {
          path: { organisation_id: organisationId },
          query: {
            state: 'pending',
            limit: PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        },
      })
      return page(required(data, 'GET /organisations/{id}/invitations'))
    },
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
  })
}

async function enrolmentTokenPage(
  organisationId: string,
  cursor: string | null
): Promise<CursorPage<EnrolmentToken>> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/enrolment-tokens', {
    params: {
      path: { organisation_id: organisationId },
      query: { state: 'active', limit: TOKEN_PAGE_SIZE, ...(cursor === null ? {} : { cursor }) },
    },
  })
  return page(required(data, 'GET /organisations/{id}/enrolment-tokens'))
}

/** Active sheets are few; the list reads every page, bounded against a cursor loop. */
const TOKEN_PAGE_SIZE = 100
const TOKEN_MAX_PAGES = 20

export function useEnrolmentTokensQuery(organisationId: string) {
  return useQuery({
    queryKey: peopleKeys.tokens(organisationId),
    // Never fetched while Core does not serve it (`src/app/capabilities.ts`).
    enabled: offers('on-site-enrolment'),
    queryFn: async () => {
      const tokens: EnrolmentToken[] = []
      let cursor: string | null = null
      for (let pages = 0; pages < TOKEN_MAX_PAGES; pages += 1) {
        const current: CursorPage<EnrolmentToken> = await enrolmentTokenPage(organisationId, cursor)
        tokens.push(...current.data)
        const next = current.next_cursor ?? null
        if (!current.has_more || next === null) break
        cursor = next
      }
      return tokens
    },
  })
}

/** Every People read is stale after any People write. */
export function useInvalidatePeople(organisationId: string) {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: peopleKeys.all(organisationId) })
}

/** A role change, a suspension (`suspended`) or a reactivation (`active`): one `PATCH`, under
 * the tag of a read made just before it. */
export function changeMembership(
  organisationId: string,
  membership: Tagged<MembershipDetail>,
  change: { role?: OrganisationRole; state?: 'active' | 'suspended' }
) {
  return mutate(
    { method: 'patch', path: '/organisations/{organisation_id}/memberships/{membership_id}' },
    {
      params: {
        path: { organisation_id: organisationId, membership_id: membership.value.id },
      },
      body: change,
      concurrency: membership.etag,
    }
  )
}

export function changeRole(
  organisationId: string,
  membership: Tagged<MembershipDetail>,
  role: OrganisationRole
) {
  return changeMembership(organisationId, membership, { role })
}

/** Removal answers the removed membership. `If-Match` is optional for Core, and always sent
 * here: a removal decided on what someone else has since changed is refused (`412`). */
export function removeMembership(organisationId: string, membership: Tagged<MembershipDetail>) {
  return mutate(
    { method: 'delete', path: '/organisations/{organisation_id}/memberships/{membership_id}' },
    {
      params: {
        path: { organisation_id: organisationId, membership_id: membership.value.id },
      },
      concurrency: membership.etag,
    }
  )
}

export function inviteBatch(
  organisationId: string,
  invitations: { email: string; role: InvitationRole }[],
  idempotencyKey: string
) {
  return mutate(
    { method: 'post', path: '/organisations/{organisation_id}/invitations' },
    {
      // One key per intent: a retry of the same addresses after a network
      // failure must not create a second batch.
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body: { invitations, send_email: true, locale: 'fr' },
    }
  )
}

export function resendInvitation(invitationId: string, idempotencyKey: string) {
  return mutate(
    { method: 'post', path: '/invitations/{invitation_id}/actions/resend' },
    {
      params: {
        path: { invitation_id: invitationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
    }
  )
}

export function revokeInvitation(invitationId: string) {
  return mutate(
    { method: 'delete', path: '/invitations/{invitation_id}' },
    { params: { path: { invitation_id: invitationId } } }
  )
}
