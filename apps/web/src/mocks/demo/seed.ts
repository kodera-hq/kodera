// The seeded organisation the walkable demo runs on: ONE company, ONE person,
// ONE subscription, ONE incident, ONE invoice ledger, built here and served to
// every screen by `src/mocks/overlays/demo.groupe-vercelli.ts`.
//
// Why a seed rather than more overlays. The `<area>.<condition>` overlays are
// per-screen fixtures: `home.*` and `invoices.*` each answer their own screen
// well and are free to disagree with one another, which is correct for a test
// that asserts one screen's behaviour and useless for a demo somebody narrates
// across five screens. Nothing forced them to agree, so they do not: on
// `main` today the Home greeting is "Julie" while the sign-in email is
// someone else's, the invoice list calls the subscription by its plan while
// the status screen calls the pack `visio-docs`, and the capacity gauge Home
// shows is `null` while the status screen shows 92 %. This module is the
// single source those disagreements cannot survive: every screen's body is
// derived from the same values, and `seed.test.ts` fails if a derivation
// stops holding.
//
// Everything is a pure function of `now`, so the demo never ages: the open
// incident started 42 minutes ago whenever you open it, the last invoice was
// issued on the 1st of the current month, and the next one falls on the 1st of
// the next one. A fixture with dates baked in reads as stale the moment the
// month turns, which is exactly when somebody is showing it to a customer.
//
// The organisation is the one the design handoff uses (Groupe Vercelli, a Lyon
// construction group) so the console's demo and the product mock describe the
// same company. Data is French because the product copy is; code, names and
// comments are English (AGENTS.md).

import type { components } from '@/api/schema'
import { keycloakUrl } from '../../config'
import { baseDomain } from '../fixtures/domainFixtures'

type AvailabilityDay = components['schemas']['AvailabilityDay']
type CapacityTier = components['schemas']['CapacityTier']
type Domain = components['schemas']['Domain']
type Dpa = components['schemas']['Dpa']
type DunningView = components['schemas']['DunningView']
type Entitlement = components['schemas']['Entitlement']
type HelpContext = components['schemas']['HelpContext']
type Incident = components['schemas']['Incident']
type Invitation = components['schemas']['Invitation']
type Invoice = components['schemas']['Invoice']
type LegalDocument = components['schemas']['LegalDocument']
type Me = components['schemas']['Me']
type Membership = components['schemas']['Membership']
type Money = components['schemas']['Money']
type Order = components['schemas']['Order']
type Organisation = components['schemas']['Organisation']
type OrganisationRole = components['schemas']['OrganisationRole']
type OrganisationStatusSummary = components['schemas']['OrganisationStatusSummary']
type Pack = components['schemas']['Pack']
type PaymentLink = components['schemas']['PaymentLink']
type Plan = components['schemas']['Plan']
type Price = components['schemas']['Price']
type PriceSnapshot = components['schemas']['PriceSnapshot']
type RealmDiscoveryResult = components['schemas']['RealmDiscoveryResult']
type StatusComponent = components['schemas']['StatusComponent']
type Subscription = components['schemas']['Subscription']
type SupportTicket = components['schemas']['SupportTicket']
type Tenant = components['schemas']['Tenant']
type TenantApp = components['schemas']['TenantApp']
type TenantStatusView = components['schemas']['TenantStatusView']

/** The scenario name `src/mocks/overlays/demo.groupe-vercelli.ts` is discovered
 * under, and the one the `?demo=1` entry point writes to session storage. */
export const DEMO_SCENARIO = 'demo.groupe-vercelli'

/** The organisation slug the demo path lives under: `/vercelli/home`, and the
 * realm the sign-in email's domain resolves to. The two are deliberately the
 * same string — the mock identity provider mints `sub: mock-user-<realm>`, and
 * `src/features/order/owner.ts` refuses to open the order wizard unless the
 * `/me` identity matches the session's issuer and subject exactly. */
export const DEMO_SLUG = 'vercelli'
export const DEMO_EMAIL_DOMAIN = 'groupe-vercelli.fr'
export const DEMO_SIGN_IN_EMAIL = `i.kaci@${DEMO_EMAIL_DOMAIN}`

// Readable, stable identifiers rather than `crypto.randomUUID()`: a demo that
// is re-entered mid-walk must land on the same invoice it linked to before the
// reload, and `resolveOrderOwner` validates the UUID shape of both the
// organisation and the membership id. `5eed` reads as "seed" and marks every
// id in this file as one the demo minted, so a body an unrelated base handler
// answered is visible on sight rather than plausible.
const id = (group: number, index: number): string =>
  `5eed${String(group).padStart(4, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`

export const ORGANISATION_ID = id(0, 1)
export const PERSON_ID = id(0, 2)
export const IDENTITY_ID = id(0, 3)
export const MEMBERSHIP_ID = id(0, 4)
export const TENANT_ID = id(0, 5)
export const INSTANCE_ID = id(0, 6)
export const SUBSCRIPTION_ID = id(0, 7)
export const ORDER_ID = id(0, 8)
export const DPA_ID = id(0, 9)
export const INCIDENT_ID = id(0, 10)
export const PAYMENT_LINK_ID = id(0, 11)
export const UPGRADE_INVOICE_ID = id(0, 12)
export const SUPPORT_TICKET_ID = id(0, 13)
export const INVITATION_ID = id(0, 14)

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

const iso = (value: Date): string => value.toISOString()
const shift = (from: Date, ms: number): Date => new Date(from.getTime() + ms)

