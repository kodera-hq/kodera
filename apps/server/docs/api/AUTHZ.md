# Authentication and authorisation

**Status:** Proposed · **Owner:** API seat

How the Core API decides who a caller is and what that caller may do. Bound by ADR-0003 (the API process holds no infrastructure credential), console ADR-0002 (tenant admins log in against their own realm) and console ADR-0003 (the console talks only to the Core API).

## 1. Principals

| Principal | Authenticator | Realm / credential | Represents |
|---|---|---|---|
| Tenant user | Bearer JWT | the organisation's own Keycloak realm, named `{organisation_slug}` | A person acting inside one organisation |
| Staff user | Bearer JWT | the `kodera-staff` realm, MFA enforced | A Kodera operator or support agent |
| Agent | mTLS client certificate, or a per-tenant bearer token | issued at enrolment, one per tenant VM | One tenant's agent process |
| System | none (in-process) | — | The worker and scheduled tasks; never reachable over HTTP |

There is no API key, no shared secret, no basic auth, and no service account usable by a human. A principal is always resolved to exactly one of the four types before any view code runs.

Two states of the tenant-user principal hold no `Membership` and are declared in §4 beside the roles rather than in this table, because the authenticator is the same: `invited`, a person redeeming an invitation, and `bootstrap`, the intended first owner of a `prospect` organisation between the identity worker's binding of their identity and their consumption of the owner claim. Neither is a stored role; each names the closed set of operations a person may reach while holding no row of the §5 matrix.

## 2. Token verification across N customer realms

Keycloak runs at `id.kodera.io` with one realm per customer organisation plus the staff realm `kodera-staff` (ADR-0006). Every tenant of an organisation authenticates against that organisation's realm; a tenant has no realm of its own. Verification is strictly ordered; a failure at any of steps 1 to 5, an unknown realm or issuer included, is `401 unauthenticated` with no detail beyond `www_authenticate_reason`. A token that passes them is never `401`: what step 6 refuses is `403 identity-unknown`.

1. **Parse** the compact JWS. Reject `alg: none` and any algorithm outside `{RS256, ES256}` — the allow-list is a constant, not read from the token or from discovery.
2. **Read `iss`.** It MUST match `^https://id\.kodera\.io/realms/(?P<realm>[a-z0-9][a-z0-9-]{0,19})$` exactly, including scheme and host. Any other issuer host is rejected before any network call.
3. **Look up the realm.** `realm` is resolved against the database: the staff realm constant `kodera-staff`, or `Organisation.realm` (unique, indexed). An unknown realm is `401`. **The client never supplies the realm, the organisation, or the tenant it wants to act on**; those are derived from `iss` alone. A body or header field naming a realm is ignored, and a pull request that reads one is rejected.
4. **Fetch the signing key.** JWKS is cached **per issuer** (`iss` string, not per organisation) with a positive TTL of 10 minutes and a negative TTL of 30 seconds. A `kid` miss triggers at most one refetch per issuer per 60 seconds; a second miss is `401`. The cache is a shared, size-bounded (1 000 issuers) LRU, and every fetch has a 2-second connect and 3-second read timeout so one slow realm cannot stall the API.
5. **Verify** signature, `exp`, `nbf`, `iat` with 30 seconds of clock skew, `aud` containing `kodera-server`, and `typ: Bearer` (an ID token presented as an access token is rejected). On the customer lane, `azp` must also be exactly one of the allowed OAuth clients: `KODERA_ALLOWED_OIDC_CLIENT_IDS`, comma-separated, by default `console,kodera-ios,kodera-android` (the web console and the two native apps, each a public client of every organisation realm), with `KODERA_CONSOLE_CLIENT_ID` added when it is set. A token with no `azp`, or another client's, is refused here like any other. The list is resolved once at start (`config.environment.allowed_oidc_client_ids`) and held by each customer-lane issuer of `KODERA_AUTH_TRUST`; a malformed entry stops the process, and so does a list that resolves to no client, except in the local test and end-to-end profiles. The staff lane does not judge `azp`.
6. **Resolve the subject.** `(iss, sub)` is the natural key of `Identity`; `Identity.user` is the `User`. A verified token of a customer realm whose `(iss, sub)` has no `Identity`, or only one that is disabled or deleted, or whose person is disabled or deleted, creates neither and is `403 identity-unknown`, with no `WWW-Authenticate`. It is not `401`: the token is valid, and signing in again yields the same token, so a client told to re-authenticate would loop; `403 identity-unknown` lets it route the person, such as a realm account Core never bound, to "no organisation yet". **The one named exception is the `invited` principal on `acceptInvitation` and `previewInvitation`** (§4): a person the realm authenticated and Core does not know yet, by design, since accepting the invitation is what creates the identity; those two operations resolve their principal from the invitation, not by this step, and are not answered `identity-unknown`. It reveals nothing about another subject, since the caller already holds a valid token of that realm. Identities are created by the invitation and enrolment flows, and by the identity worker's binding of an intended first owner during bootstrap (§4, `bootstrap`); never by a bearer token arriving. The staff lane is unchanged, and `identity-unknown` is for customer identities only: a staff token that resolves no stored staff identity is refused as §3 and [`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md) say, a staff token presented on a customer operation is refused there as that operation's staff rule says (`403 forbidden` on every customer read), and the staff issuer is never answered as a customer identity: a token of the staff issuer arriving on the customer lane, which only a misconfigured trust admits, is refused `401` by one lane guard (`core/api/lanes.py`) on every customer operation before any customer identity is resolved.
7. **Resolve the scope of action.** For a customer realm the organisation is `Organisation.objects.get(realm=realm)`; the caller's roles come from `Membership(user, organisation)` in the database, **not** from the token's `realm_access.roles`. Keycloak roles are advisory; the database is authoritative, so revoking a membership takes effect on the next request rather than on the next token refresh.
8. **Check the organisation.** `status` in `{active}` for mutations; a `suspended` organisation may read, may pay and may cancel an order not yet paid (`cancelOrder`, which only stops what it would owe), and every other mutation is `402 payment-required` (billing dunning) or `403` (administrative suspension) — except `initialiseWorkspace`, which on a `suspended` organisation is `409 invalid-state-transition` with `allowed_states: [active]`: setting the workspace up is not use of the service, and the contract declares no `402` for it ([`../specs/PILOT_WORKSPACE_ONBOARDING.md`](../specs/PILOT_WORKSPACE_ONBOARDING.md) §§6, 9). A `prospect` organisation admits exactly one mutation, `consumeOwnerClaim` by its `bootstrap` principal, and one read of its own, `getOrganisationBootstrap`; staff reads on it follow the ordinary rule, and every other mutation on it is `409 invalid-state-transition`, because it is the organisation's state that forbids the act, not the caller's role.

Failures at steps 2–4 are counted per issuer and alert when one realm's failure rate exceeds its own baseline; this is how a misconfigured or hostile realm is noticed.

## 3. Staff realm

