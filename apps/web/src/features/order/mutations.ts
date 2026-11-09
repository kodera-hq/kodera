// Every write the order wizard makes, through `src/api/mutations.ts`
// (ADR-0005) — never a bespoke fetch. Each one takes an explicit
// `idempotencyKey`: `mutate()` passes a caller-supplied `Idempotency-Key`
// straight through instead of the client middleware's own random one
// (`src/api/mutations.ts`, `tests/unit/api/client.test.ts` "keeps a key the
// caller supplied"), which is what lets a retried submit replay the first
// response instead of placing a second order (01-order.md §6, acceptance
// test 5).

import { useMutation } from '@tanstack/react-query'
import { mutate } from '../../api/mutations'
import type { components } from '../../api/schema'

export type OrderRequest = components['schemas']['OrderRequest']
export type OrderResult = components['schemas']['OrderResult']
export type Dpa = components['schemas']['Dpa']

export function useGenerateDpaMutation(organisationId: string) {
  return useMutation({
    mutationFn: (input: { packCode: string; locale: 'fr' | 'en'; idempotencyKey: string }) =>
      mutate(
        { method: 'post', path: '/organisations/{organisation_id}/dpa' },
        {
          params: {
            path: { organisation_id: organisationId },
            header: { 'Idempotency-Key': input.idempotencyKey },
          },
          body: { pack_code: input.packCode, locale: input.locale, tenant_id: null },
        }
      ),
  })
}

export function usePlaceOrderMutation(organisationId: string) {
  return useMutation({
    mutationFn: (input: { body: OrderRequest; idempotencyKey: string }) =>
      mutate(
        { method: 'post', path: '/organisations/{organisation_id}/orders' },
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

export function useCreatePaymentLinkMutation() {
  return useMutation({
    mutationFn: (input: {
      invoiceId: string
      returnUrl: string
      locale: 'fr' | 'en'
      idempotencyKey: string
    }) =>
      mutate(
        { method: 'post', path: '/invoices/{invoice_id}/payment-link' },
        {
          params: {
            path: { invoice_id: input.invoiceId },
            header: { 'Idempotency-Key': input.idempotencyKey },
          },
          body: { return_url: input.returnUrl, locale: input.locale },
        }
      ),
  })
}

export function useCreateSupportTicketMutation() {
  return useMutation({
    mutationFn: (input: {
      subject: string
      body: string
      contactEmail: string
      locale: 'fr' | 'en'
      idempotencyKey: string
    }) =>
      mutate(
        { method: 'post', path: '/support/tickets' },
        {
          params: { header: { 'Idempotency-Key': input.idempotencyKey } },
          body: {
            category: 'other',
            severity: 'question',
            subject: input.subject,
            body: input.body,
            contact_email: input.contactEmail,
            locale: input.locale,
          },
        }
      ),
  })
}
