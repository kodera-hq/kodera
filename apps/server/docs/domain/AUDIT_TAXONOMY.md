# Audit taxonomy

**Status:** Proposed · **Owner:** Worker seat

`AuditEvent` is the control plane's evidence. It backs the accountability clause of the data-processing agreement, it is what a customer exports when they ask what we did to their tenant, and it is the only durable record of who changed what. ADR-0004 makes jobs and their audit rows the audit trail for infrastructure mutations, and every other control-plane change commits with its own `AuditEvent`; this document fixes the row shape, the closed action registry, the retention split and the export format.

## 1. Schema

| Column | Type | Rule |
|---|---|---|
| `id` | UUIDv7 | Deterministic tie-breaker after `occurred_at`; never the only ordering key |
| `occurred_at` | timestamptz | When the change happened, not when the row was written |
| `actor_type` | enum | `staff` \| `tenant` \| `agent` \| `system` |
| `actor_id` | UUIDv7 NULL | `Identity` for `staff` and `tenant`, `Agent` for `agent`, null for `system` |
| `actor_label` | text | A stable pseudonym, never an email address (§4) |
| `organisation_id` | UUIDv7 NULL | The organisation the event concerns; null only for fleet-level events |
| `action` | text | A member of the closed registry in §3 |
| `target_urn` | text | §2 |
| `before` | jsonb NULL | Redacted prior values of the changed fields only |
| `after` | jsonb NULL | Redacted new values of the changed fields only |
| `request_id` | text NULL | Correlates with the API request |
| `job_id` | UUIDv7 NULL | Correlates with the job |
| `source_ip_trunc` | inet NULL | IPv4 truncated to /24, IPv6 to /48; see §4 |
| `retention_class` | enum | `short` \| `standard` (§4) |
| `metadata` | jsonb | Action-specific, schema-checked per action |
| `hash_prev`, `hash_self` | bytea | Tamper-evidence chain (§5) |

The table is **append-only**: no `UPDATE`, no `DELETE` outside the retention job, enforced by a trigger and proven by a mutation test.
Audit organisation scope is currently a caller convention, not an exhaustively enforced runtime
boundary: writers accept nullable organisation scope and the database has no central discriminator.
Callers are responsible for carrying their locked organisation when one exists and for using null
only for a genuine fleet event. This is an explicit current gap, especially for mixed actions such
as authentication denials or unresolved payment reconciliation. A future enforceable guard needs
an organisation-required, fleet-required or mixed predicate for every action plus matching writer
and database migrations.

`actor_type` semantics:

| Value | Who | Typical actions |
|---|---|---|
| `staff` | A Kodera operator or support agent in the `kodera-staff` realm | Provisioning, suspension, restore, plan changes |
| `tenant` | A person acting inside their own organisation | Invitations, role changes, domain requests, export requests |
| `agent` | A tenant's agent process | Backup reports, command results, heartbeat-derived state |
| `system` | A scheduler, a webhook processor, a retention job | Dunning transitions, drift findings, nightly backups, purges |

The public `AuditEvent.actor.type` wire enum keeps `user` for compatibility. Core maps that value
exactly to the canonical/runtime `tenant` actor type; `staff`, `agent` and `system` map identically.
The OpenAPI `x-canonical-audit-actor-map` is the executable boundary mapping, not a second actor
vocabulary.

## 2. Target URN

```
urn:kodera:<type>:<id>
```

`<type>` is the lower-case entity name; `<id>` is the entity's UUIDv7, or its slug where the slug is the addressing key.

| Type | Identifier | Example |
|---|---|---|
| `organisation` | slug | `urn:kodera:organisation:acme-org` |
| `user` | UUIDv7 | `urn:kodera:user:019467a3-0f9d-7eb5-b9e4-3bc6a04ab784` |
| `identity` | UUIDv7 | `urn:kodera:identity:019467a3…` |
| `membership` | UUIDv7 | `urn:kodera:membership:019467a3…` |
| `invitation` | UUIDv7 | |
| `member_import` | UUIDv7 | |
| `enrolment_token` | UUIDv7 | |
| `owner_claim` | UUIDv7 | |
| `tenant` | slug | `urn:kodera:tenant:acme` |
| `host`, `ip`, `domain` | UUIDv7 | `urn:kodera:domain:019467a3…` |
| `release`, `tenant_release` | UUIDv7 | |
| `backup`, `probe`, `status_component` | UUIDv7 | |
| `secret` | `<tenant-slug>/<name>/<version>` | `urn:kodera:secret:acme/oidc_client_secret/3` |
| `agent` | UUIDv7 | |
| `job` | UUIDv7 | |
| `outbox_delivery` | UUIDv7 | |
| `plan`, `price` | `<code>/<version>` | `urn:kodera:plan:business/4` |
| `order`, `subscription`, `invoice`, `credit_note`, `payment` | UUIDv7 | |
| `export`, `deletion_certificate` | UUIDv7 | |
| `support_ticket` | UUIDv7 | |
| `realm` | realm name | `urn:kodera:realm:acme-org` |
| `workspace` | UUIDv7 | |
| `category` | UUIDv7 | |
| `channel` | UUIDv7 | |
| `member_set` | UUIDv7 | |
| `channel_set` | UUIDv7 | |

Rules: a URN is stable for the life of the entity and survives its deletion, which is why a deletion certificate can still name a purged organisation. A URN never contains an email address, a personal name or a secret value.

## 3. Action registry

`action` is `<domain>.<verb_phrase>`, lower snake case, past tense. The registry is **closed**: a new
action is a pull request that adds a row here and to `contracts/core-api.openapi.yaml`. An
unregistered action fails the contract test. Current runtime enforcement is partial and
service-specific: `AuditEvent.action` itself does not yet reject every unregistered action, and the
complete writer guard remains expected-red.

