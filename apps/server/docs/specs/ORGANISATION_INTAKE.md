# Organisation intake

**Status:** Proposed, built against the pilot amendment ratified on Core #154 · **Owner:** API seat

`createOrganisation`, `POST /api/v1/organisations`: the staff intake of
[`FIRST_OWNER_BOOTSTRAP.md`](FIRST_OWNER_BOOTSTRAP.md) §3, as amended for the invited pilot and
ratified on Core #154, which authorises its implementation. If the amendment changes, this changes
with it.

This document states what is implemented and where it departs from the amendment. It decides
nothing the amendment leaves open.

## 1. What a request goes through, in order

1. **The bearer token** is verified against `KODERA_AUTH_TRUST`. No token, or one that does not
   verify: `401 unauthenticated`.
2. **The staff principal** (§3.7 of the amendment, [`STAFF_IDENTITY.md`](STAFF_IDENTITY.md) §5).
   A customer-lane token is `403 forbidden`, whatever roles it names: a staff role is never read
   from a token. A staff-lane token of an issuer other than `KODERA_STAFF_ISSUER` is `401`. A
   staff token whose `amr` names none of `otp`, `hwk`, `mfa` is `403 mfa-required` with
   `required_amr`, and is audited `authz.denied` (`metadata.reason` `mfa_missing`) when it names a
   stored staff identity. A token that resolves no enabled stored staff identity is `401`. A staff
   identity with no current `staff_operator` grant is `403 forbidden`, audited `authz.denied`
   (`role_missing`). Each denial row is written in a transaction of its own, fleet-level, with the
   target `urn:kodera:organisation:*`: the refusal precedes any organisation, and the body of a
   refused request is not read.
3. **The intake gate** (§3.8). The intake is refused `503 intake-closed` unless
   `KODERA_INTAKE_ADMITTED` is `1`, a contact seal key is configured, and the staff issuer is set.
   `KODERA_INTAKE_ADMITTED` is read once at start: unset, empty or `0` closes the gate, `1` opens
   it, and any other value stops the process. `config.settings.test` opens it, because the test
   database is disposable; the end-to-end stack (`dev/e2e/compose.yaml`) opens it for the same
   reason. Every other profile leaves it closed until whoever declares a database's ADR-0015
   cutover final sets it. The refusal is not stored, so the same key works once the gate opens.
4. **The replay store** ([`IDEMPOTENCY_REPLAY.md`](IDEMPOTENCY_REPLAY.md)): `Idempotency-Key` is
   required, and every answer below is stored and replayed byte for byte for 24 hours.
5. **The body**, inside the store's transaction. Not one JSON document — invalid UTF-8, a
   syntax error, a duplicate member, `NaN` — is `400 malformed-request`. Every member of
   `OrganisationCreateRequest` is checked as the contract declares it, `additionalProperties:
   false` at the top and on `intended_owner` included, so a body naming a membership, a role, a DPA,
   terms or an order is `422 validation-error` with one `errors[]` entry per failure, each a JSON
   Pointer and a code (`required`, `unexpected`, `type`, `pattern`, `min_length`, `max_length`,
   `format`, `enum`, `max_items`, `invalid`, `reserved`). The slug must match the 5–20 rule and is
   refused `reserved` when it is one of the closed list `master`, `kodera-staff`, `kodera-probe`,
   `kodera-dev`, `kodera`, `staff`, `admin`: `master` would name Keycloak's administration realm
   (`<idp>/realms/master`), `kodera-staff` is the staff realm, `kodera-probe` the realm of the studio's
   other applications, `kodera-dev` the lab realm on staging, and the last three would read as the
   platform's own; since contract 0.22.0 the list also holds the platform labels of `kodera.io`,
   `notify`, `staging`, `status`, `support`, `billing`, `console`, `developers`, `matrix`,
   `auth-admin` and `auth-mail` ([`ESPACE_STRUCTURE.md`](ESPACE_STRUCTURE.md) §8), and since
   contract 0.39.0 the platform hosts `errors` and `ops-admin`. The database
   refuses the same list (`organisation_slug_not_reserved`, beside
   `organisation_realm_not_staff`). Since contract 0.29.0, any otherwise valid slug beginning
   `synth-` is also `422 reserved`: Path K synthetic realms stay outside Core, and ordinary
   intake has no synthetic exception. `synth`, `synth0-a`, `synthesis` and `acme-pilot` remain
   ordinary names. Format failures still precede reservation checks. The database independently
   refuses the prefix (`organisation_slug_not_synthetic`, `orgs.0015`/`0016`); the migration
   stops on an existing holder without renaming it, adds the check `NOT VALID`, then validates
   separately under finite timeouts. `instruction_ref` must be a ticket reference,
   `^[A-Z]{2,8}-[0-9]{1,8}$` such as `SUP-0418`, so no contact can be pasted there in clear; the
   database refuses any other shape (`intake_instruction_ref_valid`). `name` must hold at least one
   character, which the database requires.
