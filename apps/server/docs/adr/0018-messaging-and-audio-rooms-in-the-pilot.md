# ADR-0018: Messaging and audio rooms in the pilot

**Status:** Accepted
**Owner:** API seat
**Deciders:** zôÖma, the product owner, who decided on 2026-10-22 that live text channels and always-open audio rooms join the pilot, accepting that the pilot moves later, and approved the design and its rulings the same day. Lours, owner of the agent contract and of the tenant profiles, for the agent, profile and edge consequences and the ADR-0012 reading.

**Partly supersedes [ADR-0016](0016-engines-and-permission-intents.md).** This record replaces the following parts of ADR-0016:
- its "Messaging" bullet: Synapse is a later wave;
- its options row "Matrix in the pilot";
- for channels only, its "Resource access stays in the engine" paragraph and its options row "Mirror every resource ACL into Core".

ADR-0016 stays Proposed and in force for Docs, Meet and the organisation's member set.

## Context

ADR-0016 set the pilot to Visio and Docs on one dedicated instance, and left messaging to a later wave because no chat client was built. The owner's position is that one place where a team both writes and talks is what makes Kodera specific. That place is categories holding text channels and always-open audio rooms side by side, showing who is in each room. So the pilot now includes them: in the « Espace » surface of the console, alongside Visio and Docs.

Core already models the structure:
- `apps/workspaces` holds Workspace → Category → Channel, where a channel's kind is `text` or `audio`, and per-channel access in `ResourcePolicy` and `ResourcePolicyRule`;
- a pure policy-projection kernel (`docs/specs/workspace-policy-projection.md`) evaluates the closed capability vocabulary and carries the desired and projected policy revisions.

Nothing yet connects that structure to an engine. The engine spike (`design specification` `architecture/engine-spike/`) ran Synapse v1.163.0 behind the organisation's realm and measured channels, threads, direct messages, an outsider refused, live removal and persistence. It built no client.

The design is `run-notes/messaging-pilot-2026-10-22/DESIGN.md` in the lead's workspace, which is not versioned; this record carries what a pull request is checked against. It was reviewed by an independent builder check and by the lead, and approved by the owner on 2026-10-22.

## Decision

### Scope
In the pilot, Espace has:
- categories that mix text channels and audio rooms;
- a timeline with send, edit, delete, reply, reactions and threads;
- file and image upload, @mentions, in-tab and browser notifications, server-side search, and direct messages;
- audio rooms joined in one click, with optional camera and screen share;
- a call docked across Kodera's surfaces.

Out of the pilot:
- end-to-end encryption, and federation (Tchap included);
- native and mobile apps and push;
- bots and bridges, recording and transcription;
- custom emoji, polls, voice messages and a rich-text composer;
- pins and presence dots on people;
- showing who is speaking to people outside the call.

### One chain of authority: Core policy → Matrix room membership → LiveKit access

- **Core owns the tree and the rules.** Admins change categories, channels and their policies only through Core's API. **Core is the authority for channel access.** Synapse and LiveKit hold projections of it.
- **Every channel, text or audio, is one Matrix room** on the tenant's Synapse. The tenant agent creates each room and converges its membership to the members the channel's policy allows.
  - This is delivered as a revisioned **channel membership set**: the same discipline as ADR-0016's member set, a state and not events.
  - It goes through the Agent API, whose new command kind arrives in its next version.
  - A lower revision is ignored, and the latest set is re-applied every 15 minutes, as ADR-0016's member set is.
- **An audio room's media access derives from membership of its Matrix room.** A room-access service on the tenant VM checks that the caller is a joined member of that room, then mints a short-lived LiveKit token for that room only.
  - The LiveKit key stays on the VM, as ADR-0016 requires. Core never holds it in clear, and never mints media tokens.
- **Removal** is a new set revision. The agent:
  - removes the member from the Matrix room;
  - removes them from the live call;
  - extends ADR-0016's LiveKit roster guard to remove, after they join, anyone in an audio room who is not a member of that room's Matrix room. LiveKit's `participant_joined` is a notification, not a gate, and its webhooks are best effort, so the same check also runs on every reconciliation pass of the room-access service (every few seconds), not only on the 5-minute sweep.

  A token's lifetime alone does not close a rejoin, because LiveKit refreshes a connected client's token.
- **Audio rooms and Meet share the tenant's LiveKit** with separate keys. Audio rooms use their own room-name prefix, and the guard removes from an audio room any participant who is not a member of its Matrix room, a Meet participant included.
- **Fine-grained capabilities.** The server enforces membership, a read-only channel (no posting, by the power levels the agent sets: owners and admins keep the posting level, members keep reactions) and a listen-only room (the room-access service mints a token with `canPublish: false`; when an admin changes the setting during a call, the agent updates the participant's permission with LiveKit's `UpdateParticipant`, or removes the participant). The other capabilities of the kernel's vocabulary are honoured by Kodera's client and not enforced against a third-party client in the pilot.

