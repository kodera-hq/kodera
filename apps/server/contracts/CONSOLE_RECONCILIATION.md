# Console reconciliation

**Status:** Proposed · **Owner:** API seat

Two documents were written independently and had to be made into one contract: the console's
screen-flow specifications (`kodera-web/docs/specs/*.md`), which say what each launch screen
calls, and `core-api.openapi.yaml`, which says what exists. This file is the reconciliation: every
call the console assumes, what it maps onto, and why.

It is a record of decisions, not a second contract. `core-api.openapi.yaml` is the contract; when
this file and that file disagree, that file wins and this one has a bug.

## 1. The rule that settled most rows

Two principles, applied in this order:

1. **The console adapts to naming.** Paths, parameter names, field names and enum values come from
   [`../docs/api/CONVENTIONS.md`](../docs/api/CONVENTIONS.md)
   and from the domain documents. Where the specs invented a name for something that already had
   one — `is_primary` for `is_canonical`, `state` for `status`, `txt-not-found` for `txt_absent` —
   the contract's name stands and the specs were edited. A second name for one thing is how three
   disagreeing status enums happened once already.
2. **The contract adds capability.** Where a launch screen genuinely needs something the contract
   did not offer — federation, member imports, the dunning view, contextual help — the contract
   grew rather than the screen shrinking. A specification that survived design review is evidence
   of a real need; a missing endpoint is not.

Neither principle lets a screen invent a domain rule. Where a spec assumed behaviour the domain
documents forbid — offset totals, `PUT`, a client-computed SLA clock — the screen changed.

## 2. Counts

These numbers are counted from the table below by a script, not maintained by hand: it splits the
five-column rows of §3.1 to §3.8 and tallies the verdict column, so the table and this summary
cannot drift apart again. The first version of this file was hand-counted and was wrong by two rows
in three of these lines.

| | |
|---|---|
| Rows in the mapping table below | 76 |
| Of which the same call listed on two screens | 4 |
| **Distinct calls assumed by the console specifications** | **72** |
| **match** — already in the contract, at most a field rename inside the body | 13 |
| **rename** — the console moves to the contract's path, parameter or shape | 22 |
| **fold** — the call disappears into another operation; nothing is lost | 3 |
| **added** — the contract gained the capability | 38 |
| Operations in the contract before | 51 |
| Operations in the contract after | 92 |
| Operations added | 41 |
| Operations the console never calls, which is fine: staff surfaces | 15 |
| Operations in the contract at 0.10.0, counted from the file | 94 |
| Operations in the contract at 0.11.0, counted from the file | 94 |

Per section: 7 shell, 10 order, 7 status, 15 people, 10 domain, 7 invoices, 8 support, 12
federation — 76.

`added` counts console rows, not operations: 38 rows closed by 41 new operations, because some rows
(federation, member imports) needed a resource rather than an endpoint, and because a resource with
a `PATCH` and a `DELETE` and no `GET` is a defect whatever the console asked for.

The before, after and added rows describe this reconciliation. The contract has grown since by the
two operations of the first-owner claim, `getOrganisationBootstrap` and `consumeOwnerClaim`, and
removed none, which is the 94.

The four calls listed twice are `GET /support/help-context` (shell and support),
`POST /support/tickets` (order, invoices and support), and the subscription read (status and
invoices).

## 3. The mapping table

`Verdict` is one of `match`, `rename`, `fold`, `added`. Paths are relative to `/api/v1`.

### 3.1 Shell and login (`00-shell-and-login.md`)

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `POST /auth/realm-discovery` | Resolve a slug or email domain to a realm before the OIDC flow | `POST /auth/discover` · `discoverRealm` | rename | Body is `{slug}` **or** `{email}`, not `{identifier, kind}`: the server decides which lookup applies, so a client cannot mislabel an address as a slug. Response is `realm`/`issuer`/`openid_configuration_url`/`organisation` with `candidates[]` for a shared domain |
| `GET /me` | Who the caller is, their organisations, the switcher | `GET /me` · `getMe` | match | `user{}` flattens to the top level; `memberships[]` is `organisations[]`; `mfa` lives on each `identities[]` entry as `mfa_enrolled`, because a person may hold a passkey in one realm and not another |
| `PATCH /me` | Language switch | `PATCH /me` · `patchMe` | added | Locale is held server-side so a second machine and every notification mail follow the same choice |
| `GET /organisations/{slug}` | The organisation behind the shell | `GET /organisations/{organisation_id}` · `getOrganisation` | rename | Addressed by id, see §4.1 |
| `GET /organisations/{slug}/entitlements` | Render an action disabled with the pack that unlocks it | `GET /organisations/{organisation_id}/entitlements` · `listEntitlements` | added | `EntitlementCode` is closed; `required_tier` became `required_pack_code` plus `required_capacity_tier_code`, because the two moved apart in the domain model |
| `GET /organisations/{slug}/status-summary` | One call for the shell banner | `GET /organisations/{organisation_id}/status-summary` · `getOrganisationStatusSummary` | added | `capacity.percent` stays server-computed; `billing.dunning_state` is the canonical ladder enum |
| `GET /support/help-context` | Contextual help entry | `GET /support/help-context` · `getHelpContext` | added | See §3.7 |

### 3.2 Order (`01-order.md`)

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `GET /plans` | Pack, tier and price cards | `GET /catalog/plans`, `/catalog/packs`, `/catalog/capacity-tiers`, `/catalog/prices` | rename | One console row, four catalogue resources. `Plan` is what is sold, `Pack` is what is included, `CapacityTier` is what is deployed; conflating them is the mistake `Tenant.capacity_tier` was split to avoid |
| `POST /orders` | Create a draft order | `POST /organisations/{organisation_id}/orders` · `placeOrder` | rename | Not a draft. See §4.2 |
| `GET /orders/{id}` | Read the order back | `GET /orders/{order_id}` · `getOrder` | match | |
| `PATCH /orders/{id}` | Edit the draft | — | fold | There is no server-side draft. The wizard's state lives in the browser until the single transaction |
| `GET /orders/{id}/documents` | The contractual documents to read before signing | `GET /legal-documents` · `listLegalDocuments`, plus `GET /organisations/{organisation_id}/dpa/{dpa_id}` and `/pdf` | added | The DPA is generated per organisation and pack; the other three are published templates |
| `POST /orders/{id}/acceptances` | Record acceptance of CGV, DPA, SLA, AUP | `dpa_acceptance` inside `OrderRequest`; `POST /organisations/{organisation_id}/dpa/{dpa_id}/accept` for a standalone acceptance | fold | Acceptance is part of the order transaction, not a step after it: no processing begins before it is recorded |
| `POST /orders/{id}/submission` | The transactional step | `POST /organisations/{organisation_id}/orders` · `placeOrder` | fold | The order **is** the transaction. `OrderResult` carries the order, subscription, tenant, invoice, payment link and DPA, with `billing_pending` when the billing adapter has not answered |
| `POST /orders/{id}/payment-links` | Pay now | `POST /invoices/{invoice_id}/payment-link` · `createPaymentLink` | rename | A payment link belongs to an invoice, not to an order; that is what makes it re-issuable after the order is closed |
| `GET /organisations/slug-availability` | Is the name free | `GET /slug-availability` · `checkSlugAvailability` | added | Top level, not under `/organisations`, so it cannot be ambiguous with `/organisations/{organisation_id}`. Never says who holds a taken name |
| `POST /support/tickets` with `kind: "sales"` | Ask for a quote | `POST /support/tickets` · `createSupportTicket` | rename | No `kind`. `category: other` and `severity: question`; the tenant context is recomputed server-side |

### 3.3 Status (`02-status.md`)

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `GET /organisations/{slug}/tenants` | The tenants of an organisation | `GET /organisations/{organisation_id}/tenants` · `listTenants` | rename | |
| `GET /tenants/{id}` | Desired and observed state | `GET /tenants/{tenant_id}` · `getTenant` | match | `state` is `status`, the one canonical enum; `observed.stale` is `observed.stale` on the tenant and `is_stale` in the domain model — the console reads `agent.stale` from the status view |
| `GET /tenants/{id}/provisioning` | Progress by step | `GET /tenants/{tenant_id}/status` · `getTenantStatus` | rename | `provisioning_steps[]` and `current_job` are members of `TenantStatusView`; `customer_label_key` is the closed `ProvisioningStepLabel` |
| `GET /tenants/{id}/components` | Component health | `GET /status/components?tenant_id=` · `listStatusComponents` | rename | Also embedded in `TenantStatusView.components`, so the Status screen needs one call and not two |
| `GET /tenants/{id}/incidents` | Open incidents with updates | `GET /status/incidents?tenant_id=&state=open` · `listIncidents` | added | Every customer-visible string is a message key from a closed set |
| `GET /tenants/{id}/availability` | The seven-day strip | `GET /tenants/{tenant_id}/availability?days=7` · `listTenantAvailability` | added | Counted from probes, not agent vitals: a quiet agent is not an outage |
| `GET /organisations/{slug}/subscription` | What is subscribed | `GET /organisations/{organisation_id}/subscriptions?state=active` · `listSubscriptions`, then `GET /subscriptions/{subscription_id}` | rename | A collection, because an organisation may hold add-on subscriptions. `next_invoice_at` and `price_change_notice_days` were added to `Subscription`; `concurrent_participants` is `CapacityGauge.participants.included` |

