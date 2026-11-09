# Espace structure: administering categories, channels and channel access

**Status:** Proposed · **Owner:** API seat · **Decision:** [ADR-0018](../adr/0018-messaging-and-audio-rooms-in-the-pilot.md)

The operations through which an organisation's owners and admins shape their Espace: create, rename, move and archive categories and channels, and decide who may see a channel and what they may do there.
- It extends the read and the starter step of [`PILOT_WORKSPACE_ONBOARDING.md`](PILOT_WORKSPACE_ONBOARDING.md), the stored schema of [`workspace-metadata-schema.md`](workspace-metadata-schema.md), and the resolution of [`workspace-member-parent-policy.md`](workspace-member-parent-policy.md).
- It ships with the next contract minor of `0.y`, a breaking one (`contract:breaking`): 0.22.0 if it lands after 0.21.0.

## 1. Scope

- **In:**
  - category create, rename, move and delete;
  - channel create, rename, retopic, move, archive and unarchive;
  - a channel's access, read and changed as a whole;
  - an administrative read of the structure;
  - each channel's room state;
  - the audio room `lounge` in the starter template (template version 2);
  - reserved platform slugs;
  - the application code `messaging`.
- **Out:**
  - messages, files and occupancy, which are the engines' (ADR-0018);
  - a category's own default access;
  - role-based grants;
  - deleting a channel: archive is the pilot's only removal;
  - the channel membership set and its delivery, which §9 only feeds.

## 2. Who may act

- `org_owner` and `org_admin` administer structure and access. `org_billing`, `org_member` and staff do not.
- `AUTHZ.md` §5's `Workspace`, `Category`, `Channel` row gains, for owner and admin: `read own, create own, update own, delete own, act own (initialise, archive)`.
- The scopes are the matrix verbs:
  - `workspace:create` (create);
  - `workspace:update` (rename, move, retopic, change access);
  - `workspace:delete` (category delete);
  - `workspace:act` (archive, unarchive);
  - `workspace:read` (the administrative read and the access read).
- **Mutations need an `active` organisation,** as AUTHZ §2 step 8 says: a `suspended` one is `402` or `403`.

### 2.1 Administrative disclosure (an amendment to AUTHZ §6 rule 8)

Rule 8 keeps every channel a caller may not view out of `getWorkspace`, with no owner bypass. That stays true for `getWorkspace`, for every content read, and for the engines. This spec adds one exception, which goes in rule 8:

> **Administrative disclosure.** `getWorkspaceAdministration` and `getChannelAccess` disclose to an organisation's `org_owner` and `org_admin` the name, topic, kind, position, lifecycle and access of every channel of the organisation, including channels they may not view. They disclose no message, file, occupancy or room content. An owner or admin who grants themselves a channel they could not view (adding themselves to `allow_members`, removing themselves from `deny_members`, or opening a restricted channel to the organisation) does so through `patchChannelAccess`. The grant is recorded in the audit log, and **announced in the channel itself**: the tenant agent posts a notice there, « {name} a rejoint ce salon en tant qu'administrateur » / « {name} joined this channel as an administrator », so its members know. Viewing the channel then follows from the new access, as for anyone.

**Why.** A B2B organisation's administrators must be able to find and fix every channel's access, or a channel nobody can administer can exist. The audit record and the visible notice keep a self-grant accountable. **Decided by zôÖma: "yes, plus visible notice"**; recorded in `AUTHZ.md` §6 rule 8.

## 3. Operations

All are under `/organisations/{organisation_id}/workspace`. They follow `CONVENTIONS.md`:
- every POST carries an `Idempotency-Key`;
- errors are RFC 9457, with the existing problem types only;
- `PUT` is not used;
- concurrency follows §10:
  - every category, channel and channel access returns a strong `ETag`;
  - a `PATCH` must carry `If-Match`: `428` without it, `412` with `current_etag` when stale;
  - `DELETE` may carry it and, when it does, it is enforced;
  - the `POST` actions do not require it.

