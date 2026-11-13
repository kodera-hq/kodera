import {
  readPeopleState,
  memberDetail,
  mutateMember,
  invitePeople,
  mutateInvitation,
} from '../demo/peopleState'
import {
  localFixtureIds,
  localMemberships,
  localDiscovery,
  localMe,
  localRequestWorkspace,
  findLocalWorkspace,
  localOrganisation,
  localTenant,
  localWorkspace,
  withLocalMemberships,
} from '../demo/localWorkspaces'
import * as community from '../demo/community'
import { MESSAGING_DEMO_ROUTES, messagingDemoHandlers } from '../demo/messagingMedia'
// The walkable demo (docs/dev/DEMO.md): one scenario overlay that answers
// EVERY route the built areas call, from the one seed in `src/mocks/demo/seed.ts`.
//
// Unlike the `<area>.<condition>` overlays beside it, this one is deliberately
// broad. Those exist so a spec can state one screen's condition and leave the
// rest to the generated base handlers; this one exists so a person can walk
// five screens in front of a customer and have them describe the same company.
// Any route left to a base handler here would answer with the contract's own
// example — ACME SAS, Julie Marchand, `INV-2026-0142` — in the middle of a
// sentence about Groupe Vercelli, which is exactly the failure the seed is for.
// `src/mocks/demo/seed.test.ts` asserts every route below is served.
//
// Paths are matched on `:organisation_id` / `:tenant_id` rather than the
// seed's own ids: an overlay pinned to a literal id stops answering the moment
// something upstream hands the console a different one, and it does so by
// silently falling through to the base handler rather than by failing.

import { http, HttpResponse, type HttpHandler } from 'msw'
import type { components } from '@/api/schema'
import { isTenantSlug } from '@/api/tenantSlug'
import * as seed from '../demo/seed'
import {
  demoStatusSummary,
  demoTenantStatus,
  demoStatusComponents,
  demoIncidents,
} from '../demo/interactiveStatus'
import { problem } from '../problem'
import { readyWorkspace } from '../fixtures/workspaceFixtures'
import { memberImportHandlers } from './support/people'

type OrderResult = components['schemas']['OrderResult']

const BASE = '*/api/v1'
const isCommunity = (id: unknown) =>
  id === community.COMMUNITY_ORGANISATION_ID || id === community.COMMUNITY_SLUG
const isCommunityOrLocal = (id: unknown) => isCommunity(id) || !!findLocalWorkspace(id)
const organisationFor = (id: unknown) =>
  findLocalWorkspace(id)
    ? localOrganisation(findLocalWorkspace(id)!, now())
    : isCommunity(id)
      ? community.communityOrganisation(now())
      : seed.organisation(now())
const initialMembershipsFor = (id: unknown) =>
  findLocalWorkspace(id)
    ? localMemberships(findLocalWorkspace(id)!, now())
    : isCommunity(id)
      ? community.communityMemberships(now())
      : seed.memberships(now())
const peopleFor = (id: unknown) =>
  readPeopleState(organisationFor(id).id, initialMembershipsFor(id))
const membershipsFor = (id: unknown) =>
  isCommunityOrLocal(id) ? peopleFor(id).members : initialMembershipsFor(id)
const requestPeopleId = (request: Request) =>
  localRequestWorkspace(request)
    ? localFixtureIds(localRequestWorkspace(request)!).organisation
    : community.COMMUNITY_ORGANISATION_ID
const isCommunityRequest = (request: Request) =>
  community.isCommunityDemoRequest(request) ||
  !!localRequestWorkspace(request) ||
  isCommunity(new URL(request.url).searchParams.get('organisation_id'))
const isCommunityTenant = (id: unknown) =>
  id === community.COMMUNITY_TENANT_ID || !!findLocalWorkspace(id)

const requestId = (): string => crypto.randomUUID()
const headers = () => ({ 'X-Request-Id': requestId() })
const page = <T>(data: readonly T[]) => ({ data: [...data], next_cursor: null, has_more: false })

/** `new Date()` per request, not per module load: a demo left open across a
 * break must not still claim its incident started 42 minutes before the tab
 * was opened. */
const now = (): Date => new Date()

