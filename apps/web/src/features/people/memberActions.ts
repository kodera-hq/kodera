// Writes shared by the row menu and the member drawer. A role change is a
// `PATCH` with `If-Match`, and the tag comes only from a fresh read of the
// membership — never invented, never carried over from a list page.

import { ApiProblem, coreApi } from '../../api/client'
import type { MessageKey } from '../../i18n'
import type { MembershipDetail, Tagged } from './queries'

export async function fetchMembership(
  organisationId: string,
  membershipId: string
): Promise<Tagged<MembershipDetail>> {
  const { data, response } = await coreApi().GET(
    '/organisations/{organisation_id}/memberships/{membership_id}',
    { params: { path: { organisation_id: organisationId, membership_id: membershipId } } }
  )
  const etag = response.headers.get('ETag')
  if (data === undefined || etag === null) {
    throw new Error('GET membership answered without a body or an ETag.')
  }
  return { value: data, etag }
}

/** §9: `last-owner-protected` is one sentence naming the fix. */
export function lastOwnerProblem(error: unknown): boolean {
  return (
    error instanceof ApiProblem &&
    error.type === 'https://kodera.io/problems/last-owner-protected'
  )
}

/** The person changed, or went, since they were read: what the screen shows is out of date. */
export function staleRecord(error: unknown): boolean {
  return (
    error instanceof ApiProblem &&
    (error.type === 'https://kodera.io/problems/precondition-failed' ||
      error.type === 'https://kodera.io/problems/not-found')
  )
}

/** The sentence for a refused membership change or removal (03-people.md §9), else `otherwise`. */
export function membershipProblem(error: unknown, otherwise: MessageKey): MessageKey {
  if (!(error instanceof ApiProblem)) return otherwise
  switch (error.type) {
    case 'https://kodera.io/problems/last-owner-protected':
      return 'console.people.members.error-last-owner'
    // Someone else changed this person between the read and the write, or already removed them.
    case 'https://kodera.io/problems/precondition-failed':
    case 'https://kodera.io/problems/not-found':
      return 'console.people.members.error-changed-meanwhile'
    // Out of reach, oneself, or an organisation that is itself suspended.
    case 'https://kodera.io/problems/forbidden':
      return 'console.people.members.error-forbidden'
    default:
      return otherwise
  }
}

/** Whether the record just read is still the one on screen: a change decided on a row that has
 * since moved is not sent. */
export function sameAsShown(
  fresh: Tagged<MembershipDetail>,
  shown: { role: MembershipDetail['role']; state: MembershipDetail['state'] }
): boolean {
  return fresh.value.role === shown.role && fresh.value.state === shown.state
}
