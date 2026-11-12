// GENERATED FILE — DO NOT EDIT. Regenerate with: npm run api:generate

// One msw handler per operation, answering the contract example. Hand-written base
// responses are forbidden (docs/dev/TESTING.md): a mock written by hand keeps
// passing against a shape the Core API stopped returning. Scenario overlays go in
// `tests/e2e/scenarios/` and override these.

import { http, HttpResponse } from 'msw'
import type { HttpHandler } from 'msw'
import type { components } from '@/api/schema'
import { bindCurrentUserToMockRequest } from '../currentUserIdentity'
import { EXAMPLES, type OperationExample } from './examples'
import { PROBLEM_STATUS, PROBLEM_TITLES } from './problems'

// `*` matches whatever origin the console is built against, so the same handlers
// serve the unit suite, the Playwright build and a developer pointing at localhost.
const BASE = "*/api/v1"

const IDEMPOTENCY_KEY_MISSING = "https://kodera.io/problems/idempotency-key-missing" as const
const PRECONDITION_REQUIRED = "https://kodera.io/problems/precondition-required" as const

// Every response of this API carries `X-Request-Id`, and it is the id a customer
// quotes to support, so it is fresh per response rather than baked into the example.
const requestId = (): string => crypto.randomUUID()

interface Recorded {
  readonly status: number
  readonly body: unknown
  readonly headers: Record<string, string>
}

// `(method, resolved path, key) → the first response`. A replay of a POST must
// return what the first call returned; a retried order that creates a second one
// is the failure `Idempotency-Key` exists to prevent. Per worker, and per process:
// call `resetIdempotencyStore()` between tests that reuse a key.
const recorded = new Map<string, Recorded>()

export function resetIdempotencyStore(): void {
  recorded.clear()
}

function send(status: number, body: unknown, headers: Record<string, string>): Response {
  if (body === null) return new HttpResponse(null, { status, headers })
  if (headers['Content-Type'] === 'text/plain' && typeof body === 'string') {
    return HttpResponse.text(body, { status, headers })
  }
  return HttpResponse.json(body, { status, headers })
}

function answer(example: OperationExample): Response {
  return send(example.status, example.body, { ...example.headers, 'X-Request-Id': requestId() })
}

function problemMissingHeader(type: string, request: Request): Response {
  const id = requestId()
  const status = PROBLEM_STATUS[type as keyof typeof PROBLEM_STATUS]
  return HttpResponse.json(
    {
      type,
      title: PROBLEM_TITLES[type as keyof typeof PROBLEM_TITLES],
      status,
      instance: new URL(request.url).pathname,
      request_id: id,
    },
    {
      status,
      headers: { 'Content-Type': 'application/problem+json', 'X-Request-Id': id },
    }
  )
}

function answerIdempotent(example: OperationExample, request: Request): Response {
  const key = request.headers.get('Idempotency-Key')
  if (key === null) return problemMissingHeader(IDEMPOTENCY_KEY_MISSING, request)
  const slot = `${request.method} ${new URL(request.url).pathname} ${key}`
  const first = recorded.get(slot)
  if (first !== undefined) {
    return send(first.status, first.body, { ...first.headers, 'Idempotency-Replayed': 'true' })
  }
  const headers = { ...example.headers, 'X-Request-Id': requestId() }
  recorded.set(slot, { status: example.status, body: example.body, headers })
  return send(example.status, example.body, headers)
}

// A `PATCH` with no `If-Match` is refused by the contract itself (`428
// precondition-required`), so the base handler enforces it the same way it enforces
// `Idempotency-Key` on a POST — a mock that answered anyway would hide the client's
// own bug behind a 200. A stale (mismatched) `If-Match` is not checked here: it needs
// the resource's current tag, which a stateless example response does not carry.
function answerRequiringIfMatch(example: OperationExample, request: Request): Response {
  if (request.headers.get('If-Match') === null) {
    return problemMissingHeader(PRECONDITION_REQUIRED, request)
  }
  return answer(example)
}