### Authentication and authorisation

| Action | Actor | Target | Retention | Notes |
|---|---|---|---|---|
| `auth.login_succeeded` | tenant, staff | `identity` | standard | `metadata.amr`, `metadata.realm` |
| `auth.login_failed` | tenant, staff | `identity` or `organisation` | standard | No credential material |
| `auth.mfa_enrolled` | tenant, staff | `identity` | standard | |
| `auth.token_rejected` | system | `organisation` | standard | `metadata.reason` from the closed reason list |
| `authz.denied` | any | the attempted target | standard | `metadata.required_scope`, `metadata.reason` |
| `staff_role.granted`, `staff_role.revoked` | staff, system | `identity` | standard | Fleet-level, no organisation. `metadata.role`, `metadata.grant_id`; the actor is the acting staff identity, a different identity from the target's (two-person rule), or the system for the one-time bootstrap, with `metadata.reason` `bootstrap` ([`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md) §4) |
| `agent.enrolled` | staff | `agent` | standard | A staff operator's `enrol_tenant_agent`; `metadata.tenant_id`, never the token |
| `agent.revoked` | staff | `agent` | standard | A staff operator's `revoke_tenant_agent`; `metadata.tenant_id` |
| `agent.enrolment_reused` | agent | `agent` | standard | Alerting event |
| `agent.fingerprint_mismatch` | agent | `agent` | standard | Alerting event |
| `agent.replay_detected` | agent | `agent` | standard | |

### Organisations and people

| Action | Actor | Target | Retention |
|---|---|---|---|
| `organisation.created` | staff, tenant | `organisation` | standard |
| `organisation.intake_recorded` | staff | `organisation` | standard |
| `organisation.activated` | tenant | `organisation` | standard |
| `identity.bound` | system; staff for the pilot only (`FIRST_OWNER_BOOTSTRAP.md` §10.3; ends with the identity worker or before the first paying customer) | `identity` | standard |
| `owner_claim.issued` | system; staff for the pilot only (`FIRST_OWNER_BOOTSTRAP.md` §10.3; ends with the identity worker or before the first paying customer) | `owner_claim` | standard |
| `owner_claim.expired` | system | `owner_claim` | standard |
| `owner_claim.consumed` | tenant | `owner_claim` | standard |
| `owner_claim.confirmed` | staff, for the pilot only (`FIRST_OWNER_BOOTSTRAP.md` §§8.7, 10.3, PC-10; ends with the identity worker or before the first paying customer) | `owner_claim` | standard |
| `owner_claim.revoked` | staff, system | `owner_claim` | standard |
| `organisation.updated` | staff, tenant | `organisation` | standard |
| `organisation.suspended`, `organisation.resumed`, `organisation.terminated` | staff, system | `organisation` | standard |
| `membership.created` | tenant, staff | `membership` | standard |
| `membership.role_changed`, `membership.suspended`, `membership.reactivated`, `membership.removed` | tenant | `membership` | standard |
| `invitation.sent`, `invitation.resent`, `invitation.accepted`, `invitation.revoked`, `invitation.expired` | tenant, staff, system | `invitation` | standard |
| `member_import.created`, `member_import.validated`, `member_import.executed`, `member_import.discarded`, `member_import.expired`, `member_import.staging_scrubbed` | tenant, staff, system | `member_import` | standard |
| `enrolment_token.issued`, `enrolment_token.claimed`, `enrolment_token.revoked`, `enrolment_token.expired` | tenant, staff, system | `enrolment_token` | standard |
| `contact.created`, `contact.updated`, `contact.removed` | tenant, staff | `organisation` | standard |
| `dpa.accepted` | tenant | `organisation` | standard |
| `dpa.contract_closed` | staff, tenant, system | `organisation` | standard |

`dpa.contract_closed` is emitted in the same transaction as the sole contract-close write. Its
metadata is exactly `dpa_acceptance_id`, `order_id`, `subscription_id`, `organisation_id`,
`contract_ended_at`, `close_reason` and immutable `close_evidence_ref`, copied from the locked
ten-year DPA row. A `staff` or `tenant` event
records the authenticated actor identity; a `system` event records its authenticated job authority.
The writer locks all three legal rows, requires exact authority/scope equality and refuses the event
unless all three rows receive the identical contract end and derived deadlines atomically.

### Tenancy

| Action | Actor | Target | Retention |
|---|---|---|---|
| `tenant.ordered`, `tenant.provision_requested`, `tenant.ready`, `tenant.activated` | tenant, staff | `tenant` | standard |
| `tenant.failed` | staff, system | `tenant` | standard |
| `tenant.project_bootstrap_recorded`, `tenant.project_bootstrap_replaced` | staff | `tenant` | standard |
| `tenant.project_bootstrap_verified`, `tenant.host_created`, `tenant.dns_created`, `tenant.secrets_created`, `tenant.agent_enrolled` | system | `tenant` | standard |
| `tenant.ordered_cancellation_cleanup_recorded` | tenant, staff, system | `tenant` | standard |
| `tenant.ordered_cancellation_cleanup_closed`, `tenant.ordered_cancellation_cleanup_verified` | staff | `tenant` | standard |
| `tenant.ordered_cancellation_cleanup_finalized` | system | `tenant` | standard |
| `tenant.preflight_passed`, `tenant.preflight_failed` | system | `tenant` | standard |
| `tenant.plan_changed`, `tenant.capacity_tier_changed`, `tenant.apps_changed` | staff, tenant | `tenant` | standard |
| `tenant.maintenance_on`, `tenant.maintenance_off` | system | `tenant` | standard |
| `tenant.upgrade_requested`, `tenant.snapshot_taken`, `tenant.release_applied`, `tenant.release_rolled_back` | staff, system | `tenant` | standard |
| `tenant.suspended`, `tenant.resumed` | staff, system | `tenant` | standard |
| `tenant.restore_requested`, `tenant.restore_completed`, `tenant.restore_failed` | staff, system | `tenant` | standard |
| `tenant.drift_detected`, `tenant.maintenance_mismatch` | system | `tenant` | standard |
| `tenant.decommission_requested`, `tenant.infrastructure_destroyed`, `tenant.realm_deleted`, `tenant.deletion_certificate_issued`, `tenant.deleted` | staff, system | `tenant` | standard |
| `tenant.purged` | system | `tenant` | standard |

