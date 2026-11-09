// What the Aide page may know about why the customer came, read from the
// query string every support action builds through `helpHref`
// (`./helpHref.ts`, docs/specs/06-support.md §4.0): the status screen's
// `reason` and `job_id`, the instance's lifecycle `state`, an invoice's
// number, and a billing, capacity or order topic. It is a hint for the
// customer's own message, never a fact the page acts on, so anything
// unrecognised is dropped rather than shown: the page renders only labels from
// the catalogue, and the two free values it repeats (an invoice number, a job
// reference) must look like one.

import type { TFunction } from 'i18next'
import { z } from 'zod'

export const LIFECYCLE_STATES = [
  'ready',
  'upgrading',
  'maintenance',
  'suspended',
  'decommissioning',
  'deleted',
  'failed',
] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

export function isLifecycleState(value: string | undefined): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly (string | undefined)[]).includes(value)
}

// `.catch(undefined)` on every field: a value the page does not recognise is
// dropped, never a route error — a customer asking for help must reach help.
export const helpSearchSchema = z.object({
  reason: z.enum(['stale', 'step-failed', 'late', 'incident']).optional().catch(undefined),
  job_id: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional()
    .catch(undefined),
  state: z.enum(LIFECYCLE_STATES).optional().catch(undefined),
  invoiceNumber: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/)
    .optional()
    .catch(undefined),
  topic: z.enum(['change-plan', 'capacity', 'dunning', 'order']).optional().catch(undefined),
})

export type HelpSearch = z.infer<typeof helpSearchSchema>

/**
 * `problem`: something is wrong now, so the time it happened and what happens
 * matter. `question`: a billing, plan or capacity question, where neither
 * does. The page and the pre-written e-mail ask for what fits.
 */
export type HelpTopicKind = 'problem' | 'question'

export interface HelpTopic {
  text: string
  kind: HelpTopicKind
}

/** The customer's words for why they came, or `undefined` when the page
 * cannot tell. Every branch is a catalogue sentence; nothing from the query
 * string is rendered except the two values the schema above has shaped. */
export function helpTopic(search: HelpSearch, t: TFunction): HelpTopic | undefined {
  const problem = (text: string): HelpTopic => ({ text, kind: 'problem' })
  const question = (text: string): HelpTopic => ({ text, kind: 'question' })
  switch (search.reason) {
    case 'stale':
      return problem(t('console.support.help.about-stale'))
    case 'step-failed':
      return problem(
        search.job_id === undefined
          ? t('console.support.help.about-step-failed')
          : t('console.support.help.about-step-failed-reference', { reference: search.job_id })
      )
    case 'late':
      return problem(t('console.support.help.about-provisioning'))
    case 'incident':
      return problem(t('console.support.help.about-incident'))
    case undefined:
      break
  }
  switch (search.state) {
    case 'ready':
      return problem(t('console.support.help.about-state-ready'))
    case 'upgrading':
      return problem(t('console.support.help.about-state-upgrading'))
    case 'maintenance':
      return problem(t('console.support.help.about-state-maintenance'))
    case 'suspended':
      return problem(t('console.support.help.about-state-suspended'))
    case 'decommissioning':
      return problem(t('console.support.help.about-state-decommissioning'))
    case 'deleted':
      return problem(t('console.support.help.about-state-deleted'))
    case 'failed':
      return problem(t('console.support.help.about-state-failed'))
    case undefined:
      break
  }
  if (search.invoiceNumber !== undefined) {
    return question(t('console.support.help.about-invoice', { number: search.invoiceNumber }))
  }
  switch (search.topic) {
    case 'change-plan':
      return question(t('console.support.help.about-change-plan'))
    case 'capacity':
      return question(t('console.support.help.about-capacity'))
    case 'dunning':
      return question(t('console.support.help.about-dunning'))
    case 'order':
      return problem(t('console.support.help.about-order'))
    case undefined:
      return undefined
  }
}
