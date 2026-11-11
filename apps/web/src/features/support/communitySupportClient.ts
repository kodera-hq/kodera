import { coreApi } from '../../api/client'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'
import { everyChannel, requireWorkspace } from '../workspace/workspace'

export async function communitySupportHref(organisationId: string): Promise<string> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/workspace', {
    params: { path: { organisation_id: organisationId } },
  })
  const channel = everyChannel(requireWorkspace(data)).find(
    (channel) =>
      channel.kind === 'text' &&
      channel.lifecycle === 'active' &&
      (channel.name === 'support' || channel.name === '#support')
  )
  if (!channel) throw new Error('Community support channel unavailable.')
  return `/community/workspace/${encodeURIComponent(channel.id)}`
}

export async function createCommunitySupportTicket(
  subject: string,
  body: string,
  locale: 'fr' | 'en',
  idempotencyKey: string
): Promise<components['schemas']['CommunitySupportTicketReceipt']> {
  return mutate(
    { method: 'post', path: '/community/support/tickets' },
    {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: { subject, body, category: 'other', severity: 'question', locale },
    }
  )
}
