# Membership lifecycle

**Status:** Proposed · **Owner:** API seat

How an organisation's owners and admins change, suspend, reactivate and remove a person's membership:
`getMembership`, `changeMembershipRole` and `removeMembership` of `contracts/core-api.openapi.yaml`.
Suspension and reactivation are the `state` field of `changeMembershipRole`'s body, which the contract
already carries; no new operation is added.

Core's database is authoritative for these facts ([`../api/AUTHZ.md`](../api/AUTHZ.md) §2 step 7): a
suspended or removed membership loses every Core grant on the person's next request, because every
grant reads `_current_memberships` (undeleted, `active`, accepted). The applications and the realm do
not follow yet (§6).

## 1. Operations

| Operation | Caller roles | Answer |
|---|---|---|
| `GET /organisations/{organisation_id}/memberships/{membership_id}` | `org_owner`, `org_admin`, `org_member` | `200 MembershipDetail` with a strong `ETag` |
| `PATCH` same path, `application/merge-patch+json`, `If-Match` required | `org_owner`, `org_admin` | `200 Membership` with the new `ETag` |
| `DELETE` same path, `If-Match` optional and enforced when present | `org_owner`, `org_admin` | `200 Membership`, the `removed` row's `id`, `organisation_id`, `role`, `state` and timestamps, without the person's contact |

- The target is a membership of the caller's own organisation, bound by issuer (`read_tenant_caller`).
  Another organisation's membership, an unknown id and a `removed` membership are the same `404`,
  except for a repeated `DELETE` (§2).
- Staff tokens are refused `403` on all three. A staff read of a membership is declared by the
  contract but not served yet, as for `listMemberships`.
- `org_billing` holds no cell of the `Membership` row: `403`.
- The `ETag` is `sha256` over the canonical JSON of `id`, `organisation_id`, `role`, `state` and
  `updated_at` (CONVENTIONS §10). It is compared exactly: a weak or `*` tag does not match.
- The detail's flags are the rules of §2 applied to the caller now: `can_change_role` needs an
  accepted (`active` or `suspended`) row, `can_remove` admits an `invited` one too, and both are
  false in a suspended organisation. `blocked_reason` names `last_owner` or `self` when one of those
  is why; an admin looking at an owner's row gets `null`, since no listed reason fits.

## 2. Rules

A PATCH body is an object with only `role` (one of the four roles) and `state` (`active` or
`suspended`), both strings, sent as UTF-8 `application/merge-patch+json` within the server's body
limit. Anything else is `400 malformed-request`, the only `400` the contract declares here.

Checks run in this order, after authentication, the issuer binding and the target lookup:

| # | Check | Answer |
|---|---|---|
| 1 | Caller role is `org_owner` or `org_admin` | `403 forbidden` |
| 2 | Organisation is `active` | `403 forbidden` (a suspended organisation reads but does not administer people; the contract declares no `402` here) |
| 3 | PATCH: the target is not `removed` | `404 not-found` |
| 4 | PATCH carries `If-Match` | `428 precondition-required` |
| 5 | `If-Match` equals the target's current `ETag` (PATCH always, DELETE when present) | `412 precondition-failed` with `current_etag` |
| 6 | An `org_admin` caller: the target's role and any new role are `org_admin` or `org_member` | `403 forbidden` |
| 7 | The change would leave no `active`, accepted `org_owner`: demoting, suspending or removing the last one | `409 last-owner-protected` with `organisation_id` |
| 8 | The target is the caller's own membership | `403 forbidden` |
| 9 | PATCH only: the target is `invited` | `409 invalid-state-transition`, `allowed_states: [active, suspended]` |

- Rule 7 precedes rule 8 so that an owner removing their own last-owner row learns why (first-slice
  FS-ID-03). Rule 6 precedes rule 7 so that an admin, who cannot touch an owner at all, is refused
  rather than told about the organisation's owners.
- A PATCH that changes nothing passes every rule and then answers `200` with the current row,
  writing nothing; it is refused like any other when a rule refuses it.
- A DELETE of a row that is already `removed` passes rules 1, 2 and 6 and then answers `200` with the
  row again, whatever `If-Match` it carries, so a retry whose first answer was lost succeeds. Nothing
  is written. Rule 6 still applies, so an admin cannot read a removed owner's row this way.

## 3. Concurrency

The write runs in one transaction with `lock_timeout = 2s`. It first resolves the caller, then touches
the target row (`UPDATE … SET state = state`), whose existing triggers take the canonical locks: the
target's `identity_user` row, then every organisation of that person in id order
([`member-authority-revision.md`](member-authority-revision.md)). It then resolves the caller again,
since the caller's own authority may have changed while it waited. Every later read, the owner count
of rule 7 included, comes after those locks. Two owners demoting each other therefore serialise: the
second finds itself an admin and is refused by rule 6. The deferred `organisation_owner_required`
trigger stays the backstop; its violation at commit also answers `409 last-owner-protected`.

A lock wait past the timeout answers `500`, is logged by exception class and request id, and changes
nothing. The contract declares no `503` for these operations.

Every role or state write advances `Organisation.authority_revision` through the same triggers, so
outstanding authority reads elsewhere see the change. A PATCH that changes nothing and a repeated
DELETE roll their touch back, so they advance nothing.

## 4. Audit

In the write's transaction, one row per changed fact, actor the caller's identity, target
`urn:kodera:membership:{id}`, `before`/`after` holding only the changed field:

| Change | Action |
|---|---|
| role | `membership.role_changed` |
| `active` → `suspended` | `membership.suspended` (new) |
| `suspended` → `active` | `membership.reactivated` (new) |
| removal, from any state | `membership.removed` |

Every refused PATCH or DELETE, and every refused staff read, writes one `authz.denied` in a
transaction of its own after the refused one rolls back (AUTHZ §9). A refused tenant read is not
recorded, so a reader cannot fill the trail by repeating it. Its scope is `membership:read`,
`membership:update` or `membership:delete`. Its reason is `role_missing`, the closed list's only fit,
also for a suspended organisation. Its target is the organisation, as for `initialiseWorkspace`.

## 5. Removal

`DELETE` sets `state = removed`, the tombstone `MembershipState` names. It sets neither `deleted_at`
nor `purge_after`: no retention period is defined for memberships
([`CUSTOMER_PERSISTENCE.md`](CUSTOMER_PERSISTENCE.md)), and this document does not invent one. The
row keeps its `(user, organisation)` unique slot, and a removed row cannot be changed back through
PATCH (rule 3). An invitation does not bring a removed person back either: the batch refuses their
address and acceptance never revives the row (INVITATIONS.md §3).