/** The 1st of the month `offset` months away from `from`, at midnight UTC. */
function monthStart(from: Date, offset: number): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1, 0, 0, 0, 0))
}

/** The last instant of the month `offset` months away from `from` — an invoice
 * issued on the 1st falls due at the end of the same month. */
function monthEnd(from: Date, offset: number): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset + 1, 0, 23, 59, 59, 0)
  )
}

/**
 * The invoice number for the month `monthsBack` behind `now`.
 *
 * Numbers advance by nine per month rather than by one: a real ledger's
 * sequence is shared with every other customer, and a demo whose four invoices
 * read 0091 / 0090 / 0089 / 0088 says "we have four customers". Anchored so
 * that September 2026 is `FA-2026-0091`, which is the number the design
 * handoff's own billing pane shows.
 */
const SEQUENCE_ANCHOR_MONTH = 2026 * 12 + 8
const SEQUENCE_AT_ANCHOR = 91
const SEQUENCE_STEP = 9

export function invoiceNumber(month: Date): string {
  const absolute = month.getUTCFullYear() * 12 + month.getUTCMonth()
  const sequence = SEQUENCE_AT_ANCHOR + (absolute - SEQUENCE_ANCHOR_MONTH) * SEQUENCE_STEP
  return `FA-${String(month.getUTCFullYear())}-${String(sequence).padStart(4, '0')}`
}

const eur = (amountMinor: number): Money => ({ amount_minor: amountMinor, currency: 'EUR' })

const VAT_RATE_BP = 2000
const withVat = (exclMinor: number): number => Math.round((exclMinor * VAT_RATE_BP) / 10_000)

// ---------------------------------------------------------------------------
// The catalogue. Three capacity tiers, the middle one subscribed, the top one
// the reason the demo ends in the order wizard. Shaped like Core's (apps/server
// `apps/billing/catalogue/offer.toml`): one plan per tier, linked to it by the
// price row's `plan_code`, and tiers named « Capacité S » to « Capacité L »
// with no description. The capacities and prices are Core's grid.
// ---------------------------------------------------------------------------

export const PLAN_VERSION = 3
// The pack the demo organisation runs. Visio only: the Visio + Docs pack is not on sale yet,
// and the demo shows only what Kodera sells (the launch catalogue, `order.catalogue-today`).
export const PACK_CODE = 'visio'
export const CURRENT_TIER_CODE = 'M'
export const SUGGESTED_TIER_CODE = 'L'

export const CAPACITY_TIERS: readonly CapacityTier[] = [
  {
    code: 'S',
    name: 'Capacité S',
    description: null,
    seats_included: 80,
    concurrent_participants_included: 25,
    storage_included_bytes: 50_000_000_000,
    available: true,
  },
  {
    code: 'M',
    name: 'Capacité M',
    description: null,
    seats_included: 165,
    concurrent_participants_included: 50,
    storage_included_bytes: 100_000_000_000,
    available: true,
  },
  {
    code: 'L',
    name: 'Capacité L',
    description: null,
    seats_included: 250,
    concurrent_participants_included: 75,
    storage_included_bytes: 250_000_000_000,
    available: true,
  },
]

function tier(code: string): CapacityTier {
  const found = CAPACITY_TIERS.find((candidate) => candidate.code === code)
  if (found === undefined) throw new Error(`Demo seed: no capacity tier "${code}".`)
  return found
}

export const PACKS: readonly Pack[] = [
  {
    code: PACK_CODE,
    name: 'Visio',
    description:
      'Réunions vidéo et salles de réunion permanentes sur votre instance, hébergée dans l’Union européenne.',
    apps: ['visio'],
    profile_ref: 'visio/1.4',
    capacity_tier_codes: ['S', 'M', 'L'],
    available: true,
  },
  {
    code: 'visio-docs',
    name: 'Visio + Docs',
    description:
      'Réunions vidéo, salles de réunion permanentes et documents collaboratifs sur votre instance, hébergée dans l’Union européenne.',
    apps: ['visio', 'docs'],
    profile_ref: 'visio-docs/1.4',
    capacity_tier_codes: ['S', 'M', 'L'],
    // Not on sale until Docs can be deployed: listed, and none of its prices are.
    available: false,
  },
]

function plan(code: string, name: string, description: string): Plan {
  return {
    code,
    version: PLAN_VERSION,
    name,
    description,
    state: 'published',
    packs: [PACK_CODE, 'visio-docs'],
    support_tier: 'standard',
    published_at: '2026-06-15T00:00:00Z',
    retired_at: null,
  }
}

/** The design lane's plan text (French UI catalogue copy). */
export const PLANS: readonly Plan[] = [
  plan(
    'team',
    'Team',
    'Pour une équipe ou une petite organisation. Assistance par e-mail les jours ouvrés ; Docs en option dès sa mise à disposition.'
  ),
  plan(
    'business',
    'Business',
    'Pour une organisation de taille moyenne, avec plusieurs équipes. Assistance par e-mail les jours ouvrés ; Docs en option dès sa mise à disposition.'
  ),
  plan(
    'business-plus',
    'Business Plus',
    'Pour une organisation qui tient de grandes réunions et des événements internes. Assistance par e-mail les jours ouvrés ; Docs inclus dès sa mise à disposition.'
  ),
]

const PLAN_OF_TIER: Readonly<Record<string, string>> = {
  S: 'team',
  M: 'business',
  L: 'business-plus',
}

/** The plan a tier is sold under, as the price rows name it. */
export function planFor(tierCode: string): Plan {
  const found = PLANS.find((candidate) => candidate.code === PLAN_OF_TIER[tierCode])
  if (found === undefined) throw new Error(`Demo seed: no plan for tier "${tierCode}".`)
  return found
}

