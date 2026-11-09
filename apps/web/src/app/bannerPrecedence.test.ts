import { describe, expect, it } from 'vitest'
import { decideBanner } from './bannerPrecedence'
import type { StatusSummary } from './bannerPrecedence'

const OPERATIONAL_SUMMARY: StatusSummary = {
  organisation_id: '6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f',
  tenant_id: '2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
  billing_enabled: true,
  workspace_pack_code: null,
  overall: 'operational',
  components: [
    {
      id: '0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f',
      scope: 'tenant',
      key: 'calls',
      name: 'Calls',
      state: 'operational',
      since: '2026-12-01T00:00:00Z',
    },
  ],
  capacity: null,
  billing: { dunning_state: 'current', oldest_overdue_invoice_id: null, amount_due: null },
  maintenance: null,
  open_incident_ids: [],
}

describe('decideBanner', () => {
  it('shows nothing when everything is operational and current', () => {
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: OPERATIONAL_SUMMARY })
    ).toBeUndefined()
  })

  it('offline outranks every other condition', () => {
    const decision = decideBanner({
      offline: true,
      sessionExpiring: true,
      statusSummary: { ...OPERATIONAL_SUMMARY, overall: 'major_outage' },
    })
    expect(decision).toEqual({ kind: 'offline' })
  })

  it('session-expiring outranks an incident', () => {
    const decision = decideBanner({
      offline: false,
      sessionExpiring: true,
      statusSummary: { ...OPERATIONAL_SUMMARY, overall: 'degraded' },
    })
    expect(decision).toEqual({ kind: 'session-expiring' })
  })

  it('names the affected component for a degraded overall state', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      overall: 'degraded',
      components: [{ ...OPERATIONAL_SUMMARY.components[0]!, state: 'degraded' }],
    }
    const decision = decideBanner({
      offline: false,
      sessionExpiring: false,
      statusSummary: summary,
    })
    expect(decision).toEqual({ kind: 'incident', component: summary.components[0] })
  })

  it('an incident outranks dunning', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      overall: 'degraded',
      components: [{ ...OPERATIONAL_SUMMARY.components[0]!, state: 'degraded' }],
      billing: { dunning_state: 'past_due', oldest_overdue_invoice_id: null, amount_due: null },
    }
    const decision = decideBanner({
      offline: false,
      sessionExpiring: false,
      statusSummary: summary,
    })
    expect(decision?.kind).toBe('incident')
  })

  it('shows dunning when the invoice is overdue and nothing outranks it', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      billing: { dunning_state: 'past_due', oldest_overdue_invoice_id: 'inv-1', amount_due: null },
    }
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: summary })
    ).toEqual({
      kind: 'dunning',
    })
  })

  it('dunning outranks capacity', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      billing: { dunning_state: 'notice', oldest_overdue_invoice_id: 'inv-1', amount_due: null },
      capacity: {
        seats: { used: 10, included: 20, pct: 50 },
        participants: { used: 92, included: 100, pct: 92 },
        storage: { used: 1, included: 10, pct: 10 },
        threshold_pct: 90,
        upgrade_prompt: true,
        measured_at: '2026-12-03T11:19:42Z',
      },
    }
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: summary })?.kind
    ).toBe('dunning')
  })

  it('shows capacity at or above the threshold when nothing outranks it', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      capacity: {
        seats: { used: 10, included: 20, pct: 50 },
        participants: { used: 92, included: 100, pct: 92 },
        storage: { used: 1, included: 10, pct: 10 },
        threshold_pct: 90,
        upgrade_prompt: true,
        measured_at: '2026-12-03T11:19:42Z',
      },
    }
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: summary })
    ).toEqual({
      kind: 'capacity',
    })
  })

  it('does not show capacity below the threshold', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      capacity: {
        seats: { used: 10, included: 20, pct: 50 },
        participants: { used: 40, included: 100, pct: 40 },
        storage: { used: 1, included: 10, pct: 10 },
        threshold_pct: 90,
        upgrade_prompt: false,
        measured_at: '2026-12-03T11:19:42Z',
      },
    }
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: summary })
    ).toBeUndefined()
  })

  it('shows maintenance only when nothing else outranks it', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      maintenance: { scheduled_at: '2026-12-10T22:00:00Z', duration_s: 1800, message_key: null },
    }
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: summary })
    ).toEqual({
      kind: 'maintenance',
    })
  })

  it('capacity outranks maintenance', () => {
    const summary: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      maintenance: { scheduled_at: '2026-12-10T22:00:00Z', duration_s: 1800, message_key: null },
      capacity: {
        seats: { used: 10, included: 20, pct: 50 },
        participants: { used: 95, included: 100, pct: 95 },
        storage: { used: 1, included: 10, pct: 10 },
        threshold_pct: 90,
        upgrade_prompt: true,
        measured_at: '2026-12-03T11:19:42Z',
      },
    }
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: summary })?.kind
    ).toBe('capacity')
  })

  it('shows nothing before the first status fetch resolves', () => {
    expect(
      decideBanner({ offline: false, sessionExpiring: false, statusSummary: undefined })
    ).toBeUndefined()
  })

  // A page announcing the same incident in its own banner (Applications):
  // the slot does not repeat it and continues down the precedence.
  describe('with the incident already on the page', () => {
    const degradedAndOverdue: StatusSummary = {
      ...OPERATIONAL_SUMMARY,
      overall: 'degraded',
      components: [{ ...OPERATIONAL_SUMMARY.components[0]!, state: 'degraded' }],
      billing: {
        dunning_state: 'past_due',
        oldest_overdue_invoice_id: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70',
        amount_due: { amount_minor: 538560, currency: 'EUR' },
      },
    }

    it('falls to the next banner when the page names the same component', () => {
      expect(
        decideBanner({
          offline: false,
          sessionExpiring: false,
          statusSummary: degradedAndOverdue,
          incidentsShownByPage: ['calls'],
        })
      ).toEqual({ kind: 'dunning' })
    })

    it('keeps the incident when the page names a different component', () => {
      expect(
        decideBanner({
          offline: false,
          sessionExpiring: false,
          statusSummary: degradedAndOverdue,
          incidentsShownByPage: ['web'],
        })?.kind
      ).toBe('incident')
    })
  })
})