| Operation | Method and path | Body | Result |
|---|---|---|---|
| `createCategory` | `POST /categories` | `name`, optional `position` | `201`, the category |
| `patchCategory` | `PATCH /categories/{category_id}` | any of `name`, `position` | `200`, the category |
| `deleteCategory` | `DELETE /categories/{category_id}` | — | `204`; `409 conflict` with `reason: category_not_empty` while any channel row, in any lifecycle, references it |
| `createChannel` | `POST /channels` | `category_id` (nullable), `kind` (`text`, `audio`), `name`, optional `topic`, optional `position` | `201`, the channel |
| `patchChannel` | `PATCH /channels/{channel_id}` | any of `name`, `topic`, `category_id`, `position` | `200`, the channel |
| `archiveChannel` | `POST /channels/{channel_id}/actions/archive` | — | `200`, the channel; idempotent |
| `unarchiveChannel` | `POST /channels/{channel_id}/actions/unarchive` | — | `200`, the channel; idempotent |
| `getChannelAccess` | `GET /channels/{channel_id}/access` | — | `200`, the access (§6), with its `ETag` |
| `patchChannelAccess` | `PATCH /channels/{channel_id}/access` | the whole access (§6): every field present | `200`, the access |
| `getWorkspaceAdministration` | `GET /administration` | — | `200`, every category and every channel that is not deleted, unfiltered (§2.1), with each row's `ETag` value, `lifecycle`, `room_state` and `access.mode` |

**ETags.**
- A category's ETag covers `(id, name, position, version, updated_at)`. A channel's covers `(id, category_id, kind, name, topic, position, lifecycle, version, updated_at)`.
- **The access ETag covers `(channel_id, policy_mode, policy_id, policy_revision)`.** A revision alone is not identity: going explicit → inherit → explicit creates a new policy, starting again at revision 1 (`workspace-member-parent-policy.md`).
- Every write increments the row's `version` with `F("version") + 1` in the same `UPDATE`; no trigger does it.

**Names and topics.**
- A name is 1–100 characters and not blank; a topic is 0–1,024 characters. The stored schema already guards both.
- Renaming a templated row clears its `template_key`, so a person's choice is never overridden by a catalogue label.

**Kind** never changes after creation. A `category_id` must be a category of the same workspace, or the request is `422`.

**Archive.** An archived channel keeps its category and its position. `getWorkspace` keeps returning it as `archived`. Archiving an audio room ends its live call through the agent (§9).

## 4. Positions and serialisation

- **Lists.** A position is an index within one list: the workspace's categories, each category's channels, and the uncategorised channels (`category` null, returned by `getWorkspace` as `uncategorised_channels`).
- **Dense.** Each list is dense from 0 over every row that is not `deleted`, archived rows included. An omitted `position` appends. A `position` beyond the end is `422`.
- **Moves.** Inserting or moving shifts the siblings in the same transaction. A move to another category closes the gap in the old list and opens one in the new.
- **Constraints.** A migration makes `category_position_unique` and `channel_position_unique` `DEFERRABLE INITIALLY DEFERRED`, so a shift that passes through a temporary duplicate commits only when the end state is unique. Neither constraint has a condition, so this is allowed.
- **Serialisation.** Every mutation's first statement is `UPDATE workspace SET structure_revision = structure_revision + 1 … RETURNING`, under the request's `lock_timeout`. Concurrent mutations of one workspace are therefore serialised, and none of them loses: the second waits and applies to the first's result. A lock timeout is the existing `503`.
- **Reading order.** `getWorkspace` sends order without position numbers, so a client takes the positions for a move from the administrative read.

## 5. Lifecycle and room state

- **A channel is `active` as soon as Core commits it.** `initialiseWorkspace` already creates active channels, and `getWorkspace` returns only active and archived ones. A structure that waited on an engine would hide channels from every organisation whose Espace is not provisioned yet. `provisioning`, `deletion_pending` and `deleted` stay in the stored vocabulary and are never written by these operations.
- **Whether a channel's Matrix room exists is a separate fact, `room_state`:**
  - `pending`: no tenant agent has yet reported the room as created;
  - `ready`: the room exists;
  - `failed`: the last attempt reported an error.
- It is stored on `Channel` in a new column, beside `applied_access_etag`, the access ETag the agent last applied. Both are written only by the acknowledgement of the channel membership set (the Agent API change of E3, §12). Until that exists, every channel is `pending` with no applied ETag.
- **`getWorkspace` and the administrative read return `room_state`.** The console shows a pending or failed channel as not yet usable for messages or calls.
- **`ready` says the room exists, not that its access is current.** Content readiness, the policy kernel's projection gate, needs both: the room `ready`, and the stored `applied_access_etag` equal to the channel's current access ETag (§3). An access change therefore makes content wait until the agent has applied it, while `room_state` stays `ready`. `structure.py` stops hard-coding `ready` for content decisions; the structure read itself keeps not depending on either.

## 6. Channel access

A channel's access is one document. It is read whole, and changed whole by a `PATCH` that carries every field:

| Field | Type | Meaning |
|---|---|---|
| `mode` | `inherit` or `explicit` | `inherit`: the channel follows its resolved policy (its category's default if one is set, else the workspace default), and the fields below describe that resolved policy, read-only |
| `visibility` | `organisation` or `restricted` | `organisation`: every current member; `restricted`: only `allow_members` |
| `allow_members` | membership ids | who may view a restricted channel |
| `deny_members` | membership ids | who may never view it; a deny wins over everything |
| `read_only` | boolean, text channels only | see the table below |
| `listen_only` | boolean, audio rooms only | see the table below |

**What the two flags refuse, and to whom.** Both apply to `org_member` and `org_billing`. Owners and admins are exempt (approved by the lead), so an announcement channel works: the resolver, which owns capability eligibility, leaves these denies out for those two roles. The pure kernel is unchanged.

| Flag | Capabilities denied | Matrix (agent-set power levels) | LiveKit |
|---|---|---|---|
| `read_only` | `message.post`, `message.reply`, `message.edit_own`, `file.upload` | `events_default: 20`, and owners and admins at 20, below the 50 that kick, ban, redacting others' events and invite need; members stay at 0. `events["m.reaction"]: 0` and `events["m.room.redaction"]: 0`, so members still react and delete their own messages, while redacting another's still needs 50. Native power levels, so the Synapse module needs no rule for it | — |
| `listen_only` | `media.speak`, `media.video`, `media.share` | — | the room-access service mints `canPublish: false` for members without the exemption; a change during a call goes through `UpdateParticipant` |

Reactions, deleting one's own earlier messages, and reading stay allowed in a read-only channel.

**Storage.** The access maps onto the existing schema:
- `mode` is `Channel.policy_mode`;
- `visibility` is `ResourcePolicy.visibility`;
- the member lists are `allow_member` and `deny_member` rules;
- each flag is its set of `deny_capability` rules.

Switching to `explicit` creates the channel's own `ResourcePolicy`. Switching back to `inherit` detaches it; the old policy is kept, because policies are never deleted. Each rule write increments the policy's `revision`, so a change raises it by one or more.

**Validation (`422`):**
- `mode: inherit` with any other field differing from the resolved policy;
- `visibility: organisation` with a non-empty `allow_members`;
- a membership that is not a current membership of the organisation;
- one member both allowed and denied;
- `read_only` on an audio room, or `listen_only` on a text channel.

## 7. The administrative read

- `getWorkspaceAdministration` returns the whole structure to owners and admins under §2.1: each category and each non-deleted channel, in order.
- Each row carries its `etag`, `lifecycle`, `room_state` and `access.mode`.
- It never returns content or occupancy. It is `Cache-Control: no-store`, with a strong ETag of the rendered answer, as `getWorkspace` has.

## 8. Starter template, reserved slugs and the application code

- **Template version 2.** `initialiseWorkspace` gains the audio room `lounge` in `team`: position 0, `policy_mode = inherit`, `lifecycle = active`. It is created in the same transaction as the other rows, and `workspace.initialised` records `template_version: 2`.
  - `PILOT_WORKSPACE_ONBOARDING.md` §2 is amended in this pull request: its "Audio later" paragraph becomes this rule. A workspace initialised under version 1 keeps an empty `team`, because no step re-runs a template, and an admin adds a room.
  - No organisation has a production workspace yet.
  - `apps/workspaces/initialise.py` is L3's file and is granted by the lead at the time.
- **Reserved slugs.** `RESERVED_ORGANISATION_SLUGS` and the contract's closed list on `OrganisationCreateRequest.slug` gain the platform labels of `kodera.io` that fit the 5–20 slug pattern: `notify`, `staging`, `status`, `support`, `billing`, `console`, `developers`, `matrix`, `auth-admin` and `auth-mail`.
  - The migration first checks that no organisation holds one of them, and stops with the conflicting slugs named if one does.
  - The slug is already immutable: `OrganisationPatchRequest` has `additionalProperties: false` and no `slug`, so a patch carrying it is refused. A test pins that refusal.
- **The application code `messaging` replaces `tchap`.** `AppCode` becomes `[visio, docs, drive, messaging, grist]`, and `apps/billing/catalogue` (L3) follows in the same pull request. Removing a member is breaking.

## 9. Audit, and what this feeds to the channel membership set

- **Audit actions** (`AUDIT_TAXONOMY.md` gains them; tenant scope). The metadata carries ids, kinds, positions, the changed field names and the access ETag. It never carries a name, a topic or a member's personal data.

  | Action | Target |
  |---|---|
  | `workspace.category_created`, `workspace.category_updated`, `workspace.category_deleted` | `category` |
  | `workspace.channel_created`, `workspace.channel_updated`, `workspace.channel_archived`, `workspace.channel_unarchived` | `channel` |
  | `workspace.channel_access_changed` | `channel`; metadata lists membership ids added to or removed from each list, the flags, and `self_grant: true` when the caller granted themselves a channel they could not view |

- **The channel membership set's input** (its delivery is the Agent API change of E3):
  - for each channel that is not deleted: the subjects whose current active membership passes `channel.view` on the resolved access;
  - which of them are exempt from `read_only` or `listen_only`;
  - the flags themselves;
  - the channel's access ETag (§3), which the acknowledgement stores as `applied_access_etag` (§12);
  - an archived channel, an audio room included, keeps the members its access gives it, so the agent never empties its room; its policy event says `archived: true` (§12);
  - **pending notices:** for a self-grant (§2.1), the subject who joined as an administrator. The agent posts the notice in the channel's room once, as an `m.notice` from its account with the localised text, and acknowledges it with the set, so a redelivered set does not post it twice.
- **When a set revision is recorded.** In the same transaction as any of:
  - `initialiseWorkspace`;
  - a channel created, archived or unarchived;
  - `patchChannelAccess`;
  - a channel moved to another category, when its access is inherited;
  - any membership change that already records an ADR-0016 member set.

## 10. Acceptance

**Real-database tests, each written to fail before the code exists:**
1. **Roles.** Each operation succeeds for `org_owner` and `org_admin`, is `403` for `org_billing` and `org_member`, and is `404` for a caller from another organisation.
2. **Dense positions.** Positions stay dense after creates, moves within and across categories, and to and from the uncategorised list, archived rows included. Two concurrent moves in one list both succeed, one after the other, and leave the list dense.
3. **Concurrency tokens.** `PATCH` without `If-Match` is `428`; with a stale one, `412` carrying `current_etag`, and nothing is written. Explicit → inherit → explicit changes the access ETag.
4. **Template keys.** Renaming a templated row clears its `template_key`.
5. **Category delete.** `deleteCategory` on a category that holds an archived channel is `409 conflict`, `reason: category_not_empty`.
6. **Access validation.** Each case of §6's list is `422`.
7. **Disclosure.** After the access is restricted to member A, `getWorkspace` returns the channel to A and not to member B or to a non-allowed admin. `getWorkspaceAdministration` returns it to that admin.
8. **Audit.** Every mutation writes exactly one audit event of §9's list, with no name or topic in its metadata, and increments `structure_revision`.
9. **Template.** `initialiseWorkspace` creates `lounge` as an active audio channel in `team` and records `template_version: 2`.
10. **Slugs.** Each newly reserved slug is refused at intake. A patch carrying `slug` is refused. The migration stops when a held slug collides.
11. **App code.** The catalogue accepts `messaging` and refuses `tchap`.
12. **Room state.** Every channel is `pending` until an acknowledgement exists, and `getWorkspace` returns that state.
13. **Self-grant.** An admin who adds themselves to a restricted channel they could not view gets one `workspace.channel_access_changed` event with `self_grant: true`, and the next channel membership set carries exactly one pending notice naming them. An admin granting someone else carries none. Re-applying the same set adds no second notice.

**Contract checks:** `check-authz-matrix`, the customer contract tests and the contract-change job pass, with every new operation carrying `x-kodera-scope` and `x-kodera-authz`.

## 11. Implementation notes

- **Where.** `apps/workspaces/administration.py` (the structure writes, the administrative read, the tags), `apps/workspaces/channel_access.py` (the access, the self-grant, the channel membership set's input) and `apps/workspaces/api/administration.py` (the ten views). Migrations `workspaces.0006_espace_structure` (the deferred position constraints, `room_state`, `applied_access_etag`, `ChannelNotice`) and `orgs.0013_reserved_platform_slugs`, validated by `orgs.0014`.
- **Pending notices.** A self-grant stores one `ChannelNotice` row: the channel, the membership, and `acknowledged_at`, null until the set that carries it is acknowledged (E3). `channel_notice_pending_unique` holds at most one pending row per member and channel, so a second self-grant before the first is announced adds none. `channel_set_input` returns, per channel that is not deleted, the membership ids that pass `channel.view`, those exempt from the flags (owners and admins), the flags, and the pending notices of members who still view it. It names memberships, never realm subjects: mapping them is the delivery's, and recording a set revision in the transactions §9 lists is E3's, not built here.
- **A self-grant** is a change after which the caller may view the channel and before which they could not, by the projection kernel over the stored access alone: the lifecycle is evaluated as `active`, so a self-grant on an archived channel, an audio room included, is one. That covers §2.1's three cases (adding oneself, lifting one's own deny, opening a restricted channel), and a switch back to `inherit` that opens the channel to them.
- **Archived channels keep their viewers.** `getWorkspace` evaluates a channel's access with an archived lifecycle treated as active, then reports `archived`, so an archived channel, an audio room included, stays listed for whoever its access admits; `channel_set_input` keeps its members. The room-access service ends the call through the policy event's `archived: true` (§12).
- **The flags move their whole sets, and only when they change.** A channel's new explicit policy copies every `deny_capability` rule of the policy it inherited. `read_only` and `listen_only` then add their whole capability set when the flag turns on and remove it when it turns off; an unchanged flag touches nothing. So any other deny is kept, a partial set (`message.post` alone, which is not `read_only`) survives going explicit with `read_only` false, and a flag turned on and then off restores the earlier denies outside its set. An earlier deny inside the flag's set is dropped: nothing records which denies the flag brought, so with `message.post` already denied, turning `read_only` on and then off leaves `message.post` not denied.
- **A move under category defaults (follow-up).** No category has a default policy yet, so a `patchChannel` move never changes an inherited channel's access. When category default access exists, a move that changes an inherited channel's visibility must run the self-grant check of `patchChannelAccess`.
- **Bodies.** `400 malformed-request` is a body that is not a JSON object, or a `PATCH` whose media type is not `application/merge-patch+json`. Everything the schema or a rule refuses is `422 validation-error`, every error a `pointer` and a `code` (`required`, `unexpected`, `type`, `enum`, `length`, `blank`, `out_of_range`, `not_found`, `duplicate`, `not_restricted`, `allowed_and_denied`, `not_a_member`, `not_applicable`, `inherited`), as the staff intake answers. `archiveChannel`, `unarchiveChannel` and `deleteCategory` take no body.
- **Members on a list.** Only a membership added to `allow_members` or `deny_members` must be a current membership of the organisation; one already on the list may stay, so a suspended member stays denied while the rest of the access changes.
- **Before the workspace exists**, `createCategory` and `createChannel` are `409 invalid-state-transition` with `allowed_states: [initialised]`, and every operation that names a row, the access read and the administrative read are `404`.
- **A suspended organisation** is `403` on every write, recorded as `authz.denied`; its owners and admins still read.
- **Follow-ups.**
  - Done: the request-id, problem and bearer helpers of the two workspace view modules are one module, `apps/workspaces/api/responses.py`, with byte-identical answers. The same helpers in the `orgs` and `identity` views are out of this spec's reach.
  - Left: the hand-rolled `Fields` validator; it is kept until a schema validator can give the same pointers and codes.
  - Left: no operation declares `405`, because no path of the contract does and it has no shared `405` response to reuse.
  - Left: `If-Match: *` is compared as a tag, so it answers `412`; `CONVENTIONS.md` §10 does not say what it means, and that section decides it before any operation does.
- **No operation writes `deleted`.** So `channel_position_unique`, which counts deleted rows, is safe while the lists exclude them; a deletion lifecycle must revisit it.
- **Shifts are writes.** A sibling moved by a create, a move or a delete gets `version + 1` and a new `updated_at` in the same `UPDATE`, so its tag changes with its position.
- **A change that changes nothing** (the same name, an archive of an archived channel, the same access) answers the current row and rolls back: no event, no revision.
- **Busy.** An expired lock wait is `503 service-unavailable` with `Retry-After: 1` and `retry_after_s: 1`, never stored under the key, on every write. A stored row a read relies on that is missing or out of its vocabulary is the same `503` on the two reads, never guessed. Every operation declares `429`, as `getWorkspace` does; no operation serves it yet.
- **The administrative read** takes `If-None-Match` and answers `304`, as `getWorkspace` does.
- **Database privileges.** The API writer role (`dev/api_writer_role.py`) gains `INSERT` on `workspaces_resourcepolicyrule` and `workspaces_channelnotice`; `SELECT` on `workspaces_channelnotice`; `DELETE` on `workspaces_category` and `workspaces_resourcepolicyrule`; `UPDATE (structure_revision)` on `workspaces_workspace`; `UPDATE (name, template_key, position, version, updated_at)` on `workspaces_category`; `UPDATE (category_id, name, template_key, topic, position, version, policy_mode, explicit_policy_id, lifecycle, updated_at)` on `workspaces_channel`; and `UPDATE (visibility, revision)` on `workspaces_resourcepolicy`, whose revision the rule trigger rewrites with the invoker's rights. Never a channel's `kind`, `room_state` or `applied_access_etag`, a policy's deletion, or a notice's change. `tests/test_workspace_writer_role.py` administers as that role and shows those refused.
- **Acceptance.** §10's items 1–8, 12 (the administrative read) and 13 are `tests/test_espace_structure.py`; item 10 is `tests/test_reserved_platform_slugs.py`, the intake's refusal in `tests/test_organisation_intake.py`, and the patch's refusal of `slug` against the contract in `tests/test_espace_structure_contract.py`, since `patchOrganisation` is not served yet; the contract checks are `tests/test_espace_structure_contract.py`. Items 9, 11 and 12 (`getWorkspace`) are `tests/test_espace_starter.py`.

## 12. Interface with the tenant agent and the room-access service (E3, E4)

Settled with the engines lane on this pull request. The engines lane builds E3 and E4 to it.

- **Room alias.** `#kodera-ch-{channel_id}:{server_name}`, the channel's UUID in lower-case hex with dashes.
  - It never derives from a name or a slug, so a rename or a move keeps it.
  - The agent resolves the alias first and creates the room only on a 404.
  - Core never stores a Matrix room id.
- **Delivery.** Delivering the set to the organisation's first (primary) tenant is E3's; E1 records no binding between a channel and a tenant.
- **Acknowledgement and `room_state`.**
  - The channel membership set carries each channel's access ETag (§3).
  - A `succeeded` result means every channel the set names is at the ETag it carried. Core sets them `ready` and stores `applied_access_etag`.
  - A `failed` or partial result carries a bounded `failed_channel_ids` list and one error code. Those channels become `failed`, and the rest `ready` at their ETag.
  - Results never carry room ids or names.
  - The same result acknowledges the set's pending notices (§9), which fills `ChannelNotice.acknowledged_at`, so a redelivered set never posts a notice twice.
- **`io.kodera.room.policy`.** A state event the agent writes in every channel room, with `state_key: ""` and this content:

  ```json
  {
    "version": 1,
    "kind": "text" | "audio",
    "listen_only": bool,
    "may_publish": ["@…"],
    "archived": bool
  }
  ```

  - `may_publish` lists the members exempt from `listen_only` (owners and admins, §6). It is meaningful only when `listen_only` is true, and is bounded by the set's size.
  - The room-access service mints LiveKit tokens only for `kind: audio` rooms that are not archived. A token has `canPublish: false` unless `listen_only` is false or the caller is in `may_publish`.
  - The service re-reads the event on every reconciliation pass and applies a change during a call with `UpdateParticipant`.
  - It empties an archived room's call, so §3's "archiving ends its live call" needs no LiveKit action from the agent.
- **Power levels the agent sets.**
  - `state_default: 100`, held by the agent.
  - `events["io.kodera.room.policy"]: 100`.
  - `events["io.kodera.room.occupancy"]: 10`.
  - The room-access account (`@kodera-rooms:{server_name}`) at 10, so it can write occupancy and cannot kick, ban, redact or invite (50).
  - Members at 0.
  - The posting levels of `read_only` are those of §6: `events_default: 20`, owners and admins at 20, `events["m.reaction"]: 0` and `events["m.room.redaction"]: 0`.
  - The agent joins the room-access account to every audio room through the admin API, as it joins members, so a new room's first token is not refused. If the account does not exist yet, the agent invites it, and the service joins on its next pass.
- **`io.kodera.room.occupancy`.** A state event written only by the room-access account, with `state_key: ""` and this content:

  ```json
  {
    "version": 1,
    "participants": [
      {"user_id": "@…", "devices": n, "screen_share": bool, "camera": bool}
    ],
    "at_ms": int
  }
  ```

  - It is written only when it changes. It is reset to empty when the room empties, closes or is archived.
  - It has at most one entry per member: LiveKit identities are per device (`{user_id}|{device_id}`) and are grouped by user.
  - The console reads it from its `/sync`. Core never reads it, and `getWorkspaceAdministration` returns no occupancy (§7).
- **The room-access service** is a top-level `room_access/` package in Core, run as its own process, with its own Matrix account and never the agent's (lead's decision). The Kodera Synapse policy module refuses none of the above: the agent invites, and only the agent and the room-access account write the two `io.kodera.room.*` events, which the power levels enforce.