### 3.4 People (`03-people.md`)

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `GET /organisations/{slug}/members` | The people list | `GET /organisations/{organisation_id}/memberships` · `listMemberships` | rename | `items[]` is `data[]`, `next_cursor` is `next_cursor`, and **`total` is gone**: see §4.3. `kind` is `account_kind` with values `hosted`, `federated`, `on_site` |
| `GET .../members/{id}` | The member drawer | `GET /organisations/{organisation_id}/memberships/{membership_id}` · `getMembership` | added | Returns `MembershipDetail` with `can_change_role`, `can_remove` and `blocked_reason`, so the disabled control has a reason |
| `PATCH .../members/{id}` | Change a role | `PATCH /organisations/{organisation_id}/memberships/{membership_id}` · `changeMembershipRole` | rename | **No `Idempotency-Key`.** A `PATCH` carrying one is refused; concurrency on a `PATCH` is `If-Match`, not idempotency |
| `DELETE .../members/{id}` | Remove someone | `DELETE .../memberships/{membership_id}` · `removeMembership` | rename | No `Idempotency-Key`; `DELETE` is idempotent by construction |
| `GET .../invitations` | Pending invitations | `GET /organisations/{organisation_id}/invitations` · `listInvitations` | match | |
| `POST .../invitations` | Invite a pasted list | `POST /organisations/{organisation_id}/invitations` · `inviteToOrganisation` | match | Up to 500 rows. `created[]`/`rejected[]` becomes `created`/`skipped`/`failed` counters plus `results[]` with one `outcome` per submitted row, in submission order, which is what the partial-failure state needs |
| `POST .../invitations/{id}/resend` | Send the mail again | `POST /invitations/{invitation_id}/actions/resend` · `resendInvitation` | added | Same invitation, same token, so a person holding the first mail is not confused by two working links. The one action sub-resource that answers `200`: it hands a message to the mail transport and updates two counters, and it mutates no infrastructure |
| `DELETE .../invitations/{id}` | Withdraw an invitation | `DELETE /invitations/{invitation_id}` · `revokeInvitation` | added | |
| `POST .../member-imports` | Upload a CSV | `POST /organisations/{organisation_id}/member-imports` · `createMemberImport` | added | See §4.4 |
| `PATCH .../member-imports/{id}` | Map columns, get the preview | `PATCH /member-imports/{member_import_id}` · `patchMemberImport` | added | Column mapping is by zero-based index |
| `POST .../member-imports/{id}/execution` | Send, and retry the failures | `POST /member-imports/{member_import_id}/actions/execute` · `executeMemberImport` | added | `only_lines[]` kept verbatim; a line that already produced an invitation is skipped whatever is sent |
| `GET .../member-imports/{id}` | Poll the run | `GET /member-imports/{member_import_id}` · `getMemberImport` | added | |
| `POST .../enrolment-tokens` | Print a QR sheet | `POST /organisations/{organisation_id}/enrolment-tokens` · `createEnrolmentToken` | match | `count` is `max_uses`, `ttl_hours` is `expires_at`, `code`/`claim_url`/`qr_svg_url` are `secret`/`enrolment_url`/`qr_svg`, all returned exactly once |
| `GET .../enrolment-tokens` | Active sheets | `GET /organisations/{organisation_id}/enrolment-tokens` · `listEnrolmentTokens` | match | `state=active` is the same filter |
| `DELETE .../enrolment-tokens/{id}` | Revoke a sheet | `DELETE .../enrolment-tokens/{enrolment_token_id}` · `revokeEnrolmentToken` | match | |

### 3.5 Domain (`04-domain.md`)

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `GET /tenants/{id}/domains` | The domain list | `GET /tenants/{tenant_id}/domains` · `listDomains` | match | `is_primary` is `is_canonical`; `is_provided` is `kind` on the domain plus `default_urls` on the tenant |
| `POST /tenants/{id}/domains` | Add a host | `POST /tenants/{tenant_id}/domains` · `addDomain` | match | The response already carries the TXT record: the nonce is issued on creation, so the wizard has something to show on its first screen |
| `GET .../domains/{domainId}` | The wizard's poll | `GET /domains/{domain_id}` · `getDomain` | rename | Top level, one level of nesting, the same shape the list returns |
| `POST .../verification-checks` | "Check again" | `POST /domains/{domain_id}/actions/verify` · `verifyDomain` | rename | `actions/<verb>` per the conventions and the domain state machine. `202` with the `add_domain` job: two resolvers, a CA and the edge are not something to hold a request open for. A failed pass is not an error — the job succeeds and leaves the domain in its new state |
| `POST .../verification-nonce` | Re-issue an expired nonce | `POST /domains/{domain_id}/actions/reissue-nonce` · `reissueDomainNonce` | added | `202` with the job that re-enters the state machine. The old nonce stops being accepted immediately; the copy must say the record has to be replaced |
| `POST .../activation` | Put the host in service | `POST /domains/{domain_id}/actions/activate` · `activateDomain` | added | `202` with the job. Refused below `txt_verified`: a host never enters a certificate list before its nonce is observed |
| `POST .../primary` | Make it the main address | `PATCH /domains/{domain_id}` · `patchDomain` | added | `{"is_canonical": true}`, allowed only on a `live` domain. The domain state machine already called this a `PATCH` |
| `DELETE .../domains/{domainId}` | Remove a host | `DELETE /domains/{domain_id}` · `deleteDomain` | rename | `202` with the job that clears the certificate list, the allowed hosts and the redirect URIs |
| `GET .../instructions` | The sheet to forward | `GET /domains/{domain_id}/instructions` · `getDomainInstructions` | added | Data plus message keys, with a `DownloadLink` for the PDF. `format=text\|pdf` is gone: the API never proxies document bytes |
| `POST .../instruction-shares` | Mail it to whoever holds the DNS | `POST /domains/{domain_id}/instruction-shares` · `shareDomainInstructions` | added | The Core API sends the mail from the platform's own sending domain |

The console's ten hyphenated `failure_code` values map onto `DomainFailureCode`, which is the closed
list of the domain state machine's named checks:

| Console spec | Contract |
|---|---|
| `txt-not-found` | `txt_absent` |
| `txt-value-mismatch` | `txt_mismatch` |
| `nxdomain` | `nxdomain` |
| `cname-not-found`, `a-not-found` | `unresolved` |
| `cname-wrong-target`, `a-wrong-address` | `target_mismatch` |
| `caa-forbids` | `caa_forbids_issuance` |
| `resolver-unavailable` | `resolver_unavailable` |
| `rate-limited` | `rate_limited` |

`cname-not-found` and `a-not-found` collapse into one code, and so do the two wrong-target codes,
because the check does not know which record type the customer chose to publish: it knows the name
did not resolve, or resolved somewhere else. The record type the customer should publish is in
`target.record_type`, and the copy composes the two.

`DomainFailureCode` also carries `servfail`, `nonce_expired`, `cname_chain_too_long`,
`edge_unreachable`, `wrong_edge`, `no_certificate`, `chain_invalid`, `expiring`, `media_cert_stale`,
`media_reload_failed`, `not_in_allowed_hosts`, `not_in_redirect_uris`, `default_vhost`,
`invalid_fqdn`, `reserved_name` and `already_claimed`. Each needs a copy key before launch.

### 3.6 Invoices (`05-invoices.md`)

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `GET /organisations/{slug}/invoices` | The invoice list | `GET /organisations/{organisation_id}/invoices` · `listInvoices` | rename | `total_excl_tax_minor` and friends are `total_excl_vat`, `vat_amount`, `total_incl_vat`, each a `Money` object with its own currency |
| `GET .../invoices/{id}` | One invoice | `GET /invoices/{invoice_id}` · `getInvoice` | rename | `lines[]` is on the invoice; `bank_transfer` is not returned. The masked IBAN and the transfer reference live on the PDF only, which is where a payer copies them from |
| `GET .../invoices/{id}/pdf` | Download it | `GET /invoices/{invoice_id}/download` · `getInvoiceDownloadLink` | rename | Returns a `DownloadLink`, not bytes; the console opens the pre-signed URL. Each issuance is audited |
| `POST .../invoices/{id}/payment-links` | Pay by card | `POST /invoices/{invoice_id}/payment-link` · `createPaymentLink` | rename | Pressing it twice returns the same active link |
| `GET .../subscription` | Plan and next invoice | see §3.3 | rename | |
| `GET .../dunning` | What happens next, and when | `GET /organisations/{organisation_id}/dunning` · `getDunning` | added | `DunningState` is the billing model's ladder: `current`, `past_due`, `notice`, `formal_notice`, `suspension_notice`, `suspended`, `terminated`. The console's `none`/`reminder_1`/`reminder_2` collapse into `current`/`past_due`/`notice`, because the two reminders are the same state at different ages and `days_overdue` is what distinguishes them |
| `POST /support/tickets` with `kind: "billing"` | Dispute an invoice | `POST /support/tickets` · `createSupportTicket` | rename | `category: billing` |

