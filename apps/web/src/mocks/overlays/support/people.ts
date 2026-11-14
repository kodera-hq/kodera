// A small stateful People backend for the `people.*` overlays
// (docs/specs/03-people.md §7). The generated handlers answer one static
// example per operation; the People acceptance tests need a removal to leave
// the table, an invitation to reach the Invitations tab and a page cursor to
// lead somewhere, so these handlers keep the rows in memory for the life of
// the page. Each overlay builds its own store, and the scenario named last
// wins (`../index-glob.ts`).
//
// Rules mirrored from the contract, because a mock that accepted what the
// API refuses would hide a console bug: a POST needs `Idempotency-Key`, a
// PATCH needs `If-Match`, the last owner cannot be demoted or removed, and a
// caller cannot remove themselves.
// Resend keys replay the first response, and a stale PATCH tag refuses the
// write before either resource data or its version changes.

import { http, HttpResponse, type HttpHandler } from 'msw/http'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../../currentUserIdentity'
import { EXAMPLES } from '../../generated/examples'
import { problem } from '../../problem'

type Me = components['schemas']['Me']
export type Membership = components['schemas']['Membership']
type MembershipDetail = components['schemas']['MembershipDetail']
export type Invitation = components['schemas']['Invitation']
type InvitationRole = components['schemas']['InvitationRole']
export type EnrolmentToken = components['schemas']['EnrolmentToken']
type EnrolmentTokenCreated = components['schemas']['EnrolmentTokenCreated']
export type MemberImport = components['schemas']['MemberImport']
type InvitationBatchResult = components['schemas']['InvitationBatchResult']
type OrganisationRole = components['schemas']['OrganisationRole']

const BASE = '*/api/v1'
const ME = EXAMPLES.getMe.body as Me
const CALLER = ME.organisations[0]!
export const ORG_ID = CALLER.organisation.id
export const CALLER_MEMBERSHIP_ID = CALLER.membership_id
const NOW = Date.parse('2027-03-04T09:12:00Z')
const DAY = 86_400_000

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString()
}

let serial = 0
function nextId(prefix: string): string {
  serial += 1
  return `${prefix}-0000-4000-8000-${String(serial).padStart(12, '0')}`
}

export function member(
  name: string | null,
  email: string | null,
  role: OrganisationRole,
  extra: Partial<Membership> = {}
): Membership {
  return {
    // An on-site account may have no address at all; the field is then absent.
    ...(email === null ? {} : { email }),
    id: nextId('5e0e0e0e'),
    organisation_id: ORG_ID,
    person_id: null,
    display_name: name,
    role,
    state: 'active',
    source: 'invitation',
    account_kind: 'hosted',
    mfa_enrolled: true,
    last_seen_at: iso(-2 * DAY),
    created_at: iso(-60 * DAY),
    updated_at: iso(-2 * DAY),
    ...extra,
  }
}

export function invitation(email: string, role: InvitationRole = 'org_member'): Invitation {
  return {
    id: nextId('1a1a1a1a'),
    organisation_id: ORG_ID,
    email,
    role,
    state: 'pending',
    realm: 'acme-sa',
    expires_at: iso(7 * DAY),
    sent_count: 1,
    last_sent_at: iso(-DAY),
    created_at: iso(-DAY),
  }
}

/** The caller's own row: the membership `/me` names, with the scenario's role. */
export function caller(role: OrganisationRole): Membership {
  return member('Julie Marchand', 'julie@acme.fr', role, {
    id: CALLER_MEMBERSHIP_ID,
    last_seen_at: iso(0),
    source: 'order',
  })
}

/** The People list of the wireframe (§4.1), around the caller. */
export function defaultMembers(callerRole: OrganisationRole): Membership[] {
  return [
    member('Marie Dupont', 'marie.dupont@acme.fr', 'org_owner', { source: 'order' }),
    caller(callerRole),
    member('Camille Bernard', 'camille@acme.fr', 'org_billing', { last_seen_at: iso(-5 * DAY) }),
    member('Marc Petit', 'marc.petit@acme.fr', 'org_member', { last_seen_at: iso(-31 * DAY) }),
    member('Samir Benali', null, 'org_member', {
      account_kind: 'on_site',
      source: 'enrolment_token',
      last_seen_at: null,
      mfa_enrolled: true,
    }),
  ]
}

