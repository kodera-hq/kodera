# Pilot workspace onboarding

**Status:** Proposed · **Owner:** API seat

What happens between an organisation's owner claim and its members working in a workspace: the
starter template, the one setup state Core derives for the console, what the console shows for
each state, and the two operations of contract 0.13.0 that carry them, `getWorkspace` and
`initialiseWorkspace`. The acceptance scenarios of §7 are what the implementation (Phase 1 K9)
must pass. K9 implements them in `apps/workspaces` (`setup.py`, `structure.py`, `initialise.py`,
`api/`), tested by `tests/test_workspace_onboarding.py`; §9 says what it decided and what it does
not cover.

## 1. Scope

- **In.** The starter template (§2); the setup-state derivation (§3) and its rendering (§4); the
  read (§5) and the initialise step (§6); their acceptance (§7).
- **Out.** The claim itself and the owner's confirmation, which
  [`FIRST_OWNER_BOOTSTRAP.md`](FIRST_OWNER_BOOTSTRAP.md) §§8.3–8.7 govern: the starter workspace
  is the **separate, idempotent step after the claim** that §8.6 names, and it waits for the
  confirmation §8.7 records. Structural administration (creating, renaming, moving, archiving a
  category or channel), messages, files, audio and any content service: each arrives with its own
  operations. Nothing here changes the persisted schema of
  [`workspace-metadata-schema.md`](workspace-metadata-schema.md) except the column §2 names.
- **Citations.** §§5.4, 5.7, 8.6 and 8.7 of `FIRST_OWNER_BOOTSTRAP.md`, `confirm_owner_contact`,
  `owner_claim.confirmed` and `requeue_realm_bootstrap` are those of that document's pilot
  amendment, ratified with Core #154. Should its numbering or names change, this document follows
  it.

## 2. The starter template

Template version 2. `initialiseWorkspace` creates exactly these rows, once per organisation, in
one transaction:

| Row | `template_key` | Stored `name` | Position | Details |
|---|---|---|---|---|
| Workspace | — | — | — | `structure_revision` 1; `default_policy` is a new `ResourcePolicy` with `visibility = organisation`, revision 1, no rule |
| Category | `general` | `General` | 0 | no default policy of its own: it inherits the workspace's |
| Category | `team` | `Team` | 1 | the same |
| Text channel in `general` | `welcome` | `welcome` | 0 | `policy_mode = inherit`, `lifecycle = active`, empty topic |
| Text channel in `general` | `general` | `general` | 1 | the same |
| Audio room in `team` | `lounge` | `lounge` | 0 | the same |

- **Order, not positions, on the wire.** Positions are stored and order every list of
  `getWorkspace`, which sends the order and not the numbers: a hidden row would otherwise show as a
  gap.
- **Names are identifiers; labels are the console's.** `template_key` is the stable identifier
  of a templated row, unique within its kind only. The console's catalogue key is namespaced by
  kind — `category.general`, `category.team`, `channel.welcome`, `channel.general` — so the
  category and the channel both keyed `general` have two labels, French and English, in its
  message catalogues. The stored `name` is what the console shows when the key is
  null — anything a person creates — or unknown to it. When structural administration ships, a
  rename sets `name` and clears `template_key`, so a person's choice is never overridden by a
  catalogue.
- **Persisting the key.** The stored schema has no `template_key` yet. K9 adds a nullable
  `template_key` column to `Category` and `Channel`, guarded by the contract's pattern
  (`^[a-z][a-z0-9_]{0,31}$`), in a new `workspaces` migration (`0005_template_key`). The database
  also holds the key unique within its kind in one workspace (`category_template_key_unique`,
  `channel_template_key_unique`).
- **The audio room** ([`ESPACE_STRUCTURE.md`](ESPACE_STRUCTURE.md) §8). Template version 2
  creates the audio room `lounge` in `team`: position 0, `policy_mode = inherit`,
  `lifecycle = active`, in the same transaction as the other rows, and `workspace.initialised`
  records `template_version: 2`. A workspace initialised under version 1 keeps an empty `team`,
  because no step re-runs a template; an admin adds a room with `createChannel`.
