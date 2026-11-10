// Zod schemas for the order wizard's forms (01-order.md §8, ADR-0006). Every
// message is a catalogue key — `console.order.<screen>.error-*` — never a
// sentence: a screen looks the key up through `t()` at render time
// (docs/dev/I18N.md rule 1). Validation timing (on blur vs on submit) is the
// form's `mode`, not this schema's concern.

import { z } from '@/validation-policy'
import { TENANT_SLUG_PATTERN } from '../../api/tenantSlug'
import type { MessageKey } from '../../i18n'

// A thin wrapper so every `message:` below is checked against the actual
// catalogue key union rather than an arbitrary string — a typo here would
// otherwise render as the literal wrong key on screen with nothing failing.
const key = (k: MessageKey): MessageKey => k

// Loose on purpose (01-order.md §13: "no live VIES lookup; the check is
// server-side and asynchronous"): two letters then up to twelve alphanumeric
// characters covers every EU member state's shape without pretending to
// validate the checksum a real VIES call would.
const VAT_PATTERN = /^[A-Za-z]{2}[0-9A-Za-z]{2,12}$/
const FRENCH_REGISTRATION_PATTERN = /^\d{9}$/

export const headcountSchema = z
  .number()
  .int(key('console.order.plan.error-headcount-range'))
  .min(1, key('console.order.plan.error-headcount-range'))
  .max(100_000, key('console.order.plan.error-headcount-range'))

export const planSelectionSchema = z.object({
  packCode: z.string().min(1, key('console.order.plan.error-plan-required')),
  capacityTierCode: z.string().min(1, key('console.order.plan.error-plan-required')),
})

export const contactsSchema = z
  .object({
    legalName: z
      .string()
      .min(2, key('console.order.contacts.error-name-required'))
      .max(120, key('console.order.contacts.error-name-required')),
    // The requested identifier is the tenant's (`OrderRequest.tenant.slug`), and the rule is
    // the contract's own tenant slug pattern: 3–32 characters, a DNS label (01-order.md §8).
    // `min`/`max` restate the bounds the pattern already fixes so that a wrong length and a
    // wrong shape read the same key; the pattern is what decides.
    slug: z
      .string()
      .min(3, key('console.order.contacts.error-slug-format'))
      .max(32, key('console.order.contacts.error-slug-format'))
      .regex(TENANT_SLUG_PATTERN, key('console.order.contacts.error-slug-format')),
    registrationNumber: z.string(),
    vatNumber: z.string().refine((value) => value === '' || VAT_PATTERN.test(value), {
      message: key('console.order.contacts.error-vat-format'),
    }),
    addressLine1: z.string().min(1, key('console.order.contacts.error-address-required')),
    postalCode: z.string().min(1, key('console.order.contacts.error-address-required')),
    city: z.string().min(1, key('console.order.contacts.error-address-required')),
    country: z.string().min(1, key('console.order.contacts.error-address-required')),
    billingReference: z.string().max(60, key('console.order.contacts.error-reference-length')),
    adminEmail: z.string().email(key('console.order.contacts.error-email-format')),
    billingEmail: z.string().email(key('console.order.contacts.error-email-format')),
    securityEmail: z.string().email(key('console.order.contacts.error-email-format')),
  })
  // France's registration number is a 9-digit SIREN; every other country
  // only requires the field to be non-empty (01-order.md §8).
  .refine(
    (value) => value.country !== 'FR' || FRENCH_REGISTRATION_PATTERN.test(value.registrationNumber),
    {
      message: key('console.order.contacts.error-registration-required'),
      path: ['registrationNumber'],
    }
  )
  .refine((value) => value.registrationNumber.trim().length > 0, {
    message: key('console.order.contacts.error-registration-required'),
    path: ['registrationNumber'],
  })

export type ContactsFormValues = z.infer<typeof contactsSchema>

export const agreementsSchema = z.object({
  accepted: z.literal(true, {
    message: key('console.order.agreements.error-acceptance-required'),
  }),
})

export const quoteSchema = z.object({
  // `error`: an empty field reads as `NaN`, refused as the wrong type. Without a key of its own,
  // zod's English default would reach the screen.
  headcount: z
    .number({ error: key('console.order.quote.error-headcount-range') })
    .int(key('console.order.quote.error-headcount-range'))
    .min(1, key('console.order.quote.error-headcount-range'))
    .max(1_000_000, key('console.order.quote.error-headcount-range')),
  country: z.string().min(1, key('console.order.quote.error-country-required')),
  needs: z.string().min(1, key('console.order.quote.error-needs-required')),
  contactEmail: z.string().email(key('console.order.quote.error-email-format')),
})
