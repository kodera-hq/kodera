// The demo's one claim is that every screen describes the same company, and
// nothing about a set of MSW handlers enforces that on its own — the fixtures
// this seed replaces disagreed with each other for months without a single
// test going red, because each one was only ever asserted against its own
// screen. These are the joins: the ids that have to point at each other, the
// arithmetic that has to add up, and the routes that have to be answered.
//
// Each assertion carries a message naming the two things that stopped
// agreeing, so a failure reads as "the invoice no longer belongs to the
// subscription" rather than as `expected 'a' to be 'b'`.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `keycloakUrl()` is `required()`, and the seed reads it to build the issuer
// the order wizard's owner check compares against — so it has to be set
// before this file's imports evaluate, the same way `src/mocks/auth.test.ts`
// does it for the handlers that answer under it.
import.meta.env['VITE_KEYCLOAK_URL'] = 'https://id.example.test'

const { DEMO_ROUTES, handlers } = await import('../overlays/demo.groupe-vercelli')
const seed = await import('./seed')
const { keycloakUrl } = await import('../../config')

// A fixed instant, so a test that fails names a value rather than a race. The
// seed's own relative arithmetic is what is under test, not the clock.
const NOW = new Date('2026-09-10T17:26:00Z')

describe('the demo seed describes one organisation', () => {
  it('gives every record the same organisation', () => {
    const owners: ReadonlyArray<readonly [string, string | undefined]> = [
      ['organisation', seed.organisation(NOW).id],
      ['me.organisations[0]', seed.me(NOW).organisations[0]!.organisation.id],
      ['membership', seed.memberships(NOW)[0]!.organisation_id],
      ['tenant', seed.tenant(NOW).organisation_id],
      ['subscription', seed.subscription(NOW).organisation_id],
      ['invoice', seed.currentInvoice(NOW).organisation_id],
      ['upgrade invoice', seed.upgradeInvoice(NOW).organisation_id],
      ['status summary', seed.statusSummary(NOW).organisation_id],
      ['order', seed.upgradeOrder(NOW).organisation_id],
      ['dpa', seed.dpa(NOW).organisation_id],
      ['support ticket', seed.supportTicket(NOW).organisation_id],
      ['invitation', seed.invitation(NOW).organisation_id],
    ]
    for (const [what, organisationId] of owners) {
      expect(
        organisationId,
        `${what} belongs to a different organisation than the seed's own`
      ).toBe(seed.ORGANISATION_ID)
    }
  })

  it('gives every record the same tenant', () => {
    const tenants: ReadonlyArray<readonly [string, string | null | undefined]> = [
      ['tenant', seed.tenant(NOW).id],
      ['tenant status', seed.tenantStatus(NOW).tenant_id],
      ...seed.domains(NOW).map((domain) => [`address ${domain.fqdn}`, domain.tenant_id] as const),
      ['subscription', seed.subscription(NOW).tenant_id],
      ['status summary', seed.statusSummary(NOW).tenant_id],
      ['incident', seed.incident(NOW).tenant_id],
      ['order', seed.upgradeOrder(NOW).tenant_id],
      ['support ticket', seed.supportTicket(NOW).tenant_id],
    ]
    for (const [what, tenantId] of tenants) {
      expect(tenantId, `${what} points at a different tenant than the seed's own`).toBe(
        seed.TENANT_ID
      )
    }
  })

  it('names the same person on the sign-in email, the profile and the owning membership', () => {
    const me = seed.me(NOW)
    const owner = seed.memberships(NOW).find((row) => row.role === 'org_owner')
    expect(me.email, 'the profile email is not the address the demo signs in with').toBe(
      seed.DEMO_SIGN_IN_EMAIL
    )
    expect(owner?.email, "the organisation's owner is not the person the demo signs in as").toBe(
      seed.DEMO_SIGN_IN_EMAIL
    )
    expect(owner?.display_name, "the owner's name differs from the profile's").toBe(me.display_name)
    expect(me.organisations[0]!.membership_id, 'the profile names a membership nobody holds').toBe(
      owner?.id
    )
  })

  it('matches the identity the mock provider actually mints for this realm', () => {
    // The failure this prevents is silent and late: `resolveOrderOwner`
    // compares the `/me` identity against the live session and returns
    // `undefined` on any mismatch, so a seed with the contract example's
    // issuer signs in, renders four screens, and then refuses the order
    // wizard with "Impossible de vérifier vos droits".
    const identity = seed.me(NOW).identities[0]!
    expect(identity.issuer, 'the seeded issuer is not the realm the mock provider issues for').toBe(
      `${keycloakUrl()}/realms/${seed.DEMO_SLUG}`
    )
    expect(identity.subject, 'the seeded subject is not the one the mock token carries').toBe(
      `mock-user-${seed.DEMO_SLUG}`
    )
    expect(seed.realmDiscovery().realm, 'discovery resolves to a different realm').toBe(
      seed.DEMO_SLUG
    )
    expect(
      seed.DEMO_SIGN_IN_EMAIL.endsWith(`@${seed.DEMO_EMAIL_DOMAIN}`),
      'the sign-in address is outside the domain discovery resolves'
    ).toBe(true)
    expect(
      seed.organisation(NOW).email_domains,
      "the organisation does not claim the sign-in address's domain"
    ).toContain(seed.DEMO_EMAIL_DOMAIN)
  })
})