### The agent's command wait holds no database connection
The pilot's removal target is 5 s from the admin's action, and the agent learns of new commands within it. The agent checks for a new revision every 2 to 3 seconds, or waits asynchronously. **A command wait never holds a database connection, and never blocks a synchronous web worker,** while it is idle. This binds the Agent API's existing `wait_s` parameter (1–55 s, accepted and not honoured today): Core honours it only with a wait that holds no connection, and otherwise answers at once.

### Presence
- The room-access service receives LiveKit's webhooks on the VM and reconciles them every few seconds with LiveKit's participant list, because webhook delivery is best effort.
- It writes presence as a state event in the audio room's Matrix room: who is present, and who shares a screen. It writes only when presence changes.
- Clients read it over the sync they already hold.
- Who is speaking is shown only inside the call.

### A Kodera Synapse policy module
Synapse's client API is reachable by any Matrix client a member signs in with. A small Kodera module, loaded into Synapse, therefore refuses, through Synapse's `user_may_create_room`, `user_may_invite`, `user_may_send_3pid_invite`, `user_may_create_room_alias`, `user_may_publish_room` and `check_event_for_spam` callbacks:
- room creation and invites from any account but the agent's administrative account, with one exception: creating a direct message between two members of the organisation, with its one invite;
- invites by e-mail or phone, and room aliases, from anyone but the agent;
- publishing any room to the room directory;
- `m.room.encryption` in any room;
- from anyone but the agent: a join rule other than `invite`, a world-readable history (which would also defeat `forget_rooms_on_leave`), aliases, third-party invites, server ACLs, room upgrades and space links. With invites and the join rule locked, a direct message's power levels cannot open it to anyone else.

Posting in a read-only channel is not the module's: it is the room's power levels.

Channel rooms are created by the agent with power levels that leave every state change to its administrative account.

The module is AGPL-3.0, like Synapse. It is developed in its own repository, outside every proprietary repository, and published when the owner authorises it. Synapse itself runs unmodified.

### Homeserver settings the pilot fixes
- **Federation off:** `federation_domain_whitelist: []` and no federation listener. Opening to other servers, Tchap included, is a later decision.
- **Registration closed.** Accounts exist only through the organisation's realm: OIDC, back-channel logout, and a localpart derived from the stable subject, never from the mutable `preferred_username`.
- **No end-to-end encryption.** Rooms are created unencrypted (`encryption_enabled_by_default_for_room_type: off`), and the module refuses enabling it. Server-side search, compliance export and history for new members keep working. Product copy and contracts never promise end-to-end encryption.
- **Authenticated media only.** `enable_authenticated_media: true`. Downloads are served only through `/_matrix/client/v1/media/*`, and the tenant's edge blocks the unauthenticated read paths `/_matrix/media/(r0|v1|v3)/(download|thumbnail|preview_url|config)`. Upload (`/_matrix/media/v3/upload`, `/_matrix/media/v1/create`) stays where the Matrix specification keeps it, behind the access token. Authenticated media checks sign-in, not room membership: a member of the instance who obtained a file's address can fetch it. That is a known limit of the pilot.
- **History after removal.** `forget_rooms_on_leave: true`, so a removed member can no longer page back through the channel. What their device already displayed is beyond Kodera's reach.
- **Bounded tokens.** The console asks for a refresh token at login. `refreshable_access_token_lifetime`, `refresh_token_lifetime` and `nonrefreshable_access_token_lifetime` are all set to bounded values, so no access or refresh token a reloading browser leaves behind lives indefinitely, and a client that does not ask for refresh tokens gets an expiring token too.
- **Encryption at rest of Synapse's database and media store is not promised** until the profile builds and verifies it.

### The Matrix `server_name` and the organisation slug
- Each tenant's `server_name` is `{organisation-slug}.kodera.io`, delegated by `.well-known` to wherever the homeserver runs. It is never a customer's custom domain. It depends on the tenant host names still owed by Lours and the owner (ADR-0015, Proposed, moves identity and mail to `kodera.io`); no tenant's Synapse is provisioned before that decision.
- A `server_name` is permanent: every user and room identifier embeds it. So **an organisation's slug becomes immutable once its Espace is provisioned.** Core refuses the change, and a test proves the refusal.
- Organisation slugs cannot take a label the platform uses under `kodera.io` (those that fit the 5–20 slug pattern, such as `notify`, `staging`, `auth-admin` or `auth-mail`; shorter ones such as `api` or `auth` cannot be slugs). The reserved list grows with the contract change that introduces Espace.

### The browser connects to two tenant services
- The console's client is built in Kodera's own code, on matrix-js-sdk and livekit-client (both Apache-2.0). No Element, Cinny or other copyleft client code enters the console.
- The browser talks to the tenant's Synapse client-server API with the member's own Matrix token, and to the tenant's LiveKit with a room token. No administrative credential ever reaches it.
- These two connections are exceptions to the console's rule that Core is its only backend (console ADR-0003). The console records them in its own amendment.