/**
 * Core's monthly list prices, excluding VAT, in minor units (apps/server
 * `apps/billing/catalogue/offer.toml`), as it launches: Docs is not on sale,
 * so only the Visio pack is priced, and Business Plus (L) is sold Visio-only
 * at 690 €. A pack and tier missing here is not sold.
 */
const MONTHLY_AMOUNT_MINOR: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  visio: { S: 17_900, M: 34_900, L: 69_000 },
}

/** A yearly row is the annual total, as Core's grid sets it: the list less 10 %, rounded down
 * to the euro, twelve times. */
function yearlyAmountMinor(listMinor: number): number {
  return Math.floor((listMinor * 0.9) / 100) * 100 * 12
}

export const PRICES: readonly Price[] = PACKS.flatMap((pack, packIndex) =>
  CAPACITY_TIERS.flatMap((capacityTier, tierIndex) =>
    (['monthly', 'yearly'] as const).flatMap((billingPeriod, periodIndex) => {
      const monthly = MONTHLY_AMOUNT_MINOR[pack.code]?.[capacityTier.code]
      if (monthly === undefined) return []
      return {
        id: id(1, packIndex * 100 + tierIndex * 10 + periodIndex),
        plan_code: planFor(capacityTier.code).code,
        plan_version: PLAN_VERSION,
        pack_code: pack.code,
        capacity_tier_code: capacityTier.code,
        billing_period: billingPeriod,
        amount_excl_vat: eur(billingPeriod === 'yearly' ? yearlyAmountMinor(monthly) : monthly),
        setup_fee_excl_vat: null,
        valid_from: '2026-06-15T00:00:00Z',
        valid_to: null,
      }
    })
  )
)

export function priceFor(packCode: string, tierCode: string, period: 'monthly' | 'yearly'): Price {
  const found = PRICES.find(
    (candidate) =>
      candidate.pack_code === packCode &&
      candidate.capacity_tier_code === tierCode &&
      candidate.billing_period === period
  )
  if (found === undefined) {
    throw new Error(`Demo seed: no price for "${packCode}"/"${tierCode}"/"${period}".`)
  }
  return found
}

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  {
    code: 'cgv',
    version: '2026.06',
    locale: 'fr',
    title: 'Conditions générales de vente',
    pack_code: null,
    html_url: 'https://kodera.io/legal/cgv/2026.06',
    sha256: '0000000000000000000000000000000000000000000000000000000000005ee1',
    download: null,
    published_at: '2026-06-15T00:00:00Z',
  },
  {
    code: 'dpa',
    version: '2026.06',
    locale: 'fr',
    title: 'Contrat de sous-traitance (RGPD)',
    pack_code: PACK_CODE,
    html_url: 'https://kodera.io/legal/dpa/2026.06',
    sha256: '0000000000000000000000000000000000000000000000000000000000005ee2',
    download: null,
    published_at: '2026-06-15T00:00:00Z',
  },
  {
    code: 'sla',
    version: '2026.06',
    locale: 'fr',
    title: 'Engagements de service',
    pack_code: null,
    html_url: 'https://kodera.io/legal/sla/2026.06',
    sha256: '0000000000000000000000000000000000000000000000000000000000005ee3',
    download: null,
    published_at: '2026-06-15T00:00:00Z',
  },
  {
    code: 'aup',
    version: '2026.06',
    locale: 'fr',
    title: "Charte d'usage",
    pack_code: null,
    html_url: 'https://kodera.io/legal/aup/2026.06',
    sha256: '0000000000000000000000000000000000000000000000000000000000005ee4',
    download: null,
    published_at: '2026-06-15T00:00:00Z',
  },
]

// ---------------------------------------------------------------------------
// The company and the people.
// ---------------------------------------------------------------------------

export const ORGANISATION_NAME = 'Groupe Vercelli'
export const ORGANISATION_LEGAL_NAME = 'Groupe Vercelli SAS'
export const PERSON_NAME = 'Inès Kaci'

interface DemoPerson {
  readonly localPart: string
  readonly displayName: string
  readonly role: OrganisationRole
}

/** The five people the console screens name. `SEAT_COUNT` below is how many
 * accounts the workspace actually carries; these are the first page of them. */
const NAMED_PEOPLE: readonly DemoPerson[] = [
  { localPart: 'i.kaci', displayName: PERSON_NAME, role: 'org_owner' },
  { localPart: 'n.chevalier', displayName: 'Nadia Chevalier', role: 'org_admin' },
  { localPart: 'm.teil', displayName: 'Marc Teil', role: 'org_billing' },
  { localPart: 's.ellenstein', displayName: 'Sylvain Ellenstein', role: 'org_member' },
  { localPart: 'p.ferrand', displayName: 'Paul Ferrand', role: 'org_member' },
]

/** Accounts on the tenant, and therefore memberships of the organisation: the
 * two are the same set, so `capacity.seats.used`, `memberships/count` and the
 * membership list's own total are one number rather than three. */
export const SEAT_COUNT = 138

const GENERATED_FIRST_NAMES = [
  'Camille',
  'Rachid',
  'Hélène',
  'Julien',
  'Sofiane',
  'Claire',
  'Marc',
  'Nadia',
] as const
const GENERATED_LAST_NAMES = [
  'Fabre',
  'Roy',
  'Pasquier',
  'Brun',
  'Vasseur',
  'Morel',
  'Renard',
  'Said',
] as const