`vat_treatment_label` is `vat_mention` in the domain model and `vat_regime` on the contract, and the
sentence itself is snapshotted on the invoice. The console renders `vat_regime` through its own
catalogue rather than displaying a server sentence verbatim, which keeps the French and English
invoices consistent with the French and English console.

### 3.7 Support (`06-support.md`)

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `GET /support/help-context` | Articles, SLA, current incident | `GET /support/help-context` · `getHelpContext` | added | `area` is the closed `ConsoleArea`. `sla.next_response_due_at` is computed server-side, including out of hours: the console does not know the French public-holiday calendar |
| `GET /support/ticket-context` | Show what the ticket will carry | `GET /support/ticket-context` · `getTicketContext` | added | The list is truthful because it is the list the ticket carries. `value_summary` is already redacted, and no item is ever meeting content, document content, a room name or a participant list |
| `POST /support/tickets` | Open a ticket | `POST /support/tickets` · `createSupportTicket` | match | `kind` and `impact` become `category` and `severity`. **`context_codes[]` is not sent**: the tenant context is recomputed server-side and whatever the client sends for it is ignored, because the context routes the ticket and sets the SLA. See the open question in §5.5 |
| `POST /support/tickets/{id}/attachments` | Attach a screenshot | `POST /support/tickets/{ticket_id}/attachments` · `attachToTicket` | added | Scanned before it reaches the helpdesk; the ticket exists before the attachment, so a rejected file never costs the customer their message |
| `GET /support/tickets` | The ticket list | `GET /support/tickets` · `listSupportTickets` | match | `state` is `TicketState`: `open`, `pending_customer`, `pending_kodera`, `solved`, `closed`. The console's `waiting_on_you` is `pending_customer` and `answered` is `pending_kodera` |
| `GET /support/tickets/{id}` | One ticket | `GET /support/tickets/{ticket_id}` · `getSupportTicket` | match | `messages[]` moved to its own cursor-paginated collection; the ticket carries `message_count` and `last_message_at` |
| `POST /support/tickets/{id}/messages` | Reply | `POST /support/tickets/{ticket_id}/messages` · `replyToTicket` | added | Replying reopens a `solved` ticket; a `closed` one is refused and the console offers a new ticket that references it |
| `POST /support/sign-in-problems` | Help when you cannot sign in | `POST /support/sign-in-problems` · `reportSignInProblem` | added | Unauthenticated, `202` and an empty body for every input, so it cannot be used to test whether an address exists |

`next_response_by` is `sla.next_response_due_at` on both the ticket and the help context.

### 3.8 Federation (`07-federation.md`)

The contract had nothing here. Twelve operations exist now across eight paths: the eleven rows below
that the specification asked for, plus `listFederationTests`, which is contract-only. The twelfth row
below is a count and belongs to Memberships.

| Console assumed | Purpose | Contract operation | Verdict | Note |
|---|---|---|---|---|
| `GET /tenants/{id}/federation` | List providers | `GET /tenants/{tenant_id}/federation-providers` · `listFederationProviders` | added | `federation-providers`, plural noun, because `federation` is a mass noun and the resource is one provider |
| `POST /tenants/{id}/federation` | Start the guided setup | `POST /tenants/{tenant_id}/federation-providers` · `createFederationProvider` | added | Returns the draft with its **generated** values and its runbook in the same response |
| `GET .../federation/{fedId}` | The provider | `GET /federation-providers/{federation_provider_id}` · `getFederationProvider` | added | Top level, mirroring `/domains/{domain_id}`, so nesting stays one level deep |
| `PATCH .../federation/{fedId}` | Change the claimed domains | `PATCH /federation-providers/{federation_provider_id}` · `patchFederationProvider` | added | `domains[]` is `allowed_email_domains`. `login_mode` is deliberately not patchable here |
| `PUT .../credentials` | Save the client id and secret | `PATCH /federation-providers/{federation_provider_id}/credentials` · `setFederationCredentials` | added | **`PUT` is not used in this API.** Write-only either way: nothing returns the secret, ever |
| `POST .../tests` | Run a real sign-in | `POST /federation-providers/{federation_provider_id}/tests` · `startFederationTest` | added | `return_url` must be an `app.kodera.io` URL |
| `GET .../tests/{testId}` | The result | `GET /federation-tests/{federation_test_id}` · `getFederationTest` | added | Top level, for the same reason as the provider |
| `POST .../activation` | Put it in service | `POST /federation-providers/{federation_provider_id}/actions/activate` · `activateFederationProvider` | added | `202` with the job. `acknowledged_hosted_accounts` must match the current count, so the number on the confirmation screen is the number being confirmed |
| `DELETE .../federation/{fedId}` | Turn it off | `DELETE /federation-providers/{federation_provider_id}` · `disableFederationProvider` | added | Accounts stay; their sign-in route changes. Refused when it would leave nobody able to sign in |
| `GET .../runbook` | The one-page procedure | `GET /federation-providers/{federation_provider_id}/runbook` · `getFederationRunbook` | added | Steps as message keys with a `value_ref`, plus a `DownloadLink`. `format=html\|pdf` is gone for the same reason as the domain sheet |
| `POST .../runbook-shares` | Mail it to the provider's admin | `POST /federation-providers/{federation_provider_id}/runbook-shares` · `shareFederationRunbook` | added | The mail never carries the client secret |
| `GET .../members?kind=hosted&limit=1` → `total` | How many people a redirection affects | `GET /organisations/{organisation_id}/memberships/count?account_kind=hosted` · `countMemberships` | added | See §4.3 |

`GET /federation-providers/{id}/tests` lists the test history and is contract-only: nothing in the
specifications asks for it, and a customer who wants to know whether it worked last week is better
served by a list than by a support ticket.

The console's `failure_code` list maps one to one onto `FederationFailureCode`, with hyphens
replaced by underscores: `invalid-client` → `invalid_client`, `invalid-secret` → `invalid_secret`,
`redirect-uri-mismatch` → `redirect_uri_mismatch`, `consent-required` → `consent_required`,
`tenant-mismatch` → `tenant_mismatch`, `domain-not-allowed` → `domain_not_allowed`,
`provider-unreachable` → `provider_unreachable`, `token-expired` → `token_expired`. Three were
added: `domain_not_verified`, `user_cancelled` and `provider_error`, because a test that ends
because the person closed the provider's window is not a configuration mistake and must not be
worded as one.

### 3.9 Contract-only operations

These exist and the console never calls them. That is the intended shape: staff act through the
same API as the console, not through a Django admin.

`listOrganisations`, `createOrganisation`, `patchOrganisation`, `acceptInvitation`,
`getPaymentLink`, `listOrders`, `listJobs`, `getJob`, `triggerTenantJob`, `getInstanceLogs`,
`listAuditEvents`, `createAgentEnrolmentToken`, `listMemberImports`, `deleteMemberImport`,
`listFederationTests` — fifteen.

`listTenantJobs` was listed here in the first version and does not exist: `/tenants/{tenant_id}/jobs`
carries `POST triggerTenantJob` only. A script now asserts that every `operationId` named anywhere in
this file resolves in the contract, because a reconciliation that names an operation nobody wrote is
worse than one that omits a real one — it reads as a promise.

`acceptInvitation` is called by the console, from the page an invitation link lands on, but no
launch specification covers that page: it is the gap that shows up when someone actually clicks the
mail. It needs a screen before launch.

`consumeOwnerClaim` and `getOrganisationBootstrap` are in the same position, one step earlier in
a customer's life: the page a claim delivery lands on shows the bootstrap state, starts the OIDC
flow against the organisation's own realm, and posts the token to the consume operation. No
launch specification covers that page either, and the `bootstrap` principal is not named on
`getMe`, so the page cannot open with the shell's usual first call; whether it should is a screen
question for that specification, not a contract change made here. `createOrganisation` stays
contract-only: the intake is a staff act.

## 4. Decisions

### 4.1 One addressing scheme per resource, and it is the id

