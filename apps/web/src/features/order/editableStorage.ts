import { z } from 'zod'
import { emptyDraft } from './draft'
import type { OrderDraft } from './draft'
import type { OrderOwner } from './owner'

export const EDITABLE_RETENTION_MS = 24 * 60 * 60 * 1000
const text = z.string().max(1024)
export const editableContactsSchema = z.object({
  legalName: text,
  slug: text,
  registrationNumber: text,
  vatNumber: text,
  addressLine1: text,
  postalCode: text,
  city: text,
  country: text,
  billingReference: text,
  adminEmail: text,
  billingEmail: text,
  securityEmail: text,
})
const editableSchema = z.object({
  headcount: z.number().int().nonnegative().safe().optional(),
  packCode: text.optional(),
  capacityTierCode: text.optional(),
  billingPeriod: z.enum(['monthly', 'yearly']),
  ngoRate: z.boolean(),
  contacts: editableContactsSchema.optional(),
  contactEdits: editableContactsSchema.strict().optional(),
})
const envelopeSchema = z.object({
  version: z.literal(1),
  purpose: z.literal('editable-order'),
  owner: z.tuple([z.string(), z.string(), z.string()]),
  draftId: z.string().min(1).max(128),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime(),
  editable: editableSchema,
})
const submittedFields = [
  'submitIdempotencyKey',
  'dpaId',
  'orderId',
  'invoiceId',
  'tenantId',
  'intent',
  'receipt',
]
export const ownerTuple = (owner: OrderOwner) =>
  [owner.issuer, owner.subject, owner.organisationId] as const
export const editableKey = (id: string, owner: OrderOwner) =>
  `order-draft:editable-v1:${JSON.stringify([...ownerTuple(owner), id])}`
export const editableLatestKey = (owner: OrderOwner) =>
  `order-draft-latest:editable-v1:${JSON.stringify(ownerTuple(owner))}`
export type RecoveryStatus = 'empty' | 'saved' | 'rejected' | 'held' | 'unavailable'
export interface EditableState {
  draft: OrderDraft
  status: RecoveryStatus
}
const blank = (id: string, status: RecoveryStatus): EditableState => ({
  draft: { ...emptyDraft(), draftId: id },
  status,
})
function possibleSubmission(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return submittedFields.some((key) => Object.hasOwn(value, key))
}
export function readEditable(id: string, owner: OrderOwner, now = Date.now()): EditableState {
  try {
    const raw = localStorage.getItem(editableKey(id, owner))
    const legacy = localStorage.getItem(`order-draft:${id}`)
    // A new-looking record cannot override an unresolved legacy purchase.
    // Old saves could fail before an order request was dispatched.
    if (legacy !== null) return blank(id, 'held')
    if (raw === null) return blank(id, 'empty')
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return blank(id, 'held')
    }
    if (possibleSubmission(value)) return blank(id, 'held')
    const parsed = envelopeSchema.safeParse(value)
    if (!parsed.success) return blank(id, 'held')
    const saved = parsed.data
    if (possibleSubmission((value as { editable?: unknown }).editable)) return blank(id, 'held')
    if (saved.draftId !== id || JSON.stringify(saved.owner) !== JSON.stringify(ownerTuple(owner)))
      return blank(id, 'held')
    const created = Date.parse(saved.createdAt),
      edited = Date.parse(saved.editedAt)
    if (created > edited || edited > now || now - edited >= EDITABLE_RETENTION_MS)
      return blank(id, 'rejected')
    return {
      draft: { ...saved.editable, draftId: id, createdAt: saved.createdAt },
      status: 'saved',
    }
  } catch {
    return blank(id, 'unavailable')
  }
}
export function saveEditable(
  draft: OrderDraft,
  owner: OrderOwner,
  now = Date.now()
): EditableState | undefined {
  if (possibleSubmission(draft)) return blank(draft.draftId, 'held')
  const parsed = editableSchema.safeParse(draft)
  if (!parsed.success) return undefined
  const safe = { ...parsed.data, draftId: draft.draftId, createdAt: draft.createdAt }
  try {
    const envelope = envelopeSchema.parse({
      version: 1,
      purpose: 'editable-order',
      owner: ownerTuple(owner),
      draftId: safe.draftId,
      createdAt: safe.createdAt,
      editedAt: new Date(now).toISOString(),
      editable: parsed.data,
    })
    const encoded = JSON.stringify(envelope)
    const current = readEditable(draft.draftId, owner, now)
    if (current.status === 'held') return current
    if (current.status === 'unavailable') return { draft: safe, status: 'unavailable' }
    localStorage.setItem(editableKey(draft.draftId, owner), encoded)
    localStorage.setItem(editableLatestKey(owner), draft.draftId)
    return { draft: safe, status: 'saved' }
  } catch {
    return { draft: safe, status: 'unavailable' }
  }
}
export function latestEditableId(owner: OrderOwner): string | undefined {
  try {
    const id = localStorage.getItem(editableLatestKey(owner))
    // Preserve a possible legacy checkout as a hold; never copy its fields.
    const legacy = localStorage.getItem(`order-draft-latest:${owner.organisationId}`)
    const candidate = id ?? legacy
    return candidate !== null && candidate.length > 0 && candidate.length <= 128
      ? candidate
      : undefined
  } catch {
    return undefined
  }
}