function generatedPerson(index: number): DemoPerson {
  const first = GENERATED_FIRST_NAMES[index % GENERATED_FIRST_NAMES.length] as string
  const last = GENERATED_LAST_NAMES[
    Math.floor(index / GENERATED_FIRST_NAMES.length) % GENERATED_LAST_NAMES.length
  ] as string
  return {
    localPart: `${first.slice(0, 1).toLowerCase()}.${last.toLowerCase()}${String(index)}`,
    displayName: `${first} ${last}`,
    role: 'org_member',
  }
}

export const PEOPLE: readonly DemoPerson[] = [
  ...NAMED_PEOPLE,
  ...Array.from({ length: SEAT_COUNT - NAMED_PEOPLE.length }, (_unused, offset) =>
    generatedPerson(offset)
  ),
]

export function memberships(now: Date): Membership[] {
  const joined = iso(shift(now, -400 * DAY_MS))
  return PEOPLE.map((person, index) => ({
    id: index === 0 ? MEMBERSHIP_ID : id(3, index),
    organisation_id: ORGANISATION_ID,
    person_id: index === 0 ? PERSON_ID : id(4, index),
    identity_id: index === 0 ? IDENTITY_ID : id(5, index),
    email: `${person.localPart}@${DEMO_EMAIL_DOMAIN}`,
    display_name: person.displayName,
    role: person.role,
    state: 'active',
    source: 'invitation',
    account_kind: 'hosted',
    mfa_enrolled: index < NAMED_PEOPLE.length,
    last_seen_at: iso(shift(now, -(index + 1) * 37 * MINUTE_MS)),
    created_at: joined,
    updated_at: joined,
  }))
}

export function organisation(now: Date): Organisation {
  return {
    id: ORGANISATION_ID,
    slug: DEMO_SLUG,
    name: ORGANISATION_NAME,
    legal_name: ORGANISATION_LEGAL_NAME,
    state: 'active',
    realm: DEMO_SLUG,
    country: 'FR',
    vat_number: 'FR42512345678',
    siren: '512345678',
    vat_regime: 'fr_standard',
    billing_email: `compta@${DEMO_EMAIL_DOMAIN}`,
    billing_address: {
      line1: '42 route de Vienne',
      line2: null,
      postal_code: '69007',
      city: 'Lyon',
      country: 'FR',
    },
    email_domains: [DEMO_EMAIL_DOMAIN],
    locale: 'fr',
    created_at: iso(shift(now, -400 * DAY_MS)),
    updated_at: iso(shift(now, -3 * DAY_MS)),
  }
}

/**
 * `/me` for the signed-in person. The identity's `issuer` and `subject` are
 * the ones the mock identity provider actually mints for this realm, not the
 * contract example's — `resolveOrderOwner` compares them against the live
 * session and refuses the order wizard on a mismatch, which is how a demo
 * ends on "Impossible de vérifier vos droits" three clicks from the end.
 */
export function me(now: Date): Me {
  return {
    id: PERSON_ID,
    email: DEMO_SIGN_IN_EMAIL,
    display_name: PERSON_NAME,
    locale: 'fr',
    staff: false,
    identities: [
      {
        id: IDENTITY_ID,
        issuer: `${keycloakUrl()}/realms/${DEMO_SLUG}`,
        realm: DEMO_SLUG,
        subject: `mock-user-${DEMO_SLUG}`,
        email: DEMO_SIGN_IN_EMAIL,
        email_verified: true,
        mfa_enrolled: true,
        federated_with: null,
        last_login_at: iso(shift(now, -3 * MINUTE_MS)),
      },
    ],
    organisations: [
      {
        organisation: {
          id: ORGANISATION_ID,
          slug: DEMO_SLUG,
          name: ORGANISATION_NAME,
          realm: DEMO_SLUG,
        },
        membership_id: MEMBERSHIP_ID,
        role: 'org_owner',
        state: 'active',
        identity_id: IDENTITY_ID,
        joined_at: iso(shift(now, -400 * DAY_MS)),
      },
    ],
  }
}

export function realmDiscovery(): RealmDiscoveryResult {
  return {
    realm: DEMO_SLUG,
    issuer: `${keycloakUrl()}/realms/${DEMO_SLUG}`,
    openid_configuration_url: `${keycloakUrl()}/realms/${DEMO_SLUG}/.well-known/openid-configuration`,
    organisation: {
      id: ORGANISATION_ID,
      slug: DEMO_SLUG,
      name: ORGANISATION_NAME,
      realm: DEMO_SLUG,
    },
    candidates: [],
  }
}

// ---------------------------------------------------------------------------
// The tenant, its applications, and the incident in progress.
// ---------------------------------------------------------------------------

export const VISIO_URL = `https://visio.${DEMO_EMAIL_DOMAIN}`
export const INCIDENT_REFERENCE = 'INC-2026-071'

/** How long the open incident has been running when the demo opens, and how
 * far ahead the next update is promised. Relative, so both read as live
 * whenever the demo is shown. */
const INCIDENT_STARTED_MINUTES_AGO = 42
const INCIDENT_NEXT_UPDATE_IN_MINUTES = 18

export function apps(): TenantApp[] {
  return [
    {
      code: 'visio',
      name: 'Visio',
      url: VISIO_URL,
      default_url: `https://${DEMO_SLUG}.visio.kodera.io`,
      custom_domain: `visio.${DEMO_EMAIL_DOMAIN}`,
      state: 'live',
      version: '1.4',
    },
  ]
}

