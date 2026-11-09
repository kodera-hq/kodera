// The order wizard's own state (01-order.md §6: "there is no server-side
// draft"). Everything the buyer has entered lives in the browser, keyed by a
// client-generated `draftId` that appears in the URL
// (`/order/{draftId}/{step}`) and in `localStorage`, and is never sent to the
// Core API — only the final submit is. This module is the storage shape and
// the pure functions over it; `useOrderDraft.ts` is the thin `localStorage`
// binding around them.

import { z } from 'zod'

export const ORDER_STEPS = ['plan', 'contacts', 'agreements', 'confirmation'] as const
export type OrderStep = (typeof ORDER_STEPS)[number]

const draftContactsSchema = z.object({
  legalName: z.string(),
  slug: z.string(),
  registrationNumber: z.string(),
  vatNumber: z.string(),
  addressLine1: z.string(),
  postalCode: z.string(),
  city: z.string(),
  country: z.string(),
  billingReference: z.string(),
  adminEmail: z.string(),
  billingEmail: z.string(),
  securityEmail: z.string(),
})

export type DraftContacts = z.infer<typeof draftContactsSchema>

const orderDraftSchema = z.object({
  draftId: z.string(),
  createdAt: z.iso.datetime(),
  headcount: z.number().optional(),
  packCode: z.string().optional(),
  capacityTierCode: z.string().optional(),
  billingPeriod: z.enum(['monthly', 'yearly']),
  ngoRate: z.boolean(),
  contacts: draftContactsSchema.optional(),
  // Unvalidated editing never advances the reachable step.
  contactEdits: draftContactsSchema.optional(),
  // Generated once, the first time it is needed, and kept for the rest of
  // the draft's life: the same `Idempotency-Key` on every submit attempt is
  // what makes a retried submit replay instead of double-order (§6).
  submitIdempotencyKey: z.string().optional(),
  dpaId: z.string().optional(),
  orderId: z.string().optional(),
  invoiceId: z.string().optional(),
  tenantId: z.string().optional(),
})

export type OrderDraft = z.infer<typeof orderDraftSchema>

export function emptyDraft(): OrderDraft {
  return {
    draftId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    billingPeriod: 'yearly',
    ngoRate: false,
  }
}

export function serializeDraft(draft: OrderDraft): string {
  return JSON.stringify(draft)
}

/** `undefined` for anything that is not a well-formed draft — a corrupted or
 * hand-edited `localStorage` entry is treated as absent, not thrown over. */
export function parseDraft(json: string | undefined): OrderDraft | undefined {
  if (json === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  const result = orderDraftSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

/**
 * The furthest step a draft has reached, for the "Resume rule"
 * (01-order.md §5): a plan chosen but no contacts yet resumes on `contacts`,
 * a placed order resumes on `confirmation`. Never skips ahead of what the
 * draft actually holds — a person who abandoned the form mid-way lands back
 * exactly where they left it, not on a step for data that is still missing.
 */
export function furthestStep(draft: OrderDraft): OrderStep {
  if (draft.orderId !== undefined) return 'confirmation'
  if (draft.contacts !== undefined) return 'agreements'
  if (draft.packCode !== undefined && draft.capacityTierCode !== undefined) return 'contacts'
  return 'plan'
}