`tenant.project_bootstrap_recorded` and `tenant.project_bootstrap_replaced` carry in `metadata` the provider identifiers, policy digest, key fingerprint, expiry and evidence reference of the `ProjectBootstrap` row ([`MODEL.md`](MODEL.md) §5), never a secret value and never the content behind `secret_ref`. There is no `tenant.project_created`: the project is created by a person outside Core (ADR-0005), and a registry member no job emits is a name a contract test cannot check.

The future ordered-cancellation cleanup actions bind every state transition to the exact cleanup id,
cancelled order, tenant, organisation and immutable bootstrap-scope digest. `...recorded` carries the
scope reference/digest but no secret; `...closed` carries the operator identity and closure-evidence
digest; `...verified` carries the distinct `staff_security` identity and fresh absence-evidence
digest; `...finalized` commits with the initial-attestation and `tenant.deleted` actions. No state
write occurs without its action in the same transaction.

`tenant.realm_deleted` is kept for the organisation-offboarding realm job that removes an organisation's realm. No kind of [`JOB_CATALOGUE.md`](JOB_CATALOGUE.md) emits it today: a tenant's `delete` never deletes the realm, and that job is a follow-up, not yet a kind. The future writer targets the final tenant and, after fencing and draining the realm's identity-backup generation and obtaining an authenticated fresh provider read proving the realm absent, commits this event in the same control-plane transaction as `Organisation.closed` and the `closure_scope = final_organisation` active-store attestation.

`tenant.deletion_certificate_issued` is the legacy action for the initial active-store deletion
attestation. The future durable cutoff finalizer emits it with
`metadata.closure_scope = tenant_only` after a tenant `delete`; the future corrected
ordered-cancellation transaction with no lifetime `ProjectBootstrap` emits the same action with
that scope and canonical `never_provisioned` workload/data-store evidence. If any lifetime
bootstrap boundary existed, only the future cleanup finalizer emits it, after authenticated
complete-scope project/application/policy/key retirement and absence evidence is sealed. The future
organisation-offboarding writer emits it against the final tenant with
`metadata.closure_scope = final_organisation` in the transaction above. It never claims that
locked backups are gone. The follow-up purge job must add a
distinct final-certificate action here and in `contracts/core-api.openapi.yaml` in the same change;
that job and action do not exist yet.

### Domains, releases, backups, secrets

| Action | Actor | Target | Retention |
|---|---|---|---|
| `domain.added`, `domain.verification_started`, `domain.txt_verified`, `domain.certificate_issued`, `domain.live`, `domain.failed`, `domain.canonical_changed`, `domain.removed` | tenant, staff, system | `domain` | standard |
| `release.created`, `release.approved`, `release.withdrawn` | staff | `release` | standard |
| `backup.started`, `backup.succeeded`, `backup.failed`, `backup.restore_drill_passed`, `backup.restore_drill_failed` | system, agent | `backup` | standard |
| `secret.rotation_requested`, `secret.rotated`, `secret.rotation_failed` | staff, system | `secret` | standard |
| `realm.created`, `realm.verification_failed` | system; staff for the pilot only (`FIRST_OWNER_BOOTSTRAP.md` §10.3; ends with the identity worker or before the first paying customer) | `realm` | standard |
| `realm.updated`, `realm.client_changed`, `realm.idp_changed` | system | `realm` | standard |

### Billing

| Action | Actor | Target | Retention |
|---|---|---|---|
| `plan.published`, `plan.deprecated`, `price.published`, `price.deprecated` | staff | `plan`, `price` | standard |
| `subscription.created`, `subscription.changed`, `subscription.terminated` | staff, tenant | `subscription` | standard |
| `subscription.cancelled` | staff, tenant, system | `subscription` | standard |
| `order.confirmation_enqueued` | system | `order` | standard |
| `order.terminated` | system | `order` | standard |
| `order.complimentary` | staff | `order` | standard |
| `invoice.issued`, `invoice.sent`, `invoice.paid`, `invoice.overdue`, `invoice.voided` | staff, system | `invoice` | standard |
| `credit_note.issued` | staff, system | `credit_note` | standard |
| `credit_note.notice_enqueued` | system | `credit_note` | standard |
| `payment.received`, `payment.failed`, `payment.refunded`, `payment.reconciled`, `payment.reconciliation_mismatch` | system | `payment` | standard |
| `payment.placed_on_account`, `payment.allocated` | staff, system | `payment` | standard |
| `dunning.reminder_sent`, `dunning.formal_notice_sent`, `dunning.suspension_notice_sent`, `dunning.suspended`, `dunning.terminated`, `dunning.cleared` | system | `organisation` | standard |
| `vat.vies_checked`, `vat.regime_changed` | system, staff | `organisation` | standard |

