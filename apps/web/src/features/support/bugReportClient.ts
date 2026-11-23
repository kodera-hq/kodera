import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'

export async function submitBugReport(
  organisationId: string,
  payload: components['schemas']['BugReportCreateRequest'],
  idempotencyKey: string
): Promise<components['schemas']['BugReportReceipt']> {
  return mutate(
    { method: 'post', path: '/organisations/{organisation_id}/support/bug-reports' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body: payload,
    }
  )
}