/**
 * The organisation's own addresses: one per application that answers at one,
 * derived from `apps()`, so the list on « Domaine & identité » and the
 * addresses on Applications cannot disagree. Each is live and points at the
 * address provided for its application. The contract allows one main address
 * per instance and per role, so only the first carries the flag.
 *
 * The proof record is the contract example's, renamed for the address
 * (`baseDomain`): the list does not show it, and nothing here invents a nonce.
 */
export function domains(now: Date): Domain[] {
  const connected = iso(shift(now, -390 * DAY_MS))
  const renewed = shift(now, -30 * DAY_MS)
  return apps()
    .filter((app) => typeof app.custom_domain === 'string' && app.default_url !== undefined)
    .map((app, index) => {
      const fqdn = app.custom_domain as string
      const provided = `${new URL(app.default_url as string).host}.`
      const base = baseDomain(fqdn)
      return {
        ...base,
        id: id(7, index + 1),
        tenant_id: TENANT_ID,
        kind: 'subdomain' as const,
        role: 'web' as const,
        app: app.code,
        state: 'live' as const,
        is_canonical: index === 0,
        verification: {
          ...base.verification,
          issued_at: connected,
          verified_at: connected,
          checked_at: connected,
          attempts: 1,
          failure_code: null,
        },
        target: {
          record_name: fqdn,
          record_type: 'CNAME' as const,
          record_value: provided,
          observed_value: provided,
        },
        certificate: {
          state: 'issued' as const,
          issued_at: iso(renewed),
          expires_at: iso(shift(renewed, 90 * DAY_MS)),
          days_left: 60,
          issuer: null,
          failure_code: null,
        },
        created_at: connected,
        updated_at: iso(renewed),
      }
    })
}

export function statusComponents(now: Date): StatusComponent[] {
  const since = iso(shift(now, -INCIDENT_STARTED_MINUTES_AGO * MINUTE_MS))
  return [
    {
      id: id(6, 1),
      scope: 'tenant',
      tenant_id: TENANT_ID,
      key: 'web',
      name: 'Web',
      state: 'operational',
      since: iso(shift(now, -30 * DAY_MS)),
      message_key: 'status.web.operational',
      incident_ref: null,
    },
    {
      id: id(6, 2),
      scope: 'tenant',
      tenant_id: TENANT_ID,
      key: 'calls',
      name: 'Calls',
      state: 'degraded',
      since,
      message_key: 'status.calls.degraded',
      incident_ref: INCIDENT_REFERENCE,
    },
    {
      id: id(6, 3),
      scope: 'tenant',
      tenant_id: TENANT_ID,
      // The console, not Docs: the demo organisation runs Visio only.
      key: 'console',
      name: 'Console',
      state: 'operational',
      since: iso(shift(now, -30 * DAY_MS)),
      message_key: 'status.console.operational',
      incident_ref: null,
    },
  ]
}

export function incident(now: Date): Incident {
  const startedAt = shift(now, -INCIDENT_STARTED_MINUTES_AGO * MINUTE_MS)
  return {
    id: INCIDENT_ID,
    reference: INCIDENT_REFERENCE,
    scope: 'tenant',
    tenant_id: TENANT_ID,
    state: 'open',
    severity: 'major',
    component_keys: ['calls'],
    title_key: 'incident.calls.degraded',
    impact_key: 'incident.impact.calls_drop',
    started_at: iso(startedAt),
    resolved_at: null,
    next_update_at: iso(shift(now, INCIDENT_NEXT_UPDATE_IN_MINUTES * MINUTE_MS)),
    updates: [
      { at: iso(shift(startedAt, 7 * MINUTE_MS)), body_key: 'incident.update.investigating' },
    ],
  }
}

export const PARTICIPANTS_USED = 46
// 60 % of the M tier's 100 GB: the demo's pressure is on participants, not storage.
export const STORAGE_USED_BYTES = 60_000_000_000

function capacity(now: Date): NonNullable<TenantStatusView['capacity']> {
  const current = tier(CURRENT_TIER_CODE)
  const pct = (used: number, included: number): number => Math.round((used / included) * 1000) / 10
  return {
    seats: {
      used: SEAT_COUNT,
      included: current.seats_included,
      pct: pct(SEAT_COUNT, current.seats_included),
    },
    participants: {
      used: PARTICIPANTS_USED,
      included: current.concurrent_participants_included,
      pct: pct(PARTICIPANTS_USED, current.concurrent_participants_included),
    },
    storage: {
      used: STORAGE_USED_BYTES,
      included: current.storage_included_bytes,
      pct: pct(STORAGE_USED_BYTES, current.storage_included_bytes),
    },
    threshold_pct: 90,
    upgrade_prompt: true,
    suggested_capacity_tier_code: SUGGESTED_TIER_CODE,
    // Measured now, not a couple of minutes ago. The shell's incident banner
    // renders `status-summary.measured_at` in the "prochaine mise à jour"
    // slot — the contract carries no next-update field there, and
    // `src/app/StatusBanner.tsx` says so — so an older timestamp makes the
    // banner promise an update that already passed while the incident drawer
    // on the status screen shows the real one.
    measured_at: iso(now),
  }
}