- **Policy.** Every starter row is visible to every current member through the workspace default.
  No member- or role-specific grant is created, and no rule names a person.

## 3. The setup state

One function, `workspace_setup(organisation)`, derives the setup state on every read; it is never
stored. Its inputs are the organisation's **latest** `realm_create` job (a failed job is replaced
by `requeue_realm_bootstrap`, `FIRST_OWNER_BOOTSTRAP.md` §5.7), whether the organisation's issuer
is in the trust list `KODERA_AUTH_TRUST`, which a realm needs to count as ready (§5.4) — an
entry on the customer lane that has not expired, since an expired entry verifies no token — and
whether `owner_claim.confirmed` is recorded (§8.7): the organisation's `owner_claim.confirmed`
audit event with its `staff` actor, the one record `confirm_owner_contact` writes. The latest job
is the last enqueued, by the database clock and then the time-ordered id. The job
statuses are the queue's ([`JOB_QUEUE.md`](JOB_QUEUE.md) §3.3), not the contract's `JobStatus`,
which does not yet list `needs_reconciliation`.

Evaluated top to bottom; the first matching row wins:

| # | Facts | `setup.state` | `setup.reason` |
|---|---|---|---|
| 1 | No `realm_create` job for the organisation (a defect: intake enqueues one in its own transaction, `FIRST_OWNER_BOOTSTRAP.md` §3) | `failed` | `realm_job_failed` |
| 2 | Latest job `failed` or `cancelled` | `failed` | `realm_job_failed` |
| 3 | Latest job `queued` | `pending` | null |
| 4 | Latest job `leased`, `running`, `orphaned` or `needs_reconciliation` | `running` | null |
| 5 | Latest job `succeeded`, issuer not in the trust list | `failed` | `issuer_untrusted` |
| 6 | Latest job `succeeded`, issuer trusted, `owner_claim.confirmed` not recorded | `pending` | `awaiting_owner_confirmation` |
| 7 | Latest job `succeeded`, issuer trusted, owner confirmed | `ready` | null |

- `cancelled` is `failed` like `failed`: the job will not run again by itself and an operator
  acts. The cure is the same, `requeue_realm_bootstrap`, which the pilot amendment extends to a
  cancelled job; the console offers no retry for either.
- `needs_reconciliation` is `running`, not `failed`: a lost provider answer is never read as an
  outcome, and an operator's decision leaves it (`JOB_QUEUE.md` §5.4).
- `leased` is `running`: a runner holds the job before its first step is recorded.
- Row 6 covers an unconsumed claim as well, since the confirmation requires a consumed claim
  (§8.7); no tenant-role caller exists before the claim, so `getWorkspace` can only show row 6
  after it.
- Through `getWorkspace`, rows 1–5 are seen only exceptionally: a tenant token of an untrusted
  issuer does not verify, so row 5 is answered `401` before the derivation runs. The rows exist
  because the derivation is shared: the staff bootstrap view is to report the same states (§8).
- The organisation's own state is not an input. A `suspended` organisation keeps a `ready` setup;
  `initialiseWorkspace` refuses it on its own check (§6).

## 4. What the console shows

The console reads `getWorkspace` on entering `/{org}/workspace` and renders from `setup`,
`state` and `can_initialise`, mapping each closed enum member to one catalogue key.