export const handlers: HttpHandler[] = [
  http.get(`${BASE}/me`, ({ request }) => answer({ ...EXAMPLES["getMe"], body: bindCurrentUserToMockRequest(EXAMPLES["getMe"].body as components['schemas']['Me'], request) })),
  http.patch(`${BASE}/me`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchMe"], request)),
  http.post(`${BASE}/auth/discover`, ({ request }) => answerIdempotent(EXAMPLES["discoverRealm"], request)),
  http.get(`${BASE}/organisations`, () => answer(EXAMPLES["listOrganisations"])),
  http.post(`${BASE}/organisations`, ({ request }) => answerIdempotent(EXAMPLES["createOrganisation"], request)),
  http.get(`${BASE}/organisations/:organisation_id`, () => answer(EXAMPLES["getOrganisation"])),
  http.patch(`${BASE}/organisations/:organisation_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchOrganisation"], request)),
  http.get(`${BASE}/organisations/:organisation_id/bootstrap`, () => answer(EXAMPLES["getOrganisationBootstrap"])),
  http.get(`${BASE}/organisations/:organisation_id/workspace`, () => answer(EXAMPLES["getWorkspace"])),
  http.post(`${BASE}/workspaces/instant-claim`, ({ request }) => answerIdempotent(EXAMPLES["instantClaimWorkspace"], request)),
  http.post(`${BASE}/organisations/:organisation_id/workspace/actions/initialise`, ({ request }) => answerIdempotent(EXAMPLES["initialiseWorkspace"], request)),
  http.post(`${BASE}/organisations/:organisation_id/workspace/categories`, ({ request }) => answerIdempotent(EXAMPLES["createCategory"], request)),
  http.patch(`${BASE}/organisations/:organisation_id/workspace/categories/:category_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchCategory"], request)),
  http.delete(`${BASE}/organisations/:organisation_id/workspace/categories/:category_id`, () => answer(EXAMPLES["deleteCategory"])),
  http.post(`${BASE}/organisations/:organisation_id/workspace/channels`, ({ request }) => answerIdempotent(EXAMPLES["createChannel"], request)),
  http.patch(`${BASE}/organisations/:organisation_id/workspace/channels/:channel_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchChannel"], request)),
  http.post(`${BASE}/organisations/:organisation_id/workspace/channels/:channel_id/actions/archive`, ({ request }) => answerIdempotent(EXAMPLES["archiveChannel"], request)),
  http.post(`${BASE}/organisations/:organisation_id/workspace/channels/:channel_id/actions/unarchive`, ({ request }) => answerIdempotent(EXAMPLES["unarchiveChannel"], request)),
  http.get(`${BASE}/organisations/:organisation_id/workspace/channels/:channel_id/access`, () => answer(EXAMPLES["getChannelAccess"])),
  http.patch(`${BASE}/organisations/:organisation_id/workspace/channels/:channel_id/access`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchChannelAccess"], request)),
  http.get(`${BASE}/organisations/:organisation_id/workspace/administration`, () => answer(EXAMPLES["getWorkspaceAdministration"])),
  http.get(`${BASE}/organisations/:organisation_id/notice-contacts`, () => answer(EXAMPLES["getNoticeContacts"])),
  http.patch(`${BASE}/organisations/:organisation_id/notice-contacts`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchNoticeContacts"], request)),
  http.get(`${BASE}/organisations/:organisation_id/memberships`, () => answer(EXAMPLES["listMemberships"])),
  http.get(`${BASE}/organisations/:organisation_id/memberships/:membership_id`, () => answer(EXAMPLES["getMembership"])),
  http.patch(`${BASE}/organisations/:organisation_id/memberships/:membership_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["changeMembershipRole"], request)),
  http.delete(`${BASE}/organisations/:organisation_id/memberships/:membership_id`, () => answer(EXAMPLES["removeMembership"])),
  http.get(`${BASE}/organisations/:organisation_id/invitations`, () => answer(EXAMPLES["listInvitations"])),
  http.post(`${BASE}/organisations/:organisation_id/invitations`, ({ request }) => answerIdempotent(EXAMPLES["inviteToOrganisation"], request)),
  http.post(`${BASE}/invitations/preview`, () => answer(EXAMPLES["previewInvitation"])),
  http.post(`${BASE}/invitations/accept`, ({ request }) => answerIdempotent(EXAMPLES["acceptInvitation"], request)),
  http.post(`${BASE}/owner-claims/actions/consume`, ({ request }) => answerIdempotent(EXAMPLES["consumeOwnerClaim"], request)),
  http.get(`${BASE}/organisations/:organisation_id/enrolment-tokens`, () => answer(EXAMPLES["listEnrolmentTokens"])),
  http.post(`${BASE}/organisations/:organisation_id/enrolment-tokens`, ({ request }) => answerIdempotent(EXAMPLES["createEnrolmentToken"], request)),
  http.delete(`${BASE}/organisations/:organisation_id/enrolment-tokens/:enrolment_token_id`, () => answer(EXAMPLES["revokeEnrolmentToken"])),
  http.get(`${BASE}/catalog/plans`, () => answer(EXAMPLES["listPlans"])),
  http.get(`${BASE}/catalog/packs`, () => answer(EXAMPLES["listPacks"])),
  http.get(`${BASE}/catalog/capacity-tiers`, () => answer(EXAMPLES["listCapacityTiers"])),
  http.get(`${BASE}/catalog/prices`, () => answer(EXAMPLES["listPrices"])),
  http.get(`${BASE}/organisations/:organisation_id/orders`, () => answer(EXAMPLES["listOrders"])),
  http.post(`${BASE}/organisations/:organisation_id/orders`, ({ request }) => answerIdempotent(EXAMPLES["placeOrder"], request)),
  http.get(`${BASE}/orders/:order_id`, () => answer(EXAMPLES["getOrder"])),
  http.post(`${BASE}/orders/:order_id/actions/cancel`, ({ request }) => answerIdempotent(EXAMPLES["cancelOrder"], request)),
  http.get(`${BASE}/organisations/:organisation_id/subscriptions`, () => answer(EXAMPLES["listSubscriptions"])),
  http.get(`${BASE}/subscriptions/:subscription_id`, () => answer(EXAMPLES["getSubscription"])),
  http.get(`${BASE}/organisations/:organisation_id/invoices`, () => answer(EXAMPLES["listInvoices"])),
  http.get(`${BASE}/invoices/:invoice_id`, () => answer(EXAMPLES["getInvoice"])),
  http.get(`${BASE}/organisations/:organisation_id/credit-notes`, () => answer(EXAMPLES["listCreditNotes"])),
  http.get(`${BASE}/credit-notes/:credit_note_id`, () => answer(EXAMPLES["getCreditNote"])),
  http.get(`${BASE}/invoices/:invoice_id/download`, () => answer(EXAMPLES["getInvoiceDownloadLink"])),
  http.get(`${BASE}/invoices/:invoice_id/payment-link`, () => answer(EXAMPLES["getPaymentLink"])),
  http.post(`${BASE}/invoices/:invoice_id/payment-link`, ({ request }) => answerIdempotent(EXAMPLES["createPaymentLink"], request)),
  http.post(`${BASE}/organisations/:organisation_id/dpa`, ({ request }) => answerIdempotent(EXAMPLES["generateDpa"], request)),
  http.get(`${BASE}/organisations/:organisation_id/dpa/:dpa_id`, () => answer(EXAMPLES["getDpa"])),
  http.post(`${BASE}/organisations/:organisation_id/dpa/:dpa_id/accept`, ({ request }) => answerIdempotent(EXAMPLES["acceptDpa"], request)),
  http.get(`${BASE}/organisations/:organisation_id/dpa/:dpa_id/pdf`, () => answer(EXAMPLES["getDpaPdfLink"])),
  http.get(`${BASE}/organisations/:organisation_id/tenants`, () => answer(EXAMPLES["listTenants"])),
  http.post(`${BASE}/organisations/:organisation_id/tenants`, ({ request }) => answerIdempotent(EXAMPLES["createTenant"], request)),
  http.get(`${BASE}/tenants/:tenant_id`, () => answer(EXAMPLES["getTenant"])),
  http.get(`${BASE}/tenants/:tenant_id/status`, () => answer(EXAMPLES["getTenantStatus"])),
  http.get(`${BASE}/tenants/:tenant_id/domains`, () => answer(EXAMPLES["listDomains"])),
  http.post(`${BASE}/tenants/:tenant_id/domains`, ({ request }) => answerIdempotent(EXAMPLES["addDomain"], request)),
  http.get(`${BASE}/domains/:domain_id`, () => answer(EXAMPLES["getDomain"])),
  http.patch(`${BASE}/domains/:domain_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchDomain"], request)),
  http.delete(`${BASE}/domains/:domain_id`, () => answer(EXAMPLES["deleteDomain"])),
  http.post(`${BASE}/domains/:domain_id/actions/verify`, ({ request }) => answerIdempotent(EXAMPLES["verifyDomain"], request)),
  http.post(`${BASE}/community/support/tickets`, ({ request }) => answerIdempotent(EXAMPLES["createCommunitySupportTicket"], request)),
  http.get(`${BASE}/support/tickets`, () => answer(EXAMPLES["listSupportTickets"])),
  http.post(`${BASE}/support/tickets`, ({ request }) => answerIdempotent(EXAMPLES["createSupportTicket"], request)),
  http.get(`${BASE}/support/tickets/:ticket_id`, () => answer(EXAMPLES["getSupportTicket"])),
  http.get(`${BASE}/status/components`, () => answer(EXAMPLES["listStatusComponents"])),
  http.get(`${BASE}/jobs`, () => answer(EXAMPLES["listJobs"])),
  http.get(`${BASE}/jobs/:job_id`, () => answer(EXAMPLES["getJob"])),
  http.post(`${BASE}/tenants/:tenant_id/jobs`, ({ request }) => answerIdempotent(EXAMPLES["triggerTenantJob"], request)),
  http.get(`${BASE}/instances/:instance_id/logs`, () => answer(EXAMPLES["getInstanceLogs"])),
  http.get(`${BASE}/audit-events`, () => answer(EXAMPLES["listAuditEvents"])),
  http.post(`${BASE}/tenants/:tenant_id/agent-enrolment-tokens`, ({ request }) => answerIdempotent(EXAMPLES["createAgentEnrolmentToken"], request)),
  http.get(`${BASE}/slug-availability`, () => answer(EXAMPLES["checkSlugAvailability"])),
  http.get(`${BASE}/legal-documents`, () => answer(EXAMPLES["listLegalDocuments"])),
  http.get(`${BASE}/legal-documents/:code/:version/:locale`, () => answer(EXAMPLES["getLegalDocumentText"])),
  http.get(`${BASE}/organisations/:organisation_id/entitlements`, () => answer(EXAMPLES["listEntitlements"])),
  http.get(`${BASE}/organisations/:organisation_id/status-summary`, () => answer(EXAMPLES["getOrganisationStatusSummary"])),
  http.get(`${BASE}/organisations/:organisation_id/dunning`, () => answer(EXAMPLES["getDunning"])),
  http.get(`${BASE}/organisations/:organisation_id/memberships/count`, () => answer(EXAMPLES["countMemberships"])),
  http.delete(`${BASE}/invitations/:invitation_id`, () => answer(EXAMPLES["revokeInvitation"])),
  http.post(`${BASE}/invitations/:invitation_id/actions/resend`, ({ request }) => answerIdempotent(EXAMPLES["resendInvitation"], request)),
  http.get(`${BASE}/organisations/:organisation_id/member-imports`, () => answer(EXAMPLES["listMemberImports"])),
  http.post(`${BASE}/organisations/:organisation_id/member-imports`, ({ request }) => answerIdempotent(EXAMPLES["createMemberImport"], request)),
  http.get(`${BASE}/member-imports/:member_import_id`, () => answer(EXAMPLES["getMemberImport"])),
  http.patch(`${BASE}/member-imports/:member_import_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchMemberImport"], request)),
  http.delete(`${BASE}/member-imports/:member_import_id`, () => answer(EXAMPLES["deleteMemberImport"])),
  http.post(`${BASE}/member-imports/:member_import_id/actions/execute`, ({ request }) => answerIdempotent(EXAMPLES["executeMemberImport"], request)),
  http.get(`${BASE}/tenants/:tenant_id/availability`, () => answer(EXAMPLES["listTenantAvailability"])),
  http.get(`${BASE}/status/incidents`, () => answer(EXAMPLES["listIncidents"])),
  http.post(`${BASE}/domains/:domain_id/actions/reissue-nonce`, ({ request }) => answerIdempotent(EXAMPLES["reissueDomainNonce"], request)),
  http.post(`${BASE}/domains/:domain_id/actions/activate`, ({ request }) => answerIdempotent(EXAMPLES["activateDomain"], request)),
  http.get(`${BASE}/domains/:domain_id/instructions`, () => answer(EXAMPLES["getDomainInstructions"])),
  http.post(`${BASE}/domains/:domain_id/instruction-shares`, ({ request }) => answerIdempotent(EXAMPLES["shareDomainInstructions"], request)),
  http.get(`${BASE}/support/help-context`, () => answer(EXAMPLES["getHelpContext"])),
  http.get(`${BASE}/support/ticket-context`, () => answer(EXAMPLES["getTicketContext"])),
  http.post(`${BASE}/support/sign-in-problems`, ({ request }) => answerIdempotent(EXAMPLES["reportSignInProblem"], request)),
  http.get(`${BASE}/support/tickets/:ticket_id/messages`, () => answer(EXAMPLES["listTicketMessages"])),
  http.post(`${BASE}/support/tickets/:ticket_id/messages`, ({ request }) => answerIdempotent(EXAMPLES["replyToTicket"], request)),
  http.post(`${BASE}/support/tickets/:ticket_id/attachments`, ({ request }) => answerIdempotent(EXAMPLES["attachToTicket"], request)),
  http.get(`${BASE}/tenants/:tenant_id/federation-providers`, () => answer(EXAMPLES["listFederationProviders"])),
  http.post(`${BASE}/tenants/:tenant_id/federation-providers`, ({ request }) => answerIdempotent(EXAMPLES["createFederationProvider"], request)),
  http.get(`${BASE}/federation-providers/:federation_provider_id`, () => answer(EXAMPLES["getFederationProvider"])),
  http.patch(`${BASE}/federation-providers/:federation_provider_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["patchFederationProvider"], request)),
  http.delete(`${BASE}/federation-providers/:federation_provider_id`, () => answer(EXAMPLES["disableFederationProvider"])),
  http.patch(`${BASE}/federation-providers/:federation_provider_id/credentials`, ({ request }) => answerRequiringIfMatch(EXAMPLES["setFederationCredentials"], request)),
  http.get(`${BASE}/federation-providers/:federation_provider_id/tests`, () => answer(EXAMPLES["listFederationTests"])),
  http.post(`${BASE}/federation-providers/:federation_provider_id/tests`, ({ request }) => answerIdempotent(EXAMPLES["startFederationTest"], request)),
  http.get(`${BASE}/federation-tests/:federation_test_id`, () => answer(EXAMPLES["getFederationTest"])),
  http.post(`${BASE}/federation-providers/:federation_provider_id/actions/activate`, ({ request }) => answerIdempotent(EXAMPLES["activateFederationProvider"], request)),
  http.get(`${BASE}/federation-providers/:federation_provider_id/runbook`, () => answer(EXAMPLES["getFederationRunbook"])),
  http.post(`${BASE}/federation-providers/:federation_provider_id/runbook-shares`, ({ request }) => answerIdempotent(EXAMPLES["shareFederationRunbook"], request)),
  http.post(`${BASE}/organisations/:organisation_id/workspace/moderation`, ({ request }) => answerIdempotent(EXAMPLES["moderateWorkspaceMember"], request)),
  http.get(`${BASE}/organisations/:organisation_id/workspace/reports`, () => answer(EXAMPLES["listAbuseReports"])),
  http.post(`${BASE}/organisations/:organisation_id/workspace/reports`, ({ request }) => answerIdempotent(EXAMPLES["createAbuseReport"], request)),
  http.patch(`${BASE}/organisations/:organisation_id/workspace/reports/:report_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["resolveAbuseReport"], request)),
  http.get(`${BASE}/organisations/:organisation_id/workspace/invite-links`, () => answer(EXAMPLES["listWorkspaceInviteLinks"])),
  http.post(`${BASE}/organisations/:organisation_id/workspace/invite-links`, ({ request }) => answerIdempotent(EXAMPLES["createWorkspaceInviteLink"], request)),
  http.delete(`${BASE}/organisations/:organisation_id/workspace/invite-links/:invite_link_id`, () => answer(EXAMPLES["revokeWorkspaceInviteLink"])),
  http.post(`${BASE}/workspace-invites/preview`, ({ request }) => answerIdempotent(EXAMPLES["previewWorkspaceInvite"], request)),
  http.post(`${BASE}/workspace-invites/redeem`, ({ request }) => answerIdempotent(EXAMPLES["redeemWorkspaceInvite"], request)),
  http.post(`${BASE}/organisations/:organisation_id/workspace/attachments/uploads`, ({ request }) => answerIdempotent(EXAMPLES["createAttachmentUpload"], request)),
  http.post(`${BASE}/organisations/:organisation_id/workspace/attachments/:attachment_id/complete`, ({ request }) => answerIdempotent(EXAMPLES["completeAttachmentUpload"], request)),
  http.get(`${BASE}/organisations/:organisation_id/workspace/attachments/:attachment_id`, () => answer(EXAMPLES["getAttachment"])),
  http.post(`${BASE}/organisations/:organisation_id/workspace/unfurl`, ({ request }) => answerIdempotent(EXAMPLES["unfurlUrl"], request)),
  http.get(`${BASE}/notifications`, () => answer(EXAMPLES["listNotifications"])),
  http.post(`${BASE}/notifications/read`, ({ request }) => answerIdempotent(EXAMPLES["markNotificationsRead"], request)),
  http.get(`${BASE}/push/public-key`, () => answer(EXAMPLES["getPushPublicKey"])),
  http.put(`${BASE}/push/subscriptions/:device_id`, () => answer(EXAMPLES["putPushSubscription"])),
  http.delete(`${BASE}/push/subscriptions/:device_id`, () => answer(EXAMPLES["deletePushSubscription"])),
  http.get(`${BASE}/organisations/:organisation_id/workspace/documents`, () => answer(EXAMPLES["listWorkspaceDocuments"])),
  http.post(`${BASE}/organisations/:organisation_id/workspace/documents`, ({ request }) => answerIdempotent(EXAMPLES["createWorkspaceDocument"], request)),
  http.get(`${BASE}/organisations/:organisation_id/workspace/documents/:document_id`, () => answer(EXAMPLES["getWorkspaceDocument"])),
  http.patch(`${BASE}/organisations/:organisation_id/workspace/documents/:document_id`, ({ request }) => answerRequiringIfMatch(EXAMPLES["updateWorkspaceDocument"], request)),
  http.delete(`${BASE}/organisations/:organisation_id/workspace/documents/:document_id`, () => answer(EXAMPLES["deleteWorkspaceDocument"])),
  http.get(`${BASE}/organisations/:organisation_id/workspace/documents/:document_id/backlinks`, () => answer(EXAMPLES["listDocumentBacklinks"])),
  http.post(`${BASE}/organisations/:organisation_id/workspace/documents/:document_id/collab-session`, ({ request }) => answerIdempotent(EXAMPLES["createDocumentCollabSession"], request)),
  http.get(`${BASE}/organisations/:organisation_id/workspace/search`, () => answer(EXAMPLES["searchWorkspace"])),
]