export function tenant(now: Date): Tenant {
  const heartbeat = iso(shift(now, -40_000))
  return {
    id: TENANT_ID,
    organisation_id: ORGANISATION_ID,
    slug: DEMO_SLUG,
    name: ORGANISATION_NAME,
    status: 'active',
    status_changed_at: iso(shift(now, -400 * DAY_MS)),
    pack_code: PACK_CODE,
    capacity_tier_code: CURRENT_TIER_CODE,
    apps: ['visio'],
    region: 'fr-par',
    realm: DEMO_SLUG,
    profile_ref: 'visio/1.4',
    profile_commit: '0000000000000000000000000000000000005eed',
    instance_id: INSTANCE_ID,
    default_urls: {
      visio: `https://${DEMO_SLUG}.visio.kodera.io`,
    },
    observed: {
      last_heartbeat_at: heartbeat,
      heartbeat_seq: 512_233,
      stale: false,
      agent_version: '0.4.2',
      profile: {
        app: PACK_CODE,
        version: '1.4',
        compose_digest: 'sha256:0000000000000000000000000000000000000000000000000000000000005eed',
      },
      drift_detected_at: null,
      drift_summary: null,
      maintenance: false,
    },
    locale: 'fr',
    created_at: iso(shift(now, -400 * DAY_MS)),
    updated_at: heartbeat,
  }
}

export function tenantStatus(now: Date): TenantStatusView {
  const provisioned = shift(now, -400 * DAY_MS)
  return {
    tenant_id: TENANT_ID,
    status: 'active',
    status_changed_at: iso(provisioned),
    message_key: 'status.tenant.active',
    provisioning_steps: (
      [
        ['project', 'order', 'Project bootstrap'],
        ['host', 'server', 'Host reserved'],
        ['deploy', 'apps', 'Deploy'],
        ['dns', 'addresses', 'DNS and certificates'],
        ['identity', 'accounts', 'Accounts and sign-in'],
        ['backup', 'backups', 'Backups and monitoring'],
      ] as const
    ).map(([key, label, title], index) => ({
      key,
      customer_label_key: label,
      title,
      status: 'succeeded' as const,
      started_at: iso(shift(provisioned, index * 5 * MINUTE_MS)),
      ended_at: iso(shift(provisioned, (index + 1) * 5 * MINUTE_MS)),
    })),
    current_job: null,
    apps: apps(),
    capacity: capacity(now),
    components: statusComponents(now),
    agent: {
      stale: false,
      last_heartbeat_at: iso(shift(now, -40_000)),
      agent_version: '0.4.2',
      maintenance: false,
    },
    domains: domains(now),
  }
}

/** Thirty days of availability, ending today. Only today carries the open
 * incident's degraded minutes, so the Home card's 30-day figure and the
 * incident on every other screen are the same event counted once. */
export function availability(now: Date): AvailabilityDay[] {
  return Array.from({ length: 30 }, (_unused, offset) => {
    const day = shift(now, -offset * DAY_MS)
    const today = offset === 0
    return {
      date: iso(day).slice(0, 10),
      components: [
        {
          key: 'web' as const,
          state: 'operational' as const,
          degraded_minutes: 0,
          down_minutes: 0,
        },
        {
          key: 'calls' as const,
          state: today ? ('degraded' as const) : ('operational' as const),
          degraded_minutes: today ? INCIDENT_STARTED_MINUTES_AGO : 0,
          down_minutes: 0,
        },
        {
          key: 'console' as const,
          state: 'operational' as const,
          degraded_minutes: 0,
          down_minutes: 0,
        },
      ],
    }
  })
}

// ---------------------------------------------------------------------------
// Money: one subscription, one invoice a month, nothing overdue.
// ---------------------------------------------------------------------------

export const BILLING_PERIOD = 'monthly'

/** How many months of paid history the ledger carries behind the current
 * month's invoice. */
export const PAID_MONTHS = 3

function priceSnapshot(now: Date): PriceSnapshot {
  const price = priceFor(PACK_CODE, CURRENT_TIER_CODE, BILLING_PERIOD)
  const excl = price.amount_excl_vat.amount_minor
  return {
    price_id: price.id,
    plan_code: planFor(CURRENT_TIER_CODE).code,
    plan_version: PLAN_VERSION,
    pack_code: PACK_CODE,
    capacity_tier_code: CURRENT_TIER_CODE,
    billing_period: BILLING_PERIOD,
    unit_amount_excl_vat: eur(excl),
    quantity: 1,
    vat_regime: 'fr_standard',
    vat_rate_bp: VAT_RATE_BP,
    total_excl_vat: eur(excl),
    vat_amount: eur(withVat(excl)),
    total_incl_vat: eur(excl + withVat(excl)),
    captured_at: iso(shift(now, -400 * DAY_MS)),
  }
}

export function subscription(now: Date): Subscription {
  const start = monthStart(now, 0)
  const next = monthStart(now, 1)
  return {
    id: SUBSCRIPTION_ID,
    organisation_id: ORGANISATION_ID,
    tenant_id: TENANT_ID,
    order_id: ORDER_ID,
    state: 'active',
    plan_code: planFor(CURRENT_TIER_CODE).code,
    plan_version: PLAN_VERSION,
    pack_code: PACK_CODE,
    capacity_tier_code: CURRENT_TIER_CODE,
    billing_period: BILLING_PERIOD,
    price_snapshot: priceSnapshot(now),
    current_period_start: iso(start),
    current_period_end: iso(next),
    cancel_at_period_end: false,
    cancelled_at: null,
    next_invoice_at: iso(next),
    price_change_notice_days: 90,
    created_at: iso(shift(now, -400 * DAY_MS)),
    updated_at: iso(start),
  }
}

/** The invoice for the month `monthsBack` behind `now`. `monthsBack === 0` is
 * the current month's: issued on the 1st, due at the end of the month, and the
 * only one still open. */