/** The routes this overlay answers, as `METHOD /path` — the list
 * `seed.test.ts` compares against what the console actually calls, so a route
 * added to a screen without a seeded answer is a failing test rather than a
 * stray ACME row mid-demo. */
export const DEMO_ROUTES: readonly string[] = [
  'POST /workspaces/instant-claim',
  'POST /auth/discover',
  'GET /me',
  'GET /organisations/:organisation_id',
  'GET /organisations/:organisation_id/bootstrap',
  'GET /organisations/:organisation_id/memberships',
  'GET /organisations/:organisation_id/memberships/count',
  'GET /organisations/:organisation_id/invitations',
  'GET /organisations/:organisation_id/memberships/:membership_id',
  'PATCH /organisations/:organisation_id/memberships/:membership_id',
  'DELETE /organisations/:organisation_id/memberships/:membership_id',
  'POST /organisations/:organisation_id/invitations',
  'DELETE /invitations/:invitation_id',
  'GET /organisations/:organisation_id/enrolment-tokens',
  'POST /organisations/:organisation_id/enrolment-tokens',
  'DELETE /organisations/:organisation_id/enrolment-tokens/:enrolment_token_id',
  'POST /organisations/:organisation_id/member-imports',
  'GET /member-imports/:member_import_id',
  'PATCH /member-imports/:member_import_id',
  'POST /member-imports/:member_import_id/actions/execute',
  'GET /organisations/:organisation_id/status-summary',
  'GET /organisations/:organisation_id/entitlements',
  'GET /organisations/:organisation_id/subscriptions',
  'GET /organisations/:organisation_id/invoices',
  'GET /organisations/:organisation_id/dunning',
  'GET /organisations/:organisation_id/tenants',
  'GET /tenants/:tenant_id/status',
  'GET /tenants/:tenant_id/availability',
  'GET /tenants/:tenant_id/domains',
  'GET /status/components',
  'GET /status/incidents',
  'GET /invoices/:invoice_id',
  'GET /invoices/:invoice_id/download',
  'GET /invoices/:invoice_id/payment-link',
  'POST /invoices/:invoice_id/payment-link',
  'GET /catalog/plans',
  'GET /catalog/packs',
  'GET /catalog/capacity-tiers',
  'GET /catalog/prices',
  'GET /legal-documents',
  'GET /slug-availability',
  'GET /support/help-context',
  'GET /orders/:order_id',
  'GET /organisations/:organisation_id/orders',
  'POST /organisations/:organisation_id/orders',
  'POST /organisations/:organisation_id/dpa',
  'POST /organisations/:organisation_id/tenants',
  'POST /support/tickets',
  'POST /community/support/tickets',
  'POST /invitations/:invitation_id/actions/resend',
  'POST /invitations/accept',
  'GET /organisations/:organisation_id/workspace',
  'POST /organisations/:organisation_id/workspace/actions/initialise',
  ...MESSAGING_DEMO_ROUTES,
]

/** The invoice whose id the console asked for, or the current month's — the
 * detail screen is reachable from a link the list drew, so the id is always
 * one of the seed's own, but a hand-typed URL should still land somewhere
 * that belongs to this organisation rather than on a 404 mid-demo. */
function invoiceById(invoiceId: string | readonly string[] | undefined) {
  const wanted = Array.isArray(invoiceId) ? invoiceId[0] : invoiceId
  const ledger = [...seed.invoices(now()), seed.upgradeInvoice(now())]
  return ledger.find((row) => row.id === wanted) ?? seed.currentInvoice(now())
}

/** The payment link belonging to the invoice asked for, so the amount on the
 * payment screen is the amount on the invoice that led to it. */
function paymentLinkFor(invoiceId: string | readonly string[] | undefined) {
  const wanted = Array.isArray(invoiceId) ? invoiceId[0] : invoiceId
  return wanted === seed.UPGRADE_INVOICE_ID
    ? seed.upgradePaymentLink(now())
    : seed.paymentLink(now())
}

