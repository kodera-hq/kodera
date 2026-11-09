# Staff identities and staff role grants

**Status:** Proposed · **Owner:** API seat

How Core stores a staff person's identity and the staff roles granted to it. [`../api/AUTHZ.md`](../api/AUTHZ.md) is the authority this document implements: staff authenticate against the staff realm `kodera-staff` with MFA (§3), and staff roles "are stored on … `StaffRole` (staff side)" (§4), the database being authoritative so that a revocation takes effect on the next request (§2, step 7). A staff token proves who the staff person is; it grants no role.

What this document builds: the stored staff identity, the `StaffRole` grant, the readers that keep the two apart from customer reads, the operator commands that write grants, and the staff principal, resolved from a verified staff token, that the job queue's decisions take ([`JOB_QUEUE.md`](JOB_QUEUE.md) §4, §5.4). What it does not build: any HTTP operation, and so no request authenticator: whatever verifies a staff request's token calls the resolver of §5.

## 1. The staff identity

A staff identity is an `Identity` row with **no organisation**. Before this change `Identity.organisation` was not null, and the composite binding `identity_organisation_binding_fk` (`organisation_id, issuer, realm` → the organisation's) tied every identity to a customer organisation, so no staff identity could be stored, while the job queue's decision tables already name the deciding staff identity by a restrictive foreign key to `Identity` (`decided_by_identity_id`, [`../domain/MODEL.md`](../domain/MODEL.md)).

- `Identity.organisation` is nullable. A customer identity keeps its organisation and its composite binding: PostgreSQL does not check a foreign key one of whose columns is null (`MATCH SIMPLE`), so the binding holds exactly the rows that have an organisation.
- `identity_staff_realm_valid`: an identity with no organisation is in the staff realm, `kodera-staff`.
- `identity_staff_issuer_valid`: an identity with no organisation has an issuer of 1 to 2,048 characters ending `/realms/kodera-staff`, the rule `organisation_issuer_valid` applies to an organisation.
- `organisation_realm_not_staff`: no organisation's realm is `kodera-staff`. With the composite binding, a customer identity is therefore never in the staff realm: an identity is a staff identity exactly when it has no organisation, and exactly when its realm is `kodera-staff`.
- The staff realm's **name** is a constant (ADR-0006; ADR-0015 changes no realm name), so the database checks it. Its **issuer** is one fixed settings value per environment, `KODERA_STAFF_ISSUER`: an `https` URL of at most 2,048 characters whose path ends `/realms/kodera-staff`, refused at start otherwise; a loopback host (`localhost`, a name under `.localhost`, a loopback or unspecified address), or `http` on a loopback host, is admitted only when the selected settings module is `config.settings.e2e` or `config.settings.e2e_operator`, the local end-to-end stack's API and operator profiles (`LOOPBACK_PROFILES` in `config/environment.py`, read into `KODERA_LOOPBACK_ISSUERS`), and refused by every other profile, `config.settings.customer_http` and `config.settings.job_queue` included: every issuer of `KODERA_AUTH_TRUST` is held to the same rule, because the local fixtures' keys are derived from public labels; and refused at start too unless it is an issuer of the `staff` lane of `KODERA_AUTH_TRUST` (`config/environment.py`), so that the one issuer whose tokens can resolve a staff principal is one whose tokens verify. Unset, there is no staff issuer, and no role can be granted nor principal resolved. The database checks only that a staff identity's issuer names the realm; the exact issuer is checked by the commands (§4), which store only identities of it, and by the staff principal (§5). `config.settings.test` fixes it to a synthetic issuer.
- The existing guards hold for staff identities unchanged: the binding is immutable (`identity_immutable_binding`, so a staff identity never gains an organisation and a customer identity never loses one), `(issuer, subject)` and `(issuer, user)` are unique, and an identity is never deleted (`identity_delete_refused`).
- The authority-revision triggers of [`member-authority-revision.md`](member-authority-revision.md) fire on a staff identity's writes as on any identity's, and are not changed. Every organisation they lock or touch is selected by `organisation_id`, which is null for a staff identity, and a comparison with null selects no row: writing a staff identity locks and advances no organisation's revision. The parent `User` is still versioned, so a person who also holds customer memberships has those organisations advanced conservatively, which that specification permits.

## 2. The role grant

`StaffRole` grants one staff role to one staff identity.

| Column | Rule |
|---|---|
| `identity_id` | The staff identity. With `realm`, the key of `staffrole_staff_identity_fk` → `identity_identity(id, realm)`, unique there as `identity_realm_binding_unique` |
| `realm` | Always `kodera-staff` (`staffrole_realm_valid`). It is what makes the foreign key refuse a customer identity: a grant names an identity *and* the staff realm |
| `role` | `staff_operator`, `staff_support` or `staff_security`, ADR-0010's closed staff set (`staffrole_role_valid`) |
| `created_at` | When the grant was made |
| `revoked_at` | Null while the grant is current; set once, never earlier than `created_at` (`staffrole_revocation_valid`) |

- One current grant per identity and role (`staffrole_one_current_grant`, a unique index over the rows not revoked). A role revoked and granted again is a second row.
- A grant is retained and immutable: the row trigger `a_staffrole_change` refuses a `DELETE` (`staffrole_delete_refused`), a change of `id`, `identity_id`, `realm`, `role` or `created_at` (`staffrole_immutable_grant`), and any change of `revoked_at` once set (`staffrole_revocation_final`). The table is its own history of who held which role when.
- `TRUNCATE` passes a row trigger. It is refused by privilege, as JOB_QUEUE.md §3.2 says for the queue's tables: the production role holds no `TRUNCATE` privilege on `identity_staffrole`, and there is no `BEFORE TRUNCATE` trigger, which would break a test database's flush. That privilege is what keeps the bootstrap's "once, ever" (§4) true: an emptied table would admit a second bootstrap.
- A grant carries no organisation. Staff roles do not imply tenant roles, and no staff role creates a customer membership (AUTHZ.md §4).
- Every grant and revocation is also an audit row (§4).

## 3. Readers

- The customer readers `current_identity` and `person_identities` (`apps/identity/selectors.py`) read identities that have an organisation and nothing else. A staff token therefore resolves to no customer person. Every customer read (`getMe`, the organisation, its memberships and notice contacts, the workspace and its structure, billing and the DPA) refuses a staff token `403 forbidden` before it reads any customer row, as it did before contract 0.28.0. `getOrganisationBootstrap` and `consumeOwnerClaim` keep their own staff rules, a `401` included where one applied. A staff token is never answered `403 identity-unknown`, which is for customer identities only (`../api/AUTHZ.md` §2 step 6). `IdentitySnapshot.organisation_id` stays a non-null UUID.
- `current_staff_identity(issuer, subject)` reads the staff identity of that key, enabled and not deleted, with its person enabled and not deleted, or nothing. It reads no role.
- `current_staff_grant(identity_id, role)` returns the id of that identity's grant of that role that is not revoked, of an enabled, not deleted staff identity of an enabled, not deleted person, and locks the grant's row `FOR SHARE` until the caller's transaction ends; or nothing. A revocation that starts after the read waits for the caller to finish, and a revocation that committed before it, or that holds the row when the read arrives, is seen: the read waits for it, then finds the grant revoked. Its keyword switches exist for the job queue's mutant flags only ([`JOB_QUEUE.md`](JOB_QUEUE.md) §9.2); every other caller leaves them off.

## 4. Operator commands

There is no HTTP operation for staff identities or grants, and the API image carries neither the commands nor the migrations. An operator runs them from a checkout of this repository, with the API's database and `--settings config.settings.job_queue`, the profile that installs the audit application; under a profile without it, every command is refused before any write.

```text
manage.py bootstrap_staff_roles --operator <sub> <address> --operator <sub> <address>
manage.py grant_staff_role  --staff-identity <acting identity id> --subject <sub> --role <role> [--email <address>]
manage.py revoke_staff_role --staff-identity <acting identity id> --subject <sub> --role <role>
```

Every subject is one of the staff issuer `KODERA_STAFF_ISSUER`; with it unset, every command is refused. Set, it must also be on the `staff` lane of `KODERA_AUTH_TRUST`, or no settings profile starts. Each refuses, before any write, a role outside the staff set and a subject that cannot be stored.

- **The bootstrap, once.** `bootstrap_staff_roles` succeeds only while `StaffRole` holds no row at all, revoked or not, and is refused forever after. It takes exactly two distinct subjects, stores each staff identity and its person when none exists, refusing a disabled or deleted one, and grants each `staff_operator`, all in one transaction that first locks `StaffRole` against a concurrent bootstrap: two operators or none.
- **Two people for every later change.** `--staff-identity` names the acting staff identity, which must have the staff issuer, be enabled, of an enabled person, and hold a current `staff_operator` grant, which the transaction locks; and it must not be the identity whose grant changes. A staff identity grants itself nothing and revokes nothing of its own.
- **What `--staff-identity` proves.** Nothing cryptographic: it is asserted by whoever has shell access to run the command, and no token is verified. For the pilot the two-person rule is procedural: the acting operator runs or witnesses the command, and the audit row names them. Binding it to an authenticated staff session belongs to the HTTP operation that will replace the command.
- **Lock-out and recovery.** Every later change needs an enabled current operator other than the target. If every operator is disabled, deleted or revoked, no command can grant again and the bootstrap stays refused: the system is locked out. Recovery is privileged SQL on the database, done by the identity operator and the product owner, both present, and recorded where the change was made.
- **Concurrency.** A grant, a revocation or a bootstrap that a concurrent change of the same rows makes the database refuse — a unique key met, a deadlock, a serialisation failure, a lock not available — is reported as "a concurrent change refused this; run it again", with nothing written. Any other database error is not reworded.
- `grant_staff_role` stores the grantee's staff identity and its person first when none of that subject exists, which needs `--email`, and refuses a disabled or deleted one. A role already held is reported, neither granted twice nor audited.
- `revoke_staff_role` sets `revoked_at` on the current grant of that role, enabled identity or not, and refuses when there is none.
- **Audited.** Each grant writes `staff_role.granted`, each revocation `staff_role.revoked` ([`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md) §3), in the transaction of the change: a fleet-level row with no organisation, the target the grantee's identity, `metadata.role` and `metadata.grant_id`. The actor is the acting staff identity, or, for the bootstrap, the system, with `metadata.reason` `bootstrap`.
- The output names the role and the identity's or grant's id, never the subject or the address.

## 5. The staff principal

`apps.identity.staff.resolve_staff_principal(verified, lane)` is the request path's only way to build a `StaffPrincipal`. `verified` and `lane` are what `verify_configured_token` returns for a request's bearer token; `verified` must be exactly a `VerifiedAccessToken`, whose sole producer is the verifier of `services.identity.access_tokens`, so a subclass or a look-alike object is refused. It refuses with `StaffPrincipalError`, one closed error whose message names no reason, unless every one of these holds:

1. `lane` is `staff`;
2. the token's issuer is exactly the one staff issuer, `KODERA_STAFF_ISSUER` (§1). The lane comes from the trust configuration and the issuer from this setting, and the two checks are separate: a staff-lane issuer that is not the staff issuer is refused, and so is the staff issuer paired with another lane;
3. the token's `amr` contains `otp`, `hwk` or `mfa`, compared exactly — `OTP` or ` otp` is not `otp` (AUTHZ.md §3: a staff token without a second factor is refused whatever the realm says);
4. its `(iss, sub)` is a stored staff identity that `current_staff_identity` reads, so enabled, of an enabled person.

The token's roles are never read: a token of a customer realm that names `staff_operator` builds no principal at the first check, and a staff token that names it grants nothing. The principal carries the identity's id and its issuer, and no role.

For the invited pilot only, ratified [`FIRST_OWNER_BOOTSTRAP.md`](FIRST_OWNER_BOOTSTRAP.md) §3.7,
PC-1 permits `apps.identity.command_principal.staff_principal_for_command(identity_id)` outside
the API image. It accepts a UUID naming an enabled, non-deleted stored staff identity of the one
configured staff issuer, with an enabled, non-deleted person. The database operator asserts that
identity; there is no token or `amr` proof, and no role is carried. This exception ends when the
commands carry staff device-authorisation tokens, when the identity worker ships, or before the
first paying customer, whichever comes first. Every operation still checks its current grant.

- **Construction is private.** Calling `StaffPrincipal(...)` raises `TypeError`; the resolver builds an instance without calling it. An instance cannot be changed, copied into another, or serialised. `is_staff_principal(value)` is true for exactly that class.
- **The role is read where it is used, and held while it is used.** A staff role is a current `StaffRole` grant (§2), and an operation that needs one reads it itself with `current_staff_grant`, in its own transaction, which also requires the identity and its person to be enabled and not deleted then, and locks the grant until the transaction ends. A principal resolved before its grant was revoked, or before its identity or person was disabled or deleted, therefore authorises nothing; and a revocation racing an operation either waits for it to commit or is seen by it, never neither. The job queue's two decision functions do so for `staff_operator` (`role_missing`, JOB_QUEUE.md §5.4), and raise `TypeError` for any principal `is_staff_principal` refuses, before anything else.
- **The grant relied on is recorded.** A job's decision names the grant it read in its audit row, as `metadata.staff_role_grant_ref` of `job.reconciliation_decided`: the decision table has no column for it, and adding one is a migration this change does not make. A delivery's decision names it the same way, as `metadata.staff_role_grant_ref` of `outbox_delivery.reconciliation_decided` (JOB_QUEUE.md §7).

## 6. Acceptance

`tests/test_staff_identity.py`, against the migrated tables: each constraint and trigger above refuses by its name, with a positive control beside it; the customer readers do not return a staff identity; the staff reader refuses each disabled or deleted state; a staff identity's writes leave every organisation's authority revision unchanged; the staff issuer setting's admitted and refused values, including an issuer missing from the trust's staff lane, and a settings profile that refuses to start with one; and each command's refusals and effects — the bootstrap once and only for two, all or nothing; each acting identity that is not a current operator, and itself; the audit rows; each concurrent refusal reported with nothing written, and another database error not reworded. `tests/test_customer_persistence_migrations.py` applies, reverses and reapplies `identity.0003` and `orgs.0006` with the other customer migrations.

`tests/test_staff_principal.py`: the resolver refuses each case of §5's four checks — among them a subclass of the verified token, the staff issuer with a trailing slash, `amr` of `OTP` or ` otp`, a deleted staff identity — and an object it did not build; it resolves a stored staff identity; a principal cannot be built by calling the class, changed, copied into another or pickled; both decision functions raise `TypeError` for a look-alike object before any statement; each of the resolver's refusal clauses, deleted alone from its source, makes its own case resolve, and so does the exact-class check written as `isinstance` for the subclass, and `pwd`, `OTP` or ` otp` added to `MFA_METHODS` for its own case, which proves each case can fail. Two tests run a delivery decision and a revocation on two sessions: a revocation that starts after the decision read the grant waits for the decision, which is recorded; a decision that reads while a revocation holds the grant waits for it and is refused `role_missing`. Through the job queue, A3-31 (`JQ-P33`, JOB_QUEUE.md §9) shows the resolver's refusals at a decision, principals resolved and then revoked, disabled or deleted, and the grant named in each decision's audit row, a job's and a delivery's, with a mutant row for each clause of the grant read and for each audit row's grant.

The command-only constructor has its own predicate-removal and UUID input proofs in
`tests/test_staff_principal.py`. `tests/test_development_boundary.py` reads the effective API
image inputs and refuses each restored operator module, including the principal constructor.

## Changelog

- Reconciles the principal constructor description with the ratified command-only pilot exception;
  adds predicate-removal proofs and explicit effective-image exclusion proofs for that constructor.

- First version: the stored staff identity (nullable `Identity.organisation`, the staff-realm checks, no organisation in the staff realm), the `StaffRole` grant, the customer and staff readers, and the operator commands: a one-time bootstrap of two operators, then two-person grants and revocations, each audited, all of the one fixed staff issuer.
- §5, the staff principal: resolved only from a staff-lane token of the one staff issuer with a second factor, for a stored staff identity; no role carried, the grant read where it is used; the job queue's decisions take it and nothing else.
- A delivery's decision names the grant it relied on in its audit row, `outbox_delivery.reconciliation_decided` (JOB_QUEUE.md §7), as a job's does.
- §3 says what a staff token on a customer read is answered: `403 forbidden`, as before, never contract 0.28.0's `403 identity-unknown`.
