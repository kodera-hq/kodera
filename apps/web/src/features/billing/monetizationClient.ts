// Typed Core API client helpers for H3.1 Community Workspace Monetization
// (Volet A Boosts/Hosting Credits & Volet B VIP Paid Servers / Stripe Connect / DAC7).

import { coreApi } from '../../api/client'
import type { components } from '../../api/schema'

export type WorkspaceMonetizationOverview =
  components['schemas']['WorkspaceMonetizationOverview']
export type WorkspaceBoostCheckoutRequest =
  components['schemas']['WorkspaceBoostCheckoutRequest']
export type WorkspaceBoostCheckoutResult =
  components['schemas']['WorkspaceBoostCheckoutResult']
export type CreatorConnectOnboardingRequest =
  components['schemas']['CreatorConnectOnboardingRequest']
export type CreatorConnectOnboardingResult =
  components['schemas']['CreatorConnectOnboardingResult']
export type VipTierOfferCreateRequest = components['schemas']['VipTierOfferCreateRequest']
export type VipTierOfferItem = components['schemas']['VipTierOfferItem']
export type VipPassCheckoutRequest = components['schemas']['VipPassCheckoutRequest']
export type VipPassCheckoutResult = components['schemas']['VipPassCheckoutResult']
export type Dac7ExportDocument = components['schemas']['Dac7ExportDocument']

export async function fetchWorkspaceMonetization(
  organisationId: string
): Promise<WorkspaceMonetizationOverview> {
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/monetization',
    {
      params: { path: { organisation_id: organisationId } },
    }
  )
  if (!data) throw new Error('missing workspace monetization payload')
  return data
}

export async function createWorkspaceBoostCheckoutSession(
  organisationId: string,
  body: WorkspaceBoostCheckoutRequest,
  idempotencyKey: string = crypto.randomUUID()
): Promise<WorkspaceBoostCheckoutResult> {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/monetization/boosts/checkout',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }
  )
  if (!data) throw new Error('missing boost checkout session payload')
  return data
}

export async function startCreatorConnectOnboardingSession(
  organisationId: string,
  body: CreatorConnectOnboardingRequest,
  idempotencyKey: string = crypto.randomUUID()
): Promise<CreatorConnectOnboardingResult> {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/monetization/connect/onboarding',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }
  )
  if (!data) throw new Error('missing Connect onboarding payload')
  return data
}

export async function createWorkspaceVipTierOffer(
  organisationId: string,
  body: VipTierOfferCreateRequest,
  idempotencyKey: string = crypto.randomUUID()
): Promise<VipTierOfferItem> {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/monetization/vip-tiers',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }
  )
  if (!data) throw new Error('missing VIP tier offer payload')
  return data
}

export async function createVipPassCheckoutSession(
  organisationId: string,
  body: VipPassCheckoutRequest,
  idempotencyKey: string = crypto.randomUUID()
): Promise<VipPassCheckoutResult> {
  const { data } = await coreApi().POST(
    '/organisations/{organisation_id}/workspace/monetization/vip-passes/checkout',
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body,
    }
  )
  if (!data) throw new Error('missing VIP pass checkout payload')
  return data
}

export async function exportWorkspaceDac7Report(
  organisationId: string,
  format: 'json' | 'xml',
  year?: number
): Promise<string> {
  if (format === 'xml') {
    const { data } = await coreApi().GET(
      '/organisations/{organisation_id}/workspace/monetization/dac7-report',
      {
        params: {
          path: { organisation_id: organisationId },
          query: { format: 'xml', ...(year !== undefined ? { year } : {}) },
        },
        parseAs: 'text',
      }
    )
    return typeof data === 'string' ? data : ''
  }
  const { data } = await coreApi().GET(
    '/organisations/{organisation_id}/workspace/monetization/dac7-report',
    {
      params: {
        path: { organisation_id: organisationId },
        query: { format: 'json', ...(year !== undefined ? { year } : {}) },
      },
    }
  )
  return JSON.stringify(data ?? {}, null, 2)
}
