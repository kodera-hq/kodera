import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { helpHref } from './helpHref'
import { helpSearchSchema, helpTopic } from './helpTopic'
import type { HelpSearch } from './helpTopic'

const t = i18n.t.bind(i18n)
const topicOf = (search: Record<string, unknown>) => helpTopic(helpSearchSchema.parse(search), t)

describe('the Aide page reads the context a support action carried', () => {
  it.each([
    [{ reason: 'stale' }, 'Votre instance ne donne plus de nouvelles', 'problem'],
    [{ reason: 'step-failed' }, 'Une étape de la mise en service a échoué', 'problem'],
    [
      { reason: 'step-failed', job_id: '8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f' },
      'Une étape de la mise en service a échoué (référence 8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f)',
      'problem',
    ],
    [{ reason: 'late' }, 'Mise en service de votre instance', 'problem'],
    [{ reason: 'incident' }, 'Incident en cours sur votre instance', 'problem'],
    [{ state: 'ready' }, 'Votre instance est prête à vous être remise', 'problem'],
    [{ state: 'upgrading' }, 'Mise à jour de votre instance en cours', 'problem'],
    [{ state: 'maintenance' }, 'Maintenance en cours sur votre instance', 'problem'],
    [{ state: 'suspended' }, 'Votre instance est suspendue', 'problem'],
    [{ state: 'decommissioning' }, 'Fermeture de votre instance en cours', 'problem'],
    [{ state: 'deleted' }, 'Votre instance est fermée', 'problem'],
    [{ state: 'failed' }, 'Une opération sur votre instance a échoué', 'problem'],
    [{ invoiceNumber: 'INV-2026-0142' }, 'Facture INV-2026-0142', 'question'],
    [{ topic: 'change-plan' }, 'Changement de formule', 'question'],
    [{ topic: 'capacity' }, 'Capacité de votre formule', 'question'],
    [{ topic: 'dunning' }, 'Retard de paiement', 'question'],
    [{ topic: 'order' }, 'Votre commande', 'problem'],
  ])('%o reads « %s » as a %s', (search, text, kind) => {
    expect(topicOf(search)).toEqual({ text, kind })
  })

  it('reads nothing when the action carried nothing', () => {
    expect(topicOf({})).toBeUndefined()
  })

  // The page repeats two free values to the customer; anything that does not
  // look like one is dropped, and an unknown value never becomes a route
  // error — a customer asking for help must reach help.
  it.each([
    { reason: 'bogus' },
    { state: 'toString' },
    { topic: 'refund' },
    { category: 'billing' },
    { invoiceNumber: 'Appelez le 01 23 45 67 89' },
    { invoiceNumber: '<b>INV</b>' },
    { invoiceNumber: 42 },
  ])('drops %o rather than repeat it or fail', (search) => {
    expect(topicOf(search)).toBeUndefined()
  })

  it('drops a job reference that does not look like one, keeping the reason', () => {
    expect(topicOf({ reason: 'step-failed', job_id: 'x'.repeat(65) })?.text).toBe(
      'Une étape de la mise en service a échoué'
    )
  })
})

describe('helpHref, the one way to write a link to Aide', () => {
  it.each<[HelpSearch, string]>([
    [{}, '/acme-sa/help'],
    [{ reason: 'stale' }, '/acme-sa/help?reason=stale'],
    [{ job_id: 'job-42', reason: 'step-failed' }, '/acme-sa/help?reason=step-failed&job_id=job-42'],
    [{ state: 'suspended' }, '/acme-sa/help?state=suspended'],
    [{ invoiceNumber: 'INV-2026-0142' }, '/acme-sa/help?invoiceNumber=INV-2026-0142'],
    [{ topic: 'capacity' }, '/acme-sa/help?topic=capacity'],
  ])('writes %o as %s, in a fixed order, and the page reads it back', (search, href) => {
    expect(helpHref('acme-sa', search)).toBe(href)
    const parsed = helpSearchSchema.parse(
      Object.fromEntries(new URL(href, 'http://x').searchParams)
    )
    expect(parsed).toEqual(search)
  })
})