export function invoice(now: Date, monthsBack: number): Invoice {
  const month = monthStart(now, -monthsBack)
  const due = monthEnd(now, -monthsBack)
  const snapshot = priceSnapshot(now)
  const excl = snapshot.total_excl_vat.amount_minor
  const vat = withVat(excl)
  const open = monthsBack === 0
  return {
    id: id(2, monthsBack),
    organisation_id: ORGANISATION_ID,
    subscription_id: SUBSCRIPTION_ID,
    order_id: ORDER_ID,
    number: invoiceNumber(month),
    state: open ? 'issued' : 'paid',
    currency: 'EUR',
    vat_regime: 'fr_standard',
    lines: [
      {
        description: `${planFor(CURRENT_TIER_CODE).name}, pack Visio, palier ${CURRENT_TIER_CODE}, 1 mois`,
        quantity: 1,
        unit_amount_excl_vat: eur(excl),
        total_excl_vat: eur(excl),
        vat_rate_bp: VAT_RATE_BP,
        period_start: iso(month),
        period_end: iso(monthStart(now, -monthsBack + 1)),
      },
    ],
    total_excl_vat: eur(excl),
    vat_amount: eur(vat),
    total_incl_vat: eur(excl + vat),
    amount_due: open ? eur(excl + vat) : eur(0),
    issued_at: iso(shift(month, 9 * 60 * MINUTE_MS)),
    due_at: iso(due),
    paid_at: open ? null : iso(shift(month, 2 * DAY_MS)),
    pdf_available: true,
    external_ref: `qonto_inv_${invoiceNumber(month).replace(/-/g, '')}`,
    created_at: iso(month),
    updated_at: iso(open ? month : shift(month, 2 * DAY_MS)),
  }
}

/** Newest first, the way the invoice list renders them. */
export function invoices(now: Date): Invoice[] {
  return Array.from({ length: PAID_MONTHS + 1 }, (_unused, monthsBack) => invoice(now, monthsBack))
}

export function currentInvoice(now: Date): Invoice {
  return invoice(now, 0)
}

export function dunning(): DunningView {
  return {
    state: 'current',
    ladder: 'invoice',
    oldest_overdue_invoice_id: null,
    days_overdue: 0,
    amount_due: null,
    hold_until: null,
    steps: [],
  }
}

export function paymentLink(now: Date): PaymentLink {
  const open = currentInvoice(now)
  return {
    id: PAYMENT_LINK_ID,
    invoice_id: open.id,
    provider: 'stripe',
    url: 'https://checkout.stripe.com/c/pay/5eed5eed5e',
    state: 'active',
    amount: open.total_incl_vat,
    expires_at: iso(monthEnd(now, 0)),
    used_at: null,
    created_at: iso(shift(monthStart(now, 0), 9 * 60 * MINUTE_MS)),
  }
}

export function statusSummary(now: Date): OrganisationStatusSummary {
  const components = statusComponents(now)
  return {
    organisation_id: ORGANISATION_ID,
    tenant_id: TENANT_ID,
    billing_enabled: true,
    workspace_pack_code: null,
    overall: 'degraded',
    components,
    capacity: capacity(now),
    billing: { dunning_state: 'current', oldest_overdue_invoice_id: null, amount_due: null },
    maintenance: null,
    open_incident_ids: [INCIDENT_ID],
    measured_at: iso(now),
  }
}

export function entitlements(): Entitlement[] {
  return [
    {
      code: 'custom_domain',
      enabled: true,
      required_pack_code: null,
      required_capacity_tier_code: null,
      limit: null,
      used: null,
    },
    {
      code: 'federation',
      enabled: false,
      required_pack_code: null,
      required_capacity_tier_code: null,
      limit: null,
      used: null,
    },
  ]
}

export function helpContext(now: Date): HelpContext {
  return {
    area: 'status',
    screen: 'overview',
    articles: [
      {
        id: 'capacite',
        title: 'Comprendre les paliers de capacité',
        url: 'https://aide.kodera.io/capacite',
      },
    ],
    sla: {
      support_tier: 'standard',
      first_response_target_minutes: 240,
      business_hours_label: '09:00-18:00 Europe/Paris, lundi au vendredi',
      business_hours_timezone: 'Europe/Paris',
      next_response_due_at: iso(shift(now, 4 * 60 * MINUTE_MS)),
    },
    incident: null,
  }
}

// ---------------------------------------------------------------------------
// The order the demo ends on: the same organisation moving to the tier the
// capacity gauge already suggested.
// ---------------------------------------------------------------------------

/**
 * The invoice the upgrade produces — a NEW row, at the `L` tier's price, not
 * the current month's subscription invoice: an order that hands back an
 * invoice already marked paid is the kind of detail a customer notices while
 * you are explaining that nothing here is faked.
 */
export function upgradeInvoice(now: Date): Invoice {
  const price = priceFor(PACK_CODE, SUGGESTED_TIER_CODE, BILLING_PERIOD)
  const excl = price.amount_excl_vat.amount_minor
  const vat = withVat(excl)
  const month = monthStart(now, 1)
  return {
    id: UPGRADE_INVOICE_ID,
    organisation_id: ORGANISATION_ID,
    subscription_id: SUBSCRIPTION_ID,
    order_id: ORDER_ID,
    number: invoiceNumber(month),
    state: 'issued',
    currency: 'EUR',
    vat_regime: 'fr_standard',
    lines: [
      {
        description: `${planFor(SUGGESTED_TIER_CODE).name}, pack Visio, palier ${SUGGESTED_TIER_CODE}, 1 mois`,
        quantity: 1,
        unit_amount_excl_vat: eur(excl),
        total_excl_vat: eur(excl),
        vat_rate_bp: VAT_RATE_BP,
        period_start: iso(month),
        period_end: iso(monthStart(now, 2)),
      },
    ],
    total_excl_vat: eur(excl),
    vat_amount: eur(vat),
    total_incl_vat: eur(excl + vat),
    amount_due: eur(excl + vat),
    issued_at: iso(now),
    due_at: iso(monthEnd(now, 1)),
    paid_at: null,
    pdf_available: true,
    external_ref: `qonto_inv_${invoiceNumber(month).replace(/-/g, '')}`,
    created_at: iso(now),
    updated_at: iso(now),
  }
}

