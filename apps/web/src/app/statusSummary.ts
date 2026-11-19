// The one status-summary read. The shell's status banner and Home share it under one query key
// (`queryKeys.ts`), so the shell keeps it in the entry chunk and Home reuses it, not a copy.

import { coreApi } from '../api/client'
import type { components } from '../api/schema'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']

/** The one status-summary read: Home and the shell's status banner share it, and its key. */
export async function fetchStatusSummary(
  organisationId: string
): Promise<OrganisationStatusSummary> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/status-summary', {
    params: { path: { organisation_id: organisationId } },
  })
  if (data === undefined) {
    throw new Error(
      'GET /organisations/{organisation_id}/status-summary resolved with no body; this should be unreachable.'
    )
  }
  const summary = data
  if (
    summary.tenant_id !== null &&
    (typeof summary.tenant_id !== 'string' || summary.tenant_id.length === 0)
  ) {
    throw new Error('Status summary returned no tenant identifier or explicit absence.')
  }
  return summary
}