## 13. The channel set's input and its result (E2, with agent-api 0.5.0)

Agreed with the lead: the engines lane's `apps/engine_intents` (kodera-core #232) owns the channel set's storage, revision, supersession, size bound, delivery and acknowledgement. The workspace application owns three things: what goes in, when it is emitted, and what a result does to the workspace. **The engines lane confirmed this section on #232, with the bounded shape of §13.1.**

### 13.1 What goes in

- **The call.** `channel_set_input(workspace)` returns `(all_members, channels)` for `emit_channel_set(organisation_id=…, reason=…, all_members=…, channels=…)`.
  - `all_members` is the organisation's Espace members, sent once per set: the realm subjects of current active memberships with an enabled identity.
  - `channels` has one entry per channel that is not deleted, archived ones included, in the contract's `ChannelMembership` shape.
- **The fields:**

  | Field | Value |
  |---|---|
  | `channel_id` | the channel's id |
  | `kind` | the channel's kind |
  | `name`, `topic` | the channel's stored name and topic; the agent sets them on the room |
  | `access_etag` | the access ETag of §3 |
  | `archived` | `lifecycle == archived` |
  | `audience` | `all` when the channel's resolved visibility is `organisation`; `listed` when it is `restricted` |
  | `members` | `listed` only: the realm subjects of the current active memberships that pass `channel.view` on the channel's access, judged on access alone with the lifecycle read as active (§5, §6), mapped as `emit_member_set` maps them (`identity.selectors.realm_subjects`), enabled identities only. Empty for `all` |
  | `denied` | `all` only: the subjects of `deny_members`, among `all_members`. Empty for `listed` |
  | `read_only`, `listen_only` | the flags of §6 |
  | `exempt` | the channel's effective members (all minus denied, or listed) who are `org_owner` or `org_admin`, when either flag is set; otherwise empty |
  | `notices` | each pending `ChannelNotice` whose member still passes `channel.view`: `notice_id` is the notice's id, `body` is « {name} a rejoint ce salon en tant qu'administrateur », with `{name}` the member's display name, else « Un administrateur » |

