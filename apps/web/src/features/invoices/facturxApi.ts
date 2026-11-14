// Wave 4 billing API calls: VIES consultation status & validation, Factur-X 1.0
// PDF/A-3 and EN 16931 XML download links (type 380 invoice and type 381 credit
// note), and catalogue pack/tier lookup for the active subscription view.

import { coreApi } from '../../api/client'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'
import {
  requireArtifactDownloadLink,
  requireBillingVatStatus,
  requireCreditNoteResponse,
} from './responseValidation'

export type CreditNote = components['schemas']['CreditNote']
export type BillingVatStatus = components['schemas']['BillingVatStatus']
export type BillingVatValidationRequest = components['schemas']['BillingVatValidationRequest']
export type DownloadLink = components['schemas']['DownloadLink']
export type Pack = components['schemas']['Pack']
export type CapacityTier = components['schemas']['CapacityTier']

export async function fetchInvoiceArtifactDownloadLink(
  invoiceId: string,
  format: 'pdf' | 'xml' = 'pdf'
): Promise<DownloadLink> {
  const { data } = await coreApi().GET('/invoices/{invoice_id}/download', {
    params: {
      path: { invoice_id: invoiceId },
      ...(format === 'xml' ? { query: { format: 'xml' } } : {}),
    },
  })
  if (data === undefined) {
    throw new Error('GET /invoices/{id}/download resolved with no body.')
  }
  requireArtifactDownloadLink(data, format)
  return data
}

export async function fetchCreditNote(
  creditNoteId: string,
  expected: { organisationId: string; invoiceId?: string }
): Promise<CreditNote> {
  const { data } = await coreApi().GET('/credit-notes/{credit_note_id}', {
    params: { path: { credit_note_id: creditNoteId } },
  })
  if (data === undefined) {
    throw new Error('GET /credit-notes/{id} resolved with no body.')
  }
  requireCreditNoteResponse(data, { creditNoteId, ...expected })
  return data
}

export async function fetchCreditNoteDownloadLink(
  creditNoteId: string,
  format: 'pdf' | 'xml' = 'pdf'
): Promise<DownloadLink> {
  const { data } = await coreApi().GET('/credit-notes/{credit_note_id}/download', {
    params: {
      path: { credit_note_id: creditNoteId },
      ...(format === 'xml' ? { query: { format: 'xml' } } : {}),
    },
  })
  if (data === undefined) {
    throw new Error('GET /credit-notes/{id}/download resolved with no body.')
  }
  requireArtifactDownloadLink(data, format)
  return data
}

export async function fetchBillingVatStatus(organisationId: string): Promise<BillingVatStatus> {
  const { data } = await coreApi().GET('/organisations/{organisation_id}/billing/vat-status', {
    params: { path: { organisation_id: organisationId } },
  })
  if (data === undefined) {
    throw new Error('GET /organisations/{id}/billing/vat-status resolved with no body.')
  }
  requireBillingVatStatus(data)
  return data
}

export async function validateBillingVat(
  organisationId: string,
  request: BillingVatValidationRequest,
  idempotencyKey = crypto.randomUUID()
): Promise<BillingVatStatus> {
  const data = await mutate(
    { method: 'post', path: '/organisations/{organisation_id}/billing/vat-status' },
    {
      params: {
        path: { organisation_id: organisationId },
        header: { 'Idempotency-Key': idempotencyKey },
      },
      body: request,
    }
  )
  requireBillingVatStatus(data)
  return data
}

export async function fetchSubscriptionCatalogueContext(
  packCode: string,
  capacityTierCode: string
): Promise<{ pack: Pack | null; capacityTier: CapacityTier | null }> {
  const [packsResponse, tiersResponse] = await Promise.all([
    coreApi().GET('/catalog/packs', { params: { query: { limit: 100 } } }),
    coreApi().GET('/catalog/capacity-tiers', { params: { query: { limit: 100 } } }),
  ])
  const packs = Array.isArray(packsResponse.data?.data) ? packsResponse.data.data : []
  const tiers = Array.isArray(tiersResponse.data?.data) ? tiersResponse.data.data : []
  return {
    pack: packs.find((candidate) => candidate.code === packCode) ?? null,
    capacityTier: tiers.find((candidate) => candidate.code === capacityTierCode) ?? null,
  }
}