describe('the demo seed adds up', () => {
  it('bills every invoice at the catalogue price for the subscribed pack and tier', () => {
    const subscription = seed.subscription(NOW)
    const price = seed.priceFor(seed.PACK_CODE, seed.CURRENT_TIER_CODE, seed.BILLING_PERIOD)
    expect(
      subscription.price_snapshot.unit_amount_excl_vat.amount_minor,
      'the subscription is priced at something the catalogue does not sell'
    ).toBe(price.amount_excl_vat.amount_minor)
    for (const invoice of seed.invoices(NOW)) {
      expect(
        invoice.lines[0]!.total_excl_vat.amount_minor,
        `${invoice.number} is not billed at the subscription's own price`
      ).toBe(price.amount_excl_vat.amount_minor)
      expect(invoice.subscription_id, `${invoice.number} belongs to another subscription`).toBe(
        subscription.id
      )
    }
  })

  it('adds VAT to the same total on every invoice', () => {
    for (const invoice of [...seed.invoices(NOW), seed.upgradeInvoice(NOW)]) {
      const excl = invoice.total_excl_vat.amount_minor
      const vat = invoice.vat_amount.amount_minor
      expect(vat, `${invoice.number} charges VAT at a rate its own line does not declare`).toBe(
        Math.round((excl * invoice.lines[0]!.vat_rate_bp) / 10_000)
      )
      expect(
        invoice.total_incl_vat.amount_minor,
        `${invoice.number}'s total is not its net plus its VAT`
      ).toBe(excl + vat)
    }
  })

  it('numbers the ledger newest first, without collisions', () => {
    const numbers = seed.invoices(NOW).map((invoice) => invoice.number)
    expect(new Set(numbers).size, 'two invoices in the ledger carry the same number').toBe(
      numbers.length
    )
    expect(numbers.length, 'the ledger is not the seeded number of months').toBe(
      seed.PAID_MONTHS + 1
    )
    expect(numbers[0], "the newest invoice is not the current month's").toBe('FA-2026-0091')
    expect(numbers, 'the ledger is not ordered newest first').toEqual([...numbers].sort().reverse())
  })

  it('leaves exactly one invoice open, and says so on the dunning ladder', () => {
    const ledger = seed.invoices(NOW)
    const open = ledger.filter((invoice) => invoice.state !== 'paid')
    expect(open.length, 'the ledger does not have exactly one open invoice').toBe(1)
    expect(open[0]!.id, "the open invoice is not the current month's").toBe(
      seed.currentInvoice(NOW).id
    )
    const overdue = ledger.filter((invoice) => invoice.state === 'overdue')
    const dunning = seed.dunning()
    expect(
      dunning.state === 'current',
      'the dunning ladder disagrees with the ledger about whether anything is overdue'
    ).toBe(overdue.length === 0)
    expect(
      seed.statusSummary(NOW).billing?.dunning_state,
      'the shell banner would report a different dunning state than the invoices screen'
    ).toBe(dunning.state)
  })

  it('lists as its own addresses the ones its applications answer at', () => {
    const domains = seed.domains(NOW)
    expect(domains.length, 'the demo has no address of its own to list').toBeGreaterThan(0)
    expect(
      domains.map((domain) => `https://${domain.fqdn}`),
      'the domain list and the Applications screen name different addresses'
    ).toEqual(seed.apps().map((app) => app.url))
    expect(
      domains.map((domain) => domain.app),
      'an address is listed under another application than the one that answers at it'
    ).toEqual(seed.apps().map((app) => app.code))

    const provided = Object.values(seed.tenant(NOW).default_urls ?? {}).map(
      (url) => `${new URL(url).host}.`
    )
    for (const domain of domains) {
      expect(domain.state, `${domain.fqdn} is in use on Applications and not live here`).toBe(
        'live'
      )
      expect(
        provided,
        `${domain.fqdn} points somewhere other than an address provided with the instance`
      ).toContain(domain.target.record_value)
    }
    expect(
      domains.filter((domain) => domain.is_canonical).length,
      'the contract allows one main address per instance and per role'
    ).toBe(1)
    expect(
      seed.tenantStatus(NOW).domains,
      'the status view and the domain list would describe different addresses'
    ).toEqual(domains)
  })

  it('measures capacity against the tier the subscription actually pays for', () => {
    const capacity = seed.tenantStatus(NOW).capacity!
    const tier = seed.CAPACITY_TIERS.find(
      (candidate) => candidate.code === seed.subscription(NOW).capacity_tier_code
    )!
    expect(capacity.seats.included, "the seat allowance is not the subscribed tier's").toBe(
      tier.seats_included
    )
    expect(
      capacity.participants.included,
      "the participant allowance is not the subscribed tier's"
    ).toBe(tier.concurrent_participants_included)
    expect(capacity.storage.included, "the storage allowance is not the subscribed tier's").toBe(
      tier.storage_included_bytes
    )
    expect(
      capacity.storage.used,
      'the demo stores more than its tier includes, and the suggested upgrade would not fix it'
    ).toBeLessThanOrEqual(tier.storage_included_bytes)
    expect(capacity.seats.used, 'the seats in use are not the people the console lists').toBe(
      seed.memberships(NOW).length
    )
    expect(
      seed.statusSummary(NOW).capacity,
      'Home and the status screen would draw two different capacity gauges'
    ).toEqual(capacity)
  })

  it('suggests a bigger tier than the one in use, and one the catalogue sells', () => {
    const capacity = seed.tenantStatus(NOW).capacity!
    const current = seed.CAPACITY_TIERS.find((row) => row.code === seed.CURRENT_TIER_CODE)!
    const suggested = seed.CAPACITY_TIERS.find(
      (row) => row.code === capacity.suggested_capacity_tier_code
    )
    expect(suggested, 'the suggested capacity tier is not one the catalogue offers').toBeDefined()
    expect(
      suggested!.concurrent_participants_included,
      'the suggested tier is no bigger than the one already paid for'
    ).toBeGreaterThan(current.concurrent_participants_included)
    expect(
      capacity.participants.pct >= capacity.threshold_pct,
      'the demo prompts an upgrade the gauge gives no reason for'
    ).toBe(true)
  })

  it('tells the same incident on the banner, the status screen and the availability history', () => {
    const incident = seed.incident(NOW)
    const degraded = seed.statusComponents(NOW).filter((row) => row.state !== 'operational')
    expect(degraded.length, 'more than one component is degraded for a single incident').toBe(1)
    expect(degraded[0]!.incident_ref, 'the degraded component names another incident').toBe(
      incident.reference
    )
    expect(degraded[0]!.key, 'the incident and the component disagree about what is affected').toBe(
      incident.component_keys[0]
    )
    expect(degraded[0]!.since, 'the component and the incident started at different times').toBe(
      incident.started_at
    )
    expect(
      seed.statusSummary(NOW).open_incident_ids,
      'the shell would report an incident the status screen does not carry'
    ).toEqual([incident.id])

    const degradedDays = seed
      .availability(NOW)
      .filter((day) => day.components.some((component) => component.state !== 'operational'))
    expect(
      degradedDays.length,
      'the availability history degrades on more than the incident day'
    ).toBe(1)
    expect(degradedDays[0]!.date, 'the degraded day is not the day the incident started').toBe(
      incident.started_at.slice(0, 10)
    )
  })
})