export function upgradePaymentLink(now: Date): PaymentLink {
  const target = upgradeInvoice(now)
  return {
    id: PAYMENT_LINK_ID,
    invoice_id: target.id,
    provider: 'stripe',
    url: 'https://checkout.stripe.com/c/pay/5eed5eed5e',
    state: 'active',
    amount: target.total_incl_vat,
    expires_at: iso(monthEnd(now, 1)),
    used_at: null,
    created_at: iso(now),
  }
}

export function upgradeOrder(now: Date): Order {
  const price = priceFor(PACK_CODE, SUGGESTED_TIER_CODE, BILLING_PERIOD)
  const excl = price.amount_excl_vat.amount_minor
  const vat = withVat(excl)
  return {
    id: ORDER_ID,
    organisation_id: ORGANISATION_ID,
    state: 'awaiting_payment',
    pack_code: PACK_CODE,
    capacity_tier_code: SUGGESTED_TIER_CODE,
    apps: ['visio'],
    billing_period: BILLING_PERIOD,
    price_snapshot: {
      price_id: price.id,
      plan_code: planFor(SUGGESTED_TIER_CODE).code,
      plan_version: PLAN_VERSION,
      pack_code: PACK_CODE,
      capacity_tier_code: SUGGESTED_TIER_CODE,
      billing_period: BILLING_PERIOD,
      unit_amount_excl_vat: eur(excl),
      quantity: 1,
      vat_regime: 'fr_standard',
      vat_rate_bp: VAT_RATE_BP,
      total_excl_vat: eur(excl),
      vat_amount: eur(vat),
      total_incl_vat: eur(excl + vat),
      captured_at: iso(now),
    },
    dpa_id: DPA_ID,
    subscription_id: SUBSCRIPTION_ID,
    invoice_id: UPGRADE_INVOICE_ID,
    tenant_id: TENANT_ID,
    purchase_order_ref: 'BC-2026-118',
    placed_by: PERSON_ID,
    created_at: iso(now),
    updated_at: iso(now),
  }
}

export function dpa(now: Date): Dpa {
  return {
    id: DPA_ID,
    organisation_id: ORGANISATION_ID,
    tenant_id: TENANT_ID,
    version: '2026.06',
    state: 'generated',
    locale: 'fr',
    pack_code: PACK_CODE,
    sha256: '0000000000000000000000000000000000000000000000000000000000005ee2',
    sub_processors: [
      { name: 'Scaleway', role: 'Hébergement et infrastructure', location: 'Paris', country: 'FR' },
    ],
    annexes: ['A', 'B', 'C', 'D'],
    generated_at: iso(now),
    accepted_at: null,
    accepted_by: null,
    superseded_by: null,
  }
}

/**
 * The ticket a "Nous en parler" or "Écrire au support" button creates. Its
 * `tenant_context` repeats what the status screen already showed — the pack,
 * the tier, the open incident's component — because the pitch on that screen
 * is that support already knows; a ticket that came back describing a
 * different tenant would say the opposite.
 */
export function supportTicket(now: Date): SupportTicket {
  return {
    id: SUPPORT_TICKET_ID,
    organisation_id: ORGANISATION_ID,
    tenant_id: TENANT_ID,
    subject: 'Participants éjectés des réunions après quelques minutes',
    category: 'calls',
    severity: 'degraded',
    state: 'open',
    sla: {
      support_tier: 'standard',
      first_response_target_minutes: 240,
      first_response_due_at: iso(shift(now, 4 * 60 * MINUTE_MS)),
      first_response_at: null,
      next_response_due_at: iso(shift(now, 4 * 60 * MINUTE_MS)),
      business_hours_label: '09:00-18:00 Europe/Paris, lundi au vendredi',
    },
    tenant_context: {
      tenant_slug: DEMO_SLUG,
      tenant_status: 'active',
      pack_code: PACK_CODE,
      capacity_tier_code: CURRENT_TIER_CODE,
      agent_stale: false,
      open_incident_component_keys: ['calls'],
      last_job_id: null,
    },
    message_count: 1,
    last_message_at: iso(now),
    created_by: PERSON_ID,
    external_ref: null,
    created_at: iso(now),
    updated_at: iso(now),
  }
}

/**
 * The invitation a resend answers with. The demo's own invitation list is
 * empty on purpose — Home would otherwise offer a banner whose only action
 * leads to a screen this build still renders as "pas encore disponible" — so
 * nothing in the walk reaches this; it exists so `DEMO_ROUTES` can claim
 * every route without an exception.
 */
export function invitation(now: Date): Invitation {
  return {
    id: INVITATION_ID,
    organisation_id: ORGANISATION_ID,
    email: `r.fabre@${DEMO_EMAIL_DOMAIN}`,
    role: 'org_member',
    state: 'pending',
    realm: DEMO_SLUG,
    invited_by: PERSON_ID,
    expires_at: iso(shift(now, 7 * DAY_MS)),
    accepted_at: null,
    membership_id: null,
    sent_count: 2,
    last_sent_at: iso(now),
    created_at: iso(shift(now, -2 * DAY_MS)),
  }
}