export const handlers: HttpHandler[] = [
  // A demo never allocates a Cloud tenant or fabricates a signed invitation.
  http.post(`${BASE}/workspaces/instant-claim`, () =>
    HttpResponse.json({ code: 'local-preview-only' }, { status: 503, headers: headers() })
  ),
  http.post(`${BASE}/auth/discover`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { slug?: unknown; email?: unknown }
    const selected =
      body.slug === community.COMMUNITY_SLUG ||
      (typeof body.email === 'string' && body.email.endsWith('@community.kodera.io'))
    const local = findLocalWorkspace(body.slug)
    return HttpResponse.json(
      local
        ? localDiscovery(local)
        : selected
          ? community.communityDiscovery()
          : seed.realmDiscovery(),
      {
        headers: headers(),
      }
    )
  }),
  http.get(`${BASE}/me`, ({ request }) =>
    HttpResponse.json(
      withLocalMemberships(
        localRequestWorkspace(request)
          ? localMe(localRequestWorkspace(request)!, now())
          : community.isCommunityDemoRequest(request)
            ? community.communityMe(now())
            : seed.me(now()),
        now()
      ),
      { headers: headers() }
    )
  ),

  // The first-owner claim (behind `VITE_FIRST_OWNER_JOURNEY`): the demo organisation's claim was
  // consumed long ago, by its owner.
  http.get(`${BASE}/organisations/:organisation_id/bootstrap`, ({ params }) => {
    const organisation = organisationFor(params.organisation_id)
    const at = organisation.created_at
    const owner = membershipsFor(params.organisation_id)[0]!
    const bootstrap: components['schemas']['OrganisationBootstrap'] = {
      organisation_id: organisation.id,
      slug: organisation.slug,
      organisation_state: 'active',
      intake: {
        instruction_ref: 'DEMO-0001',
        recorded_at: at,
        intended_owner_email_masked: (owner.email ?? '').replace(/^(.).*(.)@/, '$1***$2@'),
      },
      realm: {
        state: 'ready',
        name: organisation.realm ?? null,
        job_id: '0b5e0000-0000-4000-8000-000000000001',
      },
      identity_mapping: { state: 'ready', identity_id: owner.identity_id ?? null, bound_at: at },
      claim: {
        state: 'consumed',
        issued_at: at,
        expires_at: at,
        consumed_at: at,
        revoked_at: null,
        membership_id: owner.id,
      },
      updated_at: at,
    }
    return HttpResponse.json(bootstrap, { headers: headers() })
  }),
  http.get(`${BASE}/organisations/:organisation_id`, ({ params }) =>
    HttpResponse.json(
      findLocalWorkspace(params.organisation_id)
        ? localOrganisation(findLocalWorkspace(params.organisation_id)!, now())
        : isCommunity(params.organisation_id)
          ? community.communityOrganisation(now())
          : seed.organisation(now()),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/organisations/:organisation_id/memberships`, ({ params }) =>
    HttpResponse.json(page(membershipsFor(params.organisation_id)), { headers: headers() })
  ),
  http.get(`${BASE}/organisations/:organisation_id/memberships/count`, ({ params }) =>
    HttpResponse.json(
      {
        count: membershipsFor(params.organisation_id).length,
        counted_at: new Date().toISOString(),
      },
      { headers: headers() }
    )
  ),
  // Empty on purpose: the demo's Home shows the invite CALL TO ACTION, not a
  // pending-invitation banner that links to a screen this build still renders
  // as "pas encore disponible".
  http.get(`${BASE}/organisations/:organisation_id/invitations`, ({ params, request }) =>
    HttpResponse.json(
      page(
        isCommunityOrLocal(params.organisation_id)
          ? peopleFor(params.organisation_id).invitations.filter(
              (invitation) =>
                !new URL(request.url).searchParams.get('state') ||
                invitation.state === new URL(request.url).searchParams.get('state')
            )
          : []
      ),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/organisations/:organisation_id/status-summary`, ({ params }) =>
    HttpResponse.json(
      isCommunityOrLocal(params.organisation_id)
        ? {
            ...demoStatusSummary(now()),
            organisation_id: organisationFor(params.organisation_id).id,
            tenant_id: findLocalWorkspace(params.organisation_id)
              ? localFixtureIds(findLocalWorkspace(params.organisation_id)!).tenant
              : community.COMMUNITY_TENANT_ID,
            overall: 'operational',
            billing_enabled: false,
            billing: null,
            capacity: null,
            open_incident_ids: [],
            components: community.communityStatusComponents(now()).map((item) => ({
              ...item,
              tenant_id: findLocalWorkspace(params.organisation_id)
                ? localFixtureIds(findLocalWorkspace(params.organisation_id)!).tenant
                : community.COMMUNITY_TENANT_ID,
            })),
          }
        : demoStatusSummary(now()),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/organisations/:organisation_id/entitlements`, ({ params }) =>
    HttpResponse.json(
      page(
        isCommunityOrLocal(params.organisation_id)
          ? seed.entitlements().map((item) => ({ ...item, enabled: true }))
          : seed.entitlements()
      ),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/organisations/:organisation_id/subscriptions`, ({ params }) =>
    HttpResponse.json(
      page(isCommunityOrLocal(params.organisation_id) ? [] : [seed.subscription(now())]),
      {
        headers: headers(),
      }
    )
  ),
  http.get(`${BASE}/organisations/:organisation_id/invoices`, ({ params }) =>
    HttpResponse.json(
      page(isCommunityOrLocal(params.organisation_id) ? [] : seed.invoices(now())),
      {
        headers: headers(),
      }
    )
  ),
  http.get(`${BASE}/organisations/:organisation_id/dunning`, () =>
    HttpResponse.json(seed.dunning(), { headers: headers() })
  ),
  http.get(`${BASE}/organisations/:organisation_id/tenants`, ({ params }) =>
    HttpResponse.json(
      page([
        findLocalWorkspace(params.organisation_id)
          ? localTenant(findLocalWorkspace(params.organisation_id)!, now())
          : isCommunity(params.organisation_id)
            ? community.communityTenant(now())
            : seed.tenant(now()),
      ]),
      { headers: headers() }
    )
  ),

  http.get(`${BASE}/tenants/:tenant_id/status`, ({ params }) =>
    HttpResponse.json(
      findLocalWorkspace(params.tenant_id)
        ? {
            ...community.communityTenantStatus(now()),
            tenant_id: String(params.tenant_id),
            apps: [],
            domains: [],
            components: community
              .communityStatusComponents(now())
              .map((item) => ({ ...item, tenant_id: String(params.tenant_id) })),
          }
        : params.tenant_id === community.COMMUNITY_TENANT_ID
          ? community.communityTenantStatus(now())
          : demoTenantStatus(now()),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/tenants/:tenant_id/availability`, ({ params }) =>
    HttpResponse.json(
      page(
        isCommunityTenant(params.tenant_id)
          ? community.communityAvailability(now())
          : seed.availability(now())
      ),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/tenants/:tenant_id/domains`, ({ params }) =>
    HttpResponse.json(
      page(
        findLocalWorkspace(params.tenant_id)
          ? []
          : params.tenant_id === community.COMMUNITY_TENANT_ID
            ? community.communityDomains(now())
            : seed.domains(now())
      ),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/status/components`, ({ request }) =>
    HttpResponse.json(
      page(
        isCommunityRequest(request)
          ? community.communityStatusComponents(now())
          : demoStatusComponents(now())
      ),
      { headers: headers() }
    )
  ),
  http.get(`${BASE}/status/incidents`, ({ request }) =>
    HttpResponse.json(page(isCommunityRequest(request) ? [] : demoIncidents(now())), {
      headers: headers(),
    })
  ),

  http.get(`${BASE}/invoices/:invoice_id`, ({ params }) =>
    HttpResponse.json(invoiceById(params['invoice_id']), { headers: headers() })
  ),
  http.get(`${BASE}/invoices/:invoice_id/download`, ({ params }) => {
    const row = invoiceById(params['invoice_id'])
    return HttpResponse.json(
      {
        url: `https://s3.fr-par.scw.cloud/kodera-invoices/${row.number}.pdf?X-Amz-Signature=redacted`,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        content_type: 'application/pdf',
        filename: `${row.number}.pdf`,
        sha256: '0000000000000000000000000000000000000000000000000000000000005ee5',
        size_bytes: 48_213,
      },
      { headers: headers() }
    )
  }),
  http.get(`${BASE}/invoices/:invoice_id/payment-link`, ({ params }) =>
    HttpResponse.json(paymentLinkFor(params['invoice_id']), { headers: headers() })
  ),
  http.post(`${BASE}/invoices/:invoice_id/payment-link`, ({ params }) =>
    HttpResponse.json(paymentLinkFor(params['invoice_id']), { status: 201, headers: headers() })
  ),

  http.get(`${BASE}/catalog/plans`, () =>
    HttpResponse.json(page(seed.PLANS), { headers: headers() })
  ),
  http.get(`${BASE}/catalog/packs`, () =>
    HttpResponse.json(page(seed.PACKS), { headers: headers() })
  ),
  http.get(`${BASE}/catalog/capacity-tiers`, () =>
    HttpResponse.json(page(seed.CAPACITY_TIERS), { headers: headers() })
  ),
  http.get(`${BASE}/catalog/prices`, ({ request }) => {
    const query = new URL(request.url).searchParams
    const packCode = query.get('pack_code')
    const billingPeriod = query.get('billing_period')
    return HttpResponse.json(
      page(
        seed.PRICES.filter(
          (price) =>
            (packCode === null || price.pack_code === packCode) &&
            (billingPeriod === null || price.billing_period === billingPeriod)
        )
      ),
      { headers: headers() }
    )
  }),
  http.get(`${BASE}/legal-documents`, () =>
    HttpResponse.json(page(seed.LEGAL_DOCUMENTS), { headers: headers() })
  ),
  http.get(`${BASE}/slug-availability`, ({ request }) => {
    const slug = new URL(request.url).searchParams.get('slug') ?? ''
    // The parameter carries the whole tenant slug pattern; a value that fails it is refused
    // before any availability answer, never echoed back as a `slug` the schema would refuse.
    if (!isTenantSlug(slug)) {
      return problem('https://kodera.io/problems/malformed-request', {
        detail: 'slug: not a tenant slug (3-32 characters, a DNS label).',
        instance: '/api/v1/slug-availability',
      })
    }
    return HttpResponse.json(
      {
        slug,
        available:
          slug !== seed.DEMO_SLUG && slug !== community.COMMUNITY_SLUG && !findLocalWorkspace(slug),
        reason: null,
      },
      { headers: headers() }
    )
  }),
  http.get(`${BASE}/support/help-context`, ({ request }) =>
    HttpResponse.json(
      isCommunityRequest(request) ? community.communityHelpContext() : seed.helpContext(now()),
      { headers: headers() }
    )
  ),

  http.get(`${BASE}/orders/:order_id`, () =>
    HttpResponse.json(seed.upgradeOrder(now()), { headers: headers() })
  ),
  // The demo organisation's own order: one page, so a placed order is seen before any other.
  http.get(`${BASE}/organisations/:organisation_id/orders`, ({ params }) =>
    HttpResponse.json(
      page(isCommunityOrLocal(params.organisation_id) ? [] : [seed.upgradeOrder(now())]),
      {
        headers: headers(),
      }
    )
  ),
  http.post(`${BASE}/organisations/:organisation_id/orders`, ({ params }) => {
    if (isCommunityOrLocal(params.organisation_id))
      return problem('https://kodera.io/problems/forbidden')
    const moment = now()
    const result: OrderResult = {
      order: seed.upgradeOrder(moment),
      subscription: seed.subscription(moment),
      tenant: seed.tenant(moment),
      invoice: seed.upgradeInvoice(moment),
      payment_link: seed.upgradePaymentLink(moment),
      dpa: seed.dpa(moment),
      billing_pending: false,
    }
    return HttpResponse.json(result, { status: 201, headers: headers() })
  }),
  http.post(`${BASE}/organisations/:organisation_id/dpa`, ({ params }) =>
    isCommunityOrLocal(params.organisation_id)
      ? problem('https://kodera.io/problems/forbidden')
      : HttpResponse.json(seed.dpa(now()), { status: 201, headers: headers() })
  ),
  // The demo organisation bills and already has its tenant: the one-step creation is refused
  // as Core refuses it on a deployment that bills.
  http.post(`${BASE}/organisations/:organisation_id/tenants`, () =>
    problem('https://kodera.io/problems/billing-enabled')
  ),

  // The private ticket form is unavailable in simulation builds.
  http.post(`${BASE}/community/support/tickets`, () =>
    problem('https://kodera.io/problems/forbidden')
  ),
  http.post(`${BASE}/support/tickets`, ({ request }) =>
    isCommunityRequest(request)
      ? problem('https://kodera.io/problems/forbidden')
      : HttpResponse.json(seed.supportTicket(now()), { status: 201, headers: headers() })
  ),
  // Unreachable while `listInvitations` above answers an empty page, and
  // seeded anyway: `DEMO_ROUTES` is the claim that no screen of this console
  // can reach a route the demo does not answer, and a claim with an exception
  // in it is not one.
  http.post(`${BASE}/invitations/:invitation_id/actions/resend`, ({ request, params }) =>
    isCommunityRequest(request)
      ? mutateInvitation(
          requestPeopleId(request),
          peopleFor(requestPeopleId(request)),
          String(params.invitation_id),
          request
        )
      : HttpResponse.json(seed.invitation(now()), { headers: headers() })
  ),
  // The invitation page (12-invitation-accept.md) needs a protected sign-in the demo never
  // performs; seeded for the same reason as the resend above.
  http.post(`${BASE}/invitations/accept`, ({ request }) =>
    isCommunityRequest(request)
      ? problem('https://kodera.io/problems/not-found')
      : HttpResponse.json(seed.memberships(now())[0]!, { headers: headers() })
  ),

  // Community and newly created workspaces retain People changes for this browser session.
  // The independent narrated scenario keeps its original deterministic fixture responses.
  http.get(`${BASE}/organisations/:organisation_id/memberships/:membership_id`, ({ params }) => {
    if (isCommunityOrLocal(params.organisation_id))
      return memberDetail(
        peopleFor(params.organisation_id),
        String(params.membership_id),
        initialMembershipsFor(params.organisation_id)[0]!.id
      )
    const all = membershipsFor(params.organisation_id)
    const found = all.find((m) => m.id === params['membership_id']) ?? all[0]!
    const self = found.id === all[0]?.id
    return HttpResponse.json(
      {
        ...found,
        can_change_role: !self,
        can_remove: !self,
        blocked_reason: self ? 'self' : null,
        invitation_id: null,
      },
      { headers: { ...headers(), ETag: `"${found.id}"` } }
    )
  }),
  http.patch(
    `${BASE}/organisations/:organisation_id/memberships/:membership_id`,
    async ({ params, request }) => {
      if (isCommunityOrLocal(params.organisation_id))
        return mutateMember(
          organisationFor(params.organisation_id).id,
          peopleFor(params.organisation_id),
          String(params.membership_id),
          initialMembershipsFor(params.organisation_id)[0]!.id,
          request
        )
      const all = membershipsFor(params.organisation_id)
      const found = all.find((m) => m.id === params['membership_id']) ?? all[0]!
      const body = (await request.json()) as {
        role?: typeof found.role
        state?: 'active' | 'suspended'
      }
      return HttpResponse.json(
        { ...found, role: body.role ?? found.role, state: body.state ?? found.state },
        { headers: { ...headers(), ETag: `"${found.id}-2"` } }
      )
    }
  ),
  // The removed membership, without the person's contact fields (contract 0.18.0).
  http.delete(
    `${BASE}/organisations/:organisation_id/memberships/:membership_id`,
    ({ params, request }) => {
      if (isCommunityOrLocal(params.organisation_id))
        return mutateMember(
          organisationFor(params.organisation_id).id,
          peopleFor(params.organisation_id),
          String(params.membership_id),
          initialMembershipsFor(params.organisation_id)[0]!.id,
          request
        )
      const found = membershipsFor(params.organisation_id).find(
        (m) => m.id === params['membership_id']
      )
      if (found === undefined) return problem('https://kodera.io/problems/not-found')
      const { email: _email, display_name: _name, ...removed } = { ...found, state: 'removed' }
      return HttpResponse.json(removed, { headers: headers() })
    }
  ),
  http.post(`${BASE}/organisations/:organisation_id/invitations`, async ({ request, params }) => {
    if (isCommunityOrLocal(params.organisation_id))
      return invitePeople(
        organisationFor(params.organisation_id).id,
        organisationFor(params.organisation_id).slug,
        peopleFor(params.organisation_id),
        initialMembershipsFor(params.organisation_id)[0]!.person_id!,
        request
      )
    const body = (await request.json()) as { invitations?: { email: string }[] }
    const rows = body.invitations ?? []
    return HttpResponse.json(
      {
        created: rows.length,
        skipped: 0,
        failed: 0,
        results: rows.map((row) => ({ email: row.email, outcome: 'created', invitation: null })),
      },
      { status: 201, headers: headers() }
    )
  }),
  http.delete(`${BASE}/invitations/:invitation_id`, ({ request, params }) =>
    isCommunityRequest(request)
      ? mutateInvitation(
          requestPeopleId(request),
          peopleFor(requestPeopleId(request)),
          String(params.invitation_id),
          request
        )
      : new HttpResponse(null, { status: 204, headers: headers() })
  ),
  http.get(`${BASE}/organisations/:organisation_id/enrolment-tokens`, () =>
    HttpResponse.json(page([]), { headers: headers() })
  ),
  http.post(
    `${BASE}/organisations/:organisation_id/enrolment-tokens`,
    async ({ request, params }) => {
      const body = (await request.json()) as { max_uses?: number; expires_at?: string }
      const created = now()
      const secret = isCommunityOrLocal(params.organisation_id)
        ? 'enr_COMMUNITY0001'
        : 'enr_VERCELLI0001'
      return HttpResponse.json(
        {
          id: crypto.randomUUID(),
          organisation_id: organisationFor(params.organisation_id).id,
          role: 'org_member',
          state: 'active',
          max_uses: body.max_uses ?? 1,
          uses: 0,
          fingerprint: '9c8b7a6d5e4f3021',
          expires_at: body.expires_at ?? new Date(created.getTime() + 86_400_000).toISOString(),
          created_at: created.toISOString(),
          secret,
          enrolment_url: `https://app.kodera.io/enrol#${secret}`,
          qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"></svg>',
        },
        { status: 201, headers: headers() }
      )
    }
  ),
  http.delete(
    `${BASE}/organisations/:organisation_id/enrolment-tokens/:enrolment_token_id`,
    () => new HttpResponse(null, { status: 204, headers: headers() })
  ),
  // The workspace (11-workspace.md): the starter template, which names no company, already
  // created for the demo's organisation; creating it again changes nothing, as the API answers.
  http.get(`${BASE}/organisations/:organisation_id/workspace`, ({ params }) =>
    HttpResponse.json(
      findLocalWorkspace(params.organisation_id)
        ? localWorkspace(findLocalWorkspace(params.organisation_id)!)
        : isCommunity(params.organisation_id)
          ? community.communityWorkspace()
          : { ...readyWorkspace(), organisation_id: seed.ORGANISATION_ID },
      { headers: { ...headers(), 'Cache-Control': 'no-store' } }
    )
  ),
  http.post(`${BASE}/organisations/:organisation_id/workspace/actions/initialise`, ({ params }) =>
    HttpResponse.json(
      { state: 'initialised' },
      {
        headers: {
          ...headers(),
          Location: `/api/v1/organisations/${organisationFor(params.organisation_id).id}/workspace`,
        },
      }
    )
  ),
  ...memberImportHandlers({
    organisationId: (id) => organisationFor(id).id,
    columns: (id) =>
      isCommunityOrLocal(id)
        ? [
            { index: 0, header: 'Name', sample: 'Community Member' },
            { index: 1, header: 'Email', sample: 'member@community.kodera.io' },
          ]
        : [
            { index: 0, header: 'Prénom', sample: 'Lucia' },
            { index: 1, header: 'Nom', sample: 'Ferraro' },
            { index: 2, header: 'Adresse mail', sample: `l.ferraro@${seed.DEMO_EMAIL_DOMAIN}` },
          ],
  }),
  ...messagingDemoHandlers(BASE, headers),
]