- Realm `kodera-staff`, used only by Kodera staff, with MFA (passkey or TOTP) required by the realm's browser flow **and** re-asserted by the API on every staff request, whatever the realm says: a staff token without `amr` containing one of `{otp, hwk, mfa}` resolves no staff principal, and on a staff write the contract answers it `403 mfa-required`, with the second factors it would accept in `required_amr`.
- Staff tokens carry no organisation. A staff principal names the organisation or tenant it acts on in the path, and every such request is audited with `actor_type: staff` (see [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md)).
- Staff never authenticate against a customer realm, and tenant users never authenticate against `kodera-staff`. A token from `kodera-staff` presented on a tenant-scoped write path is accepted only for the staff roles in §5.
- There is no Django admin in production. Staff act through the same API as the console.
- A staff person's identity is stored with no organisation, in the staff realm, and the staff roles of §4 are `StaffRole` rows granted to it by an operator command ([`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md)). As for tenant users (§2, step 7), the database is authoritative: a staff token's realm roles grant nothing, and revoking a grant takes effect on the next request. A staff principal is resolved only from a staff-lane token of the one staff issuer, `KODERA_STAFF_ISSUER`, whose `amr` names a second factor, for a stored staff identity, and an operation reads the grant it needs itself (`STAFF_IDENTITY.md` §5).

## 4. Roles

Roles are stored on `Membership.role` (tenant side) or `StaffRole` (staff side). The set is closed.

