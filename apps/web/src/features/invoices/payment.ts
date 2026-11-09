// The "Payer en ligne" action: `GET` the invoice's active payment link, and
// only `POST` one when none exists (§6: "an invoice that already has an
// active link returns that link unchanged", so a `POST` on every click would
// be redundant, not wrong — this still prefers the read, since each issuance
// the `POST` performs is an audited event `PaymentLink`'s own doc comment
// mentions no need to repeat). Every write goes through `mutate()`
// (`src/api/mutations.ts`, ADR-0005), which supplies a key for this issuance.
// A later click reads the active link again. Atomic active-link uniqueness and
// ambiguous provider reconciliation remain server requirements, not client proof.

import { ApiProblem } from '../../api/client'
import { coreApi } from '../../api/client'
import { mutate } from '../../api/mutations'
import type { Locale } from '../../i18n/format'
import type { PaymentLink } from './queries'
import { requirePaymentLink } from './responseValidation'

export async function payOnline(
  invoiceId: string,
  returnUrl: string,
  locale: Locale,
  isCurrent: () => boolean
): Promise<PaymentLink> {
  const checkCurrent = () => {
    if (!isCurrent()) throw new DOMException('Invoice action ended.', 'AbortError')
  }
  checkCurrent()
  try {
    const { data } = await coreApi().GET('/invoices/{invoice_id}/payment-link', {
      params: { path: { invoice_id: invoiceId } },
    })
    checkCurrent()
    if (data === undefined) throw new Error('Payment link response is unavailable.')
    requirePaymentLink(data, invoiceId)
    return data
  } catch (error) {
    // Anything but "no link yet" is a real failure (the payment-provider
    // outage this action's own error state exists for) and must propagate,
    // not be swallowed into a silent fall-through to `POST`.
    if (!(error instanceof ApiProblem) || error.status !== 404) throw error
  }

  checkCurrent()
  const link = await mutate(
    { method: 'post', path: '/invoices/{invoice_id}/payment-link' },
    {
      params: { path: { invoice_id: invoiceId } },
      body: { return_url: returnUrl, locale },
    }
  )
  checkCurrent()
  requirePaymentLink(link, invoiceId)
  return link
}