### Meet
Meet keeps scheduled meetings, guests and its calendar add-ins. It is not bent into permanent rooms: its API lists no participants, and its rooms are not persistent.

### Licences
Synapse (AGPL-3.0) joins the pilot, unmodified. The Kodera module is AGPL-3.0 in its own repository. If Synapse is ever patched, the patch is published to the users of the service, as AGPL section 13 requires.

## Options considered

| Option | Why not |
|---|---|
| Messaging in a later wave (ADR-0016) | The owner ruled that unified text and audio is the product's specificity, and belongs in the pilot. |
| Embed or fork Element Web | Element's room list and panels fight a unified sidebar, and occupancy would live in state the console cannot read. A fork carries AGPL obligations into the console. |
| Fork Cinny or another Discord-like client | The same licence problem. Cinny is also replacing its SDK and accepts no outside changes. |
| Audio rooms as Meet rooms | Meet's API lists no participants, its rooms are not persistent, and its room access is Meet's own, not the channel's. |
| MatrixRTC and Element Call | The base specification (MSC4143) is not merged, its token service shipped breaking changes, and Element's own video rooms are still a labs feature. Revisit once merged. |
| Core mints LiveKit tokens and receives LiveKit webhooks | Core would hold a tenant's media secret, which ADR-0003 and ADR-0016 keep on the VM, and policy would reach voice by a second path. |
| Membership alone, without a Synapse module | Any Matrix client could create rooms or invite people outside Kodera's policy, because Synapse's client API is open to it. |
| End-to-end encryption on channels | Server-side search, compliance export and history for new members would be lost. Bots would need their own cryptography. The client would cost several more person-weeks. |
| A 25-second long poll held by a web worker | It would hold a database connection and a synchronous worker per agent while idle. |
| Keep ADR-0016's rejection of "mirror every resource ACL into Core" | That objection was two sources of truth. For channels there is one: Core is the authority, and Synapse and LiveKit hold projections the agent converges, never edited by members. Docs and Meet ACLs stay in their engines. |
| Copying channel models into a second Core application | `apps/workspaces` already holds them. Channels extend it. |

## Consequences

- **Kodera's own code:**
  - Core: the channel and category operations and policy edits on `apps/workspaces`, the channel membership set and its emitter, and the slug freeze.
  - The tenant agent's Synapse engine and the extended roster guard.
  - The room-access service.
  - The Synapse module.
  - The console's Espace client.
- **Contracts:**
  - The Core API's next version adds the channel, category and policy operations and the slug rule, and replaces the application code `tchap` with `messaging`.
  - The Agent API's next version adds the channel membership set, and the command check becomes a 2–3 s poll or an asynchronous wait that holds no database connection.
- **The profile:**
  - A Synapse profile with its preflight checks, each with a mutation: federation off, registration closed, an https issuer, the back-channel URL present, and the unauthenticated media paths refused at the edge.
  - Backup of the database, the media store and the signing key.
  - The room-access service.
  - A confidential `synapse` client in the organisation realm template.
- **Tests that must be able to fail:**
  - a third-party Matrix client cannot create a room or invite anyone;
  - a removed member loses the timeline, the call and the rejoin within 5 s of the admin's action;
  - presence is right after a lost webhook;
  - everything survives an engine restart.
- **The console's end-to-end tests** for Espace need a real Synapse and LiveKit; the console records that exception to its mock-only rule in its own amendment.
- **The pilot moves later,** as the owner accepted. Visio, Docs and the tenant lifecycle continue in parallel.
- **Plans.** Espace is sold only on dedicated-instance plans. The shared entry plan (ADR-0014: shared hosts and a shared media host) has no Espace until its own design exists, because a LiveKit key is not limited to one tenant's rooms and each tenant needs its own Synapse. Prices are the catalogue's, not this record's; the owner kept them unchanged for now.
- **Residency.** Synapse's database, media store and backups are customer data under ADR-0017 (EU). Federation off means no transfer to another server.
- **Leaving and erasure.** A member who leaves the organisation or is suspended is an inactive subject of ADR-0016's member set, and the agent deactivates their Synapse account as it does in Docs and Meet; the realm disable stays the outbox delivery of ADR-0004. When a person is erased, the agent deactivates the account with Synapse's erase flag, so their messages are no longer served to anyone who joins a room later. Whether that meets the erasure obligations is checked by the legal seat before this record is accepted.
- **Relationship to ADR-0012.** Room creation and membership convergence are user-level effects that converge, read as outside ADR-0012's rule in the same way as ADR-0016's member set. Lours confirms this reading before this decision is accepted.
- **Revisit when:**
  - MatrixRTC is merged and its token service is stable;
  - a customer needs end-to-end encryption or federation;
  - native apps need Matrix Authentication Service;
  - Synapse needs workers at the measured load;
  - the pack margin rule (list ≥ 3× infrastructure, ≥ 44 % gross margin) is re-checked once Synapse's sizing is measured;
  - the shared entry plan gets an Espace design.