`payment.placed_on_account` and `payment.allocated` are the only allocation-decision actions. Each
is emitted in the same transaction as its monotonic Payment transition. Metadata is exactly
`payment_id`, `organisation_id`, `previous_allocation_state`, `allocation_state` and immutable
`decision_evidence_ref`, plus `invoice_id` and `invoice_number` for `payment.allocated`; those two
invoice keys are absent for `payment.placed_on_account`. A `staff` event records the authenticated
actor identity; a `system` event records its authenticated reconciliation or job authority.

### Workspaces

| Action | Actor | Target | Retention |
|---|---|---|---|
| `workspace.initialised` | tenant | `workspace` | standard |
| `workspace.category_created` | tenant | `category` | standard |
| `workspace.category_updated` | tenant | `category` | standard |
| `workspace.category_deleted` | tenant | `category` | standard |
| `workspace.channel_created` | tenant | `channel` | standard |
| `workspace.channel_updated` | tenant | `channel` | standard |
| `workspace.channel_archived` | tenant | `channel` | standard |
| `workspace.channel_unarchived` | tenant | `channel` | standard |
| `workspace.channel_access_changed` | tenant | `channel` | standard |
| `workspace.channel_set_refused` | system | `workspace` | standard |

`workspace.initialised` is written once per organisation, in the transaction of `initialiseWorkspace` that creates the starter workspace ([`../specs/PILOT_WORKSPACE_ONBOARDING.md`](../specs/PILOT_WORKSPACE_ONBOARDING.md) §6). `metadata` carries `workspace_id` and `template_version` (`2` since the starter template gained the audio room `lounge`, [`../specs/ESPACE_STRUCTURE.md`](../specs/ESPACE_STRUCTURE.md) §8), never a category or channel name.

`workspace.channel_set_refused` is written by the system when a membership change commits and the channel set it should have recorded is refused by its emitter ([`../specs/ESPACE_STRUCTURE.md`](../specs/ESPACE_STRUCTURE.md) §13.5): a change of who belongs is never blocked by the Espace. `metadata` carries the change's `reason` and the emitter's `problem`.

The other eight are written by the structure administration of [`../specs/ESPACE_STRUCTURE.md`](../specs/ESPACE_STRUCTURE.md) §9, one per change, in the transaction that makes it, with the acting owner or admin as actor; a request that changes nothing writes none. `metadata` carries ids, kinds, positions, the changed field names and the access tag, and never a name, a topic or a member's personal data:

- every row: `workspace_id`, and the `category_id` or `channel_id` its target names;
- `workspace.category_created` and `workspace.category_deleted`: `position`; `workspace.category_updated`: `changed`, the sorted names of the fields that changed (`name`, `position`), and the new `position`;
- `workspace.channel_created`: `kind`, `category_id` (or null) and `position`; `workspace.channel_updated`: `kind`, `changed` (`name`, `topic`, `category_id`, `position`), the new `category_id` and `position`; `workspace.channel_archived` and `workspace.channel_unarchived`: `kind`;
- `workspace.channel_access_changed`: `kind`, the new `mode`, `visibility`, `read_only` and `listen_only`, the access `etag` after the change, the membership ids of `allow_members_added`, `allow_members_removed`, `deny_members_added` and `deny_members_removed`, and `self_grant: true` when the caller granted themselves a channel they could not view before the change (`../api/AUTHZ.md` §6 rule 8). A membership id is a pseudonymous key, never a contact.

### Engine member sets

| Action | Actor | Target | Retention |
|---|---|---|---|
| `engine_member_set.issued` | system | `member_set` | standard |
| `engine_member_set.refused` | system | `organisation` | standard |
| `engine_member_set.applied`, `engine_member_set.failed` | agent | `member_set` | standard |

ADR-0016. `engine_member_set.issued` is written in the transaction that records an organisation's member set, which is the transaction of the membership change it follows; `metadata` carries the `revision`, the `reason` and the count of each list, never a subject, `erased` when inactive subjects of erased people are listed for erasure (ADR-0018), `unnamed_leavers` when a leaver had no realm subject the set could name, and `malformed_subjects` when subjects outside the contract's shape were left out (quarantined). `engine_member_set.refused` is written when a set failed closed and rolled its membership change back, in a transaction of its own after that rollback; `metadata` carries the `reason` and the `problem`: `malformed_subjects`, with their count, when a leaver of the change had a subject outside the contract's shape, or `over_bound`, with the `subjects` count and the `bound`, when the set exceeded it while an agent would receive it. `engine_member_set.applied` and `engine_member_set.failed` are written when a tenant agent reports the terminal result of the set's command; the actor is the agent credential, and `metadata` carries the `revision`, the `command_id`, the `attempt`, and either the result's counts or its `error_code`.

### Engine channel sets

| Action | Actor | Target | Retention |
|---|---|---|---|
| `engine_channel_set.issued` | system | `channel_set` | standard |
| `engine_channel_set.applied`, `engine_channel_set.failed` | agent | `channel_set` | standard |

ADR-0018. `engine_channel_set.issued` is written in the transaction that records an organisation's channel set, which is the transaction of the workspace change it follows; `metadata` carries the `revision`, the `reason`, and the counts of channels, members and notices, never a name, a topic or a subject. `engine_channel_set.applied` and `engine_channel_set.failed` are written when a tenant agent reports the terminal result of the set's command; the actor is the agent credential, and `metadata` carries the `revision`, the `command_id`, the `attempt`, the `error_code` of a failure, and the result's counts and `failed_channel_ids`.

### Jobs and the platform itself