6. **The grant again.** `current_staff_grant` is read in the store's transaction and locked
   `FOR SHARE` until it commits, so a revocation either waits for the intake or is seen by it. A
   grant revoked since step 2 rolls everything back and answers `403 forbidden`, unstored.
7. **The effect**, one transaction (§3.1):
   - the organisation is created `prospect`, its realm the slug, its issuer the staff issuer's
     origin with `/realms/<slug>` (one identity provider for every realm, ADR-0006 and ADR-0015);
   - the slug is reserved, `provisional`, by a `SlugReservation` row;
   - a slug already held is refused by the database's unique constraints
     (`organisation_issuer_unique`, `reservation_namespace_slug_unique`) inside a savepoint, never
     by a read before the write (§3.2), and answers `409 slug-taken`;
   - the `realm_create` job is enqueued with `enqueue_job` (actor `staff`, the recorder), its seven
     steps and its `job.created` row; its idempotency key is derived as
     [`JOB_QUEUE.md`](JOB_QUEUE.md) §3.4 says, from the recorder's URN, `POST`, the path,
     `realm_create`, the client key and `0`;
   - `organisation.intake_recorded` is written inside the job's `apply_desired_state`, actor the
     recorder, target the organisation's slug, `metadata.instruction_ref` and nothing else;
   - the `OrganisationIntake` row records the recorder, the instruction reference, the job, the
     masked owner address, and the sealed contact.
   No membership, identity or claim is created, and no outbound call is made (§3.3, §3.4).
8. **The answer**: `201` with `OrganisationIntakeResult` and `Location`. `organisation` carries
   `id`, `slug`, `name`, `state`, `realm` (null: the realm does not exist yet), `created_at` and
   `updated_at`. `bootstrap` reports the realm `pending` with its `job_id`, the identity mapping
   `pending` and the claim `not_issued`.

**Repeating an intake** (§3.6). Within 24 hours the store replays the first answer. After its
entry expires, the same principal sending the same key reaches the effect again, which finds the
job its key derived and answers the same organisation and job, writing nothing; the same key with
another slug is `409 idempotency-key-reuse`. A new key for a slug already held is the `409` above.
So no intention ever reserves a second slug or enqueues a second job.

## 2. The intake record

`orgs.OrganisationIntake`, table `orgs_organisationintake`, migration `orgs.0007`:

| Column | Rule |
|---|---|
| `organisation_id` | Unique, `intake_organisation_fk` → `orgs_organisation` |
| `recorded_by_identity_id`, `recorded_by_realm` | `intake_recorder_staff_fk` → `identity_identity(id, realm)`; the realm is `kodera-staff` (`intake_recorder_staff_realm`), so no customer identity can be the recorder |
| `instruction_ref` | A ticket reference, `^[A-Z]{2,8}-[0-9]{1,8}$` (`intake_instruction_ref_valid`) |
| `sealed_contact` | The intended owner's address and name, and the optional profile members below, sealed |
| `intended_owner_email_masked` | The first and last character of a local part of three characters or more, `***` alone for a shorter one, and the domain: the contract's `intended_owner_email_masked` |
| `bootstrap_job_id` | The `realm_create` job of the same transaction, unique. No foreign key: `apps.jobs` is installed by profiles `orgs` migrations must not depend on |