| `setup.state` / `reason` | `state` | Console |
|---|---|---|
| `pending` / null | `not_initialised` | Setup in progress; no workspace; polls `getWorkspace` |
| `running` / null | `not_initialised` | The same |
| `pending` / `awaiting_owner_confirmation` | `not_initialised` | "We are confirming your ownership with you": the intake recorder contacts the owner out of band; no workspace, no action, slow polling |
| `failed` / `realm_job_failed` or `issuer_untrusted` | either | Setup stopped and the team is told; a support entry carrying the request id; no retry control, because an operator acts |
| `ready` / null | `not_initialised`, `can_initialise` true | The console calls `initialiseWorkspace` once, with a key generated when the screen is rendered, shows progress, then reads `getWorkspace` and shows the workspace |
| `ready` / null | `not_initialised`, `can_initialise` false | `org_billing` and `org_member`: "Your workspace is being prepared"; polls |
| `ready` / null | `initialised` | The workspace: categories, then channels, in the order received, labels from `template_key` |

**Which key on a retry.** The same `Idempotency-Key` only after a `5xx` or a network failure,
when the outcome is unknown: the step then either ran and is replayed, or did not and runs. After
any `4xx` the answer is final for that key — the store keeps and replays it — so a later attempt,
once its cause is gone, takes a **new** key. A `409 invalid-state-transition` means the console's
last read is stale: it reads `getWorkspace` again, renders that, and generates a new key if it
initialises again.

**Never render from the initialise answer.** `initialiseWorkspace` returns `Location` and
`{"state": "initialised"}` only; the structure always comes from `getWorkspace`, rendered for the
caller's current authority.

## 5. `getWorkspace`

- **Roles.** `org_owner`, `org_admin`, `org_billing`, `org_member` of the organisation
  (`AUTHZ.md` §5, row `Workspace`); scope `workspace:read`. Another organisation, a non-member, a
  `bootstrap` principal or staff: refused, `404` where `AUTHZ.md` §6 rule 3 asks for it.
- **Structure only.** The answer validates against `Workspace`, whose schemas are closed
  (`additionalProperties: false`), and carries no message, file, occupancy, member list or
  policy rule.
- **Visibility, server-side** (`AUTHZ.md` §6 rule 8). For each channel in `active` or `archived`,
  the kernel of [`workspace-policy-projection.md`](workspace-policy-projection.md) is evaluated on
  `channel.view` over the caller's facts and the channel's resolved policy, read together in one
  snapshot ([`workspace-member-parent-policy.md`](workspace-member-parent-policy.md)); the channel
  is returned only on `allow`. The projection fields of that snapshot are set to Core's own
  current revisions with `projection_state = ready`: this read is served by the system of record,
  not by a projection, so the projection gate has nothing to compare. A category is returned when
  the caller may view a channel created in it under the category's resolution (its default, else
  the workspace's) or may view one of its channels. Channels in `provisioning`,
  `deletion_pending` or `deleted` are never returned. Nothing in the answer reveals an omitted
  row: no count, no stored position, no placeholder.
- **Before initialisation.** `200` with `state = not_initialised`, `id` null, both lists empty,
  and `setup` from §3.
- **No revision, one ETag per view.** The stored `structure_revision` is not sent: it moves when a
  row the caller cannot see changes, and would disclose that change. The response's strong `ETag`
  hashes the caller's rendered answer, as the `GET /me` exception of `CONVENTIONS.md` §10 does, so
  conditional `GET` works per view: when only hidden rows change, nothing a caller receives
  changes, its tag included, and `If-None-Match` still answers `304`. Authorisation and filtering
  run before the tag is compared, so a revoked view never gets `304`. Every response is
  `Cache-Control: no-store`.
- **Rate limited** like every read (`CONVENTIONS.md` §11): `429` with `Retry-After`.
- **`can_initialise`** is true exactly when the caller is `org_owner` or `org_admin`, the
  organisation is `active`, `setup.state` is `ready` and `state` is `not_initialised`.

## 6. `initialiseWorkspace`

`POST /organisations/{organisation_id}/workspace/actions/initialise`, `org_owner` and `org_admin`,
scope `workspace:act`, `Idempotency-Key` required, no request body (a non-empty body is
`400 malformed-request`).

1. Authentication and authorisation against current state, before the replay store
   ([`IDEMPOTENCY_REPLAY.md`](IDEMPOTENCY_REPLAY.md) §2.3).