| Action | Actor | Target | Retention |
|---|---|---|---|
| `job.created`, `job.started`, `job.step_succeeded`, `job.step_failed`, `job.succeeded`, `job.failed`, `job.cancelled`, `job.orphaned` | any | `job` | standard |
| `job.reconciliation_required` | system | `job` | standard |
| `job.reconciliation_decided`, `job.state_force_unlocked` | staff | `job` | standard |
| `export.requested`, `export.ready`, `export.collected`, `export.expired` | tenant, system | `export` | standard |
| `audit.exported` | tenant, staff | `organisation` | standard |
| `retention.purged` | system | the purged type | standard |
| `support.ticket_linked`, `support.ticket_closed` | tenant, staff | `organisation` | standard |
| `support.ticket_opened` | tenant | `support_ticket` | standard |
| `notification.sent` | system | `organisation` | short |
| `outbox_delivery.sent`, `outbox_delivery.deferred`, `outbox_delivery.failed`, `outbox_delivery.reconciliation_required` | system | `outbox_delivery` | standard |
| `outbox_delivery.drift_detected` | system | `outbox_delivery` | standard |
| `outbox_delivery.reconciliation_decided` | staff | `outbox_delivery` | standard |
| `enduser.session_observed` | system | `tenant` | **short** |

`job.reconciliation_required` is written when a job enters `needs_reconciliation` (ADR-0004, [`JOB_CATALOGUE.md`](JOB_CATALOGUE.md) §1), by the runner or by the sweeper; `metadata` carries the `unresolved_step` and `unresolved_operation_ref` it recorded, and the event alerts. `job.reconciliation_decided` is the operator's decision that takes the job out of that state; `metadata` carries the exit (`resume` or `fail`), the `reconciliation_decision_ref` and the `staff_role_grant_ref` of the `staff_operator` grant the decision relied on ([`../specs/STAFF_IDENTITY.md`](../specs/STAFF_IDENTITY.md) §5), never the evidence's content. `job.state_force_unlocked` is **operator-only**: a person runs `tofu force-unlock` after such a decision is recorded, `metadata` carries the lock identifier and the decision reference, and nothing automatic emits it: its only actor is `staff`.

The four `outbox_delivery.*` actions record what a run of the mail sender did with a `message` delivery ([`../specs/OUTBOX_MAIL_SENDER.md`](../specs/OUTBOX_MAIL_SENDER.md) §8): `metadata` carries the attempt's sequence number, the template id, the SMTP reply code and a `reason` from that section's closed set, and `outbox_delivery.sent` adds the `Message-ID` and the provider's queue identifier. Never the recipient, the subject, the body, the link or its secret.

The same four actions record what a run of the realm access delivery did ([`../specs/MEMBERSHIP_LIFECYCLE.md`](../specs/MEMBERSHIP_LIFECYCLE.md) §6.1.3): `metadata` carries the attempt's sequence number, the `operation` (`access_off` or `access_on`), the HTTP status (or null) and a `reason` from that section's closed set (`user_absent`, `transport`, `credential`, `temporary`, `readback_mismatch`, `attempt_abandoned`, `rejected`, `attempts_exhausted`, `payload_mismatch`, `withdrawn`, `outcome_unknown`, `not_found_inconsistent`, `deadline`). Never a token, a secret, a user representation or an address.

`outbox_delivery.reconciliation_decided` is the operator's decision that takes a delivery out of `needs_reconciliation` ([`../specs/JOB_QUEUE.md`](../specs/JOB_QUEUE.md) §7), written in the decision's transaction by `record_delivery_reconciliation_decision`, as `job.reconciliation_decided` is for a job: the actor is the deciding staff identity, the organisation is the delivery's, and `metadata` carries the exit (`resume` or `fail`), the `reconciliation_decision_ref` and the `staff_role_grant_ref` of the `staff_operator` grant the decision relied on, never the evidence's content. A refused decision writes none.

`enduser.session_observed` and `notification.sent` are the only actions permitted to carry a `source_ip_trunc` derived from an end user rather than an administrator.

## 4. Redaction, pseudonymisation, retention

**Redaction of `before` / `after`.** Only the fields that changed are recorded, and every field passes a redaction pass before it is written:

| Field class | Treatment |
|---|---|
| Secret values, token hashes, wrapped keys, private keys | Never written. The key is present with the value `"[redacted]"` so the shape of the diff is honest |
| Contact name, email, phone | Replaced by a stable HMAC pseudonym; the plaintext stays in the encrypted `Contact` row |
| Free-text customer content (ticket subjects, document titles, room names) | Never written. A message-catalogue key or a length is written instead |
| Identifiers (UUIDv7 values, slugs, plan codes, amounts, states) | Written as they are |
| Anything else | Rejected: writing an audit diff with an undeclared field raises in development and is dropped with a counter in production |

**`actor_label`.** `HMAC-SHA256(pepper, identity_id)` truncated to 16 hex characters, prefixed with the actor type: `staff:9f3c…`, `tenant:41ab…`. The pepper lives with the application, not in the database, and rotating it breaks correlation deliberately. An operator resolving a label to a person does so through the `Identity` table under a `staff_operator` scope, and that lookup is itself audited.

**IP addresses.** `source_ip_trunc` is never a full address. Administrative and authentication events keep the truncated administrator address for 12 months; anything derived from an end user of a tenant (a participant, a document reader) is `retention_class = short`.

**The split**, as decided in the strategy review:

| Class | Contents | Kept |
|---|---|---|
| `short` | Events carrying an end-user-derived IP or session signal | **7 days**, then hard-deleted |
| `standard` | Administrative, authentication and authorisation events, pseudonymised as above | **12 months**, then hard-deleted |

Billing events are additionally mirrored into the accounting record, which follows its own ten-year obligation; the audit copy still expires at 12 months. Deletion is performed by the nightly retention job, which emits `retention.purged` with counts per class and never with identifiers.

## 5. Tamper evidence

