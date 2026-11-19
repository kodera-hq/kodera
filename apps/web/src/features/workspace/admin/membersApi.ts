// The organisation directory as the administration reads and changes it. The settings are
// mounted on every route, where the People area's message namespace is not loaded, so this module
// speaks to Core directly and leaves every sentence to `adminMessages`.
//
// A role change is a PATCH under the tag of a fresh read (CONVENTIONS §10): a row that moved since
// it was drawn is not changed, and Core refuses to demote the last owner.

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ApiProblem, coreApi } from '../../../api/client'
import { mutate } from '../../../api/mutations'
import type { components } from '../../../api/schema'
import type { OrganisationRole } from '../../people/roles'

export type Membership = components['schemas']['Membership']
export type MembershipDetail = components['schemas']['MembershipDetail']

const PAGE_SIZE = 25

export const directoryKeys = {
  all: (organisationId: string) => ['workspace-admin-directory', organisationId] as const,
  list: (organisationId: string, query: string) =>
    ['workspace-admin-directory', organisationId, query.trim().toLowerCase()] as const,
}

/** The directory, searched by Core (`q`) and paged by its cursor. Removed people are left out. */
export function useDirectory(organisationId: string, query = '') {
  const queryKey = directoryKeys.list(organisationId, query)
  const q = queryKey[2]
  return useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data } = await coreApi().GET('/organisations/{organisation_id}/memberships', {
        signal,
        params: {
          path: { organisation_id: organisationId },
          query: {
            limit: PAGE_SIZE,
            ...(q === '' ? {} : { q }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        },
      })
      if (data === undefined || !Array.isArray(data.data)) throw new Error('directory-unavailable')
      return {
        data: data.data.filter((member) => member.state !== 'removed'),
        has_more: data.has_more,
        next_cursor: data.next_cursor ?? null,
      }
    },
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
    placeholderData: keepPreviousData,
  })
}

export async function readMembership(
  organisationId: string,
  membershipId: string
): Promise<{ value: MembershipDetail; etag: string }> {
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/memberships/{membership_id}',
    { params: { path: { organisation_id: organisationId, membership_id: membershipId } } }
  )
  const etag = response.headers.get('ETag')
  if (data === undefined || etag === null) throw new Error('membership-unavailable')
  return { value: data, etag }
}

export class MembershipMoved extends Error {
  constructor() {
    super('membership changed since it was shown')
    this.name = 'MembershipMoved'
  }
}

export class LastOwner extends Error {
  constructor() {
    super('last owner')
    this.name = 'LastOwner'
  }
}

/** Reads the membership again, then changes its role under that read's tag. */
export async function changeOrganisationRole(
  organisationId: string,
  shown: Pick<Membership, 'id' | 'role' | 'state'>,
  role: OrganisationRole
): Promise<void> {
  const fresh = await readMembership(organisationId, shown.id)
  if (fresh.value.role !== shown.role || fresh.value.state !== shown.state)
    throw new MembershipMoved()
  if (fresh.value.blocked_reason === 'last_owner') throw new LastOwner()
  await mutate(
    { method: 'patch', path: '/organisations/{organisation_id}/memberships/{membership_id}' },
    {
      params: { path: { organisation_id: organisationId, membership_id: shown.id } },
      body: { role },
      concurrency: fresh.etag,
    }
  )
}

export type RoleChangeProblem = 'lastOwner' | 'moved' | 'forbidden' | 'generic'

export function roleChangeProblem(error: unknown): RoleChangeProblem {
  if (error instanceof LastOwner) return 'lastOwner'
  if (error instanceof MembershipMoved) return 'moved'
  if (!(error instanceof ApiProblem)) return 'generic'
  switch (error.type) {
    case 'https://kodera.io/problems/last-owner-protected':
      return 'lastOwner'
    case 'https://kodera.io/problems/precondition-failed':
    case 'https://kodera.io/problems/not-found':
      return 'moved'
    case 'https://kodera.io/problems/forbidden':
      return 'forbidden'
    default:
      return 'generic'
  }
}
