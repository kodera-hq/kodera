# ADR-0016: Pilot engines, and the member set Core sends their tenant agents

**Status:** Proposed
**Owner:** API seat
**Deciders:** zôÖma, the product owner. Lours, owner of the agent contract, for the tenant-agent and profile consequences and the ADR-0012 reading.

**Partly superseded by [ADR-0018](0018-messaging-and-audio-rooms-in-the-pilot.md)** (Proposed): live text channels and audio rooms join the pilot. The "Messaging" bullet, the options row "Matrix in the pilot", and, for channels, the "Resource access stays in the engine" paragraph and the options row "Mirror every resource ACL into Core" are replaced there. The rest of this record stands.

## Context

The pilot milestone is Visio and Docs on one dedicated instance for a design partner. Two questions were open:

- whether La Suite Docs and La Suite Meet with LiveKit can run behind the organisation's realm (ADR-0006) with permissions that Kodera controls;
- how a decision taken in Core reaches an engine.

A spike in `design specification` (`architecture/engine-spike/`) answered the first with running software: scripted scenarios, results and two independent reviews. For the second, it used stand-ins: the scenario runner held the engine keys, and a host script ran the engines' code. There was no Agent API and no Core table, and nothing crossed a real network between Keycloak and a tenant VM. This decision specifies the real path. The baseline measured was Docs v6.0.1, Meet v1.36.0 and LiveKit 1.13.10.

What the spike measured:

1. **One realm signs a user in to every engine.** The Keycloak subject is the same in each, and LiveKit's participant identity is that subject.
2. **Each engine already revokes live access in its own model.**
   - Removing a Docs access closes the open editor (yhub, close code 4401), through the Docs Celery worker. With the worker stopped, revoked users kept co-editing.
   - The same kick, queued by the engine's own code for every document a deactivated user held a direct access or a link trace on, closed both of that user's open editors.
   - Meet's moderation call disconnects a participant at once.
3. **Disabling the user in the realm is not enough.**
   - Keycloak sends each client an OIDC back-channel logout, a single best-effort call; the spike simulated one that never arrived.
   - Docs v6.0.1 keeps sessions in its cache, which the back-channel view of the shared `django-lasuite` library refuses to scan. A disabled user's Docs session and open editor keep working until the engine's own user is deactivated.
   - Meet acts on the back-channel logout only with database-backed sessions.
   - Setting the engine user's `is_active` to false made every open session answer 401 on its next request, in both engines.
4. **Removing a Meet membership leaves the member in the live call.** A removed participant can rejoin with the LiveKit grant he already holds, a bearer token valid for six hours. A guard that asks Meet's own role logic, then removes everyone it would not grant, removed such a rejoin when called directly. Through LiveKit's `participant_joined` webhook, the tenant agent's guard removed it 2.2–2.5 s after the join (the agent scenario of the spike, design specification #83).
5. **Neither engine has a service-to-service call to deactivate a user.** Code running on the tenant host can do it, through the engine's own models.

## Decision

### Engines of the pilot

- **Docs:** La Suite Docs v6: backend, Celery worker and yhub. The worker is a required service of the profile.
  - The editor image is built with `PUBLISH_AS_MIT=true` (licences, below).
- **Calls:** La Suite Meet with LiveKit, as Visio runs today.
  - Meet runs with `SESSION_ENGINE=django.contrib.sessions.backends.cached_db`.
  - Each tenant's LiveKit grant lifetime is as short as Meet allows; Meet needs a one-line upstream setting for it.
- **Back-channel logout:** every engine's OIDC client in the realm carries its back-channel logout URL.
- **Messaging:** Synapse is recorded as the engine for a later wave, and is not part of the pilot profile. *Superseded by ADR-0018: Synapse is a pilot engine.*

### Permissions: Core decides, the engine enforces, the tenant agent converges

**The intent is state, not an event.** Core sends each tenant agent the organisation's **member set**, with a revision number:

- **`active_subjects`:** the Keycloak subjects of its active members' enabled identities;
- **`inactive_subjects`:** the subjects of its members who left or are suspended, and any subject an earlier set recorded for a member that no enabled identity holds now;
- **`released_subjects`:** the subjects Core once listed as inactive that are active again.

Each subject is the one of the member's identity in this organisation's realm. Who is in which list is Core's, from `Membership`. A suspended organisation is not expressed through the set: its tenants are held by their own state (maintenance or stop).