export interface PeopleSeed {
  callerRole: OrganisationRole
  members: Membership[]
  invitations?: Invitation[]
  tokens?: EnrolmentToken[]
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>.]+(\.[^\s@<>.]+)+$/

/** A QR image stand-in: what matters to the console is that it is an SVG. */
const QR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="7" height="7"/><rect x="14" width="7" height="7"/><rect y="14" width="7" height="7"/></svg>'

export function peopleHandlers(seed: PeopleSeed): HttpHandler[] {
  const members = [...seed.members]
  const invitations: Invitation[] = []
  // An invitation is also a membership in state `invited` until accepted
  // (`MembershipDetail.invitation_id`), which is what the count of pending
  // invitations and the row menu's "Renvoyer l'invitation" read.
  function track(sent: Invitation): Invitation {
    const pending = member(null, sent.email, sent.role, {
      state: 'invited',
      last_seen_at: null,
      created_at: sent.created_at,
    })
    members.push(pending)
    const linked = { ...sent, membership_id: pending.id }
    invitations.push(linked)
    return linked
  }
  for (const sent of seed.invitations ?? []) track(sent)
  const tokens = [...(seed.tokens ?? [])]
  const versions = new Map<string, number>()
  const resendReplies = new Map<string, Invitation>()
  const etag = (id: string) => `"${id}-${versions.get(id) ?? 1}"`
  const bump = (id: string) => versions.set(id, (versions.get(id) ?? 1) + 1)

  const owners = () => members.filter((m) => m.role === 'org_owner' && m.state === 'active')
  const isLastOwner = (m: Membership) => m.role === 'org_owner' && owners().length <= 1

  function detail(m: Membership): MembershipDetail {
    const lastOwner = isLastOwner(m)
    const self = m.id === CALLER_MEMBERSHIP_ID
    const blocked = lastOwner ? 'last_owner' : self ? 'self' : null
    return {
      ...m,
      can_change_role: blocked === null,
      can_remove: blocked === null,
      blocked_reason: blocked,
      invitation_id: invitations.find((i) => i.membership_id === m.id)?.id ?? null,
    }
  }

  function page<T>(rows: T[], url: URL) {
    const limit = Number(url.searchParams.get('limit') ?? '25')
    const start = Number(url.searchParams.get('cursor') ?? '0')
    const data = rows.slice(start, start + limit)
    const more = start + limit < rows.length
    return { data, has_more: more, next_cursor: more ? String(start + limit) : null }
  }

  const noKey = (request: Request) =>
    request.headers.get('Idempotency-Key') === null
      ? problem('https://kodera.io/problems/idempotency-key-missing')
      : null
  const noIfMatch = (request: Request) =>
    request.headers.get('If-Match') === null
      ? problem('https://kodera.io/problems/precondition-required')
      : null

  return [
    http.get(`${BASE}/me`, ({ request }) =>
      HttpResponse.json(
        bindCurrentUserToMockRequest(
          {
            ...ME,
            organisations: ME.organisations.map((entry) => ({
              ...entry,
              role: seed.callerRole,
            })),
          } satisfies Me,
          request
        )
      )
    ),

    http.get(`${BASE}/organisations/:organisation_id/memberships/count`, ({ request }) => {
      const q = new URL(request.url).searchParams
      const count = members.filter(
        (m) =>
          (q.get('role') === null || m.role === q.get('role')) &&
          (q.get('state') === null || m.state === q.get('state')) &&
          (q.get('account_kind') === null || m.account_kind === q.get('account_kind'))
      ).length
      return HttpResponse.json({ count, counted_at: iso(0) })
    }),

    http.get(`${BASE}/organisations/:organisation_id/memberships`, ({ request }) => {
      const url = new URL(request.url)
      const role = url.searchParams.get('role')
      const state = url.searchParams.get('state')
      const rows = members.filter(
        (m) => (role === null || m.role === role) && (state === null || m.state === state)
      )
      return HttpResponse.json(page(rows, url))
    }),

    http.get(`${BASE}/organisations/:organisation_id/memberships/:membership_id`, ({ params }) => {
      const found = members.find((m) => m.id === params['membership_id'])
      if (found === undefined) return problem('https://kodera.io/problems/not-found')
      return HttpResponse.json(detail(found), { headers: { ETag: etag(found.id) } })
    }),

    http.patch(
      `${BASE}/organisations/:organisation_id/memberships/:membership_id`,
      async ({ params, request }) => {
        const refused = noIfMatch(request)
        if (refused !== null) return refused
        const found = members.find((m) => m.id === params['membership_id'])
        if (found === undefined) return problem('https://kodera.io/problems/not-found')
        // No one changes their own membership.
        if (found.id === CALLER_MEMBERSHIP_ID)
          return problem('https://kodera.io/problems/forbidden')
        if (request.headers.get('If-Match') !== etag(found.id)) {
          return problem('https://kodera.io/problems/precondition-failed', {
            currentEtag: etag(found.id),
          })
        }
        const body = (await request.json()) as {
          role?: OrganisationRole
          state?: 'active' | 'suspended'
        }
        // Parsing yields: another writer may have advanced the tag meanwhile.
        // Recheck current state with no await between this comparison and write.
        if (request.headers.get('If-Match') !== etag(found.id)) {
          return problem('https://kodera.io/problems/precondition-failed', {
            currentEtag: etag(found.id),
          })
        }
        // The last owner can be neither demoted nor suspended.
        if (
          ((body.role !== undefined && body.role !== 'org_owner') || body.state === 'suspended') &&
          isLastOwner(found)
        ) {
          return problem('https://kodera.io/problems/last-owner-protected')
        }
        if (body.role !== undefined) found.role = body.role
        if (body.state !== undefined) found.state = body.state
        bump(found.id)
        return HttpResponse.json(found, { headers: { ETag: etag(found.id) } })
      }
    ),

    http.delete(
      `${BASE}/organisations/:organisation_id/memberships/:membership_id`,
      ({ params, request }) => {
        const index = members.findIndex((m) => m.id === params['membership_id'])
        const found = members[index]
        if (found === undefined) return problem('https://kodera.io/problems/not-found')
        // `If-Match` is optional on a removal and enforced when present.
        const ifMatch = request.headers.get('If-Match')
        if (ifMatch !== null && ifMatch !== etag(found.id)) {
          return problem('https://kodera.io/problems/precondition-failed', {
            currentEtag: etag(found.id),
          })
        }
        if (isLastOwner(found)) return problem('https://kodera.io/problems/last-owner-protected')
        if (found.id === CALLER_MEMBERSHIP_ID) {
          return problem('https://kodera.io/problems/forbidden')
        }
        members.splice(index, 1)
        // `200` with the removed membership, without the person's contact fields; it leaves the
        // list at once. The realm account follows in a separate delivery.
        const { email: _email, display_name: _name, ...removed } = { ...found, state: 'removed' }
        return HttpResponse.json(removed, { headers: { ETag: etag(found.id) } })
      }
    ),

    http.get(`${BASE}/organisations/:organisation_id/invitations`, ({ request }) => {
      const url = new URL(request.url)
      const state = url.searchParams.get('state')
      return HttpResponse.json(
        page(
          invitations.filter((i) => state === null || i.state === state),
          url
        )
      )
    }),

    http.post(`${BASE}/organisations/:organisation_id/invitations`, async ({ request }) => {
      const refused = noKey(request)
      if (refused !== null) return refused
      const body = (await request.json()) as {
        invitations?: { email: string; role: InvitationRole }[]
      }
      const result: InvitationBatchResult = { created: 0, skipped: 0, failed: 0, results: [] }
      for (const row of body.invitations ?? []) {
        const email = row.email.toLowerCase()
        if (!ADDRESS.test(row.email)) {
          result.failed += 1
          result.results.push({ email: row.email, outcome: 'invalid_email', invitation: null })
        } else if (members.some((m) => m.state === 'active' && m.email?.toLowerCase() === email)) {
          result.skipped += 1
          result.results.push({ email: row.email, outcome: 'already_member', invitation: null })
        } else if (
          invitations.some((i) => i.email.toLowerCase() === email && i.state === 'pending')
        ) {
          result.skipped += 1
          result.results.push({ email: row.email, outcome: 'already_invited', invitation: null })
        } else {
          const created = invitation(row.email, row.role)
          track(created)
          result.created += 1
          result.results.push({ email: row.email, outcome: 'created', invitation: created })
        }
      }
      return HttpResponse.json(result, { status: 201 })
    }),

    http.post(`${BASE}/invitations/:invitation_id/actions/resend`, ({ params, request }) => {
      const refused = noKey(request)
      if (refused !== null) return refused
      const replayKey = `${String(params['invitation_id'])}:${request.headers.get('Idempotency-Key')}`
      const replay = resendReplies.get(replayKey)
      if (replay !== undefined) return HttpResponse.json(replay)
      const found = invitations.find((i) => i.id === params['invitation_id'])
      if (found === undefined) return problem('https://kodera.io/problems/not-found')
      found.sent_count = (found.sent_count ?? 1) + 1
      found.last_sent_at = iso(0)
      const reply = { ...found }
      resendReplies.set(replayKey, reply)
      return HttpResponse.json(reply)
    }),

    http.delete(`${BASE}/invitations/:invitation_id`, ({ params }) => {
      const index = invitations.findIndex((i) => i.id === params['invitation_id'])
      if (index < 0) return problem('https://kodera.io/problems/not-found')
      const [revoked] = invitations.splice(index, 1)
      const pending = members.findIndex((m) => m.id === revoked?.membership_id)
      if (pending >= 0) members.splice(pending, 1)
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(`${BASE}/organisations/:organisation_id/enrolment-tokens`, ({ request }) => {
      const url = new URL(request.url)
      const state = url.searchParams.get('state')
      return HttpResponse.json(
        page(
          tokens.filter((t) => state === null || t.state === state),
          url
        )
      )
    }),

    http.post(`${BASE}/organisations/:organisation_id/enrolment-tokens`, async ({ request }) => {
      const refused = noKey(request)
      if (refused !== null) return refused
      const body = (await request.json()) as { max_uses?: number; expires_at?: string }
      const secret = `enr_7K4P92MB${String(tokens.length).padStart(4, '0')}`
      const token: EnrolmentToken = {
        id: nextId('e1e1e1e1'),
        organisation_id: ORG_ID,
        role: 'org_member',
        state: 'active',
        max_uses: body.max_uses ?? 1,
        uses: 0,
        expires_at: body.expires_at ?? iso(DAY),
        fingerprint: '4a1b2c3d4e5f6071',
        created_at: iso(0),
      }
      tokens.push(token)
      const created: EnrolmentTokenCreated = {
        ...token,
        secret,
        enrolment_url: `https://app.kodera.io/enrol#${secret}`,
        qr_svg: QR_SVG,
      }
      return HttpResponse.json(created, { status: 201 })
    }),

    http.delete(
      `${BASE}/organisations/:organisation_id/enrolment-tokens/:enrolment_token_id`,
      ({ params }) => {
        const found = tokens.find((t) => t.id === params['enrolment_token_id'])
        if (found === undefined) return problem('https://kodera.io/problems/not-found')
        found.state = 'revoked'
        return new HttpResponse(null, { status: 204 })
      }
    ),

    ...memberImportHandlers(),
  ]
}

export interface ImportVariant {
  /** The preview counts `PATCH /member-imports/{id}` answers. */
  summary?: NonNullable<MemberImport['summary']>
  /** What execution leaves behind. */
  outcome?: 'completed' | 'partially_failed'
  /** Rows still retryable after a partial failure, with their reason codes. */
  failedRows?: NonNullable<MemberImport['rows']>
  /** Another organisation's file (the walkable demo), instead of ACME's. */
  organisationId?: string | ((requestedId: string) => string)
  columns?:
    MemberImport['detected_columns'] | ((requestedId: string) => MemberImport['detected_columns'])
}

const DEFAULT_SUMMARY = {
  ready: 120,
  already_member: 4,
  already_invited: 0,
  duplicate: 0,
  invalid: 0,
}

/**
 * The staged CSV import (§4.3): upload, mapping and preview, execution. Its
 * own factory, so an import scenario can replace all four calls together and
 * keep one coherent staging record.
 */
export function memberImportHandlers(variant: ImportVariant = {}): HttpHandler[] {
  const imports = new Map<string, MemberImport>()
  const versions = new Map<string, number>()
  const etag = (id: string) => `"${id}-${versions.get(id) ?? 1}"`
  const bump = (id: string) => versions.set(id, (versions.get(id) ?? 1) + 1)
  const summary = variant.summary ?? DEFAULT_SUMMARY

  return [
    http.post(`${BASE}/organisations/:organisation_id/member-imports`, ({ request, params }) => {
      if (request.headers.get('Idempotency-Key') === null) {
        return problem('https://kodera.io/problems/idempotency-key-missing')
      }
      const created: MemberImport = {
        id: nextId('a1a1a1a1'),
        organisation_id:
          typeof variant.organisationId === 'function'
            ? variant.organisationId(String(params.organisation_id))
            : (variant.organisationId ?? ORG_ID),
        state: 'uploaded',
        filename: 'equipe.csv',
        row_count: Object.values(summary).reduce((a, b) => a + (b ?? 0), 0),
        has_header_row: true,
        detected_columns: (typeof variant.columns === 'function'
          ? variant.columns(String(params.organisation_id))
          : variant.columns) ?? [
          { index: 0, header: 'Prénom', sample: 'Julie' },
          { index: 1, header: 'Nom', sample: 'Leroy' },
          { index: 2, header: 'Adresse mail', sample: 'julie.leroy@acme.fr' },
          { index: 3, header: 'Service', sample: 'Chantier' },
        ],
        column_mapping: null,
        staging_expires_at: iso(7 * DAY),
        created_at: iso(0),
        rows: [],
      }
      imports.set(created.id, created)
      return HttpResponse.json(created, { status: 201 })
    }),

    http.get(`${BASE}/member-imports/:member_import_id`, ({ params }) => {
      const found = imports.get(String(params['member_import_id']))
      if (found === undefined) return problem('https://kodera.io/problems/not-found')
      return HttpResponse.json(found, { headers: { ETag: etag(found.id) } })
    }),

    http.patch(`${BASE}/member-imports/:member_import_id`, async ({ params, request }) => {
      if (request.headers.get('If-Match') === null) {
        return problem('https://kodera.io/problems/precondition-required')
      }
      const found = imports.get(String(params['member_import_id']))
      if (found === undefined) return problem('https://kodera.io/problems/not-found')
      if (request.headers.get('If-Match') !== etag(found.id)) {
        return problem('https://kodera.io/problems/precondition-failed', {
          currentEtag: etag(found.id),
        })
      }
      const body = (await request.json()) as Pick<MemberImport, 'column_mapping' | 'default_role'>
      // The early refusal preserves stale/missing-tag precedence over parsing;
      // this fresh comparison makes the subsequent synchronous write atomic.
      if (request.headers.get('If-Match') !== etag(found.id)) {
        return problem('https://kodera.io/problems/precondition-failed', {
          currentEtag: etag(found.id),
        })
      }
      found.column_mapping = body.column_mapping ?? null
      if (body.default_role !== undefined) found.default_role = body.default_role
      found.state = 'ready'
      found.summary = { ...summary }
      bump(found.id)
      return HttpResponse.json(found, { headers: { ETag: etag(found.id) } })
    }),

    http.post(
      `${BASE}/member-imports/:member_import_id/actions/execute`,
      async ({ params, request }) => {
        if (request.headers.get('Idempotency-Key') === null) {
          return problem('https://kodera.io/problems/idempotency-key-missing')
        }
        const found = imports.get(String(params['member_import_id']))
        if (found === undefined) return problem('https://kodera.io/problems/not-found')
        const body = (await request.json().catch(() => ({}))) as { only_lines?: number[] }
        const retrying = body.only_lines !== undefined
        const failedRows = retrying ? [] : (variant.failedRows ?? [])
        const failed = failedRows.length
        const invited = retrying
          ? (found.summary?.invited ?? 0) + body.only_lines!.length
          : (found.summary?.ready ?? 0) - failed
        const partial = failed > 0 && variant.outcome === 'partially_failed'
        Object.assign(found, {
          state: partial ? 'partially_failed' : 'completed',
          filename: partial ? found.filename : null,
          rows: partial ? failedRows : [],
          detected_columns: found.detected_columns.map((c) => ({
            ...c,
            sample: partial ? (c.sample ?? null) : null,
          })),
          summary: { ...found.summary, invited, failed },
        } satisfies Partial<MemberImport>)
        bump(found.id)
        return HttpResponse.json({
          created: retrying ? body.only_lines!.length : invited,
          skipped: 0,
          failed,
          results: [],
        } satisfies InvitationBatchResult)
      }
    ),
  ]
}