The specifications address organisations and tenants by slug (`/organisations/{slug}/...`); the
contract addresses them by id. A resource exposes exactly one addressing scheme, and picking the
slug would have meant either a second scheme for resources with no human key, or a slug that can
never change even when a customer is renamed.

**The console adapts.** The browser URL keeps the slug — `/{org}/people` reads well and is
shareable — and the console resolves it to an id once, from `GET /me`, which returns the id and the
slug of every organisation the caller belongs to. The id then goes in every API path.

The one place the slug survives in the API is realm discovery, where the caller has nothing else.

### 4.2 The order is one transaction, and it does not provision

The specifications describe a draft order that is created, patched, has documents accepted against
it, and is then submitted. The contract has one `POST` that writes the order, the subscription, the
DPA acceptance, the tenant row and the invoice, and returns all of them.

The draft is a wizard, and a wizard's state belongs to the wizard. Keeping a half-filled order
server-side buys nothing the browser cannot do and costs a state machine, a cleanup job and a
"resume your order" path nobody specified.

What the single transaction does **not** do is start provisioning. `OrderResult.tenant.status` is
`ordered`. Provisioning is a `staff_operator` job at launch, by the job catalogue's own self-service
column. See the open question in §5.1.

### 4.3 No totals in a page, and a `count` sub-resource where one is genuinely needed

Cursor pagination returns no total, because a total on a filtered, cursor-paginated collection is a
second query with different consistency, and offset pagination is not offered anywhere. Two screens
genuinely need a number: the seat gauge on People, and the hosted-account count the federation
screen shows before redirecting an organisation.

`GET /organisations/{organisation_id}/memberships/count` answers both, with its own rate limit. The
console's `members?kind=hosted&limit=1` trick, which reads a total out of a one-row page, does not
work and was removed.

### 4.4 Member imports and the batch invitation both stay, with one engine underneath

Two candidate designs were on the table: the specifications' `member-imports` resource with upload,
column mapping, validated preview, execution and `only_lines[]` retry; and the contract's 500-row
`POST /invitations` batch.

**Both stay.** They answer different questions and folding either into the other loses something:

- The batch is the console's paste-a-list drawer and the API's own primitive. It is one call, it is
  transactional in the sense that every row gets an outcome, and it is what a script would use.
- The import is a staging area for a file nobody has read yet: it exists precisely so that the
  column mapping and the preview happen **before** anything is sent. Squeezing that into the batch
  would mean a `dry_run` flag, and a `dry_run` flag on an endpoint that sends mail is one typo away
  from sending 500 mails.

What is **not** duplicated is the engine. `POST /member-imports/{id}/actions/execute` runs the same
batch-invitation service as `POST /organisations/{id}/invitations`: one seat check, one place where
an `Invitation` row is created, one audit action. The import is the staging area, not a second
implementation. A pull request that gives the import its own invitation-creating code path is
rejected.

`only_lines[]` is kept verbatim from the specification, and it is belt and braces rather than the
safety mechanism: a line that has already produced an invitation is skipped whatever the client
sends, so a console that retries the whole file cannot double-invite.

### 4.5 CSV parsing is server-side

The specifications say the file is uploaded and parsed by the Core API. That is kept, and it is the
only non-JSON request body in this contract. The reasons are in the specification and they hold:
the parse rules live in one place, and the console never holds a customer's address book beyond the
page it is displaying. See the retention decision in §5.3.

### 4.6 Actions are `actions/<verb>`, and `PUT` does not exist

`POST /domains/{domain_id}/verify` became `POST /domains/{domain_id}/actions/verify`. The
conventions reserve `actions/<verb>` for non-CRUD operations and the domain state machine already
wrote the path that way; having one action sub-resource in the imperative and another as a bare noun
is how a convention stops being one. The new domain and federation actions follow it.

`PUT .../credentials` became `PATCH .../credentials`. `PUT` is not used anywhere in this API;
replacement semantics are a `PATCH` carrying every field. The write-only property of the secret is
unchanged and is the point: no operation in this contract returns `client_secret`, to anybody.

### 4.7 Closed enums, and why each one is closed

Six enums were added or tightened because the console maps every member to exactly one message key,
and a member it has never seen renders nothing:

| Enum | Why closed |
|---|---|
| `ProvisioningStepLabel` | Six customer-facing labels over sixteen internal steps. The internal `key` names an OpenTofu apply and changes with the profile; the customer's six do not |
| `DomainFailureCode` | Each value maps to one copy key, one list of likely causes and one next action. A resolver's raw output never reaches a screen |
| `FederationFailureCode` | Same, plus the provider's own error string stays server-side for support |
| `DunningState` | The billing model's ladder, which is a state machine and not a set of badge colours |
| `EntitlementCode` | The console renders a disabled control naming the pack that unlocks it |
| `ConsoleArea` | It keys help articles and ticket context server-side; an unknown area is a `malformed-request`, not a silent empty answer |

`MemberImportRowStatus` and `MembershipAccountKind` are closed for the same reason, and so are
the three the first-owner claim adds: `OrganisationState`, because `FIRST_SLICE_SPEC.md` §P2
requires the state and permission mapping to be exhaustive and to reject an unknown state,
`BootstrapStepState` and `OwnerClaimState`, because the claim page renders one message per member.

### 4.8 Server-side totals, money and clocks

Three rules the specifications already respected and the contract now enforces in its shapes:

- **Money** is `{amount_minor, currency}` everywhere. The console formats; it never sums, never
  divides, and never computes a VAT amount.
- **Percentages** on the capacity gauge are server-computed (`CapacityDimension.pct`).
- **Clocks** are server-computed. `sla.next_response_due_at` accounts for business hours and public
  holidays; the console renders the instant it is given.

### 4.9 Two things the specifications assumed that were not adopted

- `PATCH /orders/{id}` — no server-side draft (§4.2).
- `format=text|pdf` and `format=html|pdf` on the domain instructions and the federation runbook —
  the API never proxies document bytes. Both return structured data with a `DownloadLink` for the
  PDF, matching how invoices and the DPA already work.

## 5. Owner decisions

These are product or contractual decisions rather than API mechanics. Section
5.2 carries ADR-0010, whose tenant and staff role sets the product owner has
decided. Section 5.3 and the identifier item in 5.6 carry the answers of
ADR-0011 and ADR-0009, which the product owner has decided as well. The
remaining sections keep their provisional option visible until the owner closes
them.

### 5.1 An order does not provision. Is that what the launch promises?

The job catalogue makes `provision` staff-only at launch, and the tenant state machine requires an
operator to move `ordered → provisioning`. So a customer who has paid sees status `ordered` until a
person acts. Meanwhile `console.status.overview.subtitle-provisioning` promises "ready within one
business day", and the order confirmation says the same.

That promise is currently kept by a human being available. Three ways out, in increasing order of
work: keep it manual and staff a rota; auto-trigger `provision` when the preconditions are met (DPA
accepted, quota headroom, slug free) and keep the operator only for failures; or say plainly on the
confirmation screen that a person reviews the order first.

**Taken provisionally:** manual, unchanged, because the contract cannot decide a staffing question.
Whichever is chosen, the confirmation copy and this contract must say the same thing.

### 5.2 The role set is closed

ADR-0010 fixes four tenant membership roles — `org_owner`, `org_admin`,
`org_billing`, `org_member` — and three staff roles — `staff_operator`,
`staff_support`, `staff_security`. `anonymous`, `invited` and `bootstrap` are
principal states, not stored roles.

`org_billing` is a sideways least-privilege grant for finance contacts. Only an
`org_owner` changes or removes an `org_owner` or `org_billing` membership, or
moves an active membership to or from those roles; an `org_admin` changes or
removes only `org_admin` and `org_member` memberships, and moves one only
between those two roles (`changeMembershipRole`, `removeMembership`); no one
changes or removes their own membership.

**A requirement on the console, not a description of it.** ADR-0010 requires the
People screen to expose that change to an owner with explicit permission copy.
Console pull request 42 (`docs/align-core-contract-decisions`) satisfied it and is
merged: on `kodera-hq/kodera` `main`, `docs/specs/03-people.md` gives an
owner "Donner accès à la facturation" in the row menu, the invitation dialog offers
"Facturation" beside "Membre" and "Administrateur", and the import shows
"Facturation" to an owner only.