## 6. Hooks and what stays open

- **Engine member set.** After the state change and last in the transaction:
  - suspending an `active` member calls `emit_member_left(membership, reason=member_suspended)`;
  - removing an `active` member calls it with `reason=member_removed`;
  - reactivation calls `emit_member_set(organisation_id=…, reason=member_reactivated)`.

  Removing a suspended member or an invitation calls nothing: the first already left the set and the
  second never joined it. A role change does not change the set, and a join records none: the next
  set lists the newcomer. `apps/orgs/member_set_hooks.py` makes these calls. A leaver with no realm
  subject is counted and does not block the change. A leaver whose subject is outside the
  contract's shape, or a set past its bound while an agent would receive it, fails closed: the
  change rolls back and is answered `500`, and `member_set_hooks.after_rollback` records the
  refusal for an operator (ADR-0016). The API role's grants on the `engine_intents_*` tables cover them, and
  `tests/test_membership_writer_role.py` suspends, reactivates and removes an active member through
  the views as that role, with an agent credential, checks each set and its commands, and has a
  refused set roll a suspension and a removal back.
- **Provider effects: realm access** (part of identity realm tooling#52). Disabling the
  person in the organisation's realm and ending their realm sessions are user-level identity
  operations, so they are outbox deliveries, not jobs (`JOB_CATALOGUE.md`, **Outbox deliveries are
  not jobs**). §6.1 is the delivery. Syncing realm group membership with roles is not part of it: no
  realm mirrors roles as groups, and Core reads no token role (AUTHZ §2). It changes no contract.
- **Release gate.** Suspending or removing someone stops their Core access at once; the member set
  reaches the engines once the tenant agent runs on the tenant (its Fleet deployment); and, once
  `run_realm_deliveries` has run, the person is disabled in their organisation's realm, every online
  realm session is ended and every offline grant is revoked there, so no new token is issued to them
  and no refresh token of theirs is honoured. What is still not covered, each a follow-up:
  - **Visio and Docs keep their own sessions.** Each holds its own session after the sign-in. Of the
    realm's clients only Synapse has back-channel logout; Visio and Docs keep a person already inside
    until their own session expires. Their back-channel logout (or a short session that re-checks
    the realm) is owed by each application, outside Core.
  - **Matrix** follows the member set the tenant agent applies (above), not the realm delivery.
  - **The schedule.** `run_operator_schedule` runs it every minute, first in each pass
    (OPERATOR_SCHEDULE.md). The deployment must keep that process running, and alert on its failed
    runs, before the Console offers suspend or remove as a security control.
  - **Erasure only disables.** An explicit erasure (`erase_member`) turns the realm user off like a
    removal; deleting the realm user is a follow-up of its own.
  - **The deploy order** (§6.1.8): schema, grants, the realm worker client enabled, its secret
    directory, the pinned origins, then the schedule.

- **Contract.** `removeMembership` answered `202` with a `realm_update` job that does not exist; it
  now answers `200 Membership`. Both operations' descriptions, and `MembershipPatchRequest.state`'s,
  drop the realm effect. Breaking, so the version moves to 0.18.0 under the `contract:breaking`
  label. The Console already calls both operations (`src/features/people/queries.ts`) and mocks the
  old `202`; it needs a regenerated client and that mock changed. That is Console follow-up work.

### 6.1 Realm access delivery

#### 6.1.1 What is written, and when

In the transaction of the membership change, after its audit rows and before the engine hooks,
`apps.outbox.realm_enqueue.enqueue_realm_access` writes one delivery per realm identity of the person
in that organisation (`identity_identity` rows with the membership's `user_id` and
`organisation_id`):

| Change | Operation | Identities |
|---|---|---|
| `active` → `suspended` (PATCH) | `access_off` | every one, disabled and soft-deleted rows included, since a row keeps its realm user |
| removal (DELETE), from any state, and an explicit erasure (`erase_member`) | `access_off` | every one |
| `suspended` → `active` (PATCH) | `access_on` | enabled, undeleted ones only |
| a role change, a no-op, a repeated DELETE, any refusal | nothing | — |

Each delivery is an `OutboxDelivery` with `category = identity_user_operation`, `changes_realm =
true`, `status = pending`, and one `outbox_realmaccess` row: the delivery, the membership, the
identity, the realm user id (the identity's subject, which Keycloak issues as the user's id), the
operation and `not_before`. It carries no issuer, realm or URL. A person with no identity in the
organisation's realm (an invitation never accepted) gets no delivery: there is no realm user. The
row is the change's own (ADR-0004): a rollback of the change loses it, and a delivery is never
written without its change. The enqueue raises outside a transaction.

A person who belongs to several organisations has one realm, and one identity, per organisation
(ADR-0006): a delivery names one identity, so it reaches only the realm of the organisation whose
membership changed.

The API image carries this one module of `apps.outbox` and nothing of the run, so the API process
holds no Keycloak credential and no admin client (ADR-0003).

#### 6.1.2 The run

`run_realm_deliveries(admin_factory=…, organisation_lock=…, origins_issuer=…, limit=50)` refuses to
run inside a caller's transaction. In order:

1. **Reconcile** (§6.1.4), in its own transaction.
2. **Sweep.** An `in_flight` realm-access delivery whose open attempt started more than 15 minutes ago
   has an unknown outcome: the runner that holds it may have stalled, not died, and may still land
   its write. The attempt is closed `abandoned` and the delivery goes to `needs_reconciliation`
   (`outbox_delivery.reconciliation_required`, reason `attempt_abandoned`, an `error` log). ADR-0004:
   an ambiguous outcome is reconciled, never retried automatically. Retrying it could let a stalled
   `access_on` land after a later suspension's `access_off` and leave a suspended member enabled with
   nobody told. The held delivery blocks every later delivery of the same identity (step 3) and is
   outstanding on every run (§6.1.6) until an operator decides it (§6.1.4).
3. **Claim**, one delivery at a time, in its own transaction: the oldest `pending` realm-access
   delivery whose `not_before` has passed, not attempted by this run, and with **no earlier delivery
   of the same identity still `pending`, `in_flight` or `needs_reconciliation`**, so an `access_off`
   and a later `access_on` of one person apply in commit order, and nothing of a person runs while an
   outcome of theirs is unknown. Locked `FOR NO KEY UPDATE SKIP LOCKED`.
   - **Organisation lock.** Before anything else the claim takes the organisation lock shared,
     non-blocking, as a session lock, under the queue's key (`JOB_CATALOGUE.md` §1): it first checks
     that no job holds a reservation of that lock exclusively and that no `realm_create` or
     `realm_update` of the organisation has requested its locks and waits; then takes the lock; then
     checks both again. If any check or the lock fails, the delivery stays `pending`, untouched, the
     run counts it `held` and moves on. The lock is released once the outcome is recorded.
   - **The payload is not trusted.** The API role can insert these rows, so the claim re-derives
     the realm and the realm user from Core's own rows: the membership (read `FOR SHARE`), the
     identity and the organisation. It executes only if the membership belongs to the delivery's
     organisation, the identity belongs to that organisation and to the membership's person, its
     subject is the row's realm user id, its realm and issuer are the organisation's, and that
     issuer is `{KODERA_REALM_ISSUER_ORIGIN}/realms/{realm}`: a realm this worker's Keycloak
     serves. Otherwise the delivery ends `failed`, reason `payload_mismatch`, with an `error` log
     naming the check that failed, and nothing reaches Keycloak. The realm and user the run acts on
     are the identity row's, never the payload's.
   - **Withdrawn.** A delivery that would move the realm away from the membership's current state is
     not executed and ends `failed`, reason `withdrawn`: an `access_off` of a membership that is
     `active` (a reconcile that raced a reactivation), and an `access_on` of one that is not `active`
     or of an identity that is disabled or soft-deleted. Core never enables a realm user whose
     membership is not active, and never disables one whose membership is.
   - Otherwise it opens the next attempt (`outbox_deliveryattempt`, its `message_id` the operation
     reference `realm-access:<attempt id>`), sets the delivery `in_flight` with `started_at` and
     `operation_ref`, and commits. Only then does the run call Keycloak.
4. **Execute**, outside any transaction, with the realm's credential loaded for this delivery only
   (§6.1.5):
   - `access_off`: read the user (`GET users/{id}`). If enabled, `PUT users/{id}` with
     `{"enabled": false}` and nothing else: Keycloak 26.0.7's `UserResource.updateUser` keeps the
     user's existing attributes when the representation carries none, and a body with only the flag
     cannot overwrite a concurrent change to anything else. Then `POST users/{id}/logout`, then, for
     every client the user's consents list (`GET users/{id}/consents`), `DELETE
     users/{id}/consents/{clientId}` (a `404` there is already revoked). **Read back:** the user is
     disabled, `GET users/{id}/sessions` is empty and `GET users/{id}/consents` is empty.
   - `access_on`: read the user; if disabled, `PUT` `{"enabled": true}`. Nothing else: no session or
     grant is restored. **Read back:** the user is enabled. Reactivation in Core overrides a disable
     made in Keycloak outside Core: Core's membership is authoritative.
   - **An absent user.** A `404` on the user is accepted as `user_absent` only after a positive
     control: `GET users/count` answers `200` for that realm, so a wrong realm or host is never read
     as a person already gone. A `404` on a write or a sub-resource (`PUT`, logout, consents,
     sessions) certifies nothing by itself: the run reads the user again, and accepts absence only if
     that read is `404` too and the positive control answers. If the user still reads back, the
     delivery fails `not_found_inconsistent` for an operator. Absence is counted in the report and
     logged at `warning`.

   Why the consents step: in Keycloak 26.0.7, `POST users/{id}/logout` (`UserResource.logout`,
   `services/src/main/java/org/keycloak/services/resources/admin/UserResource.java` at tag 26.0.7,
   commit `812d849c`) sets the user's not-before to now and back-channel-logs-out
   `getUserSessionsStream`, which yields **online** sessions only; offline sessions survive it. A
   refresh of an older offline token is then refused as `Stale token`
   (`TokenManager.refreshAccessToken` checks `NotBeforeCheck.forModel(session, realm, user)`), and
   any refresh is refused `User disabled` while the user is disabled, but the offline session itself
   remains until it expires. `GET users/{id}/consents` (`UserResource.getConsents`) lists every
   client holding an offline token for the user, with or without a consent, and `DELETE
   users/{id}/consents/{client}` (`UserResource.revokeConsent` →
   `UserConsentManager.revokeConsentToClient`) revokes the consent **and** the offline tokens of
   that client. So the delivery revokes them explicitly and its read-back requires none left.
5. **Record**, in one transaction, the attempt's outcome and the delivery's move, with its audit
   row (§6.1.3). An outcome that arrives after the sweep abandoned its attempt is recorded nowhere:
   it is counted `late`, logged at `error`, and the delivery stays with its operator.
6. **Verify** (§6.1.9), in a time phase of its own after the deliveries' phase, so new revocations
   are never held back and cannot hold verification back: list every enabled user of each realm
   Core has turned someone off in, and enqueue a fresh `access_off` for each one Core wants off;
   then claim those corrections in the same pass, with a budget and a phase of their own.
7. **Report what is outstanding** (§6.1.6).

Every Keycloak write is idempotent, and the delivery ends only on a read-back that shows the target
state, so a repeat converges: a second `access_off` finds the user disabled and nothing to revoke.

**What is retried, and what is held (ADR-0004).** Only a failure proven to come before anything
was asked to change is retried: Keycloak unreachable before a request left (refused, unresolved,
TLS), a refused credential, a failed **read** (a `GET`'s timeout or `5xx`, before or after the writes
that already answered), and a read-back that does not match after every write answered. A **write**
(`PUT`, logout, consent revocation) that times out, loses its connection after sending, answers a
`5xx`, or fails in any way the run cannot classify has an **unknown outcome**: Keycloak may have
received it and may still be executing it. Such a delivery goes to `needs_reconciliation` at once and
is never retried automatically. Idempotence does not order opposing writes: an `access_on` whose
`PUT` times out here can still be committed by Keycloak after a later removal's `access_off` has
disabled the user and passed its read-back, so a retry, or a later delivery run past it, could
leave a removed member enabled with the removal reported done. The held delivery blocks every later
delivery of the same identity (step 3), is outstanding on every run (§6.1.6), and is decided by an
operator after the quiet period (§6.1.4).

#### 6.1.3 Outcomes

| What happened | Attempt | Delivery | Audit (`outbox_delivery.*`) |
|---|---|---|---|
| Read-back shows the target state | `accepted` | `succeeded` | `sent` |
| The user does not exist, and the realm answers `users/count` | `accepted` | `succeeded` | `sent`, reason `user_absent` |
| The request positively never left: connection refused, name not resolved, connecting timed out, or the TLS handshake failed — each before `request()` wrote a byte | `transport` | `pending`, `not_before` unchanged, no budget spent | `deferred`, reason `transport` |
| The credential missing, unreadable or refused: no file, token endpoint `400`/`401` (a disabled or wrong worker client), admin `401`/`403` (the admin API asked on the public host, or the account's roles missing) | `transport` | `pending`, no budget spent; **an operator's at once** | `deferred`, reason `credential` |
| The phase or the run ended between two calls of a delivery (§6.1.9): nothing more is started, no write of it is in flight | `transport` | `pending`, `not_before` unchanged, no budget spent | `deferred`, reason `deadline` |
| The attempt still open 15 minutes after it started (§6.1.2, step 2) | `abandoned` | `needs_reconciliation` | `reconciliation_required`, reason `attempt_abandoned` |
| A **read** answered by a `5xx` or a `429`, timed out or cut off; a `429` to a write (refused before it was processed); or a read-back that does not show the target state | `temporary` | `pending`, `not_before` moved by 15 s plus retry class `A` (30 s × 2^(n−1), cap 10 min, full jitter) | `deferred`, reason `temporary` or `readback_mismatch` |
| A **write** that failed in any way once `request()` started writing — a timeout, a lost connection, a TLS error mid-stream, a `5xx` — or any failure the run cannot classify | `ambiguous` | `needs_reconciliation`, never retried; blocks the identity's later deliveries | `reconciliation_required`, reason `outcome_unknown` |
| The fifth `temporary` attempt | `temporary` | `failed` | `failed`, reason `attempts_exhausted` |
| Any other `4xx` from the admin API, a redirect, or a `404` on `users/count` | `permanent` | `failed` | `failed`, reason `rejected` |
| A `404` on a write or a sub-resource while the user still reads back | `permanent` | `failed` | `failed`, reason `not_found_inconsistent` |
| The payload disagrees with Core's rows (§6.1.2) | — (no attempt) | `failed` | `failed`, reason `payload_mismatch` |
| Withdrawn (§6.1.2) | — (no attempt) | `failed` | `failed`, reason `withdrawn` |

A long Keycloak outage keeps its deliveries `pending` without spending
budget, and is reported by `outstanding` once they are 5 minutes old. What needs an operator — a
failure other than a withdrawal, a mismatch, a refused credential, an abandoned attempt, a write
with an unknown outcome, a late outcome, and anything outstanding — is logged at
`error` naming the delivery and makes the command exit non-zero (§6.1.6). Audit `metadata` carries
`attempt`, `operation`, `http_status` (or null) and `reason`; never a token, a secret, a user
representation or an address. The same holds for every log line: identifiers, the operation, the
HTTP status, a check's name and an error's class name only.

#### 6.1.4 Reconcile

Removals and suspensions made before this delivery existed, and any change whose delivery was
missed, must reach the realm. The reconcile pass, run first by every `run_realm_deliveries` and
alone by `run_realm_deliveries --reconcile-only`, enqueues an `access_off` for every realm identity of
every `suspended` or `removed` membership (not soft-deleted) whose latest realm-access delivery is
missing or is an `access_on`. One whose latest delivery is an `access_off` is left alone whatever its
status: a pending or in-flight one will run, a succeeded one is done, and a failed one is the
operator's, reported as outstanding on every run until the operator asks for it again with
`--requeue-failed` (after fixing its cause). Repeating the pass writes nothing new; concurrent passes
serialise on a transaction lock. A pass that races a reactivation can commit an `access_off` after
that reactivation's `access_on`; the claim withdraws it, since the membership is active (§6.1.2). It
writes no audit row of its own; each delivery's outcome is audited.

**Deciding an unknown outcome.** A delivery in `needs_reconciliation` leaves it only through an
operator's decision recorded with its two pieces of evidence (`JOB_QUEUE.md` §§5.4, 7):

```
run_realm_deliveries --once --reconcile-attempt <delivery> --staff-identity <staff operator> \
  --compute-terminated-provider … --compute-terminated-resource-id … \
  --compute-terminated-request-id … --compute-terminated-observed-at …
```

For an attempt the runner closed `ambiguous` itself, its closing record is the evidence that the
runner's side ended, and the `--compute-terminated-*` flags may be left out: the decision records
that attempt's id and closing instant as its `compute_terminated` evidence. For an attempt the
sweep abandoned, the runner may still be alive, so the operator must supply evidence that it
stopped; without it the command refuses (`compute_terminated_required`). **Quiet period:** the command
refuses, writing and reading nothing, until `RECONCILE_QUIET_PERIOD`, 330 s, has passed since the
later of the attempt's end and that evidence. Keycloak commits or rolls back a request's work
within its own server-side transaction timeout, 300 s by default in 26.0.7
(`quarkus.transaction-manager.default-transaction-timeout=300` in
`quarkus/runtime/src/main/resources/application.properties` at tag 26.0.7); the 30 s margin covers
the request's own transit. A deployment that raises Keycloak's timeout raises this constant with it.
The quiet period is a **safety margin, not the guarantee**: a request queued upstream (a proxy, a
load balancer, a thread pool) can still run after it. The guarantee is the bulk verification
(§6.1.9), which finds and reverts such a late enable on the next pass that verifies the realm.
Only then does the command re-derive the delivery's subject from Core's rows as a claim does, reads the realm user's
**current** state with the realm's worker credential (enabled, online sessions, offline grants; an
absent user only once `users/count` answers) and, in one transaction under the operator's current
`staff_operator` grant, records the decision with that read as its target evidence:

- the realm shows what the delivery set (an `access_on` that landed, an `access_off` that did):
  `resume` with `completed`, the delivery `succeeded`;
- it does not: `fail` with `no_effect`, the delivery `failed`;
- and, in the same transaction, when the realm does not show what Core's membership asks **now**
  (on for an active membership of a usable identity, off otherwise), a fresh delivery of that
  operation is enqueued. A stalled `access_on` that landed after a suspension is therefore
  `completed` as observed, and the fresh `access_off` turns the member off again.

It prints the decision, the observed state as counts and flags, and what it enqueued, never a token
or a representation. Any refusal writes nothing.

#### 6.1.5 The credential and the origins

The delivery acts in the organisation's realm with that realm's own service-account client,
`kodera-identity-worker` (realm-apply step 3, `identity realm tooling` `REALMS.md`): a confidential client
whose service account holds `manage-users` and `view-users` of `realm-management` and nothing else
(ADR-0003, "a per-realm `realm-management` service account"). No master-realm credential is used.

**Where it goes is pinned, never read from a delivery.** Two worker settings, read once by
`config.settings.job_queue` and refused at start when malformed (`https`, or `http` on a loopback
host, no user, query or fragment):

| Variable | Serves | Production |
|---|---|---|
| `KODERA_REALM_ISSUER_ORIGIN` | the realms' issuer and token endpoint, `{origin}/realms/{realm}/protocol/openid-connect/token` | `https://auth.kodera.io` |
| `KODERA_REALM_ADMIN_ORIGIN` | the Admin REST API, `{origin}/admin/realms/{realm}/…` | `https://auth-admin.kodera.io` |

The public host answers `403` on `/admin` (`identity realm tooling` README, "DNS and hostnames";
`ADMINISTRATION.md` §3), so the admin calls go to the admin host. The realm name comes from Core's
identity row, checked as a single path segment.

For each delivery the run loads that realm's client secret, asks the token endpoint for an access
token with `client_credentials`, uses it for this delivery's calls only, and drops both when the
delivery ends, on failure too. The bulk verification (§6.1.9) fetches one token per realm per pass,
for that realm's listing, and drops it when the listing ends.

Every call has one absolute deadline, 10 s from its start (`TIMEOUT_S`) or its window's end if
sooner (§6.1.9), covering the DNS lookup, connecting, the TLS handshake, the response headers and
the whole body. The whole call runs in the calling thread, and **no request outlives its call**:
only the DNS lookup runs on a helper thread, abandoned at the deadline, since it sends nothing.
Connecting and the TLS handshake use a socket timeout of the time left. The deadline is checked
immediately before the first byte is written, and before every read, each read's timeout being the
time left, so a slow peer or a trickled body cannot hold the call past it. The connection never
opens itself implicitly and refuses to reconnect once used, so a request cut by its deadline can
never be sent later. A deadline that passes before the first byte is written is `transport`; once
a byte may have been written, the outcome is `temporary`, `ambiguous` for a write. A deadline
already passed when the call is made sends nothing. A body cut short, by the deadline or
by the peer, is never returned. The token request takes the same deadline. Nothing is put in the process environment. The source today is a
directory named by `KODERA_REALM_WORKER_SECRET_DIR`, one file per realm named after the realm,
holding the secret; a mounted Secret Manager secret fits it. A symlink is followed only to a file
that stays under the directory. A missing directory, file or an empty secret is the `credential`
outcome above.

`SETTINGS_AND_SECRETS.md` §4 places credential loading in `worker/credentials/`, and the loader is
`worker/credentials/realm.py`. The mail sender loads its own SMTP password the same way; neither
ships in the API image.

#### 6.1.6 The command and what it reports

`python manage.py run_realm_deliveries --once [--limit N] [--reconcile-only] [--requeue-failed]
--settings=config.settings.job_queue`, from `apps/orgs`, which wires the outbox's run to the
queue's organisation lock. `--once` is required; without the secret directory or the two origins it
refuses to run. It prints one line of counts — `reconciled`, `succeeded`, `user_absent`,
`deferred`, `failed`, `mismatched`, `credential`, `drift`, `unverifiable`, `unverified`,
`reconciliation`, `late`, `withdrawn`, `held`, `outstanding`, `oldest_outstanding_s` — and exits
non-zero when anything needs an operator: a drift found and corrected by the bulk verification, a
credential refused while verifying, and any realm not fully verified within the thresholds of
§6.1.9, included.
`--reconcile-only` prints the same line and exits non-zero while anything is outstanding. A run that
finds another pass running prints `already_running` and exits `0` (§6.1.9), unless that pass has held
the lock past twice the run bound: it then prints `stuck_run` and exits non-zero, so a stuck pass
cannot silence every later alert. A pass that fails releases the lock without letting a failed
release (a dead connection) hide the error that ended it.

For the operator on call:

| Counter | Meaning | Operator action | Exit non-zero |
|---|---|---|---|
| `reconciled` | `access_off` enqueued for suspensions or removals that had none (§6.1.4) | none; expected after an outage or on the first run | no |
| `succeeded` | deliveries whose read-back showed the target state | none | no |
| `user_absent` | succeeded on a user Keycloak no longer has (the realm answered `users/count`) | none; check if unexpected in bulk | no |
| `deferred` | retryable: a read failed, Keycloak unreachable, a phase ran out, a read-back mismatch | none unless it persists (it then becomes `outstanding`) | no |
| `failed` | a delivery ended failed: rejected, attempts exhausted, `not_found_inconsistent` | read the error log for the delivery; fix the cause; `--requeue-failed` | yes |
| `mismatched` | a delivery's row disagrees with Core's rows or the pinned issuer; never executed | investigate the row: it was not written by the membership views | yes |
| `credential` | a realm credential missing or refused (delivery or listing) | fix the secret file, the `kodera-identity-worker` client or its roles | yes |
| `drift` | a person Core turned off was enabled in the realm; corrected in this pass | find what enabled them (admin console, a stray request) | yes |
| `unverifiable` | a realm listing failed this pass | none unless it persists (it then becomes `unverified`) | no |
| `unverified` | a realm not fully verified for 5 passes or 10 minutes | restore Keycloak reachability, the credential, or release the job holding the realm | yes |
| `reconciliation` | a write's outcome is unknown, or an attempt was abandoned; the person's later deliveries wait | after 330 s, `--reconcile-attempt <delivery>` (§6.1.4) | yes |
| `late` | an outcome arrived after its attempt was abandoned; recorded nowhere | decide that delivery with `--reconcile-attempt` | yes |
| `withdrawn` | a delivery no longer matching the membership, ended without a call | none | no |
| `held` | a delivery or a realm skipped because a job holds the organisation's lock | none unless it persists (`unverified`, `outstanding`) | no |
| `outstanding` | people still holding access Core removed, a reactivated member left disabled, or an unknown outcome, older than 5 minutes | work the failed or held delivery it points to | yes |
| `oldest_outstanding_s` | age of the oldest outstanding delivery | — | — |
| `stuck_run` (printed instead of the counts) | another pass has held the run lock for longer than twice the run bound (`STUCK_RUN_AFTER_S`, 2 × 70 s), read from `pg_locks` and the holder's `pg_stat_activity.backend_start`; `already_running` below that age exits `0` | find the stuck worker process (its pid holds the advisory lock) and end it; its session ending releases the lock | yes |

**Outstanding** is recomputed on every run, whatever the run did. It counts each realm identity whose
latest delivery failed, or has been `pending` or `in_flight` for more than 5 minutes, while Core
still asks for it: an `access_off` of a `suspended` or `removed` membership (a person who still
holds realm access Core took away), and an `access_on` of an `active` membership of a usable
identity (a reactivated member left disabled). It also counts every realm-access delivery in
`needs_reconciliation`, whatever its operation (an outcome nobody knows). `oldest_outstanding_s` is the age of the oldest. Any outstanding person makes the run exit non-zero, so a failure keeps being reported
until it is fixed, not only on the run that failed.

#### 6.1.7 Acceptance

`tests/test_realm_access_client.py`, without a database, against two in-process HTTP stubs standing
for one Keycloak's public and admin hosts (the public one answering `403` on `/admin`):

- the token goes to the pinned public origin and every admin call to the pinned admin origin; the
  request shapes and the bearer token; the `PUT` carries only `enabled`;
- admin calls sent to the public host, a disabled or refused worker client and a missing credential
  file are each `credential`; each status class is classified, and a redirect is never followed;
- an absent user is accepted only when `users/count` answers; a `404` realm is `permanent`;
- an origin setting outside `https`, or with a user, a query or a fragment, is refused; a realm name
  that is not one path segment is refused;
- a credential symlink is followed inside the directory and refused outside it;
- the operator profile's migration plan reaches the realm access table, and the image carries the
  enqueue and no migration.

`tests/test_realm_access.py`, against PostgreSQL, with a fake admin client at the Keycloak boundary:

- each change of §6.1.1 writes exactly its deliveries, `access_on` only for usable identities, and a
  no-op, a role change, a repeated DELETE and a refusal write none; a person with no realm identity
  gets none; the enqueue raises outside a transaction;
- a change rolled back after the enqueue (a refused member set) leaves no delivery and no change;
- `access_off` disables, logs out, revokes each consent, reads back and succeeds; a second run
  converges with no change; `access_on` enables, calls neither logout nor revoke, and overrides a
  disable made in Keycloak;
- order: an `access_on` is not claimed while an earlier `access_off` of the same identity is open;
  two identities of one person in two organisations each reach only their own realm;
- a `5xx` defers with backoff and the fifth fails; a refused credential needs an operator at once;
  an absent user needs `users/count` and is counted; a `400` fails `rejected`; a read-back mismatch
  defers;
- a forged realm user id, a cross-organisation payload, another person's identity and an issuer this
  Keycloak does not serve each end `payload_mismatch` without reaching Keycloak;
- an `access_on` whose membership is suspended again, and an `access_off` whose membership is active
  again, are withdrawn without a call;
- a delivery is held while a job holds the organisation lock, or a realm job waits for it;
- bulk verification (§6.1.9): an enable applied directly in Keycloak after a completed removal is
  found by the next pass, which corrects it in the same pass (user disabled, no session, no grant),
  writes `outbox_delivery.drift_detected` and exits non-zero; the following pass is clean; an
  identity with open work, or an active member, is never corrected; a new removal arriving every
  pass, with slow deliveries filling their phase, does not delay correcting an older identity; with
  the correction budget at 2, three drifts are corrected over two passes, two in the first; one new
  delivery filling the delivery limit does not stop a correction in the same pass; a credential
  refused while listing needs an operator on the first pass; a realm unverified for
  `VERIFY_ALERT_PASSES` passes, or for longer than `VERIFY_ALERT_AFTER`, needs an operator, and
  stops needing one once verified; a lock skip keeps the failure count; a new `access_off` is
  executed before any listing; the verification phase is bounded; one token per realm per pass; a
  suspended person whose `access_on` is still pending is outstanding; a runner-closed `ambiguous`
  attempt is decided without operator evidence, an abandoned one is not;
- the correction window keeps `CORRECTION_PHASE_S` whatever the earlier windows overran, by
  construction (database-free) and in a pass whose slow new deliveries overrun their window while a
  drift is detected (PostgreSQL); a slow connect or handshake ends at the call's deadline and sends
  nothing, an already-expired deadline sends nothing, and the token request honours its deadline;
- no request outlives its call: a pause before the first byte past the deadline sends nothing, a
  connection ready only after the deadline writes nothing, a slow TLS handshake or DNS lookup ends
  at the deadline with no request sent, no request thread is alive after a call ends, and a used
  connection refuses to reconnect;
- the actual-image qualifications (production, bootstrap, consume) assert the image's `apps/outbox`
  holds exactly `__init__.py` and `realm_enqueue.py`, and forbid nothing the image allowlist admits:
  their probes run against the image tree, without Docker, and refuse any other file there;
- an `https` request names no `:443` in its `Host` header; an explicit port is kept;
- one pass at a time: a run that finds the run lock held prints `already_running`, writes nothing
  and exits `0`; the run deadline ends a pass whose delivery outlasted it, between its calls, and
  verification never starts; a realm whose listing keeps failing cannot keep a healthy realm from
  being verified when only one fits in a phase;
- a delivery past its phase's end starts no further call (`transport`, reason `deadline`), and one
  already past it calls nothing;
- deadlines, through the real HTTP adapter: a body trickled one byte at a time within every socket
  timeout still ends at the call's deadline; a listing ends at the phase's deadline when that is
  sooner; the enabled users of a realm are listed in full pages;
- through the real HTTP adapter: a TLS error once a `PUT` started sending is `ambiguous`; a TLS
  handshake failure before it, injected or real (TLS against a plaintext server, nothing parsed
  there), is `transport`;
- the review's counterexample: an `access_on` whose `PUT` times out is held, never retried; the
  member is removed and the `access_off` waits behind it; Keycloak finishes the enable last and the
  run still needs an operator; no `access_off` is certified meanwhile. The operator's decision is
  refused inside the quiet period, then reads the realm, records what landed, and the fresh
  `access_off` turns the member off;
- a write's `5xx` or timeout is `ambiguous`, a read's is `temporary`, an unclassifiable failure is
  `ambiguous`; a `PUT` answering `404` while the user reads back fails `not_found_inconsistent`,
  and a sub-resource `404` is absence only when the user reads `404` and `users/count` answers;
- the counterexample: a stalled `access_on`, then a suspension. The abandoned attempt is held in
  `needs_reconciliation`, the later `access_off` waits behind it, the run needs an operator, the
  stalled runner's late outcome is recorded nowhere and reported, and every later run still needs an
  operator. The operator's decision reads the realm (the enable landed), records `resume` with
  `completed`, enqueues a fresh `access_off`, and the next run turns the member off and is clean;
- `--reconcile-only` exits non-zero while anything is outstanding;
- a failed `access_off` is outstanding on every later run, and a long-pending one with its age; a
  failed or long-pending `access_on` of an active member is outstanding too;
- a retry's backoff (reads and before-send failures only) is never shorter than the request timeout
  plus 5 s, whatever the jitter;
- reconcile enqueues for a pre-existing removal and suspension, nothing on a second pass, a failed
  `access_off` only with `--requeue-failed`, and replaces a stray `access_on`;
- the command refuses without its settings and exits non-zero on a refused credential; end to end
  over HTTP, no log record, audit row or command output carries the secret, the token or an address.

Mutation negatives: each check raises with its own first line (`CHECK <name>:`), and each mutant must
fail its owning check with exactly that line: the enqueue skipped; the enqueue moved outside the
change's transaction; reconcile skipped; logout not called; consents not revoked; the payload trusted
(a forged realm user id; a cross-organisation payload); the issuer not checked against the pinned
origin; an `access_off` of an active membership executed; a credential failure read as plain
transport; an abandoned attempt returned to `pending` (the round-one sweep); outstanding not
reported; `access_on` left out of outstanding; a write's unknown outcome deferred and retried; the
bulk verification skipped. Without a database, a source mutation of each review fix fails its owning test in
`test_realm_access_client.py`: an off with a grant left read as reached; an unknown or late outcome
not needing an operator; the admin calls on the issuer origin; a `403` or a disabled client read as
rejected; an absent user without the positive control; a `PUT` carrying more than the flag; a
symlink out of the credential directory followed; the realm access migration missing.

#### 6.1.8 Deploy order

Core's schema is migrated operator-side under `config.settings.job_queue`, which installs
`apps.outbox`; the API image carries no migration at all, and its deployable profile
(`config.settings.deploy`) installs no outbox app because it needs none: the enqueue writes the
tables by name (`dev/accept_production_http.py` migrates that way; `CUSTOMER_HTTP_RUNTIME.md`). So
the realm access table exists wherever Core's schema does. In order:

1. **Schema:** `manage.py migrate --settings=config.settings.job_queue` (outbox `0005_realm_access`).
2. **Grants — a prerequisite nothing checks automatically:** `dev/api_writer_role.py`'s `INSERT`
   on `outbox_outboxdelivery` and `outbox_realmaccess` (§7) to the API role, applied by the operator
   who provisions the role, before the API serves the new code. Without them every suspension and
   removal answers `500` and changes nothing; no start-up check or CI job applies or verifies them on
   a deployed database.
3. **Realm worker client:** enable `kodera-identity-worker` in each organisation realm (realm-apply
   step 3 creates it disabled) and confirm its two roles.
4. **Secret directory:** one file per realm under `KODERA_REALM_WORKER_SECRET_DIR`, mode `600`.
5. **Origins:** `KODERA_REALM_ISSUER_ORIGIN` and `KODERA_REALM_ADMIN_ORIGIN` in the worker.
6. **Schedule:** `run_operator_schedule --interval 60` (OPERATOR_SCHEDULE.md), which runs
   `run_realm_deliveries --once` every minute and logs each failed run.
   Its first run reconciles every earlier suspension and removal.

#### 6.1.9 Bulk verification

Holding an unknown outcome and waiting out a quiet period bound the writes this worker knows about.
They cannot prove Keycloak quiet: a request queued upstream, an administrator's change in the
console, or a fault elsewhere can still enable a realm user Core turned off, after every check here
passed. So every `run_realm_deliveries` pass verifies the realms themselves, in bulk, rather than
chasing request lifetimes or reading people one at a time.

- **One pass at a time.** The whole `run_realm_deliveries` pass holds a PostgreSQL session advisory
  lock (`pg_try_advisory_lock`, key `run_realm_deliveries`). A run that finds it held prints
  `already_running`, does nothing and exits `0`: a pass can outlast the schedule's minute, and two
  overlapping passes would report false drift and enqueue duplicate corrections.
- **Which realms.** Every organisation's realm that has at least one `suspended` or `removed`
  membership (not soft-deleted), least recently **attempted** first (`last_attempted_at`, set when
  a listing of the realm starts, whatever its outcome): a realm that keeps failing goes to the back
  and cannot keep a healthy one from its turn, and a realm skipped for a held lock or a spent phase
  keeps its place at the front. A failing realm's own alert still fires. A realm whose issuer is not
  `{KODERA_REALM_ISSUER_ORIGIN}/realms/{realm}` is not this worker's to read: it counts as a failed
  verification (`not_served`), so it alerts like any other unverified realm.
- **What is read.** One listing per realm per pass, with one token: `GET
  /admin/realms/{realm}/users?enabled=true&briefRepresentation=true`, in full pages of 100 (the
  page size `UsersResource.getUsers` defaults to in 26.0.7), until a short page. The pages are
  offsets into the enabled users: when an earlier user is disabled while the pages are read, every
  later one moves back by one and one user can be skipped. Nothing guarantees a later pass sees
  them: repeated shifts can keep the same person unseen. That is the first of the known limits
  below. Keycloak's user listing has no cursor or snapshot.
- **Who must be off.** Each realm identity of a `suspended` or `removed` membership whose latest
  realm-access delivery is an `access_off` that `succeeded`: what the realm should show. Every other
  identity has an owner already: open work its own delivery, held in order (§6.1.2); a failed
  `access_off` the operator, through `outstanding` (§6.1.6); a missing or stray `access_on`
  reconcile (§6.1.4). Active members are never corrected.
- **A drift** is a user who must be off and is in the enabled listing. In one transaction, under a
  share lock on the membership, the pass checks the membership is still off and nothing is open for
  the identity, then enqueues a fresh `access_off` and writes `outbox_delivery.drift_detected`
  (reason `realm_drift`, never a representation), logged at `error`. The run counts `drift` and
  exits non-zero, even though it corrects the drift.
- **Sessions and grants need no bulk check.** A disabled user can open no session and refresh no
  token (`TokenManager.refreshAccessToken` refuses `User disabled`), and every correction is an
  ordinary `access_off`: it disables, logs out, revokes every consent and offline grant, and reads
  all three back.
- **Corrections in the same pass, with a budget of their own.** After the verification phase, the
  run claims the corrections it enqueued, and only those, up to `CORRECTION_BUDGET`, 50, within
  `CORRECTION_PHASE_S`, 10 s, whatever the deliveries' limit used. More drifts than that: the run
  still exits non-zero, and the rest, already enqueued, are claimed first by the next pass.
- **Phases and deadlines.** A pass has three windows, laid out from its start so that none can
  starve another: new deliveries (`DELIVERY_PHASE_S`, 15 s), verification (`VERIFY_PHASE_S`, 15 s),
  corrections (`CORRECTION_PHASE_S`, 10 s). Each window after the first begins `CALL_OVERRUN_S`
  (10 s, one call's own deadline) after the previous one ends, so a call started at the end of one
  window never eats into the next: **the corrections always keep their 10 s**, whatever the
  deliveries and the listings overran. The pass's deadline is the end of the correction window
  (`RUN_DEADLINE_S` = 15 + 15 + 10 + 2 × 10 = 60 s). A phase starts no new delivery or listing past
  its window's end, and a delivery checks that end before **every** call it makes, its token
  request included: past it, it starts no further call and waits for the next pass as `transport`
  (reason `deadline`), spending no budget, since every call it completed is idempotent and none of
  its writes is in flight. A call already started keeps its own absolute deadline (§6.1.5: 10 s,
  covering DNS, connecting, the TLS handshake, the headers and the whole body); a listing's and a
  token request's are also cut at their window's end; a write cut after it started sending is
  `ambiguous` (§6.1.3). A pass therefore ends within `RUN_DEADLINE_S` plus one call's deadline:
  70 s (`RUN_BOUND_S`).
- **Health, per realm** (`outbox_realmverification`): when the realm was last fully verified, how
  many passes in a row it was not (`unverified_passes`), how many of those failed
  (`consecutive_failures`) and the last failure's kind. A pass that does not read the realm because
  a job holds its organisation's lock, or because the phase ran out, adds to `unverified_passes`
  and leaves the failure history exactly as it was; only a complete listing resets them. The two
  counters do not overlap: the alert reads `unverified_passes`, which counts skips too, so a realm a
  job keeps locked still alerts; `consecutive_failures` counts only listings that failed, so an
  operator can tell a broken realm from a busy one, and a skip never resets it. Keeping one would
  lose either the alert on skips or that distinction.
- **Alerts.** A credential refused while listing needs an operator on the first pass (`credential`).
  Any other failure is counted `unverifiable`. A realm not fully verified for
  `VERIFY_ALERT_PASSES`, 5, passes in a row, or for longer than `VERIFY_ALERT_AFTER`, 10 minutes,
  since its last complete verification (or since it first needed one) is counted `unverified`, and
  the run exits non-zero until the realm is verified again.
- **The bound.** A late enable of a person Core turned off lasts until the next pass that verifies
  that realm, and each pass verifies every realm whose listing fits in its 15 s window, least
  recently attempted first, within the known limits below. With the scheduler running a pass every minute (§6.1.8; the scheduler is
  issue #274), that is one minute while Keycloak answers; if it does not, the realm's alert fires
  within 5 passes or 10 minutes, whichever comes first.

**Known limits of the sweep (defence in depth).** The bulk verification is a second line: the
**primary revocation path stays the guarantee**: the `access_off` committed with the membership
change, executed, read back, and held for an operator whenever its outcome is unknown (§§6.1.1–
6.1.4). Two limits of the verification are known and left to a follow-up:

- **Pagination can hide a user.** The listing pages by offset (above). An earlier enabled user
  disabled between two pages shifts every later one back by one, and one can be skipped; repeated
  page shifts on every pass, an earlier user disabled and re-enabled around each listing, could keep
  the same person unseen while the realm reads as verified. Closing it needs an authoritative point
  read of each expected-off identity, fairly scheduled, with its own overdue alert.
- **Inner loops are not yet bounded.** A claim walks past held, withdrawn or mismatched deliveries
  without checking time, the verification writes per-realm health and enqueues every drift it
  found, and reconcile enqueues every owed `access_off`, all in database work no deadline cuts. A
  large backlog or a large number of realms can therefore push a pass past its bound, and a pass
  that keeps progressing can be reported `stuck_run`. Bounding them (batched health, capped inner
  loops, unfinished work left for the next pass) is the same follow-up.

## 7. Grants

`dev/api_writer_role.py` gains `UPDATE (role, state, updated_at)` on `orgs_membership`, and the
columns its triggers write with the invoker's rights: `identity_user.enabled` and
`orgs_organisation.authority_revision` (`owner_guard_revision` is already granted). The `enabled`
grant also lets the role disable or re-enable a person; no narrower grant serves the triggers, which
lock the person and rewrite `enabled` to itself. Narrowing it, by a `SECURITY DEFINER` trigger
function with a pinned `search_path` or a guard refusing a changed `enabled` from the API role, is a
follow-up. `tests/test_membership_writer_role.py` proves the role serves all three operations, that
each new grant is needed, and that it is refused other writes on the membership table.

The realm access delivery (§6.1) adds `INSERT` on `outbox_outboxdelivery` and `outbox_realmaccess`,
and nothing else of the outbox: the role can enqueue a delivery and can neither read, change nor
delete one, nor write an attempt or a decision.

## 8. Acceptance

`tests/test_membership_lifecycle.py` and `tests/test_membership_writer_role.py`, against PostgreSQL:

- **GET:**
  - each reading role gets the row, its `ETag` and honest flags, including on an invited row and in
    a suspended organisation;
  - billing and staff get `403`; only the staff read is recorded;
  - another organisation's membership and a removed one get `404`.
- **PATCH:**
  - an owner promotes, demotes, suspends and reactivates;
  - an admin moves admin↔member and is refused owner and billing rows and moves;
  - changing one's own membership is `403`;
  - demoting or suspending the last owner is `409`, also through the commit-time backstop;
  - missing `If-Match` is `428`; a stale tag is `412` with `current_etag`;
  - bad bodies are `400`, including wrong types, deep nesting, non-UTF-8 and oversize;
  - an `invited` target is `409`; a `removed` target is `404`;
  - a suspended organisation is `403`;
  - a no-op is `200` with nothing written, and is still refused by the rules.
- **DELETE:**
  - an owner removes; an admin removes a member and is refused an owner;
  - the last owner is `409`, including removing oneself;
  - a repeat, or a retry with the first request's tag, is `200` with nothing written;
  - an admin's repeat on a removed owner is `403`;
  - a stale `If-Match` is `412`.
- **Effects:**
  - every successful change writes exactly its audit rows and advances `authority_revision`;
  - every `403` writes one `authz.denied`;
  - a suspended person loses their next read (`404` on a membership, `403` on the directory).
- **Concurrency:**
  - two owners demoting each other: one `200`, one `403`, one owner left. The test waits until both
    requests are blocked on the lock;
  - a caller demoted to member while waiting is `403`;
  - a lock held past the timeout is `500` with nothing changed.
- **Hooks:** called with the right row state and reason, inside the transaction, only for an active
  member leaving, never on a refusal or a no-op.
