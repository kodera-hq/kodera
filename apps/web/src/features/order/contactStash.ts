import { z } from 'zod'
import type { DraftContacts } from './draft'
import { editableContactsSchema, EDITABLE_RETENTION_MS, ownerTuple } from './editableStorage'
import type { OrderOwner } from './owner'

const envelope = z.strictObject({
  version: z.literal(1),
  purpose: z.literal('order-contact-edits'),
  owner: z.tuple([z.string(), z.string(), z.string()]),
  draftId: z.string().min(1).max(128),
  editedAt: z.iso.datetime(),
  contacts: editableContactsSchema.strict(),
})
const key = (owner: OrderOwner, draftId: string) =>
  `kodera.web.order.contactStash:${JSON.stringify([...ownerTuple(owner), draftId])}`

/** Only editable fields; the owner tuple survives a same-person auth generation change. */
export function stashContacts(owner: OrderOwner, draftId: string, contacts: DraftContacts) {
  try {
    const value = envelope.parse({
      version: 1,
      purpose: 'order-contact-edits',
      owner: ownerTuple(owner),
      draftId,
      editedAt: new Date().toISOString(),
      contacts,
    })
    sessionStorage.setItem(key(owner, draftId), JSON.stringify(value))
  } catch {
    // Best-effort recovery; never log private form values or storage errors.
  }
}

/** Read without consuming during render; committed recovery clears this exact snapshot. */
export function readStashedContacts(owner: OrderOwner, draftId: string) {
  try {
    const raw = sessionStorage.getItem(key(owner, draftId))
    if (raw === null) return undefined
    const parsed = envelope.safeParse(JSON.parse(raw) as unknown)
    if (!parsed.success) return undefined
    const value = parsed.data
    const age = Date.now() - Date.parse(value.editedAt)
    if (
      value.draftId !== draftId ||
      JSON.stringify(value.owner) !== JSON.stringify(ownerTuple(owner)) ||
      age < 0 ||
      age >= EDITABLE_RETENTION_MS
    )
      return undefined
    return { contacts: value.contacts, raw }
  } catch {
    return undefined
  }
}

export function clearStashedContacts(owner: OrderOwner, draftId: string, expectedRaw?: string) {
  try {
    const storageKey = key(owner, draftId)
    if (expectedRaw !== undefined && sessionStorage.getItem(storageKey) !== expectedRaw) return
    sessionStorage.removeItem(storageKey)
  } catch {
    // Storage denial must not prevent editing or in-memory navigation.
  }
}
