# Staff intake and first-owner claim

**Status:** Accepted, ratified for the invited pilot (Core #154) · **Owner:** API seat ·
**Custodian of the identity duties:** the identity operator

This is the Core design of record for one slice: a staff operator records an intake, the intended
owner is bound — by the identity worker in the design, and for the invited pilot by an operator
command (§5.5, §5.6) — and that person claims first ownership. It is derived clause by
clause from `internal architecture records` `plans/complete-mock/FIRST_SLICE_SPEC.md` §P1, whose
steps 1–5 are cited inline as **§P1.1** … **§P1.5**. Step 6 is deliberately out of scope; §9 says
why and states the question its owner must answer first.

The intake, bootstrap status view, workspace read/initialisation, §3.7's staff grants and §6.4's
mail sender are implemented. K7 adds the operator realm commands and `orgs.RealmReadiness`;
owner binding, claim controls and consumption remain unimplemented. See
[`ORGANISATION_INTAKE.md`](ORGANISATION_INTAKE.md),
[`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md),
[`STAFF_IDENTITY.md`](STAFF_IDENTITY.md) and [`OUTBOX_MAIL_SENDER.md`](OUTBOX_MAIL_SENDER.md).
This document specifies behaviour; the original acceptance packet — `dev/first_slice_bootstrap.py`, wired into
`dev/accept_first_slice.py` — drives the intended path through the real settings, the real URL
resolver, the real DRF stack and a real disposable PostgreSQL, and reports `FS-BOOT-01`…`FS-BOOT-05`
and `FS-BOOT-07` as `failed`; the registry also expects `FS-BOOT-06` to fail at its first real-provider
gap. §11 records what each of those
observations does and does not prove. A reviewer should read §11 before believing any other section
is testable today.

## 1. Scope, and what this document is not

In scope: the three reviewed wire operations of `contracts/core-api.openapi.yaml` —
`createOrganisation`, `getOrganisationBootstrap`, `consumeOwnerClaim` — the `bootstrap` principal of
[`../api/AUTHZ.md`](../api/AUTHZ.md) §4, the records they read and write, the transaction and lock
boundaries between them, and the audit evidence each commits.

Out of scope, and not designed around: `placeOrder` and everything downstream of it (§9); claim
issuance and revocation as staff-reachable **wire** operations, which the contract does not carry
yet (`AUTHZ.md` §4) — for the invited pilot they are operator commands in Core (§6.6); the identity
worker's internal steps beyond the state it must publish, and the identity operator's tooling beyond
the references Core records from it (§5.5); the starter workspace, which is a separate step after
the claim (§8.6); and the remaining twenty-six acceptance scenarios.

This document does not authorise implementation until it is ratified. `FIRST_SLICE_SPEC.md`'s
decision table requires zôÖma plus an independent backend/security reviewer to ratify the guarded
protocol, and an identity operator to accept the operational duties, before identity
implementation begins.

**The invited pilot.** zôÖma decided to ratify this protocol for the invited pilot **with an
operator-run realm step**: there is no automated identity worker yet. The clauses marked *pilot*
in §§3, 5, 6 and 8 carry that decision and its five companions — the trust-list rule of §5.4, the
claim delivery and lifetime of §§6.4–6.6, the starter workspace of §8.6, the staff principal of
§3.7 and the ADR-0015 gate of §3.8. Where the decisions disagreed with existing text of this
document or of a document it cites, §10.3 records the conflict and the lead's ruling on it, and
every ruling that departs from `AUTHZ.md`, `JOB_QUEUE.md`, `JOB_CATALOGUE.md`,
`STAFF_IDENTITY.md`, `REALM_DISCOVERY.md`, ADR-0006 or the audit registry is marked **Pilot deviation**
where it applies, each with the one end condition of §10.3. The independent
backend/security review returned *ratify after fixes*; its two blockers and its should-fix items
are applied as the lead ruled them (§10.3). Ratification is complete when the reviewer has accepted
this text, the pilot deviations included, and the identity operator has accepted the duties it
gives them. Until then this document still authorises no
implementation.

## 2. Records

Field-level shapes stay in [`../domain/MODEL.md`](../domain/MODEL.md); this section names only what
the slice adds to or depends on, and the responsibility each carries.

| Record | Responsibility in this slice |
|---|---|
| `Organisation` | Stable id, reserved slug, `status` beginning at `prospect`. Its commercial lifecycle is independent of any tenant's |
| `OrganisationIntake` | The recording staff identity (`recorded_by_identity_id`), the recorded customer instruction reference, the intended owner contact sealed and its masked form, the organisation id and the identity-bootstrap operation id (`bootstrap_job_id`). It carries no membership and no acceptance evidence, and it is never changed after it is written |
| Identity-bootstrap operation | The `realm_create` job of [`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) §2, organisation-scoped: desired realm configuration, intended subject binding, progress, failure or unknown status, and the worker's evidence — for the invited pilot, the identity operator's tooling-run references and the evidence of Core's verify step (§5.5) |
| `StaffRole` | A staff identity's role, one of the closed staff set of `AUTHZ.md` §4, stored in Core and never read from a token ([`STAFF_IDENTITY.md`](STAFF_IDENTITY.md) §2; §3.7) |
| `OwnerClaim` | Organisation, intended identity, token **verifier**, expiry, and claim state. Separate from `Invitation`; no ordinary invitation path reaches it |
| Outbox delivery | A message or user-level identity operation of this slice, which ADR-0004 keeps out of the job model: the logical operation id, the action, the synthetic provider correlation, the attempt and its unresolved outcome. Written in the same transaction as the desired state and the audit event it belongs to. Realm creation is not one: it is the `realm_create` job above, whose `Job` row is its outbox record |
| `AuditEvent` | Append-only. `organisation.intake_recorded`, `identity.bound`, `owner_claim.issued`, `owner_claim.expired`, `owner_claim.revoked`, `owner_claim.consumed`, `owner_claim.confirmed` (pilot), `membership.created`, `organisation.activated`, `authz.denied`, the `realm.*` events of `realm_create`, `job.reconciliation_required` and `job.reconciliation_decided`, the `outbox_delivery.*` events of the claim mail ([`OUTBOX_MAIL_SENDER.md`](OUTBOX_MAIL_SENDER.md) §8, `outbox_delivery.reconciliation_decided` of [`JOB_QUEUE.md`](JOB_QUEUE.md) §7), and `staff_role.granted` and `staff_role.revoked` ([`STAFF_IDENTITY.md`](STAFF_IDENTITY.md) §4) — the closed registry of [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md) §3 |

Two rules about the last two rows, both from `FIRST_SLICE_SPEC.md`'s "Boundaries and proposed
records":

1. The mutable execution projection of a job MUST be a separate relation from the append-only audit
   stream. A job row whose status changes is not an immutable row, and this specification does not
   repeat the baseline's contradictory claim that it is.
2. These responsibilities MAY be fields on existing models where that is coherent. Nothing here
   requires a generic workflow framework, and a reviewer should refuse one that arrives with it.

## 3. Intake — §P1.1

> *"An authenticated staff operator submits an intake with a recorded instruction reference and
> intended owner contact. Validate and reserve the organisation slug atomically."* — §P1.1

`createOrganisation`, `organisation:create`, `staff_operator` only.

**3.1 One transaction.** In one PostgreSQL transaction the API MUST: validate the slug; reserve it;
create the `Organisation` with `status = prospect`; write the `OrganisationIntake` against the
authenticated staff actor; create the `realm_create` identity-bootstrap job, whose `Job` row,
committed here, is the operation's outbox record in ADR-0004's sense, so no separate outbox delivery
is written for it; and write the `organisation.intake_recorded` audit event. All of it commits or
none of it does (§P1.1: *"in one transaction"*). A crash after commit MUST leave a dispatchable
operation, never a half-created organisation.

**3.2 Atomic slug reservation.** "Atomically" MUST mean a unique constraint the database enforces,
not a read-then-write check in application code. Two concurrent intakes for the same slug MUST
resolve to one insert and one `409 slug-taken`; the loser MUST NOT have created an organisation, a
job or an audit row. A `SELECT ... WHERE slug = ...` followed by an `INSERT` is the defect this
clause exists to forbid: it is a race, and under `READ COMMITTED` it is a race that passes its own
test.

The reservation is permanent for a provisioned slug (ADR-0008). `FIRST_SLICE_SPEC.md` §P2 requires
that the same canonical rule validate creation, persistence, discovery and authentication — one
function, called from all four, never four regexes that agree today. See §10.2: the canonical rule
is decided, 5–20 characters, the owner's minimum, and contract 0.11.0 carries it.

**3.3 The API touches no identity provider here.** Realm creation belongs to the worker (ADR-0003;
§P1.2) — for the invited pilot, to the identity operator's tooling, completed in Core by the operator
command of §5.5, which holds no identity-provider credential either. The intake transaction makes no
outbound call at all: an HTTP transaction held open across
an external call is what §P4 forbids, and it is also how a slug reservation ends up committed
against a realm that was never created.

**3.4 It creates no membership.** The caller does not become `org_owner`; no staff principal ever
holds a customer membership (§P1.1: *"No owner membership exists yet"*; §P1.6: *"Staff cannot …
become its owner through intake"*). A request body naming a membership, a role, a DPA or an order
MUST be refused `422 validation-error` by `additionalProperties: false`, not silently ignored.
`org_owner` is not granted here for a second and independent reason: a principal holds that role
only inside an existing organisation, so the grant could never be exercised (`AUTHZ.md` §4).

**3.5 `instruction_ref` is a reference.** A ticket reference of the contract's pattern
`^[A-Z]{2,8}-[0-9]{1,8}$`, such as `SUP-0418`, never the instruction's content: the pattern leaves
no room for an address or a name pasted in clear, and the database refuses any other shape
(`intake_instruction_ref_valid`, Core #164). The intended owner contact is sealed on the intake
record until a `Contact` record exists; only its masked form is readable in clear. Staff assistance
never substitutes for the customer's own acceptance of terms or processing instructions (§P1.1,
§P1.6).

**3.6 Idempotency.** `Idempotency-Key` is the intention key of the intake. A resumed or repeated
submission of the same intake MUST return the same organisation and the same bootstrap — never a
second slug reservation, never a second job (`docs/api/CONVENTIONS.md` §8; §P3).

**3.7 The staff principal — *pilot*.** The staff side of this slice — the intake of §3, and the
operator commands of §§5.5–5.7, 6.4, 6.6 and 8.7 — is acted by a staff principal. Rules 1–4 are the
design of record on `main`, [`STAFF_IDENTITY.md`](STAFF_IDENTITY.md) and `AUTHZ.md` §3; what the
pilot adds is how an operator command builds its principal, the deviation below rule 4.

1. Staff roles are stored in a `StaffRole` table, one row per grant of a role to a staff identity,
   from the closed staff set of `AUTHZ.md` §4 (`STAFF_IDENTITY.md` §2). A role is read from that
   table, never from the token's realm roles, as `Membership.role` is on the tenant side.

   > **Resolved on main:** `AUTHZ.md` §3 and `STAFF_IDENTITY.md` §§2, 5; the database grant is
   > authoritative and token roles are never read. `AUTHZ.md` §4's role table, whose staff rows
   > still said "granted by: staff realm role", is aligned with its §3 by this amendment.

   `StaffRole` rows are written only by the operator commands of `STAFF_IDENTITY.md` §4. The
   first rows come from `bootstrap_staff_roles`, which takes two `--operator <sub> <address>`
   pairs, succeeds only while `StaffRole` holds no row at all, stores the two staff identities
   itself and grants each `staff_operator` in one transaction, audited with the `system` actor and
   reason `bootstrap`. Every later change is `grant_staff_role` or `revoke_staff_role`, each with
   `--staff-identity <acting identity id>`; each refuses when the acting identity is the one whose
   grant changes, and writes `staff_role.granted` or `staff_role.revoked` with the acting identity
   as the actor. A revocation sets `revoked_at` and never deletes the row, so the table is never
   empty again and the bootstrap cannot reopen. These commands are the design of record, not a
   pilot deviation: they end only when an HTTP operation replaces them (`STAFF_IDENTITY.md` §4).

   **Offboarding a staff member** is three acts, done together, none of which stands in for
   another:

   - [ ] `revoke_staff_role` for each of their roles in Core;
   - [ ] their staff-realm account disabled;
   - [ ] their access to every environment's Core database credentials removed.
2. A staff `Identity` is stored **without an organisation**, in the staff realm `kodera-staff`
   (`STAFF_IDENTITY.md` §1): a `StaffRole` row cannot name an identity of any other realm
   (`staffrole_staff_identity_fk`), and a principal is resolved only for the one staff issuer. That
   issuer is one fixed value in Core's settings, `KODERA_STAFF_ISSUER` (`STAFF_IDENTITY.md` §1),
   which must be an issuer of the `staff` lane of `KODERA_AUTH_TRUST`; it is not an entry an
   onboarding edits, and changing it is a reviewed deployment change. A customer-realm token naming
   a staff role is a customer principal, and is refused on every staff operation.
3. Every staff action requires MFA evidence: the verified token's `amr` contains a second factor
   (`AUTHZ.md` §3, `STAFF_IDENTITY.md` §5), whatever the realm's own policy says. A staff HTTP
   action without it is `403 mfa-required`, with `required_amr` (contract 0.14.0,
   `createOrganisation`), and is audited under `authz.denied`.
4. Every staff HTTP action — the intake now, and the staff operations that replace the operator
   commands after the pilot — requires both a verified staff-realm token, which a disabled account
   cannot obtain, and an active `StaffRole` row for the role it needs.

> **Pilot deviation from `AUTHZ.md` §3, `JOB_QUEUE.md` §4, `STAFF_IDENTITY.md` §5 and
> [`MODEL.md`](../domain/MODEL.md) `decided_by_identity_id` (PC-1).** The intake is an HTTP
> operation and follows rules 1–4. The operator commands of §§5.5–5.7, 6.4, 6.6 and 8.7 are not.
> Like the commands of `STAFF_IDENTITY.md` §4, they are not in the API image: they run from a
> checkout of this repository against the target environment's Core database, with
> `--settings config.settings.job_queue` locally, or the separate command-only
> `--settings config.settings.deploy_operator` with explicit deployment inputs, run by the staff member each names — the identity
> operator, or, for `confirm_owner_contact`, the intake recorder — and access to that database's
> credentials is their credential. A command carries no token and so no `amr`. Each takes
> `--staff-identity <acting identity id>`, the id of a stored staff identity, the identifier
> `OrganisationIntake.recorded_by_identity_id` also holds; it refuses, writing nothing, unless that
> identity holds a current `staff_operator` grant, and audits it as the actor.
>
> **The commands' principal.** `resolve_staff_principal` builds a principal only from a verified
> token, calling `StaffPrincipal(...)` raises `TypeError` (`STAFF_IDENTITY.md` §5), and the queue's
> decision functions refuse any other object before they read anything (`validate_principal`,
> `apps/jobs/_decisions.py`). The commands therefore build their principal with a second,
> command-only builder, `staff_principal_for_command(identity_id)`. It reads the current staff
> identity of that id — enabled and not deleted, of an enabled, not deleted person, as
> `current_staff_identity` reads one — whose issuer is `KODERA_STAFF_ISSUER`, refuses with
> `StaffPrincipalError` otherwise, and builds the principal as the resolver does, carrying no role.
> It lives in a module of its own that the API image does not carry, as it carries none of the
> commands (`.dockerignore`, held exact by `tests/test_development_boundary.py`), so no request
> path can reach it. The role is still read where it is used: a decision reads the current
> `staff_operator` grant itself and refuses `role_missing` without it (`JOB_QUEUE.md` §5.4). For
> the pilot, a decision's `decided_by_identity_id` therefore names the identity a command was
> given, not one resolved from a verified staff token. The builder ends with this deviation. The
> change that implements it amends `STAFF_IDENTITY.md` §5, whose resolver is "the only way to build
> a `StaffPrincipal`", and `tests/test_staff_principal.py`, to name this builder, prove its
> refusals, and prove it absent from the image.
>
> **That identity is asserted by database access, not proven.** Whoever holds the database
> credentials can name any staff identity, and the audit row records the name given. Four
> controls compensate, none of which proves the identity:
>
> 1. **Two-person rule.** `bind_intended_owner`, reissue and revoke refuse, writing nothing, when
>    `--staff-identity` equals the identity that recorded the intake
>    (`OrganisationIntake.recorded_by_identity_id`). In the pilot, zôÖma records the intake and the
>    identity operator binds.
> 2. **Keycloak admin events** are enabled on every organisation realm, so the account and realm
>    changes the tooling makes — a credential reset after the binding included — leave the identity
>    provider's own record. Owed by the identity operator before the first pilot organisation.
> 3. **A second record of every command.** Each operator command writes its audit row and also
>    prints a one-line record of what it did — command, organisation, job, claim or delivery, staff
>    identity named, outcome, never an address or a token — to its standard output.
> 4. **The owner's confirmation, out of band** (§8.7): after the claim is consumed, the intake
>    recorder, not the identity operator, confirms with the customer that the customer holds the
>    owner account.
>
> The Keycloak admin events and the command records are shipped to the platform's log service
> (Cockpit); that shipping is owed by the identity operator before the first pilot organisation. **For the pilot the identity operator can still reach those logs**, so they are
> detective records the operator could alter, not a control against the operator; the effective
> control is the recorder's confirmation of §8.7. A write-once log store the operator cannot write
> is an end condition of this deviation.
>
> Device-authorisation staff tokens for the commands, verified by Core's own verifier with `amr`,
> are deferred. This deviation ends when the commands carry such tokens or are replaced by staff
> HTTP operations, and in any case ends when the identity worker ships or before the first paying
> customer, whichever comes first (§10.3).

**3.8 Where intake may run — *pilot*.** ADR-0015 forbids any organisation row on a live Core
database before its cutover, because `Organisation.issuer` is immutable and its host is the one
ADR-0015 changes. `createOrganisation`, and every operator command of this document, therefore runs
on a given database only after **that database's** ADR-0015 cutover: on staging after the staging
cutover (ADR-0015 step 4), on production after the production cutover (step 7), and in each case
only once that cutover is **declared final, with no rollback pending**: ADR-0015 allows a cutover
to be rolled back until its step 8, and a row written before then would carry an issuer the
rollback changes and the schema forbids changing. Local and
disposable databases are not live and are not gated. Code implementing this document may merge
before either cutover; nothing of it runs against a live database first.

The gate is one setting. The intake's route answers `503 intake-closed` unless
`KODERA_INTAKE_ADMITTED` is `1`, which the identity operator, who runs the cutover, sets when
declaring that database's cutover final in a run note
(`ORGANISATION_INTAKE.md` §1 step 3, Core #164). Every operator command of this document reads the
same setting and refuses, writing nothing, while it is not `1`. In Core #164 only the API's profile
(`config.settings.customer_http`) reads `KODERA_INTAKE_ADMITTED` and `KODERA_CONTACT_SEAL_KEY`;
the operator profile the commands run under (`config.settings.job_queue`, or its deployed
successor) must read both too, with the same contact key value as the API, and the change that
implements these commands adds them there. A second limit holds today:
`config.settings.job_queue`, the local profile the commands run under, builds on the local database
profile and refuses any database but a local one ([`OUTBOX_MAIL_SENDER.md`](OUTBOX_MAIL_SENDER.md)
§7.5). `config.settings.deploy_operator` supplies a separate fixed command-only settings graph,
with the same cutover/contact/trust inputs and no local fallback or HTTP entrypoint. It is excluded
from the API image. Its hermetic settings/command/migration-graph acceptance does not supply an
operator artifact, database grants, applied schema, mail delivery or genuine journey qualification.
Those operational prerequisites remain owed; the pilot cannot run on staging or production without
them. The operator graph adds outbox support to the already migrated shared Core database; it does
not replace the API graph. Generic delivery requires the schema/rights used by every due template,
including the billing-order locking read for order confirmations. See
[`HOST_MIGRATIONS.md`](../dev/HOST_MIGRATIONS.md#separate-operator-profile-and-checkout-artifact)
for the separate proposed artifact/migration procedure and its limits. Until
Core has a deployed server, the identity operator runs the commands from their own workstation,
through a tunnel to the environment's Core database, with full-disk encryption and production
credentials read from the secret store at use, never stored in a file; once a Core server exists,
from a dedicated operator host in project « Kodera ».

## 4. `prospect`, and why the owner invariant does not apply to it — §P1.1

> *"No owner membership exists yet; the active-organization owner invariant therefore does not
> apply to this non-active state."* — §P1.1

The invariant is *"at least one non-deleted `org_owner` per **active** organisation"*
(`MODEL.md` invariant 1). It is stated on `active` rather than on every organisation precisely so
that a `prospect` — an organisation that by construction has no owner yet — is not a violation of
it. The complementary half MUST be enforced too: **no `Membership` of any role exists in a
`prospect` organisation.** Without that half, "the invariant does not apply here" degrades into
"this state is unchecked", which is the same sentence a reviewer will later read as a hole.

`prospect` admits exactly one mutation, `consumeOwnerClaim` by its `bootstrap` principal, and one
read of its own, `getOrganisationBootstrap`. Staff reads on it follow the ordinary rule. Every
other mutation on it is `409 invalid-state-transition`, because it is the organisation's state that
forbids the act, not the caller's role (`AUTHZ.md` §2 step 8).

`FIRST_SLICE_SPEC.md` defines no deadline for an unclaimed prospect and no fate for its slug
reservation, and this document invents neither: a prospect that is never claimed stays `prospect`
until an owner decision adds an abandonment path. The claim expires; the organisation does not.

## 5. The identity-bootstrap job — §P1.2

> *"The identity worker claims the operation and creates the organization realm before tenant
> provisioning … It must not link accounts across organizations solely because email strings match.
> A provider success whose response is lost enters reconciliation; it must not produce a second
> realm or subject."* — §P1.2

For the invited pilot there is no identity worker. §§5.5–5.7 say who does its part, and every
clause below that names the worker reads, for the pilot, as the operator command of §5.5 or §5.6,
run as §3.7 says.

**5.1 Ordering.** Realm creation precedes any tenant provisioning. The worker establishes the
intended prospective subject through the approved identity-provider flow, then records the verified
issuer/subject mapping. *Pilot:* the identity operator establishes the subject in the realm with
their tooling, and the mapping is recorded by `bind_intended_owner` (§5.6), only after the
`realm_create` job has succeeded.

**5.2 The binding is `(iss, sub)`, never the email string.** Two identities with the same address in
two realms are two identities (`AUTHZ.md` §6 rule 7). An implementation that matches on email — even
as a convenience, even behind a flag — violates §P1.2 directly, and `FS-BOOT-03` exists to catch it.

**5.3 A lost provider response is reconciliation, not a retry.** The `realm_create` job's dispatch
record carries the provider correlation and the fence of the claim that dispatched it, and the job
records the step and the operation whose outcome is unknown. On a lost response the worker
resolves the existing provider object by correlation before any further issuance: authenticated
terminal proof that the realm is complete, or that it is absent where the call is proven ended or a
late landing converges (the realm is addressed by its name, so a repeated create finds it), closes
the dispatch, and anything less puts the job in
`needs_reconciliation` (ADR-0004, [`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) §1),
which only an operator's recorded decision leaves. It MUST NOT create a second realm or a second
subject. Automatic retry from an ambiguous outcome is prohibited (§P4). *Pilot:* the provider calls
are made by the identity operator's tooling, each after the command has recorded its dispatch under
its claim (§5.5); an outcome the operator cannot establish holds the job for reconciliation exactly
as a worker's lost response would, and so does a verify read that does not complete.

**5.4 Published state.** `getOrganisationBootstrap` is a derived, secret-free view over the
organisation, the intake, the `realm_create` job, the identity binding and the claim. It carries no
claim token, no verifier and no delivery payload. Bootstrap progress is a separate operation state,
not an overloaded tenant state (§P2). `pending` and `unknown` MUST be reportable and truthful:
`FS-BOOT-02` requires that a crash leave a truthful pending or unknown state rather than a state
that a human has to repair by hand.

*Pilot — "ready" requires trust.* The realm is reported `ready`, and the identity binding can become
`ready`, only while the realm's issuer is present in Core's fixed trust list, `KODERA_AUTH_TRUST`:
at most eight issuers (`MAX_ISSUERS`, `services/identity/trusted_issuers.py`), the staff realm's
included, each with pinned public keys and its own expiry, loaded once at process start. The staff
realm's issuer is on the list's `staff` lane; each pilot realm's issuer goes on its `customer` lane.
The identity operator adds each pilot realm's issuer and keys to that list at onboarding, and renews
an entry before it expires; each is a configuration change and a redeploy of Core. A trust-list
change is made **only through a reviewed pull request to the deployment configuration**, never by an
edit in a shell on a host. A realm Core cannot authenticate against is not ready, whatever the job
says. Resolving realms dynamically from the database is deferred until after the pilot; until then
the list's size bounds the number of pilot organisations, and that limit is the pilot's, not a
defect.

*Pilot — realm discovery.* [`REALM_DISCOVERY.md`](REALM_DISCOVERY.md) admits an organisation to
`POST /api/v1/auth/discover` only when it is active or suspended and its customer realm carries a
"worker-confirmed ready" fact, and says no manual seed constitutes a production writer of that fact.
For the pilot, `complete_realm_bootstrap` (§5.5) is that fact's writer. It records
`orgs.RealmReadiness` in a separate transaction immediately before `finish_job(succeeded)`;
the reader counts it only when its job is the organisation's latest `realm_create` and has
succeeded, with the exact issuer/realm binding and current trust (§5.5 step 3.4).
`issuer_untrusted` withdraws it: while the realm's issuer is absent
from the trust list, discovery reads the realm as not ready, and the fact counts again once the
entry is back. Pilot organisations are therefore discoverable, from the moment the claim makes them
`active`; a `prospect` stays excluded, as discovery excludes every prospect. That writer is a pilot
deviation (PC-8, §10.3) and ends with the others.

> **Pilot deviation from `AUTHZ.md` §2 and §4 (PC-5).** `AUTHZ.md` §2 steps 3–4 resolve the realm
> from the database and fetch and cache each issuer's JWKS; for the pilot an issuer is trusted only
> through the fixed list above, with its keys pinned, and the realm must also match the organisation
> it names. `AUTHZ.md` §4 grants `bootstrap` by "the identity worker's binding"; for the pilot the
> binding is the operator's (§5.6). This amendment edits `AUTHZ.md` only in §4's staff rows (§3.7);
> its §2 and its `bootstrap` row are not edited. This deviation ends when the identity worker ships
> or before the first paying customer, whichever comes first (§10.3).

*Pilot — a trusted realm that stops being trusted (PC-7).* When the `realm_create` job has
succeeded but the realm's issuer is no longer in the trust list, the view reports the realm
`failed` — the `BootstrapStepState` member that means "needs an operator" — with the reason
`issuer_untrusted`. The identity binding and the claim are shown **blocked with the same reason**:
they keep the states they have, and no new state is added beyond the reason. `consumeOwnerClaim`
cannot succeed meanwhile, because the realm's bearer token no longer verifies against Core's trust
configuration and authentication fails before any check of §8.2. The cure is the identity
operator's: restore or renew the trust entry. No job is re-run for it, and the realm returns to
`ready` once the entry is back. The contract's `realm`, `identity_mapping` and `claim` objects have
no reason member yet; carrying `issuer_untrusted` on the wire is a contract change this amendment
does not make.

**5.5 The operator-run realm step — *pilot*.** The `realm_create` job created by the intake (§3.1)
is completed by operator commands in Core, run as §3.7 says. The commands hold no identity-provider
credential; the identity operator's tooling does, and creates the realm from the organisation-realm
template, at intake and with no tenant (PC-9, §10.3). **No lease spans manual work:** every step is split into short invocations joined by the
queue's own reconciliation hold and decision (`JOB_QUEUE.md` §§4.4, 5.4). A command records the
step's dispatch and holds the job; the identity operator runs the tooling while no claim exists;
the next invocation records the outcome. A redeploy of Core between any two invocations is safe.

Two rules hold for every operator command of this document, these and those of §§5.6, 5.7, 6.4,
6.6 and 8.7:

- **Sweep first.** Each command runs the queue's sweep (`sweep_jobs`, step 4) before it acts, so a
  lease left by a command that died is released before anything reads the job. The deployment may
  also schedule `sweep_jobs`.
- **Re-entry after a crash.** Each command that acts on a job is idempotent on `(job, step)`: run
  again, it reads what the queue recorded and resumes from the last recorded step, never repeating a
  recorded one. In particular a command accepts the job either held or already `queued` with its
  next step `pending`, which is where a crash between a decision and the following claim leaves it.

**The planned hold.** Each hold below is planned: it is taken on a dispatch whose operation has not
started yet, so that the work outside Core runs under no lease. Its `unresolved_operation_ref`
names what it waits for — `awaiting tooling step <n>` or `awaiting trust entry` — and that prefix
is what tells a planned hold from a lost response. The queue still emits `job.reconciliation_required`
for it, and the bootstrap view still reports the realm `running`; the alert owed for
`needs_reconciliation` (`JOB_QUEUE.md` §2) MUST NOT page on a planned hold.

> **Pilot deviation from `JOB_QUEUE.md` §4.4.** `hold_for_reconciliation` is for a call whose
> outcome is unknown. Here it is also a planned pause before an operation that has not started.
> The decision that follows it states the operation's real outcome, with evidence. This deviation
> ends when the identity worker ships or before the first paying customer, whichever comes first
> (§10.3).

1. **`start_realm_bootstrap` — steps 1–6, one step per invocation.** Run once to begin, and once
   after each tooling step. Each invocation does, for the next step `n` of steps 1–6 of
   `realm_create` (`JOB_CATALOGUE.md` §2):
   1. **Outcome of step `n − 1`**, when the job is held on it: it records the operator's
      reconciliation decision (`record_reconciliation_decision`, principal of §3.7) with
      `compute_terminated` the tooling run's record that the step's run has ended and `target_read`
      the tooling's read of the realm object the step made, each with the tooling's `provider`,
      `resource_id`, `request_id` and `observed_at`. Outcome `completed` resumes the job with the
      step `succeeded`; `no_effect` resumes it with the step `pending`, to be dispatched again;
      `partial` fails the job (`reconciliation_failed`), and the tooling runs the step's
      compensation. A reference names a run or a read; it carries no credential, no secret and no
      realm export, and Core does not check that it is authentic (`JOB_QUEUE.md` §5.4).
   2. **Claim.** It claims the job through the queue's own claim (`JOB_QUEUE.md` §4.2), under its
      fence and lease rules, unchanged; every write below is fenced. Nothing is created in the
      identity provider before the claim that dispatches it.
   3. **Dispatch and hold.** It records step `n` `running` and its dispatch, whose `operation_ref`
      is `awaiting tooling step <n>` together with the tooling run's identifier; holds the job for
      reconciliation on that dispatch (`hold_for_reconciliation`); and releases its live locks
      (`release_live_locks`). The claim and its lease end here.
   4. **Outside any lease,** the identity operator runs step `n` with the tooling, under the run
      identifier the dispatch names, and runs `start_realm_bootstrap` again.

   After step 6's outcome is recorded, the same invocation claims the job, records step 7,
   `verify`, `running` and its dispatch with the `operation_ref` `awaiting trust entry`, holds the
   job on it and releases its live locks.

2. **Between the invocations, the identity operator** adds the realm's issuer and pinned keys to
   `KODERA_AUTH_TRUST` through a reviewed change, redeploys Core (§5.4), and performs a test
   sign-in on the new realm by hand.

3. **`complete_realm_bootstrap` — decision, verify, end.** It takes the identity operator's result
   of the test sign-in as an explicit input — `--sign-in-result ok` or `--sign-in-result failed`,
   with `--sign-in-evidence <reference>` — and refuses without both. Then:
   1. It reads the realm's public OpenID discovery document and its JWKS, with no credential. A
      read that does not complete writes nothing: the job stays held and the command can be run
      again.
   2. It records the decision on the held step 7: `resume`, with `operation_outcome = no_effect` —
      the held verify never started — `compute_terminated` the record that the trust-configuration
      deployment awaited by the step-7 hold has ended, retaining its `provider`, `resource_id`,
      `request_id` and `observed_at`. The queue's evidence-ordering tolerance is unchanged.
      `target_read` is the read of step 3.1 (`provider` the realm's identity
      service, `resource_id` the issuer, `request_id` the read's correlation, `observed_at` its
      time). The job returns to `queued` with step 7 `pending` in a new resolution cycle.
   3. It claims the job again — that claim counts no attempt (`JOB_QUEUE.md` §5.4) — records step 7
      `running` and its dispatch, and runs the verify: it fetches the discovery document and the
      JWKS, and checks that the discovery document's `issuer` is exactly the issuer the
      organisation's realm name gives under the environment's identity host, and that the published
      keys match the keys pinned for that issuer in the trust configuration of the running Core
      (§5.4). It is never satisfied by the tooling's reference, a cached document or a test double.

      > **Pilot deviation from `JOB_CATALOGUE.md` §2, `realm_create` step 7 (PC-3).** The
      > catalogue's scripted authentication round-trip is replaced, for the pilot, by the identity
      > operator's manual test sign-in, given as the explicit input above and recorded on the step
      > as an evidence reference. The step succeeds only with the automated checks passing and
      > `--sign-in-result ok`. This deviation ends when the identity worker ships or before the
      > first paying customer, whichever comes first (§10.3).
   4. It ends the job: step 7 `succeeded`, with the verify's evidence and the sign-in reference as
      its `output_ref`. The command records the readiness fact immediately before
      `finish_job(succeeded)`, in a separate transaction because `finish_job` refuses a caller's
      transaction. The fact counts only when it names the latest `realm_create` job and that job
      has succeeded, while the issuer is trusted. A crash or failed completion leaves a
      non-counting fact; retry must complete the fenced job before discovery can report ready
      (`REALM_DISCOVERY.md`, §5.4, PC-8). When a check observes
      a definite mismatch — another issuer, keys that differ from the pinned ones, an issuer absent
      from the trust configuration, `--sign-in-result failed` — step 7 `failed` with the mismatch as
      its reason in the step's reference and in `realm.verification_failed`, and
      `finish_job(failed)` with the queue's `error_code` `step_failed`. A fetch that does not
      complete under this claim holds the job on step 7's dispatch again (§5.3), and the command is
      run again once the realm answers. A `failed` job is replaced under §5.7.

4. **`sweep_jobs` — the sweep, as an operator command.** The pilot runs no worker and so no
   sweeper; every operator command runs it first (above), and the deployment may schedule it.
   `sweep_jobs` runs the queue's own `sweep_expired_leases` (`JOB_QUEUE.md` §5.2), unchanged, as
   §3.7 says, and the events it emits keep the `system` actor the queue gives them. It adds nothing
   to the sweep: it reads no claim, and claim expiry is written as §6.5 says. A command that
   dies mid-lease is released by it: a job with an open dispatch goes to `needs_reconciliation`,
   one without becomes `orphaned`, and the next command claims an `orphaned` job again from its
   first step that is not `succeeded`.

The commands write the realm's, the binding's and the claim's audit events as the catalogue names
them, with the staff identity of §3.7 as the actor: the registry rows for `realm.created`,
`realm.verification_failed`, `identity.bound` and `owner_claim.issued` admit a `staff` actor beside
`system` (`AUDIT_TAXONOMY.md` §3, amended with this document; PC-4, RP-3), and `owner_claim.revoked`
and `owner_claim.confirmed` already name `staff`. The job's own events keep the actor the queue
gives them, whoever calls the queue: `job.started`, the step events, `job.succeeded`, `job.failed`
and the sweep's events are written by the queue's claim, runner and sweep functions with the
`system` actor (`apps/jobs/_claim.py`, `_runner.py`, `_sweep.py`); `job.created` carries the
enqueuer, the recorder for the intake's job and the acting staff identity for a job
`requeue_realm_bootstrap` enqueues (§5.7); and the decisions, `job.reconciliation_decided` and
`outbox_delivery.reconciliation_decided`, carry the deciding staff identity (`JOB_QUEUE.md` §§5.4,
7). That registry change is a pilot deviation too, and ends when the identity worker ships or before
the first paying customer, whichever comes first (§10.3).

**5.6 Binding the intended owner — *pilot*.** `bind_intended_owner` is a separate operator command,
run as §3.7 says. It records the intended owner's realm identity `(iss, sub)` with the subject
**supplied by the operator from the realm** — read by the identity operator from the realm's own
record of the account they created for that person — and creates the `Identity` that §7.3 and
`AUTHZ.md` §2 step 6 allow the binding to create. It MUST NOT look an account up by email, match the
intake's contact against the realm's users, or accept a subject from any other realm: §5.2 holds,
and `FS-BOOT-03` applies to this command as it did to the worker. It refuses unless the organisation
is `prospect`, its latest `realm_create` job has `succeeded`, the issuer is in the trust
configuration (§5.4), and no identity is already bound for it. In the same transaction it writes
`identity.bound` and issues the claim (§6.1).

The account and the binding carry four further rules:

1. **No credential the operator knows.** The identity operator creates the owner's realm account
   with no password, no OTP and the email **not** verified, at the intake's intended owner contact,
   with the Keycloak required actions verify email, update password and configure OTP. The person
   completes them from realm mail, so `email_verified` and the second factor that §8.2 checks 3
   and 4 read are the person's own. The realm sends that mail from the identity service's own
   sending domain (`auth.kodera.io`, mail project `kodera-mail-auth`; on staging
   `auth.staging.kodera.io`, `kodera-mail-auth-staging`), as ADR-0014 has a realm do before its
   organisation's first shared tenant. The identity operator's tooling sends Keycloak's
   required-actions email when it creates the account, and sends it again on request. Its link
   lives 72 hours, as the claim mail promises (« 3 jours »), the same as the claim's default
   (§6.5): at that default, the first link still expires before the claim, by the minutes between
   the account's creation and `bind_intended_owner`. The operator MUST run `bind_intended_owner`
   only once the tooling records the mail as sent; nothing in Core checks this, since the account
   creation record carries no send status. A resend late in those three days can outlive the claim, so an owner who comes
   late gets a new link first and then a reissued claim (§6.6), in that order. The tooling's link
   lifetime is fixed at 72 hours, not read from Core: a claim lifetime configured below 72 hours
   needs the tooling changed with it. `bind_intended_owner` takes the tooling's record of the account
   creation and refuses, writing nothing, an account that record marks as created with a
   credential.

   **Where the address comes from.** The intake keeps the contact sealed and shows only its masked
   form (§3.5), so the identity operator takes the address from the customer's instruction ticket,
   the one `instruction_ref` names, and gives it to the command on its standard input, never as an
   argument, so the address stays out of shell history and the process list. Neither the command's
   one-line record (§3.7) nor any of its refusals prints the address, as
   [`OUTBOX_MAIL_SENDER.md`](OUTBOX_MAIL_SENDER.md) §5.2 keeps the recipient out of every output.
   `bind_intended_owner` unseals the intake's contact under `KODERA_CONTACT_SEAL_KEY` and
   refuses, writing nothing, unless the two addresses are equal once each has had surrounding
   whitespace removed and its domain lower-cased, the local part compared exactly. This compares
   the operator's input with Core's own record; it looks up no account and matches nothing against
   the realm's users, so the rule above it holds. It is a check on the operator's input, not a
   control on the account: it does not show that the realm account was created at that address,
   since Core never reads the account's email. The claim token still goes only to the sealed
   contact.
2. **Two-person rule.** It refuses when its `--staff-identity` is the identity that recorded the
   intake (§3.7).
3. **Lock and constraint.** It takes the organisation lock exclusively, with a non-blocking
   attempt, under the key function of `JOB_CATALOGUE.md` §1, for its one transaction, as
   `consumeOwnerClaim` does (§8.1), and it is listed there among the lock's takers. One binding per
   intake is a unique constraint the database enforces, not a read-then-write check.
4. **Mail must be deliverable.** The claim email is enqueued in the binding's transaction with
   `enqueue_message` and sent by Core's outbox mail sender (§6.4). `bind_intended_owner` refuses,
   writing nothing, without `KODERA_CONTACT_SEAL_KEY`, which it needs to unseal the recipient,
   and `enqueue_message` refuses without the sender's settings, which rolls the whole binding
   back: it raises `SenderUnavailableError` without `KODERA_OUTBOX_SEAL_KEY`, and
   `MessageRefusedError` for every link when `KODERA_MAIL_LINK_ORIGINS` is unset, and for an
   address outside its conservative recipient set (`apps/outbox/sender.py`; `OUTBOX_MAIL_SENDER.md`
   §3). Without `KODERA_MAIL_SMTP_URL`, `run_deliveries` refuses to run (§7.5 there), and the
   message waits `pending` until its expiry. The message's locale is the intake's sealed `locale`,
   `fr` or `en`, and `fr`, the contract's default, when the intake gave none.

**5.7 Replacing a failed or cancelled realm job — *pilot*.** A `failed` or `cancelled` `realm_create` is replaced by an
operator command, `requeue_realm_bootstrap`, run as §3.7 says. It refuses, writing nothing, unless
the organisation is `prospect` and the latest `realm_create` job of the organisation is `failed` or
`cancelled`. The intake record is never changed and names only the first job
(`OrganisationIntake.bootstrap_job_id`), so "latest" is read from the organisation's jobs, as
[`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md) §3 reads it. It enqueues one new
`realm_create` job for the organisation, in one transaction with its audit row (`JOB_QUEUE.md`
§4.1); the replaced job stays as history, and the bootstrap view reads the latest. The new job's
idempotency key is derived as `JOB_QUEUE.md` §3.4 derives every key, from the array
`["requeue", replaced_job_id]`, so a requeue repeated after a crash, or run twice concurrently,
finds the one job its key derived and enqueues no second; `JOB_QUEUE.md` §3.4's table gains that
row with the implementing change. The intake stays idempotent: replaying `createOrganisation`
under its `Idempotency-Key` within the replay window returns the stored answer, and after the
window it reaches the job its own key derived and answers the original organisation and job
(`ORGANISATION_INTAKE.md` §1, Core #164) — the original answer, never the replacement — and in
neither case enqueues a job (§3.6). A job held for
reconciliation is not `failed` and is not replaced; it leaves that state only by a recorded
decision.

## 6. The owner claim — §P1.3

> *"Issue a limited owner claim only after the identity mapping is ready. The proposed claim lasts
> 72 hours, has a random token of at least 256 bits, and is bound to one organization and intended
> identity. Persist its verifier, never its plaintext in logs or ordinary replay storage."* — §P1.3

**6.1 Issuance is the worker's act**, and only once the identity binding is ready. Claim issuance
and revocation are not customer-reachable operations; the contract carries no operation for either
yet, and `AUTHZ.md` §4 grants `staff_operator` `revoke` on the `OwnerClaim` row so that the
`owner_claim.revoked` audit row has a cell behind it when such an operation lands. *Pilot:* with no
worker, Core issues the claim in the transaction of `bind_intended_owner` (§5.6), which is the act
that makes the binding ready, and never in answer to a request. The owner's decisions name no
issuing act; this reading is the amendment's, kept by the lead and confirmed by the independent
review on condition of §5.6's rules and §6.6's lock, both applied.

**6.2 The token.** At least 256 bits from a cryptographically secure source. Bound to exactly one
organisation and one intended identity. At most one `issued` claim exists per organisation
(`MODEL.md` invariant 15).

**6.3 The verifier, and only the verifier, is persisted.** Core stores a verifier — a one-way
function of the token — and compares in constant time. The plaintext MUST NOT appear in logs,
traces, ordinary replay/response storage, or the bootstrap view. One-time tokens and secret values
are excluded from ordinary result storage; losing their delivery requires the dedicated
revoke/reissue flow, not a re-read of a cached response (§P3, §P1.3).

**6.4 Delivery.** Any delivery retry payload containing the plaintext MUST be encrypted, narrowly
accessible, and deleted at delivery expiry or completion. *Pilot:* the claim is delivered by Core
email through **Core's outbox mail sender**, [`OUTBOX_MAIL_SENDER.md`](OUTBOX_MAIL_SENDER.md), and
by no other path. The transaction that issues the claim calls `enqueue_message` (§3 there) with
the template `owner_claim`, whose French and English copy the product owner approved (§4 there);
the intake's intended owner contact as the recipient and its locale (§5.6 rule 4); the console's
claim link as `link` and the claim token as `link_secret`; the organisation's name and the
claim's `expires_at` as the template's parameters; and the claim's `expires_at` as the message's.
The recipient and the token are stored only sealed, under `KODERA_OUTBOX_SEAL_KEY`, and erased
when the delivery succeeds, fails or expires (§5.1 there): that sealed value is the delivery
payload this clause governs. The non-secret `link` is derived from `KODERA_OWNER_CLAIM_LINK`
by appending `/{organisation_id}/{slug}` for the persisted organisation: its UUID in canonical
form and its slug, preserving the configured path prefix and removing at most one trailing
slash before joining.
The sent body carries `link#link_secret`, so the **claim token is in
the URL fragment**, never in the path or the query, and reaches no server log, proxy log or
`Referer`; the console reads it from the fragment and presents it in the body of
`consumeOwnerClaim`. The link's origin must be one of `KODERA_MAIL_LINK_ORIGINS`, the console's
origins. `run_deliveries --once`, run by the operator or a schedule (§7.5 there), sends the
message: locally to Mailpit, in production through the platform's transactional mail, from the
Core sending domain ADR-0015 names. ADR-0015 has that domain's mail project created when Core
ships its first sender; the pilot is that sender, so `notify.kodera.io` (and
`notify.staging.kodera.io`) with their mail projects are a prerequisite of the first pilot
organisation. The SMTP password comes from the deployment environment's
secret store, never from the database or the repository (§6 there).

**One delivery per issued claim.** A send whose outcome is unknown is never resent automatically:
the delivery goes to `needs_reconciliation` (`OUTBOX_MAIL_SENDER.md` §7.3), and only an operator's decision takes it
out, through `record_delivery_reconciliation_decision`, which writes
`outbox_delivery.reconciliation_decided` (`JOB_QUEUE.md` §7). That function takes a
`StaffPrincipal`, so for the pilot the decision is the operator command below, under PC-1. An
operator who needs the person to receive a link again uses reissue (§6.6), which revokes the old
claim; the old token is never sent again.

**`decide_claim_delivery` — *pilot*.** The decision on a held claim mail, run as §3.7 says:

```text
manage.py decide_claim_delivery --staff-identity <acting identity id> --delivery <delivery id>
    --exit <resume|fail> --outcome <completed|no_effect>
    --compute-terminated <provider> <resource_id> <request_id> <observed_at>
    --target-read <provider> <resource_id> <request_id> <observed_at>
```

1. **What it decides.** It refuses, writing nothing, unless the delivery is a `message` delivery
   whose `OutboxMessage.template_id` is `owner_claim`, and unless the decision is one of two
   pairs: `resume` with `completed`, when the mail provider's record shows it accepted the
   attempt's `Message-ID` (the delivery's `operation_ref`), which makes the delivery `succeeded`;
   or `fail` with `no_effect`, when the provider's record shows no such message, which makes it
   `failed`. It refuses, writing nothing, unless the `--target-read` `resource_id` equals the
   delivery's `operation_ref`. It refuses `resume` with `no_effect`, which would return the delivery to `pending`
   and send the same token again: a resend is a reissue (§6.6). `partial` names nothing a mail
   provider reports, and is refused too.
2. **The decision.** It builds its principal with `staff_principal_for_command` (§3.7) and calls
   `record_delivery_reconciliation_decision` with `compute_terminated` the record that the
   attempt's SMTP conversation has ended and `target_read` the mail provider's record of that
   `Message-ID`, each with its `provider`, `resource_id`, `request_id` and `observed_at`. The
   function's refusals are reported unchanged, with their reason, and write nothing:
   `not_in_reconciliation`, `role_missing`, `evidence_missing`, `evidence_out_of_order`
   (`JOB_QUEUE.md` §§5.4, 7).
3. **Audit.** The function writes `outbox_delivery.reconciliation_decided` in the decision's
   transaction: the actor the acting staff identity, the organisation the delivery's, the target
   the delivery, `metadata` the exit, the decision reference and the `staff_role_grant_ref` it
   relied on (`AUDIT_TAXONOMY.md` §3). The command writes no other audit row, and prints its
   one-line record (§3.7).
4. **Re-entry.** Run again on a decided delivery, it is refused `not_in_reconciliation`, writing
   nothing. Its "sweep first" (§5.5) runs `sweep_jobs`, which never moves an abandoned delivery
   attempt; only `run_deliveries`' own sweep does, so a delivery whose attempt died is refused
   `not_in_reconciliation` until that sweep has held it.
5. **What it does not touch.** It changes no claim and takes no organisation lock. A delivery the
   operator cannot establish stays held: reissue (§6.6) is the cure for the claim, and the held
   message's sealed token is erased at its expiry (`OUTBOX_MAIL_SENDER.md` §7.1).

The claim page handles the token so:

1. it removes the token from the URL with `history.replaceState` before it makes any request;
2. it loads no third-party resource of any kind;
3. it and its sign-in callback route are served with `Referrer-Policy: no-referrer` and a strict
   Content Security Policy: `default-src 'self'`, no inline script, `connect-src` limited to Core
   and the organisation's realm, and `frame-ancestors 'none'`;
4. across the single sign-in redirect, it holds the token in `sessionStorage` under one key, on the
   claim page's origin, for at most 10 minutes; it deletes the key on return before any other
   request, and on any failure. The token is never logged, and never placed in `localStorage` or a
   cookie.

**6.5 Lifetime is decided for the pilot, and stays configuration.** 72 hours was §P1.3's
*proposal*. *Pilot:* the lifetime is configurable with a default of 72 hours. The contract is still
right not to fix a number: it carries `expires_at` on the bootstrap view and no constant. An
implementation MUST read the lifetime from configuration, with 72 hours as the configured default,
and MUST NOT hard-code it. The configured lifetime is at most seven days: `enqueue_message`
refuses a message whose `expires_at` is more than seven days away (`OUTBOX_MAIL_SENDER.md` §3),
so a longer lifetime would refuse every binding and every reissue.

**Expiry is computed on read.** A claim is expired when `expires_at` is not after the current time,
whatever its stored state: the bootstrap view and §8.2 check 5 compare `expires_at` with now, and
nothing waits for a writer. The stored state moves to `expired`, and `owner_claim.expired` is
written with its `system` actor, by whichever bootstrap command or bootstrap read
(`getOrganisationBootstrap`) first observes the expiry; a command then acts on the state it has
just recorded. `sweep_jobs` is not one of them: it is the queue's sweep, unchanged (§5.5), and
never touches a claim.

**6.6 Reissue and revocation — *pilot*.** The contract has no operation for either yet. For the
pilot both are operator commands in Core, run as §3.7 says. Revocation moves the issued claim to
`revoked`, records the revoking staff identity and writes `owner_claim.revoked`. Reissue is a
revocation of any claim still `issued` followed, in the same transaction, by a new issuance and a
new delivery under §§6.2–6.4, to the intake's sealed contact as §5.6 rule 4 reads it, so that
`MODEL.md` invariant 15's single `issued` claim holds at every commit. Neither re-reads, re-sends or
recovers an earlier plaintext: there is none to recover (§6.3).

Both take the organisation lock exclusively, with a non-blocking attempt, under the key function of
`JOB_CATALOGUE.md` §1, for their one transaction, and are listed there among the lock's takers, so
neither interleaves with a consume (§8.1). Each changes a claim only while it is `issued`: the
update is conditional on `state = 'issued'`, and revoking a claim that is consumed, expired or
already revoked refuses, writing nothing. Both refuse when their `--staff-identity` is the identity
that recorded the intake (§3.7).

## 7. The `bootstrap` principal — §P1.4

> *"A bootstrap principal may reach only claim/status operations; it has no ordinary organization
> role. Unknown organization identities remain rejected by normal API authentication. The
> implementation must name the explicit bootstrap exception instead of weakening authentication
> globally."* — §P1.4

**7.1 What it is.** An authenticated principal in a customer realm whose `(iss, sub)` the identity
worker bound — for the pilot, the operator's `bind_intended_owner` (§5.6) — as the intended owner of
a `prospect` organisation, holding no `Membership`. It is
**not** a `Membership.role`, and it is not a stored row (`AUTHZ.md` §4).

**7.2 It reaches exactly two operations**, `getOrganisationBootstrap` and `consumeOwnerClaim`, and
nothing else. An operation naming `bootstrap` anywhere else fails the contract check that
`scripts/ci/check-authz-matrix.py` already runs.

**7.3 The exception is named, not global.** Authentication is unchanged: a token whose `(iss, sub)`
has no `Identity` and whose realm is a customer realm creates neither and is
`403 identity-unknown` (`AUTHZ.md` §2 step 6). Identities are created by the invitation and enrolment flows and by the worker's binding —
for the pilot, by `bind_intended_owner` (§5.6) — never by a bearer token arriving. The bootstrap
exception lives in **authorisation**, as a closed
two-operation list, and MUST be expressed that way in code: a check that answers *"is this
operation one of the two, and is this principal the bound intended owner of the organisation its
`iss` resolves to"*. It MUST NOT be expressed as a relaxed authentication class, a
`permission_classes = [AllowAny]` on those views, or a settings flag that widens the default
authentication for any request. `AUTHZ.md` §4 states that a fourth such principal is a change to
that document before it is a change to the contract; the same rule binds the implementation.

**7.4 Scoping.** A `bootstrap` principal's organisation is the one its `iss` resolves to.
`getOrganisationBootstrap` on any other `organisation_id` is `404`, never `403`, so that a claim
cannot be used to probe organisations. A claim token that resolves to another organisation's claim
is `404 not-found`. The single declared exception: within its own organisation, a claim bound to a
different `(iss, sub)` is `403 owner-claim-identity-mismatch`, because the caller is already an
authenticated subject of that realm and the denial is evidence worth recording (`AUTHZ.md` §6
rule 7).

## 8. Consuming the claim — §P1.5

> *"Under an organization lock, verify token, subject/issuer binding, verified-contact evidence,
> expiry, revocation, required MFA and absence of an existing first owner. Create the first owner
> membership, consume the claim, transition the organization to `active`, and emit audit evidence
> atomically. A spent token alone cannot authenticate a retry; an authorized replay of the original
> logical operation may return its existing result."* — §P1.5

**8.1 Lock ordering.** Organisation before tenant; multiple ids within a class in sorted order
(§P4). This operation takes the organisation lock only, exclusively, for its one transaction
([`../domain/JOB_CATALOGUE.md`](../domain/JOB_CATALOGUE.md) §1). It takes it with a non-blocking
attempt, as a job claim does: when the lock is busy it fails fast rather than waiting, and the
caller retries the same logical operation, whose replay §P1.5 allows. Different organisations proceed
independently, and a blocked organisation MUST NOT block another — `FS-CON-02` is the scenario that
holds this to account beyond this slice.

**8.2 Verified under the lock, in this order.** Every one of these is a distinct refusal, and none
may be reordered so that a cheaper check leaks information the ordering was chosen to protect:

| # | Check | Refusal when it fails |
|---|---|---|
| 1 | The token resolves and matches its stored verifier, compared in constant time | `404 not-found`, never saying whether it existed |
| 2 | The claim is bound to the caller's `(iss, sub)` | `403 owner-claim-identity-mismatch` |
| 3 | The signed `email_verified` claim is exactly boolean `true` | `403 owner-claim-contact-unverified` |
| 4 | The signed `kodera_mfa_enrolled` claim is exactly boolean `true`, `azp` is the configured Console client, the registration evidence is at most 330 seconds old, current-login `amr` contains exact `otp`, and the login itself is recent: integer `auth_time` no more than 2 seconds ahead and no more than 320 seconds behind, at the decision and at the final read before commit (a 330-second ceiling less a 10-second commit budget) | `403 mfa-required` |
| 5 | The claim is not expired | `410` |
| 6 | The claim is not revoked | `410` |
| 7 | The claim is not consumed | `409 owner-claim-consumed` |
| 8 | The organisation is `prospect` | `409 invalid-state-transition`, `allowed_states: [prospect]` |
| 9 | The organisation holds no `org_owner` | `409 invalid-state-transition` |

Every refusal is audited under `authz.denied` with the claim's state as `metadata.reason` and
**never** a `metadata` member carrying the token (`AUDIT_TAXONOMY.md` §3, `AUTHZ.md` §9). **No
refusal creates a membership.**

Checks 8 and 9 are both required and are not the same check. State is what the API reads; ownership
is what the invariant is about. An organisation could be `prospect` with an owner only through a
defect, and this is the operation that must refuse to compound it.

**8.3 One transaction.** Creating the first `org_owner` membership, consuming the claim, moving the
organisation `prospect` → `active`, and writing `owner_claim.consumed`, `membership.created` and
`organisation.activated` all commit together or not at all (§P1.5). There is no window in which an
`active` organisation has no owner, and none in which an owner exists against an unconsumed claim.

**8.4 One path to first ownership.** `consumeOwnerClaim` is the only operation of the contract that
creates an organisation's first owner (`MODEL.md` invariant 15, `AUTHZ.md` §4). Any other path
that can write `role = org_owner` into an organisation with no owner is a defect, and a mutation
that opens one MUST fail the acceptance.

**8.5 Why a spent token cannot authenticate a retry.** The token never authenticates anything. The
realm-issued bearer JWT authenticates; the claim token is *authorisation evidence* bound to one
organisation and one identity. Once consumed, check 1 finds a claim in state `consumed` and check 7
refuses `409 owner-claim-consumed`. Nothing about holding the plaintext later re-establishes who
the caller is — which is exactly why the plaintext is not a credential and why §6.3 keeps it out of
replay storage.

What *may* be replayed is the **logical operation**: the same `Idempotency-Key` and the same body
from the same identity — now `org_owner` — is answered from the replay cache *after* authentication
and authorisation against current state (§P3). That is why `consumeOwnerClaim` names `org_owner`
beside `bootstrap`: the retry reaches the handler and receives the replayed `200`, or `409
owner-claim-consumed` under a new key, rather than a `403` that reads as "you may not own this".
Replay MUST re-authorise against current state, so revocation, an organisation change or a lost
capability prevents recovery of the stored output (§P3, `FS-OP-04`).

**8.6 The starter workspace is not part of the claim — *pilot*.** §8.3's transaction stays exactly
as specified: it creates no workspace, no channel and no other record beyond those it names. The
organisation's starter workspace is created by a **separate, idempotent step after the claim has
committed**, text channels first, specified in
[`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md). A failure or a repetition of that
step never undoes, delays or repeats the claim, and an `active` organisation without its starter
workspace yet is a truthful intermediate state, not a violation of §8.3. *Pilot:* the workspace
cannot be initialised until the owner's confirmation of §8.7 is recorded.

**8.7 The owner's confirmation — *pilot*.** After the claim is consumed, the **intake recorder** —
not the identity operator — confirms with the customer, through a channel independent of the
realm, that the customer holds the owner account. The confirmation is recorded with the staff
command `confirm_owner_contact`, run as §3.7 says, which refuses, writing nothing, unless the claim
is `consumed` and its `--staff-identity` is the identity that recorded the intake, and writes
`owner_claim.confirmed`. Until it is recorded, the bootstrap view shows the organisation as
**awaiting owner confirmation**, and the starter workspace cannot be initialised (§8.6). This is
the effective control against an identity operator who resets the owner's credential after the
binding (§3.7). The contract's bootstrap view has no member for it yet; carrying it on the wire is
a contract change this amendment does not make.

## 9. Out of scope: §P1.6 `placeOrder` — decided in the contract, not designed around here

**§P1.6 says:** *"The verified owner selects an immutable published offer … Staff cannot submit the
customer's signature or become its owner through intake."*

**The contract as reviewed said**, up to 0.9.1 — `contracts/core-api.openapi.yaml`, `placeOrder`:
`x-kodera-authz: roles: [org_owner, staff_operator]`, and its request body requires
`dpa_acceptance`, whose acceptance the description calls mandatory and part of this request.

These two statements were in conflict. A `staff_operator` who may call `placeOrder`, and whose body
must carry `dpa_acceptance`, is a staff actor submitting the customer's acceptance evidence — the
act §P1.6 forbids. This document does **not** design around it in either direction; OD-1 records
how the contract resolved it.

> **Decision OD-1, decided.** Does `placeOrder` keep `staff_operator`, and if so, how is
> `dpa_acceptance` supplied without staff submitting the customer's signature? The candidate shapes
> a decision must choose between: (a) drop `staff_operator` from `placeOrder`, so only `org_owner`
> orders; (b) keep `staff_operator` but move DPA acceptance to a separate customer-only operation
> that `placeOrder` then references by id, so staff can place an order only against acceptance the
> customer already gave; (c) keep both and record explicitly that staff-assisted ordering is
> permitted with a named evidence rule that distinguishes it from a customer signature.
> **Owner:** zôÖma, with the independent backend/security reviewer named in
> `FIRST_SLICE_SPEC.md`'s decision table. **Blocked:** any implementation of §P1.6, `FS-BILL-01`,
> `FS-BILL-06` and `FS-JOURNEY-01`.
>
> **Decided: shape (a).** Contract 0.10.0 drops `staff_operator` from `placeOrder`, so only
> `org_owner` orders, and the `Order` cell of `AUTHZ.md` §5 gives `staff_operator` `read all`. The
> lead decided it under the owner's delegation (register ORDER-AUTH); no participation of the
> independent reviewer named above is recorded. The three scenarios are no longer blocked on it;
> §P1.6 itself stays out of this document's scope.

`FS-BOOT-07` is in this packet and is *not* the same question. It asserts the intake side only:
that a staff intake request attempting to sign terms or a DPA, or to nominate staff as customer
membership, is refused and the denial recorded. That much §P1.1 and §P1.6 already settle, and
`createOrganisation`'s `additionalProperties: false` is the mechanism.

## 10. Recorded drifts — not silently resolved

10.1 and 10.2 were raised against `contracts/core-api.openapi.yaml`. 10.1 is decided for the G1
specification by [`../adr/0019-organisation-lifecycle-states.md`](../adr/0019-organisation-lifecycle-states.md);
its persistence, contract and UI implementation still have to move together. 10.2 is decided, its
minimum by the owner, and contract 0.11.0 carries the decision. 10.3 records where the owner's
decisions for the invited pilot disagree with existing text, each open until its owner records a
resolution.

**10.1 Organisation lifecycle state name: `closed` versus `terminated`.**
`contracts/core-api.openapi.yaml` `OrganisationState` is `[prospect, active, suspended, closed]`.
[`../domain/MODEL.md`](../domain/MODEL.md) `Organisation.status` is
`prospect | active | suspended | terminated`, and its own row records the disagreement, pointing at
[`../../contracts/CONSOLE_RECONCILIATION.md`](../../contracts/CONSOLE_RECONCILIATION.md) §6.5.
`FIRST_SLICE_SPEC.md` §P2 proposes a fifth state and a different final name again: `prospect`,
`active`, `suspended`, `closing`, `closed`.

> **Decision OD-2.** Organisation state is `prospect | active | suspended | closing | closed`.
> Unknown states fail closed. `prospect` admits only bootstrap, `active` is the ordinary operating
> state, `suspended` and `closing` admit no new effect-bearing customer mutation without an explicit
> rule, and `closed` is terminal with no customer bearer-token access. Retained-record reads and
> post-erasure delivery stay outside this decision. State and permission mappings change
> **together** across persistence, OpenAPI and UI. ADR-0019 records the complete decision and its
> consequences; its status-only ratification remains separate from this specification change.

The implemented slice still touches only `prospect` and `active`, on which all three documents
agree. The decision is no longer an owner blocker, but the four-state persistence and contract
remain an implementation gap until they move together with authorization and generated clients.

**10.2 Organisation slug length: 3–64 versus 2–20, decided as 5–20.** When this section was written
the contract's pattern was
`^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$` — minimum three characters, maximum sixty-four — and
`OrganisationBootstrap` kept it until 0.9.1.
`FIRST_SLICE_SPEC.md` §P2 then recommended 2–20 lowercase ASCII characters, first and last
alphanumeric, inner hyphens permitted. It now states 5–20 characters, its minimum set by register
SLUG-MIN-ANSWER.

> **Decision OD-3, decided, with the owner's minimum of five.** Which canonical rule? The two
> disagree at both ends: a two-character slug the internal specification admits is refused by the
> contract, and a twenty-one to sixty-four character slug the contract admits is refused by the
> internal specification. §P2 requires **one** canonical rule validating creation, persistence,
> discovery and authentication; `FS-ID-01` and `FS-ID-02` are written against minimum and maximum
> lengths and against *"the former 21-character counterexample"*, so neither can be implemented
> until the boundary is fixed. The reserved-name list — staff, system, environment names and the
> configured identity namespaces — is a separate input to the same decision, decided below.
> **Owner:** API seat with the Security seat, since the rule also
> constructs the realm issuer. **Blocked:** §3.2's canonical validator, `FS-ID-01`, `FS-ID-02`.
>
> **Decided: §P2's rule, with the owner's minimum.** One organisation slug rule of 5–20 lower-case
> ASCII characters, first and last alphanumeric, inner hyphens permitted, for creation, persistence,
> discovery and authentication. Contract 0.11.0 carries it as one pattern on all five schemas that
> carry the organisation slug, and `Organisation`'s database check `organisation_slug_valid`
> enforces it. Contract 0.10.0 carried a minimum of two, §P2's figure at the time and the lead's own
> call (register SLUG-MIN); the owner answered five (register SLUG-MIN-ANSWER), superseding it, and
> §P2 now states 5–20. The tenant slug is a separate rule, a DNS label of 3–32 characters.
>
> **The reserved names are decided too.** Contract 0.14.0 enumerates them on
> `OrganisationCreateRequest.slug`, a closed list refused `422 validation-error` with the code
> `reserved`: `master`, `kodera-staff`, `kodera-probe`, `kodera-dev`, `kodera`, `staff` and `admin`.
> Core #164's migration `orgs.0008` makes the database refuse the same list
> (`organisation_slug_not_reserved`). Adding a name to the list is a breaking change.

Contract 0.29.0 additionally reserves every otherwise valid `synth-*` organisation name. Path K
synthetic realms deliberately stay outside Core; there is no synthetic organisation flag or intake
bypass. Format errors are checked first. Names such as `synth`, `synth0-a`, `synthesis` and
`acme-pilot` remain ordinary. `orgs.0015` refuses existing collisions without rewriting an identity,
adds `organisation_slug_not_synthetic` as `NOT VALID`, and `0016` validates it separately; both
use finite lock and statement budgets. Operators must resolve a collision deliberately before
migration can continue.

§3.2's requirement stands unchanged — the reservation is atomic and one function serves all four
call sites — and OD-3 fixes the *content* of that function, reserved names included.

**10.3 Conflicts between the pilot decisions and existing text, and the lead's rulings.** Each
conflict below was raised by this amendment and ruled by the lead. A ruling that departs from
`AUTHZ.md`, `JOB_QUEUE.md`, `JOB_CATALOGUE.md`, `STAFF_IDENTITY.md`, `REALM_DISCOVERY.md`, ADR-0006 or
the audit registry is a **pilot deviation**, marked where it
applies; the independent reviewer's acceptance of this document is acceptance of each of them.

**End condition.** Every pilot deviation of this document — the registry rows of
`AUDIT_TAXONOMY.md` §3 included — has one end condition: it ends when the identity worker ships or
before the first paying customer, whichever comes first. PC-1's deviation may end earlier, when the
commands carry device-authorisation staff tokens, and `staff_principal_for_command` ends with it;
and its reliance on logs the operator can reach ends when those logs go to a write-once store the
operator cannot write (§3.7).

The independent review returned *ratify after fixes*. Its blockers B1 (one person could make
themselves owner under an attribution of their choosing) and B2 (a revoke could lose to a concurrent
consume) are applied by §3.7's controls, §5.6's rules and §6.6's lock and conditional update; its
should-fix items are applied as the lead ruled them in §§3.7, 3.8, 5.4, 5.5, 6.4 and 6.5: S1, the
mail sender's credential and the reconciliation of an ambiguous send (§6.4); S2, dispatch, tooling
outside any lease, outcome on the next invocation, for every step (§5.5); S4, binding and claim
blocked under `issuer_untrusted` (§5.4); S5, the token across the sign-in redirect (§6.4); S7,
`StaffRole` written only by the commands of `STAFF_IDENTITY.md` §4 and a fixed staff issuer (§3.7).
Of its nits, N1 to N4 are applied (§§2, 5.5, 7.1, 7.3); N5, an added email check at consume, is left
to the custodian and changes nothing here.

| # | Conflict | Ruling | Where |
|---|---|---|---|
| PC-1 | Operator commands carry no token and no `amr`, while `AUTHZ.md` §3 has staff act through the API, and `JOB_QUEUE.md` §4, `STAFF_IDENTITY.md` §5 and `MODEL.md` `decided_by_identity_id` have the staff principal resolved only from a verified token | **Pilot deviation.** Run from a checkout against the target environment's Core database under `config.settings.job_queue`; database access is the credential; `--staff-identity <acting identity id>` names a stored staff identity with a current `staff_operator` grant, audited as the actor; the principal is built by the command-only `staff_principal_for_command(identity_id)`, which the API image does not carry; the identity is asserted, not proven, and compensated by a two-person rule, Keycloak admin events, a one-line command record and the recorder's confirmation; ends under the end condition above, and the builder with it | §§3.7, 6.4 |
| PC-2 | Creating the realm before the job is claimed left steps 1–6 unfenced, with no dispatch, against `JOB_CATALOGUE.md` §1 | Reordered: the command claims first and records each step's dispatch before the tooling runs it. No deviation remains | §5.5 step 1 |
| PC-3 | The decided verify uses no credential; catalogue step 7 requires a scripted authentication round-trip | **Pilot deviation.** Automated discovery and JWKS checks, plus a manual test sign-in recorded as an evidence reference | §5.5 step 3.3 |
| PC-4 | The registry gives `realm.created`, `identity.bound` and `owner_claim.issued` a `system` actor only; under the pilot they are staff acts | **Pilot deviation** in the registry: the rows admit `staff` beside `system`; `AUDIT_TAXONOMY.md` §3 is amended with this document | §5.5, §5.6 |
| PC-5 | `AUTHZ.md` §2 resolves realms from the database with fetched JWKS; its §4 has the worker bind | **Pilot deviation**, noted here only: fixed trust list, operator binds. `AUTHZ.md` §2 and its `bootstrap` row, and the contract's prose, are edited separately | §5.4 |
| PC-6 | The decision gated production on the staging cutover; ADR-0015 forbids a row before that database's own cutover | Each database after its own cutover, declared final with no rollback pending: staging after step 4, production after step 7 | §3.8 |
| PC-7 | No state for "succeeded, issuer no longer trusted", and no successor to a `failed` `realm_create` | Reported `failed` with reason `issuer_untrusted`; a failed job is replaced by `requeue_realm_bootstrap`; intake stays idempotent | §5.4, §5.7 |
| PC-8 | `REALM_DISCOVERY.md` admits an organisation only when its realm carries a "worker-confirmed ready" fact, and no manual seed is a production writer of that fact | **Pilot deviation.** `complete_realm_bootstrap` records the fact in a separate transaction immediately before `finish_job`; it counts only for the latest succeeded `realm_create` job while trusted (§5.5 step 3.4). `issuer_untrusted` withdraws it; pilot organisations are discoverable once `active`; ends under the end condition above | §5.4, §5.5 step 3.4 |
| PC-9 | [ADR-0006](../adr/0006-kodera-identity-topology.md) (and ADR-0015, Proposed, in the same words) runs realm creation and template changes through the worker, and creates an organisation's realm with its first tenant | **Pilot deviation.** The identity operator's tooling, outside Core, creates the realm from the organisation-realm template and applies template changes; the `realm_create` job is created at intake, so a pilot organisation's realm exists before, and possibly without, any tenant. ADR-0006's other rule holds: the API holds no Keycloak master-realm credential, and no Core process holds an identity-provider credential at all. Ends under the end condition above, when the identity worker runs realm creation and template changes | §§3.1, 5.5 |
| PC-10 | The registry has no action for the intake recorder's out-of-band confirmation that the customer holds the owner account | **Pilot deviation.** `owner_claim.confirmed` (`staff`, target `owner_claim`) is added to `AUDIT_TAXONOMY.md` §3 and written by `confirm_owner_contact`; the workspace waits for it; ends under the end condition above | §8.7 |

The rulings raised three further points, which the lead also ruled:

| # | Point | Ruling | Where |
|---|---|---|---|
| RP-1 | With claim-first ordering the realm's keys exist only after the claim, while the trust entry that pins them is a redeploy of Core | Split invocations: `start_realm_bootstrap` ends in the reconciliation hold `awaiting trust entry`; after the redeploy, `complete_realm_bootstrap` decides on the held job and verifies. **Pilot deviation** from `JOB_QUEUE.md` §4.4's use of the hold | §5.5 |
| RP-2 | A lease held across manual work, and no worker or sweeper to release a dead command's lease | No lease spans manual work (§5.5); the queue's sweep is exposed as the operator command `sweep_jobs` for the pilot | §5.5 step 4 |
| RP-3 | A failed verify emits `realm.verification_failed`, which admitted `system` only | The row admits `staff` beside `system`, as PC-4's rows do | §5.5, `AUDIT_TAXONOMY.md` §3 |

## 11. What the acceptance packet proves, and what it does not

The seven bootstrap scenarios are executable and non-passing. They run against a real disposable
PostgreSQL, apply the real migrations, load the real `config.settings.test` with its local-only
refusals, and drive the reviewed operations through the real URL resolver and the real DRF stack.
The paths and roles they drive are **read from `contracts/core-api.openapi.yaml` at run time**, not
copied, so a contract edit moves the acceptance with it rather than leaving it asserting a route
nobody serves any more.

**What is red, and why.** `FS-BOOT-01`…`FS-BOOT-05` and `FS-BOOT-07` report `failed`. Each names
the specific absent behaviour it reached for. They are red at the **first** step of their intended
path — the reviewed operation resolves to no view, and the schema holds no relation for the records
§2 names — not at the subtle discrimination each scenario is ultimately about. A reader MUST NOT
conclude from a red `FS-BOOT-03` that identity binding is checked and merely broken; nothing checks
it, because nothing authenticates yet. Each assertion says which of its sub-conditions were never
reached, and that list is the honest measure of how far this slice is from done.

**What is red, and what remains operationally missing.** `FS-BOOT-06` is an expected failure. Its positive half requires the
claim to succeed after *"actual local provider MFA succeeds and evidence is freshly verified"*, and
`ACCEPTANCE.md` forbids replacing the provider's assertions with a test boolean. The repository
does contain a real local identity provider — `dev/identity_fixture.py` boots a pinned Keycloak,
imports a realm and completes a real authorisation-code flow with PKCE — and Core does contain real
production token verification, `services/identity/access_tokens.py`, which reads `amr`, `acr` and
`auth_time`. **What is missing is a second factor in the provider this packet boots.** The named
missing dependency: neither `dev/realms/*.json` nor the realm `dev/identity_fixture.py` builds
configures an OTP policy, a required `CONFIGURE_TOTP` action, or any second-factor credential, and
the fixture's login exchange posts a password and expects the authorisation redirect immediately,
so it cannot complete an OTP challenge. The local end-to-end stack is another matter: since Core
#159, `dev/e2e/realms/e2e-pilot.json` and `dev/e2e/realms/kodera-staff.json` require a code at sign-in
and map `amr` to `["pwd", "otp"]`, and `dev/e2e/README.md` creates the pilot's owner account as
`bind_intended_owner` expects it. The repository therefore holds a real second factor, but not in
the provider this packet boots; and that README records as unproven that the owner's token carries
`otp` after the required-actions path. The acceptance measures
this rather than asserting it: it boots the real provider, completes the real flow, verifies the
issued token with the real production verifier, and reports `blocked` on the observation that the
verified token carries no `otp` in `amr`. Faking that factor would satisfy `FS-BOOT-06`'s
letter and destroy its purpose, so it is not faked.

The Core consumer decision is fixed in
[`REGISTERED_FACTOR_SIGNAL.md`](REGISTERED_FACTOR_SIGNAL.md): strict signed
`email_verified=true` and `kodera_mfa_enrolled=true`, the configured Console as `azp`, current-login
`amr` containing exact `otp`, and evidence no older than 330 seconds. Because the provider keeps a
session's `amr` for the whole SSO session, the claim step also requires authentication within the
last 320 seconds (`auth_time`: 300 seconds plus 30 of skew, less a 10-second commit budget), and
the Console's owner-claim sign-in requests `max_age=0` so that the person signs in again for it.
Core bounds the login's age; that the forced login re-runs OTP is the realm's flow. Its
configuration is held by identity realm tooling realm-apply's `check` (`auth-otp-form` REQUIRED), and the
behaviour was shown on real Keycloak 26.0.7 by a recorded run of the lab case `max_age-0-reauth`,
added by identity realm tooling #59 and re-run by the SRE as lab GO item 3. Local TOTP is the only v1
factor; a brokered owner must add and use local TOTP. What remains with the SRE seat is operational:
the Keycloak producer, realm configuration and real-provider evidence. The implementation task that
closes the gap MUST extend the local provider to produce and exercise that contract, and MUST NOT
introduce a simulation path.

**What it does not cover yet.** The pilot's operator commands (§§5.5–5.7, 6.4, 6.6, 8.7) and their
`--staff-identity` refusal, the trust-list condition and `issuer_untrusted` of §5.4, the
fragment-only delivery of §6.4 and the separation of §8.6 have no scenario in the packet. The
implementation change for each lands its failing scenario first, against the real provider and the
real trust loader, under the same rule as `FS-BOOT-06`: nothing simulated.

**What none of it proves.** Not that the design in §§3–8 is correct — only that it is absent. Not
`FS-HARNESS-01`, whose dependency, network and reset requirements this packet does not meet. Not
the twenty-six other scenarios, which remain `not_implemented`. `make acceptance-first-slice`
returns nonzero and will keep doing so.

## 12. Review checklist

- [ ] Every clause of §§3–8 cites the §P1 step it comes from, and no clause resolves an owner
      decision that §9 or §10 records as open.
- [ ] The slug reservation is a database constraint, not a read-then-write check (§3.2).
- [ ] No path other than `consumeOwnerClaim` writes `role = org_owner` into an organisation with no
      owner (§8.4).
- [ ] The bootstrap exception is a two-operation authorisation list, not a relaxed authentication
      class or a widened default (§7.3).
- [ ] The claim plaintext appears in no log, trace, replay entry or bootstrap view; only the
      verifier is persisted (§6.3).
- [ ] The nine checks of §8.2 run under the organisation lock, in that order, and no refusal
      creates a membership.
- [ ] The claim lifetime is configuration, defaulting to 72 hours, not a hard-coded 72 hours (§6.5).
- [ ] *Pilot:* the verify step of §5.5 fetches the real discovery document and JWKS and compares
      them with the pinned trust entry; nothing reports the realm `ready` while its issuer is absent
      from `KODERA_AUTH_TRUST` (§5.4).
- [ ] *Pilot:* `bind_intended_owner` takes the subject from the operator and never from an email
      match (§5.6).
- [ ] *Pilot:* the claim token travels only in the link's fragment and in the encrypted outbox
      payload (§6.4).
- [ ] *Pilot:* the claim transaction of §8.3 creates no workspace (§8.6).
- [ ] Staff roles come from `StaffRole`, staff identities carry no organisation and belong to the
      staff realm, and every staff HTTP action requires `amr` (`STAFF_IDENTITY.md`). *Pilot:* an
      operator command refuses unless its `--staff-identity` holds a current `staff_operator`
      grant, and builds its principal only with `staff_principal_for_command`, which the API image
      does not carry (§3.7).
- [ ] *Pilot:* `start_realm_bootstrap` claims before any effect, records each step's dispatch
      before the tooling runs it, and ends in the hold `awaiting trust entry`; no lease spans the
      trust entry, the redeploy or the sign-in (§5.5).
- [ ] *Pilot:* `complete_realm_bootstrap` writes nothing when its read does not complete, decides
      `resume`/`no_effect` on the held job, and step 7 needs both the automated checks and the
      manual sign-in reference (§5.5).
- [ ] *Pilot:* `sweep_jobs` is the queue's own sweep, unchanged (§5.5 step 4).
- [ ] *Pilot:* `requeue_realm_bootstrap` replaces only a `failed` or `cancelled` job, the
      organisation's latest, under a key derived from the replaced job, and replaying the intake
      never enqueues one (§5.7).
- [ ] *Pilot:* `bind_intended_owner` reads the owner's address on standard input, never prints it,
      refuses one that differs from the intake's sealed contact, and refuses without the contact
      seal key or the sender's settings (§5.6).
- [ ] *Pilot:* a held claim mail leaves `needs_reconciliation` only through
      `decide_claim_delivery`, which never returns it to `pending` (§6.4).
- [ ] *Pilot:* `complete_realm_bootstrap` writes the realm's ready fact for discovery, and
      `issuer_untrusted` withdraws it (§§5.4, 5.5).
- [ ] *Pilot:* no organisation row is written on a live database before that database's ADR-0015
      cutover, and every operator command refuses while `KODERA_INTAKE_ADMITTED` is not `1`
      (§3.8).
- [ ] Every pilot deviation of §10.3 is marked where it applies and carries §10.3's end condition.
- [ ] *Pilot:* the owner's account is created with no operator-known credential, and bind, reissue
      and revoke refuse the intake's own recorder (§§3.7, 5.6).
- [ ] *Pilot:* bind, reissue and revoke take the organisation lock exclusively; reissue and revoke
      change a claim only while `issued`; one binding per intake is a database constraint (§§5.6,
      6.6).
- [ ] *Pilot:* every operator command sweeps first, resumes from its last recorded step, and prints
      its one-line record (§§3.7, 5.5).
- [ ] *Pilot:* each realm step's dispatch is recorded and the job held before the tooling runs, and
      its outcome is recorded by the next invocation with the tooling's evidence (§5.5).
- [ ] Only `grant_staff_role` and `revoke_staff_role` write `StaffRole`, never for the
      granter's own identity, after `bootstrap_staff_roles`, which grants exactly two distinct
      identities and refuses once any row exists (§3.7).
- [ ] *Pilot:* the claim token is held across the sign-in redirect only in `sessionStorage`, at
      most 10 minutes, deleted on return and on failure, under the claim page's strict CSP (§6.4).
- [ ] *Pilot:* the workspace waits for `confirm_owner_contact` by the intake recorder (§§8.6, 8.7).
- [ ] *Pilot:* `owner_claim.expired` is written by a bootstrap command or read, never by
      `sweep_jobs` (§6.5).
- [ ] *Pilot:* expiry is computed on read (§6.5); the claim page strips the fragment before any
      request, loads no third-party resource and sends no referrer (§6.4).
- [ ] Nothing in this document or in the acceptance claims a control that does not exist; §11 is
      accurate about what is red, what is blocked and what was never reached.

## 13. Optional caller assurance contract

Status: CONTRACT ONLY; current server output always omits caller_assurance. Synthetic examples
validate structure, not runtime availability, signatures, current eligibility or readiness.

The existing authenticated getOrganisationBootstrap operation may later carry optional
caller_assurance for its current customer only. Existing customer identity/person enablement,
exact issuer/subject/target organisation and OwnerBinding authorization stay mandatory. It is
never a pre-auth locator, initially unbound preparation path or staff assurance projection.
No route, role, status, header, persisted BootstrapView member or emitter changes in this slice.

BootstrapCallerAssurance version1 requires canonical lower-case identity_id and strict boolean
authentication_mfa. That current-auth fact never substitutes for registered-factor evidence.
Optional email_verified preserves signed true/false/absence. Optional mfa_enrolled is present
if and only if enrollment_window is present; unknown is omission, never null or coerced false.
The window has only evaluated_at_ms, valid_before_ms and profile issuer-core-bounded-v1.
Its two nonnegative integer coordinates are at most 9007199254740991 on the declared Core axis,
under the sole additional payload timestamp exception in CONVENTIONS §3/§13/§15. Every other
timestamp/duration and Sunset HTTP-date/RFC rule remains unchanged. Both true and false facts
expire to omission, and the same token never gains a renewed window from a later arrival.

Schema structure does not prove customer lane, equality to identity_mapping, current issuer,
subject, signature, target, evaluated-before-expiry or any qualified interval/browser clock.
Actual registered-factor plus independent current-auth/contact evidence, the settled 330-second
limit, conservative nonextending mapping and effect/physical-commit acceptance remain held.
Current AMR or a /me flag alone cannot open that guard.

An unaffiliated intended prospect still receives403 from membership-bound /me. A later
prospect-assurance producer on this same bootstrap is an explicit separate source-contract
amendment, not fallback after a failed /me read. Eligible members invalidate/refetch /me on
refresh; every relevant readiness fact is invalidated and unknown/failed reads hold. Neither
branch may reuse an old proof after token/context retirement. C8 remains postconsume fresh
owner evidence only. P1, serving/copy, operator duties and mounted onboarding remain held.

## Changelog

- First version. Derives the staff-intake and first-owner-claim design from `FIRST_SLICE_SPEC.md`
  §P1 steps 1–5, clause by clause, and states the transaction, lock and audit boundaries between
  the three reviewed wire operations.
- Records §P1 step 6 as out of scope with OD-1, the unresolved conflict between `placeOrder`'s
  `staff_operator` grant plus `dpa_acceptance` body and step 6's rule that staff cannot submit the
  customer's signature.
- Records OD-2 (`closed` versus `terminated`, and whether `closing` exists) and OD-3 (slug 3–64
  versus 2–20) as open decisions with their owners and what each blocks, rather than picking a
  spelling or a boundary.
- Records in §11 that `FS-BOOT-06` is blocked on the absence of any second factor in the
  repository's local identity provider, and that the acceptance measures that absence against the
  real provider rather than asserting it.
- Records OD-1 and OD-3 as decided, as contract 0.10.0 carries them: `placeOrder` is `org_owner`
  only, which the lead decided under the owner's delegation (register ORDER-AUTH); and the
  organisation slug is 2–20 characters on every schema that carries it, whose minimum of two was
  the lead's own call, correcting its own earlier figure (register SLUG-MIN). OD-2 stays open.
- Records the owner's answer on OD-3's minimum, as contract 0.11.0 carries it: the organisation slug
  is 5–20 characters (register SLUG-MIN-ANSWER), superseding the lead's own call of two that the
  entry above recorded. §3.2's pointer and §10.2 carry the owner's minimum.
- Records the delegated Core consumer decision for first-owner assurance and reclassifies
  `FS-BOOT-06` as expected red at the real-provider second-factor gap. Keycloak production and
  evidence remain an SRE delivery task, not an owner decision.
- Aligns §2, §3.1 and §5.3 with ADR-0004 as accepted, which makes a realm change an infrastructure
  mutation and so a job. The intake creates the `realm_create` job and writes no separate outbox row
  for it: the `Job` row is the operation's outbox record, its dispatch record carries the provider
  correlation, and a lost provider response puts the job, not a delivery, in
  `needs_reconciliation`, which only an operator's recorded decision leaves. Outbox deliveries remain
  for this slice's messages and user-level identity operations.
- §5's heading drops "and its outbox", which no longer describes it, and §5.3 keeps "terminal": a
  correlation read that finds the realm absent counts only when the call is proven ended or a late
  landing converges.
- §8.1 states the organisation lock's mode and hold (exclusive, for the one transaction) and that the
  operation fails fast and is retried when the lock is busy.
- Amends the document for the invited pilot on the owner's decisions: the realm step is run by
  operator commands (§5.5) with a real, credential-free verify against the
  pinned trust entry, and the intended owner is bound by a separate operator command
  (`bind_intended_owner`, §5.6) with an operator-supplied subject; "ready" requires the issuer in
  `KODERA_AUTH_TRUST` (§5.4); the claim lifetime defaults to 72 hours and stays configuration, its
  link travels by Core email with the token in the fragment, and reissue and revocation are operator
  commands (§§6.4–6.6); the starter workspace is a separate idempotent step after the claim (§8.6);
  staff roles live in `StaffRole`, staff identities carry no organisation and staff actions require
  `amr` (§3.7); and intake waits for ADR-0015's cutover (§3.8). Records seven conflicts with
  existing text in §10.3, PC-1 to PC-7, and states what ratification requires (§1).
- Records the lead's rulings on PC-1 to PC-7, marking each departure from `AUTHZ.md`,
  `JOB_CATALOGUE.md` or the audit registry as a pilot deviation where it applies: operator commands
  run through `manage.py` under a named staff identity (§3.7); the realm step claims before
  any effect, and step 7 adds a manual test sign-in (§5.5); the registry admits a `staff`
  actor on three rows (`AUDIT_TAXONOMY.md` §3); each database waits for its own cutover (§3.8);
  `issuer_untrusted` and `requeue_realm_bootstrap` (§§5.4, 5.7).
- Records the lead's rulings on RP-1 to RP-3: the realm step is split into `start_realm_bootstrap`,
  which ends in the hold `awaiting trust entry`, and `complete_realm_bootstrap`, a reconciliation
  decision followed by the verify, so no lease spans manual work and a redeploy between them is
  safe; the sweep is the operator command `sweep_jobs`; `realm.verification_failed` admits a
  `staff` actor (§5.5, `AUDIT_TAXONOMY.md` §3).
- Applies the independent review (*ratify after fixes*) as the lead ruled it. B1: the owner's account
  carries no operator-known credential, bind, reissue and revoke follow a two-person rule, and the
  command's staff identity is stated as asserted, with Keycloak admin events and a one-line command
  record as compensation (§§3.7, 5.6). B2: bind, reissue and revoke take the organisation lock
  exclusively, change a claim only while `issued`, and one binding per intake is a constraint
  (§§5.6, 6.6; `JOB_CATALOGUE.md` §1). Also: the outbox mail sender gates the binding (§6.4);
  commands sweep first and re-enter idempotently (§5.5); expiry is computed on read (§6.5); fragment
  handling on the claim page (§6.4); one end condition for every pilot deviation (§10.3); the
  `StaffRole` contradiction is marked with `AUTHZ.md` §4 winning (§3.7); trust-list changes go
  through a reviewed pull request (§5.4); intake waits for a cutover declared final (§3.8).
- Applies the lead's last rulings on the review: the mail sender's credential comes from the
  deployment's secret store, and an ambiguous send is reconciled at-least-once, a resend being a
  reissue (§6.4); every realm step records its dispatch and holds before the tooling runs outside
  any lease, and the next invocation records its outcome, with the planned hold told apart by its
  operation reference and the test sign-in an explicit input (§5.5); the token crosses the sign-in
  redirect in `sessionStorage` only (§6.4); `StaffRole` is written only by `grant_staff_role` and
  `revoke_staff_role` under a two-person rule, after a one-time `bootstrap_staff_roles` that grants
  two distinct identities while the table is empty, and the staff issuer is a fixed setting (§3.7);
  binding and claim show `issuer_untrusted` as a reason (§5.4); §§2, 7.1 and 7.3 name the pilot's
  binding and the audit actions this slice writes.
- Applies the delta review's fixes as the lead ruled them: the intake recorder confirms out of band
  that the customer holds the owner account (`confirm_owner_contact`, `owner_claim.confirmed`), and
  the workspace waits for it; the admin events and command records go to the platform's log
  service, which the operator can still reach, so the confirmation is the effective control and a
  write-once store an end condition (§§3.7, 8.6, 8.7). `owner_claim.expired` is written by the first
  bootstrap command or read that observes the expiry, and `sweep_jobs` stays the queue's sweep
  (§§5.5, 6.5). Offboarding is one three-part checklist, and staff HTTP actions need a verified
  staff-realm token and an active `StaffRole` row (§3.7). The claim page and its callback carry a
  strict CSP (§6.4). Revocation deactivates a `StaffRole` row and never deletes it (§3.7).
- Applies a consistency review against `main` and Core #164, as the lead ruled it. The commands
  build their principal with a command-only `staff_principal_for_command(identity_id)` the API
  image does not carry, and PC-1 now names `STAFF_IDENTITY.md` §5 and `MODEL.md`
  `decided_by_identity_id`; the implementing change amends that section and
  `tests/test_staff_principal.py` (§3.7). The `AUTHZ.md` §4 box is replaced by `main`'s rule — the
  database grant is authoritative and token roles are never read — and `AUTHZ.md` §4's staff rows
  are aligned with its §3. The staff role commands are `STAFF_IDENTITY.md` §4's design of record,
  not a pilot deviation; `--staff-identity` takes the acting identity's id; commands run from a
  checkout against the Core database under `config.settings.job_queue`, behind
  `KODERA_INTAKE_ADMITTED`, and a deployed operator profile is owed (§§3.7, 3.8). A held claim
  mail is decided by a new command, `decide_claim_delivery`, under PC-1, and never returned to
  `pending`; the claim mail is `OUTBOX_MAIL_SENDER.md`'s `owner_claim`, one delivery per issued
  claim, and the claim lifetime is at most seven days (§§6.4, 6.5). `bind_intended_owner` checks
  the owner's address the operator gives, taken from the instruction ticket, against the intake's sealed
  contact, and states what it needs to send (§5.6). `requeue_realm_bootstrap` reads the
  organisation's latest job and derives its key from the replaced job (§5.7). The job's audit
  events keep the queue's actor (§5.5). `complete_realm_bootstrap` writes the realm's ready fact
  for discovery, which `issuer_untrusted` withdraws, as PC-8 (§§5.4, 10.3). Also:
  `409 slug-taken`, `403 mfa-required`, the instruction reference's pattern and the sealed contact
  (§§3.2, 3.5, 3.7); the reserved slugs decided (§10.2); the workspace specification linked
  (§8.6); `AUTHZ.md` §4 cited for the one path to first ownership (§8.4); §11 narrowed to the
  provider the packet boots; `OrganisationIntake` named (§2); `initialiseWorkspace` listed among
  the organisation lock's takers (`JOB_CATALOGUE.md` §1).
- Applies the second consistency review's text fixes: the operator profile reads
  `KODERA_INTAKE_ADMITTED` and `KODERA_CONTACT_SEAL_KEY` as the API's does (§3.8); the owner's
  address reaches `bind_intended_owner` on standard input and is never printed, and its comparison
  is stated as a check on the operator's input, not on the account (§5.6); `decide_claim_delivery`
  refuses a target read that does not name the delivery's `Message-ID`, and its sweep is the
  delivery sender's (§6.4); the sender's refusals cite the code (§5.6).
- Lists as PC-9 the deviation from ADR-0006 that the custodian's review found unlisted: under the
  pilot, the identity operator's tooling, not the worker, creates the realm and applies template
  changes, and the realm is created at intake rather than with the organisation's first tenant
  (§§5.5, 10.3).
- Applies the custodian's review at `2bbe4e4`: ADR-0015 cited beside ADR-0006 in PC-9; PC-10
  lists `owner_claim.confirmed`; the realm's mail is the identity service's domain, as ADR-0014
  says before a first shared tenant, and the required-actions email is sent and resent by the
  tooling (§5.6); `notify.*` is a prerequisite of the first pilot organisation (§6.4); the admin
  events and their shipping are owed by the identity operator (§3.7); the identity operator
  declares a cutover final and runs the commands from a workstation through a tunnel until a Core
  server exists (§3.8).
- Applies the owner's two K7 reconciliation rulings: step 7's planned trust hold uses the
  trust-deployment completion record as compute evidence; the readiness fact is recorded
  separately before job completion and counts only for the latest succeeded job while trusted.
  Missing trust remains a definite mismatch. Records the implemented intake, status, workspace,
  sender and operator-realm parts without claiming owner binding/claim consumption are built.
- §7.3 follows contract 0.28.0: a verified customer token with no `Identity` is
  `403 identity-unknown`, not `401`; authentication itself is unchanged and creates nothing.
- §5.6 rule 1 follows the identity tooling's 72-hour set-up link (identity realm tooling #84): the first
  link expires before the claim only by the minutes before the binding, a late owner gets a resend
  and then a reissued claim, in that order, the operator binds only once the mail is recorded as
  sent, and the tooling's fixed 72 hours must be changed with the claim's configured lifetime.
