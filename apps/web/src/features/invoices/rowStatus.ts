// What an invoice row's status pill shows. Pure and separate from the
// component so the one non-trivial branch — an overdue row's day count only
// exists on `DunningView`, keyed to `oldest_overdue_invoice_id`, not on the
// invoice itself — is unit-tested without mounting anything.
//
// §8: "`days_overdue` present but state is not `overdue` → trust `state`,
// ignore the count." This function's own contract is the mirror of that: an
// `overdue` invoice that is not the one `DunningView` is tracking has no day
// count to show at all, and says so as `overdue-unknown` rather than
// guessing one from `due_at`.

import type { InvoiceState } from './queries'

export type RowStatusKind =
  | { kind: 'paid' }
  | { kind: 'open' }
  | { kind: 'overdue-known'; days: number }
  | { kind: 'overdue-unknown' }
  | { kind: 'credit-note' }
  | { kind: 'void' }
  | { kind: 'draft' }

export interface DunningOverdueRef {
  readonly oldest_overdue_invoice_id?: string | null
  readonly days_overdue?: number | null
}

export function rowStatus(
  state: InvoiceState,
  invoiceId: string,
  dunning: DunningOverdueRef | undefined
): RowStatusKind {
  switch (state) {
    case 'paid':
      return { kind: 'paid' }
    case 'issued':
      return { kind: 'open' }
    case 'credited':
      return { kind: 'credit-note' }
    case 'void':
      return { kind: 'void' }
    case 'draft':
      return { kind: 'draft' }
    case 'overdue': {
      if (
        dunning?.oldest_overdue_invoice_id === invoiceId &&
        dunning.days_overdue !== undefined &&
        dunning.days_overdue !== null &&
        // Zero is "late today": the pill says « En retard », never « 0 jours ».
        dunning.days_overdue > 0
      ) {
        return { kind: 'overdue-known', days: dunning.days_overdue }
      }
      return { kind: 'overdue-unknown' }
    }
    default:
      return { kind: 'open' }
  }
}
