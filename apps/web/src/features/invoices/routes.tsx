// `/{org}/invoices` — "Facturation" (docs/specs/05-invoices.md). Three flat
// siblings under `orgRoute`, the same shape every other area's `routes.tsx`
// uses (`docs/dev/BASELINE.md`: "one `routes.ts` per area … no generated
// route tree"), rather than a nested layout route: the list, the detail and
// the read-only subscription screen share no chrome of their own beyond the
// shell every area already sits inside. `invoices/subscription` is a static
// segment and matches before `invoices/$invoiceId` regardless of
// registration order (TanStack Router's own routing, not something this file
// has to arrange) — "subscription" is never read as an invoice id.
//
// Search parameters are zod-validated per route (ADR-0005); `#pay` (the
// dunning-banner entry point) is not one — the detail screen reads
// `location.hash` directly (ADR-0005's own note on why).

import { createRoute } from '@tanstack/react-router'
import { z } from '@/validation-policy'
import { orgRoute } from '../../app/org-route'
import { InvoiceDetailScreen } from './InvoiceDetailScreen'
import { InvoiceListScreen } from './InvoiceListScreen'
import { SubscriptionScreen } from './SubscriptionScreen'

export const invoicesRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'invoices',
  component: InvoiceListScreen,
})

const invoiceDetailSearchSchema = z.object({
  /** Where the visitor came from — the order confirmation or an invoice
   * e-mail (§3). Read only to decide whether a "back to the order" link
   * makes sense; never trusted for anything the API itself should say. */
  from: z.enum(['order', 'email']).optional(),
  /** Set by the PSP's own return redirect (§5, "Payment return"). The
   * console draws no conclusion from its presence — it refetches the
   * invoice and renders whatever the Core API says. */
  payment: z.enum(['return']).optional(),
})

export const invoiceDetailRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'invoices/$invoiceId',
  validateSearch: invoiceDetailSearchSchema,
  component: InvoiceDetailScreen,
})

export const invoicesSubscriptionRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'invoices/subscription',
  component: SubscriptionScreen,
})