Each row stores `hash_self = sha256(canonical_json(row without hashes) || hash_prev)`, where `hash_prev` is the previous row's `hash_self` **per organisation** (and a fleet chain for organisation-less rows). The chain head per organisation is published in the daily export manifest.

This detects a silently modified or removed row without pretending to be a write-once store: an operator with database access can still rewrite the chain, which is why the head is exported daily and why the retention job's deletions are always a prefix of the chain, recorded as such.

## 6. Export format

The export backs the accountability clause of the data-processing agreement and the "audit-log export" entitlement of the upper plans. It is produced by the `export` job (`audit_jsonl` scope) or by `GET /api/v1/organisations/{slug}/audit/export`.

**Format: JSON Lines, UTF-8, one event per line, ordered by (`occurred_at`, `id`).** Not CSV — the `before`/`after` diffs are nested — and not a single JSON array, so a large export streams.

```json
{"id":"019467a3-0f9d-7eb5-b9e4-3bc6a04ab784","occurred_at":"current baselineT08:14:22Z","actor_type":"staff","actor_label":"staff:9f3c1a77b2e40d58","organisation":"urn:kodera:organisation:acme-org","action":"tenant.suspended","target":"urn:kodera:tenant:acme","before":{"status":"active"},"after":{"status":"suspended","status_reason":"non_payment"},"request_id":"019467a3-0f9b-7cc3-98c2-1fa48f28f562","job_id":"019467a3…","source_ip_trunc":"203.0.113.0/24","hash_self":"3f9a…"}
```

The archive contains:

| File | Contents |
|---|---|
| `events.jsonl` | The events, ordered |
| `manifest.json` | Organisation URN, event count, `id` range, `occurred_at` range, the chain head `hash_self`, the `sha256` of `events.jsonl`, the schema version, and the exporting principal's `actor_label` |
| `schema.json` | The JSON Schema `events.jsonl` validates against |
| `actions.md` | The registry rows for every action present, so the file is readable without this document |

Rules:

- The export contains only rows whose `organisation_id` matches, plus fleet events that name that organisation as a target. It never contains another customer's rows, and a test asserts this on a database holding two organisations.
- Pseudonyms are exported as they are stored. We do not resolve `actor_label` to a person in an export; a customer asking who a label is gets an answer through a documented request, recorded as `audit.exported` with the reason.
- Producing an export is itself an event (`audit.exported`), so the accountability record includes its own disclosure history.
- Exports are encrypted to the customer's key by the `export` job (see [`JOB_CATALOGUE.md`](JOB_CATALOGUE.md)). An ordinary export is available for at most 30 days from successful publication; a recovery-window export ends at the earlier of that expiry and `TenantExit.effective_access_ends_at`.

## 7. What a reviewer checks

- [ ] Every new action is in the registry in §3 with an actor, a target type and a retention class.
- [ ] The event is written in the same transaction as the change it describes.
- [ ] `before` / `after` carry only changed fields and pass the redaction pass; no secret, no email address, no free-text customer content.
- [ ] The target is a well-formed URN of a type in §2.
- [ ] `request_id` is set for API-driven events, `job_id` for job-driven ones.
- [ ] Nothing writes a full IP address anywhere.
- [ ] A `short`-class action is justified in the pull request.

## Changelog

- First version. Fixes assessment item C4 (audit half): the `AuditEvent` schema with four actor types, the `urn:kodera:<type>:<id>` target format, the closed action registry, redaction and pseudonymisation rules, the 7-day / 12-month retention split from the strategy review, a tamper-evidence chain, and the JSON Lines export that backs the data-processing agreement's accountability clause.
- Adds the project-bootstrap verification event required by ADR-0005.
- Uses UUIDv7 only as the deterministic tie-breaker after `occurred_at` and adds
  the count-only member-import lifecycle actions required by ADR-0011.
- Reconciles §3 actors with the role matrix this change ships, and splits the membership
  row so that each action carries the actors it can actually have.
  `membership.role_changed` and `membership.removed` drop to `tenant`: after this change
  `PATCH` and `DELETE /organisations/{organisation_id}/memberships/{membership_id}` are
  `org_owner, org_admin` only. `membership.created` keeps `staff`, because **two**
  operations of [`../../contracts/core-api.openapi.yaml`](../../contracts/core-api.openapi.yaml)
  create a `Membership` and they do not carry the same scope. `POST /invitations/accept`
  is the sole path that creates one under `membership:create`; `POST /organisations`
  creates the organisation's first `org_owner` membership under `organisation:create` —
  its description says "The caller becomes `org_owner`" and its grant is
  `org_owner, staff_operator`. The second is not avoidable: `InvitationRole` is
  `org_admin | org_billing | org_member`, and [`MODEL.md`](MODEL.md) requires at least one
  non-deleted `org_owner` per active organisation, so an accepted invitation can never
  produce an organisation's first owner. **The count of two is of the operations that create
  a `Membership` as [`MODEL.md`](MODEL.md) §`Membership` defines it** — accepted, with no
  `state` column and no `source` — and it is bounded here because the contract defines the
  entity differently: `Membership.state` admits `invited`, `person_id` reads "Null while the
  invitation is not accepted" and `source` is
  `invitation | enrolment_token | federation | order | staff`, so on that reading the row
  exists from the moment of invitation and `inviteToOrganisation` and `executeMemberImport`
  create one as well — **four**, both of them `org_owner, org_admin, staff_operator` and so
  a further reason for the `staff` actor here. This row is therefore stated by effect and
  not by scope name — a sweep over `membership:*` finds only `POST /invitations/accept`, on
  either count. Claiming a shared enrolment token also grants `org_member`, and no operation
  of either contract exposes that claim, so it is on neither count.
