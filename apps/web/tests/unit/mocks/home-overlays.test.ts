// One sanity check per Home overlay (docs/specs/08-home.md §7): each name
// resolves, and each carries the one deviation its own file promises — the
// same shape `shell-single-organisation.test.ts` uses. The Playwright specs
// exercise how Home renders each of these; this is the mock layer's own
// self-test, so a typo in an overlay's body is caught here rather than as a
// confusing end-to-end failure three layers away.

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { forgetResends } from '@/mocks/overlays/home.pending-invitations'
import { resolveOverlays } from '@/mocks/overlays/index-glob'

type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']
type Me = components['schemas']['Me']

const HOME_OVERLAYS = [
  'home.default',
  'home.provisioning',
  'home.pending-invitations',
  'home.pending-invitations-partial',
  'home.capacity-92',
  'home.capacity-at-limit',
  'home.incident',
  'home.dunning',
  'home.no-tenant',
  'home.invitations-error',
  'home.member-role',
  'home.capacity-null',
]

describe('Home scenario overlays', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it.each(HOME_OVERLAYS)('%s resolves to at least one handler', (name) => {
    expect(resolveOverlays([name]).length).toBeGreaterThan(0)
  })

  it('home.default answers an operational summary with a 62 % capacity gauge and no pending invitation', async () => {
    server.use(...resolveOverlays(['home.default']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.overall).toBe('operational')
    expect(summary.capacity?.participants.pct).toBe(62)

    const invitations = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/invitations?state=pending')
    ).json()) as { data: unknown[] }
    expect(invitations.data).toEqual([])
  })

  it('home.capacity-null answers a summary with no capacity block at all', async () => {
    server.use(...resolveOverlays(['home.default', 'home.capacity-null']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.capacity).toBeNull()
  })

  it('home.capacity-92 turns the upgrade prompt on with the suggested tier', async () => {
    server.use(...resolveOverlays(['home.default', 'home.capacity-92']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.capacity?.participants.pct).toBe(92)
    expect(summary.capacity?.upgrade_prompt).toBe(true)
    expect(summary.capacity?.suggested_capacity_tier_code).toBe('L')
  })

  it('home.dunning marks billing past_due with an amount due', async () => {
    server.use(...resolveOverlays(['home.default', 'home.dunning']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.billing?.dunning_state).toBe('past_due')
    expect(summary.billing?.amount_due?.amount_minor).toBe(538560)
  })

  it('home.member-role answers /me with every organisation role downgraded to member', async () => {
    server.use(...resolveOverlays(['home.member-role']))
    const me = (await (await fetch('https://example.test/api/v1/me')).json()) as Me
    expect(me.organisations.every((entry) => entry.role === 'org_member')).toBe(true)
  })

  it('home.no-tenant answers a null tenant id and an empty tenants page', async () => {
    server.use(...resolveOverlays(['home.no-tenant']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.tenant_id).toBeNull()

    const tenants = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/tenants')
    ).json()) as { data: unknown[] }
    expect(tenants.data).toEqual([])
  })

  it('home.pending-invitations-partial rate limits exactly the second resend', async () => {
    server.use(...resolveOverlays(['home.pending-invitations-partial']))
    const first = await fetch(
      'https://example.test/api/v1/invitations/4a6e2c1d-9b3f-4c7a-8e5d-000000000000/actions/resend',
      {
        method: 'POST',
      }
    )
    const second = await fetch(
      'https://example.test/api/v1/invitations/4a6e2c1d-9b3f-4c7a-8e5d-000000000001/actions/resend',
      {
        method: 'POST',
      }
    )
    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
  })

  it('home.invitations-error fails the invitations call with service-unavailable', async () => {
    server.use(...resolveOverlays(['home.invitations-error']))
    const response = await fetch(
      'https://example.test/api/v1/organisations/org-1/invitations?state=pending'
    )
    expect(response.status).toBe(503)
  })

  it('home.provisioning answers a tenant id and a provisioning tenant status', async () => {
    server.use(...resolveOverlays(['home.provisioning']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.tenant_id).toBeTruthy()

    const status = (await (
      await fetch(`https://example.test/api/v1/tenants/${summary.tenant_id}/status`)
    ).json()) as { status: string; provisioning_steps: { status: string }[] }
    expect(status.status).toBe('provisioning')
    expect(status.provisioning_steps).toHaveLength(6)
    expect(status.provisioning_steps.some((step) => step.status === 'running')).toBe(true)
  })

  it('home.incident degrades calls and carries one open incident', async () => {
    server.use(...resolveOverlays(['home.default', 'home.incident']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.overall).toBe('degraded')
    expect(summary.open_incident_ids).toHaveLength(1)
  })

  it('home.capacity-at-limit answers a full gauge', async () => {
    server.use(...resolveOverlays(['home.default', 'home.capacity-at-limit']))
    const summary = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/status-summary')
    ).json()) as OrganisationStatusSummary
    expect(summary.capacity?.participants.pct).toBe(100)
  })

  it("home.pending-invitations moves an invitation's last send on a resend, as Core does", async () => {
    server.use(...resolveOverlays(['home.pending-invitations']))
    const list = async () =>
      (
        (await (
          await fetch('https://example.test/api/v1/organisations/org-1/invitations?state=pending')
        ).json()) as { data: { id: string; last_sent_at: string; sent_count: number }[] }
      ).data
    const [first] = await list()
    const resend = await fetch(
      `https://example.test/api/v1/invitations/${first?.id ?? ''}/actions/resend`,
      { method: 'POST', headers: { 'Idempotency-Key': 'resend-1' } }
    )
    expect(resend.status).toBe(200)
    const after = (await list()).find((row) => row.id === first?.id)
    // Sent again just now: the banner's 72 hours start again from here.
    expect(Date.now() - new Date(after?.last_sent_at ?? 0).getTime()).toBeLessThan(60_000)
    expect(after?.sent_count).toBe(2)
    forgetResends()
    expect((await list()).find((row) => row.id === first?.id)?.sent_count).toBe(1)
  })

  it('home.pending-invitations answers four invitations past their 72-hour set-up link, still pending', async () => {
    server.use(...resolveOverlays(['home.pending-invitations']))
    const invitations = (await (
      await fetch('https://example.test/api/v1/organisations/org-1/invitations?state=pending')
    ).json()) as { data: { created_at: string; last_sent_at: string; expires_at: string }[] }
    expect(invitations.data).toHaveLength(4)
    for (const row of invitations.data) {
      // The banner counts from the last send; Core lists a pending invitation only before its expiry.
      expect(Date.now() - new Date(row.last_sent_at).getTime()).toBeGreaterThan(72 * 60 * 60 * 1000)
      expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now())
    }
  })
})