The agent makes each engine of its VM match that set when it receives one, and re-applies the latest set every 15 minutes and after any restore or rollback it runs. A set whose revision is lower than the one the agent has applied is ignored: the agent reports success with the revision it keeps (`revision_applied`), so a late or redelivered older set changes nothing.

- **Who a leaver is.** A leaver's subject is read from their identity rows in the organisation's realm, disabled and soft-deleted rows included, since a row keeps its subject. Failing that, it comes from what an earlier set recorded for them, so a later purge of the identity does not drop them. A leaver with neither cannot be named and there is nothing to deny: the set is recorded all the same, the count is in its audit row and an error is logged, because refusing the set would roll back the leave and keep them a member of Core. Only an enabled identity's subject is ever active: an active member whose identity was disabled has that subject listed inactive.
- **Subjects outside the contract's shape.** The contract needs `\x21-\x7e`. Core's identity rule (`identity_subject_valid`) now requires the same printable ASCII, so no identity can hold any other subject, and a check constraint on the recorded subjects does too; each migration first checks that no stored row violates it. Before that, the identity rule allowed `\x01-\x7f`. The checks below remain as defence for a row older than the rule. The membership change fails closed only when a leaver of that change has such a subject: the emitter raises, the change rolls back, and, after the rollback, the organisation's head is marked refused and an `engine_member_set.refused` audit row is written for an operator; the lag alert reports it until a set is recorded again. Any other such subject, an active member's or a legacy one, is quarantined: left out of the set, counted on it, logged as critical and reported by the lag alert, without blocking later changes. Keycloak subjects are UUIDs, so none should occur.
- **An inactive subject** is deactivated, each through the engine's own models:
  - In Docs, `is_active` is set to false. The user's sessions are deleted from the session cache: the agent scans it for sessions whose user is the deactivated one. The yhub reset-connections kick is queued for every document the user reaches by direct access or link trace, and by team access too, which is untested because Docs defines no teams yet.
  - In Meet, `is_active` is set to false, and the user's sessions are deleted from the session table.
- **A released subject** whose engine user is inactive is reactivated, when a set naming it arrives. This is how a suspension is lifted. The 15-minute re-application never reactivates, so an engine administrator's own later deactivation stands. Core keeps a subject in the released list until every active agent has applied a set that names it. Until then, the daily resend of that set may reactivate it again, at most once a day.
- **Nothing else.** An engine user whose subject is in none of the lists is never touched: a local superuser, a service account, a user of another issuer, or one an engine administrator deactivated. Core's lists bound what the agent can change.
- The agent deletes the sessions only of users it newly deactivates, in one scan per application.
- **The LiveKit roster guard** removes, from every room, each participant whose subject is inactive and each participant Meet holds as a deactivated user. Before a VM's first set, only the second rule applies.
  - Room-level access stays Meet's: roles, the lobby, moderation, guests and Meet's own agents. The guard never second-guesses a participant Meet admitted.
  - A member removed from a room, not from the organisation, can therefore rejoin with the grant they hold until it expires. A short grant lifetime closes this, and it needs the upstream Meet setting below.
  - The guard runs on LiveKit's `participant_joined` webhook, on each new set, and as a sweep every 5 minutes, because webhook delivery is best effort.

**Why a set.** Applying a set twice changes nothing, so every delivery is safe to repeat:

- A failure is retried by sending the latest set again.
- A restored engine database converges at the re-application that ends the restore.
- A reinstated member is reactivated.
- An older set never undoes a newer one, because the agent keeps only the highest revision.

**How Core records and delivers it.** This is the `apps/engine_intents` application:

- **One emitter, `emit_member_set(organisation, reason)`, called in the transaction that changes a membership.**
  - The membership lifecycle (K6) calls it on suspension, removal and reactivation (`MEMBERSHIP_LIFECYCLE.md` §6); `emit_member_left(membership, reason)` is its leave form. A join records no set: the next set lists the newcomer active, and an agent that has not received the latest set gets it at its next pull.
  - It takes a per-organisation row lock, computes both lists, and stores them with the next revision. Two concurrent changes are therefore serialised: the later revision includes both.
  - **A subject stays in `inactive_subjects` until it is active again.** Each set rebuilds the full list from every subject ever read in the organisation's realm, recorded as it is read, less the active ones; so a member who left by a change that recorded no set, before the lifecycle was wired included, is still listed. The erasure of the person does not remove it: the subject is a pseudonymous realm identifier, kept while the organisation exists and deleted with it. This is a data-minimisation exception to note against ADR-0011. A pending older revision can therefore be superseded safely, because every later revision still lists the leaver.
  - **Erasure is explicit; retention never erases.** The member set lists a subject in `erased_subjects` only after `mark_erased` records the person's erasure: a GDPR article 17 request, or an account erasure under ADR-0011, whose flow calls it. The agent then runs Synapse's erase on the account (ADR-0018), once. The nightly purge of soft-deleted rows does not call `mark_erased`. A leaver's messages in workspace channels are the organisation's content and stay, while the leaver loses access.
  - A set holds at most 10,000 subjects across its lists, which bounds one command at roughly 400 KB. It never evicts a subject. Past that bound, while the organisation has an active agent credential, the change fails closed as above, logged as critical. With no agent, the set is recorded and the change goes through, since nothing would receive it. The lag alert warns from 8,000 subjects. An organisation that nears the bound needs chunked sets, decided then.
  - Every tenant of the organisation receives the whole set, which ADR-0006 already allows, since a member of the organisation may use all of its tenants.
- **Delivery is per instance.** An organisation can have several tenants, each with its own VM and agent.
  - Each agent has its own credential, scoped to one organisation and, once the tenant model exists, to one tenant. That is `EngineAgentCredential`, a temporary exception to the contract's "instance from the credential". It ends when the `Agent` entity of `docs/domain/MODEL.md` §9 lands and the credential folds into it.
  - Each set becomes one command per active credential.
  - An agent that has not yet received the latest set gets it at its next pull. That covers a new tenant and a re-enrolled VM. Every agent is sent the latest set again at least daily, which also converges a VM whose local state was lost.
- **The command loop is the Agent API's.** This decision requires its contract (`contracts/agent-api.openapi.yaml`) at version 0.4.0, which adds:
  - the kind `engine_set_member_subjects`;
  - its payload fields `revision`, `active_subjects`, `inactive_subjects` and `released_subjects`;
  - its artefacts `revision_applied`, `users_deactivated`, `users_reactivated`, `documents_kicked` and `participants_removed`;
  - no new error code: `invalid_payload`, `service_unhealthy` and `precondition_failed` are reused.

  The loop itself:
  - pulled with `GET /agent/v1/commands`, then acknowledged and reported;
  - a pending command for an older revision is superseded, and never delivered once a newer one exists;
  - a failed command with a transient error code is reissued with backoff, under a new command id;
  - a command still not applied after one hour raises an alert.
- **Core holds no engine credential in clear.**
  - The LiveKit API secret, like every tenant secret, is a `Secret` row: envelope-encrypted, plaintext only on the VM, delivered by `config_ref` (THREAT_MODEL A5).
  - Core never uses it, and an intent carries no secret and no code.

**Resource access stays in the engine.** Docs accesses and Meet room accesses are managed by members in the product. Core keeps no copy of these ACLs, and no proxy stands in front of an engine. *For channels, ADR-0018 makes Core the authority and Synapse and LiveKit its projections.*

**Relationship to ADR-0004.** ADR-0004 makes "disabling a user" an outbox delivery executed by Core's worker. That remains true for the realm: disabling the user in Keycloak is still such a delivery.

The member set is a different effect. It is executed by the tenant agent on its VM, and reported through the Agent API's acknowledgement and result. An `OutboxDelivery` is pushed, with worker attempts and staff reconciliation, so its push columns would stay empty here. The outbox and job applications are unchanged. The member set keeps their discipline:

- it is committed in the transaction of the change it follows;
- it carries a UUIDv7 id;
- every set and every terminal result writes an `AuditEvent`.

Because the effect converges, an unknown outcome is resolved by applying the set again: the "safe convergent outcome" exit of ADR-0004, not a staff decision.

The two effects do not depend on each other's order. The realm disable refuses new sign-ins; the member set closes what is already open.

**Relationship to ADR-0012.** ADR-0012 blocks remote mutating commands until the Agent contract enforces the fence and a one-shot receipt. That rule governs infrastructure mutations. The member set is a user-level effect under ADR-0004, and it converges, so this decision reads it as outside that rule. Lours, as owner of the agent contract, confirms this reading before this decision is accepted.

### Licences