- That `staff_operator` grant on `POST /organisations` contradicts
  [`../api/AUTHZ.md`](../api/AUTHZ.md) §4 and ADR-0010, which both say no staff role may
  create a tenant membership for itself. It is pre-existing, unchanged by this pull request
  and an owner's to settle; until it is settled the membership it creates stays auditable
  under a `staff` actor, because an audit row that cannot legally exist is not a control.
  The invitation and enrolment-token rows gain `staff` on that same principle:
  `staff_operator` may send, resend and revoke an invitation and may issue and revoke an
  enrolment token, and without it a staff-assisted invitation had no legal actor to be
  audited under.
- Records the contract change that removed both grounds the previous entry gave the `staff`
  actor on `membership.created`: `POST /organisations` now creates no membership — first
  ownership is the first-owner claim protocol, whose operations are not yet in the contract —
  and `inviteToOrganisation` and `executeMemberImport` are `org_owner, org_admin` only. `staff`
  stays on `membership.created`, `invitation.*`, `member_import.*` and `enrolment_token.*`
  deliberately: an actor the registry cannot name is an event that cannot be written, and the
  registry records what happened rather than asserting what cannot.
- Adds the rows the first-owner claim protocol of `FIRST_SLICE_SPEC.md` §P1 emits, now that
  the contract carries its operations: `organisation.intake_recorded` under the `staff` actor of
  `createOrganisation`, whose `metadata` carries the `instruction_ref` and never the intended
  owner's address; `identity.bound` for the worker's recording of the intended owner's verified
  `(iss, sub)`; the four `owner_claim.*` rows with the `owner_claim` URN type, `issued` and
  `expired` being the worker's, `consumed` the claimant's and `revoked` staff's or the system's;
  and `organisation.activated` for the `prospect` to `active` transition. `membership.created`
  gains no actor: the first owner is created by the claimant, a `tenant` actor the row already
  names, with `metadata.source = owner_claim`. Every refusal of `consumeOwnerClaim` is
  `authz.denied` with the claim's state as `metadata.reason`, never a `metadata` member that
  carries the token. The `owner_claim.revoked` row has a `staff` actor before the contract
  carries a staff revoke operation, on the principle of the previous entry.
- Replaces the orphan `tenant.project_created`, which no job emits since ADR-0005 moved project creation to a person, with `tenant.project_bootstrap_recorded` and `tenant.project_bootstrap_replaced`, the two staff actions on the `ProjectBootstrap` record.
- Adds `job.reconciliation_required` (`system`) and `job.reconciliation_decided` (`staff`) for entering and leaving `needs_reconciliation`, which ADR-0004 as accepted adds to the job states, and narrows `job.state_force_unlocked` from any actor to `staff` only, because the accepted ADR lets no automatic path force-unlock a state file. The contract carries no list of audit actions, so no contract line changes with these rows.
- Records that `tenant.realm_deleted` belongs to the future organisation-offboarding realm job, since a tenant's `delete` no longer deletes the realm.
- Registers `staff_role.granted` and `staff_role.revoked`, the audit rows of a staff role grant and its revocation (`specs/STAFF_IDENTITY.md` §4). The contract carries no action list, so no contract row is added with them.
- `job.reconciliation_decided` carries `staff_role_grant_ref`, the staff role grant the decision relied on.
- Registers `outbox_delivery.sent`, `outbox_delivery.deferred`, `outbox_delivery.failed` and `outbox_delivery.reconciliation_required`, and the URN type `outbox_delivery`, for the mail sender (`specs/OUTBOX_MAIL_SENDER.md` §8). The contract carries no action list, so no contract row is added with them.
- Registers `outbox_delivery.reconciliation_decided` (`staff`), the operator's decision that takes a delivery out of `needs_reconciliation`, carrying the exit, the decision reference and the `staff_role_grant_ref` it relied on (`specs/JOB_QUEUE.md` §7). The contract carries no action list, so no contract row is added with it.
- Admits a `staff` actor beside `system` on `realm.created`, `realm.verification_failed`,
  `identity.bound` and `owner_claim.issued`, for the invited pilot of
  [`../specs/FIRST_OWNER_BOOTSTRAP.md`](../specs/FIRST_OWNER_BOOTSTRAP.md) §§5.5–5.6 only: with no
  identity worker, a named staff operator completes or fails the realm job, binds the intended owner
  and so issues the claim, and an actor the registry cannot name is an event that cannot be written.
  It is a pilot deviation with that document's end condition: it ends when the identity worker
  ships or before the first paying customer, whichever comes first, and the four rows then return
  to `system` only. `owner_claim.expired` and the other `realm.*` rows keep `system` only.
- Adds `owner_claim.confirmed` (`staff`, target `owner_claim`), written when the intake recorder
  records that the customer holds the owner account
  ([`../specs/FIRST_OWNER_BOOTSTRAP.md`](../specs/FIRST_OWNER_BOOTSTRAP.md) §8.7). It is part of
  that document's pilot deviation and ends with it. The contract carries no action list, so no
  contract row is added with it.
- Registers `workspace.initialised` (`tenant`, target `workspace`) and the URN type `workspace`, for `initialiseWorkspace` (`specs/PILOT_WORKSPACE_ONBOARDING.md` §6). The contract carries no action list, so no contract row is added with it.
- Adds `membership.suspended` and `membership.reactivated` (`tenant`, target `membership`), written by
  `changeMembershipRole` when its body changes `state` ([`../specs/MEMBERSHIP_LIFECYCLE.md`](../specs/MEMBERSHIP_LIFECYCLE.md) §4).