- **No subject is invented.** A membership without an enabled identity in the realm is left out, as `emit_member_set` leaves it out of `active`.
- **Computed once per emission,** inside the change's transaction, never on the agent's poll.
- **Lock order.** The two emitters, `emit_member_set` and `emit_channel_set`, take their locks in the one order `apps/engine_intents` documents. Every caller that emits both in one transaction (the membership hooks) calls them in that order.

### 13.2 When it is emitted

- **In the transaction of every change to what a room must be.** The `reason` names the change:
  - `workspace.initialised`;
  - `channel.created`, `channel.updated` (a rename, a new topic, or a move that changes inherited access), `channel.archived`, `channel.unarchived`;
  - `channel.access_changed`;
  - `membership.changed`, from `apps/orgs/member_set_hooks.py`: one line in both `member_left` and `member_set_changed`, after the member-set emission, in the same transaction. The lead granted it.
  - **A membership becoming active also emits a set**, because `all_members` changes. Today the only such path is the owner claim, which runs before the workspace exists, so `initialiseWorkspace`'s set already includes the owner. Every future path (invitation acceptance, member import, provisioning at sign-in) must call the same hook in its transaction. Until it does, a newcomer joins the organisation's rooms only at the next change.
- **A position-only move emits nothing,** because positions are not in the set.
- **A change that `emit_channel_set` refuses** (its contract bounds or a malformed subject) raises, and the whole change rolls back. The structure operations therefore refuse, before the emitter, a channel past the 500th that is not deleted: `409 conflict`, `reason: channel_limit` (added by the contract version that ships the channel-set code).

