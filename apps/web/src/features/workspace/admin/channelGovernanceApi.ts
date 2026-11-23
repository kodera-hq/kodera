import { coreApi } from '../../../api/client'
import type { components } from '../../../api/schema'

type Schema = components['schemas']
export type ChannelGovernance = Schema['ChannelGovernance']
export type PartnerAgreement = Schema['PartnerChannelAgreement']
export type GuestGrant = Schema['SingleChannelGuestGrant']
export type Proposal = Schema['PartnerChannelProposal']
export type GuestRequest = Schema['SingleChannelGuestRequest']

export async function readGovernance(organisationId: string): Promise<ChannelGovernance> {
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/channel-governance',
    {
      params: { path: { organisation_id: organisationId } },
    }
  )
  if (data === undefined) throw new Error('governance-unavailable')
  return data
}

export async function proposeAgreement(organisationId: string, body: Proposal) {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/partner-agreements',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body,
    }
  )
  if (data === undefined) throw new Error('governance-refused')
  return data
}

export async function transitionAgreement(
  organisationId: string,
  agreement: PartnerAgreement,
  action: Schema['PartnerChannelTransition']['action']
) {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/partner-agreements/{agreement_id}/actions/transition',
    {
      params: {
        path: { organisation_id: organisationId, agreement_id: agreement.id },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: { action, revision: agreement.revision },
    }
  )
  if (data === undefined) throw new Error('governance-refused')
  return data
}

export async function grantGuest(organisationId: string, body: GuestRequest) {
  const { data } = await coreApi().POST('/organisations/{organisation_id}/workspace/guest-grants', {
    params: {
      path: { organisation_id: organisationId },
      header: { 'Idempotency-Key': crypto.randomUUID() },
    },
    body,
  })
  if (data === undefined) throw new Error('governance-refused')
  return data
}

export async function revokeGuest(organisationId: string, grant: GuestGrant) {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/guest-grants/{grant_id}/actions/revoke',
    {
      params: {
        path: { organisation_id: organisationId, grant_id: grant.id },
        header: { 'Idempotency-Key': crypto.randomUUID() },
      },
      body: {},
    }
  )
  if (data === undefined) throw new Error('governance-refused')
  return data
}