2. The replay store runs the rest once per key: a same-key retry is replayed with
   `Idempotency-Replayed: true`; a concurrent same-key request is `409 idempotency-key-in-flight`.
3. Under the organisation lock, taken exclusively under the key function `FIRST_OWNER_BOOTSTRAP.md`
   §8.1 uses (`JOB_CATALOGUE.md` §1) for the step's one transaction. Unlike §8.1, the step
   **waits** for the lock instead of failing fast, for at most 2 seconds (`lock_timeout`, equal to
   every connection's `statement_timeout`, `config/environment.py`): the
   contract declares no answer for a busy lock, and WS-04 requires the second of two concurrent
   initialisations to answer `200`. A wait that runs out rolls the step back and answers `500`,
   which the client retries with the same key:
   1. organisation not `active`: `409 invalid-state-transition`, `allowed_states: [active]`;
   2. `workspace_setup` not `ready`: `409 invalid-state-transition`, `allowed_states: [ready]`;
   3. a workspace exists: `200`, nothing written, no audit;
   4. otherwise create §2's rows, write one audit event `workspace.initialised` with the
      workspace id and template version, and answer `201`.

   Both `201` and `200` carry `Location: /api/v1/organisations/{organisation_id}/workspace` and
   the body `{"state": "initialised"}`, nothing else. What the store keeps and replays for 24 hours
   therefore holds no category or channel name: a replay can never show a structure that has
   since changed, or a channel the caller may no longer view.
4. Every effect is a row of Core's database, so a `5xx` or an exception rolls the whole step back
   and a retry runs it again. Nothing is enqueued and no external system is called; a content
   service that needs rooms later gets them from its own job, never from this transaction.

The unique `workspace_organisation_unique` constraint is the backstop under the lock: a second
creator that bypassed it fails, rolls back and is answered as step 3.3 on retry.

## 7. Acceptance (K9)

Against the disposable PostgreSQL test database and the real HTTP view, each scenario with a
mutation that makes it fail by its own message.

| ID | Scenario | Must hold |
|---|---|---|
| WS-01 | Owner initialises a confirmed, active organisation | `201`, `Location`, body exactly `{"state": "initialised"}`; exactly §2's rows and values, stored `structure_revision` 1; one `workspace.initialised` event; a following `getWorkspace` shows §2's structure |
| WS-02 | Same key again | Byte-identical body and status, `Idempotency-Replayed: true`; no row or event added |
| WS-03 | Another key, or the admin, after WS-01 | `200`, the same `Location` and body; no row or event added |
| WS-04 | Owner and admin concurrently, two connections, two keys | One `201` and one `200`; one set of §2's rows; no `5xx` |
| WS-05 | Organisation `suspended` | `409 invalid-state-transition`, `allowed_states: [active]`; nothing written |
| WS-06 | Claim consumed, `owner_claim.confirmed` absent | `getWorkspace`: `pending` / `awaiting_owner_confirmation`, `can_initialise` false; initialise: `409`, `allowed_states: [ready]`; nothing written |
| WS-07 | `workspace_setup` over every row of §3 | The table's state and reason, row by row, including `leased` and `needs_reconciliation`; deleting any row or reordering rows 2 and 5 fails |
| WS-08 | Visibility | A restricted channel is absent for a member without a grant and present with an `allow_member` grant; a `deny_member` hides a channel from an `org_owner`; `team` is visible to every member; a category whose resolved default is restricted, with no visible channel, is absent; `provisioning` and `deletion_pending` channels are absent, `archived` is present as `archived` |
| WS-09 | Callers outside the four roles | Another organisation's member and a non-member: `404`; staff and `bootstrap`: refused; none sees a `200` |
| WS-10 | `org_billing`, `org_member` initialise | `403 forbidden`; nothing written; their `can_initialise` is false |
| WS-11 | The claim creates no workspace | After `consumeOwnerClaim`, `state` is `not_initialised` and no workspace row exists (`FIRST_OWNER_BOOTSTRAP.md` §8.6) |
| WS-12 | Fault after the categories are inserted | Rolled back, nothing persisted; the same key then runs and creates exactly §2's rows |
| WS-13 | Header and body refusals | Missing key `400 idempotency-key-missing`; a 15-character or space-containing key `400 malformed-request`; a non-empty body `400 malformed-request`, refused inside the step before the lock and stored under its key like every `4xx`; none writes a row |
| WS-14 | Contract conformance | Every response of the other scenarios validates against `contracts/core-api.openapi.yaml`, problem documents included |
| WS-15 | Per-view ETag | A member's tag is unchanged, and `If-None-Match` answers `304`, after a channel restricted from them is renamed or added; it changes when a visible channel is; after the member loses view of a channel, the old tag gets `200`, never `304`; no answer carries a revision |

## 8. Owed elsewhere

- `workspace.initialised` is registered in [`../domain/AUDIT_TAXONOMY.md`](../domain/AUDIT_TAXONOMY.md)
  §3 by K9, with the `workspace` URN type.
- `JOB_CATALOGUE.md` §1 lists `initialiseWorkspace` among the non-job takers of the organisation
  lock and leaves whether and how long it waits to §6 step 3, the one place that states the bound.
- The staff bootstrap view carries neither the owner's confirmation nor `issuer_untrusted` yet
  (`FIRST_OWNER_BOOTSTRAP.md` §8.7 says so); when it does, it reports §3's derivation.
- The contract's `JobStatus` lacks the queue's `needs_reconciliation`; §3 reads the queue's set.
- [`IDEMPOTENCY_REPLAY.md`](IDEMPOTENCY_REPLAY.md) §5's decoded-path item stays open.

## 9. Implementation notes (K9)

- **No rate limit yet.** §5's `429` is not served: Core has no rate limiter for any operation
  (`CONVENTIONS.md` §11 is policy, not code). It arrives for every read at once.
- **WS-11 without the claim.** `consumeOwnerClaim` is not on `main`. The test holds an activated
  organisation — an owner membership, its realm job succeeded, its owner confirmed — to
  `not_initialised` with no workspace row, which is what the claim leaves (§8.6 of the amendment);
  it is to be rerun through the claim when that operation lands.
- **A suspended organisation is read.** `getWorkspace` answers a `suspended` organisation's members
  with `200`, its setup as §3 derives it and `can_initialise` false (`AUTHZ.md` §2 step 8). The
  `initialiseWorkspace` on it is `409 invalid-state-transition`, `allowed_states: [active]`, not
  `402` or `403`: setting the workspace up is not use of the service, and the contract declares no
  `402` there (`AUTHZ.md` §2 step 8 says so for this operation). The
  member reader of [`workspace-member-parent-policy.md`](workspace-member-parent-policy.md) keeps
  its active-organisation limit, so the caller is read by `apps.orgs.actor_selectors`, which admits
  `active` and `suspended`; the channel facts are read in the same snapshot and evaluated by the
  same kernel.
- **Every role reads; two initialise.** The kernel's `eligible` set is `channel.view` for each of
  the four roles (`AUTHZ.md` §5, row `Workspace`); no role rule exists, so `role_ids`,
  `allow_roles` and `deny_roles` are empty. An unexpected stored role is `404`.
- **The event.** `workspace.initialised` carries `metadata.workspace_id` and
  `metadata.template_version`, `2` for §2's template (`1` before the audio room); its actor is
  the caller's identity.
- **Refusals.** Staff tokens are `403` on both operations, before any read of the organisation's
  data; a verified caller with no enabled identity is `403 identity-unknown`; another organisation, a non-member and a
  `bootstrap` principal are `404`. A non-empty body is refused inside the replayed step, so its
  `400` is replayed under its key like every other `4xx`.
- **Denials are recorded.** Every `403 forbidden` these operations answer writes one `authz.denied`
  (`AUTHZ.md` §9) in a transaction of its own, before the answer. They are: on
  `initialiseWorkspace`, `org_billing`, `org_member` and a staff token, with
  `metadata.required_scope` `workspace:act`; on `getWorkspace`, a staff token — a staff read
  refused — with `workspace:read`. Each carries `request_id`, the actor (the tenant identity, the
  stored staff identity, or `unknown`), the organisation as target and `metadata.reason`
  `role_missing`; never a token, a header or the body. A tenant read never answers `403 forbidden`:
  it is `200`, `401`, `403 identity-unknown` or `404`, and writes nothing. A denial that cannot be written answers `500`, logged
  by class, rather than an unrecorded `403`.
- **Failures are logged by class.** A `500` of either operation logs the exception's class and the
  request id, never the body, a header or the token.
- **Database privileges.** The image's profile was read-only. These operations add exactly: `SELECT`
  on `jobs_job` and `audit_auditevent`; `INSERT` on `workspaces_workspace`,
  `workspaces_resourcepolicy`, `workspaces_category`, `workspaces_channel`, `audit_auditevent` and
  `idempotency_record`; and, for the replay store and the default policy binding, `SELECT` on the
  workspace tables and `idempotency_record`, `UPDATE (default_policy_id)` on
  `workspaces_workspace` and `DELETE` on `idempotency_record` (an expired entry is replaced). They
  are part of the staff intake's least-privilege API writer role, `dev/api_writer_role.py`
  ([`ORGANISATION_INTAKE.md`](ORGANISATION_INTAKE.md) §4), and `tests/test_workspace_writer_role.py`
  initialises, replays, reads and refuses as that role, and shows it refused, by privilege, a listed
  set of other writes on the workspace tables and on its own audit rows. Recorded in [`CUSTOMER_HTTP_RUNTIME.md`](CUSTOMER_HTTP_RUNTIME.md).

## Changelog

- First version, with contract 0.13.0: the text-first starter template, the setup-state
  derivation from the latest `realm_create` job, the trust list and the owner's confirmation, the
  console rendering per state, `getWorkspace` and `initialiseWorkspace`, and fourteen acceptance
  scenarios for K9.
- After review: `initialiseWorkspace` answers `Location` and its state only, so no replay carries
  a structure; a retry reuses its key only after a `5xx` or a network failure; no structure
  revision on the wire and a per-view `ETag` with conditional `GET`; catalogue keys namespaced by
  kind; `429` on `getWorkspace`; `cancelled` is `failed` and cured by `requeue_realm_bootstrap`;
  WS-15.
- K9: the implementation notes of §9; the lock waits, bounded, instead of failing fast (§6); what
  "trusted" and "confirmed" are read from (§3); the template key's uniqueness (§2).
- K9 fix round 2: the staff `403` of `getWorkspace` is recorded too, and a denial that cannot be
  recorded answers `500` (§9).
- K9 fix round: the lock wait is bounded at 2 seconds; every `403` of `initialiseWorkspace` is
  recorded as `authz.denied`; a suspended organisation's `409` is cited from `AUTHZ.md`; failures
  are logged by class; the database privileges the operations add are listed (§9).
- K9 rebased on the ratified first-owner amendment (#154) and the staff intake (#164): the
  citations and §8 follow what merged, and the workspace grants are part of the intake's API writer
  role (§9).
- §2 is amended for contract 0.22.0 ([`ESPACE_STRUCTURE.md`](ESPACE_STRUCTURE.md) §8): template
  version 2 adds the audio room `lounge` in `team` and records `template_version: 2`; the "Audio
  later" paragraph becomes that rule, and a workspace initialised under version 1 keeps an empty
  `team`.
- Contract 0.28.0: a verified caller with no enabled identity is `403 identity-unknown`, not
  `401`, on both operations; it names no principal and writes no `authz.denied`.