describe('the demo shows only what Kodera sells', () => {
  it('prices no pack that is not on sale, and subscribes to one that is', () => {
    const unavailable = new Set(seed.PACKS.filter((pack) => !pack.available).map((p) => p.code))
    expect(
      seed.PRICES.filter((price) => unavailable.has(price.pack_code)).map((p) => p.id),
      'a price for a pack that is not on sale'
    ).toEqual([])
    const subscribed = seed.PACKS.find((pack) => pack.code === seed.subscription(NOW).pack_code)
    expect(subscribed?.available, 'the demo subscribes to a pack that is not on sale').toBe(true)
  })

  it('runs exactly the applications its pack provides, and shows the status of no other', () => {
    const tenant = seed.tenant(NOW)
    const pack = seed.PACKS.find((candidate) => candidate.code === tenant.pack_code)!
    expect(tenant.apps).toEqual(pack.apps)
    expect(seed.apps().map((app) => app.code)).toEqual(pack.apps)
    expect(tenant.profile_ref?.split('/')[0]).toBe(pack.code)
    // The status screen names services: Docs only for a tenant that runs it.
    const keys = seed.statusComponents(NOW).map((component) => component.key)
    if (!pack.apps.includes('docs')) expect(keys).not.toContain('documents')
  })
})

describe('the demo answers every route this console calls', () => {
  // Scanning the source rather than listing the routes here is the point: a
  // list would go stale the first time a screen learns to call something new,
  // and it would go stale silently — the console would fall through to the
  // generated base handler and put ACME SAS on screen mid-demo.
  // `process.cwd()` is the project root under vitest (`vitest.config.ts` sets
  // no other), not this file's directory: `import.meta.url` is not a file URL
  // in the jsdom environment. A wrong root would find nothing, which is what
  // the scan floor below refuses.
  const ROOT = join(process.cwd(), 'src')

  function sourceFiles(directory: string): string[] {
    const entries = readdirSync(directory, { withFileTypes: true })
    return entries.flatMap((entry) => {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
      return [full]
    })
  }

  /** `GET('/a/{b}')` and `{ method: 'post', path: '/a/{b}' }`, the two shapes
   * every Core API call in this console is written in (ADR-0005: nothing here
   * makes a bespoke `fetch`). */
  function calledRoutes(): Set<string> {
    const found = new Set<string>()
    for (const directory of ['features', 'app', 'api']) {
      for (const file of sourceFiles(join(ROOT, directory))) {
        const source = readFileSync(file, 'utf8')
        for (const match of source.matchAll(/\.(GET|POST|PATCH|DELETE)\(\s*'(\/[^']*)'/g)) {
          found.add(`${match[1]!} ${match[2]!.replace(/\{(\w+)\}/g, ':$1')}`)
        }
        for (const match of source.matchAll(
          /method:\s*'(get|post|patch|delete)',\s*path:\s*'(\/[^']*)'/g
        )) {
          found.add(`${match[1]!.toUpperCase()} ${match[2]!.replace(/\{(\w+)\}/g, ':$1')}`)
        }
      }
    }
    return found
  }

  it('registers exactly the routes it lists', () => {
    // `DEMO_ROUTES` is prose until this runs: a list nobody derives from the
    // handlers is free to name a route the overlay stopped answering, and the
    // coverage assertion below would then pass on a promise the worker does
    // not keep.
    const registered = handlers
      .map((handler) => {
        const info = handler.info as { method: string; path: string }
        return `${info.method} ${String(info.path).replace('*/api/v1', '')}`
      })
      .sort()
    expect(registered, 'the routes the overlay lists are not the ones it registers').toEqual(
      [...DEMO_ROUTES].sort()
    )
  })

  it('finds the calls it is supposed to be scanning', () => {
    // A walker that silently found nothing would make the assertion below
    // pass on an empty set, which is the shape of vacuous green this whole
    // file exists to refuse.
    const called = calledRoutes()
    expect(called.size, 'the source scan found no Core API calls at all').toBeGreaterThan(20)
    expect(called, 'the source scan missed the call every screen makes').toContain('GET /me')
  })

  it('seeds an answer for each one', () => {
    const seeded = new Set(DEMO_ROUTES)
    const missing = [...calledRoutes()].filter((route) => !seeded.has(route)).sort()
    expect(
      missing,
      `the demo would fall through to the contract's own example — and put another company on screen — on: ${missing.join(', ')}`
    ).toEqual([])
  })
})