| Role | Principal | Granted by | Purpose |
|---|---|---|---|
| `org_owner` | tenant user | the first-owner claim of assisted onboarding (`consumeOwnerClaim`, notes below); afterwards an existing owner, by a role change on an active membership (`changeMembershipRole`) | Everything `org_admin` holds, plus the contract and payment — accepting and generating the DPA (`acceptDpa`, `generateDpa`), placing orders (`placeOrder`), payment links (`createPaymentLink`, `getPaymentLink`) — changing or removing owner and billing memberships, setting the DPA's notice addresses (`patchNoticeContacts`), and `consumeOwnerClaim`, which names `org_owner` beside `bootstrap` so that a replay by the person the claim has just made owner is answered (notes below). At least one per active organisation, always |
| `org_admin` | tenant user | an owner or an admin, through an accepted invitation (`inviteToOrganisation`, or `executeMemberImport`, which sends invitations) or a role change on an active membership (`changeMembershipRole`) | People (admin and member memberships, invitations, on-site enrolment tokens, member imports), domains, identity federation, organisation settings and support; reads tenants, jobs, audit events, orders, the DPA and billing. Places no order, accepts or generates no DPA, and holds no payment link |
| `org_billing` | tenant user | an owner only, through an accepted invitation (`inviteToOrganisation`, `executeMemberImport`) or a role change on an active membership (`changeMembershipRole`) | Reads invoices, orders, subscriptions, dunning and the DPA; creates and reads payment links; reads the organisation, its tenants, their status and availability, and its entitlements; works support tickets and edits its own profile (`patchMe`). No write on people, tenant operations, domains or infrastructure |
| `org_member` | tenant user | an owner or an admin, through an accepted invitation (`inviteToOrganisation`, `executeMemberImport`), an on-site enrolment token (`createEnrolmentToken`) or a role change on an active membership (`changeMembershipRole`) | Reads the organisation, its tenants, domains, identity federation, entitlements and the people list; works support tickets and edits its own profile (`patchMe`). No administrative write |
| `staff_operator` | staff user | a `StaffRole` grant, by an operator command ([`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md) §4); the staff realm's roles grant nothing (§3) | The only role that runs tenant lifecycle jobs (`triggerTenantJob`: provision, upgrade, backup, restore, suspend, resume, decommission), issues tenant agent enrolment tokens (`createAgentEnrolmentToken`) and takes the organisation intake (`createOrganisation`). Beyond those three, it shares its grants with other roles: with `org_owner` and `org_admin`, the operational writes on domains, identity federation and organisation settings, revoking a pending invitation, and reading and discarding a member import (`listMemberImports`, `getMemberImport`, `deleteMemberImport`); with `staff_support`, every other read across organisations, some of which `staff_security` also holds; with every tenant role and `staff_support`, support-ticket work |
| `staff_support` | staff user | a `StaffRole` grant, by an operator command ([`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md) §4); the staff realm's roles grant nothing (§3) | Read-only on customer data across organisations, except support tickets, which it creates, replies to and attaches files to (`createSupportTicket`, `replyToTicket`, `attachToTicket`); plus ticket linking, impersonation-free diagnostics and its own profile (`patchMe`) |
| `staff_security` | staff user | a `StaffRole` grant, by an operator command ([`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md) §4); the staff realm's roles grant nothing (§3) | Reads audit events, jobs and instance logs across the fleet. Writes nothing but its own profile (`patchMe`) and reads no secret value |
| `agent` | agent | enrolment | Heartbeat, command results, log references for its own tenant only |
| `invited` | tenant user | an invitation token | **Not a `Membership.role`**: an authenticated principal in a customer realm who holds no `Membership` yet. It exists for two operations: `POST /invitations/accept`, and `POST /invitations/preview`, the read-only card shown before it from the same token and the same checks (`../specs/INVITATIONS.md` §3). Both operations also name the four organisation roles, deliberately: a person who already holds a `Membership` reaches the handler and is answered `409 conflict` — already a member — rather than `403 forbidden`, which is what a second click on the same invitation link should get |
| `bootstrap` | tenant user | the identity worker's binding of the intended first owner | **Not a `Membership.role`**: an authenticated principal in a customer realm whose `(iss, sub)` the identity worker bound as the intended owner of a `prospect` organisation, holding no `Membership`, presenting a claim. It reaches only the claim and status operations of the first-owner protocol and has no ordinary organisation role: `bootstrap` reaches exactly two operations, `getOrganisationBootstrap` and `consumeOwnerClaim`, and an operation naming it anywhere else fails the contract check. `consumeOwnerClaim` names `org_owner` beside it. That operation also names `org_owner`, deliberately: consuming the claim makes the caller `org_owner` in the same transaction, so a retry of the same logical operation by the same identity — the resumed submission §P3 of `FIRST_SLICE_SPEC.md` allows — reaches the handler and is answered from the replay cache, or with `409 owner-claim-consumed` under a new key, rather than with a `403` that reads as "you may not own this". The token in the body never authenticates; the realm JWT does, and a spent token authenticates nothing |
| `anonymous` | none | — | **Not a `Membership.role`**: the unauthenticated principal. It names the handful of operations that carry no token at all — realm discovery, the public catalogue, the status page, the sign-in problem report — and it exists in the vocabulary so that "no token" is a declared value in `x-kodera-authz` rather than an absent extension |

Notes:

- A person may hold different roles in different organisations; that is why `User`, `Identity` and `Membership` are three tables ([`../domain/MODEL.md`](../domain/MODEL.md)).
- `org_owner` implies every `org_admin` permission; `org_admin` implies every `org_member` permission. `org_billing` implies no other role and is implied by none: it is a sideways grant, which is the whole point of having it. Staff roles do **not** imply tenant roles, and no staff role can create a tenant membership for itself.
- Only an `org_owner` changes or removes an `org_owner` or `org_billing` membership, or moves an active membership to or from those roles; an `org_admin` changes or removes only `org_admin` and `org_member` memberships, and moves one only between those two roles (`changeMembershipRole`, `removeMembership`); no one changes or removes their own membership. No staff role changes an active customer role; on a customer organisation's memberships, invitations, on-site enrolment tokens and member imports, staff hold reading and two removals (next note). Every role change requires the current ETag and is audited (ADR-0010).
- **Staff read a customer organisation's people records and hold two removals on them; they add no one.** No staff role holds `invitation:create`, `invitation:act`, `enrolment_token:create`, `enrolment_token:delete`, `member_import:create`, `member_import:update`, `member_import:act`, `payment:create` or `dpa_acceptance:create`: `contracts/core-api.openapi.yaml` grants the ten operations under those nine scopes (`acceptDpa` shares `dpa_acceptance:create` with `generateDpa`) to tenant roles only, and the §5 cells say the same. The three member-import operations are on the list by the rationale of `../../contracts/CONSOLE_RECONCILIATION.md` §4.4 — `executeMemberImport` runs the same batch-invitation service as `inviteToOrganisation`, so a staff-assisted batch staged there would be the same exposure through another door — and `revokeEnrolmentToken` is on it because revoking is not preparing and rested on no decision. What staff hold is reading and two removals, as the `Membership`, `Invitation`, `EnrolmentToken` and `MemberImport` rows of §5 say: `staff_operator` and `staff_support` read memberships (`listMemberships`, `getMembership`, `countMemberships`), invitations (`listInvitations`) and on-site enrolment tokens (`listEnrolmentTokens`); `staff_operator` alone also reads member imports (`listMemberImports`, `getMemberImport`), revokes a pending invitation (`revokeInvitation`) and discards a member import (`deleteMemberImport`); `staff_security` holds none of them. Other `staff_operator` operations reach people without touching those records: activating a federation provider, whose `redirect` mode sends everyone to it (`activateFederationProvider`); disabling one, which returns every federated account to hosted sign-in (`disableFederationProvider`); mailing the domain instruction sheet or the federation runbook to a named person (`shareDomainInstructions`, `shareFederationRunbook`); and recording the intended owner at intake (`intended_owner` on `createOrganisation`). No staff role creates a membership in a customer organisation, invites anyone, prepares an on-site enrolment token or a member import, changes a customer's role, or grants itself a membership. The customer's recorded instruction for assisted onboarding is therefore not a field of these operations: none of them adds anyone, and the instruction reference belongs to the intake of the next note.
- **Assisted onboarding is the intake protocol, and the customer claims ownership.** Staff-assisted intake creates a non-active organisation — `createOrganisation`, `organisation:create`, `staff_operator` only — with no membership for anyone: the caller does not become `org_owner`, and no staff principal ever holds a customer membership. The intended verified person establishes first ownership through the first-owner claim protocol specified in `internal architecture records` at `plans/complete-mock/FIRST_SLICE_SPEC.md` §P1: the organisation stays `prospect` until the claim is consumed, the claim is bound to one organisation and one intended identity, and consuming it creates the first `org_owner` membership and moves the organisation to `active` in one transaction. Its wire operations are new explicit contracts, not widened permissions on ordinary invitations, and `contracts/core-api.openapi.yaml` carries them: `record_intake` is `createOrganisation` itself (`organisation:create`, `staff_operator`), whose body carries the recorded instruction reference and the intended owner contact and whose transaction enqueues the `realm_create` job; `read_bootstrap_status` is `getOrganisationBootstrap` (`organisation_bootstrap:read`, staff and `bootstrap`), a secret-free view over the realm, the identity binding and the claim; `claim_first_owner` is `consumeOwnerClaim` (`owner_claim:act`, `bootstrap` and `org_owner`), the only operation of the contract that creates an organisation's first owner. Issuing a claim is the worker's act once the identity binding is ready, and revoking or reissuing one is a staff operation the contract does not carry yet; the `OwnerClaim` cell grants `staff_operator` `revoke` now so the `owner_claim.revoked` audit row has a cell behind it when that operation lands. A principal holds `org_owner` only inside an existing organisation, so `createOrganisation` grants it to no tenant role: a grant no principal could ever exercise is not a grant.
- `org_owner` is never granted by invitation, import or shared enrolment. Invitations and imports may grant member or admin, plus billing when the caller is an owner; shared on-site enrolment always grants `org_member`.
- Removing the last `org_owner` is `409 last-owner-protected` ([`CONVENTIONS.md`](CONVENTIONS.md) §6).
- Accepting one's own invitation creates a `Membership` and is allowed to every tenant role, including a person who holds none yet. It is the only `Membership` write that is not an administrative act.

ADR-0010 fixes both closed role sets. A role may have zero current assignees; the role model does not assign an unconfirmed crew responsibility.

## 5. Scope and role matrix

Read as: what each role may do to each resource. `own` means "rows belonging to the caller's organisation" (§6). Blank means no access — the response is `404` or `403` per §6.

| Resource | `org_owner` | `org_admin` | `org_billing` | `org_member` | `staff_operator` | `staff_support` | `staff_security` | `agent` |
|---|---|---|---|---|---|---|---|---|
| `Organisation` | read, update own | read, update own | read own | read own | create (intake), read, update all | read all | read all | — |
| `OrganisationBootstrap` | — | — | — | — | read all | read all | — | — |
| `OwnerClaim` | — | — | — | — | read, revoke all | read all | — | — |
| `Identity` | read, update self | read, update self | read, update self | read, update self | read all, update self | read all, update self | read, update self | — |
| `Membership` | create, read, update role, delete own | create, read, update role, delete own (members and admins only) | — | read own | read all | read all | — | — |
| `Invitation` | full own | full own | — | — | read, revoke all | read all | — | — |
| `EnrolmentToken` | create, read, revoke own | create, read, revoke own | — | — | read all | read all | — | — |
| `Contact` | full own | full own | — | read own | read all | read all | — | — |
| `DpaAcceptance` | create, read own | read own | read own | read own | read all | read all | — | — |
| `Plan`, `Pack`, `CapacityTier`, `Price`, `LegalDocument` | read (public catalogue) | read | read | read | read, create, deprecate | read | — | — |
| `Order` | create, read, act own (cancel unpaid) | read own | read own | — | read all | read all | — | — |
| `Subscription` | read, request change own | read own | read own | — | full all | read all | — | — |
| `Invoice`, `InvoiceLine`, `CreditNote` | read own | read own | read own | — | read all, issue credit note | read all | — | — |
| `Payment`, `PaymentLink` | read own, create link own | read own | read own, create link own | — | read all, reconcile | read all | — | — |
| `Tenant` | read own, order, create own, request action own | read own, request action own | read own | read own | full all | read all | — | read self |
| `Host`, `Ip` | — | — | — | — | read all | read all | read all | read self |
| `Domain` | full own | full own | — | read own | full all | read all | — | read self |
| `Release` | read | read | — | read | full | read | — | — |
| `TenantRelease` | read own | read own | — | read own | full all | read all | — | read self |
| `Backup` | read own, request restore own | read own | — | — | full all | read all | — | report self |
| `Probe`, `StatusComponent` | read own | read own | read own | read own | full all | read all | — | — |
| `Incident` | read own | read own | read own | read own | read all | read all | — | — |
| `MaintenanceWindow` | update own | update own | — | read own | full all | read all | — | read self |
| `Secret` | — | — | — | — | rotate (never read) | — | — | pull own by reference |
| `Agent` | read own | read own | — | — | full all | read all | — | read self |
| `Job`, `JobStep` | read own | read own | — | read own | full all | read all | read all | read self |
| `AuditEvent` | read own, export own | read own | — | — | read all | read all | read all | — |
| `SupportTicket`, `SupportTicketLink` | full own | full own | full own | create, read, reply own | create, read, update all | create, read, update all | — | — |
| `Export`, `DeletionCertificate` | request, read own | read own | — | — | full all | read all | — | — |
| `Notification` | read, create self | read, create self | read, create self | read, create self | read all | read all | — | — |
| `Entitlement` | read own | read own | read own | read own | read all | read all | — | — |
| `MemberImport` | full own | full own | — | — | read, delete all | — | — | — |
| `FederationProvider` | full own | full own | — | read own | full all | read all | — | — |
| `FederationTest` | create, read own | create, read own | — | read own | full all | read all | — | — |
| `WorkspaceModeration` | read, act own | read, act own | read, act own (moderator grant) | read, act own (moderator grant) | — | — | — | — |
| `WorkspaceReport` | full own | full own | create, read, update own (queue requires moderator grant) | create, read, update own (queue requires moderator grant) | — | — | — | — |
| `WorkspaceInviteLink` | full own | full own | read, act own (preview and redeem only) | read, act own (preview and redeem only) | — | — | — | — |
| `WorkspaceAttachment` | full own | full own | full own | full own | — | — | — | — |
| `WorkspaceUnfurl` | create own | create own | create own | create own | — | — | — | — |
| `WorkspaceDocument` | full own | full own | full own | full own | — | — | — | — |
| `WorkspaceSearch` | read own | read own | read own | read own | — | — | — | — |
| `PushSubscription` | read, update, delete self | read, update, delete self | read, update, delete self | read, update, delete self | — | — | — | — |
| `Workspace`, `Category`, `Channel` | read own, create own, update own, delete own, act own (initialise, archive) | read own, create own, update own, delete own, act own (initialise, archive) | read own | read own | — | — | — | — |

Rules that override the table:

- **No principal ever reads a `Secret` value.** `staff_operator` may enqueue `rotate_secret`; the agent pulls by `config_ref` over its own authenticated channel and renders locally (strategy Appendix A). The API returns metadata only: name, version, `rotated_at`, `kek_id`.
- **"request action"** means creating a job through an action sub-resource, not executing it. At launch, `provision`, `upgrade`, `restore`, `decommission` and `delete` are `staff_operator`-only; the tenant-side request creates a `SupportTicketLink` and a pending job request instead. Which kinds become self-service is a row in [`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md), not a code change here.
- **`staff_support` never mutates infrastructure.** Its writes are the three support-ticket operations the contract grants it — `createSupportTicket` (`support_ticket:create`), `replyToTicket` and `attachToTicket` (`support_ticket:update`) — plus `SupportTicketLink` and its own profile (`patchMe`).
- **The matrix has no `anonymous`, `invited` or `bootstrap` column, and does not need one.** `anonymous` reaches only rows a section of [`../domain/MODEL.md`](../domain/MODEL.md) declares global — `Plan`, `Pack`, `CapacityTier`, `Price`, `LegalDocument`, and an `Incident` whose `scope` is `platform` — plus the status page (`Probe`, `StatusComponent`), realm discovery and the sign-in problem report, which exist precisely for people who cannot authenticate. The check named under the extension table refuses `anonymous` on any other resource, and on any operation of the `Organisation` and `SupportTicket` rows other than those two: realm discovery and the sign-in problem report are allowed by operation id, never by widening their rows. `invited` reaches two operations, `POST /invitations/accept` and its read-only preview `POST /invitations/preview`, and its authorisation is the invitation token rather than a cell of this table: a person accepting an invitation holds no row here yet, which is what they are about to create. `bootstrap` reaches two, `GET /organisations/{organisation_id}/bootstrap` and `POST /owner-claims/actions/consume`, and its authorisation is the identity binding the worker recorded plus the claim token, on the organisation its `iss` resolves to and no other (§6). The `OrganisationBootstrap` and `OwnerClaim` rows therefore hold staff cells only: the person the rows exist for holds no column, by design. All three are closed lists, all three are declared in `x-kodera-authz`, and a fourth such principal is a change to this document before it is a change to the contract.
- Every write by a staff principal on an organisation's data emits an `AuditEvent` visible to that organisation's `org_owner`.
- **The payment provider's webhook is not a principal of this table.** The route that receives the provider's events is public: it carries no session, no token and no role, and is authorised by the provider's signature over the body alone, verified by the provider's adapter (`apps/billing/payments`) before anything is recorded; it is rate-limited. It reaches only the reconciliation of `../domain/BILLING_MODEL.md` §7, never a resource of this table on behalf of a caller. Owner decision, recorded with contract 0.20.0; the route itself and its contract operation come with automatic collection.
- **Workspace content surfaces (contract 0.43.0).** A moderator is a stored workspace grant on an active organisation membership, not an organisation billing role and never a token claim. Owner/admin memberships hold the moderation grant automatically. Other tenant roles reach moderation, report queues and report resolution only with that grant. A moderator cannot kick, ban or mute an owner/admin. Every moderation mutation is audited. Ordinary members can create reports. Reusable invite links are administered by owners/admins; other tenant roles may only preview and redeem them. Redemption verifies the bound identity and email, serializes the usage counter, and checks expiry and revocation. Documents, backlinks, search and attachments enforce current workspace visibility on each request; only editors can mutate documents or send collaboration state. Document deletion and tickets follow the same policy. Push subscriptions and notification read markers are scoped to the current subject/device. Push wakeups contain no payload. The Notification create verb denotes marking selected existing entries read, never client creation of notifications. These contract declarations remain Proposed until their separate runtime lanes pass acceptance.
- **The workspace row is structure, never content, and its `read` is filtered by channel policy.** `read own` on `Workspace`, `Category` and `Channel` is `getWorkspace`: the categories and channels the caller's current membership may view under their resolved resource policy, filtered server-side by §6 rule 8; no role reads a message, a file or an occupancy through this row. `act own` is `initialiseWorkspace`, which creates the starter template once and nothing else ([`../specs/PILOT_WORKSPACE_ONBOARDING.md`](../specs/PILOT_WORKSPACE_ONBOARDING.md)), and `archiveChannel` and `unarchiveChannel`. Administering structure is `org_owner`'s and `org_admin`'s alone ([`../specs/ESPACE_STRUCTURE.md`](../specs/ESPACE_STRUCTURE.md)): `create own` is `createCategory` and `createChannel`; `update own` is `patchCategory`, `patchChannel` and `patchChannelAccess`; `delete own` is `deleteCategory`, of an empty category only, and no operation deletes a channel; and their `read own` also covers `getWorkspaceAdministration` and `getChannelAccess`, the administrative disclosure of §6 rule 8. Every one of those writes needs an `active` organisation (§2 step 8). Staff hold no cell: a customer's channel names are the customer's, and support works from what the customer shows it.
- **`create own` on `Tenant` is `createTenant`, and only on a deployment that does not bill.** It is the owner's one step to a workspace there ([`../specs/QUICK_WORKSPACE.md`](../specs/QUICK_WORKSPACE.md) §4): the tenant, the acceptance of the CGV and the DPA for it, and the starter workspace. It accepts the customer's agreements, so it is `org_owner`'s alone, as `placeOrder` is; staff hold no part of it although `staff_operator`'s cell is `full all`. On a deployment that bills a tenant is ordered (`order`), and `createTenant` answers `409 billing-enabled`.

### Two extensions, because they answer two questions

Every operation in `contracts/core-api.openapi.yaml` declares **both** of these, and neither substitutes for the other:

| Extension | Shape | Question it answers |
|---|---|---|
| `x-kodera-scope` | `<resource>:<verb>`, one value | *What is being touched?* The row of the table above, and the verb applied to it |
| `x-kodera-authz` | `{roles: [...]}` | *Who may touch it?* The roles that hold that cell, taken from the same row |

They are not the same statement. A scope is a fact about the endpoint that survives every change of the role set: `POST /domains/{id}/actions/verify` is `domain:act` whether three roles hold it or seven. Roles are product decisions even though ADR-0010 now fixes the v1 set. Collapsing the two into a single extension would mean re-deriving the resource being touched from the role list, which is not recoverable, or freezing the role list into the permission layer, which is what makes a role change a code change.

The permission layer is specified deny-by-default in both directions: a view without a declared scope is to raise at import time, and a request whose principal holds no role listed for the operation is to be refused before any queryset is built. Neither is built yet; what exists is said below. **A missing declaration fails the contract check rather than defaulting open.** The contract half of that cross-product is enforced, by `scripts/ci/check-authz-matrix.py`, run by the `authz-matrix` job of `.github/workflows/ci.yml` (`make authz` locally): for every operation of `contracts/core-api.openapi.yaml` it asserts that both extensions are present, that the `x-kodera-scope` resource is a row of the table above and its verb a member of the closed set below, and that every role in `x-kodera-authz` holds that verb in that row. An operation MAY be narrower than its cell — `listOrganisations` is the fleet-wide list and is staff-only although every tenant role reads its own organisation — and MUST NOT be wider. `anonymous` is accepted only where the rule above places it: on the global rows and the status page by resource, and on realm discovery (`discoverRealm`) and the sign-in problem report (`reportSignInProblem`) by operation id, so `anonymous` on any other operation of the `Organisation` or `SupportTicket` rows is refused; `invited` is accepted only on `acceptInvitation` and `previewInvitation`, whose role set is the §4 override and is checked against the sentence that states it (the preview's role set is wider than the `invitation:read` cell it shares with `listInvitations`, so the permission layer, once built, grants these two by operation id, never by scope), and `bootstrap` only on the two operations §4 names, checked against the sentence that names them; `consumeOwnerClaim` is the second override, `bootstrap` plus `org_owner`, checked the same way. The check refuses rather than skips: an unknown grant phrase in a cell, a matrix row it cannot read and a role that is not a column are each a red job, never an uncounted input. Its self-test, `scripts/ci/check-authz-matrix.selftest.sh`, runs in the same job and proves each of those refusals by the message that names it. The view-level declaration is enforced by `tests/architecture/test_view_scopes.py`, in the `Tests` job: every view a URL pattern reaches declares, with `core.api.scopes.declares`, an `Operation` per HTTP method it serves (by convention defined in its application's `api/permissions.py`, which the test does not check), and the test fails on a view with no declaration, on a scope that is not a row and verb of this section, and on a scope, method or path that differs from the operation's in the contract (`../dev/PROJECT_LAYOUT.md` §2). Its only exemption is a closed list of routes, the two `core/health.py` probes at `health/live` and `health/ready`, which have no principal. The declaration carries no roles: that a view admits only the roles of its operation's `x-kodera-authz` is not tested. Nor are the methods a plain function view handles, nor a method a decorator above the declaration adds; `../dev/PROJECT_LAYOUT.md` §2 lists everything the test does not see, and the reviewer checks those by hand (§10). The rest of the runtime half — the import-time raise and a permission layer that refuses a request on the declared scope — is specified here and not yet built: until it is, that a view enforces what it declares is a rule a reviewer applies by hand (§10).

### Verbs

The verb set is closed. A scope with a verb outside it fails the same test.

| Verb | Method it usually maps to | Meaning |
|---|---|---|
| `read` | `GET` | Read a resource or a collection, including a derived view over it |
| `create` | `POST` | Create a resource the caller can then address |
| `update` | `PATCH` | Change a resource in place, under `If-Match` ([`CONVENTIONS.md`](CONVENTIONS.md) §10) |
| `delete` | `DELETE` | Soft-delete |
| `act` | `POST .../actions/<verb>` | An action sub-resource. Usually "request action" in the sense of the table above — create a `Job`, never execute one — but the verb names the shape of the endpoint, not the presence of a job: three actions (`resendInvitation`, `executeMemberImport`, and the two share endpoints) mutate no infrastructure and answer `200`. Binding the scope to whether a job exists would mean a scope that changes when an implementation does |
| `export` | `POST`, `GET` | Produce or collect a customer export ([`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md) §6) |
| `rotate` | `POST` | Rotate a `Secret` without ever reading its value |
| `report` | `POST` on `/agent/v1/` | An agent reporting its own tenant's reality |

`export`, `rotate` and `report` have no Core API operation yet; they are in the set because the table above grants them and a verb invented later at the endpoint is a verb nobody reviewed.

The Agent API declares no `x-kodera-scope` at all, and that is deliberate rather than an omission: §7 makes the agent a separate authenticator with **no scope on any Core API resource**. Giving its operations a Core scope would be the first step towards a code path where one authenticator's principal satisfies the other's check.

## 6. Object-level rules

Role checks are necessary and never sufficient. Every query is additionally constrained:

1. **Organisation scoping.** Every tenant-principal queryset is filtered by `organisation_id = principal.organisation_id` in a single shared manager. A pull request that writes `.objects.all()` in a view, or filters by an organisation id taken from the request, is rejected; the identifier comes from the verified token only.
2. **Tenant scoping for agents.** An agent principal is bound to one `Agent` row, which is bound to one `Tenant`. Its queryset is `tenant_id = principal.agent.tenant_id`, and it may write only heartbeat, vitals, command results and backup reports. An agent may never read another tenant's row, and never reads billing, membership or audit data.
3. **Existence disclosure.** For resources whose identifiers are globally guessable (slugs) the response is `404` when the row exists but belongs to another organisation. For UUIDv7-keyed resources it is also `404`. `403` is returned only when the row is visible to the principal but the verb is not allowed. The choice is declared per resource in the OpenAPI file so it is testable.
4. **Cross-organisation references.** Creating a row that points at another organisation's row (a `Subscription` on someone else's `Tenant`, a `Domain` on someone else's tenant) is `422 validation-error`, never `403`, because the reference is invalid rather than forbidden.
5. **Self-service ceilings.** Object-level rules also carry plan limits: number of tenants, custom domains per tenant, seats. Exceeding one is `409 quota-exceeded`.
6. **Deleted rows.** Soft-deleted rows (`deleted_at` set) are invisible to every principal except `staff_operator` reading through an explicit `include_deleted=true` filter, which is itself audited.
7. **Bootstrap scoping.** A `bootstrap` principal's organisation is the one its `iss` resolves to, as for any tenant principal; `getOrganisationBootstrap` on any other `organisation_id` is `404`, and a claim token that resolves to another organisation's claim is `404 not-found` on `consumeOwnerClaim`, never `403`, so a claim cannot probe organisations. Within its own organisation, a claim bound to a different `(iss, sub)` is the one declared exception to rule 3 — `403 owner-claim-identity-mismatch` rather than `404` — because the caller is already an authenticated subject of that realm, the token is at least 256 bits of randomness, and the denial is evidence §9 records and alerts on. The binding is `(iss, sub)`, never the email string: two identities with the same address in two realms are two identities.

8. **Workspace visibility.** `getWorkspace` returns a channel only when the caller's current active membership may view it under its resolved policy — the channel's explicit policy, else its category's default, else the workspace default — and a category only when the caller may view a channel created in it under that same resolution, or one of its channels. Explicit denies win; no role, `org_owner` included, bypasses a restricted channel by holding structural authority. A channel the caller may not view is absent from the answer, never redacted, so its existence is not disclosed (rule 3). The evaluator is the pure kernel of [`../specs/workspace-policy-projection.md`](../specs/workspace-policy-projection.md) on the `channel.view` action, over facts read in one snapshot ([`../specs/workspace-member-parent-policy.md`](../specs/workspace-member-parent-policy.md)); its projection gate does not apply to this read, because Core is the system of record for the structure it serves. **Administrative disclosure** (zôÖma, contract 0.22.0, [`../specs/ESPACE_STRUCTURE.md`](../specs/ESPACE_STRUCTURE.md) §2.1): `getWorkspaceAdministration` and `getChannelAccess` disclose to the organisation's `org_owner` and `org_admin` the name, topic, kind, position, lifecycle and access of every channel, restricted ones included, and never a message, a file, an occupancy or any room content. An owner or admin who grants themselves a channel they could not view does so through `patchChannelAccess`; the grant is audited, and the tenant agent posts a visible notice in that channel, so its members know who joined as an administrator.

## 7. Agent authentication

The agent is a **separate authenticator**, mounted only on `/agent/v1/` and never on `/api/v1/`. The two authenticators share no code path, so a bug in one cannot promote a principal in the other. Both are always enabled; a tenant uses one of them, recorded on `Agent.auth_method`.

**Preferred: mTLS.** The edge terminates TLS with a client-certificate request against the Kodera agent CA. The verified certificate's subject carries the tenant slug and the agent's UUIDv7; the API reads them from the proxy's verification result headers, which the edge overwrites unconditionally on every request. The certificate fingerprint MUST match `Agent.fingerprint`; a mismatch is `401` and raises an alert, because a valid certificate for the wrong agent means a stolen key.

**Fallback: per-tenant bearer token.** A 256-bit random token, stored as `argon2id(token)` on `Agent.token_hash`, presented as `Authorization: Bearer`. Used where terminating client certificates is impractical. Rotated by the `rotate_secret` job; the previous hash stays valid for one hour to make rotation non-disruptive, then is dropped.

Common rules for both:

- **Enrolment.** The worker creates the `Agent` row with a one-time `enrolment_token` (72-hour expiry, single use) during `provision`. First contact exchanges it for the certificate or bearer token and records `fingerprint`. A second use of a spent enrolment token is `401` and an alert.
- **Replay protection.** Every heartbeat carries a `boot_id` and a `seq` that is monotonic **within one `boot_id`**. `seq` restarts at zero when the agent process restarts — a reboot, a `self_update` — and `boot_id` changes at the same instant. Core orders by `(boot_id, seq)` and decides on that pair alone:

  | Case | Answer | Why |
  |---|---|---|
  | Same `boot_id`, `seq` ≤ the highest seen for it | `200`, accepted and discarded, counted | An ordinary retried or duplicated delivery. A network retry must not cost a tenant its agent |
  | New `boot_id`, any `seq` | `200`, accepted, the counter restarts | The reboot case. A restarted agent legitimately begins again at zero, and a rule that reads that as a regression breaks every reboot |
  | Same `boot_id`, `seq` goes backwards **after a higher `seq` was accepted for that same `boot_id`** | `409 seq-regression`, and the agent stops and waits for re-enrolment | The only case a reboot cannot explain: one `boot_id` cannot run its counter backwards. It is a replayed capture, a cloned VM or a duplicated credential, and retrying is exactly the wrong response |

  A `409` is therefore evidence, not backpressure. A large backward jump inside the third case raises an alert on top of the audit row, and `agent.replay_detected` is written whichever of the three the request falls into when the `seq` was already seen. Command results are idempotent by `command_id`.
- **Liveness.** `Agent.last_seen` is updated on every accepted heartbeat. Three consecutive misses set the `stale` flag — a flag, never a `Tenant.status` ([`../domain/TENANT_STATE_MACHINE.md`](../domain/TENANT_STATE_MACHINE.md)).
- **The agent cannot escalate.** It has no scope on any Core API resource, cannot create jobs, cannot read secrets' values, and cannot change its own tenant's status, plan or subscription.
- Agent traffic is rate-limited per tenant (§11 of [`CONVENTIONS.md`](CONVENTIONS.md)) and exempted from the IP bucket.

## 8. Sessions and lifetimes

| Item | Value | Where enforced |
|---|---|---|
| Access token | 5 minutes | Keycloak client (`meet`, `docs`, `console`) |
| Refresh token, tenant user | 8 hours idle, 24 hours absolute | Keycloak realm SSO settings |
| Refresh token, staff | 4 hours idle, 12 hours absolute | `kodera-staff` realm |
| Console session | tied to the refresh token; no server-side session in the API | Console |
| JWKS cache | 10 minutes positive, 30 seconds negative | API |
| Idempotency replay cache | 24 hours | API |
| Invitation | 14 days, single use | Core |
| Owner claim | single use, bound to one organisation and one identity; lifetime **proposed** at 72 hours by `FIRST_SLICE_SPEC.md` §P1 and recorded there as a security decision not yet taken — the wire carries `expires_at` and fixes no number | Core |
| Enrolment token (person, on-site) | 72 hours, single use, then a passkey | Keycloak / Core |
| Enrolment token (agent) | 72 hours, single use | Core |
| Agent bearer token | rotated on demand; one-hour overlap | Core |
| Agent client certificate | 90 days, renewed by the agent at two-thirds of life — day 60 | Agent CA |
| SSH certificate (worker → tenant) | ≤ 8 hours, per-tenant principal | Worker, ADR-0003 |

The API is stateless: it holds no session store, and logging out is a Keycloak concern. Revocation is immediate for anything the database decides (membership, organisation status, agent row) and bounded by the access-token lifetime for anything the token decides.

## 9. Audit of denials

Authorisation failures are evidence, so they are recorded, not only logged.

- **Recorded as `AuditEvent`** with `action: authz.denied`: every `403` on a mutating verb other than `identity-unknown`, which names no principal, every staff read of another organisation's data that was refused, every agent authentication failure, every `401` caused by a known-but-invalid credential (bad fingerprint, spent enrolment token, replayed `seq`), and every refusal of `consumeOwnerClaim` — a spent, expired, revoked, altered or mis-bound owner claim — whatever its status code, with the claim's state as the `reason`.
- **Logged but not recorded**: anonymous `401`s with no resolvable principal, `403 identity-unknown`s, whose verified subject resolves no principal either, and rate-limit `429`s. A `403 identity-unknown` logs one WARNING line naming the event, a fresh server-generated correlation id and the operation id (`core/api/problems.py`), never the issuer, the subject, an email, the token or the caller's `X-Request-Id`; the `authz_denied_total` counter is owed ([`../dev/OBSERVABILITY.md`](../dev/OBSERVABILITY.md)).
- Denial events carry `request_id`, `actor` (or `unknown`), `target` URN, `required_scope`, and the `reason` code. They carry **no** token, no header, and no request body.
- Retention follows the split in [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md): 12 months pseudonymised for authentication and authorisation events, 7 days for anything carrying an end-user IP address.
- Alerts: more than 20 `authz.denied` for one principal in 5 minutes; any agent fingerprint mismatch; any spent-enrolment-token reuse; any presentation of a consumed or revoked owner claim, or of a claim bound to another identity; any `iss` failing verification that resolves to a known organisation.

## 10. What a reviewer checks

- [ ] The realm comes from `iss` and from nowhere else; no code path reads a realm, organisation or tenant identifier from a request body, query parameter or header for authorisation.
- [ ] Roles are read from `Membership`, not from the token.
- [ ] The operation declares **both** `x-kodera-scope` and `x-kodera-authz` in the contract; the scope names a row of the matrix in §5 and a verb from its closed set, and the roles are the ones that hold that cell. The view declares the scope with `core.api.scopes.declares`; its declaration carries no roles. The `authz-matrix` job proves this for the contract, and `tests/architecture/test_view_scopes.py` proves that the view declares the contract's scope; the reviewer proves the view enforces that scope and admits only the operation's roles, which no test links to the view.
- [ ] The queryset is organisation- or tenant-scoped by the shared manager, not by an ad-hoc filter.
- [ ] Nothing returns a `Secret` value; nothing gives an agent a Core API scope.
- [ ] New denial paths emit `authz.denied` or a counted metric, and a test proves the denial.
- [ ] Any new lifetime is added to the table in §8.
- [ ] No operation names `bootstrap` beyond the two §4 lists, and nothing but `consumeOwnerClaim` creates a `Membership` with `role: org_owner` in an organisation that has none. The authorisation-matrix steps of the `lint` CI job prove the first for the contract; the reviewer proves both for the view.

## Changelog

- First version. Fixes assessment item C2: per-issuer JWKS caching and the `iss` → organisation rule, the staff realm with enforced MFA, the closed role set with a resource matrix, object-level scoping, the separate agent authenticator with enrolment and replay rules, session and token lifetimes, and the audit of denials.
- Records the two-extension design the contract needs: `x-kodera-scope` carries the `<resource>:<verb>` of the §5 matrix and `x-kodera-authz` carries the roles, because the resource being touched and the roles allowed to touch it are two statements and only one of them moves with a product decision. Adds the closed verb set, seven matrix rows the contract had grown into (`Identity`, `Order`, `Incident`, `Entitlement`, `MemberImport`, `FederationProvider`, `FederationTest`) and the provisional `org_billing` and `staff_security` columns. Makes the agent certificate's renewal point explicit at day 60 of 90.
- States the `(boot_id, seq)` heartbeat rule in §7 so an ordinary network retry, a reboot and a genuine replay get three different answers instead of one `409` that stops an agent on a dropped packet.
- Adds `anonymous` and `invited` to §4 as declared principals that are **not** `Membership.role` values, with a §5 note saying why neither needs a column: the contract had been declaring `anonymous` on nine operations against a table that did not contain the word, and a person accepting an invitation holds no row in the table at all. Widens the `act` verb to name the shape of an action sub-resource rather than the presence of a job, so a scope does not change when an implementation does.
- Rewrites the `invited` row to say what the contract does: `POST /invitations/accept` names the four organisation roles beside `invited`, so a second click on an invitation link is answered `409 conflict` rather than `403 forbidden`. The previous wording claimed the operation was unreachable to every other role, which the contract contradicts.
- Aligns §2 with ADR-0006: the realm belongs to the organisation, not to the tenant, so §2 counts customer realms and resolves `iss` to an organisation. No verification step changes.
- Applies ADR-0010: `org_billing` and `staff_security` are fixed
  least-privilege roles, owners control sensitive active membership changes,
  and staff assistance cannot mutate an active customer role.
- States the recorded-customer-instruction constraint as what it is: a contract
  fact with nothing behind it. No request field, header, audit action or problem
  type records an instruction, so the sentence is written as an open item rather
  than as a control. Counts the operations it leaves unbounded as **five** rather
  than three: `createMemberImport` and `executeMemberImport` reach the same
  batch-invitation service as `inviteToOrganisation`, so the enumeration now names
  `member_import:create` and `member_import:act` beside the three invitation and
  enrolment scopes, and names `member_import:update` as the mapping step that
  chooses the role. Records, without settling, that §5's `Invitation` and
  `EnrolmentToken` cells are narrower than the operations the contract grants
  `staff_operator` — four operations, named with their scopes, and a separate
  count from the five above — and that no check in this repository compares
  `x-kodera-authz` against the matrix, which is why the two drifted unnoticed.
- Applies the owner's two decisions on staff and customer identity, and ships the check that keeps this
  matrix and the contract from drifting again. Narrows the contract: no staff role holds
  `inviteToOrganisation`, `resendInvitation`, `createEnrolmentToken`, `revokeEnrolmentToken`,
  `createMemberImport`, `patchMemberImport`, `executeMemberImport`, `createPaymentLink` or `generateDpa`,
  and `generateDpa` drops `org_admin` because `acceptDpa` shares its scope and the DPA is the owner's
  contract. Replaces the caller-becomes-owner reading of `createOrganisation` with staff intake of a
  non-active organisation and the first-owner claim protocol of `deployment operations`
  `plans/complete-mock/FIRST_SLICE_SPEC.md` §P1. Widens tenant cells to what the contract already
  granted and this matrix had not: `org_admin` `update own` on `Organisation`, `read own` for owner and
  admin on `Membership` and `EnrolmentToken`, `update self` for `staff_support` and `staff_security` on
  `Identity`; gives `staff_operator` `create` on `Organisation` for intake and narrows it to
  `read, delete all` on `MemberImport`. Replaces the two §4 notes that left the question to the owner
  with the decision. Names the status page in the `anonymous` rule, which §4 already listed and the
  contract already used, and keys realm discovery and the sign-in problem report by operation. States under the extension table that `scripts/ci/check-authz-matrix.py`
  enforces the extension rule in CI, with a self-test that proves each refusal by message.
- Carries the first-owner claim protocol of `FIRST_SLICE_SPEC.md` §P1 into the contract. Declares
  the `bootstrap` principal in §1 and §4 beside `invited` and `anonymous` — an authenticated
  subject of a customer realm the identity worker bound as the intended owner, holding no
  `Membership`, reaching exactly two operations — with the sentence the cross-check verifies, and a
  second §4 override for `consumeOwnerClaim` naming `org_owner` so a replay after the claim is
  answered rather than refused. Adds the `OrganisationBootstrap` and `OwnerClaim` rows to §5 with
  staff cells only, the `prospect` exception to §2 step 8, the bootstrap scoping rule and the one
  declared `403`-over-`404` case in §6, the owner claim in §8 as a proposed lifetime rather than a
  number, and claim refusals in §9's recorded denials and alerts.
- `staff_operator` loses `create` on `Order`, so `placeOrder` is `org_owner` only: the order carries
  the customer's DPA acceptance, and staff never accept on the customer's behalf
  (`FIRST_SLICE_SPEC.md` §P1 step 6).
- Aligns §4 and §5 with ADR-0010 as the product owner clarified it. §4 no longer says staff hold no
  operation reaching a customer organisation's people: they read memberships, invitations and
  on-site enrolment tokens, `staff_operator` also reads member imports, revokes a pending invitation
  and discards a member import, and no staff role adds anyone; `org_admin` moves a role only between
  `org_admin` and `org_member`. §5's `SupportTicket` row gives both staff roles `create, read,
  update all` instead of `full all`, which is what the contract grants, and the `staff_support` rule
  names its three ticket writes and its own profile. §4's role table says the same of `staff_support`, and
  no longer says `staff_security` writes nothing: it holds `patchMe`.
- §4's owner rule gains its removal half, as `removeMembership` states it, and the staff note names the
  two further `staff_operator` operations that reach people: federation activation and the intended
  owner at intake. §5's `staff_support` rule no longer lists acknowledging notifications as a write:
  no operation acknowledges one. The first-owner claim reference points at `internal architecture records`.
- §4's role table says what the contract grants each role: `org_owner`'s contract and payment operations,
  `org_admin`'s people, domain, federation and settings writes, `org_billing`'s reads, payment links and
  ticket work without payment methods or billing contacts, which no operation manages, `org_member`'s
  ticket writes and own profile instead of "no mutation", and `staff_operator` as the only role that runs
  tenant lifecycle jobs. The owner rule says who changes or removes which membership and that no one
  changes or removes their own; the staff note names every further `staff_operator` operation that
  reaches people.
- §4's role table: the `staff_operator` row's "only" now covers `triggerTenantJob`,
  `createAgentEnrolmentToken` and `createOrganisation` alone, and says which roles share its other
  grants. The Granted-by cells name the operations that grant each tenant role: an admin grants
  `org_admin` and `org_member` as well as an owner, and only an owner grants `org_billing`. The
  `org_owner` row names `consumeOwnerClaim`. Two earlier bullets of this changelog are superseded: the
  one that says the staff note names "the two further `staff_operator` operations that reach people"
  undercounted them, and the staff note has named all five since the change recorded by the bullet that
  follows that one; and the one that calls `staff_operator` "the only role that runs tenant lifecycle
  jobs" described a row whose later items also read as operator-only, for grants other roles share.
- §4's role table: the `staff_operator` row places reading member imports (`listMemberImports`,
  `getMemberImport`) with `org_owner` and `org_admin`, not with `staff_support`, which holds neither.
- §5 and §10: the view-level declaration of a scope is tested, by `tests/architecture/test_view_scopes.py` against this matrix and the contract, except what `../dev/PROJECT_LAYOUT.md` §2 lists as not seen, which a reviewer still checks by hand; the import-time raise and a permission layer that enforces the declared scope are still not built.
- §3 states where a staff identity and its roles are stored: an identity with no organisation, and `StaffRole` grants, which §4 already named as the staff side of the role store.
- §5 gains the `Workspace`, `Category`, `Channel` row for contract 0.13.0: every tenant role reads its own organisation's structure, filtered by channel policy (§6 rule 8), and `org_owner` and `org_admin` act on it to initialise the starter workspace; staff hold no cell. A rule under the matrix says the row is structure, never content, and that structural administration is not granted yet.
- §3: on a staff write, a staff token without a second factor is `403 mfa-required` with `required_amr`, the answer contract 0.14.0 declares (the first staff write, Core #164, builds it), not `403 forbidden`.
- §4's role table: the three staff rows are granted by a `StaffRole` grant made by an operator command (`../specs/STAFF_IDENTITY.md` §4), as §3 already says, and no longer by a staff realm role, which grants nothing.
- §2 step 8 names the one exception to the suspended organisation's `402`/`403`: `initialiseWorkspace` answers `409 invalid-state-transition`, `allowed_states: [active]`.
- §5's `Order` row gives `org_owner` `act own` for contract 0.20.0's `cancelOrder` (`order:act`), the owner's cancellation of an order not yet paid. A rule under the matrix records the owner's decision on the payment provider's webhook: public, signature-verified, rate-limited, no session. §2 step 8: a `suspended` organisation may also cancel an order not yet paid.
- §6 rule 8 gains the administrative disclosure decided by zôÖma for contract 0.22.0: owners and admins see every channel's structure and access, never its content; a self-grant is audited and announced in the channel by a visible notice.
- §5's `Workspace`, `Category`, `Channel` row gives `org_owner` and `org_admin` `create own`, `update own`, `delete own` and `act own (initialise, archive)` for contract 0.22.0's structure administration (`../specs/ESPACE_STRUCTURE.md`), and the rule under the matrix names each operation those cells hold instead of saying that administration is not granted yet. `org_billing` and `org_member` keep `read own` only.
- §2: a verification failure, steps 1 to 5 and an unknown realm or issuer included, is `401 unauthenticated`; a verified customer token whose subject resolves no enabled identity of an enabled person is `403 identity-unknown` (step 6), as contract 0.28.0 declares, because re-authenticating cannot change the answer. §9 logs that refusal without recording it, as it names no principal; its counter is owed. The `invited` principal on `acceptInvitation` is step 6's named exception. The staff lane is unchanged.
- §2 step 6: one lane guard refuses the staff issuer on the customer lane `401` before customer resolution. §9: the `identity-unknown` log line carries a server-generated correlation id, never the caller's request id, and the false claim that these refusals are counted as metrics is deleted; the counter is owed.
- §5's `Tenant` row gives `org_owner` `create own` for contract 0.35.0's `createTenant` (`tenant:create`), on a deployment that does not bill only; a rule under the matrix says so and that no staff role holds it.
- §2 step 6, §4's `invited` row and §5: `invited` reaches a second operation, `previewInvitation` (`POST /invitations/preview`, contract 0.37.0), the read-only invitation card, with the same five roles as `acceptInvitation` and for the same reason. The override sentence now covers both operations, and the matrix check holds each to it.
- §2 step 5: a customer-lane token must carry, as `azp`, one of the allowed OAuth clients (`KODERA_ALLOWED_OIDC_CLIENT_IDS`, default `console,kodera-ios,kodera-android`, plus `KODERA_CONSOLE_CLIENT_ID` when set); one with none, or another client's, is `401 unauthenticated`. A deployed profile refuses to start when the list resolves to no client.