Staff read a customer organisation's people records and hold two removals on
them; they add no one. No staff role holds `inviteToOrganisation`,
`resendInvitation`, `createEnrolmentToken`, `revokeEnrolmentToken`,
`createMemberImport`, `patchMemberImport` or `executeMemberImport`; the
member-import three are on the list because `executeMemberImport` runs the same
batch-invitation service as `inviteToOrganisation` (§4.4), so a staff grant
there would be the invitation grant through another door. On a customer
organisation's memberships, invitations, on-site enrolment tokens and member
imports, staff hold reading and two removals: `staff_operator` and
`staff_support` read memberships (`listMemberships`, `getMembership`,
`countMemberships`), invitations (`listInvitations`) and on-site enrolment
tokens (`listEnrolmentTokens`); `staff_operator` alone also reads member imports
(`listMemberImports`, `getMemberImport`), revokes a pending invitation
(`revokeInvitation`) and discards a member import (`deleteMemberImport`);
`staff_security` holds none of them. Other `staff_operator` operations reach
people without touching those records: activating a federation provider, whose
`redirect` mode sends everyone to it (`activateFederationProvider`); disabling
one, which returns every federated account to hosted sign-in
(`disableFederationProvider`); mailing the domain instruction sheet or the
federation runbook to a named person (`shareDomainInstructions`,
`shareFederationRunbook`); and recording the intended owner at intake
(`intended_owner` on `createOrganisation`). No staff role creates a membership
in a customer organisation, invites anyone, prepares an on-site enrolment token
or a member import, changes a customer's role, or grants itself a membership. Staff
assistance is the intake protocol: `createOrganisation` is `staff_operator`
only, creates a `prospect` organisation with no membership for anyone, and
first ownership is established by the first-owner claim of
`internal architecture records` `plans/complete-mock/FIRST_SLICE_SPEC.md`
§P1, whose operations the contract now carries: `createOrganisation` records the
intake, `getOrganisationBootstrap` reports the bootstrap to staff and to the
`bootstrap` principal, and `consumeOwnerClaim` creates the first `org_owner`.
`docs/api/AUTHZ.md` §4
states the decision, and `scripts/ci/check-authz-matrix.py` refuses a
contract that grants a role its matrix cell does not hold.
Ordering is the customer's act too: from contract 0.10.0 `placeOrder` is
`org_owner` only, because the order carries the customer's DPA acceptance, and the
`Order` cell of `AUTHZ.md` §5 gives `staff_operator` `read all`.

`staff_security` remains a read-only investigation boundary with no operational
mutation and no secret access. It may have no assignee; the role set does not
make a staffing decision. The contract, matrix and domain model use this set
without provisional markers.

### 5.3 Member-import retention is closed

§4.5 keeps parsing server-side, and the reasons are good. The consequence is that a file of names
and email addresses — personal data of people who have not yet consented to anything — is uploaded,
stored while the mapping is decided, and kept in `MemberImport.rows` afterwards.

ADR-0011 keeps server-side parsing but separates the data lifetimes. The raw
upload is deleted immediately after parsing. Parsed staging rows are encrypted
and have a fixed seven-day maximum. A completed or discarded import loses all
personal staging data immediately; a partial failure retains only the rows that
can still be retried. The durable result is counts and audit references, not an
address book.

The production feature stays disabled until the retention schedule, ROPA and
DPA annexes record the processing purpose and deletion mechanism and receive a
named privacy review.

### 5.4 mTLS or bearer for agents, and who decides per tenant

`AUTHZ.md` §7 makes mTLS preferred and a per-tenant bearer token the fallback, recorded on
`Agent.auth_method`. `AgentEnrolmentTokenCreateRequest.credential` defaults to `mtls` and lets the
operator choose `bearer` at enrolment.

Nothing says who is allowed to choose `bearer`, on what evidence, or whether a tenant may be moved
from one to the other after enrolment. A fallback that any operator may pick without recording why
becomes the default within a quarter, and a bearer token in a file on a VM is a materially weaker
credential than a client certificate the agent renews itself.

**Taken provisionally:** `mtls` default, `bearer` available. Decide whether `bearer` needs a
recorded reason on the enrolment (a `reason` member, refused when absent), and whether the fleet
should alert on any tenant whose `auth_method` is `bearer` for more than a set period.

### 5.5 Ticket context is server-composed, so the customer's unticking does nothing

`06-support.md` shows the customer exactly what a ticket will carry and lets them untick items, then
sends back `context_codes[]` with what is left. The contract recomputes the context server-side and
ignores whatever the client sends for it, because the context is what routes the ticket and sets
the SLA — a customer who unticks "tenant" would open an unroutable ticket.

The two cannot both be true. Either the checkbox list is decoration, which the specification's own
state matrix calls a dead end, or some items are genuinely optional.

**Taken provisionally:** `TicketContext.items[].removable` marks which items the customer may
actually drop; the organisation and the tenant are `removable: false` and render ticked and
disabled. The console will need to send the removable codes it kept, which means
`SupportTicketCreateRequest` gains an `omit_context_codes[]` member restricted to removable items.
That member is **not** in the contract yet, pending this decision.

### 5.6 Smaller ones

- **`GET /organisations/{id}/dpa` has no list operation**, only `POST` to generate and `GET` by id.
  The order screen needs to find an existing unaccepted DPA after a reload. `generateDpa` returns
  the existing document rather than creating a second one, so this works, but it is a `POST` used
  as a read.
- **Identifiers use UUIDv7.** ADR-0009 keeps the contract's `format: uuid`,
  PostgreSQL native storage and Django UUID representation while fixing Core's
  generator to version 7. Clients continue to treat every identifier as an
  opaque string.
- **`If-Match` is now declared on all seven `PATCH` operations**, with `412 precondition-failed`
  and `428 precondition-required` on each, and an `ETag` response header on every `GET` of a
  patchable resource and on every `PATCH` answer. `PATCH /federation-providers/{id}/credentials`
  is the one patchable resource with no `GET`, by design — nothing in this contract returns a
  client secret — so its `ETag` comes from the provider's own `GET`. The console does have to
  round-trip a tag on a role change; that is what stops two admins demoting each other from two
  tabs, and it was the question left open rather than the mechanics.

## 6. Reconciliation with the specifications

`docs/` is the vocabulary. Enums, registries, conventions and the authorisation matrix are decided
there, and this contract conforms — except where the contract's choice is demonstrably better, in
which case `docs/` moved and the reason is here. Every row below ends with one value on both sides.

### 6.1 The contract moved