### 13.3 What a result does: `channel_set_reported`

The engines lane calls it once per terminal result, in the transaction that records the result. The workspace implementation:
- for each id in `ready`: sets `room_state = ready` and `applied_access_etag` to the reported ETag;
- for each id in `failed`: sets `room_state = failed`;
- for each id in `notices_posted`: sets `ChannelNotice.acknowledged_at`;
- ignores an id that is not a channel of the organisation, or is deleted.

**Ordering.** Each channel stores the revision of the result that last set its room state (`room_state_revision`, a new column). A result whose revision is lower than the stored one changes nothing for that channel, so a late result of an older set never undoes a newer one.

### 13.4 Settled with the engines lane (#232)

Settled on #232:
- **The bound** is `len(all_members)` plus, over all channels, `members`, `denied` and `exempt`, at most 10,000. It is refused, never truncated. Organisation-wide channels no longer repeat everyone.
- **The revision** passed to `channel_set_reported` is always the set's own, for a first, a retried or a late result. A superseded command's result never reaches the hook. A late result of an older set dispatched before a newer one does reach it, which `room_state_revision` guards against.
- **The notice body** is 1–500 characters, in French only for the pilot.


### 13.5 Implementation notes (E2)

- **Where.** `apps/workspaces/channel_sets.py`: `channel_set_input(workspace_id)`, `emit_for`, `lock_workspace` and `apply_result`, which `apps/engine_intents/channel_hooks.channel_set_reported` calls. Migration `workspaces.0007_room_state_revision` adds `Channel.room_state_revision` (0 until a result sets it). The input is taken by the workspace's id, and read in the caller's transaction.
- **Subjects.** A member's subjects are its enabled identities' (`identity.selectors.realm_subjects`), within the contract's subject shape; one outside it is left out, as the member set quarantines it, rather than refusing every set. `denied` holds the subjects of `deny_members` that are current members. `exempt` is the effective members' owners and admins, `all` less `denied` for an organisation-wide channel.
- **Notices.** At most 20 per channel, the contract's bound, oldest first; the others wait for a later set. A display name that is blank reads « Un administrateur ».
- **Lock order.** Organisation and membership rows, then the workspace row, then the engines' heads, then the credentials and commands; never a membership or organisation row `FOR UPDATE` after the workspace. Path by path:
  - a structural write: the workspace row (`UPDATE … structure_revision`, first statement) → its categories, channels, policies, rules and notices → the heads → the input → the set. Inserting a rule or a notice takes the foreign key's `FOR KEY SHARE` on its membership row, which a membership change (an `UPDATE` of non-key columns) never waits on;
  - `initialiseWorkspace`: the organisation's advisory lock → the new workspace row and the starter rows → the heads → the input → the set;
  - a membership change (state or role): the membership, person and organisation rows its triggers lock → the workspace row (`SELECT … FOR UPDATE`, `lock_workspace`) → the channel set's input, read there → the member set (the heads) on a state change → the channel set; with no workspace, the member set only;
  - a channel set's result: its command row → the workspace row → the channels and notices it sets → the heads, on a retry;
  - `channel_set_input`: reads only.