- Registers `engine_member_set.issued` (`system`), `engine_member_set.applied` and `engine_member_set.failed` (`agent`), target `member_set`, and the URN type `member_set`, for the engine member sets of ADR-0016. The contract carries no action list, so no contract row is added with them.
- `engine_member_set.issued` may carry `unnamed_leavers` and `malformed_subjects` in its `metadata`, and adds `engine_member_set.refused` (`system`, target `organisation`): the membership lifecycle now records the set; a leaver it cannot name does not block the leave, and a deny list it cannot carry refuses it.
- `subscription.cancelled` gains the `system` actor: an order whose invoice is unpaid past its due
  date is cancelled by Core (`BILLING_MODEL.md` §4.1), and `cancelOrder` writes the same row as
  `tenant`. T21 writes `tenant.deleted` in that transaction only when no lifetime bootstrap boundary
  exists; otherwise it writes the ordered-cancellation cleanup actions above and only that cleanup's
  finalizer later writes `tenant.deleted`. Cancellation never voids an issued invoice.
- Adds `order.confirmation_enqueued` (system, target `order`): the order confirmation that forms the contract was enqueued, with its delivery and the documents it names.
- Adds `order.terminated` (system, target `order`): an order cancelled after its confirmation was sent ends the contract that confirmation formed; the row names both deliveries, the confirmation's and the `order_cancellation` notice's. A confirmation not yet sent when its order is cancelled is withdrawn instead (`outbox_delivery.failed`, reason `withdrawn`).
- Registers the eight structure administration actions of contract 0.22.0 (`tenant`; targets `category` and `channel`) and those two URN types: `workspace.category_created`, `workspace.category_updated`, `workspace.category_deleted`, `workspace.channel_created`, `workspace.channel_updated`, `workspace.channel_archived`, `workspace.channel_unarchived` and `workspace.channel_access_changed`, with their metadata rules: ids, kinds, positions, changed field names and the access tag, never a name or a topic, and `self_grant: true` on an administrator's grant to themselves (`specs/ESPACE_STRUCTURE.md` §9). The contract carries no action list, so no contract row is added with them.
- `workspace.initialised` records `template_version: 2` since the starter template gained the audio room `lounge` (`specs/ESPACE_STRUCTURE.md` §8).
- Registers `engine_channel_set.issued` (`system`), `engine_channel_set.applied` and `engine_channel_set.failed` (`agent`), target `channel_set`, and the URN type `channel_set`, for the channel sets of ADR-0018 (agent-api 0.5.0).
- Adds `workspace.channel_set_refused` (`system`, target `workspace`): a membership change committed and the channel set it should have recorded was refused by its emitter (`specs/ESPACE_STRUCTURE.md` §13.5); `metadata` carries the change's `reason` and the emitter's `problem`, never a subject. The contract carries no action list, so no contract row is added with it.
- `credit_note.issued` gains the `system` actor: Core issues the credit note of an order it cancels, its owner's or its own past the due date (`BILLING_MODEL.md` §4.1), as it issues the invoice. The contract carries no action list, so no contract row is added with it.
- Adds `credit_note.notice_enqueued` (system, target `credit_note`): the notice delivering a credit note to the customer was enqueued, with its delivery (`specs/OUTBOX_MAIL_SENDER.md` §4).
- The four `outbox_delivery.*` actions also record the realm access delivery (`specs/MEMBERSHIP_LIFECYCLE.md` §6.1.3), with `operation` and `http_status` in place of the template id and the SMTP code. No action is added.
- Adds `outbox_delivery.drift_detected` (system, target `outbox_delivery`): the realm access bulk verification found a realm user Core had turned off in its realm's enabled listing, and enqueued the `access_off` the row names, which the same pass executes (`specs/MEMBERSHIP_LIFECYCLE.md` §6.1.9). `metadata` carries the operation, `reason` `realm_drift` and `enabled: true`, never a representation.
- Adds `order.complimentary` (staff, target `order`): a staff operator settled an order in flight with no charge, its invoice credited in full; `metadata` carries the `reason`, the `invoice_id` and the `credit_note_id` (`BILLING_MODEL.md` §4.2).
- `agent.enrolled` is written by a staff operator's command, so its actor is `staff`, and adds `agent.revoked` (staff, target `agent`): a staff operator revoked a tenant agent's credential (`enrol_tenant_agent`, `revoke_tenant_agent`, ADR-0016).
- Adds `tenant.failed` (`provisioning → failed`, TENANT_STATE_MACHINE.md T4). The pilot's operator override (`manage.py tenant_status`, QUICK_WORKSPACE.md §5) writes it, and the `tenant.provision_requested`, `tenant.ready`, `tenant.activated` and `tenant.deleted` rows, as `staff`, with metadata `{from, to, override: true, reason}`; the `provision` job will write it as `system`.

## Local extension writer pending central registry integration

Status: Implemented local writer; central registry/contract cutover remains Proposed.

| Action | Actor | Target kind | Retention |
|---|---|---|---|
| `extension.installed`, `extension.rotated`, `extension.revoked` | tenant | `extension` | standard |
| `extension.delivery_queued`, `extension.delivery_reconciled` | tenant | `extension` | standard |
| `extension.import_started`, `extension.object_imported` | tenant | `extension` | standard |
| `extension.digest_consent_changed` | tenant | `extension` | standard |

The local extension writer closes both action names and exact metadata keys. Metadata contains
only scoped ids, generation references, digests, closed outcomes, consent flags and evidence URNs;
it never copies event bodies, receiver URLs, signing keys or recipient contacts. Reconciliation
records an explicit owner/admin attestation, not an independently observed provider receipt.
The current worker/CLI operations add no public HTTP endpoint. The Proposed central registry and
future contract audit declarations must include these actions before that cutover is released.