| Decision | Was, in the contract | Is now | Why |
|---|---|---|---|
| Job kinds | 16, of which five were not in the catalogue | `JobKind` equals the sixteen kinds of `JOB_CATALOGUE.md` §2, in order | `render_profile` is a *step* of `provision`, not a kind. `send_invitations` mutates no infrastructure, so it is not a job at all. `verify_domain` is a fresh `add_domain` job — the catalogue is explicit that re-verification is a new job. `delete_data` was a second name for `delete`, and `sync_identity` a second name for `realm_update`, whose `configure_idp` step is exactly what a federation change applies. None of the five named a real job the catalogue lacked, so none was added to the catalogue |
| Problem types | 23 values, ten of them synonyms of registry entries | `ProblemType` equals the closed registry of `CONVENTIONS.md` §6, member for member | `capacity-exceeded` → `quota-exceeded`, `tenant-state-conflict` → `invalid-state-transition`, `job-in-flight` → `tenant-locked`. Two were mapped by status rather than by the nearer-looking name: the contract's `validation-failed` sat on `400` carrying `errors[]`, which is the registry's `malformed-request`; its `unprocessable-entity` sat on `422` refusing a business rule, which is the registry's `validation-error`. Renaming `validation-failed` to `validation-error` would have put a type the registry fixes at `422` on a `400` response, which is a second contradiction in place of the first |
| `domain-verification-failed` | `422` | `409` | The registry sets the status beside the name, and a domain that fails a check is a state conflict, not an unparseable body |
| Endpoint authorisation | `x-kodera-authz` only | `x-kodera-scope` **and** `x-kodera-authz`, on all 92, and on the two operations added since | `AUTHZ.md` §5 requires a declared `<resource>:<verb>` so that a missing declaration fails the contract test rather than defaulting open. The roles extension cannot stand in for it: the resource being touched is a fact about the endpoint, the roles are a product decision that moves — §5.2 was one, open when this row was written |
| `If-Match` | declared nowhere | required on all seven `PATCH`, with `412`, `428` and an `ETag` on every read of a patchable resource | `CONVENTIONS.md` §10 and §14, and §3.4 of this file, all promised it already |
| `Idempotency-Key` length | `maxLength: 128` | `maxLength: 255` | `CONVENTIONS.md` §8 says 16 to 255. A narrower contract rejects a conforming client |
| `verifyDomain`, `reissueDomainNonce` | `200` with the domain | `202` with the `add_domain` job and a `Location` | `CONVENTIONS.md` §7: a `200` from a mutating endpoint means nothing was enqueued. Two resolvers, a CA and an edge reload are not something to hold a request open for |
| `Location` on `202` | absent on `removeMembership` and `deleteDomain` | present, naming the job | Same rule, applied to the two other answers that hand back a `Job` |
| Agent certificate | at most 30 days, `x-kodera-rotation-days: 30` | 90 days, renewed at two-thirds of life, `x-kodera-rotation-days: 60` | `AUTHZ.md` §8 is the documented security design. Two-thirds leaves a 30-day window in which a renewal can fail, be retried and be noticed; "renewed before expiry" on a 30-day certificate gives whoever is on call a window nobody wrote down |
| Role spelling | `org:owner`, and `owner` in `OrganisationRole` | `org_owner` and `org_owner` | See §5.2. Three spellings for one role is how three disagreeing status enums happened once already |
| Credential-shaped examples | `inv_9f8e7d…`, `enr_7d6c5b…`, `aen_2f4a6c…` | `inv_EXAMPLE…`, `enr_EXAMPLE…`, `aen_EXAMPLE…` | All three were synthetic, and none of them looked it. A secret scanner that cries wolf on a schema example is a scanner people learn to ignore |
| `listTenantJobs` in §3.9 | listed | removed | No such operation. See §3.9 |
| `executeMemberImport` | `202` with a `JobAccepted` | `200` with `InvitationBatchResult` | Its `JobAccepted.kind` had to be a `JobKind`, and no kind in the catalogue sends invitations. It runs the *same* batch-invitation service as `inviteToOrganisation`, which is synchronous, so the two now answer the same shape. **This closes the `send_invitations` question**: the kind was not missing from the catalogue, the `202` was wrong. `MemberImport.job_id` is gone with it |
| `acceptInvitation` roles | the four organisation roles | `invited` plus the four | A person accepting an invitation holds no `Membership` in that organisation — that is what they are creating — so the operation was unreachable for its own case. `invited` is a declared principal in `AUTHZ.md` §4, not a `Membership.role`. The four are kept so a second click answers `409 conflict` rather than `403 forbidden` |
| `getInstanceLogs` roles | `staff_operator`, `staff_security` | plus `staff_support` | The `Host`, `Ip` row of the matrix grants `staff_support` `read all`. A support agent who can see a failing tenant but not the line explaining it escalates every question |
| `listAuditEvents` roles | staff only | plus `org_owner`, `org_admin`, `staff_support` | The matrix grants `org_owner` `read own, export own` and `org_admin` `read own`, and `AUDIT_TAXONOMY.md` makes this record the answer to "what did you do to our tenant". Staff-only would leave the DPA accountability clause with no way to honour it but a support ticket. A tenant principal's response is scoped to its own organisation before any filter; `organisation_id` is never an authorisation input |
| `CapacityTier.code` | `S`, `M`, `L` | `S`, `M`, `L`, `XL` | `MODEL.md` carries four on `Plan.capacity_tier` and `Tenant.capacity_tier`. The enum is the model; a tier that is not on sale carries `available: false`, which is what the contract's own rejected-order example already assumed |
| `listAuditEvents` filter example | `tenant.provision.requested` | `tenant.provision_requested` | Not a member of the closed registry of `AUDIT_TAXONOMY.md` §3. An example that fails the contract test teaches the wrong key |
| `activateDomain`, `deleteDomain`, `activateFederationProvider` | "a job" | `add_domain`, `remove_domain`, `realm_update`, named | So a reader checks `JobAccepted.kind` against the catalogue rather than against a guess |
| `Location` response headers | 15 headers, 0 examples | an example on all 15 | Found by generating the console's client and MSW handlers against this file. A mock built from examples could not emit the header the `202 + Job` convention promises, so the convention was untestable in the one place it is consumed. The eight `202`s carry the job URL; the seven `201`s carry the created resource's URL, which is what a `201` `Location` means |
| `Idempotency-Key` | required, with no machine-readable note of who produces it | `x-kodera-client-generated: true` plus a sentence | Required is right on the wire and stays. Without the marker, all 27 generated `POST` call sites take a mandatory key argument no caller should be choosing. The extension is recorded in `CONVENTIONS.md` §8 — an extension in the contract with no row in the vocabulary is exactly the divergence this file exists to end |
| `RealmDiscoveryRequest` | two examples | one, with the second form as prose | Every other schema carries one, and a single-example generator had to pick between them. The `email` branch is still documented, in the description, where it costs a generator nothing |
| `Job.idempotency_key` | "is the caller's `Idempotency-Key`" | "derived from it", `sha256(principal_urn + ":" + request_key)` | `CONVENTIONS.md` §8 says derived, and a digest is not the caller's key. The field keeps `maxLength: 128`: tightening it to `^[0-9a-f]{64}$` would be a narrowed type, which `README.md` classifies as breaking, and this round is additive |
| Sixteen high-entropy example values | random-looking hex and tokens | visibly non-random, patterns unchanged | `gitleaks` in the console's CI flags them as generic API keys once they are copied into a generated file, so every consumer would have to allowlist them. `ETag`, `If-Match`, three DPA digests, `DownloadLink.sha256`, `LegalDocument.sha256`, `Job.desired_spec_hash`, `Job.idempotency_key`, `Tenant.profile_commit`, the three token-shaped secrets, **the domain verification nonce** (`verification.record_value`, in four places), and — found by the widened sweep below — `Tenant.observed.compose_digest` and the agent CA's `ca_fingerprint`, both of which hid a 64-hex digest behind a `sha256:` prefix. Each still matches its declared `pattern`, and each field's description or its schema says the example is deliberately non-random |
| Verification nonce example | `kodera-verify=` plus 32 hex characters | `kodera-verify=` plus 48 lower-case Crockford base-32 characters, visibly non-random | The old value was not a nonce of ours at all: `DOMAIN_STATE_MACHINE.md` §2 fixes 48 base-32 characters from 30 random bytes, and 32 hex characters is 16 bytes in the wrong alphabet. The round-3 sweep missed it because the sweep matched a whole value against `^[0-9a-f]{32,}$` and this one carries a `kodera-verify=` prefix — the sweep now matches inside a prefixed value too, so a credential cannot hide behind a label again. The same value is used in `DOMAIN_STATE_MACHINE.md`, in the two schema examples, in the domain-instructions example and in `contracts/examples/domain-verification.json`. The sweep now also asserts that every `kodera-verify=` example is 48 characters of the lower-case Crockford alphabet, so a wrong-shaped nonce fails the tally rather than a reviewer |
| Counts in §2 | hand-counted, wrong in three lines | counted from the table by a script | See §2 |

### 6.2 The specifications moved

| Decision | Was, in `docs/` | Is now | Why the contract's choice is better |
|---|---|---|---|
| Page envelope | `{"data": [...], "next": "..."}` (`CONVENTIONS.md` §2, §12) | `{data, next_cursor, has_more}` | A page can be short without being the last one, so "stop when `data` is short" is a bug that only shows up under load. `has_more` is a boolean a client can loop on without inferring anything, and naming the cursor `next_cursor` says what it is rather than what it is for |
| Problem registry | 24 rows | 29 rows | Five types the contract emits had no row: `mfa-required`, `idempotency-key-missing`, `domain-state-conflict`, `last-owner-protected`, `upstream-unavailable`. Each is a real condition with its own client behaviour, and the convention says a new value is a row in that table *and* a member in this file — so both got one |
| Authorisation matrix | 25 rows, six roles | 32 rows, eight roles | The contract had grown into `Identity`, `Order`, `Incident`, `Entitlement`, `MemberImport`, `FederationProvider` and `FederationTest`, none of which had a row to mirror. ADR-0010 fixes the `org_billing` and `staff_security` columns |
| `x-kodera.schema.json` | a reserved row in `docs/INDEX.md` | no row | The schema is owned by `deployment operations` and referenced by SHA. A reserved row for a path this repository will never hold can never resolve, and the index's own rule fails on it |
| `SupportTicket` for `org_member` | `read own` | `create, read, reply own` | A member who cannot open a ticket asks an admin to open it for them, and support then answers the wrong person |
| Entities the matrix authorised | 34 of 44 defined in `MODEL.md` | 44 of 44 | `AUTHZ.md` §5 was authorising ten resources the data model never defined: `Order`, `Incident`, `Entitlement`, `MemberImport`, `FederationProvider`, `FederationTest`, `Pack`, `CapacityTier`, `LegalDocument`, `SupportTicket`. Each now has a section with its fields, keys and scoping, matching this contract's schema of the same name field for field. A matrix row with no entity behind it authorises access to nothing, which is a permission nobody can implement and nobody can test |
| `Entitlement`, `SupportTicket` | absent | defined as **computed, never stored** | `Entitlement` is a projection of one organisation's subscription; `SupportTicket` composes `SupportTicketLink`'s Core-owned routing and SLA columns with the fields read through from the helpdesk. Giving either a table would have contradicted "Core never stores ticket content" and created a second source for an entitlement answer. Departure: while no helpdesk exists, Core stores `SupportTicket` for at most 14 days (MODEL.md, `SupportTicketLink`, "Departure while no helpdesk exists") |
| `FederationTest` scoping | — | `organisation_id` denormalised | Without it the row is two joins from an organisation and `MODEL.md` §11 invariant 12 fails. The same denormalisation `Job` already carries, for the same reason |
| `anonymous`, `invited` | not in the role table | one line each, marked "not a `Membership.role`" | `x-kodera-authz` has been declaring `anonymous` on nine operations against a table that did not contain the word. A vocabulary that omits a value the contract uses is not the vocabulary |
| Agent problem registry | `CONVENTIONS.md` §14 said the Agent API "shares §6" | §14 now states the namespace exception and lists the eleven types | See §6.5 |
| Index reserved rows | the rule said CI fails on a row whose path does not exist | the exception is written into the rule | A rule that is quietly not enforced is worse than one with a stated exception |

