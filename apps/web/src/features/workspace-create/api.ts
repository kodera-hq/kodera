// `createTenant` (Core contract 0.35.0): the owner's one step to a workspace on a deployment that
// does not bill. Through `src/api/mutations.ts` (ADR-0005), with the caller's own
// `Idempotency-Key`, so a retry after an unknown outcome replays the first answer.

import { useMutation } from '@tanstack/react-query'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'

export type TenantCreation = components['schemas']['TenantCreation']
export type TenantCreated = components['schemas']['TenantCreated']

export function useCreateTenantMutation(organisationId: string) {
  return useMutation({
    mutationFn: (input: { body: TenantCreation; idempotencyKey: string }) =>
      mutate(
        { method: 'post', path: '/organisations/{organisation_id}/tenants' },
        {
          params: {
            path: { organisation_id: organisationId },
            header: { 'Idempotency-Key': input.idempotencyKey },
          },
          body: input.body,
        }
      ),
  })
}

/**
 * The creation being sent for an organisation, for as long as the page lives: the key and the
 * body together while the outcome is unknown, so a retry resends exactly the same request (Core
 * replays a committed one; another body under the same key is refused). Cleared once Core has
 * answered with a refusal that stored nothing.
 */
export interface CreationSubmission {
  readonly key: string
  readonly body: TenantCreation
}

const submissions = new Map<string, CreationSubmission>()

export function pendingCreation(organisationId: string): CreationSubmission | undefined {
  return submissions.get(organisationId)
}

export function rememberCreation(organisationId: string, submission: CreationSubmission): void {
  submissions.set(organisationId, submission)
}

export function forgetCreation(organisationId: string): void {
  submissions.delete(organisationId)
}
