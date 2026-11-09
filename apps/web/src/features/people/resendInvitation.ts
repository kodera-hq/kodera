// An unresolved resend keeps one intention key, even when its response is
// lost or the person moves between the member row and the Invitations tab.
// QueryClient owns this memory: session clearing discards it, and a confirmed
// send discards its key so the next deliberate send is a new intention.

import { useQueryClient } from '@tanstack/react-query'
import { ApiProblem } from '../../api/client'
import type { MessageKey } from '../../i18n'
import { resendInvitation } from './queries'

const RESEND_INTENTS = ['people-resend-intent'] as const

export function useResendInvitation(organisationId: string) {
  const client = useQueryClient()
  return async (invitationId: string) => {
    const queryKey = [...RESEND_INTENTS, organisationId, invitationId]
    let key = client.getQueryData<string>(queryKey)
    if (key === undefined) {
      // A failed response must not silently become a new intention when an
      // unobserved cache entry reaches the normal five-minute collection time.
      client.setQueryDefaults(RESEND_INTENTS, { gcTime: Infinity })
      key = crypto.randomUUID()
      client.setQueryData(queryKey, key)
    }
    const result = await resendInvitation(invitationId, key)
    // A resolved body alone cannot confirm this particular resend.
    if (
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result) ||
      typeof result.id !== 'string' ||
      result.id !== invitationId ||
      typeof result.organisation_id !== 'string' ||
      result.organisation_id !== organisationId
    )
      throw new Error('Invitation resend receipt unavailable.')
    // An older concurrent replay must not clear a newer deliberate intention.
    if (client.getQueryData<string>(queryKey) === key) {
      client.removeQueries({ queryKey, exact: true })
    }
    return result
  }
}

/** What a failed resend tells the person. A 410 (`invitation-expired`, `invitation-revoked`) is
 * final: nothing is sent, and the contract says to invite the address again, never to retry. */
export function resendFailureKey(error: unknown): MessageKey {
  return error instanceof ApiProblem && error.status === 410
    ? 'console.people.members.error-resend-gone'
    : 'console.common.error-unavailable'
}