### 6.3 Both moved

| Decision | Outcome |
|---|---|
| Heartbeat `seq` | The contract answered `409 seq-regression` to any regression and told the agent to stop; `AUTHZ.md` §7 said a replay is accepted with `200` and discarded, and had no `boot_id`. Neither was right on its own: the specification could not express a reboot, and the contract took an agent out of service for a dropped packet. Both now carry the same three-case rule keyed on `(boot_id, seq)` — replay inside a `boot_id` is `200` and discarded, a new `boot_id` is the reboot case and is accepted, and only a `seq` below one already accepted for the *same* `boot_id` is `409`. `boot_id` came from the contract; the `200` came from the specification |
| Endpoint extensions | The contract gained `x-kodera-scope` on all 92 operations, and both operations added since carry it; `AUTHZ.md` §5 gained the two-extension design, the closed verb set, and the seven matrix rows the scopes needed to mirror |

### 6.4 Neither moved, and why

- **`resendInvitation` stays `200`.** It is an `actions/<verb>` sub-resource, and `CONVENTIONS.md`
  §1 says those create a `Job`; but the rule §7 actually states is that anything mutating
  *infrastructure* answers `202`. Resending hands one message to the mail transport and updates two
  counters on an existing row. Inventing a job would give the console something to poll that can
  only ever be `succeeded`.
- **`reportSignInProblem` is the one `202` with no `Location`.** A URL to poll would confirm that
  something was created, and telling an unauthenticated caller that much is the enumeration this
  endpoint is shaped to prevent.

### 6.4bis `record_value` carries no `pattern`, and that is the call

The obvious follow-up to fixing the nonce example is to pin its shape with
`pattern: '^kodera-verify=[0-9a-hjkmnp-tv-z]{48}$'`. It is not done, for three reasons in
increasing order of weight.

1. **Two of the three `record_value` declarations are not nonces.** The field is generic: under
   `verification` it carries the TXT challenge, under `target` it carries `acme.visio.kodera.io.`,
   and in the domain instructions it carries whichever of the two the row is about. A
   `kodera-verify=` pattern on `record_value` would reject the CNAME row sitting two lines below
   the TXT row in the same example. Only `verification.record_value` is nonce-shaped, because only
   there is `record_type` pinned to `TXT`.
2. **Even on that one field it is a narrowed type**, which `contracts/README.md` classifies as
   breaking. Round 3 declined exactly this move on `Job.idempotency_key`, for exactly this reason.
   Taking it here and not there would make the rule mean whichever answer was convenient.
3. **The shape is already normative somewhere better.** `DOMAIN_STATE_MACHINE.md` §2 owns the nonce
   format — alphabet, length, and the 30-bytes-to-48-characters arithmetic — and now states all
   three. A contract that repeats a rule owns a second copy of it.

The `verification.record_value` description points at that section instead, so a reader gets the
rule without the contract asserting it twice. Pinning it is a next-major item, and it travels with
the `Job.idempotency_key` pattern: one `contract:breaking` pull request, both fields, after `1.0.0`.

### 6.5 Left open, deliberately

- **Closed: what records a customer instruction for assisted staff.** Closed by narrowing, not
  by a field. No staff role holds an operation that ends in an invitation or an enrolment
  credential reaching a customer organisation (§5.2), so there is no operation left to record an
  instruction for. The recorded instruction reference is a field of the staff intake in
  `FIRST_SLICE_SPEC.md` §P1 of `internal architecture records`, and it has arrived:
  `OrganisationCreateRequest.instruction_ref` is required, and `organisation.intake_recorded`
  carries it.
- **Revoking and reissuing an owner claim.** §P3 of `FIRST_SLICE_SPEC.md` requires a dedicated
  revoke-and-reissue path for a lost delivery, and FS-BOOT-04 and FS-BOOT-05 need a revoked claim
  and a claim racing a revocation. The `OwnerClaim` cell of `AUTHZ.md` §5 grants `staff_operator`
  `revoke` and the audit registry has `owner_claim.revoked`; the operation itself is **open**,
  because the delivery mechanism it reissues into is a security decision the specification
  leaves to its owner.
- **The claim's lifetime and delivery.** Proposed at 72 hours by §P1 and recorded there as a
  security decision not yet taken. The contract carries `expires_at` and no number; `AUTHZ.md` §8
  lists the row as proposed. **Open**, with its owner named in the specification's decision table.
- **Abandonment of a `prospect`.** No transition leaves `prospect` other than the claim. The
  specification defines neither a deadline for an unclaimed prospect nor the fate of its slug
  reservation under ADR-0008, and `MODEL.md` says so rather than choosing. **Open**.
- **Which job binds the intended identity.** §P1 step 2 has the worker create the realm and then
  establish the intended subject through the identity-provider flow; the contract reports that
  binding as `OrganisationBootstrap.identity_mapping` and ties the realm to the `realm_create`
  job. Whether the binding is a step appended to `realm_create` or a sibling kind is the Worker
  seat's decision in `JOB_CATALOGUE.md`, and it is **open** there; the contract fixes the
  observable state, not the step list.
- **Closed: slug length.** Contract 0.11.0 carries two rules. The organisation slug, the name of the
  organisation's realm, is five to twenty characters on every schema that carries it —
  `Organisation`, `OrganisationCreateRequest`, `OrganisationSummary`, `RealmDiscoveryRequest` and
  `OrganisationBootstrap` — as `CONVENTIONS.md` §4, `MODEL.md` and `FIRST_SLICE_SPEC.md` §P2 state,
  §P2 since register SLUG-MIN-ANSWER. The tenant slug, the tenant's DNS label and Scaleway project
  name, is three to thirty-two characters on `OrderRequest.tenant`, `Tenant` and
  `checkSlugAvailability`, and on the tenant slugs `SlugAvailability` and
  `SupportTicket.tenant_context` return. FS-ID-01 and FS-ID-02 measure both patterns first and now
  stop at the unrouted intake. The organisation minimum of five is the owner's answer (register
  SLUG-MIN-ANSWER), superseding the lead's own call of two that contract 0.10.0 carried (register
  SLUG-MIN); the tenant rule is owner-confirmed (register TENANT-SLUG). A console check of the
  organisation slug before sending it follows the same five.
- **`Organisation.status` spells its last member `terminated` in `MODEL.md` and `closed` in the
  contract's `OrganisationState`**, and §P2 proposes `closing` and `closed`. One list is the
  rule; which spelling is a lifecycle decision the closure work owns. **Open**, pre-existing.
- **Closed: what grant ceiling a staff-assisted invitation or import has.** None is needed: no
  staff role holds `inviteToOrganisation`, `patchMemberImport` or `executeMemberImport`, so
  `InvitationRole` admitting `org_billing` is a ceiling on owners and admins only, which
  `docs/api/AUTHZ.md` §4 already states. ADR-0010's rejection of staff-assigned `org_billing`
  is implemented by the grants rather than by a rule nothing enforced.
- **Closed: whether `staff_operator` keeps `read, delete all` on `MemberImport`.** ADR-0011 is the
  data-minimisation decision. It rejects retention for support — "support access is not a lawful
  reason to keep an address book" — and removes `staff_support` from `listMemberImports` and
  `getMemberImport`. Its decision does not bound the operator. The operator's residual has since
  narrowed: `staff_operator` no longer holds `createMemberImport`, `patchMemberImport` or
  `executeMemberImport` (§5.2) and keeps `listMemberImports`, `getMemberImport` and
  `deleteMemberImport` — `member_import:read` and `:delete`, across every organisation, over the
  same staged names and email addresses of people who have not yet interacted with the service.
  The matrix and the contract agree on that residual, so this is not drift. Reading the staged
  address book is the intended residual: it is the product owner's decision, in ADR-0010, whose
  grant rules say that `staff_operator` alone among the staff roles reads member imports and
  discards one. Accepting ADR-0011 remains a decision about `staff_support`, and ADR-0010
  is the decision about staff access to the staged address book.