- **AGPL-3.0 components:**
  - Synapse (later wave; *a pilot engine since ADR-0018*);
  - `@y/hub`, bundled in the Docs collaboration server image. That image's label says MIT; upstream's README warns otherwise.

  Kodera runs both unmodified. If either is ever patched, the patch is published to the users of the service, as AGPL section 13 requires.
- **Review before serving:**
  - **The BlockNote XL packages** (PDF, DOCX and ODT export, multi-column, AI menu): upstream's Docker Hub frontend images are built with `PUBLISH_AS_MIT=false` and contain them. Upstream lists them as GPL/AGPL. `PLATFORM_2026-08-23.md` already decided that the fleet builds its own frontend image with `PUBLISH_AS_MIT=true`.
  - **The backend's optional BlockNote AI feature** is AGPL, and off by default.

  **Recommendation:**
  - Serve only the self-built MIT frontend image, verified by a licence scan before the pilot.
  - Keep the AI feature off.
  - Do not promise the export, multi-column or AI features in product copy unless a licence review accepts them; BlockNote sells a commercial licence per tenant.
- **Other components:** the components the spike actually ran are MIT, Apache-2.0, BSD or PostgreSQL licensed. Any other component added to the profile, such as the converter, is reviewed when it is added.

## Options considered

| Option | Why not |
|---|---|
| A per-user `deactivate_user` event | An event lost, reordered, expired or undone by a restore leaves access open, and it needs a matching reactivation event. A set converges from any state. |
| Disable the user in the realm and stop | Measured insufficient: the Docs session, the open editor and a held LiveKit grant survive it. |
| An authorisation proxy in front of every engine | It would duplicate each engine's ACL logic, and it cannot see inside the editor and media websockets it would have to police. |
| Mirror every resource ACL into Core | Two sources of truth for sharing, and every engine upgrade becomes a sync migration. *Superseded for channels by ADR-0018.* |
| Core calls the engines directly | Core would use engine credentials (ADR-0003), and a tenant VM has no inbound port (Agent API). |
| Write engine databases with SQL from the agent | The spike's first version did, and it skipped the engines' side effects, such as the yhub kick; it also breaks on schema changes. The agent goes through the engines' models instead, which also reaches private upstream functions: hence the contract test below, and the preference for supported APIs where they suffice. |
| The engines' own external APIs as the whole path | They cover resource sharing, not deactivation or live-session cuts. Meet's application token is a service credential that impersonates any user by email: it needs its own risk review before it is ever enabled. Assess them, engine by engine, before carrying code against private internals. |
| Matrix in the pilot | Its client is not built; the pilot is Visio and Docs. *Superseded by ADR-0018.* |

## Consequences

- **Kodera's own code:**
  - the `engine_intents` application;
  - the agent's convergence for each engine;
  - the LiveKit roster guard.
- **Tests that must be able to fail:**
  - A contract test pins the private upstream functions the agent calls, such as Docs' reset-connections queueing, at every upstream release.
  - Preflight checks in the tenant profile, each with a mutation:
    - the Docs worker is consuming;
    - Meet runs with database-backed sessions;
    - every engine client carries its back-channel URL;
    - the LiveKit webhook reaches the guard;
    - each engine answers through its database after a database restart;
    - engines are warm before they take traffic: a cold Docs worker answered yhub after its 5-second timeout.
- **Runtime vitals:** the agent reports the worker heartbeat, the queue depth, the kick errors and the revision it applied. Core alerts on an agent whose applied revision lags.
- **The agent credential is a bearer token** until mTLS bound to the instance replaces it.
  - **A stolen token can:**
    - read the member set;
    - acknowledge a set without applying it, and report the revision as applied, which also silences the lag alert.
  - **Accepted for the pilot.** The realm disable, which does not depend on the agent, still refuses new sign-ins.
  - **Ends with:** mTLS bound to the instance.
- **Not covered:**
  - a client that opens a link-shared document without first reading it through the API leaves no link trace, so the kick misses it (a yhub per-user reset is an upstream proposal);
  - handing over documents and rooms a leaver owned alone;
  - messaging (*covered by ADR-0018*).
- **Upstream proposals** that would shrink the agent:
  - a configurable session engine in Docs;
  - a per-user yhub reset;
  - a configurable LiveKit grant lifetime in Meet;
  - a service-to-service deactivation call.
- **Revisit when:**
  - the `Agent` entity lands;
  - messaging joins the profile;
  - any upstream proposal above is released.