- **The input is read after the change it follows has every lock it needs.** A structural write and `initialiseWorkspace` take the heads before reading the input (`emit_for`), so a concurrent membership change that holds the heads has committed and is read; this is what keeps a suspension that `initialiseWorkspace` races out of the starter set. A membership hook reads the input under the workspace lock, before its member set takes the heads, and hands it to the channel emission (`prepare`, `emit_prepared`).
- `tests/test_espace_channel_set.py` runs each pair at once, with barriers forcing the interleaving: an access change against a suspension (`member_left`) and against a reactivation (`member_set_changed`), seen waiting on the workspace row in `pg_stat_activity`; a result against a create that shifts its siblings; `initialiseWorkspace` against a suspension. Each of these mutations fails its test: the hook taking the heads first (PostgreSQL aborts one of the two), the hook skipping the workspace lock, the result skipping it, and the input read before the heads.
- **What emits.** `channel.updated` on a rename, a new topic, or a move after which the channel's access tag differs; a position-only move, a move that keeps the access, a category's create, change or delete, and a change that changes nothing emit nothing.
- **Results.** A `failed` channel keeps its `applied_access_etag`: the room is not at a newer access. A posted notice is acknowledged whatever the result's revision. An id that is not a UUID, not a channel of the organisation's workspace, or deleted is ignored. The workspace row is locked first.
- **A role change** records a channel set alone, `reason: membership.role_changed`, since `exempt` names owners and admins (`member_set_hooks.channel_set_changed`, granted by the lead).
- **A refused set.** On a structural write the emitter's refusal rolls the change back and answers `409 conflict`, `reason: channel_set_too_large`. On a membership change (leave, return, role) it never blocks: the channel emission runs in a savepoint, the refusal is logged critical and audited as `workspace.channel_set_refused`, and the member set and the membership change commit. `initialiseWorkspace` (L3's file) still answers `500` on a refusal, which only an organisation of more than 10,000 member subjects could meet.
- **The limit.** The 501st non-deleted channel is `409 conflict`, `reason: channel_limit`, counted under the workspace lock before anything is written (contract 0.23.0).
- **Privileges.** The API writer role gains `UPDATE (room_state, applied_access_etag, room_state_revision)` on `workspaces_channel` and `UPDATE (acknowledged_at)` on `workspaces_channelnotice`, which the Agent API's result path writes; the hook's `SELECT … FOR UPDATE` is covered by the existing `UPDATE (structure_revision)` grant.
- **Cost.** Measured on a 500-channel workspace with 200 members, one channel in five restricted to ten members on a policy of its own: 10 queries and 0.52 s on a loaded laptop (load average 37), against 1,506 queries and 25.4 s before. Every channel's access is read in four queries (`channel_access.resolve_all`); viewers are worked out once per policy revision and kind; an organisation-wide policy is all members less the denied without asking the kernel member by member, and a restricted one asks the kernel for its allowed members only. `tests/test_espace_channel_set.py` holds the input to at most 20 queries at that size.