- **`Location` on `201`. Nine, not eight** — the first version of this line miscounted, and the
  nine are: `inviteToOrganisation`, `createEnrolmentToken`, `createPaymentLink`, `generateDpa`,
  `createAgentEnrolmentToken`, `shareDomainInstructions`, `replyToTicket`, `attachToTicket`,
  `shareFederationRunbook`. Each creates a resource and declares no `Location`, which
  `CONVENTIONS.md` §14 requires. Seven of them name the created row in the body; the batch
  invitation creates up to 500 rows and has no single URL to point at, and the two share endpoints
  create a delivery rather than an addressable row. It needs one decision — a `Location` per
  created resource, or a §14 that says "where the response names exactly one" — not nine separate
  edits. `reportSignInProblem` is the tenth answer without a `Location` and the one that is
  deliberate; see §6.4.
- **The Agent API has its own problem-type namespace**, and that is the exception to
  `CONVENTIONS.md` §6's closed registry rather than a violation of it. `agent-api.openapi.yaml`
  carries eleven types under `https://kodera.io/problems/agent/` — `validation-failed`,
  `unauthenticated`, `instance-mismatch`, `instance-decommissioned`, `not-found`,
  `seq-regression`, `command-already-terminal`, `config-ref-expired`, `error-code-required`,
  `rate-limited`, `internal-error` — and §14 now says so, having previously claimed the Agent API
  "shares §6". It does not: it shares the RFC 9457 *shape*. The two clients are different animals.
  The console is a browser application that maps every `type` to a French message key; the agent
  is a daemon that switches on a short list and either retries or stops. Merging the registries
  would give the agent twenty members it can never emit and no way to say `instance-mismatch`,
  and would put agent conditions in front of the console. Both registries stay closed, and a new
  member is a pull request against the table that owns it. One name differs deliberately:
  `agent/validation-failed` sits at `400` and covers what §6 splits into `malformed-request` (400)
  and `validation-error` (422), because the agent has one body shape per endpoint and no business
  rules to fail — the split exists for an API that has both.
- **App codes.** `contracts/core-api.openapi.yaml` spells the calls application `visio` in
  `AppCode`; `docs/` spells it `meet` in `Tenant.apps`, `Plan.included_apps` and the job
  catalogue. One name for one thing, and it is not settled here because the Keycloak client id,
  the profile service name and the customer-facing product name may not all want the same word.
  It is a rename with a small diff and a large blast radius, and it needs a separate product
  naming decision.

## Changelog

- First version. Maps the 72 calls the console's launch specifications assume onto the contract,
  records the naming decisions, adds federation, member imports, entitlements, the status summary,
  the dunning view, contextual help and the sign-in problem path, and lists the six questions that
  need an owner rather than an architect.
- Recounts §2 from the mapping table with a script — 76 rows, 13 match, 22 rename, 3 fold, 38 added,
  72 distinct calls — and removes `listTenantJobs` from §3.9, which never existed.
- Adds §6, the record of the reconciliation with `docs/`: which side moved on each contradiction the
  review found, and why. Settles the role spelling in §5.2 while leaving the role set open, and
  closes the `If-Match` bullet of §5.6.
- Fourth round. The domain verification nonce example was `kodera-verify=` plus 32 hex
  characters in four places, which is not a nonce this platform issues:
  `DOMAIN_STATE_MACHINE.md` §2 fixes 48 lower-case Crockford base-32 characters from 30 random
  bytes. All four now carry the same visibly non-random 48-character value, and §6.4bis records
  why `record_value` still has no `pattern`. Widening the sweep to look *inside* a value rather
  than only at whole values — the anchoring that let a `kodera-verify=` prefix hide a digest —
  immediately found two more of the same kind, `compose_digest` and `ca_fingerprint` behind
  `sha256:`, so the converted list is sixteen rather than fourteen.
- Third round, from generating the console's typed client and MSW handlers against this file rather
  than from reading it. Every `Location` response header gains an example, all fifteen. The
  `Idempotency-Key` parameter says it is client-generated, in prose and in
  `x-kodera-client-generated`. `RealmDiscoveryRequest` drops to one example like every other
  schema, its second branch moving into the description. `Job.idempotency_key` is documented as the
  derived digest `CONVENTIONS.md` §8 already specified, rather than the caller's key. Thirteen
  example values that looked like credentials or digests become visibly non-random, patterns
  unchanged, so no consumer has to allowlist them. `If-Match` needed nothing: it was declared on all
  seven `PATCH` operations in the first round, and §5.6 records that rather than the open question
  it used to be.
- Second review round. `executeMemberImport` becomes synchronous, which closes the
  `send_invitations` question without adding a job kind; `acceptInvitation`, `getInstanceLogs` and
  `listAuditEvents` are brought back to their cell of the matrix, the last of them so a customer
  can read the audit trail the DPA promises them; the ten resources the matrix authorised and the
  model never defined are defined; the Agent API's problem namespace is recorded as an exception
  rather than left as a contradiction; and the `201`-without-`Location` count is corrected to
  nine, listed.
- Closes identifier type, role set and member-import retention through
  ADR-0009, ADR-0010 and ADR-0011; the remaining owner questions stay explicit.
- Words §5.2 as a requirement on the console rather than a description of it,
  because `03-people.md` on console `main` still has no billing entry in the row
  menu, and names the console branch that satisfies the requirement. Records the
  missing recorded-instruction mechanism in §6.5 instead of restating a control
  that nothing implements.
- Records in §6.5 that no grant ceiling is declared for `staff_operator` while
  `InvitationRole` admits `org_billing`, which is the outcome ADR-0010's options
  table rejects by name. Recorded, not closed: the enum and the grants are
  unchanged.
- Applies the owner's decisions on staff and customer identity. §5.2 states that staff prepare
  nothing that reaches a customer organisation and that assistance is the intake protocol with
  a customer-claimed first owner; §6.5 closes the recorded-instruction and staff-ceiling questions
  by the removal of the grants they were about, and restates the operator's member-import
  residual as `read, delete all`. The check that keeps the contract inside the matrix is named
  where the decision is.
- Carries the first-owner claim protocol into the contract. §3.9 places the claim page beside
  the invitation page as a screen without a specification; §4.7 lists the three closed enums it
  adds; §5.2 names the three operations; §6.5 closes the recorded-instruction item by the field
  that now carries it and opens five items the specification leaves to their owners — revoke
  and reissue, lifetime and delivery, abandonment of a prospect, which job binds the identity —
  plus two pre-existing disagreements the acceptance scenarios would otherwise find first, the
  slug length and the last organisation state's spelling.
- Follows contract 0.10.0. §2 adds the operation count at 0.10.0, 94, beside the 92 the
  reconciliation ended with; §5.2 records console pull request 42 as merged and the People
  requirement as met, and states that `placeOrder` is `org_owner` only; §6.5 closes the slug
  length item with the organisation rule of 2–20 and the tenant rule of 3–32.
- Follows contract 0.11.0. §6.5's slug length item carries the owner's organisation minimum of
  five (register row SLUG-MIN-ANSWER), superseding the lead's own call of two (register row
  SLUG-MIN); the tenant rule of 3–32 is unchanged. §2 adds the operation count at 0.11.0, 94,
  unchanged.
- §5 no longer says ADR-0009, ADR-0010 and ADR-0011 become Accepted when a second `docs/adr/`
  reviewer signs: the product owner has decided ADR-0010's tenant and staff role sets, and
  ADR-0009 and ADR-0011 await the product owner's decision.
- §5.2 no longer says staff hold no operation that reaches a customer organisation's people:
  staff read memberships, invitations and on-site enrolment tokens, `staff_operator` also reads
  member imports, revokes a pending invitation and discards a member import, and no staff role
  adds anyone, in the words of `docs/api/AUTHZ.md` §4.
- §5.2 names `bootstrap` among the principal states, adds that only an owner removes a billing
  membership, and names the two further `staff_operator` operations that reach people: federation
  activation and the intended owner at intake. §5.2 and §6 point the first-owner claim at
  `internal architecture records`.
- §5.2 states who changes or removes which membership, that no one changes or removes their own,
  and every further `staff_operator` operation that reaches people, in the words of
  `docs/api/AUTHZ.md` §4.
- Supersedes the changelog bullet above that says §5.2 "names the two further `staff_operator`
  operations that reach people": that count was incomplete. §5.2 has named all five since the change
  recorded by the bullet that follows that one — activating and disabling a federation provider,
  mailing the domain instruction sheet or the federation runbook, and recording the intended owner
  at intake.
- §5 no longer says ADR-0009 and ADR-0011 await the product owner's decision: the product owner
  has decided both. This supersedes the changelog bullet above that says they await it. §6.5 closes
  the `staff_operator` member-import item: reading and discarding a staged import is a grant
  ADR-0010 decides, and ADR-0011 says so instead of calling the question open.