The trigger `a_organisation_intake_change` refuses any `UPDATE` or `DELETE` (`intake_immutable`).

**Sealing.** `core/sealing.py` is the outbox's construction (AES-256-GCM, a fresh 96-bit nonce,
a version byte) with the payload and associated data left to the caller. The intake seals under
`KODERA_CONTACT_SEAL_KEY`, 32 bytes in URL-safe base64, read once at start; a malformed value
stops the process. The associated data is `kodera-organisation-intake:` and the row's id, so a
sealed value moved to another row does not open. The address appears in no other column, no audit
row, no problem document and no stored response.

## 3. Where this departs from the amendment, the model or the contract

- **The contact is on the intake, not in `Contact`.** The amendment (§3.5) keeps it sealed on the
  intake record until a `Contact` record exists, as this route does; the contract still says the
  address is stored encrypted "with the other `Contact` rows", and `MODEL.md` gives the intake an
  `intended_owner_contact_id`. No `Contact` table exists, and its `kind` set has no member for an
  intended owner. The sealed column stands in for it until one does.
- **The profile members are sealed, not stored.** `legal_name`, `country`, `vat_number`, `siren`,
  `billing_email`, `billing_address`, `email_domains` and `locale` are accepted and validated as the
  contract declares, but `Organisation` has no columns for them yet (`MODEL.md`, "What the first
  persistence slice stores"). They are sealed with the contact as received, so nothing staff typed
  is dropped, and `organisation` in the answer carries none of them.
- **Resolved by contract 0.14.0 (#165, merged).** The operation's `503` (`intake-closed`), the
  `409` problem type `slug-taken`, the `reason` and `required_amr` members of `Problem`, the
  reserved slug list, the `instruction_ref` pattern and `name`'s `minLength` were each a
  disagreement between this route and contract 0.13.0. Contract 0.14.1 states in the present tense
  that the database refuses the reserved names, which `orgs.0008` here makes true.
- **The realm never reads `ready` here.** The answer derives the realm's state from the job:
  `queued` is `pending`, `failed` and `cancelled` are `failed`, and every other status is
  `running`. `ready` needs the trust-list condition of §5.4, which the bootstrap view applies.
- **Staff denials are audited only for stored staff identities**, because `authz.denied` names an
  actor; a token naming no stored identity is `401` and leaves no row.
- **The replay store's purge is batched, not scheduled.** `purge_idempotency` exists
  (IDEMPOTENCY_REPLAY.md §2.7) and runs from an operator's checkout, not from the image; until an
  operator schedules it, expired entries wait for their key or for a run.

## 4. The API image

The intake is the first route that enqueues a job and answers a `POST`, so
`config.settings.customer_http`, the profile the image starts, installs `apps.jobs`, `apps.audit`
and `core.idempotency` (JOB_QUEUE.md §3.1, IDEMPOTENCY_REPLAY.md §2.1), and reads
`KODERA_INTAKE_ADMITTED` and `KODERA_CONTACT_SEAL_KEY`. It installs no `apps.outbox`: the
intake imports the queue's enqueue path alone (`apps.jobs._enqueue`), not `apps.jobs.services`,
whose decision functions import the outbox. `.dockerignore` admits only the modules that path, the
audit writer, the replay store, the staff principal and the intake import — no migration, command,
template, outbox or decision module — and excludes `config/settings/test.py`, the one profile that
permits the job queue's mutant flags. `tests/test_development_boundary.py` holds the allowlist
exact, refuses the test profile in the image, and starts the profiles from those files alone.

### The database role

The API role needs these grants to record an intake, on top of the customer reads' `SELECT`s
(`dev/accept_customer_http.py` `provision_reader`). `dev/api_writer_role.py` is the one list;
`tests/test_intake_writer_role.py` creates a role holding exactly it, records, replays, refuses and
audits an intake as that role through the real view, and shows it refused by privilege on every
write below that it does not hold.

| Privilege | Tables | Why |
|---|---|---|
| `SELECT` | `identity_user`, `identity_identity`, `identity_staffrole`, `orgs_organisation`, `orgs_membership`, `orgs_slugreservation`, `orgs_organisationintake`, `jobs_job`, `jobs_jobstep`, `audit_auditevent`, `idempotency_record` | The staff principal and its grant, the earlier intention, the replay entry, `RETURNING` of database defaults, and the deferred owner and reservation checks at commit |
| `INSERT` | `orgs_organisation`, `orgs_slugreservation`, `orgs_organisationintake`, `jobs_job`, `jobs_jobstep`, `audit_auditevent`, `idempotency_record` | The rows one intake writes |
| `UPDATE (created_at)` | `identity_staffrole` | `SELECT … FOR SHARE` of the grant needs `UPDATE` on one column; `created_at` is one `staffrole_immutable_grant` refuses to change. `revoked_at` is never granted |
| `UPDATE (owner_guard_revision)` | `orgs_organisation` | Written by the reservation's insert trigger, which runs with the invoker's rights |
| `UPDATE (lock_requested_at)` | `jobs_job` | The enqueue's placement of a job claimable now |
| `DELETE` | `idempotency_record` | An expired replay entry is replaced when its key returns |

Refused by privilege, and tested: revoking, deleting, truncating or inserting a staff grant;
changing an identity, an intake, an audit row, an organisation's state or a job's status; deleting
an intake or an audit row; inserting a membership. No CI job applies these grants to a live
database; provisioning the role is the operator's, from this list.

The same role serves `getWorkspace` and `initialiseWorkspace`, and `dev/api_writer_role.py` holds
their grants too: `SELECT` on the five workspace tables, `INSERT` on `workspaces_workspace`,
`workspaces_resourcepolicy`, `workspaces_category` and `workspaces_channel`, and
`UPDATE (default_policy_id)` on `workspaces_workspace`; the job, audit and replay grants above
already cover the rest ([`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md) §9).

It also serves `getMembership`, `changeMembershipRole` and `removeMembership`: `UPDATE (role, state,
updated_at)` on `orgs_membership`, and the two columns the membership authority triggers write with
the invoker's rights, `UPDATE (enabled)` on `identity_user` and `UPDATE (authority_revision)` on
`orgs_organisation` ([`MEMBERSHIP_LIFECYCLE.md`](MEMBERSHIP_LIFECYCLE.md) §7). The `enabled` grant
also lets the role disable or re-enable a person; narrowing it is that section's follow-up.
It also serves the Agent API's member-set command loop (getCommands, ackCommand,
reportCommandResult; [ADR-0016](../adr/0016-engines-and-permission-intents.md)): `SELECT` on
`engine_intents_credential`, `engine_intents_head`, `engine_intents_member_set` and
`engine_intents_command`, `INSERT` on `engine_intents_command`, `UPDATE (last_seen_at, last_boot_id)`
on `engine_intents_credential`, and `UPDATE (state, dispatched_at, accepted_at, finished_at,
error_code, artefacts)` on `engine_intents_command`; the audit grant above covers the result's row.
`tests/test_engine_intents_writer_role.py` runs the loop through the real views as that role and
shows it refused any change to or deletion of a recorded set, subject or head row (beyond the
head's revision), any other change to a credential or a command, and any change to the audit row.
The membership operations record the next member set (`MEMBERSHIP_LIFECYCLE.md` §6): `INSERT` on
`engine_intents_head`, `engine_intents_member_set` and `engine_intents_known_subject`, `SELECT` on
the last, `UPDATE (revision, refused_at, refused_problem)` on `engine_intents_head`, and the command grants
above;
`tests/test_membership_writer_role.py` runs them as the role.

Residual risk: the role that serves the agent endpoints also records sets, so separating the agent
surface from the emitter is not a privilege boundary. A compromise of the API role can insert a
forged set or push the head to the maximum revision, after which agents ignore every genuine set.
Moving emission behind a trigger or a `SECURITY DEFINER` function owned by another role closes it,
and is not built yet.

It serves `createSupportTicket` ([`SUPPORT_TICKETS.md`](SUPPORT_TICKETS.md)): `SELECT` on
`tenancy_tenant` and `support_supportticket`, and `INSERT` on `support_supportticket`. No column of a
ticket is granted for `UPDATE` and none is deleted: its mail mark is the operator's to set.
`tests/test_support_writer_role.py` runs it as the role and shows it refused any change to or
deletion of a ticket.

It serves `createTenant` ([`QUICK_WORKSPACE.md`](QUICK_WORKSPACE.md) §4): `INSERT` on
`tenancy_tenant`, `legal_dpa` and `legal_acceptance`, `UPDATE` on the `legal_dpa` columns the DPA's
preparation and acceptance set, and `SELECT` on `billing_pack` and `billing_capacitytier`. For the
workspace guard it reads `legal_legaldocument`, and `legal_acceptance` by column only: what was
accepted, for which tenant and DPA, never who accepted it or from where.
`tests/test_workspace_writer_role.py` runs both as the role.

And it serves `getNoticeContacts` and `patchNoticeContacts`: `UPDATE (security_contact_email,
privacy_contact_email, subprocessor_notice_email, updated_at)` on `orgs_organisation`
([`ORGANISATION_NOTICE_CONTACTS.md`](ORGANISATION_NOTICE_CONTACTS.md) §4).

It serves the structure administration of contract 0.22.0 ([`ESPACE_STRUCTURE.md`](ESPACE_STRUCTURE.md)
§11): `INSERT` on `workspaces_resourcepolicyrule` and `workspaces_channelnotice`, `SELECT` on the
latter, `DELETE` on `workspaces_category` and `workspaces_resourcepolicyrule`, and `UPDATE` on the
named columns of `workspaces_workspace`, `workspaces_category`, `workspaces_channel` and
`workspaces_resourcepolicy` that section lists; `tests/test_workspace_writer_role.py` runs it as the
role and shows a channel's kind and room state, a notice, a policy's deletion and the immutable
bindings refused.

## 5. Acceptance

`tests/test_organisation_intake.py`, against the test database through the real resolver, the
production verifier and the replay store:

| Check | What it shows |
|---|---|
| One transaction | A `201` leaves one `prospect` organisation, its provisional reservation, one queued `realm_create` job with seven steps, `organisation.intake_recorded` then `job.created` by the recorder, one intake, and no membership or customer identity |
| Sealed contact | The address opens from `sealed_contact` under its key and the row's id, under no other id, and is in no audit row and no stored response |
| Replay | The same key and body replay the answer byte for byte and enqueue nothing |
| Stable operation reference | The committed `201`, its replay, a delayed replay and a retry after receipt expiry carry the one `realm_create` job key as `X-Operation-Ref`; an in-flight contender carries the same prospective value |
| Reference isolation | The same client key under two staff identities produces two references; a forced advisory-key collision returns the contender's reference, never the lock holder's |
| Response precedence | Malformed, invalid and changed-body contenders receive the prospective reference while the winner is in flight; executed/replayed malformed or validation responses, key reuse, slug conflict, authorization refusals and `5xx` are headerless |
| After expiry | The same key reaches the same organisation and job; with another slug it is key reuse |
| Slug held | Another key for a held slug is `409 slug-taken` and writes nothing |
| Two connections | The first intake holds its transaction after reserving the slug; the second, on its own connection, waits on the unique index and is refused when the first commits. The same race with the slug constraints unrecognised answers `500`, so the `409` rests on the constraint |
| Validation | Each invalid slug, `kodera-staff`, and each body naming a DPA, terms, a membership, a role or an order is a `422` with its pointer and code, before any write; a refusal is replayed under its key; a body that is not JSON is a `400`; no key is a `400` |
| Who may ask | No token or a bad one is `401`; a customer token naming `staff_operator` is `403`; a staff token without a second factor is `403 mfa-required`, audited; a staff identity without a current operator grant is `403`, audited; an unknown or disabled staff identity is `401`; a grant revoked before the effect is `403`, unstored, and the key works once the grant holds |
| Gate | A closed gate or a missing seal key is `503 intake-closed`, unstored, and the key works once the gate opens; the setting admits only `1`, `0` or nothing; with no staff issuer set the gate is closed and every staff token is `401` |
| Reserved and shaped | Each exact reserved name and every valid `synth-*` slug is a `422 reserved` and is refused by the database itself; an `instruction_ref` that is an address, a name or lower case is a `422 pattern` |
| Authorisation before replay | A `201`, then the grant revoked, then the same key: `403`, never the stored `201` |
| Rollback | The intake row refused by the database after the job is enqueued leaves no organisation, job, `organisation.intake_recorded` or `job.created` |
| Writer role | `tests/test_intake_writer_role.py`, §4 |
| Fault points | `tests/test_intake_fault_points.py`: each site of `core/faults.py` is reached once, in order, seeing what its name says was written; a crash at `after-desired-state`, `after-audit`, `after-job` or `before-commit` writes nothing and the retry records once; a hold before commit answers a contender `409 idempotency-key-in-flight` with the winner's `X-Operation-Ref`; a crash after the commit leaves one queued `realm_create` job with its seven steps; arming is refused outside the test profile |

**The first-slice scenarios.** Routing the intake moved twelve scenarios past
`operation:createOrganisation`, and none passes. Every scenario that records an intake now stops at
`harness:identity-provider-second-factor`, because every staff request needs a second factor the
signed fixture must never mint: `FS-BOOT-02`, `FS-OP-01` and `FS-CON-06` reach it inside the fault
point they arm (below), once Core declares those points. That last gap is asserted, after the operation is measured as
routed: the harness's no-database runs cannot reach a view that reads the database.

**Not shown.** The `dev/first_slice_bootstrap.py` packet's `FS-BOOT-07` lifts only on its probes
answering `422` since #165, so a routed intake that refuses its unauthenticated probes keeps it
`failed`. No real HTTP server, no Keycloak, and no operator command of the amendment is exercised
here. A failure inside the view is logged by its exception class and request id only.

## Changelog

- First version: `createOrganisation` behind the staff principal, the intake gate and the replay
  store; the intake record with its sealed contact; the queue and replay store in the image's
  profile.
- After the security review: seven reserved slugs, refused by the API and the database; the
  instruction reference shaped as a ticket; contract 0.14.0's `slug-taken` and `intake-closed`;
  no outbox and no test profile in the image; the API role's grants listed and tested; a short local
  part masked whole; failures logged by class and request id.
- The amendment is ratified (Core #154): the status and introduction say so, and the contact's place
  on the intake is no longer a departure from it, only from `MODEL.md` and the contract.
- §4: the same role serves the structure administration of contract 0.22.0
  (`ESPACE_STRUCTURE.md` §11), with its grants named there; and §1's reserved list grows with the
  platform labels of `kodera.io`, through `orgs.0013` and `orgs.0014`.
- Contract 0.25.0 exposes the stable intake operation reference without adding replay persistence,
  a lookup or authority. The route computes the canonical job key after current authority, threads
  it through the adapter and intake transaction, and rejects any supplied internal mismatch.
- The intake reaches five named fault points of `core/faults.py`: after the desired state, after
  its audit inside `apply_desired_state`, after `enqueue_job`, as the handler's last statement
  before the replay entry, and after the view's transaction commits. They are inert unless the test
  profile arms them; the first-slice harness uses them for `FS-BOOT-02`, `FS-OP-01` and `FS-CON-06`.

- Contract 0.29.0 reserves the synthetic realm prefix at intake and persistence; synthetic realms remain outside Core. Syntax and output/discovery shapes stay unchanged.
