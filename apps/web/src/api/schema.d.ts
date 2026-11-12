// GENERATED FILE — DO NOT EDIT. Regenerate with: npm run api:generate
export interface paths {
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller, their identities and their organisations
         * @description Returns the authenticated person, the Keycloak identities that resolve to them, and every
         *     organisation they are a member of with the role held in each. A person may hold identities
         *     in several organisations' realms; the console uses this to render an
         *     organisation switcher after login.
         *
         *     The local customer-read increment resolves an enabled stored identity by exact issuer and
         *     subject, then requires its current active membership in an active or suspended organisation.
         *     Stored roles and contact fields determine the response; token role or email claims do not.
         *     Verified staff authentication returns 403 until the separate staff implementation exists.
         *     The wider role matrix and PATCH remain Proposed; this increment does not implement them.
         *
         *     Every response is Cache-Control: no-store. A strong ETag hashes the complete serialized
         *     projection only, excluding hidden update timestamps (CONVENTIONS.md section 10).
         *     Current authorization and the coherent projection are resolved before If-None-Match,
         *     including weak tags, lists and wildcard matching; revoked access never returns 304.
         */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Change your own language or display name
         * @description The console's language switch. Locale is held here rather than in the browser so a person
         *     who signs in from a second machine, and every notification mail they receive, follow the
         *     same choice.
         */
        patch: operations["patchMe"];
        trace?: never;
    };
    "/auth/discover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resolve an organisation slug or email domain to a current eligible realm
         * @description Anonymous non-mutating lookup. Ignore Authorization entirely: it neither authenticates nor selects results on this operation. Require Idempotency-Key, validate the dedicated compatibility syntax, then discard it. Identical, changed-body and concurrent same-key requests independently charge quotas and select current data. Store no key, key digest, body fingerprint, response or in-flight state; use no key lock, replay header or idempotency 409. Generic POST replay remains unchanged for every other operation.
         *
         *     Enforce the 4096-byte limit on received body bytes before JSON parsing (413 payload-too-large). Require application/json (415 unsupported-media-type). Malformed JSON and duplicate object keys are 400 malformed-request. Missing compatibility key is 400 idempotency-key-missing; invalid key is 400 malformed-request. Exactly one known string slug or email is required; shape/format errors are 422 validation-error. Use canonical ASCII slugs of 5–20 characters without URL parsing or case repair. Email uses the bounded ASCII schema; lowercase only its exact domain and discard the local part before lookup, quota-key creation or logging.
         *
         *     Read one coherent current database snapshot of nondeleted active/suspended organisations with worker-confirmed ready customer realms. Exclude prospects, staff realms, closed, deleted and unready organisations. Email selection requires current verified organisation/domain associations, never member email, tenant web domains or suffix matching; while no verified association exists, every email lookup returns the zero result. Perform no provider/DNS call, identity/account mutation or owner bootstrap. Unknown/ineligible input returns the exact five-field zero result. A single match uses top-level metadata and empty candidates; multiple matches use 2–20 candidates and null top-level metadata. Candidates are distinct by organisation and ordered by slug then id. Realm equals organisation slug and realm; issuer is exactly the configured identity provider's realm issuer {identity provider}/realms/{slug}, the organisation issuer derived from the deployment's staff issuer (the examples show https://id.kodera.io), with its derived /.well-known/openid-configuration URL. Cross-field agreement and current-authority conditions require runtime assertions beyond JSON Schema. Positive metadata intentionally reveals organisation existence; the neutral negative shape does not prevent enumeration.
         *
         *     Refuse from headers alone, before any quota charge or body read: a media type other than application/json (415), a missing or invalid compatibility key (400), and a browser request whose Origin is not an exact allowed Console origin or whose Sec-Fetch-Site is cross-site (403 forbidden). A request carrying neither Origin nor Sec-Fetch-Site, a native client's, is never refused for its origin. No cross-site page can spend another client's quota.
         *
         *     Shared database-backed rolling 60-second quotas are 30/IP, 60/slug per IP, 300/email-domain per IP and 600/global. A value bucket is per client, so no stranger can exhaust a tenant's lookups. Charge global/IP before parsing and valid-value buckets before lookup. Trust only the direct connection peer, or, when that peer is a configured trusted edge, the rightmost untrusted X-Forwarded-For hop (docs/specs/TRUSTED_EDGE.md); with no trusted edge configured, ignore forwarded-IP headers. Normalize IPv4-mapped addresses and count one IPv6 /64 as one client. Quota exhaustion is 429 with the actual controlling-stage delay rounded up, minimum one second, equal in Retry-After and retry_after_s. Enforcement/configuration/database failure is route-local 503 with five-second minimum backoff, not a recovery promise. Missing/invalid dedicated 32-byte HMAC configuration fails before quota state or lookup without raw/unkeyed fallback. Use two-second database budgets for limiter and selection; uncertain quota commit cannot yield successful uncharged lookup. Rate events expire after 60 seconds and healthy cleanup removes them within 120 seconds after expiry. The 10000 retained-event cap fails closed without evicting live counts.
         *
         *     Every response carries X-Request-Id and Cache-Control: no-store. Problems echo current request correlation without input or internal details. RateLimit-Limit/Remaining/Reset describe the tightest evaluated bucket only; omit them when prerequisites fail before evaluation, never fabricate counters. Return no Idempotency-Replayed header.
         */
        post: operations["discoverRealm"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List organisations
         * @description Staff view over every organisation. A customer token sees only its own and should call `/me`.
         */
        get: operations["listOrganisations"];
        put?: never;
        /**
         * Record a staff intake and create the organisation it is for
         * @description Staff-assisted intake, the server's `record_intake` management command
         *     `plans/complete-mock/FIRST_SLICE_SPEC.md` §P1. In one Postgres transaction the API
         *     validates and reserves the organisation slug, creates the organisation in `prospect`,
         *     records the intake — the recorded customer instruction reference and the intended owner
         *     contact, against the staff actor — enqueues the `realm_create` job that is the identity
         *     bootstrap operation (`docs/domain/JOB_CATALOGUE.md` §2, organisation-scoped), and writes
         *     the `organisation.intake_recorded` audit event. The API process touches no identity
         *     provider here (core ADR-0003); the worker creates the realm and binds the intended
         *     identity, and `getOrganisationBootstrap` reports its progress.
         *
         *     **It creates no membership for anyone.** The caller does not become `org_owner`, and no
         *     staff principal ever holds a customer membership. First ownership is established only by
         *     `consumeOwnerClaim`: the intended verified person proves their identity in the
         *     organisation's realm and presents the claim the worker issued for that organisation and
         *     that identity, which creates the first `org_owner` membership and moves the organisation
         *     to `active` in one transaction. `org_owner` is not granted here because a principal holds
         *     that role only inside an existing organisation: the grant could never be exercised
         *     (`docs/api/AUTHZ.md` §4).
         *
         *     `instruction_ref` is a reference — a ticket or signed-request identifier — never the
         *     instruction's content. The intended owner contact is sealed — encrypted at application
         *     level under a key of Core's — on the intake record, and only its masked form is ever
         *     returned; there is no `Contact` row for it. The optional profile members (`legal_name`,
         *     `country`, `vat_number`, `siren`, `billing_email`, `billing_address`, `email_domains`,
         *     `locale`) are validated as declared and sealed with it, as received: `Organisation` does
         *     not store them yet, so the `201` body's `organisation` does not carry them. Staff
         *     assistance never substitutes for the customer's own acceptance of terms or processing
         *     instructions. A body naming a membership, a role, a DPA or an order is refused
         *     `422 validation-error` by `additionalProperties: false`; the guarded operations for those
         *     stay with the customer.
         *
         *     The slug is reserved by the database's unique constraints, never by a read before the
         *     write: a slug an organisation already holds is `409 slug-taken`, and of two concurrent
         *     intakes for one slug exactly one succeeds. A reserved name — one of the closed list on
         *     `OrganisationCreateRequest.slug`, among them `kodera-staff`, the staff realm, and `master`,
         *     the identity provider's administration realm — is `422 validation-error` with the code
         *     `reserved`.
         *
         *     The caller is a staff principal with a second factor in `amr` (`403 mfa-required`
         *     otherwise) and a current `staff_operator` grant; both refusals are audited
         *     `authz.denied`. A database that does not admit the intake yet — before its identity and
         *     mail cutover is declared final (`docs/specs/FIRST_OWNER_BOOTSTRAP.md` §3.8) — answers
         *     `503 intake-closed`. That refusal, like the authentication and authorisation ones, comes
         *     before the key is read and is not stored, so the same key is valid once the intake opens.
         *
         *     `Idempotency-Key` is the intention key of the intake: a resumed or repeated submission of
         *     the same intake returns the same organisation and the same bootstrap, never a second slug
         *     reservation or a second job (`docs/api/CONVENTIONS.md` §8). A committed `201`, its
         *     successful replays and an `idempotency-key-in-flight` response carry the same opaque
         *     `X-Operation-Ref`: correlation only, never proof that a durable row exists, a resource URL
         *     or an authorization capability. No lookup by that value exists.
         */
        post: operations["createOrganisation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * Get an organisation
         * @description The legal and commercial entity behind a tenant. A customer token resolves only its own organisations; a staff token resolves any.
         */
        get: operations["getOrganisation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update an organisation
         * @description Merge patch over the mutable fields. `slug` is not one of them: it is the name of the
         *     organisation's Keycloak realm (ADR-0006), fixed when the intake reserves it.
         */
        patch: operations["patchOrganisation"];
        trace?: never;
    };
    "/organisations/{organisation_id}/bootstrap": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * Where an organisation's bootstrap stands
         * @description The `read_bootstrap_status` command of `FIRST_SLICE_SPEC.md` §P1: a derived view over the
         *     organisation, its intake, the `realm_create` job, the intended identity's binding and the
         *     owner claim, so that staff and the intended owner can see where the bootstrap stands
         *     without either of them holding an ordinary organisation role. It carries no secret: not
         *     the claim token, not its verifier, not a delivery payload.
         *
         *     Two kinds of caller. Staff read any organisation's bootstrap. The `bootstrap` principal —
         *     a person authenticated in this organisation's realm whose identity the worker bound as
         *     the intended owner, holding no `Membership` (`docs/api/AUTHZ.md` §4) — reads only the
         *     organisation its token's `iss` resolves to; any other `organisation_id` is `404`, never
         *     `403`, so that a claim cannot be used to probe organisations.
         *
         *     The view stays readable after the claim is consumed, so the person who has just become
         *     `org_owner` can still confirm what happened; at that point their ordinary role no longer
         *     needs this operation and the console should route them to `/me`.
         *
         *     Optional caller_assurance describes a proposed customer-only signed-fact transport.
         *     The current server always omits it, including for staff; examples are synthetic
         *     structure only. Its presence alone never proves current identity, registered factor,
         *     clock qualification or protected-use readiness. A failed /me read never falls back
         *     to this operation for assurance. Existing principals and status semantics are unchanged.
         */
        get: operations["getOrganisationBootstrap"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * The organisation's workspace structure, as the caller may see it
         * @description The categories and channels of the organisation's one workspace, and where the
         *     organisation's setup stands (`docs/specs/PILOT_WORKSPACE_ONBOARDING.md`). Structure only:
         *     no message, file, occupancy or any other content is ever part of this answer.
         *
         *     **Filtered server-side by channel policy.** A channel is returned only when the caller's
         *     current membership may view it under its resolved resource policy (explicit channel
         *     policy, else its category's default, else the workspace default), and a category only when
         *     the caller may view a channel created in it under that same resolution or may view one of
         *     its channels. A channel the caller may not view is absent, never redacted; nothing in the
         *     answer says that it exists. Only `active` and `archived` channels are returned.
         *
         *     Before the starter workspace exists the answer is still `200`: `state` is
         *     `not_initialised`, the structure members are null or empty, and `setup` says why. A
         *     customer token reads only an organisation it holds a current membership in; any other
         *     `organisation_id` is `404`.
         *
         *     **One ETag per view.** The strong `ETag` hashes the complete answer as rendered for this
         *     caller (the canonical serialisation of `CONVENTIONS.md` §10's `GET /me` exception), not
         *     the stored workspace: a change to rows the caller cannot see changes nothing the caller
         *     receives, its tag included. The answer carries no structure revision for the same reason.
         *     `If-None-Match` is evaluated only after current authorisation and filtering, so a revoked
         *     view never returns `304`. Every response is `Cache-Control: no-store`.
         */
        get: operations["getWorkspace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/workspaces/instant-claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Claim a worker-prepared workspace allocation
         * @description Customer org_owner only, resolved from the current identity and active membership.
         *     The allocation must already belong to that organisation in the database and match the
         *     validated provisioning plan, with every channel active and its room ready. Core performs
         *     no provider call and creates no capacity or invitation token. A missing, mismatching or
         *     unready allocation (including self-host requests) returns 503 warm_pool_unavailable.
         *     Authentication and current owner authority are checked before idempotency and on replay.
         *     The claim timestamp and 201 response are stored atomically. A different key after a claim
         *     returns 409; a failed 503 stores nothing and may be retried with the same key.
         */
        post: operations["instantClaimWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/actions/initialise": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create the organisation's starter workspace, once
         * @description Creates the starter template of `docs/specs/PILOT_WORKSPACE_ONBOARDING.md` §2 — the
         *     categories `general` and `team`, the text channels `welcome` and `general`, and, since
         *     template version 2, the audio room `lounge` in `team` — and nothing else. It is the separate, idempotent step that follows the owner claim (the pilot
         *     amendment of `docs/specs/FIRST_OWNER_BOOTSTRAP.md`, §8.6): it never undoes, delays or
         *     repeats the claim. The request has no body; the template is fixed by this contract version.
         *
         *     Checked in this order, after authentication and authorisation:
         *
         *     1. The organisation is `active`; otherwise `409 invalid-state-transition` with
         *        `allowed_states: [active]`.
         *     2. Its setup (`Workspace.setup.state`) is `ready`, which needs the owner's contact
         *        confirmed and the organisation's issuer trusted; otherwise
         *        `409 invalid-state-transition` with `allowed_states: [ready]`.
         *     3. The workspace already exists: `200`, and nothing is written.
         *     4. The organisation has an order that is not cancelled and whose DPA is accepted
         *        (`placeOrder`), or the CGV and the DPA accepted with no order, as a deployment that does
         *        not bill records them, for one tenant of its own that is not `deleted`: no workspace
         *        before the customer's CGV and DPA are accepted; otherwise
         *        `409 invalid-state-transition` with `allowed_states: [ordered]`.
         *     5. Otherwise the workspace, its default policy, the two categories and the three channels
         *        are created in one transaction with one audit event, `workspace.initialised` with
         *        `template_version: 2`: `201`.
         *
         *     **No workspace in the answer.** Both `201` and `200` carry `Location` and the body
         *     `{"state": "initialised"}` only; the console then reads `getWorkspace`, which renders the
         *     structure for the caller's current authority. A replayed answer can therefore never carry
         *     a category or channel name, stale or visible to someone else.
         *
         *     **Idempotent twice over.** Under one `Idempotency-Key` the first answer is replayed
         *     (`docs/api/CONVENTIONS.md` §8). Under another key, or from another caller, step 3 answers
         *     `200`: two owners initialising at once create one workspace, never a duplicate category
         *     or channel, and neither sees a `5xx`.
         *
         *     Synchronous: it writes Core's own records and mutates no infrastructure, so it answers
         *     `201` or `200`, never `202` and a job (`CONVENTIONS.md` §7).
         */
        post: operations["initialiseWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/categories": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a category in the organisation's workspace
         * @description Adds a category at `position` in the workspace's list of categories, or at its end when
         *     `position` is omitted; the categories after it move down one (`docs/specs/ESPACE_STRUCTURE.md`
         *     §4). A `position` beyond the end is `422`. The workspace must exist: before
         *     `initialiseWorkspace` the answer is `409 invalid-state-transition` with
         *     `allowed_states: [initialised]`.
         *
         *     Every structural write of one workspace is serialised behind its revision: a concurrent
         *     one waits and then applies to this one's result. A wait longer than the request's lock
         *     timeout is `503 service-unavailable`; retry the same request with the same key.
         *     Audited as `workspace.category_created`, with no name.
         */
        post: operations["createCategory"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/categories/{category_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                category_id: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete an empty category
         * @description Deletes the category and closes the gap it leaves in the list. A category is empty only
         *     when no channel row references it, whatever its lifecycle: one holding an archived channel
         *     is `409 conflict` with `reason: category_not_empty`, and its channels must first move.
         *     `If-Match` is optional and enforced when present. Audited as `workspace.category_deleted`.
         */
        delete: operations["deleteCategory"];
        options?: never;
        head?: never;
        /**
         * Rename or move a category
         * @description Merge patch over `name` and `position`. Renaming a category the starter template created
         *     clears its `template_key`, so the console shows the name a person chose rather than its
         *     catalogue label. A move shifts the categories between the old and the new position; a
         *     `position` beyond the end is `422`. Audited as `workspace.category_updated`, naming the
         *     changed fields and never the name.
         */
        patch: operations["patchCategory"];
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/channels": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a text channel or an audio room
         * @description Adds a channel of `kind` `text` or `audio` to a category of this workspace, or to the
         *     uncategorised list when `category_id` is null, at `position` or at the end. It is `active`
         *     as soon as this answer is sent, under its category's access (`policy_mode` `inherit`); its
         *     Matrix room follows, and `room_state` says when it exists (`docs/specs/ESPACE_STRUCTURE.md`
         *     §5). `kind` never changes afterwards. A `category_id` of another workspace is `422`. A
         *     workspace holds at most 500 channels that are not deleted, archived ones included: the
         *     501st is `409 conflict` with `reason: channel_limit`, refused before anything is written.
         *     Audited as `workspace.channel_created`, with no name or topic.
         */
        post: operations["createChannel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/channels/{channel_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Rename, retopic or move a channel
         * @description Merge patch over `name`, `topic`, `category_id` and `position`. A `category_id` moves the
         *     channel to that category's list, or to the uncategorised list when null, closing the gap
         *     in the old list and opening one in the new; without `position` it goes to the end.
         *     Renaming a templated channel clears its `template_key`. `kind` is not patchable. Audited
         *     as `workspace.channel_updated`, naming the changed fields and never the name or topic.
         */
        patch: operations["patchChannel"];
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/channels/{channel_id}/actions/archive": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Archive a channel
         * @description Sets the channel's lifecycle to `archived`; it keeps its category and position, and
         *     `getWorkspace` keeps returning it as `archived`. Archiving an audio room ends its live
         *     call through the tenant agent. Archive is the pilot's only removal: no operation deletes a
         *     channel. Idempotent: archiving an archived channel answers `200` and writes nothing. The
         *     request has no body. Audited as `workspace.channel_archived`.
         */
        post: operations["archiveChannel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/channels/{channel_id}/actions/unarchive": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Unarchive a channel
         * @description Sets an archived channel's lifecycle back to `active`, in place. Idempotent: unarchiving
         *     an active channel answers `200` and writes nothing. The request has no body. Audited as
         *     `workspace.channel_unarchived`.
         */
        post: operations["unarchiveChannel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/channels/{channel_id}/access": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        /**
         * Who may view a channel, and what they may do there
         * @description The channel's access as one document (`docs/specs/ESPACE_STRUCTURE.md` §6). With `mode`
         *     `inherit` the other members describe the policy the channel resolves to, its category's
         *     default or the workspace's, read-only. Disclosed to the organisation's owners and admins
         *     for every channel, restricted ones included, under the administrative disclosure of
         *     `docs/api/AUTHZ.md` §6 rule 8: never a message, a file or an occupancy.
         */
        get: operations["getChannelAccess"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Change a channel's access, as a whole
         * @description Carries every member of `ChannelAccess` but `channel_id`; a body missing one is `422`.
         *     `explicit` gives the channel a policy of its own, created when the channel was inheriting;
         *     `inherit` detaches it, and the detached policy is kept, never deleted. `422` refuses
         *     `inherit` with any member differing from the resolved policy, `organisation` visibility
         *     with a non-empty `allow_members`, a membership that is not a current membership of the
         *     organisation, one member both allowed and denied, `read_only` on an audio room and
         *     `listen_only` on a text channel.
         *
         *     Audited as `workspace.channel_access_changed`, with the membership ids added to and
         *     removed from each list, the flags and the new tag. An owner or admin who grants
         *     themselves a channel they could not view is recorded with `self_grant: true`, and the
         *     tenant agent announces them in the channel (`docs/api/AUTHZ.md` §6 rule 8).
         */
        patch: operations["patchChannelAccess"];
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/administration": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * The whole structure, for the organisation's administrators
         * @description Every category and every channel that is not deleted, in their stored order, with each
         *     row's position, `etag`, `lifecycle`, `room_state` and `access.mode`, unfiltered by channel
         *     policy: the administrative disclosure of `docs/api/AUTHZ.md` §6 rule 8
         *     (`docs/specs/ESPACE_STRUCTURE.md` §7). This is where a client takes the positions and tags
         *     for a move; `getWorkspace` sends order only. Structure only: never a message, a file, an
         *     occupancy or any room content. Before `initialiseWorkspace` the answer is `404`.
         *
         *     **One ETag per rendered answer**, as `getWorkspace` has: `If-None-Match` is evaluated
         *     after current authorisation, and every response is `Cache-Control: no-store`.
         */
        get: operations["getWorkspaceAdministration"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/notice-contacts": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * Read where the DPA's notices go
         * @description The three addresses the data processing agreement sends notices to: security incidents
         *     (DPA 8.2), privacy and data-protection matters (11.6) and sub-processor changes (Annex D).
         *     An unset address is `null`, and the notice then goes to the organisation's current owners,
         *     which `*_defaults_to_owners` says.
         */
        get: operations["getNoticeContacts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set where the DPA's notices go
         * @description Merge patch over the three addresses; `null` clears one, so its notices go to the owners
         *     again. Only an owner sets them: they are the contract's notice addresses. Audited as
         *     `organisation.updated` with the changed addresses only.
         */
        patch: operations["patchNoticeContacts"];
        trace?: never;
    };
    "/organisations/{organisation_id}/memberships": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List the people in an organisation
         * @description Read current stored membership relationships, not provider account status. Returns non-deleted `invited`, `active` and `suspended` memberships whose person is not deleted; `removed` and soft-deleted relationships are excluded. The `state` filter applies only within this population, so `state=removed` returns an empty page. Disabled people remain represented by their current stored relationship without implying usable access. Unavailable optional `account_kind`, `mfa_enrolled` and `last_seen_at` facts are omitted; omission does not mean hosted sign-in, no enrolled factor or never signed in. This API read does not promise provider synchronization or a complete People screen. Directory privacy applies row by row, exactly as the `Membership` schema states it. The five private member facts `email`, `identity_id`, `account_kind`, `mfa_enrolled` and `last_seen_at` are disclosed only on the caller's own row, or on every row when the caller holds `org_owner` or `org_admin` in this organisation; on every other row they are withheld (omitted or `null`). A page read by an `org_member` therefore carries that member's own row in full and every colleague's row without these five facts. No filter of this operation reads a withheld fact.
         */
        get: operations["listMemberships"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/memberships/{membership_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                membership_id: components["parameters"]["MembershipId"];
            };
            cookie?: never;
        };
        /**
         * Get one person's membership
         * @description One row of the People screen, opened as a drawer. It carries the two decisions the console
         *     would otherwise have to make for itself: `can_change_role` and `can_remove`, false on the
         *     last `org_owner` and on the caller's own row, so the control is disabled with a reason
         *     rather than failing on submit.
         *
         *     The two flags are advice for rendering, not authorisation. The API enforces the same rules
         *     again and answers `last-owner-protected` whatever the console rendered.
         *
         *     Directory privacy applies exactly as on `listMemberships` and as the `Membership` schema
         *     states it: `email`, `identity_id`, `account_kind`, `mfa_enrolled` and `last_seen_at` are
         *     disclosed when the caller reads their own membership or holds `org_owner` or `org_admin` in
         *     this organisation, and are withheld (omitted or `null`) from every other caller. The answer
         *     is still `200`: a colleague's row is readable, its private member facts are not.
         */
        get: operations["getMembership"];
        put?: never;
        post?: never;
        /**
         * Remove someone from the organisation
         * @description Marks the membership `removed`. Core's record is authoritative: the person loses every
         *     grant on their next request. Disabling the account in the organisation's realm and revoking
         *     its sessions is a separate delivery of the realm worker, not part of this answer. The
         *     person's content is not deleted; export and deletion are separate jobs owned by the
         *     organisation owner. Only an owner may remove an owner or billing membership; no one removes
         *     their own membership; the last `org_owner` cannot be removed; staff may not remove an
         *     active customer membership (ADR-0010). `If-Match` is optional and enforced when present.
         *     Removing a membership that is already `removed` answers the same row again.
         */
        delete: operations["removeMembership"];
        options?: never;
        head?: never;
        /**
         * Change someone's role
         * @description Delegated administration: the console never calls Keycloak (console ADR-0003). The body
         *     changes the role, the state (`suspended` to suspend, `active` to reactivate), or both. Core's
         *     record is authoritative: the change applies to the person's next request. Applying it in the
         *     organisation's realm is a separate delivery of the realm worker, not part of this answer.
         *     The caller cannot change their own membership.
         *
         *     The last `org_owner` of an organisation cannot be demoted or suspended; the API answers
         *     `last-owner-protected`. Only an owner may change an active membership to or
         *     from `org_owner` or `org_billing`; an admin may move only between
         *     `org_admin` and `org_member` (ADR-0010).
         */
        patch: operations["changeMembershipRole"];
        trace?: never;
    };
    "/organisations/{organisation_id}/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List invitations
         * @description Invitations sent and not yet accepted, with the ones that expired or were revoked. The token itself is never listed.
         */
        get: operations["listInvitations"];
        put?: never;
        /**
         * Invite people by email
         * @description One call carries between 1 and 500 invitations. The same batch service also backs member-
         *     import execution. The call is atomic in Postgres and partial in outcome: every row is
         *     answered with its own result so the console can show
         *     "117 sent, 3 already members".
         *
         *     Seats are checked against the subscription's capacity tier before any invitation is
         *     written; over capacity the call fails with `quota-exceeded` and the console shows the
         *     upgrade prompt.
         *
         *     `org_owner` is never an invitation value. An owner may invite an admin, billing contact or
         *     member; an admin may invite an admin or member.
         *
         *     No staff role holds this operation. Staff prepare nothing that reaches a customer
         *     organisation; staff assistance is the intake protocol behind `POST /organisations`, and
         *     the people of an organisation are invited by its owner or admins
         *     (`docs/api/AUTHZ.md` §4).
         */
        post: operations["inviteToOrganisation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invitations/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Read an invitation before accepting it
         * @description What the invitation card shows before the person accepts: the organisation's display
         *     name, the inviter's display name, the role acceptance will grant and the expiry. The
         *     caller posts the same token `acceptInvitation` takes and meets the same checks in the same
         *     order (`docs/specs/INVITATIONS.md` §3): a token that does not resolve, a staff token, an
         *     account other than the one the realm worker recorded for the invitation, or an address
         *     the realm has not verified is `404 not-found`, which never says whether the invitation
         *     exists; a caller already a member, or an organisation that is not active, is
         *     `409 conflict`; a revoked or expired invitation is the typed `410`. So a forwarded link
         *     shows no card, exactly as it accepts nothing. As on acceptance, the member check and the
         *     `410`s come before the account check, so another account of the realm holding the link
         *     learns that the token is genuine and either that it is itself a member (`409`) or that
         *     the invitation is revoked or expired (`410`), never the card.
         *
         *     **A read, sent as a `POST` only so that the token stays out of URLs and logs.** It takes no
         *     `Idempotency-Key` and ignores one sent anyway; it stores no response, writes no audit row
         *     and neither consumes nor extends the token, which a later `acceptInvitation` redeems as
         *     if no preview had been read. The answer names no identifier and no address, the
         *     inviter's included.
         *
         *     The principal is `invited`, as on `acceptInvitation` (`docs/api/AUTHZ.md` §4), and the
         *     four organisation roles are named for the same reason: a member reaches the handler and is
         *     answered `409 conflict` rather than `403 forbidden`. Like acceptance, it is not answered
         *     `identity-unknown`. `429` is declared, as on acceptance, and not served yet.
         */
        post: operations["previewInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invitations/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept an invitation
         * @description Redeems the opaque token from the invitation email. The caller must already hold a token
         *     in the target organisation's realm, which is what the invitation link walks them through:
         *     the email points at the console, the console starts the OIDC flow against the realm named
         *     in the invitation, then posts the token here.
         *
         *     The invitation token is single use, expires, and is compared in constant time. A token
         *     that does not resolve answers `404 not-found` and never says whether it existed.
         *
         *     **The caller holds no role in this organisation, which is the whole point.** The principal
         *     is `invited`: authenticated in the invitation's realm, carrying no `Membership` yet
         *     (`docs/api/AUTHZ.md` §4). Declaring the four organisation roles here, as the first version
         *     did, made the operation unreachable for the only case it exists for. The four are still
         *     named so that a second click on the same link reaches the handler and answers
         *     `409 conflict` — "you are already a member" — rather than `403 forbidden`.
         */
        post: operations["acceptInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/owner-claims/actions/consume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Claim first ownership of a prospect organisation
         * @description The `claim_first_owner` command of `FIRST_SLICE_SPEC.md` §P1. The intended owner, having
         *     authenticated against the organisation's own realm with the second factor the realm
         *     requires, presents the claim token the worker issued for that organisation and that
         *     identity. Under the organisation lock the API verifies, in this order, that the token
         *     resolves and matches its stored verifier in constant time, that the claim is bound to the
         *     caller's `(iss, sub)`, that the caller's contact is verified and the token's `amr` shows a
         *     second factor, that the claim is neither expired nor revoked nor consumed, that the
         *     organisation is `prospect`, and that it holds no `org_owner`. Then, in one transaction,
         *     it creates the first `org_owner` membership, consumes the claim, moves the organisation
         *     to `active`, and writes `owner_claim.consumed`, `membership.created` and
         *     `organisation.activated`. All of it commits or none of it does.
         *
         *     **The token never authenticates.** The bearer JWT does; the claim token is authorisation
         *     evidence bound to one organisation and one identity, and a spent token cannot
         *     authenticate a retry. What may be replayed is the logical operation, under
         *     `docs/api/CONVENTIONS.md` §8: the same `Idempotency-Key` and the same body from the same
         *     identity is authenticated and authorised against current state (§P3), then answered with
         *     the stored response, replayed verbatim — a refusal as much as a `200`. A new attempt uses
         *     a new key: a person refused `403 mfa-required` or `403 owner-claim-contact-unverified` who
         *     re-authenticates with a second factor, or verifies the contact, sends a new key, because
         *     the old one replays the refusal. That is why `org_owner` is named beside `bootstrap`: a
         *     retry by the person who has just become owner reaches the handler and gets the replayed
         *     `200` under the consuming request's key or `409 owner-claim-consumed` under a new one —
         *     never a `403` that reads as "you are not allowed to own this".
         *
         *     Refusals, each a member of `ProblemType`: a token that does not resolve, or resolves to a
         *     claim of an organisation the caller's realm does not name, is `404 not-found` and never
         *     says whether it existed; a claim of this organisation bound to another identity is
         *     `403 owner-claim-identity-mismatch`, the one case where `403` is chosen over `404`
         *     because the caller is already an authenticated subject of that realm and the denial is
         *     evidence worth recording; a missing second factor is `403 mfa-required`; an unverified
         *     contact is `403 owner-claim-contact-unverified`; an expired or revoked claim is `410`;
         *     a consumed claim is `409 owner-claim-consumed`; an organisation no longer in `prospect` is
         *     `409 invalid-state-transition` with `allowed_states: [prospect]`. Every refusal above is
         *     audited under `authz.denied` (`docs/api/AUTHZ.md` §9). Before any of them, and before the
         *     replay store, a verified token whose `(iss, sub)` names no enabled customer identity of an
         *     enabled person is `403 identity-unknown`, with nothing stored and no audit row, since it
         *     names no principal. No refusal creates a membership.
         *
         *     The claim's lifetime is not a constant of this contract: `FIRST_SLICE_SPEC.md` §P1
         *     proposes 72 hours and records the lifetime and the delivery mechanism as security
         *     decisions still to be taken. The wire carries `expires_at` on the bootstrap view and
         *     fixes no number.
         */
        post: operations["consumeOwnerClaim"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/enrolment-tokens": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List enrolment tokens
         * @description The `secret` is never returned again after creation; only its fingerprint is listed.
         */
        get: operations["listEnrolmentTokens"];
        put?: never;
        /**
         * Create a one-time on-site enrolment token
         * @description On-site enrolment: an admin projects a QR code, people scan it and create their account in
         *     the organisation's realm without an email round trip. The token is short lived, bounded by
         *     `max_uses`, and grants `org_member` only. A shared token never grants an administrative,
         *     billing or owner role (ADR-0010).
         *
         *     `secret` and `qr_svg` are returned exactly once, in this response. They are not stored in
         *     clear: the API keeps an HMAC fingerprint.
         */
        post: operations["createEnrolmentToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/enrolment-tokens/{enrolment_token_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                enrolment_token_id: components["parameters"]["EnrolmentTokenId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke an enrolment token
         * @description Idempotent. Revoking an already revoked or exhausted token answers `204`.
         */
        delete: operations["revokeEnrolmentToken"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List published plans
         * @description A plan is the commercial envelope, versioned. A price is always read through a plan
         *     version so that an order can snapshot exactly what was shown on screen.
         */
        get: operations["listPlans"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog/packs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List packs
         * @description A pack names the set of applications provisioned on a tenant, for example Visio alone or Visio plus Docs.
         */
        get: operations["listPacks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog/capacity-tiers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List capacity tiers
         * @description A capacity tier fixes the VM shape and the included capacity: seats, concurrent
         *     participants and storage. It is the `tier` rendered into the tenant profile
         *     (`x-kodera.tiers`) by the provisioning job.
         */
        get: operations["listCapacityTiers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog/prices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List prices
         * @description Prices are immutable once published; a change is a new price with a new `valid_from`.
         *     An order snapshots the price row it used, so an invoice can always be reconstructed.
         */
        get: operations["listPrices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/orders": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List the orders of an organisation
         * @description Every order the organisation has placed, most recent first. An order is immutable once placed; a change of pack or tier is a new order.
         */
        get: operations["listOrders"];
        put?: never;
        /**
         * Place an order
         * @description The single transaction that opens the tenant lifecycle (strategy 3.2, step 1). In one
         *     Postgres transaction the API writes the order with its price snapshot, the DPA acceptance,
         *     the subscription, the draft tenant in status `ordered`, the issued invoice, and the audit
         *     events. Core issues the invoice and allocates its number from its own gapless series; the
         *     payment provider only collects.
         *
         *     The payment link is not created by the order: `createPaymentLink` creates it, so it is
         *     `null` here with `billing_pending: true`, which the console renders as "payment link on
         *     its way".
         *
         *     Acceptance of the DPA is mandatory and is part of this request: no processing starts
         *     before it. The DPA must have been generated for this
         *     organisation first, for the pack ordered, from the DPA template still in force, and not
         *     yet accepted, and `dpa_acceptance.dpa_id` must name it.
         *
         *     **Owner-only.** The order carries the customer's DPA acceptance, and staff never accept
         *     on the customer's behalf (`FIRST_SLICE_SPEC.md` §P1 step 6): no staff role holds this
         *     operation, and staff assistance ends at the intake.
         *
         *     **One order in flight per organisation.** While the organisation has an order `placed` or
         *     `awaiting_payment`, another is refused with `409 order-in-progress`, whatever its key, its
         *     DPA or its slug: two tabs or two owners ordering at once buy once. The database holds the
         *     rule, so of two concurrent placements under two keys one is `201` and the other
         *     `409 order-in-progress`. A `paid`, `fulfilled` or `cancelled` order holds nothing: the
         *     organisation's next tenant is ordered once the first order is paid, or after it is
         *     cancelled (`cancelOrder`).
         *
         *     Provisioning is **not** started here. At launch an operator triggers the `provision` job
         *     (strategy R1); from the moment collection is automatic the paid webhook triggers it.
         *
         *     **Billing off.** On a deployment that does not bill (`billing_enabled: false` in the
         *     status summary), an owner's order is refused with `409 billing-disabled` and nothing is
         *     written. An answer already stored under the key is replayed first; the refusal itself is
         *     not stored. Members and staff are refused first.
         */
        post: operations["placeOrder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{order_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                order_id: components["parameters"]["OrderId"];
            };
            cookie?: never;
        };
        /**
         * Get an order
         * @description One order with its price snapshot and the identifiers of the subscription, invoice and tenant it created.
         */
        get: operations["getOrder"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{order_id}/actions/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                order_id: components["parameters"]["OrderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel an order not yet paid
         * @description The owner withdraws an order placed and not yet paid, so that another can be placed
         *     (`placeOrder`, one order in flight per organisation). The request has no body. In one
         *     transaction the order becomes `cancelled`, its pending subscription `cancelled`, its
         *     invoice is corrected, its active payment link cancelled (and withdrawn at the payment
         *     provider afterwards, not by this request). The tenant then follows the future lifecycle
         *     branch below; it is not always deleted by this transaction.
         *     The future corrected writer first proves no tenant workload or data store was provisioned,
         *     locks the tenant and sets its permanent ordered-cancellation fence before inspecting any
         *     bootstrap row; bootstrap record/verify and provisioning take the same lock and refuse this
         *     fence or a cancelled order. It seals canonical empty backup/export manifests and atomically
         *     issues the tenant-only
         *     `never_provisioned` attestation bound to this cancelled order only when no lifetime
         *     ProjectBootstrap row ever existed. If any recorded, verified, expired or replaced bootstrap
         *     exists, cancellation retires the current row, creates one durable cleanup obligation whose
         *     immutable scope covers every historical provider project/application/policy/key boundary
         *     and leaves the tenant `ordered`; it issues no attestation and does not enter `deleted`. Only after the
         *     operator retires every scoped key/application/policy, closes every empty project and an
         *     independent authenticated verifier seals exact absence evidence for the complete scope does
         *     the unbounded cleanup finalizer issue the attestation and enter `deleted`. The current runtime
         *     does not yet implement either attestation branch. The tenant's slug stays taken
         *     (`slug-taken`). The accepted CGV
         *     and DPA stay on record; a new order needs a new DPA (`generateDpa`).
         *
         *     **An issued invoice is never voided.** A credit note, numbered from a series of its own,
         *     credits it in full, and the invoice becomes `credited` (`getInvoice`). A draft invoice,
         *     which has no number, is discarded.
         *
         *     Checked in this order, after authentication and authorisation:
         *
         *     1. The order is already `cancelled`: `200` with the order, and nothing is written.
         *     2. The order is `placed` or `awaiting_payment`; otherwise (`paid`, `provisioning`,
         *        `fulfilled`) `409 invalid-state-transition` with
         *        `allowed_states: [placed, awaiting_payment]`.
         *     3. No payment for its invoice is received, and no debit is submitted and still settling:
         *        only a partial credit with a refund would correct it, which Core does not issue yet;
         *        otherwise `409 invoice-issued`. Support settles it.
         *
         *     **Owner-only**, like `placeOrder`: the order carries the customer's agreements, and no
         *     staff role holds this operation. A `suspended` organisation may cancel too (`AUTHZ.md`
         *     §2 step 8): it only stops what it would owe.
         *
         *     Synchronous: it writes Core's own records and mutates no infrastructure (`CONVENTIONS.md`
         *     §7). Under one `Idempotency-Key` the first answer is replayed (`CONVENTIONS.md` §8).
         */
        post: operations["cancelOrder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List the subscriptions of an organisation
         * @description The subscriptions of an organisation. At launch there is one per tenant.
         */
        get: operations["listSubscriptions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/subscriptions/{subscription_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                subscription_id: components["parameters"]["SubscriptionId"];
            };
            cookie?: never;
        };
        /**
         * Get a subscription
         * @description One subscription with the price snapshot taken at order time. Nothing here is recomputed from the catalog.
         */
        get: operations["getSubscription"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/invoices": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List invoices
         * @description The Invoices screen. Most recently issued first, with the amount still due on each.
         */
        get: operations["listInvoices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invoices/{invoice_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoice_id: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        /**
         * Get an invoice
         * @description One invoice with its lines, its VAT regime and its state.
         */
        get: operations["getInvoice"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/credit-notes": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List credit notes
         * @description The organisation's credit notes, most recently issued first. A credit note is the only
         *     correction of an issued invoice (`BILLING_MODEL.md` §4): it credits its invoice in full
         *     when an order is cancelled (`cancelOrder`), and the invoice names it (`credit_note_id`).
         */
        get: operations["listCreditNotes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/credit-notes/{credit_note_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                credit_note_id: components["parameters"]["CreditNoteId"];
            };
            cookie?: never;
        };
        /**
         * Get a credit note
         * @description One credit note with its lines: its own number, its date, the invoice it credits and that
         *     invoice's VAT treatment. Its permanent URL, the one the credit-note notice names.
         */
        get: operations["getCreditNote"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invoices/{invoice_id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoice_id: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        /**
         * Get a short-lived download link for the invoice PDF
         * @description The API does not proxy the PDF: it returns a pre-signed Object Storage URL valid for a few
         *     minutes, bound to the requesting subject in the audit event. The console opens it in a new
         *     tab. The link is single organisation, single invoice, and expires.
         */
        get: operations["getInvoiceDownloadLink"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invoices/{invoice_id}/payment-link": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoice_id: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        /**
         * Get the current payment link of an invoice
         * @description Returns the active link, or `404` when none exists or the last one expired.
         */
        get: operations["getPaymentLink"];
        put?: never;
        /**
         * Create or refresh the payment link of an invoice
         * @description At launch payment is a link per invoice at the payment provider, which is still to be
         *     chosen; there is no stored payment method and no recurring collection (strategy decision
         *     D5). Creating a link for an invoice that already
         *     has an active one returns that link unchanged, so the button is safe to press twice.
         *
         *     On a deployment that does not bill (`billing_enabled: false` in the status summary), the
         *     request is refused with `409 billing-disabled`, after the caller and the invoice are
         *     checked: no provider is called and nothing is stored against the key. An answer already
         *     stored under the key is replayed first.
         */
        post: operations["createPaymentLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/dpa": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Generate the data processing agreement for an organisation
         * @description Renders the DPA and its annexes A to D, including the sub-processor list in force, for
         *     this organisation and the pack it is about to order. The result is a document with a
         *     version, a SHA-256 and a PDF in Object Storage. Generating again while an unaccepted
         *     document exists returns that document; generating after a sub-processor change creates a
         *     new version and marks the previous one `superseded`.
         */
        post: operations["generateDpa"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/dpa/{dpa_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                dpa_id: components["parameters"]["DpaId"];
            };
            cookie?: never;
        };
        /**
         * Get a DPA
         * @description One data processing agreement with its sub-processor list, its digest and, once accepted, who accepted it and when.
         */
        get: operations["getDpa"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/dpa/{dpa_id}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                dpa_id: components["parameters"]["DpaId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept a DPA
         * @description Records the acceptance with the accepting person, the document SHA-256, the client IP and
         *     the user agent, and writes the audit event that backs the accountability clause. Only
         *     `org_owner` may accept: it is a contractual signature. Acceptance is irreversible; a new
         *     version requires a new acceptance.
         */
        post: operations["acceptDpa"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/dpa/{dpa_id}/pdf": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                dpa_id: components["parameters"]["DpaId"];
            };
            cookie?: never;
        };
        /**
         * Get a short-lived download link for the DPA PDF
         * @description Returns a short-lived pre-signed link rather than the bytes, with the document digest so the customer can verify what they downloaded.
         */
        get: operations["getDpaPdfLink"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/tenants": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List the tenants of an organisation
         * @description The tenants of an organisation. At launch an organisation has one; the shape allows more without a contract change.
         */
        get: operations["listTenants"];
        put?: never;
        /**
         * Create the organisation's workspace, on a deployment that does not bill
         * @description The owner's one step to a workspace when this deployment does not bill
         *     (`billing_enabled: false` in the status summary; `docs/specs/QUICK_WORKSPACE.md` §4). In
         *     one transaction it creates the tenant, in status `ordered`, on the offer the status
         *     summary names (`workspace_pack_code`, capacity tier `S`), the organisation's DPA for that
         *     pack, the acceptance of the CGV and of the DPA for that tenant, with the server's clock,
         *     the truncated client IP and the user agent, and the starter workspace of
         *     `initialiseWorkspace`. It writes no order, subscription, invoice or payment link, and starts no job: an operator
         *     provisions the tenant.
         *
         *     The acceptance is the request itself: `legal_acceptances` names the CGV and the DPA at the
         *     versions the screen showed (`listLegalDocuments` for the pack), each of which must be the
         *     version in force for its locale and the pack. A DPA the organisation generated earlier
         *     and has not accepted is reused when it comes from the template in force, and superseded
         *     otherwise.
         *
         *     Checked in this order:
         *
         *     1. The caller: an owner of the organisation. Another member's role is `403`, recorded,
         *        and so is a staff token; anyone else is `404`.
         *     2. An answer already stored under the key is replayed. Otherwise this deployment must
         *        not bill: `409 billing-enabled`, which is not stored.
         *     3. The body: `400` when it is not a JSON object, `422 validation-error` for its shape.
         *     4. Under the organisation lock, the caller and the switch again, as in steps 1 and 2: a
         *        role lost since, or billing turned on, is refused the same way, and the refusal is not
         *        stored. Then the organisation is
         *        `active`, otherwise `409 invalid-state-transition` with `allowed_states: [active]`;
         *        and its setup (`Workspace.setup.state`) is `ready`, otherwise
         *        `409 invalid-state-transition` with `allowed_states: [ready]`.
         *     5. The organisation holds no tenant that is not `deleted`; otherwise `409 tenant-exists`.
         *        Two creations at once are decided one after the other: one is `201`, the other
         *        `409 tenant-exists`, whatever their slugs.
         *     6. The workspace offer is configured: the pack on sale, its tier, and a CGV and a DPA in
         *        force for the locales sent; otherwise `503 service-unavailable`, nothing written and
         *        nothing stored.
         *     7. The slug is a DNS label of 3 to 32 characters and not reserved (the closed list on
         *        `SlugAvailability.reason`); otherwise
         *        `422 validation-error` at `/slug`. A slug any tenant holds or held is
         *        `409 slug-taken`, with up to three free `suggestions`.
         *     8. The DPA, then the CGV, is the version in force; otherwise `422 validation-error`, the
         *        entry's `code` naming it (`dpa_not_in_force`, `cgv_not_in_force`) and its `detail` the
         *        version in force.
         *
         *     A workspace the organisation already has, left by an earlier order cancelled after it was
         *     initialised, is kept as it is and named in the answer.
         *
         *     **Owner-only**: the request accepts the customer's agreements, and no staff role holds this
         *     operation. Synchronous: it writes Core's own records and
         *     mutates no infrastructure (`CONVENTIONS.md` §7). Under one `Idempotency-Key` the first
         *     answer is replayed (`CONVENTIONS.md` §8).
         */
        post: operations["createTenant"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tenants/{tenant_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        /**
         * Get a tenant
         * @description The desired state and the last observed state of one tenant. `observed` is written by the
         *     agent heartbeat and by nightly drift detection; it is never a source of truth for what the
         *     tenant should be.
         */
        get: operations["getTenant"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tenants/{tenant_id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        /**
         * Provisioning steps, apps and URLs, capacity gauge
         * @description Everything the console's Status screen renders in one call: the canonical tenant status,
         *     the ordered provisioning steps with the job behind each, the applications with their URLs
         *     and their health, the capacity gauge that drives the upgrade prompt at 90 percent
         *     (strategy 3.2, step 5), the current status components and the agent freshness.
         *
         *     `agent.stale` is `true` once three consecutive heartbeats have been missed, which is what
         *     turns the console banner amber.
         */
        get: operations["getTenantStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tenants/{tenant_id}/domains": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        /**
         * List the custom domains of a tenant
         * @description Every custom domain of a tenant with its state, the records still to publish and the certificate expiry.
         */
        get: operations["listDomains"];
        put?: never;
        /**
         * Add a custom domain
         * @description Creates the domain in state `pending` and immediately issues the verification nonce, so
         *     the response is normally in state `nonce_issued` and already carries the exact TXT record
         *     the customer must publish. The host is not added to any certificate list before the TXT
         *     nonce is observed (strategy 3.2, step 4).
         */
        post: operations["addDomain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/domains/{domain_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        /**
         * Get a domain
         * @description One custom domain, its verification challenge, its target record and its certificate.
         */
        get: operations["getDomain"];
        put?: never;
        post?: never;
        /**
         * Remove a custom domain
         * @description Enqueues the `remove_domain` job (`docs/domain/JOB_CATALOGUE.md` §2): it removes the host
         *     from the certificate list, from the edge configuration and from the LiveKit certificate
         *     bundle, then soft-deletes the row. A domain in state `live` is refused while it is the only
         *     entry point of an app in use; the console asks the customer to switch back to the default
         *     host first.
         */
        delete: operations["deleteDomain"];
        options?: never;
        head?: never;
        /**
         * Make a host the canonical one
         * @description `is_canonical` is the only patchable member, and it may only be set to `true`, on a domain
         *     already in state `live`. It changes the host used in invitation links, the application's
         *     base URL and the realm client's default redirect; the host that was canonical before keeps
         *     serving, so nothing that is already circulating breaks.
         *
         *     One canonical domain per tenant and per role. Setting a second one moves the flag rather
         *     than raising a conflict.
         */
        patch: operations["patchDomain"];
        trace?: never;
    };
    "/domains/{domain_id}/actions/verify": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask for a verification pass
         * @description Drives the domain state machine one pass forward. It resolves the
         *     `_kodera-verify.<host>` TXT record from several resolvers, then, once the nonce matches,
         *     checks the `CNAME` or `A` target, then requests the certificate.
         *
         *     The pass is a job — `add_domain` in `docs/domain/JOB_CATALOGUE.md`, whose steps are exactly
         *     `issue_nonce`, `await_txt`, `check_caa`, `await_target` and the certificate wait — so the
         *     answer is `202` with the job and a `Location`, and the console polls `GET /jobs/{job_id}`
         *     and then re-reads the domain. `CONVENTIONS.md` §7 is explicit that a `200` from a mutating
         *     endpoint means nothing was enqueued, and a DNS pass that talks to two resolvers, a CA and
         *     the edge is not something to hold a request open for.
         *
         *     A failed pass is not an error: the job succeeds, and the domain it leaves behind carries
         *     `state: failed` or an unchanged state with `verification.attempts` incremented and
         *     `verification.last_error` set. Only a malformed request or a domain that can never be
         *     verified answers `4xx`. Re-verification is a new job, never a retry of the old one.
         */
        post: operations["verifyDomain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/community/support/tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a triaged ticket from the canonical community
         * @description Requires an active persisted membership of the explicitly configured first-party
         *     community. Customer and staff issuers are eligible without cross-tenant grants.
         *     Idempotency and a database-serialized limit of five tickets per person per rolling
         *     hour apply across all of that person's identities. No free text or contact data
         *     appears in the response. No GitHub issue is published by this operation.
         */
        post: operations["createCommunitySupportTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/support/tickets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List support tickets
         * @description A customer sees the tickets of their organisations; staff see every ticket.
         */
        get: operations["listSupportTickets"];
        put?: never;
        /**
         * Open a support ticket
         * @description The console prefills the tenant context; the API recomputes it server-side and ignores
         *     whatever the client sent for it, because the context is what routes the ticket and sets
         *     the SLA. The body is customer prose and is never used to look anything up.
         *
         *     The API stores the ticket and mirrors it into the helpdesk. The helpdesk reference is
         *     returned when the mirror succeeded and is `null` otherwise; the ticket exists either way.
         *
         *     What is built: Core stores the ticket and mails it, as plain text, to the support mailbox
         *     its deployment names. Core keeps the subject, the message and both addresses until that
         *     mail is delivered and never longer than 14 days; the other fields stay. No helpdesk mirror
         *     exists yet, so `external_ref` is `null`, and no
         *     service level per support tier exists yet, so `sla` is omitted; a client reads a missing
         *     `sla` as no promise to state, never as a default one. `organisation_id` must be the
         *     caller's organisation and `tenant_id`, when given, a tenant of it that is not deleted,
         *     otherwise `400` on `/tenant_id`; `contact_email`, when given, is one address of at most 200
         *     characters, otherwise `400` on `/contact_email`; `created_by` is the caller's identity id.
         *     A caller opens at most 5 tickets in a rolling hour and an organisation at most 20, past
         *     which the answer is `429` with `Retry-After`. An `Idempotency-Key` reused with another body,
         *     or while its first request is still running, is `409`. `Location` names the ticket's URL,
         *     which `getSupportTicket` does not serve yet. Staff tokens are refused while the staff lane
         *     of the customer operations is not built.
         */
        post: operations["createSupportTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/support/tickets/{ticket_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ticket_id: components["parameters"]["TicketId"];
            };
            cookie?: never;
        };
        /**
         * Get a support ticket
         * @description One ticket with the tenant context computed when it was opened and its SLA clock.
         */
        get: operations["getSupportTicket"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/status/components": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List status components
         * @description The components behind status.kodera.io and the in-console banner. Platform components
         *     (`scope: platform`) are public. Tenant components (`scope: tenant`) require a token for
         *     that organisation, or a staff token.
         */
        get: operations["listStatusComponents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List jobs
         * @description A customer sees the jobs of their own tenants, without step output references. Staff see
         *     every job and every step.
         */
        get: operations["listJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{job_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: components["parameters"]["JobId"];
            };
            cookie?: never;
        };
        /**
         * Get a job and its steps
         * @description One job with its ordered steps. A customer sees the steps without their output references; staff see everything.
         */
        get: operations["getJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tenants/{tenant_id}/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Trigger a lifecycle job on a tenant
         * @description Staff only, and the only way an infrastructure mutation begins. The API writes the desired
         *     state change, the `Job` and the `AuditEvent` in one transaction (core ADR-0004); the
         *     worker picks the job up, obtains its credentials per job and runs the ordered steps.
         *
         *     Allowed kinds here are the seven lifecycle operations: `provision`, `upgrade`, `backup`,
         *     `restore`, `suspend`, `resume`, `decommission`. Other job kinds exist but are only ever
         *     enqueued as a side effect of another endpoint.
         *
         *     Transitions are guarded against the tenant status machine: `provision` requires `ordered`
         *     or `failed`, `upgrade` requires `active`, `restore` requires `active`, `maintenance` or
         *     `failed`, `resume` requires `suspended`. A kind that the current status forbids answers
         *     `409 invalid-state-transition` and names the statuses that would allow it.
         *
         *     `Idempotency-Key` is required, and the job's `idempotency_key` is the digest derived from
         *     it (`CONVENTIONS.md` §8): pressing "Provision" twice never produces two Scaleway projects.
         */
        post: operations["triggerTenantJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/instances/{instance_id}/logs": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Identifier of one tenant VM, as reported by its agent. */
                instance_id: components["parameters"]["InstanceId"];
            };
            cookie?: never;
        };
        /**
         * Read the logs an agent uploaded for an instance
         * @description The staff side of the agent contract's `log_ref` (strategy Appendix A, contract 2). An
         *     instance is one tenant VM; its agent uploads command output and preflight output to
         *     Object Storage and reports the reference. This endpoint resolves those references into a
         *     readable window.
         *
         *     Logs are redacted at write time by the agent and again here: values matching the secret
         *     patterns are replaced by `[redacted]`. Customer personal data is never in these logs by
         *     construction, and this endpoint is staff only for that reason.
         *
         *     `staff_support` reads them too: the `Host`, `Ip` row of the `AUTHZ.md` §5 matrix grants it
         *     `read all`, and a support agent who can see a tenant but not the log line explaining its
         *     failure has to escalate every question to an operator.
         */
        get: operations["getInstanceLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/audit-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List audit events
         * @description The append-only record that backs the DPA's accountability clause. Rows are never updated
         *     and never deleted; retention is the retention schedule, enforced by partition drop.
         *
         *     **A customer reads their own.** `docs/domain/AUDIT_TAXONOMY.md` makes this record the
         *     answer to "what did you do to our tenant", and the `AuditEvent` row of the `AUTHZ.md` §5
         *     matrix grants `org_owner` `read own, export own` and `org_admin` `read own`. A staff-only
         *     endpoint would have left the accountability clause with no way to honour it but a support
         *     ticket. For a tenant principal the response is scoped to that principal's organisation
         *     before any filter is applied, and `organisation_id` is ignored when it names another one —
         *     it is not an authorisation input (`AUTHZ.md` §2 step 3, §6 rule 1). Staff read across
         *     organisations, and every such read is itself audited.
         */
        get: operations["listAuditEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tenants/{tenant_id}/agent-enrolment-tokens": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue a one-time enrolment token for a tenant agent
         * @description Staff only. The token lets a freshly built VM present itself once to the agent API and
         *     exchange the token for its long-lived credential: an mTLS client certificate signed by the
         *     agent CA, or a per-tenant bearer credential where mTLS is not available.
         *
         *     `secret` is returned exactly once, in this response, and is handed to the VM by the
         *     provisioning job through the same channel that writes its other secrets. The API stores an
         *     HMAC fingerprint only. The token is single use, short lived, and bound to the tenant and
         *     the instance it names.
         */
        post: operations["createAgentEnrolmentToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/slug-availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Is this slug free, and if not, what else
         * @description A computed, read-only resource, not a collection: the order screen asks it on every blur of
         *     the tenant slug field. It answers for the tenant slug, which is both the tenant's DNS label
         *     and its Scaleway project name, so one answer covers both. The organisation slug is another
         *     name, the organisation's Keycloak realm, reserved by the staff intake
         *     (`createOrganisation`); this endpoint does not answer for it.
         *
         *     The endpoint never says which organisation holds a taken slug, and it is rate limited per
         *     principal, so it cannot be used to enumerate customers. The per-principal limit is not
         *     enforced yet, so `429` is not answered yet. Until it is, only a signed-in owner or admin of
         *     a customer organisation is served (staff tokens are refused while the staff lane of the
         *     customer reads is not built), a provisioned tenant's slug is a public DNS label in any
         *     case, and `placeOrder` stays the authority on whether a slug can be taken.
         */
        get: operations["checkSlugAvailability"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/legal-documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The published contractual documents for a pack
         * @description The order screen shows the terms, the data processing agreement, the service level
         *     agreement and the acceptable use policy before the customer commits. Each document is
         *     returned with its published version and, once Core holds its text, `text_url`: the
         *     permanent URL of exactly that text (`getLegalDocumentText`). The DPA itself is generated per organisation and is read through
         *     `/organisations/{organisation_id}/dpa`; the row here is the published template.
         */
        get: operations["listLegalDocuments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/legal-documents/{code}/{version}/{locale}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The text of one published document, at its permanent URL
         * @description The exact text a customer reads and accepts, Markdown served as plain text in UTF-8: the
         *     bytes its `sha256` covers, served unchanged for as long as Core runs. A version is readable
         *     from the moment it is published, before the date it comes into force, since a new
         *     version is notified thirty days before it applies (CGV 14). A published version is never edited
         *     (a change is a new version), so the response is cacheable for a year and its `ETag` is
         *     the digest. This is the URL the order confirmation names for each accepted document
         *     (CGV 5.3). Public: the text of the terms is not a secret, and no token is read.
         *
         *     A `code`, `version` or `locale` outside its schema is `400 malformed-request`, answered
         *     without reading the database; a well-formed one that names no published text is `404`.
         *     The origin is Core's public API host (`servers`), configured by
         *     `KODERA_LEGAL_TEXT_ORIGIN`.
         */
        get: operations["getLegalDocumentText"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/entitlements": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * What the organisation's pack and tier allow
         * @description The console renders an action disabled with the name of the pack that unlocks it rather
         *     than letting the customer discover a `403` by pressing it. The list is derived from the
         *     active subscription's frozen snapshot, so it does not move when the catalogue moves.
         */
        get: operations["listEntitlements"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/status-summary": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * One call for the shell banner
         * @description Everything the console shell needs on every page load, in one request: component health,
         *     the capacity gauge, the dunning state and the next maintenance window. It exists so the
         *     shell does not fan out into four calls on every navigation, and it is cacheable for a few
         *     seconds without any of the detail screens becoming stale.
         */
        get: operations["getOrganisationStatusSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/dunning": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * Where the organisation stands on the dunning ladder
         * @description The Invoices screen tells the customer what happens next and when, rather than showing a
         *     red badge. The states are the ladder of the billing model, and they are read from the
         *     subscription, never from the tenant status.
         */
        get: operations["getDunning"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/memberships/count": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * How many people match a filter
         * @description Cursor pages carry no total, so a screen that needs a count asks for it here with its own
         *     rate limit. The federation screen uses it to say how many hosted accounts a redirection
         *     would affect; the People screen uses it for the seat gauge.
         *
         *     It counts exactly the population `listMemberships` pages through, so `state=removed`
         *     counts 0. The `account_kind` filter is not answered yet: Core does not store how an account
         *     signs in (`listMemberships` omits it for the same reason), so a request carrying it is
         *     `malformed-request` rather than a count that ignored it. The per-principal rate limit is
         *     not enforced yet, and no `429` is declared yet. Staff tokens are refused while the staff
         *     lane of the customer reads is not built.
         *
         *     The answer is a number and carries no person's fact, so directory privacy (the
         *     `Membership` schema) withholds nothing from it. `account_kind` is a private member fact,
         *     and a count filtered by it could disclose one person's: when Core starts answering that
         *     filter, it answers it only for a caller who holds `org_owner` or `org_admin` in this
         *     organisation, and refuses it `forbidden` for every other caller.
         */
        get: operations["countMemberships"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invitations/{invitation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_id: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke a pending invitation
         * @description The link stops working immediately. A revoked invitation is kept as a tombstone so the
         *     audit trail shows who invited whom and who withdrew it.
         */
        delete: operations["revokeInvitation"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invitations/{invitation_id}/actions/resend": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_id: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send the invitation email again
         * @description Keeps the same invitation and the same token, and only sends the mail again, so a person
         *     who kept the first mail is not confused by two working links. Rate limited per invitation;
         *     the response carries `sent_count` and `last_sent_at` so the console can grey the button.
         *
         *     **This action is genuinely synchronous and answers `200`, not `202`.** It mutates no
         *     infrastructure: it hands one message to the mail transport and updates two counters on a
         *     row that already exists. `CONVENTIONS.md` §7 requires `202` and a `Job` of anything that
         *     mutates infrastructure, and inventing a job here would give the console something to poll
         *     that can only ever be `succeeded`.
         */
        post: operations["resendInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/member-imports": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        /**
         * List the CSV imports of an organisation
         * @description The import history, so a partly failed import can be found again after a reload.
         */
        get: operations["listMemberImports"];
        put?: never;
        /**
         * Upload a member list
         * @description The file is parsed **server-side**, so the parsing rules live in one place and the console
         *     never holds a customer's address book beyond the page it displays. The response names the
         *     columns that were detected with a sample value each; nothing is invited yet. The raw
         *     uploaded object is deleted immediately after this parse, whether it succeeds or fails.
         *
         *     The only body that is not JSON in this contract. At most 2 MB and 5 000 rows; a larger file
         *     is refused with `payload-too-large` carrying the limit.
         *
         *     No staff role holds this operation, for the same reason as
         *     `POST /organisations/{organisation_id}/invitations`: the import is where a batch of
         *     invitations is staged, and staff prepare nothing that reaches a customer organisation
         *     (`docs/api/AUTHZ.md` §4). Staff keep reading and deleting imports.
         */
        post: operations["createMemberImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/member-imports/{member_import_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                member_import_id: components["parameters"]["MemberImportId"];
            };
            cookie?: never;
        };
        /**
         * Get an import, its preview and its per-row outcome
         * @description Polled while `state` is `validating` or `running`. Before execution, `rows` carries the
         *     validated preview. After a partial failure it carries only retryable rows; after completion
         *     or discard it is empty. This keeps retry exact without retaining successful addresses.
         */
        get: operations["getMemberImport"];
        put?: never;
        post?: never;
        /**
         * Discard an import
         * @description Deletes all personal staging data and marks the import discarded. The raw uploaded object
         *     was already deleted after parsing. Counts and audit references remain; addresses, source
         *     cells, detected samples and the filename do not.
         */
        delete: operations["deleteMemberImport"];
        options?: never;
        head?: never;
        /**
         * Map the columns and revalidate
         * @description Sets which column carries the email, the given name, the family name and the role, plus the
         *     role to use when the file has no role column. The server revalidates every row against the
         *     mapping and returns the counted preview: ready, already a member, duplicate, invalid.
         *     Patching after execution is refused with `conflict`.
         */
        patch: operations["patchMemberImport"];
        trace?: never;
    };
    "/member-imports/{member_import_id}/actions/execute": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                member_import_id: components["parameters"]["MemberImportId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send the invitations of an import
         * @description Turns the validated rows into invitations. It runs the **same** batch-invitation service as
         *     `POST /organisations/{organisation_id}/invitations`, so there is one code path that creates
         *     an invitation and one seat check; the import is the staging area, not a second engine.
         *
         *     `only_lines` scopes the run to the given source lines and is what makes the retry of a
         *     partly failed import safe: a line already invited is never invited twice, whatever is sent.
         *     Omitting it runs every row whose preview status is `ready`.
         *
         *     **Synchronous, `200`, and the same result shape as the batch it runs.** It enqueues no job:
         *     the only side effect is `Invitation` rows and the mail the transport takes from there, and
         *     no kind in `docs/domain/JOB_CATALOGUE.md` §2 covers it — sending invitations mutates no
         *     infrastructure. Answering `202` would have meant either a `JobKind` the catalogue does not
         *     define, or a job the console polls that can only ever be `succeeded`. The import row is
         *     updated in the same transaction; successful and skipped staging rows are scrubbed before
         *     commit. Re-read it with `GET /member-imports/{member_import_id}` for its new `state` and
         *     any rows that remain retryable.
         *
         *     No staff role holds this operation. Because it runs that same batch-invitation service,
         *     granting it to staff would be the invitation grant through another door
         *     (`CONSOLE_RECONCILIATION.md` §4.4, `docs/api/AUTHZ.md` §4).
         */
        post: operations["executeMemberImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tenants/{tenant_id}/availability": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        /**
         * Daily availability per component
         * @description One row per day and per component, for the strip the Status screen draws under the
         *     component list. Degraded minutes are counted from probe results, not from agent vitals, so
         *     a tenant whose agent went quiet does not appear to have been down.
         */
        get: operations["listTenantAvailability"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/status/incidents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List incidents
         * @description The incidents behind a degraded component, with their updates. Every string a customer
         *     reads is a message-catalogue key chosen from a closed set, never an operator sentence, so
         *     the console can translate it and a bad copy-paste cannot reach a customer's screen.
         */
        get: operations["listIncidents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/domains/{domain_id}/actions/reissue-nonce": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue a fresh verification nonce
         * @description A nonce lives 72 hours. When it expires the domain is `failed` and the customer needs a new
         *     record to publish rather than an error message. This replaces `verification.record_value`
         *     with a fresh value, resets the TTL and returns the domain in `nonce_issued`.
         *
         *     A nonce is never reused across rows or across tenants, so the old value stops being
         *     accepted the moment this returns. The customer must replace the TXT record, and the copy
         *     says so.
         *
         *     Re-entering the state machine is a fresh `add_domain` job, so the answer is `202` with the
         *     job and a `Location`. The nonce itself is in the domain the job's first step writes; the
         *     console polls the job, then re-reads the domain for the record to publish.
         */
        post: operations["reissueDomainNonce"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/domains/{domain_id}/actions/activate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Put the host into service
         * @description Adds the host to the edge's certificate list, requests the certificate, and adds the name
         *     to the application's allowed hosts and to the realm client's redirect URIs. This is the
         *     transition that makes a name serve the tenant.
         *
         *     Refused with `domain-state-conflict` unless the domain is at least `txt_verified`: a host
         *     never enters a certificate list before its ownership nonce has been observed. The work runs
         *     as a job because it reloads the edge and briefly puts the tenant in maintenance.
         *
         *     The job is `add_domain` — steps 5 to 9 of it, in `docs/domain/JOB_CATALOGUE.md` §2. Naming
         *     the kind here is what lets a reader check `JobAccepted.kind` against the catalogue instead
         *     of against a guess.
         */
        post: operations["activateDomain"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/domains/{domain_id}/instructions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        /**
         * The instruction sheet to forward to whoever holds the DNS
         * @description The person who buys the suite is rarely the person who can edit a DNS zone. This returns
         *     the exact records to publish as **data plus message keys**, so the console renders it in
         *     the reader's language and can also offer a PDF. The PDF is a pre-signed link, never proxied
         *     bytes.
         */
        get: operations["getDomainInstructions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/domains/{domain_id}/instruction-shares": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mail the instruction sheet to someone
         * @description The Core API sends the mail, from the platform's own sending domain with its SPF, DKIM and
         *     DMARC in place. The console never sends mail and never opens a `mailto:` with the records
         *     pasted into it, because that loses the formatting the records depend on.
         *
         *     The recipient address is stored for the audit trail and is not added to any list.
         */
        post: operations["shareDomainInstructions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/support/help-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What help to offer on this screen
         * @description The help entry in the shell is contextual: the articles, the service level the customer is
         *     entitled to, and the incident that may already explain what they are seeing. Composed
         *     server-side so the console does not hold a mapping from screens to articles that goes stale
         *     the moment an article is renamed.
         *
         *     Not composed yet: Core holds no article catalogue, no incident feed and no service level
         *     per support tier, so `articles` is empty, `incident` is null and `sla` is omitted. A client
         *     reads a missing `sla` as no promise to state, never as a default one. Staff tokens are
         *     refused while the staff lane of the customer reads is not built.
         */
        get: operations["getHelpContext"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/support/ticket-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Exactly what a ticket opened here would carry
         * @description The console shows the customer the diagnostic context before they send it, and the list is
         *     truthful because it is the same list the ticket will carry. The customer unticks what they
         *     do not want to send; the console then sends back only the codes left ticked.
         *
         *     No item ever carries meeting content, document content, a room name or a participant list.
         *     `value_summary` is a short, already-redacted rendering, not the raw value.
         */
        get: operations["getTicketContext"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/support/sign-in-problems": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask for help when you cannot sign in
         * @description The one support path that cannot require a token, because the person reporting it is the
         *     person who cannot authenticate. It answers `202` and an empty body for every input, so it
         *     cannot be used to test whether an address or an organisation exists.
         *
         *     It is also the only `202` in this contract with no `Location` header, and for the same
         *     reason: a URL to poll would say that something was created, and telling an unauthenticated
         *     caller that much is the enumeration this endpoint is shaped to prevent.
         *
         *     Heavily rate limited per IP. The report reaches the helpdesk with the submitted address and
         *     nothing the client asserted about who they are.
         */
        post: operations["reportSignInProblem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/support/tickets/{ticket_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ticket_id: components["parameters"]["TicketId"];
            };
            cookie?: never;
        };
        /**
         * The conversation on a ticket
         * @description The messages both sides have written, oldest first, with their attachments.
         */
        get: operations["listTicketMessages"];
        put?: never;
        /**
         * Reply on a ticket
         * @description Adds a customer message and mirrors it into the helpdesk. Replying reopens a ticket in
         *     `solved`; replying to a `closed` ticket is refused and the console offers to open a new one
         *     that references it.
         */
        post: operations["replyToTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/support/tickets/{ticket_id}/attachments": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ticket_id: components["parameters"]["TicketId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Attach a file to a ticket
         * @description A screenshot or an export, at most 10 MB. The file is scanned before it reaches the
         *     helpdesk; until then the attachment is in state `scanning` and the ticket is already open,
         *     so a failed attachment never costs the customer their message.
         */
        post: operations["attachToTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tenants/{tenant_id}/federation-providers": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        /**
         * List the identity providers brokered for a tenant
         * @description Federation is brokered by the organisation's Keycloak realm: the console never talks to
         *     Google or Microsoft, and never to Keycloak's admin API (console ADR-0003). Everything here
         *     is applied to the realm server-side.
         */
        get: operations["listFederationProviders"];
        put?: never;
        /**
         * Start a guided federation setup
         * @description Creates the provider in state `draft` and returns, in the same response, the **generated
         *     values** the customer must paste into Google or Microsoft — the application name, the
         *     redirect URI, the sign-out URI and the scopes — plus the runbook that walks them through
         *     it. Nothing is applied to the realm yet, and no account is redirected.
         *
         *     The values are generated, never typed by the customer: a redirect URI with a typo is the
         *     single most common cause of a federation that never works.
         */
        post: operations["createFederationProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/federation-providers/{federation_provider_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        /**
         * Get a federation provider
         * @description The provider, its generated values, whether a secret is set and when it expires, the
         *     verification state of each claimed email domain, and the result of the last test.
         */
        get: operations["getFederationProvider"];
        put?: never;
        post?: never;
        /**
         * Disable a federation provider
         * @description Removes the identity provider from the realm and returns every federated account to hosted
         *     sign-in. It is not a data deletion: the accounts stay, their sign-in route changes. The
         *     provider row moves to `disabled` and keeps its history.
         *
         *     Refused with `conflict` when it is the only sign-in route left and no hosted account holds
         *     `org_owner`, because that would lock the organisation out of its own console.
         *
         *     The job is `realm_update` (`docs/domain/JOB_CATALOGUE.md` §2): removing a brokered provider
         *     is the same `configure_idp` difference against the live realm as adding one. Every
         *     operation in this contract that answers `202` with a `JobAccepted` names its kind, so
         *     `JobAccepted.kind` can be checked against the catalogue and not against a guess.
         */
        delete: operations["disableFederationProvider"];
        options?: never;
        head?: never;
        /**
         * Change the claimed domains or the label
         * @description The email domains a federated sign-in is accepted for, and the display label on the sign-in
         *     button. Changing the domains on an `active` provider re-runs the domain checks and is
         *     applied to the realm by a `realm_update` job.
         *
         *     `login_mode` is not patched here: switching a whole organisation to redirect-only is the
         *     activation action, because it needs the hosted-account count in front of the person doing
         *     it.
         */
        patch: operations["patchFederationProvider"];
        trace?: never;
    };
    "/federation-providers/{federation_provider_id}/credentials": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set the client id and the client secret
         * @description Write-only. The secret is envelope-encrypted on arrival and **no endpoint of this API ever
         *     returns it**, not to staff, not to the owner, not in an error message and not in a log. The
         *     response says whether a secret is set and when it expires, and nothing more.
         *
         *     `PATCH` rather than `PUT` because this contract does not use `PUT`; sending both members
         *     replaces both. Sending `client_secret: null` is refused: clearing a secret is disabling the
         *     provider, which is `DELETE`.
         */
        patch: operations["setFederationCredentials"];
        trace?: never;
    };
    "/federation-providers/{federation_provider_id}/tests": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        /**
         * The tests run against this provider
         * @description The history, newest first, so a customer can see that it worked yesterday and not today.
         */
        get: operations["listFederationTests"];
        put?: never;
        /**
         * Start a real sign-in test
         * @description Returns an authorisation URL the console sends the browser to. The person signs in at
         *     Google or Microsoft for real, comes back, and the result says whether the provider accepted
         *     them and whether their email domain is one this provider is allowed to serve.
         *
         *     A test never creates an account and never changes how anyone else signs in. It is the step
         *     that turns "I pasted the secret" into "it works", and it is why activation can be refused
         *     until a test has succeeded.
         */
        post: operations["startFederationTest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/federation-tests/{federation_test_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_test_id: components["parameters"]["FederationTestId"];
            };
            cookie?: never;
        };
        /**
         * The result of one sign-in test
         * @description Polled while `state` is `pending`. The tested address comes back masked, so the result can
         *     be read out in a room without putting somebody's address on a projector, and the provider's
         *     own error text stays server-side: the console receives a closed `failure_code` and a
         *     translated `provider_message_key`.
         */
        get: operations["getFederationTest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/federation-providers/{federation_provider_id}/actions/activate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Put federation into service, and choose the sign-in modes
         * @description Applies the identity provider to the organisation's realm. `both` adds a sign-in button beside the
         *     hosted form; `redirect` sends everyone to the provider and is the one that can lock people
         *     out, so it is refused unless a test has succeeded and unless at least one hosted account
         *     holds `org_owner` as a way back in.
         *
         *     `acknowledged_hosted_accounts` must equal the current hosted-account count from
         *     `/organisations/{organisation_id}/memberships/count?account_kind=hosted`. A stale number
         *     means the screen the person confirmed is not the world they are confirming, and the call is
         *     refused with `conflict`.
         *
         *     The job is `realm_update` (`docs/domain/JOB_CATALOGUE.md` §2), whose `configure_idp` step
         *     is exactly this: organisation-scoped, no tenant lock, applied as a difference against the
         *     live realm rather than a re-import.
         */
        post: operations["activateFederationProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/federation-providers/{federation_provider_id}/runbook": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        /**
         * The one-page procedure for the provider's own admin console
         * @description The steps to follow in Google Workspace or in Microsoft Entra, as data: an ordered list of
         *     message keys, each optionally naming the generated value it refers to. The console renders
         *     it and the customer forwards it; the PDF is a pre-signed link.
         *
         *     No step is free prose, so the procedure is translated once and stays correct when a
         *     generated value changes.
         */
        get: operations["getFederationRunbook"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/federation-providers/{federation_provider_id}/runbook-shares": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mail the runbook to whoever administers the provider
         * @description The person who administers Google Workspace is often not the person in the console. The
         *     Core API sends the mail; the console never does. The mail carries the runbook and the
         *     generated values, and never the client secret.
         */
        post: operations["shareFederationRunbook"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/moderation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Moderate workspace member
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited. A stored workspace moderator grant is required unless the caller is an owner or admin. Token-supplied moderator claims grant nothing.
         */
        post: operations["moderateWorkspaceMember"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List abuse reports
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited. A stored workspace moderator grant is required unless the caller is an owner or admin. Token-supplied moderator claims grant nothing.
         */
        get: operations["listAbuseReports"];
        put?: never;
        /**
         * Create abuse report
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["createAbuseReport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/reports/{report_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Resolve abuse report
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited. A stored workspace moderator grant is required unless the caller is an owner or admin. Token-supplied moderator claims grant nothing.
         */
        patch: operations["resolveAbuseReport"];
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/invite-links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List workspace invite links
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["listWorkspaceInviteLinks"];
        put?: never;
        /**
         * Create workspace invite link
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["createWorkspaceInviteLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/invite-links/{invite_link_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Revoke workspace invite link
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        delete: operations["revokeWorkspaceInviteLink"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/workspace-invites/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Preview workspace invite
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["previewWorkspaceInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/workspace-invites/redeem": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Redeem workspace invite
         * @description Rate limited; verified identity and email required. Lock the link row, check revocation, expiry and usesCount < maxUses, then add membership and increment usesCount atomically. Retries and existing members never consume another use. Codes never appear in URLs or logs.
         */
        post: operations["redeemWorkspaceInvite"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/attachments/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create attachment upload
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["createAttachmentUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/attachments/{attachment_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete attachment upload
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["completeAttachmentUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/attachments/{attachment_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get attachment
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["getAttachment"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/unfurl": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Unfurl url
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["unfurlUrl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List notifications
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["listNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notifications/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark notifications read
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["markNotificationsRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/push/public-key": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get push public key
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["getPushPublicKey"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/push/subscriptions/{device_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Put push subscription
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        put: operations["putPushSubscription"];
        post?: never;
        /**
         * Delete push subscription
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        delete: operations["deletePushSubscription"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List workspace documents
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["listWorkspaceDocuments"];
        put?: never;
        /**
         * Create workspace document
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["createWorkspaceDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/documents/{document_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get workspace document
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["getWorkspaceDocument"];
        put?: never;
        post?: never;
        /**
         * Delete workspace document
         * @description Editors only; reject deletion of non-empty parents with 409 conflict. Removal revokes collaboration tickets and closes active sessions.
         */
        delete: operations["deleteWorkspaceDocument"];
        options?: never;
        head?: never;
        /**
         * Update workspace document
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        patch: operations["updateWorkspaceDocument"];
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/documents/{document_id}/backlinks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List document backlinks
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["listDocumentBacklinks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/documents/{document_id}/collab-session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create document collab session
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        post: operations["createDocumentCollabSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/organisations/{organisation_id}/workspace/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search workspace
         * @description Organisation is derived from the verified issuer; current active membership and resource visibility are checked on every request. Responses are Cache-Control: no-store. All mutations are audited.
         */
        get: operations["searchWorkspace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * WorkspaceModerationRequest
         * @description Moderator actions are audited. Moderators cannot target owners or admins. Mute requires a future expiresAt, at most 30 days away; other actions refuse expiresAt. Bans block Core room tickets, Matrix joins and messages. Mutes are evaluated against server time on every publish and post.
         */
        WorkspaceModerationRequest: {
            /** Format: uuid */
            membershipId: string;
            /** @enum {string} */
            action: "kick" | "ban" | "unban" | "mute";
            reason: string;
            /** Format: date-time */
            expiresAt?: string;
        };
        /**
         * WorkspaceModeration
         * @example {
         *       "id": "00000000-0000-7000-8000-000000000001",
         *       "membershipId": "00000000-0000-7000-8000-000000000002",
         *       "action": "mute",
         *       "expiresAt": "2026-01-02T12:00:00Z",
         *       "createdAt": "2026-01-01T12:00:00Z"
         *     }
         */
        WorkspaceModeration: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            membershipId: string;
            /** @enum {string} */
            action: "kick" | "ban" | "unban" | "mute";
            /** Format: date-time */
            expiresAt: string | null;
            /** Format: date-time */
            createdAt: string;
        };
        /** AbuseReportRequest */
        AbuseReportRequest: {
            /** Format: uuid */
            membershipId: string;
            /** Format: uuid */
            channelId?: string;
            eventId?: string;
            reason: string;
        };
        /**
         * AbuseReport
         * @example {
         *       "id": "00000000-0000-7000-8000-000000000001",
         *       "membershipId": "00000000-0000-7000-8000-000000000002",
         *       "reason": "Unwanted messages",
         *       "status": "open",
         *       "resolution": null,
         *       "createdAt": "2026-01-01T12:00:00Z"
         *     }
         */
        AbuseReport: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            membershipId: string;
            reason: string;
            /** @enum {string} */
            status: "open" | "resolved" | "dismissed";
            resolution: string | null;
            /** Format: date-time */
            createdAt: string;
        };
        /** ResolveAbuseReportRequest */
        ResolveAbuseReportRequest: {
            /** @enum {string} */
            status: "resolved" | "dismissed";
            resolution: string;
        };
        /**
         * WorkspaceInviteLinkRequest
         * @description Only owners/admins can grant moderator. Scope is restricted to this organisation; channel must belong to its workspace. Expiration is mandatory and no more than 30 days away.
         */
        WorkspaceInviteLinkRequest: {
            /** Format: date-time */
            expiresAt: string;
            maxUses: number;
            /** Format: uuid */
            channelId?: string;
            /** @enum {string} */
            role?: "org_member" | "moderator";
        };
        /**
         * WorkspaceInviteLink
         * @example {
         *       "id": "00000000-0000-7000-8000-000000000001",
         *       "expiresAt": "2026-01-02T12:00:00Z",
         *       "maxUses": 10,
         *       "usesCount": 0,
         *       "revokedAt": null,
         *       "channelId": null,
         *       "role": "org_member"
         *     }
         */
        WorkspaceInviteLink: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            expiresAt: string;
            maxUses: number;
            usesCount: number;
            /** Format: date-time */
            revokedAt: string | null;
            /** Format: uuid */
            channelId: string | null;
            /** @enum {string} */
            role: "org_member" | "moderator";
        };
        /**
         * CreatedWorkspaceInviteLink
         * @description The random code is disclosed only on creation, never on list. Store only its cryptographic digest. Redemptions serialize the usage counter and are idempotent per caller.
         * @example {
         *       "link": {
         *         "id": "00000000-0000-7000-8000-000000000001",
         *         "expiresAt": "2026-01-02T12:00:00Z",
         *         "maxUses": 10,
         *         "usesCount": 0,
         *         "revokedAt": null,
         *         "channelId": null,
         *         "role": "org_member"
         *       },
         *       "code": "example-invite-code-do-not-redeem"
         *     }
         */
        CreatedWorkspaceInviteLink: {
            link: components["schemas"]["WorkspaceInviteLink"];
            code: string;
        };
        /** WorkspaceInviteCodeRequest */
        WorkspaceInviteCodeRequest: {
            code: string;
        };
        /**
         * WorkspaceInvitePreview
         * @description Rate limited and non-consuming. Invalid, expired, revoked and exhausted codes return indistinguishable 404 problems. No member information is disclosed.
         * @example {
         *       "organisationName": "Example workspace",
         *       "role": "org_member",
         *       "expiresAt": "2026-01-02T12:00:00Z"
         *     }
         */
        WorkspaceInvitePreview: {
            organisationName: string;
            /** @enum {string} */
            role: "org_member" | "moderator";
            /** Format: date-time */
            expiresAt: string;
        };
        /**
         * WorkspaceInviteRedemption
         * @example {
         *       "organisationId": "00000000-0000-7000-8000-000000000001",
         *       "membershipId": "00000000-0000-7000-8000-000000000002"
         *     }
         */
        WorkspaceInviteRedemption: {
            /** Format: uuid */
            organisationId: string;
            /** Format: uuid */
            membershipId: string;
        };
        /**
         * AttachmentUploadRequest
         * @description SHA-256 is the lowercase hex digest. The upload signature binds checksum, content type and size to an organisation-scoped random object key. HTML and SVG are refused.
         */
        AttachmentUploadRequest: {
            filename: string;
            /** @enum {string} */
            contentType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "application/pdf" | "text/plain" | "application/octet-stream";
            sizeBytes: number;
            sha256: string;
        };
        /**
         * AttachmentUploadTicket
         * @description Short-lived presigned URL, no storage credentials. The client must send exactly these signed headers. Completion verifies the actual object before making metadata visible.
         * @example {
         *       "attachmentId": "00000000-0000-7000-8000-000000000001",
         *       "uploadUrl": "https://storage.example.org/upload",
         *       "method": "PUT",
         *       "headers": {
         *         "Content-Type": "image/png"
         *       },
         *       "expiresAt": "2026-01-01T12:00:00Z"
         *     }
         */
        AttachmentUploadTicket: {
            /** Format: uuid */
            attachmentId: string;
            /** Format: uri */
            uploadUrl: string;
            /** @enum {string} */
            method: "PUT";
            headers: {
                [key: string]: string;
            };
            /** Format: date-time */
            expiresAt: string;
        };
        /**
         * Attachment
         * @description Membership is checked on every metadata/download ticket request. Non-image MIME types force Content-Disposition attachment. Download URLs are short-lived and must not be logged.
         * @example {
         *       "id": "00000000-0000-7000-8000-000000000001",
         *       "filename": "example.png",
         *       "contentType": "image/png",
         *       "sizeBytes": 1234,
         *       "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
         *       "downloadUrl": "https://storage.example.org/download",
         *       "expiresAt": "2026-01-01T12:00:00Z",
         *       "disposition": "inline"
         *     }
         */
        Attachment: {
            /** Format: uuid */
            id: string;
            filename: string;
            contentType: string;
            sizeBytes: number;
            sha256: string;
            /** Format: uri */
            downloadUrl: string;
            /** Format: date-time */
            expiresAt: string;
            /** @enum {string} */
            disposition: "inline" | "attachment";
        };
        /**
         * UnfurlRequest
         * @description Only HTTP(S), ports 80/443. Resolve once per hop, reject every non-public address including mapped IPv6, pin TCP to the validated address while preserving TLS hostname verification, revalidate at most three redirects. Three-second total deadline and 256 KiB text/html maximum.
         */
        UnfurlRequest: {
            /** Format: uri */
            url: string;
        };
        /** UnfurlImage */
        UnfurlImage: {
            /** Format: uri */
            url: string;
            width: number;
            height: number;
            /** @enum {string} */
            contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
        };
        /**
         * UnfurlResult
         * @description All text is plain sanitized text. Canonical and image URLs pass the same public-target policy; unvalidated images are omitted. Never return HTML.
         * @example {
         *       "url": "https://example.org/article",
         *       "canonicalUrl": "https://example.org/article",
         *       "title": "Example article",
         *       "description": "A public article.",
         *       "siteName": "Example"
         *     }
         */
        UnfurlResult: {
            /** Format: uri */
            url: string;
            /** Format: uri */
            canonicalUrl: string;
            title: string;
            description: string;
            siteName: string;
            image?: components["schemas"]["UnfurlImage"];
        };
        /** @description 403 RFC 9457 forbidden problem. reason distinguishes policy-blocked targets and private/reserved DNS answers without disclosing resolved addresses. */
        UnfurlBlockedProblem: components["schemas"]["Problem"] & {
            /** @constant */
            type?: "https://kodera.io/problems/forbidden";
            /** @enum {string} */
            reason: "blocked-target" | "private-target";
        };
        /**
         * Notification
         * @description Authenticated inbox entry; no message plaintext is sent through Web Push.
         * @example {
         *       "id": "00000000-0000-7000-8000-000000000001",
         *       "kind": "document",
         *       "resourceId": "00000000-0000-7000-8000-000000000002",
         *       "createdAt": "2026-01-01T12:00:00Z",
         *       "readAt": null
         *     }
         */
        Notification: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "mention" | "invitation" | "moderation" | "document";
            /** Format: uuid */
            resourceId: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            readAt: string | null;
        };
        /** MarkNotificationsReadRequest */
        MarkNotificationsReadRequest: {
            ids: string[];
        };
        /**
         * PushPublicKey
         * @description Base64url uncompressed P-256 VAPID public key. Wakeups have an empty body; clients fetch this authenticated inbox. No message, title, document text, or resource identifier is sent to the push provider.
         * @example {
         *       "publicKey": "example-public-key-placeholder",
         *       "payloadMode": "empty"
         *     }
         */
        PushPublicKey: {
            publicKey: string;
            /** @enum {string} */
            payloadMode: "empty";
        };
        /**
         * PushSubscriptionRequest
         * @description Subscription belongs to this authenticated user and device only. Validate the decoded P-256 point and 16-byte auth secret. Endpoint uses the same public-address, pinned transport policy as unfurl; do not permit a push endpoint to become an SSRF proxy. Dead 404/410 subscriptions are pruned.
         */
        PushSubscriptionRequest: {
            /** Format: uri */
            endpoint: string;
            p256dh: string;
            auth: string;
        };
        /**
         * WorkspaceDocumentRequest
         * @description Maximum depth 16, same-workspace parent only. No chat-thread promotion endpoint exists.
         */
        WorkspaceDocumentRequest: {
            title: string;
            /** Format: uuid */
            parentId?: string | null;
            /** @enum {string} */
            templateKey?: "spec" | "adr" | "meeting_notes" | "runbook";
        };
        /**
         * WorkspaceDocumentPatch
         * @description At least one field required. Reject cycles and descendant trees exceeding depth 16. Markdown replacement uses If-Match; collaboration snapshots remain authoritative.
         */
        WorkspaceDocumentPatch: {
            title?: string;
            /** Format: uuid */
            parentId?: string | null;
            markdown?: string;
        };
        /**
         * WorkspaceDocument
         * @example {
         *       "id": "00000000-0000-7000-8000-000000000001",
         *       "parentId": null,
         *       "title": "Example specification",
         *       "markdown": "# Example specification\n",
         *       "role": "editor",
         *       "updatedAt": "2026-01-01T12:00:00Z"
         *     }
         */
        WorkspaceDocument: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            parentId: string | null;
            title: string;
            markdown: string;
            /** @enum {string} */
            role: "editor" | "viewer";
            /** Format: date-time */
            updatedAt: string;
        };
        /**
         * DocumentBacklink
         * @example {
         *       "documentId": "00000000-0000-7000-8000-000000000001",
         *       "title": "Example specification"
         *     }
         */
        DocumentBacklink: {
            /** Format: uuid */
            documentId: string;
            title: string;
        };
        /**
         * WorkspaceSearchResult
         * @description Only resources visible to the authenticated membership; restricted channels and documents never leak via search or backlinks.
         * @example {
         *       "id": "00000000-0000-7000-8000-000000000001",
         *       "kind": "document",
         *       "title": "Example specification",
         *       "excerpt": "Example"
         *     }
         */
        WorkspaceSearchResult: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            kind: "document" | "channel";
            title: string;
            excerpt: string;
        };
        /**
         * DocumentCollabSession
         * @description Ticket lifetime at most 300 seconds, bound to one document, organisation and subject. Validate current membership and document policy before minting and room join. Viewer connections receive sync, updates and awareness, but client state updates are dropped and audited. Invalid/expired tickets close 4401; cross-org/wrong-doc/role violations close 4403. Ticket travels in the first frame, never a query string or logs.
         * @example {
         *       "wsUrl": "wss://api.example.org/documents/collab",
         *       "token": "example-ticket-placeholder",
         *       "expiresAt": "2026-01-01T12:00:00Z",
         *       "role": "viewer"
         *     }
         */
        DocumentCollabSession: {
            /** Format: uri */
            wsUrl: string;
            token: string;
            /** Format: date-time */
            expiresAt: string;
            /** @enum {string} */
            role: "editor" | "viewer";
        };
        InstantClaimTenantRequest: {
            organizationName: string;
            /** @description Platform names, community, xn-- and synth- prefixes are reserved. */
            slug: string;
            /** @enum {string} */
            hostingMode: "cloud" | "self-host";
            templateId: components["schemas"]["WorkspaceTemplateId"];
            /**
             * @description The workspace's starting theme; omitted, the template's default applies. Send a `ThemeId`. The three `ThemeIdAlias` values are the identifiers this member took before 0.42.0 and stay accepted, so that no existing request or stored value breaks. `enum` repeats the two lists, in their order, for tools that do not follow `anyOf`.
             * @enum {string}
             */
            themeId?: "light" | "dark" | "black" | "ciel" | "ciel-nuit" | "givre" | "ardoise" | "real-black";
            /** @enum {string} */
            soundPackId?: "cristal-48k" | "studio-mat" | "silence" | "givre" | "atelier" | "souffle" | "cosmos" | "luciole" | "silencieux";
            /** @description Duplicates are collapsed preserving order; omitted uses template defaults. */
            enabledConnectors?: ("frameio-review-bridge" | "github-webhook" | "linear-sync" | "sentry-alerts" | "qonto-treasury-alerts" | "stripe-revenue-events" | "calcom-booking-sync" | "nextcloud-drive-notifier")[];
        };
        /**
         * @example {
         *       "workspaceId": "018f1234-5678-7000-8000-000000000030",
         *       "workspaceUrl": "https://studio.example.org",
         *       "invitationUrl": "https://studio.example.org/invite?signed=example",
         *       "channels": [
         *         {
         *           "id": "018f1234-5678-7000-8000-000000000031",
         *           "name": "production",
         *           "kind": "text"
         *         }
         *       ],
         *       "enabledConnectors": [
         *         "frameio-review-bridge"
         *       ],
         *       "offerMode": "cloud-shared"
         *     }
         */
        InstantClaimResponse: {
            /** Format: uuid */
            workspaceId: string;
            /** Format: uri */
            workspaceUrl: string;
            /** Format: uri */
            invitationUrl: string;
            /** @enum {string} */
            offerMode: "cloud-shared" | "cloud-dedicated";
            enabledConnectors: string[];
            channels: {
                /** Format: uuid */
                id: string;
                name: string;
                /** @enum {string} */
                kind: "text" | "audio";
            }[];
        };
        /**
         * WorkspaceTemplateId
         * @description The machine identifier of an official workspace template. It is always ASCII and is never
         *     the label a person reads.
         *
         *     `proximity` is the canonical identifier of the proximity template. The feature is
         *     displayed as `#proximity` in English and `#proximité` in French; both are display labels
         *     from the message catalogues, and neither is ever sent or stored as an identifier.
         *
         *     `crisis-cell` is a deprecated alias of `proximity`. It is the identifier this template
         *     took before 0.42.0 and it is permanent: Core accepts it for as long as this contract
         *     exists, resolves it to the same template as `proximity`, and never answers it differently.
         *     A new client sends `proximity`; a value stored as `crisis-cell` is read as `proximity`.
         * @example proximity
         * @enum {string}
         */
        WorkspaceTemplateId: "audiovisual-production" | "tech-studio" | "b2b-advisory" | "public-sector" | "proximity" | "crisis-cell";
        /**
         * ThemeId
         * @description The unified theme vocabulary, the same identifier on every client and in Core: `light`,
         *     `dark`, `black` (true black), `ciel` (sky) and `ciel-nuit` (night sky). The identifier is
         *     ASCII and is never a display label. A client writes these five values and no other.
         * @example light
         * @enum {string}
         */
        ThemeId: "light" | "dark" | "black" | "ciel" | "ciel-nuit";
        /**
         * ThemeIdAlias
         * @deprecated
         * @description The three theme identifiers in use before 0.42.0, kept as deprecated aliases so that an
         *     existing request and a stored value stay readable. Each names exactly one `ThemeId`:
         *
         *     | Alias | `ThemeId` |
         *     |---|---|
         *     | `givre` | `light` |
         *     | `ardoise` | `dark` |
         *     | `real-black` | `black` |
         *
         *     Core accepts an alias wherever it accepts a `ThemeId` and treats it as the `ThemeId` it
         *     names. A client never writes an alias, and reads one, from storage or from an older
         *     peer, as the `ThemeId` it names. `ciel` and `ciel-nuit` have no alias.
         * @example givre
         * @enum {string}
         */
        ThemeIdAlias: "givre" | "ardoise" | "real-black";
        /**
         * ProximityCheckInHandle
         * @description Reserved for the proximity check-in model: no operation of this contract carries it yet,
         *     and declaring it adds no endpoint and changes no existing answer.
         *
         *     A short pseudonymous handle shown to the other people of a proximity check-in in place of
         *     a name, so that a check-in never requires a real first or last name. It is either
         *     dedicated (chosen by the person for check-ins) or generated by Core. It is not the
         *     person's `display_name` and is never derived from a name, an email address or any other
         *     fact that identifies the person.
         *
         *     3 to 24 characters: lower-case ASCII letters and digits in groups separated by single
         *     hyphens, with no leading, trailing or doubled hyphen.
         * @example heron-4821
         */
        ProximityCheckInHandle: string;
        /**
         * ProximityCheckInPseudonym
         * @description Reserved for the proximity check-in model: no operation of this contract carries it yet.
         *     How a person appears in a proximity check-in: a pseudonymous handle and where it came
         *     from, and no name, email address or account identifier.
         * @example {
         *       "handle": "heron-4821",
         *       "origin": "generated"
         *     }
         */
        ProximityCheckInPseudonym: {
            handle: components["schemas"]["ProximityCheckInHandle"];
            /**
             * @description `dedicated` when the person chose the handle for check-ins; `generated` when Core generated it because the person chose none.
             * @enum {string}
             */
            origin: "dedicated" | "generated";
        };
        /**
         * Money
         * @description An amount in the smallest unit of its currency. Never a float, never a decimal string:
         *     `{amount_minor: 44900, currency: "EUR"}` is 449,00 EUR. Only EUR exists at launch.
         * @example {
         *       "amount_minor": 44900,
         *       "currency": "EUR"
         *     }
         */
        Money: {
            /**
             * Format: int64
             * @description Amount in cents, never negative; a credit note states what it credits.
             */
            amount_minor: number;
            /**
             * @default EUR
             * @enum {string}
             */
            currency: "EUR";
        };
        /**
         * CursorPage
         * @description Envelope of every collection. Cursors are opaque and signed; offsets are never exposed,
         *     so a page is stable while rows are inserted. Stop when `has_more` is `false`, never when
         *     `data` is short.
         * @example {
         *       "data": [],
         *       "next_cursor": null,
         *       "has_more": false
         *     }
         */
        CursorPage: {
            /** @description The page. */
            data: unknown[];
            /** @description Pass as `cursor` to fetch the next page. `null` on the last page. */
            next_cursor?: string | null;
            /** @description Whether another page exists. */
            has_more: boolean;
        };
        /**
         * ProblemType
         * Format: uri
         * @description Registry of the `type` URIs this API emits. The URI is stable and dereferenceable: it
         *     resolves to the human page that explains the condition and what the client should do.
         *     Clients switch on this value, never on `title` or `detail`, which are prose and may change.
         *
         *     **This enum and the table in `docs/api/CONVENTIONS.md` §6 are one list.** The convention
         *     says a new value is a pull request that adds a row there *and* a member here; a contract
         *     test compares the two and fails on any difference in either direction. Extension members
         *     per type are in that table.
         *
         *     | `type` | Status | When | What the client should do |
         *     |---|---|---|---|
         *     | `validation-error` | 422 | body failed schema or business validation | show the field errors from `errors[]` |
         *     | `malformed-request` | 400 | unparseable JSON, wrong media type, bad query parameter | a client bug: unparseable body, wrong media type or a bad parameter |
         *     | `unauthenticated` | 401 | absent, expired or unverifiable token | refresh, then re-authenticate |
         *     | `mfa-required` | 403 | a token whose `amr` carries no second factor, on a write the API re-asserts it for: every staff write and `consumeOwnerClaim` | send the person through MFA enrolment |
         *     | `forbidden` | 403 | authenticated, but the role or scope does not allow it | hide the action; do not retry |
         *     | `identity-unknown` | 403 | a verified customer token whose `(iss, sub)` names no enabled customer identity of an enabled person, such as a realm account Core never bound; never the `invited` principal on `acceptInvitation`, nor a staff token; no `WWW-Authenticate` | do not re-authenticate; show "no organisation yet" |
         *     | `not-found` | 404 | absent, or not visible to this caller | treat as absent |
         *     | `method-not-allowed` | 405 | method not defined on the path | a client bug; read `allowed[]` |
         *     | `conflict` | 409 | generic state conflict; look at the specific types first | show which field collides |
         *     | `slug-taken` | 409 | an organisation already holds the slug the intake asked for, or a tenant, now or before, the slug an order or `createTenant` asked for | ask for another slug, with a new key; `createTenant` names up to three free ones in `suggestions` |
         *     | `order-in-progress` | 409 | the organisation has an order `placed` or `awaiting_payment`, and `placeOrder` asked for another | show that order: pay it or cancel it (`cancelOrder`), then order again with a new key |
         *     | `invoice-issued` | 409 | `cancelOrder` on an order whose invoice has a payment received or a debit still settling: only a partial credit with a refund corrects it, which Core does not issue yet | send the customer to support; do not retry |
         *     | `billing-disabled` | 409 | `placeOrder` or `createPaymentLink` on a deployment that does not bill (`billing_enabled: false` in the status summary) | hide ordering and payment; do not retry |
         *     | `billing-enabled` | 409 | `createTenant` on a deployment that bills (`billing_enabled: true` in the status summary) | order with `placeOrder` instead; do not retry |
         *     | `tenant-exists` | 409 | `createTenant` for an organisation that already holds a tenant that is not `deleted` | open the organisation's workspace; do not retry |
         *     | `idempotency-key-missing` | 400 | a `POST` without `Idempotency-Key` | a client bug; every `POST` carries a key |
         *     | `idempotency-key-reuse` | 409 | same key, different body hash | a client bug; generate a new key |
         *     | `idempotency-key-in-flight` | 409 | same key, the first request is still running | wait `retry_after_s`, then replay the same key |
         *     | `precondition-failed` | 412 | `If-Match` did not match the current `ETag` | re-read the resource and re-apply against the new `ETag` |
         *     | `precondition-required` | 428 | a `PATCH` without `If-Match` | send `If-Match` with the `ETag` of the last read |
         *     | `payload-too-large` | 413 | body over the endpoint's limit | show the limit from `limit_bytes` |
         *     | `unsupported-media-type` | 415 | not `application/json` | a client bug |
         *     | `rate-limited` | 429 | bucket exhausted | back off for `Retry-After` seconds |
         *     | `invalid-state-transition` | 409 | the transition is not in the state machine's allowed table | show the current status and the ones in `allowed_states` |
         *     | `tenant-locked` | 409 | a job holds the tenant's advisory lock | wait for the job in `job_id` and poll it |
         *     | `quota-exceeded` | 409 | plan, capacity tier or provider quota would be exceeded | show the upgrade prompt |
         *     | `domain-verification-failed` | 409 | a domain check failed | show the failing `check` and what was `observed` |
         *     | `domain-state-conflict` | 409 | the domain is not in a state that allows the operation | re-read the domain and follow its state machine |
         *     | `last-owner-protected` | 409 | the last `org_owner` would be removed or demoted | require a second owner first |
         *     | `owner-claim-expired` | 410 | the owner claim's `expires_at` has passed | tell the person to ask for a reissued claim; do not retry |
         *     | `owner-claim-revoked` | 410 | the owner claim was revoked | same as expired |
         *     | `invitation-expired` | 410 | the invitation's `expires_at` has passed | tell the person to ask for a new invitation; do not retry |
         *     | `invitation-revoked` | 410 | an administrator revoked the invitation | same as expired |
         *     | `owner-claim-consumed` | 409 | the owner claim was already consumed, and this is not a replay of the consuming request | the organisation has its owner; send the person to sign in normally |
         *     | `owner-claim-identity-mismatch` | 403 | the claim of this organisation is bound to another identity of the same realm | tell the person to sign in as the intended owner; do not retry |
         *     | `owner-claim-contact-unverified` | 403 | the caller's contact in the realm is not verified | send the person through verification, then retry with a new logical key |
         *     | `payment-required` | 402 | organisation suspended for non-payment | show the invoice and the payment link |
         *     | `subscription-required` | 402 | the action needs an active subscription the organisation lacks | show the plan named in `required_plan` |
         *     | `dpa-not-accepted` | 409 | processing asked for before the DPA is accepted | send the customer through the DPA step |
         *     | `not-implemented` | 501 | declared in the contract, not yet built | declared here, not built yet; quote `tracking` to support |
         *     | `upstream-unavailable` | 502 | billing, payment or helpdesk did not answer | retry with the same idempotency key |
         *     | `service-unavailable` | 503 | maintenance or shedding | back off for `Retry-After` seconds |
         *     | `intake-closed` | 503 | this database does not admit the staff intake yet | do not retry; the intake opens with the cutover |
         *     | `internal-error` | 500 | unhandled failure | show the `request_id` and offer support |
         * @example https://kodera.io/problems/invalid-state-transition
         * @enum {string}
         */
        ProblemType: "https://kodera.io/problems/validation-error" | "https://kodera.io/problems/malformed-request" | "https://kodera.io/problems/unauthenticated" | "https://kodera.io/problems/mfa-required" | "https://kodera.io/problems/forbidden" | "https://kodera.io/problems/identity-unknown" | "https://kodera.io/problems/not-found" | "https://kodera.io/problems/method-not-allowed" | "https://kodera.io/problems/conflict" | "https://kodera.io/problems/slug-taken" | "https://kodera.io/problems/order-in-progress" | "https://kodera.io/problems/invoice-issued" | "https://kodera.io/problems/billing-disabled" | "https://kodera.io/problems/billing-enabled" | "https://kodera.io/problems/tenant-exists" | "https://kodera.io/problems/idempotency-key-missing" | "https://kodera.io/problems/idempotency-key-reuse" | "https://kodera.io/problems/idempotency-key-in-flight" | "https://kodera.io/problems/precondition-failed" | "https://kodera.io/problems/precondition-required" | "https://kodera.io/problems/payload-too-large" | "https://kodera.io/problems/unsupported-media-type" | "https://kodera.io/problems/rate-limited" | "https://kodera.io/problems/invalid-state-transition" | "https://kodera.io/problems/tenant-locked" | "https://kodera.io/problems/quota-exceeded" | "https://kodera.io/problems/domain-verification-failed" | "https://kodera.io/problems/domain-state-conflict" | "https://kodera.io/problems/last-owner-protected" | "https://kodera.io/problems/owner-claim-expired" | "https://kodera.io/problems/owner-claim-revoked" | "https://kodera.io/problems/owner-claim-consumed" | "https://kodera.io/problems/invitation-expired" | "https://kodera.io/problems/invitation-revoked" | "https://kodera.io/problems/owner-claim-identity-mismatch" | "https://kodera.io/problems/owner-claim-contact-unverified" | "https://kodera.io/problems/payment-required" | "https://kodera.io/problems/subscription-required" | "https://kodera.io/problems/dpa-not-accepted" | "https://kodera.io/problems/not-implemented" | "https://kodera.io/problems/upstream-unavailable" | "https://kodera.io/problems/service-unavailable" | "https://kodera.io/problems/intake-closed" | "https://kodera.io/problems/internal-error";
        /**
         * Problem
         * @description RFC 9457 problem document, served as `application/problem+json`. `title` and `detail` are
         *     English staff-facing prose; the console never shows them raw to a customer, it maps `type`
         *     to a message-catalogue key. No customer personal data ever appears in a problem document.
         * @example {
         *       "type": "https://kodera.io/problems/invalid-state-transition",
         *       "title": "The tenant is not in a state that allows this job",
         *       "status": 409,
         *       "detail": "Job kind upgrade requires the tenant to be active; it is provisioning.",
         *       "instance": "/api/v1/tenants/2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b/jobs",
         *       "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
         *       "allowed_states": [
         *         "active"
         *       ]
         *     }
         */
        Problem: {
            type: components["schemas"]["ProblemType"];
            /** @description Short, stable summary of the problem type. */
            title: string;
            /** @description Same value as the HTTP status line. */
            status: number;
            /** @description What went wrong in this occurrence. Prose, never parsed by a client. */
            detail?: string;
            /**
             * Format: uri-reference
             * @description Path of the request that failed.
             */
            instance?: string;
            /** @description Same value as the `X-Request-Id` response header. */
            request_id: string;
            /** @description Field-level errors, present on `malformed-request` and on `validation-error`. */
            errors?: {
                /** @description JSON Pointer (RFC 6901) into the request body. */
                pointer: string;
                /** @description Stable machine-readable reason, safe to switch on. */
                code: string;
                detail?: string;
            }[];
            /** @description Present on `rate-limited`, `service-unavailable`, `upstream-unavailable`, `tenant-locked` and `idempotency-key-in-flight`. */
            retry_after_s?: number | null;
            /** @description Present on `invalid-state-transition` and `domain-state-conflict`; the states in which the operation would succeed. */
            allowed_states?: string[];
            /**
             * Format: uuid
             * @description Present on `tenant-locked`; the job that holds the tenant's advisory lock.
             */
            job_id?: string | null;
            /** @description Present on `precondition-failed`; the tag to re-read against. */
            current_etag?: string | null;
            /**
             * Format: uuid
             * @description Present on `last-owner-protected` and on the five `owner-claim-*` types; the organisation the claim is bound to.
             */
            organisation_id?: string | null;
            /**
             * Format: date-time
             * @description Present on `idempotency-key-reuse`; when the stored entry of the reused key was first recorded, in UTC with millisecond precision (`2026-11-04T13:55:00.123Z`).
             */
            first_seen_at?: string;
            /**
             * @description Present on `conflict`; a stable machine-readable name for the state that conflicts.
             *     The values are listed here, and a client switches only on these:
             *
             *     - `category_not_empty`: `deleteCategory` on a category that a channel row, in any
             *       lifecycle, still references; move its channels out first.
             *     - `channel_limit`: `createChannel` when the workspace already holds 500 channels that
             *       are not deleted, archived ones included, the most one channel set can carry; archive
             *       is not removal, so nothing frees a place yet.
             *     - `channel_set_too_large`: a structural change after which the organisation's
             *       channel set would pass the bounds of agent-api's `ChannelMembership` (10,000 listed
             *       members in all); nothing is written. A membership change is never refused for it.
             *
             *     Every other conflict this contract specifies has a problem type of its own (a held
             *     slug is `slug-taken`, not `conflict` with a reason).
             */
            reason?: string;
            /** @description Present on `mfa-required`; the `amr` values any one of which satisfies the second-factor requirement re-asserted on every staff write and on `consumeOwnerClaim`. */
            required_amr?: string[];
            /** @description Present on `slug-taken` from `createTenant`; up to three slugs free at the moment of the answer, which is not a reservation. */
            suggestions?: string[];
        };
        /**
         * DownloadLink
         * @description A short-lived, pre-signed link to a document in Object Storage. The API never proxies
         *     document bytes. Each issuance writes an audit event naming the subject that asked.
         * @example {
         *       "url": "https://s3.fr-par.scw.cloud/kodera-invoices/2026/INV-2026-0142.pdf?X-Amz-Signature=redacted",
         *       "expires_at": "2026-12-01T10:05:00Z",
         *       "content_type": "application/pdf",
         *       "filename": "INV-2026-0142.pdf",
         *       "sha256": "000000000000000000000000000000000000000000000000000000000000d10c",
         *       "size_bytes": 48213
         *     }
         */
        DownloadLink: {
            /**
             * Format: uri
             * @description Pre-signed URL. Treat as a secret, do not log.
             */
            url: string;
            /** Format: date-time */
            expires_at: string;
            /** @example application/pdf */
            content_type: string;
            filename?: string;
            /** @description Digest of the document, so the customer can verify what they downloaded. The example is deliberately non-random so a secret scanner does not flag it once it is copied into a generated file; a real value is a full digest. */
            sha256?: string | null;
            size_bytes?: number | null;
        };
        /**
         * JobAccepted
         * @description Returned by endpoints whose real work happens in a job the caller can poll.
         * @example {
         *       "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
         *       "kind": "realm_update",
         *       "status": "queued",
         *       "job_url": "/api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
         *     }
         */
        JobAccepted: {
            /** Format: uuid */
            job_id: string;
            kind: components["schemas"]["JobKind"];
            status: components["schemas"]["JobStatus"];
            /** Format: uri-reference */
            job_url?: string;
        };
        /** @description Opaque deterministic correlation reference for the intake operation; not proof of a durable row, a resource URL or an authorization capability. */
        OperationReference: string;
        /**
         * OrganisationRole
         * @description Role held in one organisation, mapped one to one onto a Keycloak group in the organisation's realm.
         *     `org_owner` is the contractual signatory: it alone accepts the DPA and orders.
         *
         *     The names are spelt exactly as `docs/api/AUTHZ.md` §4 and `docs/domain/MODEL.md` spell them,
         *     and exactly as `x-kodera-authz` spells them on every operation of this file. One role, one
         *     spelling, three documents: a second spelling for one thing is how three disagreeing status
         *     enums happened once already.
         *
         *     ADR-0010 fixes this four-role tenant set. Only `org_owner` changes an active
         *     membership to or from `org_billing`; it is a sideways finance grant and implies
         *     no administration role.
         * @example org_admin
         * @enum {string}
         */
        OrganisationRole: "org_owner" | "org_admin" | "org_billing" | "org_member";
        /**
         * InvitationRole
         * @description Role an invitation or member import may grant. Ownership is deliberately absent: it is
         *     assigned only through a guarded change to an active membership. Runtime authorisation
         *     additionally prevents an admin from granting `org_billing` (ADR-0010).
         * @example org_member
         * @enum {string}
         */
        InvitationRole: "org_admin" | "org_billing" | "org_member";
        /**
         * EnrolmentRole
         * @description A shared on-site enrolment token grants ordinary membership only (ADR-0010).
         * @example org_member
         * @enum {string}
         */
        EnrolmentRole: "org_member";
        /**
         * MembershipState
         * @description `invited` is pending membership acceptance; `active` is an accepted membership; `suspended` is a suspended membership relationship; `removed` is a retained membership tombstone.
         *     These are stored membership facts, not evidence of provider account existence, usability or disablement.
         * @example active
         * @enum {string}
         */
        MembershipState: "invited" | "active" | "suspended" | "removed";
        /**
         * Identity
         * @description One Keycloak subject in one realm. A person may hold several, one per organisation.
         * @example {
         *       "id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *       "issuer": "https://id.kodera.io/realms/acme-sa",
         *       "realm": "acme-sa",
         *       "subject": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
         *       "email": "julie@acme.fr",
         *       "email_verified": true,
         *       "mfa_enrolled": true,
         *       "federated_with": null,
         *       "last_login_at": "2026-12-01T08:41:12Z"
         *     }
         */
        Identity: {
            /** Format: uuid */
            id: string;
            /**
             * Format: uri
             * @description The `iss` of tokens from this realm.
             */
            issuer: string;
            realm: string;
            /** @description The `sub` claim. Opaque, stable, never reused. */
            subject: string;
            /** Format: email */
            email: string;
            email_verified?: boolean;
            /** @description On `/me`, only for the exact current identity: the signed local-TOTP registration fact when every current-token admission condition holds. strict `false` means no qualifying local TOTP; omission means unknown. */
            mfa_enrolled?: boolean;
            /**
             * @description Set when the account comes from a guided federation rather than a hosted account.
             * @enum {string|null}
             */
            federated_with?: "google" | "microsoft" | null;
            /** Format: date-time */
            last_login_at?: string | null;
        };
        /**
         * Me
         * @description The caller. `organisations` is what the console renders as the organisation switcher; a
         *     person in several organisations has one entry per membership, each with its own realm.
         * @example {
         *       "id": "11111111-2222-4333-8444-555555555555",
         *       "email": "julie@acme.fr",
         *       "display_name": "Julie Marchand",
         *       "locale": "fr",
         *       "staff": false,
         *       "identities": [
         *         {
         *           "id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *           "issuer": "https://id.kodera.io/realms/acme-sa",
         *           "realm": "acme-sa",
         *           "subject": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
         *           "email": "julie@acme.fr",
         *           "email_verified": true,
         *           "mfa_enrolled": true,
         *           "federated_with": null,
         *           "last_login_at": "2026-12-01T08:41:12Z"
         *         }
         *       ],
         *       "organisations": [
         *         {
         *           "organisation": {
         *             "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *             "slug": "acme-sa",
         *             "name": "ACME SAS",
         *             "realm": "acme-sa"
         *           },
         *           "membership_id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
         *           "role": "org_admin",
         *           "state": "active",
         *           "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *           "joined_at": "2026-11-04T14:02:00Z"
         *         }
         *       ]
         *     }
         */
        Me: {
            /**
             * Format: uuid
             * @description Core's own person id, stable across realms.
             */
            id: string;
            /**
             * Format: email
             * @description Primary email; the one an invitation was sent to.
             */
            email: string;
            display_name?: string | null;
            /**
             * @default fr
             * @enum {string}
             */
            locale: "fr" | "en";
            /** @description True for a token from the `kodera-staff` realm. */
            staff: boolean;
            /** @description Present and non-empty only when `staff` is true. */
            staff_roles?: ("staff_operator" | "staff_support" | "staff_security")[];
            identities: components["schemas"]["Identity"][];
            organisations: {
                organisation: components["schemas"]["OrganisationSummary"];
                /** Format: uuid */
                membership_id: string;
                role: components["schemas"]["OrganisationRole"];
                state: components["schemas"]["MembershipState"];
                /**
                 * Format: uuid
                 * @description Which identity signs the person into this organisation.
                 */
                identity_id?: string;
                /** Format: date-time */
                joined_at?: string | null;
            }[];
        };
        DiscoveryOrganisationSummary: {
            /** Format: uuid */
            id: string;
            slug: string;
            name: string;
            realm: string;
        };
        /** @description Realm equals organisation slug and realm. Exact admitted issuer plus /realms/{slug}; well-known URL is derived from that issuer. Never fetch a caller-supplied URL. */
        RealmDiscoveryCandidate: {
            realm: string;
            /** Format: uri */
            issuer: string;
            /** Format: uri */
            openid_configuration_url: string;
            organisation: components["schemas"]["DiscoveryOrganisationSummary"];
        };
        /** @description Exactly one canonical wire slug or approved ASCII email. Domain lowercased for exact lookup; local part discarded before lookup and quota-key creation. No server slug URL parsing. Missing/both/unknown fields and invalid format are 422. Duplicate JSON keys are 400 before schema validation. */
        RealmDiscoveryRequest: {
            slug?: string;
            /** Format: email */
            email?: string;
        } & (unknown | unknown);
        /**
         * @description Eligible nondeleted active/suspended organisations with ready customer realms only. Exact currently verified domain associations for email. Prospects use separately owned claim-bound entry; all ineligible/no matches return exact zero. Candidate organisations are distinct and sorted by slug then id. Positive organisation metadata disclosure is intentional; this is not an enumeration-prevention guarantee. Every request reads current authoritative state; no response replay or cache.
         * @example {
         *       "realm": null,
         *       "issuer": null,
         *       "openid_configuration_url": null,
         *       "organisation": null,
         *       "candidates": []
         *     }
         * @example {
         *       "realm": "atelier",
         *       "issuer": "https://id.kodera.io/realms/atelier",
         *       "openid_configuration_url": "https://id.kodera.io/realms/atelier/.well-known/openid-configuration",
         *       "organisation": {
         *         "id": "11111111-1111-4111-8111-111111111111",
         *         "slug": "atelier",
         *         "name": "Atelier Example",
         *         "realm": "atelier"
         *       },
         *       "candidates": []
         *     }
         * @example {
         *       "realm": null,
         *       "issuer": null,
         *       "openid_configuration_url": null,
         *       "organisation": null,
         *       "candidates": [
         *         {
         *           "realm": "atelier",
         *           "issuer": "https://id.kodera.io/realms/atelier",
         *           "openid_configuration_url": "https://id.kodera.io/realms/atelier/.well-known/openid-configuration",
         *           "organisation": {
         *             "id": "11111111-1111-4111-8111-111111111111",
         *             "slug": "atelier",
         *             "name": "Atelier Example",
         *             "realm": "atelier"
         *           }
         *         },
         *         {
         *           "realm": "bureau",
         *           "issuer": "https://id.kodera.io/realms/bureau",
         *           "openid_configuration_url": "https://id.kodera.io/realms/bureau/.well-known/openid-configuration",
         *           "organisation": {
         *             "id": "22222222-2222-4222-8222-222222222222",
         *             "slug": "bureau",
         *             "name": "Bureau Example",
         *             "realm": "bureau"
         *           }
         *         }
         *       ]
         *     }
         */
        RealmDiscoveryResult: {
            realm: null;
            issuer: null;
            openid_configuration_url: null;
            organisation: null;
            candidates: components["schemas"]["RealmDiscoveryCandidate"][];
        } | {
            realm: string;
            /** Format: uri */
            issuer: string;
            /** Format: uri */
            openid_configuration_url: string;
            organisation: components["schemas"]["DiscoveryOrganisationSummary"];
            candidates: components["schemas"]["RealmDiscoveryCandidate"][];
        } | {
            realm: null;
            issuer: null;
            openid_configuration_url: null;
            organisation: null;
            candidates: components["schemas"]["RealmDiscoveryCandidate"][];
        };
        /**
         * OrganisationSummary
         * @description The subset of an organisation that is safe to embed everywhere.
         * @example {
         *       "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "slug": "acme-sa",
         *       "name": "ACME SAS",
         *       "realm": "acme-sa"
         *     }
         */
        OrganisationSummary: {
            /** Format: uuid */
            id: string;
            slug: string;
            name: string;
            realm?: string | null;
        };
        /**
         * BillingAddress
         * @example {
         *       "line1": "12 rue de la Paix",
         *       "line2": null,
         *       "postal_code": "75002",
         *       "city": "Paris",
         *       "country": "FR"
         *     }
         */
        BillingAddress: {
            line1: string;
            line2?: string | null;
            postal_code: string;
            city: string;
            /** @description ISO 3166-1 alpha-2. */
            country: string;
        };
        /**
         * Organisation
         * @description The legal and commercial entity. One organisation owns one Keycloak realm, which every
         *     tenant it orders authenticates against. `slug` is the realm's name (ADR-0006) and cannot
         *     be patched. The Scaleway project, the DNS label, the TEM subdomain and the OpenTofu state
         *     file belong to each tenant and are named by `Tenant.slug`.
         * @example {
         *       "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "slug": "acme-sa",
         *       "name": "ACME",
         *       "legal_name": "ACME SAS",
         *       "state": "active",
         *       "realm": "acme-sa",
         *       "country": "FR",
         *       "vat_number": "FR12345678901",
         *       "siren": "123456789",
         *       "vat_regime": "fr_standard",
         *       "billing_email": "compta@acme.fr",
         *       "billing_address": {
         *         "line1": "12 rue de la Paix",
         *         "line2": null,
         *         "postal_code": "75002",
         *         "city": "Paris",
         *         "country": "FR"
         *       },
         *       "email_domains": [
         *         "acme.fr"
         *       ],
         *       "locale": "fr",
         *       "created_at": "2026-11-04T13:55:00Z",
         *       "updated_at": "2026-12-01T09:12:00Z"
         *     }
         */
        Organisation: {
            /** Format: uuid */
            id: string;
            slug: string;
            name: string;
            legal_name?: string | null;
            state: components["schemas"]["OrganisationState"];
            /** @description Null until the `realm_create` job the intake enqueued created it. */
            realm?: string | null;
            /** @default FR */
            country: string;
            /** @example FR12345678901 */
            vat_number?: string | null;
            siren?: string | null;
            /**
             * @description Decided from country and VAT number at order time and snapshotted on the subscription.
             * @enum {string}
             */
            vat_regime?: "fr_standard" | "eu_reverse_charge" | "exempt" | "outside_eu";
            /** Format: email */
            billing_email?: string | null;
            billing_address?: components["schemas"]["BillingAddress"] | null;
            /** @description Domains that resolve to this organisation in realm discovery. Verified by DNS before they count. */
            email_domains?: string[];
            /**
             * @default fr
             * @enum {string}
             */
            locale: "fr" | "en";
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * OrganisationCreateRequest
         * @description The staff intake of `FIRST_SLICE_SPEC.md` §P1. `instruction_ref` and `intended_owner`
         *     are required: an organisation is never created without a recorded customer instruction
         *     and a named person to claim it. There is no member, role, DPA or order here, and
         *     `additionalProperties: false` refuses one. The optional members after `intended_owner`
         *     are sealed with the intended owner's contact on the intake record; `Organisation` stores
         *     none of them yet.
         * @example {
         *       "slug": "acme-sa",
         *       "name": "ACME",
         *       "legal_name": "ACME SAS",
         *       "country": "FR",
         *       "vat_number": "FR12345678901",
         *       "billing_email": "compta@acme.fr",
         *       "email_domains": [
         *         "acme.fr"
         *       ],
         *       "locale": "fr",
         *       "instruction_ref": "SUP-0418",
         *       "intended_owner": {
         *         "email": "julie@acme.fr",
         *         "display_name": "Julie Marchand"
         *       }
         *     }
         */
        OrganisationCreateRequest: {
            /**
             * @description The organisation's realm name (ADR-0006), 5–20 characters. The closed list under `not`
             *     is the reserved names, refused `422` with the code `reserved`, and refused by the
             *     database too (`organisation_slug_not_reserved`, migration `orgs.0008`): the realm names
             *     the identity provider
             *     already holds or must never hand to an organisation — `master`, Keycloak's
             *     administration realm; `kodera-staff`, the staff realm; `kodera-probe`, the realm of the
             *     studio's other applications; `kodera-dev`, the lab realm on staging — and `kodera`,
             *     `staff` and `admin`, which would read as the platform's own. Since 0.22.0 it also holds
             *     the platform labels of `kodera.io` that fit the slug pattern, `notify`, `staging`,
             *     `status`, `support`, `billing`, `console`, `developers`, `matrix`, `auth-admin` and
             *     `auth-mail`, refused by the database since migration `orgs.0013`; since 0.39.0 the
             *     platform hosts `errors` and `ops-admin`, which that list missed (migrations `orgs.0018`
             *     and `orgs.0019`); since 0.40.0, `community` is reserved for the official Community host
             *     (migration `orgs.0020`). Adding a name to the list is a breaking change. Since 0.29.0 every syntactically valid slug beginning
             *     `synth-` is also reserved (`allOf`), refused `422 reserved` and by the database check
             *     `organisation_slug_not_synthetic` (migrations `orgs.0015` and `orgs.0016`). These
             *     synthetic realms are created outside Core; ordinary intake has no synthetic bypass.
             *     `synth`, `synth0-a` and `synthesis` remain ordinary names. Syntax errors are still
             *     reported before reservation errors; output and discovery slug shapes do not change.
             */
            slug: string & unknown;
            name: string;
            /**
             * @description Reference of the recorded customer instruction this intake acts on — a ticket or
             *     signed-request identifier such as `SUP-0418`: two to eight capital letters, a hyphen
             *     and one to eight digits. A reference, never the instruction's content, and the pattern
             *     leaves no room for an address or a name pasted in clear; it is written to the
             *     `organisation.intake_recorded` audit event as it is.
             */
            instruction_ref: string;
            /**
             * @description The person who will claim first ownership. Sealed on the intake record — encrypted at
             *     application level, with no `Contact` row — and returned only masked on the bootstrap
             *     view. The worker binds this person's
             *     realm identity and the claim is issued to that identity, not to the address: a
             *     matching email string alone never satisfies the claim.
             */
            intended_owner: {
                /** Format: email */
                email: string;
                display_name?: string | null;
            };
            legal_name?: string | null;
            /** @default FR */
            country: string;
            vat_number?: string | null;
            siren?: string | null;
            /** Format: email */
            billing_email?: string | null;
            billing_address?: components["schemas"]["BillingAddress"] | null;
            email_domains?: string[];
            /**
             * @default fr
             * @enum {string}
             */
            locale: "fr" | "en";
        };
        /**
         * OrganisationPatchRequest
         * @description JSON merge patch (RFC 7386). Absent members are unchanged; `null` clears a nullable member.
         *     `slug` and `realm` are absent on purpose: neither can be patched.
         * @example {
         *       "billing_email": "factures@acme.fr",
         *       "locale": "fr"
         *     }
         */
        OrganisationPatchRequest: {
            name?: string;
            legal_name?: string | null;
            vat_number?: string | null;
            siren?: string | null;
            /** Format: email */
            billing_email?: string | null;
            billing_address?: components["schemas"]["BillingAddress"] | null;
            email_domains?: string[];
            /** @enum {string} */
            locale?: "fr" | "en";
        };
        /**
         * NoticeContacts
         * @description Where the data processing agreement's notices go. Each address is `null` when unset, and
         *     its `*_defaults_to_owners` is then true: the notice goes to the organisation's current
         *     owners.
         * @example {
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "security_contact_email": "securite@acme.fr",
         *       "security_contact_defaults_to_owners": false,
         *       "privacy_contact_email": "dpo@acme.fr",
         *       "privacy_contact_defaults_to_owners": false,
         *       "subprocessor_notice_email": null,
         *       "subprocessor_notice_defaults_to_owners": true
         *     }
         */
        NoticeContacts: {
            /** Format: uuid */
            organisation_id: string;
            /**
             * Format: email
             * @description Security incident notices (DPA 8.2).
             */
            security_contact_email: string | null;
            security_contact_defaults_to_owners: boolean;
            /**
             * Format: email
             * @description Privacy and data-protection notices, the DPO or privacy lead (DPA 11.6).
             */
            privacy_contact_email: string | null;
            privacy_contact_defaults_to_owners: boolean;
            /**
             * Format: email
             * @description Sub-processor change notices (DPA Annex D).
             */
            subprocessor_notice_email: string | null;
            subprocessor_notice_defaults_to_owners: boolean;
        };
        /**
         * NoticeContactsPatchRequest
         * @description JSON merge patch (RFC 7386). Absent members are unchanged; `null` clears one.
         * @example {
         *       "privacy_contact_email": "dpo@acme.fr",
         *       "subprocessor_notice_email": null
         *     }
         */
        NoticeContactsPatchRequest: {
            /** Format: email */
            security_contact_email?: string | null;
            /** Format: email */
            privacy_contact_email?: string | null;
            /** Format: email */
            subprocessor_notice_email?: string | null;
        };
        /**
         * OrganisationState
         * @description Commercial state of the organisation, independent of the tenant status machine. One
         *     list, used by `Organisation.state` and by the bootstrap view, so that persistence, this
         *     contract and the console cannot disagree on it (`FIRST_SLICE_SPEC.md` §P2).
         *
         *     `prospect` is the intake state: the organisation exists, its slug is reserved, no
         *     membership exists, and the only mutation it admits is `consumeOwnerClaim`. It leaves
         *     `prospect` for `active` in the transaction that creates the first `org_owner`
         *     (`docs/domain/MODEL.md`, organisation lifecycle). The abandonment of a `prospect` that is
         *     never claimed has no transition yet: the specification defines none and this contract
         *     invents none.
         * @example active
         * @enum {string}
         */
        OrganisationState: "prospect" | "active" | "suspended" | "closed";
        /**
         * BootstrapStepState
         * @description Progress of one worker-driven step of the bootstrap. `pending` is not yet started,
         *     `running` is claimed by the worker, `ready` is done and verified, `failed` exhausted its
         *     attempts and needs an operator. A lost provider response is `running` until reconciled,
         *     never `ready` on a guess (`FIRST_SLICE_SPEC.md` §P1, step 2).
         * @example ready
         * @enum {string}
         */
        BootstrapStepState: "pending" | "running" | "ready" | "failed";
        /**
         * OwnerClaimState
         * @description `not_issued` until the identity binding is `ready`; `issued` while the claim can be
         *     consumed; `consumed`, `expired` and `revoked` are terminal. Closed, because the console
         *     renders one message per member on the claim page.
         * @example issued
         * @enum {string}
         */
        OwnerClaimState: "not_issued" | "issued" | "consumed" | "expired" | "revoked";
        /**
         * @description Synthetic contract examples only; the current server omits this optional customer-only
         *     transport. Structure is not signature, current-identity, registered-factor, clock or
         *     protected-use qualification. Staff never receive customer assurance.
         * @example {
         *       "version": 1,
         *       "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *       "authentication_mfa": false
         *     }
         * @example {
         *       "version": 1,
         *       "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *       "authentication_mfa": true,
         *       "email_verified": false,
         *       "mfa_enrolled": false,
         *       "enrollment_window": {
         *         "evaluated_at_ms": 1000,
         *         "valid_before_ms": 2000,
         *         "profile": "issuer-core-bounded-v1"
         *       }
         *     }
         */
        BootstrapCallerAssurance: {
            /** @constant */
            version: 1;
            identity_id: string;
            authentication_mfa: boolean;
            email_verified?: boolean;
            mfa_enrolled?: boolean;
            enrollment_window?: components["schemas"]["BootstrapEnrollmentWindow"];
        };
        /**
         * @description Fixed version1 Core-axis coordinates, not arrival-relative durations or a qualified
         *     browser deadline. This schema does not prove evaluated_at_ms precedes valid_before_ms,
         *     a qualified interval clock, signature provenance or current protected-use eligibility.
         *     Both true and false enrollment evidence expire to omission; omission is unknown.
         */
        BootstrapEnrollmentWindow: {
            evaluated_at_ms: number;
            valid_before_ms: number;
            /** @constant */
            profile: "issuer-core-bounded-v1";
        };
        /**
         * OrganisationBootstrap
         * @description Where an organisation's bootstrap stands: the intake, the realm, the intended identity's
         *     binding and the owner claim, as one view. Computed from the organisation, its
         *     `realm_create` job and its claim; it is never stored. It carries no secret: not the
         *     claim token, not its verifier, not a delivery payload, and the intended owner's address
         *     is masked.
         * @example {
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "slug": "acme-sa",
         *       "organisation_state": "prospect",
         *       "intake": {
         *         "instruction_ref": "SUP-0418",
         *         "recorded_at": "2026-11-04T13:55:00Z",
         *         "intended_owner_email_masked": "j***e@acme.fr"
         *       },
         *       "realm": {
         *         "state": "ready",
         *         "name": "acme-sa",
         *         "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
         *       },
         *       "identity_mapping": {
         *         "state": "ready",
         *         "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *         "bound_at": "2026-11-04T14:20:00Z"
         *       },
         *       "claim": {
         *         "state": "issued",
         *         "issued_at": "2026-11-04T14:20:05Z",
         *         "expires_at": "2026-11-07T14:20:05Z",
         *         "consumed_at": null,
         *         "revoked_at": null,
         *         "membership_id": null
         *       },
         *       "updated_at": "2026-11-04T14:20:05Z"
         *     }
         */
        OrganisationBootstrap: {
            /** Format: uuid */
            organisation_id: string;
            slug: string;
            organisation_state: components["schemas"]["OrganisationState"];
            intake: {
                instruction_ref: string;
                /** Format: date-time */
                recorded_at: string;
                /** @description First and last character of the local part, the domain in clear. */
                intended_owner_email_masked: string;
            };
            /** @description The organisation's realm, created by the `realm_create` job the intake enqueued. */
            realm: {
                state: components["schemas"]["BootstrapStepState"];
                /** @description Null until the realm exists. */
                name?: string | null;
                /**
                 * Format: uuid
                 * @description The `realm_create` job; readable by staff through `getJob`.
                 */
                job_id: string;
            };
            /**
             * @description The worker's binding of the intended person to a verified `(iss, sub)` of the realm.
             *     Recorded by the worker after the approved identity-provider flow; never inferred from
             *     an email string, and never linked across organisations.
             */
            identity_mapping: {
                state: components["schemas"]["BootstrapStepState"];
                /**
                 * Format: uuid
                 * @description Null until bound.
                 */
                identity_id?: string | null;
                /** Format: date-time */
                bound_at?: string | null;
            };
            claim: {
                state: components["schemas"]["OwnerClaimState"];
                /** Format: date-time */
                issued_at?: string | null;
                /**
                 * Format: date-time
                 * @description Set by the issuer from the lifetime the security decision fixes; `FIRST_SLICE_SPEC.md` §P1 proposes 72 hours and this contract fixes no number.
                 */
                expires_at?: string | null;
                /** Format: date-time */
                consumed_at?: string | null;
                /** Format: date-time */
                revoked_at?: string | null;
                /**
                 * Format: uuid
                 * @description The first `org_owner` membership, once consumed.
                 */
                membership_id?: string | null;
            };
            /** Format: date-time */
            updated_at: string;
            caller_assurance?: components["schemas"]["BootstrapCallerAssurance"];
        };
        /**
         * OrganisationIntakeResult
         * @description What a staff intake created — the organisation in `prospect` and the bootstrap it started.
         * @example {
         *       "organisation": {
         *         "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "slug": "acme-sa",
         *         "name": "ACME",
         *         "legal_name": "ACME SAS",
         *         "state": "prospect",
         *         "realm": null,
         *         "country": "FR",
         *         "vat_number": "FR12345678901",
         *         "siren": null,
         *         "vat_regime": "fr_standard",
         *         "billing_email": "compta@acme.fr",
         *         "billing_address": null,
         *         "email_domains": [
         *           "acme.fr"
         *         ],
         *         "locale": "fr",
         *         "created_at": "2026-11-04T13:55:00Z",
         *         "updated_at": "2026-11-04T13:55:00Z"
         *       },
         *       "bootstrap": {
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "slug": "acme-sa",
         *         "organisation_state": "prospect",
         *         "intake": {
         *           "instruction_ref": "SUP-0418",
         *           "recorded_at": "2026-11-04T13:55:00Z",
         *           "intended_owner_email_masked": "j***e@acme.fr"
         *         },
         *         "realm": {
         *           "state": "pending",
         *           "name": null,
         *           "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
         *         },
         *         "identity_mapping": {
         *           "state": "pending",
         *           "identity_id": null,
         *           "bound_at": null
         *         },
         *         "claim": {
         *           "state": "not_issued",
         *           "issued_at": null,
         *           "expires_at": null,
         *           "consumed_at": null,
         *           "revoked_at": null,
         *           "membership_id": null
         *         },
         *         "updated_at": "2026-11-04T13:55:00Z"
         *       }
         *     }
         */
        OrganisationIntakeResult: {
            organisation: components["schemas"]["Organisation"];
            bootstrap: components["schemas"]["OrganisationBootstrap"];
        };
        /**
         * OwnerClaimConsumeRequest
         * @example {
         *       "token": "own_EXAMPLE0000000000000000000000000000000000000",
         *       "display_name": "Julie Marchand"
         *     }
         */
        OwnerClaimConsumeRequest: {
            /**
             * @description The opaque claim token from the delivery. Single use, bound to one organisation and
             *     one identity, compared against its stored verifier in constant time. At least 256
             *     bits of randomness, so at least 43 characters in its encoding. Never logged.
             */
            token: string;
            display_name?: string | null;
        };
        /**
         * OwnerClaimResult
         * @description What consuming the claim created, in one transaction — the organisation now `active` and its first `org_owner`.
         * @example {
         *       "organisation": {
         *         "id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "slug": "acme-sa",
         *         "name": "ACME",
         *         "legal_name": "ACME SAS",
         *         "state": "active",
         *         "realm": "acme-sa",
         *         "country": "FR",
         *         "vat_number": "FR12345678901",
         *         "siren": null,
         *         "vat_regime": "fr_standard",
         *         "billing_email": "compta@acme.fr",
         *         "billing_address": null,
         *         "email_domains": [
         *           "acme.fr"
         *         ],
         *         "locale": "fr",
         *         "created_at": "2026-11-04T13:55:00Z",
         *         "updated_at": "2026-11-05T09:12:00Z"
         *       },
         *       "membership": {
         *         "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "person_id": "11111111-2222-4333-8444-555555555555",
         *         "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *         "email": "julie@acme.fr",
         *         "display_name": "Julie Marchand",
         *         "role": "org_owner",
         *         "state": "active",
         *         "source": "owner_claim",
         *         "account_kind": "hosted",
         *         "mfa_enrolled": true,
         *         "last_seen_at": "2026-11-05T09:12:00Z",
         *         "created_at": "2026-11-05T09:12:00Z",
         *         "updated_at": "2026-11-05T09:12:00Z"
         *       }
         *     }
         */
        OwnerClaimResult: {
            organisation: components["schemas"]["Organisation"];
            membership: components["schemas"]["Membership"];
        };
        /**
         * Workspace
         * @description The organisation's one workspace as the caller may see it (`getWorkspace`), and where its
         *     setup stands. Structure only: never a message, a file or an occupancy. Every list is in
         *     its stored order; stored positions are not sent, so a row the caller may not see leaves no
         *     gap. `docs/specs/PILOT_WORKSPACE_ONBOARDING.md` says how each member is derived.
         * @example {
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "state": "initialised",
         *       "setup": {
         *         "state": "ready",
         *         "reason": null
         *       },
         *       "can_initialise": false,
         *       "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
         *       "categories": [
         *         {
         *           "id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
         *           "name": "General",
         *           "template_key": "general",
         *           "channels": [
         *             {
         *               "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
         *               "kind": "text",
         *               "name": "welcome",
         *               "template_key": "welcome",
         *               "topic": "",
         *               "lifecycle": "active",
         *               "room_state": "ready"
         *             },
         *             {
         *               "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd1",
         *               "kind": "text",
         *               "name": "general",
         *               "template_key": "general",
         *               "topic": "",
         *               "lifecycle": "active",
         *               "room_state": "ready"
         *             }
         *           ]
         *         },
         *         {
         *           "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcf",
         *           "name": "Team",
         *           "template_key": "team",
         *           "channels": [
         *             {
         *               "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd2",
         *               "kind": "audio",
         *               "name": "lounge",
         *               "template_key": "lounge",
         *               "topic": "",
         *               "lifecycle": "active",
         *               "room_state": "pending"
         *             }
         *           ]
         *         }
         *       ],
         *       "uncategorised_channels": []
         *     }
         * @example {
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "state": "not_initialised",
         *       "setup": {
         *         "state": "pending",
         *         "reason": "awaiting_owner_confirmation"
         *       },
         *       "can_initialise": false,
         *       "id": null,
         *       "categories": [],
         *       "uncategorised_channels": []
         *     }
         */
        Workspace: {
            /** Format: uuid */
            organisation_id: string;
            state: components["schemas"]["WorkspaceState"];
            setup: components["schemas"]["WorkspaceSetup"];
            /**
             * @description True when the caller may call `initialiseWorkspace` now and it would create the
             *     starter: an `org_owner` or `org_admin`, an `active` organisation, `setup.state`
             *     `ready`, the CGV and the DPA accepted (with an order not cancelled whose DPA is
             *     accepted, or with no order, as a deployment that does not bill records them, for one
             *     tenant of the organisation not `deleted`), and `state` `not_initialised`. Advice for rendering, not authorisation; the
             *     operation checks the same conditions itself.
             */
            can_initialise: boolean;
            /**
             * Format: uuid
             * @description Null while `state` is `not_initialised`.
             */
            id: string | null;
            /** @description The categories the caller may see. Empty while `state` is `not_initialised`. */
            categories: components["schemas"]["WorkspaceCategory"][];
            /** @description The channels in no category that the caller may view. */
            uncategorised_channels: components["schemas"]["WorkspaceChannel"][];
        };
        /**
         * WorkspaceInitialisation
         * @description The whole answer of `initialiseWorkspace`. It carries no structure on purpose: the
         *     console reads `getWorkspace` at `Location`, so a replay never returns a channel name.
         * @example {
         *       "state": "initialised"
         *     }
         */
        WorkspaceInitialisation: {
            /** @constant */
            state: "initialised";
        };
        /**
         * WorkspaceState
         * @description `not_initialised` until `initialiseWorkspace` has created the starter workspace,
         *     `initialised` from then on. Closed, because the console renders one screen per member.
         * @example initialised
         * @enum {string}
         */
        WorkspaceState: "not_initialised" | "initialised";
        /**
         * WorkspaceSetup
         * @description The organisation's setup as one product state, derived by Core on every read from its
         *     `realm_create` job, the issuer trust list and the owner's confirmation
         *     (`docs/specs/PILOT_WORKSPACE_ONBOARDING.md` §3). Never stored.
         */
        WorkspaceSetup: {
            state: components["schemas"]["WorkspaceSetupState"];
            /** @description Why `state` is what it is, where the console says something different for it; null otherwise. */
            reason: components["schemas"]["WorkspaceSetupReason"] | null;
        };
        /**
         * WorkspaceSetupState
         * @description `pending`: not started, or waiting on a person; `running`: in progress; `ready`: the
         *     workspace may be initialised and entered; `failed`: stopped, and an operator must act.
         *     Closed, because the console renders one message per member.
         * @example ready
         * @enum {string}
         */
        WorkspaceSetupState: "pending" | "running" | "ready" | "failed";
        /**
         * WorkspaceSetupReason
         * @description `awaiting_owner_confirmation` (with `pending`): the claim is consumed and the intake
         *     recorder has not yet confirmed the owner out of band (the pilot amendment of
         *     `FIRST_OWNER_BOOTSTRAP.md`, §8.7).
         *     `issuer_untrusted` (with `failed`): the organisation's issuer is not in the trust list.
         *     `realm_job_failed` (with `failed`): the realm job failed or was cancelled. Closed, because
         *     the console renders one message per member.
         * @example awaiting_owner_confirmation
         * @enum {string}
         */
        WorkspaceSetupReason: "awaiting_owner_confirmation" | "issuer_untrusted" | "realm_job_failed";
        /** WorkspaceCategory */
        WorkspaceCategory: {
            /** Format: uuid */
            id: string;
            /** @description The stored name, 1–100 characters, not blank. Shown when `template_key` is null or unknown to the console. */
            name: string;
            template_key: components["schemas"]["WorkspaceTemplateKey"];
            /** @description The channels of this category the caller may view, in their stored order. */
            channels: components["schemas"]["WorkspaceChannel"][];
        };
        /** WorkspaceChannel */
        WorkspaceChannel: {
            /** Format: uuid */
            id: string;
            /**
             * @description Fixed when the channel is created. The starter template creates two text channels and one audio room.
             * @enum {string}
             */
            kind: "text" | "audio";
            /** @description The stored name, 1–100 characters, not blank. Shown when `template_key` is null or unknown to the console. */
            name: string;
            template_key: components["schemas"]["WorkspaceTemplateKey"];
            topic: string;
            /**
             * @description Only these two are ever returned; a channel in any other lifecycle is absent.
             * @enum {string}
             */
            lifecycle: "active" | "archived";
            /**
             * @description Whether the channel's Matrix room exists yet. A channel is `active` as soon as Core
             *     commits it; until a tenant agent acknowledges its room, the console shows it as not yet
             *     usable for messages or calls.
             */
            room_state: components["schemas"]["ChannelRoomState"];
        };
        /**
         * WorkspaceTemplateKey
         * @description The stable identifier of a category or channel the starter template created — `general`
         *     and `team` for categories, `welcome`, `general` and `lounge` for channels. Unique within its kind
         *     only: the console's catalogue key is the kind and this value, `category.general` and
         *     `channel.general`, so the two `general` rows have two labels. Null on anything a person
         *     created. An open set: a console that does not know a key shows `name`.
         * @example welcome
         */
        WorkspaceTemplateKey: string | null;
        /**
         * WorkspaceAdministration
         * @description The whole structure of the organisation's workspace, for its owners and admins
         *     (`getWorkspaceAdministration`, `docs/specs/ESPACE_STRUCTURE.md` §7): every category and
         *     every channel that is not deleted, in stored order, unfiltered by channel policy. Never a
         *     message, a file, an occupancy or any room content.
         * @example {
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
         *       "categories": [
         *         {
         *           "id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
         *           "name": "General",
         *           "template_key": "general",
         *           "position": 0,
         *           "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\"",
         *           "channels": [
         *             {
         *               "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
         *               "category_id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
         *               "kind": "text",
         *               "name": "welcome",
         *               "template_key": "welcome",
         *               "topic": "",
         *               "position": 0,
         *               "lifecycle": "active",
         *               "room_state": "pending",
         *               "access": {
         *                 "mode": "inherit"
         *               },
         *               "etag": "\"000000000000000000000000000000000000000000000000000000000000e7aa\""
         *             }
         *           ]
         *         }
         *       ],
         *       "uncategorised_channels": []
         *     }
         */
        WorkspaceAdministration: {
            /** Format: uuid */
            organisation_id: string;
            /**
             * Format: uuid
             * @description The workspace.
             */
            id: string;
            categories: components["schemas"]["WorkspaceAdministrationCategory"][];
            uncategorised_channels: components["schemas"]["WorkspaceAdminChannel"][];
        };
        /**
         * WorkspaceAdministrationCategory
         * @description A category of the administrative read, with every channel it holds.
         */
        WorkspaceAdministrationCategory: {
            /** Format: uuid */
            id: string;
            name: string;
            template_key: components["schemas"]["WorkspaceTemplateKey"];
            position: number;
            /** @description The category's own strong tag, for `If-Match`. */
            etag: string;
            channels: components["schemas"]["WorkspaceAdminChannel"][];
        };
        /**
         * WorkspaceAdminCategory
         * @description A category as its administrators see it. `position` is its index in the workspace's dense
         *     list of categories; `etag` is the tag the `ETag` header carries, covering its id, name,
         *     position, version and `updated_at`.
         * @example {
         *       "id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
         *       "name": "General",
         *       "template_key": "general",
         *       "position": 0,
         *       "etag": "\"000000000000000000000000000000000000000000000000000000000000e7a9\""
         *     }
         */
        WorkspaceAdminCategory: {
            /** Format: uuid */
            id: string;
            name: string;
            template_key: components["schemas"]["WorkspaceTemplateKey"];
            position: number;
            etag: string;
        };
        /**
         * WorkspaceAdminChannel
         * @description A channel as its administrators see it. `position` is its index in its category's dense
         *     list, or in the uncategorised list when `category_id` is null; archived channels hold
         *     their place. `etag` covers its id, category, kind, name, topic, position, lifecycle,
         *     version and `updated_at`, never its access, which has a tag of its own.
         * @example {
         *       "id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
         *       "category_id": "0192f3a4-5b6c-7d8e-9f01-23456789abce",
         *       "kind": "text",
         *       "name": "welcome",
         *       "template_key": "welcome",
         *       "topic": "",
         *       "position": 0,
         *       "lifecycle": "active",
         *       "room_state": "pending",
         *       "access": {
         *         "mode": "inherit"
         *       },
         *       "etag": "\"000000000000000000000000000000000000000000000000000000000000e7aa\""
         *     }
         */
        WorkspaceAdminChannel: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            category_id: string | null;
            /** @enum {string} */
            kind: "text" | "audio";
            name: string;
            template_key: components["schemas"]["WorkspaceTemplateKey"];
            topic: string;
            position: number;
            /**
             * @description The operations write `active` and `archived` only; a deleted channel is absent.
             * @enum {string}
             */
            lifecycle: "provisioning" | "active" | "archived" | "deletion_pending";
            room_state: components["schemas"]["ChannelRoomState"];
            access: {
                mode: components["schemas"]["ChannelAccessMode"];
            };
            etag: string;
        };
        /**
         * ChannelRoomState
         * @description Whether the channel's Matrix room exists yet (`docs/specs/ESPACE_STRUCTURE.md` §5).
         *     `pending`: no tenant agent has yet reported the room as created; `ready`: the room exists;
         *     `failed`: the last attempt reported an error. The console shows a pending or failed
         *     channel as not yet usable for messages or calls. `ready` says nothing of whether the
         *     room's access is current: content waits until the agent has applied the channel's current
         *     access as well.
         *     Closed, because the console renders one state per member.
         * @example pending
         * @enum {string}
         */
        ChannelRoomState: "pending" | "ready" | "failed";
        /**
         * ChannelAccessMode
         * @description `inherit`: the channel follows its category's default policy, else the workspace's;
         *     `explicit`: it has a policy of its own.
         * @example inherit
         * @enum {string}
         */
        ChannelAccessMode: "inherit" | "explicit";
        /**
         * ChannelAccess
         * @description Who may view a channel and what they may do there, as one document
         *     (`docs/specs/ESPACE_STRUCTURE.md` §6). `read_only` denies posting, replying, editing and
         *     uploading in a text channel, and `listen_only` speaking, video and sharing in an audio
         *     room, to `org_member` and `org_billing`; owners and admins are exempt. Reactions, deleting
         *     one's own earlier messages and reading stay allowed.
         * @example {
         *       "channel_id": "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
         *       "mode": "explicit",
         *       "visibility": "restricted",
         *       "allow_members": [
         *         "0192f3a4-5b6c-7d8e-9f01-23456789abe0"
         *       ],
         *       "deny_members": [],
         *       "read_only": true,
         *       "listen_only": false
         *     }
         */
        ChannelAccess: {
            /** Format: uuid */
            channel_id: string;
            mode: components["schemas"]["ChannelAccessMode"];
            /**
             * @description `organisation`: every current member; `restricted`: only `allow_members`.
             * @enum {string}
             */
            visibility: "organisation" | "restricted";
            /** @description Membership ids that may view a restricted channel. */
            allow_members: string[];
            /** @description Membership ids that may never view it; a deny wins over everything. */
            deny_members: string[];
            /** @description Text channels only. */
            read_only: boolean;
            /** @description Audio rooms only. */
            listen_only: boolean;
        };
        /**
         * ChannelAccessPatchRequest
         * @description The whole access of `ChannelAccess` but `channel_id`: every member is present, so the
         *     document replaces the access rather than merging into it. With `mode` `inherit`, the other
         *     members must equal the resolved policy's.
         */
        ChannelAccessPatchRequest: {
            mode: components["schemas"]["ChannelAccessMode"];
            /** @enum {string} */
            visibility: "organisation" | "restricted";
            allow_members: string[];
            deny_members: string[];
            read_only: boolean;
            listen_only: boolean;
        };
        /** CategoryCreateRequest */
        CategoryCreateRequest: {
            /** @description 1–100 characters, not blank. */
            name: string;
            /** @description Where to insert it; omitted, it is appended. Beyond the end is `422`. */
            position?: number;
        };
        /**
         * CategoryPatchRequest
         * @description JSON merge patch (RFC 7386); absent members are unchanged.
         */
        CategoryPatchRequest: {
            name?: string;
            position?: number;
        };
        /** ChannelCreateRequest */
        ChannelCreateRequest: {
            /**
             * Format: uuid
             * @description A category of this workspace, or null for the uncategorised list.
             */
            category_id: string | null;
            /** @enum {string} */
            kind: "text" | "audio";
            name: string;
            /** @default  */
            topic: string;
            position?: number;
        };
        /**
         * ChannelPatchRequest
         * @description JSON merge patch (RFC 7386); absent members are unchanged, and a null `category_id` moves
         *     the channel to the uncategorised list. `kind` is not a member: it never changes.
         */
        ChannelPatchRequest: {
            name?: string;
            topic?: string;
            /** Format: uuid */
            category_id?: string | null;
            position?: number;
        };
        /**
         * Membership
         * @description One person in one organisation, with the role that Keycloak groups mirror.
         *
         *     Directory privacy. Five members are the person's private member facts: `email`,
         *     `identity_id`, `account_kind`, `mfa_enrolled` and `last_seen_at`. On `listMemberships` and
         *     on `getMembership` alike, Core discloses them on a row only to a caller who, in this
         *     organisation,
         *
         *     - is the person the row describes (the caller reads their own membership), or
         *     - holds `org_owner` or `org_admin`.
         *
         *     From every other caller these reads admit, an `org_member` reading a colleague's row
         *     included, Core withholds all five: `email`, `identity_id` and `last_seen_at` are omitted or
         *     `null`, and `account_kind` and `mfa_enrolled`, which have no `null`, are omitted. A
         *     withheld fact is never replaced by a placeholder, a masked value or a partial one, and a
         *     client treats omitted and `null` alike. The rule is applied row by row, so one page can
         *     carry the caller's own row in full beside colleagues' rows without these facts.
         *
         *     `id`, `organisation_id`, `person_id`, `display_name`, `role`, `state`, `source`,
         *     `created_at` and `updated_at` are not private: `display_name` is the name the person chose
         *     for colleagues to see. A withheld fact says nothing about the person: a client never reads
         *     a missing `email` as no address, a missing `mfa_enrolled` as no enrolled factor or a
         *     missing `last_seen_at` as never signed in, and never derives a row's label from one.
         *
         *     Directory privacy governs the two reads only. `acceptInvitation` and `consumeOwnerClaim`
         *     answer the caller's own membership, and `changeMembershipRole` answers an administrator:
         *     none of them withholds a fact. The answer of `removeMembership` carries no contact fields
         *     for anyone.
         * @example {
         *       "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "person_id": "11111111-2222-4333-8444-555555555555",
         *       "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *       "email": "julie@acme.fr",
         *       "display_name": "Julie Marchand",
         *       "role": "org_admin",
         *       "state": "active",
         *       "source": "invitation",
         *       "account_kind": "hosted",
         *       "mfa_enrolled": true,
         *       "last_seen_at": "2026-12-01T08:41:12Z",
         *       "created_at": "2026-11-04T14:02:00Z",
         *       "updated_at": "2026-12-01T08:41:12Z"
         *     }
         */
        Membership: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            /**
             * Format: uuid
             * @description Null while the invitation is not accepted.
             */
            person_id?: string | null;
            /**
             * Format: uuid
             * @description Which identity signs the person in. A private member fact (directory privacy, above); omitted or `null` when withheld.
             */
            identity_id?: string | null;
            /**
             * Format: email
             * @description The person's contact address. A private member fact (directory privacy, above): on `listMemberships` and `getMembership` it is disclosed on the caller's own row and to a caller who holds `org_owner` or `org_admin`, and is omitted or `null` for every other caller, never masked or partial.
             */
            email?: string | null;
            display_name?: string | null;
            role: components["schemas"]["OrganisationRole"];
            state: components["schemas"]["MembershipState"];
            /**
             * @description How the person got in. Feeds the audit trail and the enrolment KPIs. `owner_claim` is the first owner, created by `consumeOwnerClaim` and by nothing else.
             * @enum {string}
             */
            source?: "invitation" | "enrolment_token" | "federation" | "order" | "staff" | "owner_claim";
            account_kind?: components["schemas"]["MembershipAccountKind"];
            /** @description A private member fact (directory privacy, above); omitted when withheld or unknown. */
            mfa_enrolled?: boolean;
            /**
             * Format: date-time
             * @description A private member fact (directory privacy, above); omitted or `null` when withheld or unknown.
             */
            last_seen_at?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * MembershipPatchRequest
         * @example {
         *       "role": "org_admin"
         *     }
         */
        MembershipPatchRequest: {
            role?: components["schemas"]["OrganisationRole"];
            /**
             * @description Suspending keeps the row and ends the person's Core access on their next request; `active` reactivates it. The realm account is a separate delivery of the realm worker.
             * @enum {string}
             */
            state?: "active" | "suspended";
        };
        /**
         * InvitationState
         * @example pending
         * @enum {string}
         */
        InvitationState: "pending" | "accepted" | "revoked" | "expired";
        /**
         * Invitation
         * @description An email invitation into an organisation. The token itself is never returned by the API
         *     after creation; it exists only in the email, and is stored as an HMAC fingerprint.
         * @example {
         *       "id": "5d4c3b2a-1908-4776-8564-3a2b1c0d9e8f",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "email": "marc@acme.fr",
         *       "role": "org_member",
         *       "state": "pending",
         *       "realm": "acme-sa",
         *       "invited_by": "11111111-2222-4333-8444-555555555555",
         *       "expires_at": "2026-12-08T09:00:00Z",
         *       "accepted_at": null,
         *       "membership_id": null,
         *       "sent_count": 1,
         *       "last_sent_at": "2026-12-01T09:00:00Z",
         *       "created_at": "2026-12-01T09:00:00Z"
         *     }
         */
        Invitation: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            /** Format: email */
            email: string;
            role: components["schemas"]["InvitationRole"];
            state: components["schemas"]["InvitationState"];
            /** @description The realm the invitee must authenticate against. */
            realm?: string;
            /** Format: uuid */
            invited_by?: string;
            /** Format: date-time */
            expires_at: string;
            /** Format: date-time */
            accepted_at?: string | null;
            /** Format: uuid */
            membership_id?: string | null;
            /** @description How many times the mail has been sent. A resend keeps the same token. */
            sent_count?: number;
            /** Format: date-time */
            last_sent_at?: string | null;
            /** Format: date-time */
            created_at: string;
        };
        /**
         * InvitationBatchRequest
         * @description Between 1 and 500 invitations. Member-import execution invokes the same service.
         * @example {
         *       "invitations": [
         *         {
         *           "email": "marc@acme.fr",
         *           "role": "org_member",
         *           "display_name": "Marc Dubois"
         *         },
         *         {
         *           "email": "julie@acme.fr",
         *           "role": "org_admin",
         *           "display_name": "Julie Marchand"
         *         }
         *       ],
         *       "send_email": true,
         *       "locale": "fr"
         *     }
         */
        InvitationBatchRequest: {
            invitations: {
                /** Format: email */
                email: string;
                role: components["schemas"]["InvitationRole"];
                display_name?: string | null;
            }[];
            /**
             * @description False creates the invitations without sending, for an admin who will share links themselves.
             * @default true
             */
            send_email: boolean;
            /**
             * @description Language of the invitation email. Defaults to the organisation locale.
             * @enum {string}
             */
            locale?: "fr" | "en";
        };
        /**
         * InvitationBatchResult
         * @description One result per submitted row, in submission order. `created` counts new invitations,
         *     `skipped` counts rows that were already members or already invited. A batch never fails
         *     halfway: either the whole call is refused, or every row has an outcome.
         * @example {
         *       "created": 1,
         *       "skipped": 1,
         *       "failed": 0,
         *       "seats_used_after": 118,
         *       "seats_included": 150,
         *       "results": [
         *         {
         *           "email": "marc@acme.fr",
         *           "outcome": "created",
         *           "invitation": null,
         *           "detail": null
         *         },
         *         {
         *           "email": "julie@acme.fr",
         *           "outcome": "already_member",
         *           "invitation": null,
         *           "detail": "Already an admin of this organisation."
         *         }
         *       ]
         *     }
         */
        InvitationBatchResult: {
            created: number;
            skipped: number;
            failed: number;
            seats_used_after?: number;
            seats_included?: number;
            results: {
                /** Format: email */
                email: string;
                /** @enum {string} */
                outcome: "created" | "already_member" | "already_invited" | "invalid_email" | "failed";
                invitation?: components["schemas"]["Invitation"] | null;
                detail?: string | null;
            }[];
        };
        /**
         * InvitationAcceptRequest
         * @example {
         *       "token": "inv_EXAMPLE0000000000000000000000000000000",
         *       "display_name": "Marc Dubois"
         *     }
         */
        InvitationAcceptRequest: {
            /** @description The opaque token from the invitation link. Single use, compared in constant time. */
            token: string;
            display_name?: string | null;
        };
        /**
         * InvitationPreviewRequest
         * @example {
         *       "token": "inv_EXAMPLE0000000000000000000000000000000"
         *     }
         */
        InvitationPreviewRequest: {
            /** @description The opaque token from the invitation link, as `acceptInvitation` takes it. Reading the preview does not spend it. */
            token: string;
        };
        /**
         * InvitationPreview
         * @description The invitation card, read by the invited account before it accepts. Display names only:
         *     no identifier, no address and no state.
         * @example {
         *       "organisation_name": "Acme",
         *       "inviter_display_name": "Julie Martin",
         *       "role": "org_member",
         *       "expires_at": "2026-11-20T09:30:00.000Z"
         *     }
         */
        InvitationPreview: {
            /** @description The organisation's display name. */
            organisation_name: string;
            /**
             * @description The display name of the person who sent the invitation; `null` when they set none or
             *     their person has since been deleted. Never their address.
             */
            inviter_display_name: string | null;
            role: components["schemas"]["InvitationRole"];
            /**
             * Format: date-time
             * @description When the invitation lapses; past it, the preview and acceptance are `410 invitation-expired`.
             */
            expires_at: string;
        };
        /**
         * EnrolmentTokenState
         * @example active
         * @enum {string}
         */
        EnrolmentTokenState: "active" | "exhausted" | "revoked" | "expired";
        /**
         * EnrolmentToken
         * @description A one-time on-site enrolment token, shown as a QR code. It creates accounts in the tenant
         *     realm with a fixed role, bounded by `max_uses` and by `expires_at`. The secret is not
         *     stored and is never listed.
         * @example {
         *       "id": "2f3e4d5c-6b7a-4980-8172-635445362718",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "label": "Welcome day, room B",
         *       "role": "org_member",
         *       "state": "active",
         *       "max_uses": 120,
         *       "uses": 37,
         *       "require_email_domain": "acme.fr",
         *       "fingerprint": "4a1b2c3d4e5f6071",
         *       "expires_at": "2026-12-02T18:00:00Z",
         *       "created_by": "11111111-2222-4333-8444-555555555555",
         *       "created_at": "2026-12-01T09:30:00Z",
         *       "revoked_at": null
         *     }
         */
        EnrolmentToken: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            /** Format: uuid */
            tenant_id?: string | null;
            /** @example Journée d'accueil, salle B */
            label?: string | null;
            role: components["schemas"]["EnrolmentRole"];
            state: components["schemas"]["EnrolmentTokenState"];
            max_uses: number;
            uses: number;
            /** @description When set, only an email in this domain may redeem the token. */
            require_email_domain?: string | null;
            /** @description HMAC fingerprint of the secret, for support to match a scanned code. */
            fingerprint?: string;
            /** Format: date-time */
            expires_at: string;
            /** Format: uuid */
            created_by?: string;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            revoked_at?: string | null;
        };
        /**
         * EnrolmentTokenCreateRequest
         * @example {
         *       "role": "org_member",
         *       "max_uses": 120,
         *       "expires_at": "2026-12-02T18:00:00Z",
         *       "label": "Welcome day, room B",
         *       "require_email_domain": "acme.fr"
         *     }
         */
        EnrolmentTokenCreateRequest: {
            role: components["schemas"]["EnrolmentRole"];
            max_uses: number;
            /**
             * Format: date-time
             * @description At most 24 hours ahead. An on-site token that outlives the day is a liability.
             */
            expires_at: string;
            label?: string | null;
            require_email_domain?: string | null;
            /** Format: uuid */
            tenant_id?: string | null;
        };
        /**
         * @example {
         *       "id": "2f3e4d5c-6b7a-4980-8172-635445362718",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "label": "Welcome day, room B",
         *       "role": "org_member",
         *       "state": "active",
         *       "max_uses": 120,
         *       "uses": 0,
         *       "require_email_domain": "acme.fr",
         *       "fingerprint": "4a1b2c3d4e5f6071",
         *       "expires_at": "2026-12-02T18:00:00Z",
         *       "created_by": "11111111-2222-4333-8444-555555555555",
         *       "created_at": "2026-12-01T09:30:00Z",
         *       "revoked_at": null,
         *       "secret": "enr_EXAMPLE00000000000000000000000",
         *       "enrolment_url": "https://app.kodera.io/enrol#enr_EXAMPLE00000000000000000000000",
         *       "qr_svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 33 33\"></svg>"
         *     }
         */
        EnrolmentTokenCreated: components["schemas"]["EnrolmentToken"] & {
            /** @description The one-time secret. Not stored in clear. Do not log. */
            secret: string;
            /**
             * Format: uri
             * @description What the QR code encodes.
             */
            enrolment_url: string;
            /** @description SVG of the QR code, ready to project. */
            qr_svg: string;
        };
        /**
         * AppCode
         * @description An application of the suite, as named in the tenant profile catalogue.
         *     `messaging` is the Espace's live text channels and audio rooms (ADR-0018); it replaced
         *     `tchap` in 0.22.0.
         * @example visio
         * @enum {string}
         */
        AppCode: "visio" | "docs" | "drive" | "messaging" | "grist";
        /**
         * BillingPeriod
         * @example yearly
         * @enum {string}
         */
        BillingPeriod: "monthly" | "yearly";
        /**
         * VatRegime
         * @description Decided from the organisation's country and VAT number at order time and snapshotted, so
         *     an old invoice never changes when the rules do.
         * @example fr_standard
         * @enum {string}
         */
        VatRegime: "fr_standard" | "eu_reverse_charge" | "exempt" | "outside_eu";
        /**
         * Plan
         * @description The commercial envelope, versioned. A price is always read through a plan version so an
         *     order can snapshot exactly what the customer saw.
         * @example {
         *       "code": "essentiel",
         *       "version": 3,
         *       "name": "Essentiel",
         *       "description": "Visio and Docs for an organisation that wants one login and hosting in the European Union.",
         *       "state": "published",
         *       "packs": [
         *         "visio",
         *         "visio-docs"
         *       ],
         *       "support_tier": "standard",
         *       "published_at": "2026-11-15T00:00:00Z",
         *       "retired_at": null
         *     }
         */
        Plan: {
            /** @example essentiel */
            code: string;
            version: number;
            name: string;
            description?: string | null;
            /** @enum {string} */
            state: "draft" | "published" | "retired";
            packs: string[];
            /**
             * @description Drives the SLA on a support ticket.
             * @enum {string}
             */
            support_tier?: "standard" | "business" | "critical";
            /** Format: date-time */
            published_at?: string | null;
            /** Format: date-time */
            retired_at?: string | null;
        };
        /**
         * Pack
         * @description The set of applications provisioned on a tenant, and the profile that renders them.
         * @example {
         *       "code": "visio-docs",
         *       "name": "Visio + Docs",
         *       "description": "Video meetings and collaborative documents on one tenant, one login.",
         *       "apps": [
         *         "visio",
         *         "docs"
         *       ],
         *       "profile_ref": "visio-docs/1.4",
         *       "capacity_tier_codes": [
         *         "S",
         *         "M",
         *         "L"
         *       ],
         *       "available": true
         *     }
         */
        Pack: {
            /** @example visio-docs */
            code: string;
            name: string;
            description?: string | null;
            apps: components["schemas"]["AppCode"][];
            /**
             * @description Tenant profile as `<app>/<version>`, vendored by commit SHA at provisioning.
             * @example visio-docs/1.4
             */
            profile_ref?: string;
            capacity_tier_codes?: string[];
            /** @default true */
            available: boolean;
        };
        /**
         * CapacityTier
         * @description The VM shape and the included capacity. Rendered into the tenant profile as
         *     `x-kodera.tiers.<code>` by the provisioning job, and the reference the capacity gauge
         *     measures against.
         * @example {
         *       "code": "M",
         *       "name": "Moyen",
         *       "description": "Up to 150 people, 50 in one meeting.",
         *       "seats_included": 150,
         *       "concurrent_participants_included": 50,
         *       "storage_included_bytes": 536870912000,
         *       "vm_shape": "PRO2-M",
         *       "media_ip_dedicated": true,
         *       "available": true
         *     }
         */
        CapacityTier: {
            /**
             * @description The same four values as `Tenant.capacity_tier` and `Plan.capacity_tier` in `docs/domain/MODEL.md`. A tier that exists and is not on sale carries `available: false`; the enum is the model, not the price list.
             * @enum {string}
             */
            code: "S" | "M" | "L" | "XL";
            name: string;
            description?: string | null;
            seats_included: number;
            concurrent_participants_included: number;
            /** Format: int64 */
            storage_included_bytes: number;
            /** @description Scaleway instance type. Staff-facing. */
            vm_shape?: string;
            /** @description Every tier has a dedicated media IP at launch. */
            media_ip_dedicated?: boolean;
            /** @default true */
            available: boolean;
        };
        /**
         * Price
         * @description Immutable once published. A change is a new row with a new `valid_from`; the old row stays
         *     so an invoice can always be reconstructed from what was shown.
         * @example {
         *       "id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
         *       "plan_code": "essentiel",
         *       "plan_version": 3,
         *       "pack_code": "visio-docs",
         *       "capacity_tier_code": "M",
         *       "billing_period": "yearly",
         *       "amount_excl_vat": {
         *         "amount_minor": 448800,
         *         "currency": "EUR"
         *       },
         *       "setup_fee_excl_vat": null,
         *       "valid_from": "2026-11-15T00:00:00Z",
         *       "valid_to": null
         *     }
         */
        Price: {
            /** Format: uuid */
            id: string;
            plan_code: string;
            plan_version: number;
            pack_code: string;
            capacity_tier_code: string;
            billing_period: components["schemas"]["BillingPeriod"];
            amount_excl_vat: components["schemas"]["Money"];
            setup_fee_excl_vat?: components["schemas"]["Money"] | null;
            /** Format: date-time */
            valid_from: string;
            /** Format: date-time */
            valid_to?: string | null;
        };
        /**
         * PriceSnapshot
         * @description The price as it was at order time, copied onto the subscription and every invoice line.
         *     Nothing here is ever recomputed from the catalog afterwards.
         * @example {
         *       "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
         *       "plan_code": "essentiel",
         *       "plan_version": 3,
         *       "pack_code": "visio-docs",
         *       "capacity_tier_code": "M",
         *       "billing_period": "yearly",
         *       "unit_amount_excl_vat": {
         *         "amount_minor": 448800,
         *         "currency": "EUR"
         *       },
         *       "quantity": 1,
         *       "vat_regime": "fr_standard",
         *       "vat_rate_bp": 2000,
         *       "total_excl_vat": {
         *         "amount_minor": 448800,
         *         "currency": "EUR"
         *       },
         *       "vat_amount": {
         *         "amount_minor": 89760,
         *         "currency": "EUR"
         *       },
         *       "total_incl_vat": {
         *         "amount_minor": 538560,
         *         "currency": "EUR"
         *       },
         *       "captured_at": "2026-12-01T09:41:07Z"
         *     }
         */
        PriceSnapshot: {
            /** Format: uuid */
            price_id: string;
            plan_code: string;
            plan_version: number;
            pack_code: string;
            capacity_tier_code: string;
            billing_period: components["schemas"]["BillingPeriod"];
            unit_amount_excl_vat: components["schemas"]["Money"];
            /** @default 1 */
            quantity: number;
            vat_regime: components["schemas"]["VatRegime"];
            /** @description VAT rate in basis points. 2000 is 20,00 percent. Zero under reverse charge. */
            vat_rate_bp: number;
            total_excl_vat: components["schemas"]["Money"];
            vat_amount: components["schemas"]["Money"];
            total_incl_vat: components["schemas"]["Money"];
            /** Format: date-time */
            captured_at?: string;
        };
        /**
         * OrderState
         * @description `placed` is written in the same transaction as the subscription and the invoice.
         *     `awaiting_payment` once the payment link exists, `paid` on the payment webhook,
         *     `fulfilled` once the tenant reaches `active`.
         * @example awaiting_payment
         * @enum {string}
         */
        OrderState: "placed" | "awaiting_payment" | "paid" | "provisioning" | "fulfilled" | "cancelled";
        /**
         * OrderRequest
         * @description Everything the Order screen collects. The DPA acceptance is part of the order, not a step
         *     after it: no processing begins before it is recorded.
         * @example {
         *       "pack_code": "visio-docs",
         *       "capacity_tier_code": "M",
         *       "billing_period": "yearly",
         *       "plan_code": "essentiel",
         *       "tenant": {
         *         "slug": "acme",
         *         "name": "ACME",
         *         "locale": "fr"
         *       },
         *       "dpa_acceptance": {
         *         "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
         *         "accepted": true,
         *         "accepted_by_name": "Julie Marchand",
         *         "accepted_by_role": "Présidente"
         *       },
         *       "legal_acceptances": [
         *         {
         *           "code": "cgv",
         *           "version": "2026.11",
         *           "locale": "fr"
         *         },
         *         {
         *           "code": "sla",
         *           "version": "2026.11",
         *           "locale": "fr"
         *         }
         *       ],
         *       "billing_contact": {
         *         "email": "compta@acme.fr",
         *         "name": "Service comptabilité",
         *         "purchase_order_ref": "BC-2026-118"
         *       },
         *       "notes": null
         *     }
         */
        OrderRequest: {
            pack_code: string;
            capacity_tier_code: string;
            billing_period: components["schemas"]["BillingPeriod"];
            /** @description Optional; the published plan offering this pack and tier is used when absent. */
            plan_code?: string | null;
            /**
             * @description The tenant this order creates. `slug` is the tenant's DNS label and its Scaleway project
             *     name, and names its OpenTofu state file. The tenant authenticates against its
             *     organisation's realm, which the order does not create.
             */
            tenant: {
                slug: string;
                name: string;
                /**
                 * @default fr
                 * @enum {string}
                 */
                locale: "fr" | "en";
            };
            /**
             * @description Names the DPA generated for this organisation and the person who accepts it. The API
             *     records the acceptance itself, with the server's clock, the client IP and the user
             *     agent; a client-supplied timestamp is ignored.
             */
            dpa_acceptance: {
                /** Format: uuid */
                dpa_id: string;
                /** @constant */
                accepted: true;
                accepted_by_name?: string;
                /** @example Président */
                accepted_by_role?: string;
            };
            /**
             * @description The documents the Order screen showed and the customer accepts with the order, each at
             *     the version shown (from `listLegalDocuments`). The CGV is required; the SLA and the
             *     acceptable use policy are recorded when shown. Each must be the version in force for
             *     its locale and the pack, or the order is refused with `validation-error`, the entry's
             *     `code` naming the document (`cgv_not_in_force`) and its `detail` the version in force.
             *     The DPA is accepted through `dpa_acceptance`, never here.
             */
            legal_acceptances: components["schemas"]["LegalAcceptance"][];
            /** @description Overrides the organisation's billing members for this order only. */
            billing_contact?: {
                /** Format: email */
                email?: string;
                name?: string | null;
                purchase_order_ref?: string | null;
            };
            /** @description Free text for the operator who provisions. */
            notes?: string | null;
        };
        /**
         * LegalAcceptance
         * @description One published document accepted with an order, named as `listLegalDocuments` returns it.
         * @example {
         *       "code": "cgv",
         *       "version": "2026.11",
         *       "locale": "fr"
         *     }
         */
        LegalAcceptance: {
            /** @enum {string} */
            code: "cgv" | "sla" | "aup";
            version: string;
            /** @enum {string} */
            locale: "fr" | "en";
        };
        /**
         * TenantCreation
         * @description What « Créez votre espace » collects (`createTenant`): the workspace's name and address,
         *     and the CGV and the DPA, each at the version shown. There is no pack, tier, period or
         *     billing detail: the deployment does not bill.
         * @example {
         *       "name": "ACME",
         *       "slug": "acme",
         *       "locale": "fr",
         *       "legal_acceptances": [
         *         {
         *           "code": "cgv",
         *           "version": "2026.11",
         *           "locale": "fr"
         *         },
         *         {
         *           "code": "dpa",
         *           "version": "2026.11",
         *           "locale": "fr"
         *         }
         *       ]
         *     }
         */
        TenantCreation: {
            /** @description Not blank, and without control, format, private-use, surrogate or unassigned characters (Unicode category C), or line and paragraph separators; a no-break space is allowed. */
            name: string;
            /** @description The tenant's DNS label and its Matrix server name. It never changes. */
            slug: string;
            /**
             * @default fr
             * @enum {string}
             */
            locale: "fr" | "en";
            /** @description The CGV and the DPA, once each. */
            legal_acceptances: components["schemas"]["WorkspaceAgreement"][];
        };
        /**
         * WorkspaceAgreement
         * @description One document accepted with `createTenant`, named as `listLegalDocuments` returns it.
         * @example {
         *       "code": "dpa",
         *       "version": "2026.11",
         *       "locale": "fr"
         *     }
         */
        WorkspaceAgreement: {
            /** @enum {string} */
            code: "cgv" | "dpa";
            version: string;
            /** @enum {string} */
            locale: "fr" | "en";
        };
        /**
         * TenantCreated
         * @description What `createTenant` created; the console then reads `getWorkspace`.
         * @example {
         *       "tenant": {
         *         "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "slug": "acme",
         *         "name": "ACME",
         *         "status": "ordered",
         *         "status_changed_at": "2026-12-02T16:04:00Z",
         *         "pack_code": "workspace",
         *         "capacity_tier_code": "S",
         *         "apps": [
         *           "visio",
         *           "messaging"
         *         ],
         *         "region": "fr-par",
         *         "realm": "acme-sa",
         *         "profile_ref": "workspace/1.0",
         *         "locale": "fr",
         *         "created_at": "2026-12-02T16:04:00Z",
         *         "updated_at": "2026-12-02T16:04:00Z"
         *       },
         *       "workspace_id": "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
         *     }
         */
        TenantCreated: {
            tenant: components["schemas"]["Tenant"];
            /** Format: uuid */
            workspace_id: string;
        };
        /**
         * Order
         * @example {
         *       "id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "state": "awaiting_payment",
         *       "pack_code": "visio-docs",
         *       "capacity_tier_code": "M",
         *       "apps": [
         *         "visio",
         *         "docs"
         *       ],
         *       "billing_period": "yearly",
         *       "price_snapshot": {
         *         "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
         *         "plan_code": "essentiel",
         *         "plan_version": 3,
         *         "pack_code": "visio-docs",
         *         "capacity_tier_code": "M",
         *         "billing_period": "yearly",
         *         "unit_amount_excl_vat": {
         *           "amount_minor": 448800,
         *           "currency": "EUR"
         *         },
         *         "quantity": 1,
         *         "vat_regime": "fr_standard",
         *         "vat_rate_bp": 2000,
         *         "total_excl_vat": {
         *           "amount_minor": 448800,
         *           "currency": "EUR"
         *         },
         *         "vat_amount": {
         *           "amount_minor": 89760,
         *           "currency": "EUR"
         *         },
         *         "total_incl_vat": {
         *           "amount_minor": 538560,
         *           "currency": "EUR"
         *         },
         *         "captured_at": "2026-12-01T09:41:07Z"
         *       },
         *       "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
         *       "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
         *       "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "purchase_order_ref": "BC-2026-118",
         *       "placed_by": "11111111-2222-4333-8444-555555555555",
         *       "created_at": "2026-12-01T09:41:07Z",
         *       "updated_at": "2026-12-01T09:41:09Z"
         *     }
         */
        Order: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            state: components["schemas"]["OrderState"];
            pack_code: string;
            capacity_tier_code: string;
            apps?: components["schemas"]["AppCode"][];
            billing_period: components["schemas"]["BillingPeriod"];
            price_snapshot: components["schemas"]["PriceSnapshot"];
            /** Format: uuid */
            dpa_id?: string;
            /** Format: uuid */
            subscription_id?: string | null;
            /** Format: uuid */
            invoice_id?: string | null;
            /** Format: uuid */
            tenant_id?: string | null;
            purchase_order_ref?: string | null;
            /** Format: uuid */
            placed_by?: string;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * OrderResult
         * @description Everything the single order transaction produced. The invoice is issued in that
         *     transaction; `payment_link` is `null` while the payment provider has not answered, which
         *     `billing_pending` says, and the console renders "payment link on its way" rather than an
         *     error. The tenant is returned in status
         *     `ordered`: provisioning has not started.
         * @example {
         *       "order": {
         *         "id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "state": "awaiting_payment",
         *         "pack_code": "visio-docs",
         *         "capacity_tier_code": "M",
         *         "apps": [
         *           "visio",
         *           "docs"
         *         ],
         *         "billing_period": "yearly",
         *         "price_snapshot": {
         *           "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
         *           "plan_code": "essentiel",
         *           "plan_version": 3,
         *           "pack_code": "visio-docs",
         *           "capacity_tier_code": "M",
         *           "billing_period": "yearly",
         *           "unit_amount_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "quantity": 1,
         *           "vat_regime": "fr_standard",
         *           "vat_rate_bp": 2000,
         *           "total_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "vat_amount": {
         *             "amount_minor": 89760,
         *             "currency": "EUR"
         *           },
         *           "total_incl_vat": {
         *             "amount_minor": 538560,
         *             "currency": "EUR"
         *           },
         *           "captured_at": "2026-12-01T09:41:07Z"
         *         },
         *         "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
         *         "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
         *         "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *         "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *         "purchase_order_ref": "BC-2026-118",
         *         "placed_by": "11111111-2222-4333-8444-555555555555",
         *         "created_at": "2026-12-01T09:41:07Z",
         *         "updated_at": "2026-12-01T09:41:09Z"
         *       },
         *       "subscription": {
         *         "id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *         "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
         *         "state": "active",
         *         "plan_code": "essentiel",
         *         "plan_version": 3,
         *         "pack_code": "visio-docs",
         *         "capacity_tier_code": "M",
         *         "billing_period": "yearly",
         *         "price_snapshot": {
         *           "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
         *           "plan_code": "essentiel",
         *           "plan_version": 3,
         *           "pack_code": "visio-docs",
         *           "capacity_tier_code": "M",
         *           "billing_period": "yearly",
         *           "unit_amount_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "quantity": 1,
         *           "vat_regime": "fr_standard",
         *           "vat_rate_bp": 2000,
         *           "total_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "vat_amount": {
         *             "amount_minor": 89760,
         *             "currency": "EUR"
         *           },
         *           "total_incl_vat": {
         *             "amount_minor": 538560,
         *             "currency": "EUR"
         *           },
         *           "captured_at": "2026-12-01T09:41:07Z"
         *         },
         *         "current_period_start": "2026-12-01T00:00:00Z",
         *         "current_period_end": "2027-12-01T00:00:00Z",
         *         "cancel_at_period_end": false,
         *         "cancelled_at": null,
         *         "next_invoice_at": "2027-12-01T00:00:00Z",
         *         "price_change_notice_days": 90,
         *         "created_at": "2026-12-01T09:41:07Z",
         *         "updated_at": "2026-12-03T11:20:00Z"
         *       },
         *       "tenant": {
         *         "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "slug": "acme",
         *         "name": "ACME",
         *         "status": "ordered",
         *         "status_changed_at": "2026-12-01T09:41:07Z",
         *         "pack_code": "visio-docs",
         *         "capacity_tier_code": "M",
         *         "apps": [
         *           "visio",
         *           "docs"
         *         ],
         *         "region": "fr-par",
         *         "realm": null,
         *         "profile_ref": null,
         *         "profile_commit": null,
         *         "instance_id": null,
         *         "default_urls": {},
         *         "observed": {
         *           "last_heartbeat_at": null,
         *           "heartbeat_seq": null,
         *           "stale": false,
         *           "agent_version": null,
         *           "profile": null,
         *           "drift_detected_at": null,
         *           "drift_summary": null,
         *           "maintenance": false
         *         },
         *         "locale": "fr",
         *         "created_at": "2026-12-01T09:41:07Z",
         *         "updated_at": "2026-12-01T09:41:07Z"
         *       },
         *       "invoice": {
         *         "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
         *         "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
         *         "number": "INV-2026-0142",
         *         "state": "issued",
         *         "currency": "EUR",
         *         "vat_regime": "fr_standard",
         *         "lines": [
         *           {
         *             "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
         *             "quantity": 1,
         *             "unit_amount_excl_vat": {
         *               "amount_minor": 448800,
         *               "currency": "EUR"
         *             },
         *             "total_excl_vat": {
         *               "amount_minor": 448800,
         *               "currency": "EUR"
         *             },
         *             "vat_rate_bp": 2000,
         *             "period_start": "2026-12-01T00:00:00Z",
         *             "period_end": "2027-12-01T00:00:00Z"
         *           }
         *         ],
         *         "total_excl_vat": {
         *           "amount_minor": 448800,
         *           "currency": "EUR"
         *         },
         *         "vat_amount": {
         *           "amount_minor": 89760,
         *           "currency": "EUR"
         *         },
         *         "total_incl_vat": {
         *           "amount_minor": 538560,
         *           "currency": "EUR"
         *         },
         *         "amount_due": {
         *           "amount_minor": 538560,
         *           "currency": "EUR"
         *         },
         *         "issued_at": "2026-12-01T09:42:00Z",
         *         "due_at": "2026-12-31T23:59:59Z",
         *         "paid_at": null,
         *         "pdf_available": true,
         *         "external_ref": "inv_ext_9RJ2K",
         *         "created_at": "2026-12-01T09:41:07Z",
         *         "updated_at": "2026-12-01T09:42:00Z"
         *       },
         *       "payment_link": {
         *         "id": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081",
         *         "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *         "provider": "stripe",
         *         "url": "https://pay.example.invalid/xJ8kQ2mR7t",
         *         "state": "active",
         *         "amount": {
         *           "amount_minor": 538560,
         *           "currency": "EUR"
         *         },
         *         "expires_at": "2026-12-31T23:59:59Z",
         *         "used_at": null,
         *         "created_at": "2026-12-01T09:42:05Z"
         *       },
         *       "dpa": {
         *         "id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
         *         "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *         "tenant_id": null,
         *         "version": "2026.11",
         *         "state": "accepted",
         *         "locale": "fr",
         *         "pack_code": "visio-docs",
         *         "sha256": "0000000000000000000000000000000000000000000000000000000000000d9a",
         *         "sub_processors": [
         *           {
         *             "name": "Scaleway",
         *             "role": "Hosting and infrastructure",
         *             "location": "Paris",
         *             "country": "FR"
         *           }
         *         ],
         *         "annexes": [
         *           "A",
         *           "B",
         *           "C",
         *           "D"
         *         ],
         *         "generated_at": "2026-12-01T09:38:00Z",
         *         "accepted_at": "2026-12-01T09:40:52Z",
         *         "accepted_by": {
         *           "person_id": "11111111-2222-4333-8444-555555555555",
         *           "name": "Julie Marchand",
         *           "email": "julie@acme.fr",
         *           "role_title": "Présidente"
         *         },
         *         "superseded_by": null
         *       },
         *       "billing_pending": false
         *     }
         */
        OrderResult: {
            order: components["schemas"]["Order"];
            subscription: components["schemas"]["Subscription"];
            tenant: components["schemas"]["Tenant"];
            invoice?: components["schemas"]["Invoice"] | null;
            payment_link?: components["schemas"]["PaymentLink"] | null;
            dpa?: components["schemas"]["Dpa"];
            /** @description True when the invoice or the payment link is still being created upstream. */
            billing_pending: boolean;
        };
        /**
         * SubscriptionState
         * @description `pending` until the first invoice is paid, `past_due` after the due date, `suspended` when
         *     the suspend job has run. Recurring collection arrives with the subscription engine; at
         *     launch the state moves on invoice events and operator action.
         * @example active
         * @enum {string}
         */
        SubscriptionState: "pending" | "active" | "past_due" | "suspended" | "cancelled";
        /**
         * Subscription
         * @example {
         *       "id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
         *       "state": "active",
         *       "plan_code": "essentiel",
         *       "plan_version": 3,
         *       "pack_code": "visio-docs",
         *       "capacity_tier_code": "M",
         *       "billing_period": "yearly",
         *       "price_snapshot": {
         *         "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
         *         "plan_code": "essentiel",
         *         "plan_version": 3,
         *         "pack_code": "visio-docs",
         *         "capacity_tier_code": "M",
         *         "billing_period": "yearly",
         *         "unit_amount_excl_vat": {
         *           "amount_minor": 448800,
         *           "currency": "EUR"
         *         },
         *         "quantity": 1,
         *         "vat_regime": "fr_standard",
         *         "vat_rate_bp": 2000,
         *         "total_excl_vat": {
         *           "amount_minor": 448800,
         *           "currency": "EUR"
         *         },
         *         "vat_amount": {
         *           "amount_minor": 89760,
         *           "currency": "EUR"
         *         },
         *         "total_incl_vat": {
         *           "amount_minor": 538560,
         *           "currency": "EUR"
         *         },
         *         "captured_at": "2026-12-01T09:41:07Z"
         *       },
         *       "current_period_start": "2026-12-01T00:00:00Z",
         *       "current_period_end": "2027-12-01T00:00:00Z",
         *       "cancel_at_period_end": false,
         *       "cancelled_at": null,
         *       "next_invoice_at": "2027-12-01T00:00:00Z",
         *       "price_change_notice_days": 90,
         *       "created_at": "2026-12-01T09:41:07Z",
         *       "updated_at": "2026-12-03T11:20:00Z"
         *     }
         */
        Subscription: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            /** Format: uuid */
            tenant_id?: string | null;
            /** Format: uuid */
            order_id?: string | null;
            state: components["schemas"]["SubscriptionState"];
            plan_code?: string;
            plan_version?: number;
            pack_code: string;
            capacity_tier_code: string;
            billing_period: components["schemas"]["BillingPeriod"];
            price_snapshot: components["schemas"]["PriceSnapshot"];
            /** Format: date-time */
            current_period_start: string;
            /** Format: date-time */
            current_period_end: string;
            /** @default false */
            cancel_at_period_end: boolean;
            /** Format: date-time */
            cancelled_at?: string | null;
            /**
             * Format: date-time
             * @description When the next invoice is due to be issued. Null once cancelled.
             */
            next_invoice_at?: string | null;
            /** @description Notice the contract owes before a price change takes effect. */
            price_change_notice_days?: number;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * InvoiceState
         * @example issued
         * @enum {string}
         */
        InvoiceState: "draft" | "issued" | "paid" | "overdue" | "void" | "credited";
        /**
         * InvoiceLine
         * @example {
         *       "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
         *       "quantity": 1,
         *       "unit_amount_excl_vat": {
         *         "amount_minor": 448800,
         *         "currency": "EUR"
         *       },
         *       "total_excl_vat": {
         *         "amount_minor": 448800,
         *         "currency": "EUR"
         *       },
         *       "vat_rate_bp": 2000,
         *       "period_start": "2026-12-01T00:00:00Z",
         *       "period_end": "2027-12-01T00:00:00Z"
         *     }
         */
        InvoiceLine: {
            description: string;
            quantity: number;
            unit_amount_excl_vat: components["schemas"]["Money"];
            total_excl_vat: components["schemas"]["Money"];
            vat_rate_bp: number;
            /** Format: date-time */
            period_start?: string | null;
            /** Format: date-time */
            period_end?: string | null;
        };
        /**
         * Invoice
         * @description Issued by Core, which allocates `number` from its own gapless series in the order of the
         *     issue dates, and frozen once issued: a correction is a credit note, never an edit. The
         *     number is absent while the invoice is a draft, and a draft is never listed.
         * @example {
         *       "id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
         *       "order_id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
         *       "number": "INV-2026-0142",
         *       "state": "issued",
         *       "currency": "EUR",
         *       "vat_regime": "fr_standard",
         *       "lines": [
         *         {
         *           "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
         *           "quantity": 1,
         *           "unit_amount_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "total_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "vat_rate_bp": 2000,
         *           "period_start": "2026-12-01T00:00:00Z",
         *           "period_end": "2027-12-01T00:00:00Z"
         *         }
         *       ],
         *       "total_excl_vat": {
         *         "amount_minor": 448800,
         *         "currency": "EUR"
         *       },
         *       "vat_amount": {
         *         "amount_minor": 89760,
         *         "currency": "EUR"
         *       },
         *       "total_incl_vat": {
         *         "amount_minor": 538560,
         *         "currency": "EUR"
         *       },
         *       "amount_due": {
         *         "amount_minor": 538560,
         *         "currency": "EUR"
         *       },
         *       "issued_at": "2026-12-01T09:42:00Z",
         *       "due_at": "2026-12-31T23:59:59Z",
         *       "paid_at": null,
         *       "pdf_available": true,
         *       "external_ref": "inv_ext_9RJ2K",
         *       "created_at": "2026-12-01T09:41:07Z",
         *       "updated_at": "2026-12-01T09:42:00Z"
         *     }
         */
        Invoice: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            /** Format: uuid */
            subscription_id?: string | null;
            /** Format: uuid */
            order_id?: string | null;
            /** @example INV-2026-0142 */
            number?: string | null;
            state: components["schemas"]["InvoiceState"];
            /** @enum {string} */
            currency: "EUR";
            vat_regime?: components["schemas"]["VatRegime"];
            lines: components["schemas"]["InvoiceLine"][];
            total_excl_vat: components["schemas"]["Money"];
            vat_amount: components["schemas"]["Money"];
            total_incl_vat: components["schemas"]["Money"];
            amount_due?: components["schemas"]["Money"];
            /** Format: date-time */
            issued_at?: string | null;
            /** Format: date-time */
            due_at?: string | null;
            /** Format: date-time */
            paid_at?: string | null;
            /** @description Whether GET /invoices/{invoice_id}/download will return a link. */
            pdf_available?: boolean;
            /** @description Identifier at the billing provider. Staff-facing. */
            external_ref?: string | null;
            /**
             * Format: uuid
             * @description The credit note that credits the invoice in full (`getCreditNote`), once it is `credited`; null otherwise.
             */
            credit_note_id?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * CreditNote
         * @description The only correction of an issued invoice (`BILLING_MODEL.md` §4): numbered by Core from a
         *     gapless series of its own (`AV-<series>-<YYYY>-<NNNNN>`), dated, and never changed. It
         *     carries the invoice's VAT treatment and a copy of each line it credits. Amounts are what is
         *     credited, never negative. For now a credit note credits its invoice in full.
         * @example {
         *       "id": "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *       "invoice_number": "INV-2026-00142",
         *       "number": "AV-INV-2026-00007",
         *       "issued_at": "2026-12-03T10:12:44Z",
         *       "reason": "customer_cancellation",
         *       "currency": "EUR",
         *       "vat_regime": "fr_standard",
         *       "lines": [
         *         {
         *           "description": "Essentiel, pack Visio + Docs, capacity M, 12 months",
         *           "quantity": 1,
         *           "unit_amount_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "total_excl_vat": {
         *             "amount_minor": 448800,
         *             "currency": "EUR"
         *           },
         *           "vat_rate_bp": 2000,
         *           "period_start": "2026-12-01T00:00:00Z",
         *           "period_end": "2027-12-01T00:00:00Z"
         *         }
         *       ],
         *       "total_excl_vat": {
         *         "amount_minor": 448800,
         *         "currency": "EUR"
         *       },
         *       "vat_amount": {
         *         "amount_minor": 89760,
         *         "currency": "EUR"
         *       },
         *       "total_incl_vat": {
         *         "amount_minor": 538560,
         *         "currency": "EUR"
         *       }
         *     }
         */
        CreditNote: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            /** Format: uuid */
            invoice_id: string;
            invoice_number: string;
            /** @example AV-INV-2026-00007 */
            number: string;
            /** Format: date-time */
            issued_at: string;
            reason: components["schemas"]["CreditNoteReason"];
            /** @enum {string} */
            currency: "EUR";
            vat_regime: components["schemas"]["VatRegime"];
            lines: components["schemas"]["InvoiceLine"][];
            total_excl_vat: components["schemas"]["Money"];
            vat_amount: components["schemas"]["Money"];
            total_incl_vat: components["schemas"]["Money"];
        };
        /**
         * CreditNoteReason
         * @description Why the invoice is credited: `customer_cancellation`, its order cancelled by its owner
         *     (`cancelOrder`); `unpaid_lapse`, its order cancelled by Core past the invoice's due date;
         *     `complimentary`, its order settled with no charge by a staff operator, with a reason
         *     (BILLING_MODEL.md §4.2).
         * @enum {string}
         */
        CreditNoteReason: "customer_cancellation" | "unpaid_lapse" | "complimentary";
        /**
         * PaymentLinkCreateRequest
         * @example {
         *       "return_url": "https://app.kodera.io/invoices/d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *       "locale": "fr"
         *     }
         */
        PaymentLinkCreateRequest: {
            /**
             * Format: uri
             * @description Where the provider sends the payer back. Must be an app.kodera.io URL.
             */
            return_url?: string | null;
            /** @enum {string} */
            locale?: "fr" | "en";
        };
        /**
         * PaymentLink
         * @description A one-invoice payment link at the payment provider, which is still to be chosen. There is
         *     no stored payment method and no recurring collection before the subscription engine.
         * @example {
         *       "id": "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081",
         *       "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *       "provider": "stripe",
         *       "url": "https://pay.example.invalid/xJ8kQ2mR7t",
         *       "state": "active",
         *       "amount": {
         *         "amount_minor": 538560,
         *         "currency": "EUR"
         *       },
         *       "expires_at": "2026-12-31T23:59:59Z",
         *       "used_at": null,
         *       "created_at": "2026-12-01T09:42:05Z"
         *     }
         */
        PaymentLink: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            invoice_id: string;
            /** @enum {string} */
            provider?: "stripe" | "qonto";
            /** Format: uri */
            url: string;
            /** @enum {string} */
            state: "active" | "used" | "expired" | "cancelled";
            amount: components["schemas"]["Money"];
            /** Format: date-time */
            expires_at: string;
            /** Format: date-time */
            used_at?: string | null;
            /** Format: date-time */
            created_at: string;
        };
        /**
         * DpaGenerateRequest
         * @example {
         *       "pack_code": "visio-docs",
         *       "tenant_id": null,
         *       "locale": "fr"
         *     }
         */
        DpaGenerateRequest: {
            /** @description The pack about to be ordered; it decides the sub-processor list in Annex C. */
            pack_code: string;
            /**
             * Format: uuid
             * @description Set when regenerating for an existing tenant.
             */
            tenant_id?: string | null;
            /**
             * @default fr
             * @enum {string}
             */
            locale: "fr" | "en";
        };
        /**
         * Dpa
         * @description The data processing agreement generated per organisation and pack, with annexes A to D and
         *     the sub-processor list in force. Acceptance is a contractual signature: irreversible,
         *     recorded with the accepting person, the document digest, the IP and the user agent.
         * @example {
         *       "id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": null,
         *       "version": "2026.11",
         *       "state": "accepted",
         *       "locale": "fr",
         *       "pack_code": "visio-docs",
         *       "sha256": "0000000000000000000000000000000000000000000000000000000000000d9a",
         *       "sub_processors": [
         *         {
         *           "name": "Scaleway",
         *           "role": "Hosting and infrastructure",
         *           "location": "Paris",
         *           "country": "FR"
         *         }
         *       ],
         *       "annexes": [
         *         "A",
         *         "B",
         *         "C",
         *         "D"
         *       ],
         *       "generated_at": "2026-12-01T09:38:00Z",
         *       "accepted_at": "2026-12-01T09:40:52Z",
         *       "accepted_by": {
         *         "person_id": "11111111-2222-4333-8444-555555555555",
         *         "name": "Julie Marchand",
         *         "email": "julie@acme.fr",
         *         "role_title": "Présidente"
         *       },
         *       "superseded_by": null
         *     }
         */
        Dpa: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            /** Format: uuid */
            tenant_id?: string | null;
            /** @example 2026.11 */
            version: string;
            /** @enum {string} */
            state: "generated" | "accepted" | "superseded";
            /** @enum {string} */
            locale: "fr" | "en";
            pack_code?: string;
            /** @description Digest of the exact PDF the customer accepted. The example is deliberately non-random so a secret scanner does not flag it once it is copied into a generated file; a real value is a full digest. */
            sha256: string;
            /** @description Annex C as data, so the console can render it and a change can trigger a new version. */
            sub_processors?: {
                name: string;
                role: string;
                location: string;
                country?: string;
            }[];
            annexes?: ("A" | "B" | "C" | "D")[];
            /** Format: date-time */
            generated_at: string;
            /** Format: date-time */
            accepted_at?: string | null;
            /** @description Null until accepted. */
            accepted_by?: {
                /** Format: uuid */
                person_id: string;
                name: string;
                /** Format: email */
                email: string;
                role_title?: string | null;
            } | null;
            /** Format: uuid */
            superseded_by?: string | null;
        };
        /**
         * DpaAcceptRequest
         * @description `sha256` must match the document the customer read; a mismatch means the document changed
         *     under them and the call is refused with `conflict`.
         * @example {
         *       "accepted": true,
         *       "sha256": "0000000000000000000000000000000000000000000000000000000000000d9a",
         *       "accepted_by_name": "Julie Marchand",
         *       "accepted_by_role": "Présidente"
         *     }
         */
        DpaAcceptRequest: {
            /** @constant */
            accepted: true;
            /** @description Digest of the PDF being accepted, echoed back by the client. The example is deliberately non-random so a secret scanner does not flag it once it is copied into a generated file; a real value is a full digest. */
            sha256: string;
            accepted_by_name?: string;
            accepted_by_role?: string | null;
        };
        /**
         * TenantStatus
         * @description The canonical tenant state machine. One enum, here, and nowhere else: three enums
         *     disagreeing across documents is the condition this contract exists to end.
         *
         *     ```
         *     ordered ──▶ provisioning ──▶ ready ──▶ active ⇄ upgrading
         *                      │                       │  ⇅
         *                      │                       │  maintenance
         *                      ▼                       ▼
         *                    failed ◀───────────── suspended ──▶ decommissioning ──▶ deleted
         *     ```
         *
         *     | Status | Meaning | Left by |
         *     |---|---|---|
         *     | `ordered` | the order is written and no tenant workload/data store is provisioned; a human-controlled bootstrap boundary or its cancellation cleanup may exist | `provision` job, unless cancellation fenced it; otherwise cleanup finalization |
         *     | `provisioning` | the provision job is running its steps | the job succeeding or failing |
         *     | `ready` | infrastructure is green, the welcome email is out, nobody has logged in | first successful login |
         *     | `active` | in normal service | `upgrade`, `backup`, `suspend`, `decommission` |
         *     | `upgrading` | the upgrade job holds maintenance mode | the job succeeding, or a restore |
         *     | `maintenance` | maintenance mode held deliberately, edge serves 503 with `Retry-After` | operator |
         *     | `suspended` | reachable to nobody, data intact, billing stopped | `resume` or `decommission` |
         *     | `decommissioning` | bounded read-only recovery window; ordinary access and mutations are disabled; no current API operation admits an exit export, while the future lane uses top-level jobs under a shared tenant lock until admission closes | future cutoff after the recovery end or a validated earlier-deletion instruction; `delete` destroys active stores, then a durable finalizer signs the initial attestation and changes status once cutoff evidence is sealed |
         *     | `deleted` | initial deletion attestation signed; active stores were destroyed, or an ordered cancellation proved canonically that no workload/data store was provisioned and, when any lifetime ProjectBootstrap boundary existed, independently verified retirement and absence of every scoped project/application/policy/key before finalization; any locked backups follow their separate expiry and purge clock before the final certificate | terminal |
         *     | `failed` | a job left the tenant in a state a human must look at | `provision`, `restore` or operator |
         * @example active
         * @enum {string}
         */
        TenantStatus: "ordered" | "provisioning" | "ready" | "active" | "upgrading" | "maintenance" | "suspended" | "decommissioning" | "deleted" | "failed";
        /**
         * TenantObserved
         * @description What the fleet last reported, from the agent heartbeat and from nightly drift detection.
         *     Never a source of truth for what the tenant should be: desired state lives in `Tenant`.
         * @example {
         *       "last_heartbeat_at": "2026-12-03T11:19:42Z",
         *       "heartbeat_seq": 84213,
         *       "stale": false,
         *       "agent_version": "0.4.2",
         *       "profile": {
         *         "app": "visio-docs",
         *         "version": "1.4",
         *         "compose_digest": "sha256:000000000000000000000000000000000000000000000000000000000000d16e"
         *       },
         *       "drift_detected_at": null,
         *       "drift_summary": null,
         *       "maintenance": false
         *     }
         */
        TenantObserved: {
            /** Format: date-time */
            last_heartbeat_at?: string | null;
            /** Format: int64 */
            heartbeat_seq?: number | null;
            /** @description True after three consecutive missed heartbeats, that is roughly 180 seconds. */
            stale?: boolean;
            agent_version?: string | null;
            /** @description The profile the VM is actually running. */
            profile?: {
                app?: string;
                version?: string;
                compose_digest?: string;
            } | null;
            /** Format: date-time */
            drift_detected_at?: string | null;
            drift_summary?: string | null;
            /** @default false */
            maintenance: boolean;
        };
        /**
         * Tenant
         * @description A provisioned suite for one organisation: one Scaleway project, one VM, two retained IPs,
         *     one OpenTofu state file. It authenticates against its organisation's Keycloak realm, shared
         *     with that organisation's other tenants. Desired state here, observed state in `observed`.
         * @example {
         *       "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "slug": "acme",
         *       "name": "ACME",
         *       "status": "active",
         *       "status_changed_at": "2026-12-02T16:04:00Z",
         *       "pack_code": "visio-docs",
         *       "capacity_tier_code": "M",
         *       "apps": [
         *         "visio",
         *         "docs"
         *       ],
         *       "region": "fr-par",
         *       "realm": "acme-sa",
         *       "profile_ref": "visio-docs/1.4",
         *       "profile_commit": "000000000000000000000000000000000000c0de",
         *       "instance_id": "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
         *       "default_urls": {
         *         "visio": "https://acme.visio.kodera.io",
         *         "docs": "https://acme.docs.kodera.io"
         *       },
         *       "observed": {
         *         "last_heartbeat_at": "2026-12-03T11:19:42Z",
         *         "heartbeat_seq": 84213,
         *         "stale": false,
         *         "agent_version": "0.4.2",
         *         "profile": {
         *           "app": "visio-docs",
         *           "version": "1.4",
         *           "compose_digest": "sha256:000000000000000000000000000000000000000000000000000000000000d16e"
         *         },
         *         "drift_detected_at": null,
         *         "drift_summary": null,
         *         "maintenance": false
         *       },
         *       "locale": "fr",
         *       "created_at": "2026-12-01T09:41:07Z",
         *       "updated_at": "2026-12-03T11:19:42Z"
         *     }
         */
        Tenant: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            slug: string;
            name: string;
            status: components["schemas"]["TenantStatus"];
            /** Format: date-time */
            status_changed_at?: string;
            pack_code: string;
            capacity_tier_code: string;
            apps: components["schemas"]["AppCode"][];
            /**
             * @description Hosting in the European Union is a product promise, not a setting; `fr-par` is the only region until a provider decision adds one (ADR-0017).
             * @enum {string}
             */
            region: "fr-par";
            realm?: string | null;
            /** @description Tenant profile as app/version. */
            profile_ref?: string | null;
            /** @description The commit SHA the profile was vendored from. The example is deliberately non-random; a real value is a full commit SHA. */
            profile_commit?: string | null;
            /**
             * Format: uuid
             * @description The VM the agent runs on; the id used by the instance log endpoint.
             */
            instance_id?: string | null;
            /** @description The kodera.io hosts, always valid even when a custom domain is live. */
            default_urls?: {
                [key: string]: string;
            };
            observed?: components["schemas"]["TenantObserved"];
            /**
             * @default fr
             * @enum {string}
             */
            locale: "fr" | "en";
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * ProvisioningStep
         * @description One row of the console's provisioning progress. The list is the same ordered sequence for
         *     every tenant, so the console can render it before the job even starts.
         * @example {
         *       "key": "preflight",
         *       "customer_label_key": "accounts",
         *       "title": "Preflight config, stack and public",
         *       "status": "succeeded",
         *       "started_at": "2026-12-02T15:58:10Z",
         *       "ended_at": "2026-12-02T16:03:41Z",
         *       "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
         *       "detail": "14 checks green, including no credential on this host resolves outside project acme."
         *     }
         */
        ProvisioningStep: {
            /**
             * @description The internal step. Staff-facing: it names an OpenTofu apply, an Ansible role or a
             *     Keycloak call, and it changes when the tenant profile changes. A customer never sees it.
             * @enum {string}
             */
            key: "project" | "network" | "host" | "dns" | "mail" | "identity" | "profile" | "deploy" | "preflight" | "backup" | "probes" | "status_components";
            customer_label_key: components["schemas"]["ProvisioningStepLabel"];
            /** @description Staff-facing English title. The console renders `customer_label_key`, never this. */
            title: string;
            /** @enum {string} */
            status: "pending" | "running" | "succeeded" | "failed" | "skipped";
            /** Format: date-time */
            started_at?: string | null;
            /** Format: date-time */
            ended_at?: string | null;
            /** Format: uuid */
            job_id?: string | null;
            /** @description Never contains a credential or customer personal data. */
            detail?: string | null;
        };
        /**
         * TenantApp
         * @description One application on a tenant, with the URL the customer actually uses.
         * @example {
         *       "code": "visio",
         *       "name": "Visio",
         *       "url": "https://visio.acme.fr",
         *       "default_url": "https://acme.visio.kodera.io",
         *       "custom_domain": "visio.acme.fr",
         *       "state": "live",
         *       "version": "1.4"
         *     }
         */
        TenantApp: {
            code: components["schemas"]["AppCode"];
            name: string;
            /**
             * Format: uri
             * @description The custom domain when one is live, the kodera.io host otherwise.
             */
            url: string;
            /** Format: uri */
            default_url?: string;
            custom_domain?: string | null;
            /** @enum {string} */
            state: "pending" | "live" | "degraded" | "unavailable" | "maintenance";
            version?: string | null;
        };
        /**
         * CapacityGauge
         * @description What the console renders as three bars. `upgrade_prompt` turns true at
         *     `threshold_pct`, which is 90 by default; the customer sees an upgrade prompt rather than
         *     an error, and the seat check on invitations refuses only at 100 percent.
         * @example {
         *       "seats": {
         *         "used": 118,
         *         "included": 150,
         *         "pct": 78.7
         *       },
         *       "participants": {
         *         "used": 46,
         *         "included": 50,
         *         "pct": 92
         *       },
         *       "storage": {
         *         "used": 429496729600,
         *         "included": 536870912000,
         *         "pct": 80
         *       },
         *       "threshold_pct": 90,
         *       "upgrade_prompt": true,
         *       "suggested_capacity_tier_code": "L",
         *       "measured_at": "2026-12-03T11:19:42Z"
         *     }
         */
        CapacityGauge: {
            seats: components["schemas"]["CapacityDimension"];
            participants: components["schemas"]["CapacityDimension"];
            storage: components["schemas"]["CapacityDimension"];
            /** @default 90 */
            threshold_pct: number;
            upgrade_prompt: boolean;
            suggested_capacity_tier_code?: string | null;
            /** Format: date-time */
            measured_at: string;
        };
        /**
         * CapacityDimension
         * @description One bar of the gauge. `used` and `included` share the unit named by the dimension.
         * @example {
         *       "used": 118,
         *       "included": 150,
         *       "pct": 78.7
         *     }
         */
        CapacityDimension: {
            /** Format: int64 */
            used: number;
            /** Format: int64 */
            included: number;
            /** @description Percentage with one decimal. May exceed 100 on the peak dimension. */
            pct: number;
        };
        /**
         * TenantStatusView
         * @description Everything the console's Status screen renders, in one call.
         * @example {
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "status": "active",
         *       "status_changed_at": "2026-12-02T16:04:00Z",
         *       "message_key": "status.tenant.active",
         *       "provisioning_steps": [
         *         {
         *           "key": "preflight",
         *           "customer_label_key": "accounts",
         *           "title": "Preflight config, stack and public",
         *           "status": "succeeded",
         *           "started_at": "2026-12-02T15:58:10Z",
         *           "ended_at": "2026-12-02T16:03:41Z",
         *           "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
         *           "detail": "14 checks green, including no credential on this host resolves outside project acme."
         *         }
         *       ],
         *       "current_job": null,
         *       "apps": [
         *         {
         *           "code": "visio",
         *           "name": "Visio",
         *           "url": "https://visio.acme.fr",
         *           "default_url": "https://acme.visio.kodera.io",
         *           "custom_domain": "visio.acme.fr",
         *           "state": "live",
         *           "version": "1.4"
         *         }
         *       ],
         *       "capacity": {
         *         "seats": {
         *           "used": 118,
         *           "included": 150,
         *           "pct": 78.7
         *         },
         *         "participants": {
         *           "used": 46,
         *           "included": 50,
         *           "pct": 92
         *         },
         *         "storage": {
         *           "used": 429496729600,
         *           "included": 536870912000,
         *           "pct": 80
         *         },
         *         "threshold_pct": 90,
         *         "upgrade_prompt": true,
         *         "suggested_capacity_tier_code": "L",
         *         "measured_at": "2026-12-03T11:19:42Z"
         *       },
         *       "components": [
         *         {
         *           "id": "0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f",
         *           "scope": "tenant",
         *           "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *           "key": "calls",
         *           "name": "Calls",
         *           "state": "degraded",
         *           "since": "2026-12-03T10:58:00Z",
         *           "message_key": "status.calls.degraded",
         *           "incident_ref": "INC-2026-014"
         *         }
         *       ],
         *       "agent": {
         *         "stale": false,
         *         "last_heartbeat_at": "2026-12-03T11:19:42Z",
         *         "agent_version": "0.4.2",
         *         "maintenance": false
         *       },
         *       "domains": [
         *         {
         *           "id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
         *           "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *           "fqdn": "visio.acme.fr",
         *           "kind": "subdomain",
         *           "role": "web",
         *           "app": "visio",
         *           "state": "dns_pending",
         *           "is_canonical": false,
         *           "verification": {
         *             "record_name": "_kodera-verify.visio.acme.fr",
         *             "record_type": "TXT",
         *             "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
         *             "issued_at": "2026-12-03T09:00:00Z",
         *             "verified_at": "2026-12-03T09:14:22Z",
         *             "checked_at": "2026-12-03T09:31:05Z",
         *             "attempts": 3,
         *             "failure_code": null,
         *             "resolvers_agreeing": 3
         *           },
         *           "target": {
         *             "record_name": "visio.acme.fr",
         *             "record_type": "CNAME",
         *             "record_value": "acme.visio.kodera.io.",
         *             "observed_value": null
         *           },
         *           "certificate": null,
         *           "created_at": "2026-12-03T08:59:58Z",
         *           "updated_at": "2026-12-03T09:31:05Z"
         *         }
         *       ]
         *     }
         */
        TenantStatusView: {
            /** Format: uuid */
            tenant_id: string;
            status: components["schemas"]["TenantStatus"];
            /** Format: date-time */
            status_changed_at?: string;
            /** @description Message-catalogue key for the banner. The console never shows English prose to a customer. */
            message_key?: string | null;
            provisioning_steps: components["schemas"]["ProvisioningStep"][];
            current_job?: components["schemas"]["JobAccepted"] | null;
            apps: components["schemas"]["TenantApp"][];
            /**
             * @description Null until the tenant's capacity is measured: only measured numbers are published.
             *     Since 0.30.0; a client must render the null case.
             */
            capacity: components["schemas"]["CapacityGauge"] | null;
            /** @description The status components of this tenant, the same rows the status page shows. */
            components?: components["schemas"]["StatusComponent"][];
            agent: {
                /** @description True after three missed heartbeats. */
                stale: boolean;
                /** Format: date-time */
                last_heartbeat_at?: string | null;
                agent_version?: string | null;
                maintenance?: boolean;
            };
            domains?: components["schemas"]["Domain"][];
        };
        /**
         * DomainState
         * @description The domain verification state machine. A host is never added to a certificate list before
         *     the TXT nonce has been observed (strategy 3.2, step 4).
         *
         *     ```
         *     pending ──▶ nonce_issued ──▶ txt_verified ──▶ dns_pending ──▶ certificate_issued ──▶ live
         *          └──────────────┴───────────────┴──────────────┴────────────────┴──────────▶ failed
         *     ```
         *
         *     | State | Meaning | Next |
         *     |---|---|---|
         *     | `pending` | the row exists, nothing issued yet | `nonce_issued` |
         *     | `nonce_issued` | the customer must publish `_kodera-verify.<host>` TXT | `txt_verified` |
         *     | `txt_verified` | the nonce was observed from several resolvers | `dns_pending` |
         *     | `dns_pending` | waiting for the `CNAME` or `A` target to resolve to ours | `certificate_issued` |
         *     | `certificate_issued` | the certificate exists; for a media host it is being copied into LiveKit | `live` |
         *     | `live` | serving | terminal until deletion |
         *     | `failed` | a check failed; `verification.failure_code` says which | any earlier state on the next pass |
         * @example dns_pending
         * @enum {string}
         */
        DomainState: "pending" | "nonce_issued" | "txt_verified" | "dns_pending" | "certificate_issued" | "live" | "failed";
        /**
         * DomainCreateRequest
         * @example {
         *       "fqdn": "visio.acme.fr",
         *       "role": "web",
         *       "app": "visio"
         *     }
         */
        DomainCreateRequest: {
            /** @example visio.acme.fr */
            fqdn: string;
            /**
             * @description `web` points at the retained web IP, `media` at the dedicated media IP that carries
             *     TURN over TLS on 443. A pack with calls needs one of each.
             * @enum {string}
             */
            role: "web" | "media";
            app?: components["schemas"]["AppCode"];
        };
        /**
         * Domain
         * @description A custom domain and everything the console's domain wizard needs to tell the customer what
         *     to publish and what is missing.
         * @example {
         *       "id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "fqdn": "visio.acme.fr",
         *       "kind": "subdomain",
         *       "role": "web",
         *       "app": "visio",
         *       "state": "dns_pending",
         *       "is_canonical": false,
         *       "verification": {
         *         "record_name": "_kodera-verify.visio.acme.fr",
         *         "record_type": "TXT",
         *         "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
         *         "issued_at": "2026-12-03T09:00:00Z",
         *         "verified_at": "2026-12-03T09:14:22Z",
         *         "checked_at": "2026-12-03T09:31:05Z",
         *         "attempts": 3,
         *         "failure_code": null,
         *         "resolvers_agreeing": 3
         *       },
         *       "target": {
         *         "record_name": "visio.acme.fr",
         *         "record_type": "CNAME",
         *         "record_value": "acme.visio.kodera.io.",
         *         "observed_value": null
         *       },
         *       "certificate": null,
         *       "created_at": "2026-12-03T08:59:58Z",
         *       "updated_at": "2026-12-03T09:31:05Z"
         *     }
         */
        Domain: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            tenant_id: string;
            fqdn: string;
            /**
             * @description A subdomain gets a `CNAME`, an apex gets an `A` on the retained IP.
             * @enum {string}
             */
            kind: "subdomain" | "apex";
            /** @enum {string} */
            role: "web" | "media";
            app?: components["schemas"]["AppCode"] | null;
            state: components["schemas"]["DomainState"];
            /**
             * @description The host used in invitation links and as the application's base URL. One per tenant and
             *     per role; moved with `PATCH /domains/{domain_id}`, and only to a domain in state `live`.
             * @default false
             */
            is_canonical: boolean;
            /**
             * @description The TXT nonce challenge. The nonce is single use and rotates on every re-issue.
             *
             *     `record_value` is `kodera-verify=` followed by 48 lower-case Crockford base-32
             *     characters (`0123456789abcdefghjkmnpqrstvwxyz`), from 30 random bytes — the normative
             *     definition is `docs/domain/DOMAIN_STATE_MACHINE.md` §2. That shape is **not** pinned as
             *     a `pattern` here, deliberately: see `CONSOLE_RECONCILIATION.md` §6.1. The example is
             *     deliberately non-random so no scanner mistakes it for a live nonce.
             */
            verification: {
                /** @example _kodera-verify.visio.acme.fr */
                record_name: string;
                /** @enum {string} */
                record_type: "TXT";
                record_value: string;
                /** Format: date-time */
                issued_at?: string | null;
                /** Format: date-time */
                verified_at?: string | null;
                /** Format: date-time */
                checked_at?: string | null;
                attempts?: number;
                /** @description Why the last check failed. Closed set, so every value maps to one copy key. */
                failure_code?: components["schemas"]["DomainFailureCode"] | null;
                /** @description How many independent resolvers returned the nonce. */
                resolvers_agreeing?: number | null;
            };
            /** @description What the customer must publish once the nonce is verified. */
            target: {
                record_name: string;
                /** @enum {string} */
                record_type: "CNAME" | "A";
                record_value: string;
                observed_value?: string | null;
            };
            /** @description Null until issuance. `days_left` drives the expiry alert and the agent vitals. */
            certificate?: {
                /** @enum {string} */
                state?: "pending" | "issuing" | "issued" | "failed";
                /** Format: date-time */
                issued_at?: string | null;
                /** Format: date-time */
                expires_at?: string | null;
                days_left?: number | null;
                issuer?: string | null;
                failure_code?: components["schemas"]["DomainFailureCode"] | null;
            } | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * TicketState
         * @example open
         * @enum {string}
         */
        TicketState: "open" | "pending_customer" | "pending_kodera" | "solved" | "closed";
        /**
         * SupportTicketCreateRequest
         * @description The tenant context is recomputed server-side and whatever the client sends for it is
         *     ignored: the context routes the ticket and sets the SLA.
         * @example {
         *       "subject": "Les participants tombent de l'appel après 10 minutes",
         *       "body": "Depuis ce matin, plusieurs personnes sont déconnectées de la salle Direction.",
         *       "category": "calls",
         *       "severity": "degraded",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "contact_email": null,
         *       "locale": "fr"
         *     }
         */
        SupportTicketCreateRequest: {
            subject: string;
            body: string;
            /** @enum {string} */
            category: "calls" | "documents" | "login" | "domain" | "billing" | "capacity" | "security" | "other";
            /**
             * @description The customer's own read. Staff may re-grade; the SLA follows the graded value.
             * @default question
             * @enum {string}
             */
            severity: "question" | "degraded" | "blocked" | "outage";
            /**
             * Format: uuid
             * @description Required only when the caller belongs to several organisations.
             */
            organisation_id?: string | null;
            /** Format: uuid */
            tenant_id?: string | null;
            /**
             * Format: email
             * @description Another address the customer gives, at most 200 characters, shown to support as not verified. Null when not given; support replies to the caller's own address either way.
             */
            contact_email?: string | null;
            /** @enum {string} */
            locale?: "fr" | "en";
        };
        /**
         * @example {
         *       "id": "11111111-1111-4111-8111-111111111111",
         *       "state": "open",
         *       "priority": "P1",
         *       "queue": "identity-access",
         *       "confirmation": "ticket-created"
         *     }
         */
        CommunitySupportTicketReceipt: {
            /** Format: uuid */
            id: string;
            /** @constant */
            state: "open";
            /** @enum {string} */
            priority: "P0" | "P1" | "P2" | "P3";
            /** @enum {string} */
            queue: "security-incident" | "infra-sre" | "identity-access" | "billing-ops" | "product-engineering" | "compliance-dpo";
            /** @constant */
            confirmation: "ticket-created";
        };
        /**
         * SupportTicket
         * @example {
         *       "id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "subject": "Participants dropped from the call after ten minutes",
         *       "category": "calls",
         *       "severity": "degraded",
         *       "state": "open",
         *       "sla": {
         *         "support_tier": "standard",
         *         "first_response_target_minutes": 240,
         *         "first_response_due_at": "2026-12-03T15:31:00Z",
         *         "first_response_at": null,
         *         "next_response_due_at": "2026-12-03T15:31:00Z",
         *         "business_hours_label": "09:00-18:00 Europe/Paris, lundi au vendredi"
         *       },
         *       "tenant_context": {
         *         "tenant_slug": "acme",
         *         "tenant_status": "active",
         *         "pack_code": "visio-docs",
         *         "capacity_tier_code": "M",
         *         "agent_stale": false,
         *         "open_incident_component_keys": [
         *           "calls"
         *         ],
         *         "last_job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f"
         *       },
         *       "message_count": 1,
         *       "last_message_at": "2026-12-03T11:31:00Z",
         *       "created_by": "11111111-2222-4333-8444-555555555555",
         *       "external_ref": "ZMD-4471",
         *       "created_at": "2026-12-03T11:31:00Z",
         *       "updated_at": "2026-12-03T11:31:02Z"
         *     }
         */
        SupportTicket: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id?: string;
            /** Format: uuid */
            tenant_id?: string | null;
            subject: string;
            /** @enum {string} */
            category: "calls" | "documents" | "login" | "domain" | "billing" | "capacity" | "security" | "other";
            /** @enum {string} */
            severity: "question" | "degraded" | "blocked" | "outage";
            state: components["schemas"]["TicketState"];
            /** @description Derived from the plan's support tier and the graded severity. */
            sla?: {
                /** @enum {string} */
                support_tier?: "standard" | "business" | "critical";
                first_response_target_minutes?: number;
                /** Format: date-time */
                first_response_due_at?: string | null;
                /** Format: date-time */
                first_response_at?: string | null;
                /**
                 * Format: date-time
                 * @description When Kodera owes the next answer on this ticket, computed server-side from the
                 *     tier and the business hours including the out-of-hours case. It is the value the
                 *     console renders on a ticket row; it never computes one. Null once the ticket is
                 *     waiting on the customer or closed.
                 */
                next_response_due_at?: string | null;
                /** @example 09:00-18:00 Europe/Paris, lundi au vendredi */
                business_hours_label?: string;
            };
            /**
             * @description The snapshot staff need before reading the message. Computed server-side, never from
             *     the request body.
             */
            tenant_context: {
                tenant_slug?: string | null;
                tenant_status?: components["schemas"]["TenantStatus"] | null;
                pack_code?: string | null;
                capacity_tier_code?: string | null;
                agent_stale?: boolean | null;
                open_incident_component_keys?: string[];
                /** Format: uuid */
                last_job_id?: string | null;
            };
            /** @description How many messages the conversation holds; read them at /support/tickets/{ticket_id}/messages. */
            message_count?: number;
            /** Format: date-time */
            last_message_at?: string | null;
            /** Format: uuid */
            created_by?: string;
            /** @description Helpdesk reference. Null when the mirror has not succeeded yet. */
            external_ref?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * StatusComponent
         * @description One line of the status page and of the in-console banner. Platform components are public;
         *     tenant components are visible to that organisation and to staff.
         * @example {
         *       "id": "0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f",
         *       "scope": "tenant",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "key": "calls",
         *       "name": "Calls",
         *       "state": "degraded",
         *       "since": "2026-12-03T10:58:00Z",
         *       "message_key": "status.calls.degraded",
         *       "incident_ref": "INC-2026-014"
         *     }
         */
        StatusComponent: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            scope: "platform" | "tenant";
            /** Format: uuid */
            tenant_id?: string | null;
            /** @enum {string} */
            key: "web" | "calls" | "documents" | "console" | "identity" | "mail";
            name: string;
            /** @enum {string} */
            state: "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance";
            /**
             * Format: date-time
             * @description When the component entered this state.
             */
            since: string;
            message_key?: string | null;
            incident_ref?: string | null;
        };
        /**
         * JobKind
         * @description Every infrastructure mutation is one of these. **This enum and §2 of
         *     `docs/domain/JOB_CATALOGUE.md` are one list**: the catalogue is the closed set, each kind
         *     there carrying its ordered steps, a named idempotency proof per step, a timeout, a retry
         *     class and a compensation, and a contract test compares the two in both directions.
         *
         *     Fourteen kinds are tenant-scoped and take that tenant's Postgres advisory lock; a second
         *     job on the same tenant is refused `409 tenant-locked`. `realm_create` and `realm_update`
         *     are organisation-scoped, take no tenant lock and carry a null `tenant_id`.
         *
         *     What a staff operator may trigger directly, and what a tenant may request for itself, is
         *     the self-service column of the catalogue rather than a rule of this file: the two move
         *     independently and encoding one in the other is how they stop agreeing.
         * @example provision
         * @enum {string}
         */
        JobKind: "bootstrap_verify" | "provision" | "upgrade" | "backup" | "restore" | "rotate_secret" | "add_domain" | "remove_domain" | "suspend" | "resume" | "decommission" | "export" | "delete" | "drift_check" | "realm_create" | "realm_update";
        /**
         * JobStatus
         * @description The queue states from core ADR-0004. `leased` means a runner holds it and renews
         *     `lease_expires_at` every 30 seconds; `orphaned` means the lease expired and the job will
         *     re-run from its first non-succeeded step.
         * @example running
         * @enum {string}
         */
        JobStatus: "queued" | "leased" | "running" | "succeeded" | "failed" | "orphaned" | "cancelled";
        /**
         * JobStep
         * @description One individually idempotent step: an OpenTofu apply, an Ansible role, a Keycloak
         *     GET-then-PUT. Re-running a succeeded step is safe by construction, which is what makes an
         *     orphaned job recoverable.
         * @example {
         *       "index": 8,
         *       "key": "preflight",
         *       "title": "Run preflight config, stack and public",
         *       "status": "succeeded",
         *       "attempt": 1,
         *       "started_at": "2026-12-02T15:58:10Z",
         *       "ended_at": "2026-12-02T16:03:41Z",
         *       "output_ref": "jobs/8b1f6d2e/steps/08-preflight.log",
         *       "error_code": null
         *     }
         */
        JobStep: {
            index: number;
            key: string;
            title: string;
            /** @enum {string} */
            status: "pending" | "running" | "succeeded" | "failed" | "skipped";
            attempt?: number;
            /** Format: date-time */
            started_at?: string | null;
            /** Format: date-time */
            ended_at?: string | null;
            /** @description Reference to the step output in Object Storage. Staff only; resolved through the instance log endpoint. */
            output_ref?: string | null;
            error_code?: string | null;
        };
        /**
         * Job
         * @description A row in the Postgres-backed queue. The job, the audit event and the desired-state change
         *     commit in one transaction (core ADR-0004).
         *
         *     `idempotency_key` is **derived from** the caller's `Idempotency-Key`, not equal to it:
         *     `sha256(principal_urn + ":" + request_key)`, per `docs/api/CONVENTIONS.md` §8. Pressing a
         *     button twice still never produces two projects, and the queue's unique constraint stays
         *     independent of whatever key format a client chose — including one long enough that the
         *     header's 255 characters would not fit a 128-character column. It is a digest, so it is
         *     not a credential and carries nothing the caller supplied verbatim.
         * @example {
         *       "id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "kind": "provision",
         *       "status": "succeeded",
         *       "idempotency_key": "0000000000000000000000000000000000000000000000000000000000000001",
         *       "desired_spec_hash": "00000000000000000000000000000000000000000000000000000000000005ec",
         *       "attempt": 1,
         *       "lease_expires_at": null,
         *       "steps": [
         *         {
         *           "index": 8,
         *           "key": "preflight",
         *           "title": "Run preflight config, stack and public",
         *           "status": "succeeded",
         *           "attempt": 1,
         *           "started_at": "2026-12-02T15:58:10Z",
         *           "ended_at": "2026-12-02T16:03:41Z",
         *           "output_ref": "jobs/8b1f6d2e/steps/08-preflight.log",
         *           "error_code": null
         *         }
         *       ],
         *       "progress_pct": 100,
         *       "actor": {
         *         "type": "staff",
         *         "id": "sylvain",
         *         "email": "sylvain@kodera.io"
         *       },
         *       "parent_job_id": null,
         *       "error": null,
         *       "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
         *       "created_at": "2026-12-02T15:31:00Z",
         *       "started_at": "2026-12-02T15:31:04Z",
         *       "ended_at": "2026-12-02T16:04:00Z"
         *     }
         */
        Job: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            tenant_id?: string | null;
            /** Format: uuid */
            organisation_id?: string | null;
            kind: components["schemas"]["JobKind"];
            status: components["schemas"]["JobStatus"];
            /** @description The derived digest, never the caller's key verbatim — see the schema description. The example is deliberately non-random so a secret scanner does not flag it in a generated file. */
            idempotency_key: string;
            /** @description Digest of the desired state the job was created from. The example is deliberately non-random so a secret scanner does not flag it once it is copied into a generated file; a real value is a full digest. */
            desired_spec_hash?: string | null;
            attempt: number;
            /** Format: date-time */
            lease_expires_at?: string | null;
            steps: components["schemas"]["JobStep"][];
            progress_pct?: number | null;
            /** @description Who asked. A job whose actor type is `system` came from a schedule, not from a person. */
            actor?: {
                /** @enum {string} */
                type?: "user" | "staff" | "system" | "agent";
                id?: string | null;
                /** Format: email */
                email?: string | null;
            };
            /** Format: uuid */
            parent_job_id?: string | null;
            error?: {
                code: string;
                message?: string;
                step_index?: number | null;
            } | null;
            request_id?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            started_at?: string | null;
            /** Format: date-time */
            ended_at?: string | null;
        };
        /**
         * JobTriggerRequest
         * @description Staff trigger of a lifecycle job. `parameters` is validated against the schema the kind
         *     requires: `upgrade` needs `to_version`, `restore` needs `snapshot_id`, `backup` needs
         *     `mode`. An unknown parameter is refused rather than ignored.
         * @example {
         *       "kind": "upgrade",
         *       "parameters": {
         *         "to_version": "1.5",
         *         "safety_snapshot": true,
         *         "scheduled_at": "2026-12-06T03:00:00Z"
         *       },
         *       "note": "Batched upstream minors, wave 1."
         *     }
         */
        JobTriggerRequest: {
            /** @enum {string} */
            kind: "provision" | "upgrade" | "backup" | "restore" | "suspend" | "resume" | "decommission";
            parameters?: {
                /** @description upgrade: the profile version to move to. */
                to_version?: string;
                /**
                 * @description upgrade: take a hot snapshot before touching anything. Never send false in production.
                 * @default true
                 */
                safety_snapshot?: boolean;
                /**
                 * @description backup: hot keeps the tenant serving, cold stops it.
                 * @enum {string}
                 */
                mode?: "hot" | "cold";
                /** @description restore: the snapshot to restore. */
                snapshot_id?: string;
                /** @description restore: the compose digest that snapshot was taken with. */
                compose_digest?: string;
                /** @description suspend and decommission: recorded in the audit event. */
                reason?: string;
                /** @description decommission: the operator must retype the tenant slug. A mismatch is refused. */
                confirm_slug?: string;
                /**
                 * Format: date-time
                 * @description Run no earlier than this instant, for a maintenance window.
                 */
                scheduled_at?: string;
            };
            note?: string | null;
        };
        /**
         * LogLine
         * @description One redacted line of agent or command output. Staff only.
         * @example {
         *       "at": "2026-12-02T16:03:41Z",
         *       "level": "info",
         *       "unit": "kodera-preflight",
         *       "command_id": "c0ffee00-1111-4222-8333-444455556666",
         *       "log_ref": "commands/c0ffee00/preflight.log",
         *       "message": "preflight public: 14 checks, 14 green"
         *     }
         */
        LogLine: {
            /** Format: date-time */
            at: string;
            /** @enum {string} */
            level?: "debug" | "info" | "warning" | "error";
            unit?: string | null;
            /** Format: uuid */
            command_id?: string | null;
            log_ref?: string | null;
            /** @description Secrets are replaced by a redaction marker at write time and again here. */
            message: string;
        };
        /**
         * AuditEvent
         * @description Append-only. Never updated, never deleted; retention is enforced by dropping partitions.
         *     Exports of `Job` and `AuditEvent` back the DPA's accountability clause. No customer
         *     personal data beyond the actor's own identifier and email. The future ordered-cancellation
         *     cleanup registers the closed action keys
         *     `tenant.ordered_cancellation_cleanup_recorded`,
         *     `tenant.ordered_cancellation_cleanup_closed`,
         *     `tenant.ordered_cancellation_cleanup_verified` and
         *     `tenant.ordered_cancellation_cleanup_finalized`; each state write emits its matching key.
         * @example {
         *       "id": "aa11bb22-cc33-4d44-8e55-ff6600771188",
         *       "occurred_at": "2026-12-02T15:31:00Z",
         *       "action": "tenant.provision_requested",
         *       "actor": {
         *         "type": "staff",
         *         "id": "sylvain",
         *         "email": "sylvain@kodera.io",
         *         "realm": "kodera-staff",
         *         "ip": "192.0.2.0",
         *         "user_agent": "Mozilla/5.0"
         *       },
         *       "target": {
         *         "type": "tenant",
         *         "id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b"
         *       },
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "job_id": "8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f",
         *       "request_id": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
         *       "outcome": "success",
         *       "metadata": {
         *         "pack_code": "visio-docs",
         *         "capacity_tier_code": "M"
         *       }
         *     }
         */
        AuditEvent: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            occurred_at: string;
            /** @description Dotted action key. The future Core writer guard will admit only keys in `x-audit-action-registry`; the current runtime does not yet enforce that registry. */
            action: string;
            actor: {
                /**
                 * @description The compatible wire value `user` maps to the canonical/runtime audit actor `tenant`; the other values map identically.
                 * @enum {string}
                 */
                type: "user" | "staff" | "agent" | "system";
                id?: string | null;
                /** Format: email */
                email?: string | null;
                realm?: string | null;
                /** @description Truncated to the network prefix before storage. */
                ip?: string | null;
                user_agent?: string | null;
            };
            target?: {
                type?: string;
                id?: string | null;
            };
            /** Format: uuid */
            organisation_id?: string | null;
            /** Format: uuid */
            tenant_id?: string | null;
            /** Format: uuid */
            job_id?: string | null;
            request_id?: string | null;
            /** @enum {string} */
            outcome: "success" | "failure";
            /** @description Structured detail for this action. Never a secret, never customer content. */
            metadata?: {
                [key: string]: unknown;
            };
        };
        /**
         * AgentEnrolmentTokenCreateRequest
         * @example {
         *       "instance_id": "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
         *       "expires_at": "2026-12-02T16:30:00Z",
         *       "credential": "mtls",
         *       "note": "Rebuild after quota grant"
         *     }
         */
        AgentEnrolmentTokenCreateRequest: {
            /**
             * Format: uuid
             * @description The VM this token may enrol, and only that one.
             */
            instance_id: string;
            /**
             * Format: date-time
             * @description At most one hour ahead.
             */
            expires_at: string;
            /**
             * @description `mtls` exchanges the token for a client certificate signed by the agent CA, which is
             *     the default. `bearer` issues a per-tenant bearer credential and exists for a host where
             *     client certificates cannot be terminated.
             * @default mtls
             * @enum {string}
             */
            credential: "mtls" | "bearer";
            note?: string | null;
        };
        /**
         * AgentEnrolmentTokenCreated
         * @description `secret` is returned exactly once. The provisioning job hands it to the VM through the same
         *     channel that writes its other secrets, mode 600. The API keeps an HMAC fingerprint only.
         * @example {
         *       "id": "1a2b3c4d-5e6f-4708-8192-a3b4c5d6e7f8",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "instance_id": "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
         *       "secret": "aen_EXAMPLE00000000000000000000000",
         *       "credential": "mtls",
         *       "agent_api_url": "https://agent.kodera.io/agent/v1",
         *       "ca_fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000cae",
         *       "fingerprint": "8c0e2b4d6f8a0c2e",
         *       "expires_at": "2026-12-02T16:30:00Z",
         *       "created_by": "sylvain",
         *       "created_at": "2026-12-02T15:30:12Z"
         *     }
         */
        AgentEnrolmentTokenCreated: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            tenant_id: string;
            /** Format: uuid */
            instance_id: string;
            /** @description One-time enrolment secret. Do not log, do not store outside the target VM. */
            secret: string;
            /** @enum {string} */
            credential: "mtls" | "bearer";
            /**
             * Format: uri
             * @description Where the agent must present it.
             */
            agent_api_url?: string;
            /** @description SHA-256 of the agent CA certificate, for the agent to pin. */
            ca_fingerprint?: string | null;
            /** @description HMAC fingerprint of the secret, for support to match an enrolment attempt. */
            fingerprint?: string;
            /** Format: date-time */
            expires_at: string;
            created_by?: string;
            /** Format: date-time */
            created_at: string;
        };
        /**
         * ResourceCount
         * @description The answer of a `count` sub-resource. Cursor pages carry no total on purpose, so a screen
         *     that genuinely needs a number asks for it here and pays its own rate limit for it.
         * @example {
         *       "count": 118,
         *       "counted_at": "2026-12-03T11:19:42Z"
         *     }
         */
        ResourceCount: {
            /** Format: int64 */
            count: number;
            /** Format: date-time */
            counted_at?: string;
        };
        /**
         * ConsoleArea
         * @description The console area a contextual request comes from. Closed, because it keys the help articles
         *     and the ticket context server-side; an unknown value is a `malformed-request`, never a
         *     silent empty answer.
         * @example domain
         * @enum {string}
         */
        ConsoleArea: "shell" | "login" | "order" | "status" | "people" | "domain" | "invoices" | "support" | "federation";
        /**
         * SlugAvailability
         * @description Whether a tenant slug can be taken. It never says who holds a taken slug. `suggestions` are
         *     derived from the submitted value and are themselves free at the moment of the answer, which
         *     is not a reservation: a tenant slug is taken by the order that creates the tenant, as an
         *     organisation slug is reserved by the staff intake that creates the organisation.
         * @example {
         *       "slug": "acme",
         *       "available": false,
         *       "reason": "taken",
         *       "suggestions": [
         *         "acme-fr",
         *         "acme-group",
         *         "acme-2027"
         *       ]
         *     }
         */
        SlugAvailability: {
            slug: string;
            available: boolean;
            /**
             * @description Why it is not available. `reserved` covers the platform's own names. The reserved
             *     tenant slugs are a closed list, refused by `placeOrder` and `createTenant` too, and by
             *     the database (`tenancy_tenant_slug_not_reserved`): the platform's own hosts `www`,
             *     `api`, `app`, `auth`, `identity`, `mail`, `status`, `staff`, `admin`, `kodera` and
             *     `kodera-staff`; since 0.38.0 the platform labels of `kodera.io` that organisation slugs
             *     also reserve, `notify`, `staging`, `support`, `billing`, `console`, `developers`,
             *     `matrix`, `auth-admin` and `auth-mail`, and the platform hosts `errors` and
             *     `ops-admin`, because a tenant's slug names its Matrix homeserver (ADR-0023); and every
             *     label beginning `xn--`. Adding a name to the list is a breaking change.
             *     `invalid_format` is unused: the `slug` query parameter already carries the whole
             *     tenant slug pattern, a slug that fails it is refused before this answer, and no format
             *     rule beyond that pattern exists today.
             * @enum {string|null}
             */
            reason?: "taken" | "reserved" | "invalid_format" | null;
            suggestions?: string[];
        };
        /**
         * LegalDocument
         * @description One published contractual document. `version` is what an acceptance records, so a document
         *     that changes gets a new version rather than new bytes behind the same one.
         * @example {
         *       "code": "sla",
         *       "version": "2026.11",
         *       "locale": "fr",
         *       "title": "Engagements de service",
         *       "pack_code": "visio-docs",
         *       "html_url": "https://kodera.io/legal/sla/2026.11",
         *       "text_url": "https://api.kodera.io/api/v1/legal-documents/sla/2026.11/fr",
         *       "sha256": "0000000000000000000000000000000000000000000000000000000000001e9a",
         *       "download": null,
         *       "published_at": "2026-11-02T09:00:00Z"
         *     }
         */
        LegalDocument: {
            /** @enum {string} */
            code: "cgv" | "dpa" | "sla" | "aup";
            version: string;
            /** @enum {string} */
            locale: "fr" | "en";
            title: string;
            /** @description Null when the document is the same for every pack. */
            pack_code?: string | null;
            /**
             * Format: uri
             * @description Readable version, for the console to embed.
             */
            html_url?: string | null;
            /**
             * Format: uri
             * @description The permanent URL of exactly this text (`getLegalDocumentText`). Null when Core holds no text for the document or no public origin is configured.
             */
            text_url?: string | null;
            /** @description Digest of the published text, so a customer can prove which one they read. The example is deliberately non-random so a secret scanner does not flag it once it is copied into a generated file; a real value is a full digest. */
            sha256?: string | null;
            /** @description Short-lived link to the PDF. Null when only the readable version exists. */
            download?: components["schemas"]["DownloadLink"] | null;
            /** Format: date-time */
            published_at: string;
        };
        /**
         * EntitlementCode
         * @description What a pack and a capacity tier unlock. Closed, because the console renders a disabled
         *     control naming the pack that unlocks it, and an unknown code would render nothing.
         * @example federation
         * @enum {string}
         */
        EntitlementCode: "custom_domain" | "federation" | "on_site_enrolment" | "recording" | "ai_assistant" | "priority_support" | "audit_export";
        /**
         * Entitlement
         * @description One capability, whether the organisation has it, and what it would take to get it. Derived
         *     from the active subscription's frozen snapshot, so the catalogue moving does not silently
         *     change what a customer already bought.
         * @example {
         *       "code": "federation",
         *       "enabled": false,
         *       "required_pack_code": "visio-docs-pro",
         *       "required_capacity_tier_code": null,
         *       "limit": null,
         *       "used": null
         *     }
         */
        Entitlement: {
            code: components["schemas"]["EntitlementCode"];
            enabled: boolean;
            /** @description The cheapest pack that enables it. Null when it is enabled. */
            required_pack_code?: string | null;
            required_capacity_tier_code?: string | null;
            /** @description How many of it the plan allows, when the capability is countable. */
            limit?: number | null;
            used?: number | null;
        };
        /**
         * OrganisationStatusSummary
         * @description The shell's one call. `overall` is the worst state among the components, so the banner has a
         *     single value to switch on and never has to reduce a list in the browser.
         * @example {
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "billing_enabled": true,
         *       "workspace_pack_code": null,
         *       "overall": "degraded",
         *       "components": [
         *         {
         *           "id": "0a1b2c3d-4e5f-4607-8819-2a3b4c5d6e7f",
         *           "scope": "tenant",
         *           "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *           "key": "calls",
         *           "name": "Calls",
         *           "state": "degraded",
         *           "since": "2026-12-03T10:58:00Z",
         *           "message_key": "status.calls.degraded",
         *           "incident_ref": "INC-2026-014"
         *         }
         *       ],
         *       "capacity": null,
         *       "billing": {
         *         "dunning_state": "current",
         *         "oldest_overdue_invoice_id": null,
         *         "amount_due": null
         *       },
         *       "maintenance": null,
         *       "open_incident_ids": [
         *         "3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e"
         *       ],
         *       "measured_at": "2026-12-03T11:19:42Z"
         *     }
         */
        OrganisationStatusSummary: {
            /** Format: uuid */
            organisation_id: string;
            /**
             * Format: uuid
             * @description Null before the first tenant exists.
             */
            tenant_id?: string | null;
            /**
             * @description Whether this deployment bills. `false`: no order or payment is taken
             *     (`409 billing-disabled`), and the console offers the one-step workspace creation
             *     instead of the order. Read here, never from the console's build.
             */
            billing_enabled: boolean;
            /**
             * @description With billing off, the pack an unbilled workspace is created on: the console reads the
             *     legal documents in force for it. `null` while billing is on.
             */
            workspace_pack_code: string | null;
            /** @enum {string} */
            overall: "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance";
            components: components["schemas"]["StatusComponent"][];
            capacity?: components["schemas"]["CapacityGauge"] | null;
            /** @description Enough to decide whether the shell shows a payment banner. The detail is on the Invoices screen. */
            billing?: {
                dunning_state?: components["schemas"]["DunningState"];
                /** Format: uuid */
                oldest_overdue_invoice_id?: string | null;
                amount_due?: components["schemas"]["Money"] | null;
            };
            /** @description The next planned window, null when none is planned. */
            maintenance?: {
                /** Format: date-time */
                scheduled_at: string;
                duration_s: number;
                message_key?: string | null;
            } | null;
            open_incident_ids?: string[];
            /** Format: date-time */
            measured_at?: string;
        };
        /**
         * DunningState
         * @description The ladder of the billing model, held on the subscription. It is never read off the tenant
         *     status, and the tenant status is never written from it directly: only the `suspend`,
         *     `resume` and `decommission` jobs move a tenant.
         * @example past_due
         * @enum {string}
         */
        DunningState: "current" | "past_due" | "notice" | "formal_notice" | "suspension_notice" | "suspended" | "terminated";
        /**
         * DunningView
         * @description Where the organisation stands and what happens next, so the Invoices screen can say
         *     "suspension on the 14th unless this is paid" instead of colouring a row red.
         * @example {
         *       "state": "notice",
         *       "ladder": "invoice",
         *       "oldest_overdue_invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
         *       "days_overdue": 12,
         *       "amount_due": {
         *         "amount_minor": 538560,
         *         "currency": "EUR"
         *       },
         *       "hold_until": null,
         *       "steps": [
         *         {
         *           "state": "past_due",
         *           "due_at": "2027-01-01T00:00:00Z",
         *           "done": true,
         *           "message_key": "dunning.past_due"
         *         },
         *         {
         *           "state": "notice",
         *           "due_at": "2027-01-08T00:00:00Z",
         *           "done": true,
         *           "message_key": "dunning.notice"
         *         },
         *         {
         *           "state": "formal_notice",
         *           "due_at": "2027-02-05T00:00:00Z",
         *           "done": false,
         *           "message_key": "dunning.formal_notice"
         *         }
         *       ]
         *     }
         */
        DunningView: {
            state: components["schemas"]["DunningState"];
            /**
             * @deprecated
             * @description Always `invoice`: one ladder, the terms of sale's (CGV Annex 1), whatever pays the invoice. `card` is never sent and goes with the next breaking change.
             * @enum {string}
             */
            ladder?: "invoice" | "card";
            /** Format: uuid */
            oldest_overdue_invoice_id?: string | null;
            days_overdue?: number | null;
            amount_due?: components["schemas"]["Money"] | null;
            /**
             * Format: date-time
             * @description Set while a billing dispute holds the ladder for the amount disputed.
             */
            hold_until?: string | null;
            /** @description The whole ladder, so the customer sees the step after the one they are on. */
            steps: {
                state: components["schemas"]["DunningState"];
                /** Format: date-time */
                due_at?: string | null;
                done: boolean;
                message_key?: string | null;
            }[];
        };
        /**
         * MembershipAccountKind
         * @description How the person signs in, which is what the federation screen counts before it redirects a
         *     whole organisation. `hosted` is an account in the organisation's realm with its own credential;
         *     `federated` signs in through a brokered provider; `on_site` was enrolled from a QR sheet
         *     and holds a passkey.
         * @example hosted
         * @enum {string}
         */
        MembershipAccountKind: "hosted" | "federated" | "on_site";
        /**
         * MemberImportState
         * @description `uploaded` has columns detected and no mapping yet. `validating` is recomputing the preview
         *     after a mapping change. `ready` has a preview and is waiting for the person to press send.
         *     `running` is sending. `completed` has no retryable row and its personal staging data is
         *     gone. `partially_failed` and `failed` keep only retryable rows until retry, discard or the
         *     seven-day ceiling. `discarded` has no personal staging data.
         * @example ready
         * @enum {string}
         */
        MemberImportState: "uploaded" | "validating" | "ready" | "running" | "completed" | "partially_failed" | "failed" | "discarded";
        /**
         * MemberImportRowStatus
         * @description The outcome of one source line. `ready`, `already_member`, `duplicate` and `invalid` come
         *     from validation; `invited` and `failed` come from execution. Closed, because each maps to
         *     one copy key and one suggested next action.
         * @example ready
         * @enum {string}
         */
        MemberImportRowStatus: "ready" | "already_member" | "already_invited" | "duplicate" | "invalid" | "invited" | "failed";
        /**
         * MemberImportCreateRequest
         * @description The uploaded file. Parsing happens server-side; the console posts the bytes and nothing else.
         * @example {
         *       "file": "prenom,nom,email\\nJulie,Marchand,julie@acme.fr\\n",
         *       "has_header_row": true
         *     }
         */
        MemberImportCreateRequest: {
            /**
             * Format: binary
             * @description CSV, at most 2 MB and 5 000 rows. Comma, semicolon and tab are all detected.
             */
            file: string;
            /** @description Detected when absent. Send it only to override a wrong detection. */
            has_header_row?: boolean;
        };
        /**
         * MemberImportPatchRequest
         * @description Which column carries what, by zero-based index, plus the role to use for a row whose role
         *     column is empty or absent. Setting it revalidates every row. `org_owner` is not an import
         *     role, and an admin cannot map or default a row to `org_billing` (ADR-0010).
         * @example {
         *       "column_mapping": {
         *         "email": 2,
         *         "given_name": 0,
         *         "family_name": 1,
         *         "role": null
         *       },
         *       "default_role": "org_member"
         *     }
         */
        MemberImportPatchRequest: {
            column_mapping?: {
                email: number;
                given_name?: number | null;
                family_name?: number | null;
                role?: number | null;
            };
            default_role?: components["schemas"]["InvitationRole"];
        };
        /**
         * MemberImportExecuteRequest
         * @description `only_lines` names the source lines to run, and is what the console sends when retrying a
         *     partly failed import. A line that has already produced an invitation is skipped whatever is
         *     sent here, so the retry cannot double-invite even if the console sends the whole file
         *     again.
         * @example {
         *       "only_lines": [
         *         14,
         *         27,
         *         31,
         *         88
         *       ],
         *       "send_email": true,
         *       "locale": "fr"
         *     }
         */
        MemberImportExecuteRequest: {
            /** @description One-based source line numbers. Omit to run every row whose status is `ready`. */
            only_lines?: number[];
            /** @default true */
            send_email: boolean;
            /** @enum {string} */
            locale?: "fr" | "en";
        };
        /**
         * MemberImport
         * @description A staged member list: the uploaded file, the detected columns, the validated preview and,
         *     after execution, the outcome of every row. It is the staging area, not a second invitation
         *     engine: executing it runs the same batch-invitation service as
         *     `POST /organisations/{organisation_id}/invitations`, so there is one seat check and one
         *     place where an invitation is created.
         *
         *     The raw uploaded object is deleted immediately after parsing. Parsed staging data is
         *     encrypted and deleted on completion, discard or seven days after upload, whichever comes
         *     first. A partial failure scrubs successful and skipped rows immediately and retains only
         *     retryable rows. The durable result contains counts and audit references, never an address
         *     book (ADR-0011).
         * @example {
         *       "id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "state": "partially_failed",
         *       "filename": "equipe.csv",
         *       "row_count": 124,
         *       "has_header_row": true,
         *       "detected_columns": [
         *         {
         *           "index": 0,
         *           "header": "Prénom",
         *           "sample": "Julie"
         *         },
         *         {
         *           "index": 1,
         *           "header": "Nom",
         *           "sample": "Marchand"
         *         },
         *         {
         *           "index": 2,
         *           "header": "Email",
         *           "sample": "julie@acme.fr"
         *         }
         *       ],
         *       "column_mapping": {
         *         "email": 2,
         *         "given_name": 0,
         *         "family_name": 1,
         *         "role": null
         *       },
         *       "default_role": "org_member",
         *       "summary": {
         *         "ready": 118,
         *         "already_member": 4,
         *         "already_invited": 0,
         *         "duplicate": 2,
         *         "invalid": 0,
         *         "invited": 114,
         *         "failed": 4
         *       },
         *       "seats_used_after": 118,
         *       "seats_included": 150,
         *       "rows": [
         *         {
         *           "line": 27,
         *           "email": "paul@acme.fr",
         *           "role": "org_member",
         *           "status": "failed",
         *           "reason_code": "mail_provider_rejected",
         *           "invitation_id": null
         *         }
         *       ],
         *       "created_by": "11111111-2222-4333-8444-555555555555",
         *       "staging_expires_at": "2026-12-10T10:02:00Z",
         *       "created_at": "2026-12-03T10:02:00Z",
         *       "updated_at": "2026-12-03T10:06:41Z"
         *     }
         */
        MemberImport: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            organisation_id: string;
            state: components["schemas"]["MemberImportState"];
            /** @description Cleared with personal staging data; never used as a path. */
            filename: string | null;
            row_count: number;
            has_header_row?: boolean;
            /** @description What the parser found, with one sample value each, so the person maps columns by recognising their own data. */
            detected_columns: {
                index: number;
                header?: string | null;
                sample?: string | null;
            }[];
            column_mapping?: {
                email: number;
                given_name?: number | null;
                family_name?: number | null;
                role?: number | null;
            } | null;
            default_role?: components["schemas"]["InvitationRole"];
            /** @description The counted preview, and after execution the counted outcome. */
            summary?: {
                ready?: number;
                already_member?: number;
                already_invited?: number;
                duplicate?: number;
                invalid?: number;
                invited?: number;
                failed?: number;
            };
            seats_used_after?: number | null;
            seats_included?: number | null;
            /**
             * @description Active staging rows in source-line order. After execution, successful, duplicate and
             *     skipped rows are removed; a partial failure returns only rows that can still be
             *     retried. A completed or discarded import returns an empty array.
             */
            rows?: {
                line: number;
                email?: string | null;
                role?: components["schemas"]["InvitationRole"];
                status: components["schemas"]["MemberImportRowStatus"];
                /** @description Stable code the console maps to a copy key. Never prose. */
                reason_code?: string | null;
                /** Format: uuid */
                invitation_id?: string | null;
            }[];
            /** Format: uuid */
            created_by?: string;
            /**
             * Format: date-time
             * @description Fixed seven-day ceiling for personal staging data; deletion may happen earlier on completion or discard.
             */
            staging_expires_at: string;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * AvailabilityDay
         * @description One day of the availability strip. Counted from probe results, so a tenant whose agent went
         *     quiet does not appear to have been down: staleness is a flag, never an outage.
         * @example {
         *       "date": "2026-12-03",
         *       "components": [
         *         {
         *           "key": "calls",
         *           "state": "degraded",
         *           "degraded_minutes": 42,
         *           "down_minutes": 0
         *         },
         *         {
         *           "key": "web",
         *           "state": "operational",
         *           "degraded_minutes": 0,
         *           "down_minutes": 0
         *         }
         *       ]
         *     }
         */
        AvailabilityDay: {
            /** Format: date */
            date: string;
            components: {
                /** @enum {string} */
                key: "web" | "calls" | "documents" | "console" | "identity" | "mail";
                /** @enum {string} */
                state: "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance" | "no_data";
                degraded_minutes: number;
                down_minutes: number;
            }[];
        };
        /**
         * Incident
         * @description Something visible went wrong, with the updates published while it lasted. Every customer
         *     facing string is a message-catalogue key from a closed set, so an operator's shorthand
         *     never reaches a customer's screen and the wording is translated once.
         * @example {
         *       "id": "3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e",
         *       "reference": "INC-2026-014",
         *       "scope": "tenant",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "state": "open",
         *       "severity": "major",
         *       "component_keys": [
         *         "calls"
         *       ],
         *       "title_key": "incident.calls.degraded",
         *       "impact_key": "incident.impact.calls_drop",
         *       "started_at": "2026-12-03T10:58:00Z",
         *       "resolved_at": null,
         *       "next_update_at": "2026-12-03T12:00:00Z",
         *       "updates": [
         *         {
         *           "at": "2026-12-03T11:05:00Z",
         *           "body_key": "incident.update.investigating"
         *         }
         *       ]
         *     }
         */
        Incident: {
            /** Format: uuid */
            id: string;
            /** @example INC-2026-014 */
            reference?: string | null;
            /** @enum {string} */
            scope?: "platform" | "tenant";
            /** Format: uuid */
            tenant_id?: string | null;
            /** @enum {string} */
            state: "open" | "monitoring" | "resolved";
            /** @enum {string} */
            severity?: "minor" | "major" | "critical";
            component_keys: ("web" | "calls" | "documents" | "console" | "identity" | "mail")[];
            title_key: string;
            impact_key?: string | null;
            /** Format: date-time */
            started_at: string;
            /** Format: date-time */
            resolved_at?: string | null;
            /**
             * Format: date-time
             * @description When the customer may expect the next update. Null once resolved.
             */
            next_update_at?: string | null;
            updates?: {
                /** Format: date-time */
                at: string;
                body_key: string;
            }[];
        };
        /**
         * ProvisioningStepLabel
         * @description The customer-facing grouping of the provisioning steps, closed on purpose. A tenant is built
         *     in sixteen internal steps; a customer is shown six, always the same six, in this order, and
         *     the console renders `console.status.overview.status-step-<value>` from its catalogue.
         *
         *     Internal step names never reach a customer: they name Scaleway projects, OpenTofu applies
         *     and Ansible roles, and they change when the profile changes.
         *
         *     | Value | Internal steps behind it |
         *     |---|---|
         *     | `order` | preflight of the order, profile render |
         *     | `server` | project, addresses, host |
         *     | `apps` | host configuration, application stack |
         *     | `addresses` | platform DNS, mail domain, certificates |
         *     | `accounts` | realm creation, secrets, agent enrolment |
         *     | `backups` | storage, observability, first backup, handover |
         * @example apps
         * @enum {string}
         */
        ProvisioningStepLabel: "order" | "server" | "apps" | "addresses" | "accounts" | "backups";
        /**
         * DomainFailureCode
         * @description Why a domain check failed. Closed, because each value maps to one copy key, one list of
         *     likely causes and one next action; the console never renders a resolver's raw output, and a
         *     value outside this set is a defect in the worker, not a new message on screen.
         *
         *     | Check | Codes |
         *     |---|---|
         *     | `syntax` | `invalid_fqdn`, `reserved_name`, `already_claimed` |
         *     | `nonce_txt` | `txt_absent`, `txt_mismatch`, `nxdomain`, `servfail`, `nonce_expired` |
         *     | `caa` | `caa_forbids_issuance` |
         *     | `target` | `target_mismatch`, `unresolved`, `cname_chain_too_long` |
         *     | `reachability` | `edge_unreachable`, `wrong_edge` |
         *     | `certificate` | `no_certificate`, `chain_invalid`, `expiring` |
         *     | `media_sync` | `media_cert_stale`, `media_reload_failed` |
         *     | `application` | `not_in_allowed_hosts`, `not_in_redirect_uris`, `default_vhost` |
         *     | any | `resolver_unavailable`, `rate_limited` |
         * @example txt_absent
         * @enum {string}
         */
        DomainFailureCode: "invalid_fqdn" | "reserved_name" | "already_claimed" | "txt_absent" | "txt_mismatch" | "nxdomain" | "servfail" | "nonce_expired" | "caa_forbids_issuance" | "target_mismatch" | "unresolved" | "cname_chain_too_long" | "edge_unreachable" | "wrong_edge" | "no_certificate" | "chain_invalid" | "expiring" | "media_cert_stale" | "media_reload_failed" | "not_in_allowed_hosts" | "not_in_redirect_uris" | "default_vhost" | "resolver_unavailable" | "rate_limited";
        /**
         * DomainPatchRequest
         * @description The only patchable member is `is_canonical`, and it may be set to `true` only on a domain in
         *     state `live`. Making a host canonical changes the invitation links, the application's base
         *     URL and the realm client's default redirect; the previously canonical host keeps serving.
         * @example {
         *       "is_canonical": true
         *     }
         */
        DomainPatchRequest: {
            /** @constant */
            is_canonical?: true;
        };
        /**
         * DomainInstructions
         * @description The forwardable instruction sheet, as data. The person who edits the DNS zone is usually not
         *     the person in the console, and they need exact records, not a screenshot. Every sentence is
         *     a message key so the sheet is translated once and stays right when a record changes.
         * @example {
         *       "domain_id": "b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c",
         *       "fqdn": "visio.acme.fr",
         *       "records": [
         *         {
         *           "purpose": "ownership",
         *           "record_type": "TXT",
         *           "record_name": "_kodera-verify.visio.acme.fr",
         *           "record_value": "kodera-verify=00000000000000000000000000000000000000000000fake",
         *           "ttl_s": 300,
         *           "published": true
         *         },
         *         {
         *           "purpose": "web_target",
         *           "record_type": "CNAME",
         *           "record_name": "visio.acme.fr",
         *           "record_value": "acme.visio.kodera.io.",
         *           "ttl_s": 300,
         *           "published": false
         *         }
         *       ],
         *       "steps": [
         *         {
         *           "index": 1,
         *           "body_key": "domain.instructions.publish_txt",
         *           "record_purpose": "ownership"
         *         },
         *         {
         *           "index": 2,
         *           "body_key": "domain.instructions.publish_target",
         *           "record_purpose": "web_target"
         *         }
         *       ],
         *       "nonce_expires_at": "2026-12-06T09:00:00Z",
         *       "download": null
         *     }
         */
        DomainInstructions: {
            /** Format: uuid */
            domain_id: string;
            fqdn: string;
            /** @description Every record to publish, in the order they must be published. */
            records: {
                /** @enum {string} */
                purpose: "ownership" | "web_target" | "media_target";
                /** @enum {string} */
                record_type: "TXT" | "CNAME" | "A";
                record_name: string;
                record_value: string;
                /** @description Recommended, not required. A longer existing TTL only delays the first check. */
                ttl_s?: number;
                /** @description What we last observed, so the sheet says what is left to do. */
                published?: boolean;
            }[];
            steps: {
                index: number;
                body_key: string;
                /** @enum {string|null} */
                record_purpose?: "ownership" | "web_target" | "media_target" | null;
            }[];
            /** Format: date-time */
            nonce_expires_at?: string | null;
            /** @description Short-lived link to the PDF of the same sheet. Null while it is being rendered. */
            download?: components["schemas"]["DownloadLink"] | null;
        };
        /**
         * InstructionShareRequest
         * @description Who to send the sheet to, and an optional line of context from the sender. The note is
         *     customer prose; it is included verbatim in the mail and is never parsed.
         * @example {
         *       "recipient_email": "it@acme.fr",
         *       "note": "Bonjour, pouvez-vous publier ces enregistrements ?",
         *       "locale": "fr"
         *     }
         */
        InstructionShareRequest: {
            /** Format: email */
            recipient_email: string;
            note?: string | null;
            /** @enum {string} */
            locale?: "fr" | "en";
        };
        /**
         * InstructionShare
         * @description Evidence that the sheet was handed to the mail provider, so the console can say "sent to
         *     it@acme.fr at 10:02" rather than a bare confirmation. Delivery is not acknowledged here.
         * @example {
         *       "id": "6d7e8f90-a1b2-4c3d-8e4f-5a6b7c8d9e0f",
         *       "recipient_email": "it@acme.fr",
         *       "sent_at": "2026-12-03T10:02:11Z",
         *       "sent_by": "11111111-2222-4333-8444-555555555555"
         *     }
         */
        InstructionShare: {
            /** Format: uuid */
            id: string;
            /** Format: email */
            recipient_email: string;
            /** Format: date-time */
            sent_at: string;
            /** Format: uuid */
            sent_by?: string;
        };
        /**
         * HelpContext
         * @description What the help entry offers on one screen: the articles that match it, what the customer's
         *     plan entitles them to, and the incident that may already explain what they are seeing.
         *     Composed server-side so a renamed article does not leave a dead link in a released console.
         * @example {
         *       "area": "domain",
         *       "screen": "verify",
         *       "articles": [
         *         {
         *           "id": "dns-txt",
         *           "title": "Publier un enregistrement TXT",
         *           "url": "https://aide.kodera.io/dns-txt"
         *         }
         *       ],
         *       "sla": {
         *         "support_tier": "standard",
         *         "first_response_target_minutes": 240,
         *         "business_hours_label": "09:00-18:00 Europe/Paris, lundi au vendredi",
         *         "business_hours_timezone": "Europe/Paris",
         *         "next_response_due_at": "2026-12-03T15:31:00Z"
         *       },
         *       "incident": null
         *     }
         */
        HelpContext: {
            area: components["schemas"]["ConsoleArea"];
            screen?: string | null;
            articles: {
                id: string;
                title: string;
                /** Format: uri */
                url: string;
            }[];
            /** @description What the plan promises. The console states it rather than implying it. */
            sla?: {
                /** @enum {string} */
                support_tier?: "standard" | "business" | "critical";
                first_response_target_minutes?: number;
                /** @example 09:00-18:00 Europe/Paris, lundi au vendredi */
                business_hours_label?: string;
                /** @example Europe/Paris */
                business_hours_timezone?: string;
                /**
                 * Format: date-time
                 * @description When a ticket opened right now would be answered, computed from the tier and the
                 *     business hours including the out-of-hours case. The console renders it; it never
                 *     computes it, because it does not know the calendar of French public holidays.
                 */
                next_response_due_at?: string | null;
            };
            /** @description An open incident touching this screen's area, when there is one. */
            incident?: components["schemas"]["Incident"] | null;
        };
        /**
         * TicketContext
         * @description Exactly what a ticket opened from this screen would carry. The console shows it before the
         *     customer sends it, and sends back only the codes still ticked, so the checkbox list is
         *     truthful rather than reassuring.
         *
         *     Nothing here is meeting content, document content, a room name or a participant list.
         *     `value_summary` is already redacted.
         * @example {
         *       "area": "domain",
         *       "screen": "verify",
         *       "items": [
         *         {
         *           "code": "organisation",
         *           "label_key": "support.context.organisation",
         *           "value_summary": "ACME",
         *           "removable": false
         *         },
         *         {
         *           "code": "last_request_id",
         *           "label_key": "support.context.request_id",
         *           "value_summary": "019467a3-0f9b-7cc3-98c2-1fa48f28f562",
         *           "removable": true
         *         }
         *       ]
         *     }
         */
        TicketContext: {
            area: components["schemas"]["ConsoleArea"];
            screen?: string | null;
            items: {
                code: string;
                label_key: string;
                value_summary?: string | null;
                /**
                 * @description False for the items without which a ticket cannot be routed at all, the
                 *     organisation and the tenant. The console renders those ticked and disabled.
                 */
                removable: boolean;
            }[];
        };
        /**
         * SignInProblemRequest
         * @description Submitted by someone who cannot authenticate, so it carries no token and nothing it asserts
         *     about identity is trusted. The response is `202` for every input, valid or not.
         * @example {
         *       "email": "julie@acme.fr",
         *       "organisation_hint": "ACME",
         *       "body": "Je ne reçois pas le code à six chiffres depuis ce matin.",
         *       "locale": "fr"
         *     }
         */
        SignInProblemRequest: {
            /** Format: email */
            email: string;
            /** @description Whatever the person types: a slug, a company name, a domain. Never used for authorisation. */
            organisation_hint?: string | null;
            body: string;
            /** @enum {string} */
            locale?: "fr" | "en";
        };
        /**
         * TicketMessageCreateRequest
         * @example {
         *       "body": "Le problème est revenu ce matin à 9h10."
         *     }
         */
        TicketMessageCreateRequest: {
            body: string;
        };
        /**
         * TicketMessage
         * @description One message on a ticket. `author_kind` is `customer` or `staff`; the author's name is
         *     shown, their email is not, because a ticket is often read in a shared screen.
         * @example {
         *       "id": "7f8a9b0c-1d2e-4f30-8a41-5b6c7d8e9f01",
         *       "ticket_id": "f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c",
         *       "author_kind": "staff",
         *       "author_name": "Support Kodera",
         *       "body": "Nous avons identifié la cause et déployons un correctif.",
         *       "attachments": [],
         *       "created_at": "2026-12-03T12:04:00Z"
         *     }
         */
        TicketMessage: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            ticket_id: string;
            /** @enum {string} */
            author_kind: "customer" | "staff";
            author_name?: string | null;
            body: string;
            attachments?: components["schemas"]["TicketAttachment"][];
            /** Format: date-time */
            created_at: string;
        };
        /**
         * TicketAttachmentCreateRequest
         * @example {
         *       "file": "<binary PNG>",
         *       "message_id": "7f8a9b0c-1d2e-4f30-8a41-5b6c7d8e9f01"
         *     }
         */
        TicketAttachmentCreateRequest: {
            /**
             * Format: binary
             * @description At most 10 MB. Scanned before it reaches the helpdesk.
             */
            file: string;
            /**
             * Format: uuid
             * @description Attach to an existing message rather than to the ticket.
             */
            message_id?: string;
        };
        /**
         * TicketAttachment
         * @description `scanning` until the file has been checked; `available` once it has. A rejected file never
         *     costs the customer their message, because the ticket exists before the attachment does.
         * @example {
         *       "id": "8a9b0c1d-2e3f-4041-8b52-6c7d8e9f0a12",
         *       "filename": "capture.png",
         *       "content_type": "image/png",
         *       "size_bytes": 184213,
         *       "state": "available",
         *       "rejection_code": null,
         *       "download": null,
         *       "created_at": "2026-12-03T11:32:00Z"
         *     }
         */
        TicketAttachment: {
            /** Format: uuid */
            id: string;
            filename: string;
            content_type?: string;
            size_bytes: number;
            /** @enum {string} */
            state: "scanning" | "available" | "rejected";
            /** @enum {string|null} */
            rejection_code?: "too_large" | "unsupported_type" | "malware_detected" | null;
            download?: components["schemas"]["DownloadLink"] | null;
            /** Format: date-time */
            created_at: string;
        };
        /**
         * FederationProviderKind
         * @description The identity providers the guided setup supports at launch. Anything else is a support
         *     request, because a guided setup that has not been walked through end to end is worse than
         *     no guided setup.
         * @example microsoft
         * @enum {string}
         */
        FederationProviderKind: "google" | "microsoft";
        /**
         * FederationProviderState
         * @description ```
         *     draft ──▶ configured ──▶ active ──▶ disabled
         *     ```
         *
         *     | State | Meaning |
         *     |---|---|
         *     | `draft` | the generated values exist, no credential has been saved, nothing is applied to the realm |
         *     | `configured` | a client id and secret are stored and a test can be run; still nothing applied |
         *     | `active` | the identity provider is in the organisation's realm and people can sign in through it |
         *     | `disabled` | it was removed from the realm; accounts are back to hosted sign-in, history kept |
         * @example configured
         * @enum {string}
         */
        FederationProviderState: "draft" | "configured" | "active" | "disabled";
        /**
         * FederationLoginMode
         * @description `both` shows the provider button beside the hosted sign-in form. `redirect` sends everyone
         *     straight to the provider, which is the mode that can lock an organisation out of its own
         *     console, so activation refuses it without a successful test and a hosted owner account.
         * @example both
         * @enum {string}
         */
        FederationLoginMode: "both" | "redirect";
        /**
         * FederationFailureCode
         * @description Why a federation test failed. Closed, because each value maps to one copy key and to the
         *     mistake most often behind it: `redirect_uri_mismatch` is a paste error, `invalid_secret` is
         *     a rotated secret, `domain_not_allowed` is a person signing in with the wrong address. The
         *     provider's own message is kept server-side for support and never rendered.
         * @example redirect_uri_mismatch
         * @enum {string}
         */
        FederationFailureCode: "invalid_client" | "invalid_secret" | "redirect_uri_mismatch" | "consent_required" | "tenant_mismatch" | "domain_not_allowed" | "domain_not_verified" | "provider_unreachable" | "token_expired" | "user_cancelled" | "provider_error";
        /**
         * FederationValues
         * @description What the customer pastes into Google Workspace or Microsoft Entra. Generated here, never
         *     typed by the customer: a redirect URI with one wrong character is the most common reason a
         *     federation never works, and it produces an error message that names neither the URI nor the
         *     typo.
         * @example {
         *       "application_name": "Kodera — ACME",
         *       "redirect_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint",
         *       "logout_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint/logout",
         *       "scopes": [
         *         "openid",
         *         "profile",
         *         "email"
         *       ],
         *       "account_types_label_key": "federation.microsoft.account_types.single_tenant",
         *       "issuer_url": "https://login.microsoftonline.com/common/v2.0",
         *       "entity_id": null,
         *       "acs_url": null
         *     }
         */
        FederationValues: {
            application_name: string;
            /** Format: uri */
            redirect_uri: string;
            /** Format: uri */
            logout_uri: string;
            scopes: string[];
            /** @description Which account types to allow, as a message key; the wording differs per provider. */
            account_types_label_key?: string;
            /** Format: uri */
            issuer_url?: string | null;
            /**
             * Format: uri
             * @description SAML only. Null for the OIDC setups supported at launch.
             */
            entity_id?: string | null;
            /**
             * Format: uri
             * @description SAML only.
             */
            acs_url?: string | null;
        };
        /**
         * FederationProvider
         * @description One brokered identity provider on an organisation's realm. The console never calls Keycloak, Google
         *     or Microsoft: everything here is applied to the realm server-side by a `realm_update` job
         *     (console ADR-0003).
         *
         *     The client secret is write-only and appears nowhere in this schema. `secret_set` and
         *     `secret_expires_on` are all the console needs to warn before it lapses.
         * @example {
         *       "id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
         *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
         *       "provider": "microsoft",
         *       "state": "configured",
         *       "label": "Microsoft ACME",
         *       "login_mode": "both",
         *       "allowed_email_domains": [
         *         "acme.fr"
         *       ],
         *       "domain_checks": [
         *         {
         *           "domain": "acme.fr",
         *           "verified": true,
         *           "checked_at": "2026-12-03T09:14:22Z",
         *           "failure_code": null
         *         }
         *       ],
         *       "values": {
         *         "application_name": "Kodera — ACME",
         *         "redirect_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint",
         *         "logout_uri": "https://id.kodera.io/realms/acme-sa/broker/microsoft/endpoint/logout",
         *         "scopes": [
         *           "openid",
         *           "profile",
         *           "email"
         *         ],
         *         "account_types_label_key": "federation.microsoft.account_types.single_tenant",
         *         "issuer_url": "https://login.microsoftonline.com/common/v2.0",
         *         "entity_id": null,
         *         "acs_url": null
         *       },
         *       "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
         *       "secret_set": true,
         *       "secret_expires_on": "2027-06-30",
         *       "last_test": {
         *         "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
         *         "result": "failed",
         *         "at": "2026-12-03T11:02:00Z"
         *       },
         *       "hosted_account_count": 14,
         *       "job_id": null,
         *       "activated_at": null,
         *       "disabled_at": null,
         *       "created_at": "2026-12-03T10:40:00Z",
         *       "updated_at": "2026-12-03T11:02:00Z"
         *     }
         */
        FederationProvider: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            tenant_id: string;
            provider: components["schemas"]["FederationProviderKind"];
            state: components["schemas"]["FederationProviderState"];
            /** @description What the sign-in button says. Defaults to the provider name. */
            label?: string | null;
            login_mode: components["schemas"]["FederationLoginMode"];
            /**
             * @description A sign-in through this provider is accepted only for these domains. A person whose
             *     address is outside them is refused with `domain_not_allowed` rather than silently given
             *     an account, which is what stops a personal Google account from entering the tenant.
             */
            allowed_email_domains: string[];
            /** @description Whether each claimed domain has been proven to belong to this organisation. */
            domain_checks?: {
                domain: string;
                verified: boolean;
                /** Format: date-time */
                checked_at?: string | null;
                failure_code?: components["schemas"]["DomainFailureCode"] | null;
            }[];
            values: components["schemas"]["FederationValues"];
            client_id?: string | null;
            /** @description Whether a client secret is stored. The secret itself is never returned. */
            secret_set: boolean;
            /**
             * Format: date
             * @description What the provider says the secret expires on, so the console can warn before it lapses.
             */
            secret_expires_on?: string | null;
            /** @description The most recent test, so the overview can say when federation was last proven to work. */
            last_test?: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                result: "success" | "failed";
                /** Format: date-time */
                at: string;
            } | null;
            /**
             * @description How many people still sign in with a hosted account. It is the number the person must
             *     see before switching the organisation to `redirect`, and it is why the activation
             *     request echoes it back.
             */
            hosted_account_count?: number | null;
            /**
             * Format: uuid
             * @description The job currently applying this provider to the realm.
             */
            job_id?: string | null;
            /** Format: date-time */
            activated_at?: string | null;
            /** Format: date-time */
            disabled_at?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * FederationProviderCreateRequest
         * @example {
         *       "provider": "microsoft",
         *       "allowed_email_domains": [
         *         "acme.fr"
         *       ],
         *       "label": "Microsoft ACME",
         *       "locale": "fr"
         *     }
         */
        FederationProviderCreateRequest: {
            provider: components["schemas"]["FederationProviderKind"];
            allowed_email_domains: string[];
            label?: string | null;
            /**
             * @description Language of the runbook returned with the draft.
             * @enum {string}
             */
            locale?: "fr" | "en";
        };
        /**
         * FederationProviderPatchRequest
         * @description `login_mode` is deliberately absent: switching an organisation to redirect-only is the
         *     activation action, because it needs the hosted-account count in front of the person doing
         *     it and a successful test behind it.
         * @example {
         *       "allowed_email_domains": [
         *         "acme.fr",
         *         "acme.com"
         *       ]
         *     }
         */
        FederationProviderPatchRequest: {
            allowed_email_domains?: string[];
            label?: string | null;
        };
        /**
         * FederationCredentialsPatchRequest
         * @description Write-only. Nothing in this API ever returns `client_secret`, and it never appears in a log
         *     line, an audit event, an analytics event or an error message. A rejected save clears the
         *     field in the console rather than re-rendering the value.
         * @example {
         *       "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
         *       "client_secret": "<redacted>",
         *       "secret_expires_on": "2027-06-30"
         *     }
         */
        FederationCredentialsPatchRequest: {
            client_id?: string;
            /** @description Envelope-encrypted on arrival. Never returned, never logged, never echoed in a problem document. */
            client_secret?: string;
            /**
             * Format: date
             * @description What the provider says. Used only to warn the customer before it lapses.
             */
            secret_expires_on?: string | null;
        };
        /**
         * FederationCredentialStatus
         * @description The whole answer to "did the secret save". Never the secret.
         * @example {
         *       "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
         *       "client_id": "4f2a6c8e-0b2d-4f6a-8c0e-2b4d6f8a0c2e",
         *       "secret_set": true,
         *       "secret_expires_on": "2027-06-30",
         *       "state": "configured",
         *       "updated_at": "2026-12-03T10:52:00Z"
         *     }
         */
        FederationCredentialStatus: {
            /** Format: uuid */
            federation_provider_id: string;
            client_id: string;
            /** @constant */
            secret_set: true;
            /** Format: date */
            secret_expires_on?: string | null;
            state: components["schemas"]["FederationProviderState"];
            /** Format: date-time */
            updated_at?: string;
        };
        /**
         * FederationTestCreateRequest
         * @example {
         *       "return_url": "https://app.kodera.io/acme-sa/federation/test"
         *     }
         */
        FederationTestCreateRequest: {
            /**
             * Format: uri
             * @description Where the browser comes back to. Must be an `app.kodera.io` URL; anything else is refused.
             */
            return_url: string;
        };
        /**
         * FederationTest
         * @description A real sign-in, run against the provider, that creates no account and changes nobody else's
         *     sign-in. It is what turns "the secret is saved" into "it works", and activation can be
         *     refused until one has succeeded.
         *
         *     The tested address comes back masked so a result can be read out in a room; the provider's
         *     raw message stays server-side and the console gets a closed `failure_code` and a translated
         *     `provider_message_key`.
         * @example {
         *       "id": "a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70",
         *       "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
         *       "state": "completed",
         *       "authorization_url": null,
         *       "result": "failed",
         *       "subject_email_masked": "m****e@acme.fr",
         *       "display_name": "Marc Dubois",
         *       "domain_allowed": true,
         *       "failure_code": "redirect_uri_mismatch",
         *       "provider_message_key": "federation.error.redirect_uri_mismatch",
         *       "started_by": "11111111-2222-4333-8444-555555555555",
         *       "completed_at": "2026-12-03T11:02:00Z",
         *       "created_at": "2026-12-03T11:01:12Z"
         *     }
         */
        FederationTest: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            federation_provider_id: string;
            /** @enum {string} */
            state: "pending" | "completed" | "expired";
            /**
             * Format: uri
             * @description Where the console sends the browser. Single use, valid 10 minutes, null once the test has completed.
             */
            authorization_url?: string | null;
            /** @enum {string|null} */
            result?: "success" | "failed" | null;
            /** @example m****e@acme.fr */
            subject_email_masked?: string | null;
            display_name?: string | null;
            /** @description Whether the signed-in address is in `allowed_email_domains`. */
            domain_allowed?: boolean | null;
            failure_code?: components["schemas"]["FederationFailureCode"] | null;
            /** @description Translated key. Never the provider's own string. */
            provider_message_key?: string | null;
            /** Format: uuid */
            started_by?: string;
            /** Format: date-time */
            completed_at?: string | null;
            /** Format: date-time */
            created_at: string;
        };
        /**
         * FederationActivateRequest
         * @description `acknowledged_hosted_accounts` must equal the count the console showed the person. A stale
         *     number means the screen they confirmed is not the world they are confirming, and the call is
         *     refused with `conflict` rather than redirecting more people than they agreed to.
         * @example {
         *       "login_mode": "both",
         *       "acknowledged_hosted_accounts": 14
         *     }
         */
        FederationActivateRequest: {
            login_mode: components["schemas"]["FederationLoginMode"];
            acknowledged_hosted_accounts: number;
        };
        /**
         * FederationRunbook
         * @description The procedure to follow in the provider's own admin console, as an ordered list of message
         *     keys. No step is free prose, so it is translated once and stays correct when a generated
         *     value changes; `value_ref` names which member of `FederationValues` a step refers to, and
         *     the console renders that value inline and copyable.
         * @example {
         *       "federation_provider_id": "9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20",
         *       "provider": "microsoft",
         *       "locale": "fr",
         *       "steps": [
         *         {
         *           "index": 1,
         *           "body_key": "federation.microsoft.runbook.open_entra",
         *           "value_ref": null,
         *           "caution_key": null
         *         },
         *         {
         *           "index": 2,
         *           "body_key": "federation.microsoft.runbook.new_registration",
         *           "value_ref": "application_name",
         *           "caution_key": null
         *         },
         *         {
         *           "index": 3,
         *           "body_key": "federation.microsoft.runbook.paste_redirect",
         *           "value_ref": "redirect_uri",
         *           "caution_key": "federation.microsoft.runbook.caution_trailing_slash"
         *         }
         *       ],
         *       "estimated_duration_s": 900,
         *       "download": null
         *     }
         */
        FederationRunbook: {
            /** Format: uuid */
            federation_provider_id: string;
            provider: components["schemas"]["FederationProviderKind"];
            /** @enum {string} */
            locale?: "fr" | "en";
            steps: {
                index: number;
                body_key: string;
                /** @enum {string|null} */
                value_ref?: "application_name" | "redirect_uri" | "logout_uri" | "scopes" | "account_types_label_key" | "issuer_url" | "entity_id" | "acs_url" | null;
                caution_key?: string | null;
            }[];
            estimated_duration_s?: number | null;
            /** @description Short-lived link to the PDF of the same procedure. Null while it is being rendered. */
            download?: components["schemas"]["DownloadLink"] | null;
        };
        /**
         * MePatchRequest
         * @description The two things a person may change about themselves without an administrator: the language
         *     the console and their notification emails use, and the name colleagues see. Everything else
         *     about an identity belongs to Keycloak or to a membership.
         * @example {
         *       "locale": "en",
         *       "display_name": "Julie Marchand"
         *     }
         */
        MePatchRequest: {
            /** @enum {string} */
            locale?: "fr" | "en";
            display_name?: string | null;
        };
        /**
         * @example {
         *       "id": "7c2b1a09-3e4d-4f5a-8b6c-9d0e1f2a3b4c",
         *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
         *       "person_id": "11111111-2222-4333-8444-555555555555",
         *       "identity_id": "3a7c9e1b-2d4f-4a6b-8c0d-1e2f3a4b5c6d",
         *       "email": "julie@acme.fr",
         *       "display_name": "Julie Marchand",
         *       "role": "org_owner",
         *       "state": "active",
         *       "source": "order",
         *       "account_kind": "hosted",
         *       "mfa_enrolled": true,
         *       "last_seen_at": "2026-12-01T08:41:12Z",
         *       "created_at": "2026-11-04T14:02:00Z",
         *       "updated_at": "2026-12-01T08:41:12Z",
         *       "can_change_role": false,
         *       "can_remove": false,
         *       "blocked_reason": "last_owner",
         *       "invitation_id": null
         *     }
         */
        MembershipDetail: components["schemas"]["Membership"] & {
            can_change_role: boolean;
            can_remove: boolean;
            /**
             * @description Why both flags are false, so the tooltip says which rule applies.
             * @enum {string|null}
             */
            blocked_reason?: "last_owner" | "self" | "staff_managed" | null;
            /**
             * Format: uuid
             * @description The invitation this membership came from, while it is still `invited`.
             */
            invitation_id?: string | null;
        };
    };
    responses: {
        /** @description The request body or its parameters are malformed. */
        MalformedRequest: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /**
         * @description No token, an expired token, or a token this API cannot verify, an unknown realm or issuer
         *     included (`docs/api/AUTHZ.md` §2, steps 1 to 5). A token that verifies is never `401`.
         */
        Unauthenticated: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                /** @description The challenge, naming the realm the caller should authenticate against. */
                "WWW-Authenticate"?: string;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /**
         * @description A valid token whose roles do not allow this operation on this resource (`forbidden`), or
         *     `identity-unknown`: a verified customer token whose `(iss, sub)` names no enabled,
         *     undeleted customer identity of an enabled, undeleted person (`docs/api/AUTHZ.md` §2, step
         *     6), such as a realm account Core never bound. Signing in again yields the same answer, so
         *     a client routes the person to "no organisation yet" rather than to sign-in. The one named
         *     exception is the `invited` principal on `acceptInvitation`: unknown to Core by design, it
         *     is handled by that operation and never answered `identity-unknown`. A staff token is never
         *     `identity-unknown`. Neither type carries `WWW-Authenticate`. No identity is created by the
         *     request.
         */
        Forbidden: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /**
         * @description No such resource, or a resource the caller may not see. The two are deliberately
         *     indistinguishable so that ids cannot be probed across organisations.
         */
        NotFound: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The resource is not in a state that allows this operation, or a uniqueness rule is broken. */
        Conflict: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Syntactically valid, semantically refused by a business rule. */
        ValidationError: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The body is over the endpoint's limit; `detail` names the limit. */
        PayloadTooLarge: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description The `Content-Type` is not one this endpoint accepts. */
        UnsupportedMediaType: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Too many requests. */
        RateLimited: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /**
         * @description The `PATCH` carried no `If-Match`. The client must read the resource, keep its `ETag` and
         *     send it back; a blind `PATCH` is refused rather than allowed to overwrite a concurrent
         *     change.
         */
        PreconditionRequired: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /**
         * @description The `If-Match` value is not the resource's current `ETag`: somebody else changed it since
         *     the read. `current_etag` carries the tag to re-read against.
         */
        PreconditionFailed: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                ETag: components["headers"]["ETag"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /**
         * @description Another structural change of the same workspace held it longer than this request's lock
         *     timeout; `service-unavailable`. `Retry-After` equals the body's `retry_after_s`; retry the
         *     same request, with the same `Idempotency-Key` for a `POST`.
         */
        WorkspaceBusy: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Retry-After": number;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description A third party this operation depends on (billing, payment, helpdesk) did not answer. */
        UpstreamUnavailable: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description An unhandled failure. The `request_id` is the only thing worth quoting. */
        InternalError: {
            headers: {
                "X-Request-Id": components["headers"]["XRequestId"];
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        ReportId: string;
        InviteLinkId: string;
        AttachmentId: string;
        DocumentId: string;
        DeviceId: string;
        /** @description Required compatibility header only for discoverRealm. Validate then discard. Every request is a fresh charged current lookup, including identical, different-body and concurrent reuse. This operation is explicitly exempt from generic 24-hour response replay, fingerprint, key-reuse and in-flight rules. No key or response is stored; no Idempotency-Replayed header or idempotency 409 is emitted. Other POST operations retain the generic IdempotencyKey parameter and rules. */
        DiscoveryCompatibilityKey: string;
        /**
         * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
         *     intention, not per HTTP attempt: the console generates it when the button is rendered and
         *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
         *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
         *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
         *
         *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
         *     the same key and the same body returns the first response verbatim, including its status,
         *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
         *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
         *
         *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
         *     character, nothing outside ASCII). A missing or empty header is
         *     `400 idempotency-key-missing`; any other value outside that rule is
         *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
         *
         *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
         *     caller of a generated method has to pass in. A code generator that honours the extension
         *     emits a key per request instead of adding a mandatory argument to every `POST` method
         *     that takes it; one that ignores it still gets a required header, which is what the wire
         *     needs. The extension changes no wire behaviour and is documented in
         *     `docs/api/CONVENTIONS.md` §8.
         */
        IdempotencyKey: string;
        /**
         * @description The `ETag` of the representation this change was computed against. Required on every
         *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
         *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
         *     re-applies rather than overwriting a change it never saw.
         *
         *     The example is the same value the `ETag` header returns, and is deliberately non-random
         *     for the reason given there.
         */
        IfMatch: string;
        /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
        Cursor: string;
        /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
        Limit: number;
        OrganisationId: string;
        MembershipId: string;
        CategoryId: string;
        ChannelId: string;
        EnrolmentTokenId: string;
        OrderId: string;
        SubscriptionId: string;
        InvoiceId: string;
        CreditNoteId: string;
        DpaId: string;
        TenantId: string;
        DomainId: string;
        TicketId: string;
        JobId: string;
        /** @description Identifier of one tenant VM, as reported by its agent. */
        InstanceId: string;
        InvitationId: string;
        MemberImportId: string;
        FederationProviderId: string;
        FederationTestId: string;
    };
    requestBodies: never;
    headers: {
        /**
         * @description Correlation id of the request, echoed here on every response including errors, carried into
         *     logs, audit events and error reports. Quote it in a support ticket and staff can find the
         *     exact request. Generated by the server (a UUIDv7) when the request carries none or an
         *     unsafe one; a caller's own id matching `^[A-Za-z0-9_-]{8,62}$` is answered as `c-` and that
         *     id, so it never passes for one the server generated. A `c-` id is the caller's choice and
         *     not unique: only a server-generated id identifies one request.
         */
        XRequestId: string;
        /** @description Seconds to wait before retrying. */
        RetryAfter: number;
        /**
         * @description Strong entity tag of this representation: `sha256` of the canonical serialisation of the
         *     resource's authoritative fields and its `updated_at`. Round-trip it as `If-Match` on the
         *     next `PATCH`. Collections carry none.
         *
         *     The example is deliberately non-random so a secret scanner does not flag it once it is copied into a generated file; a real value is a full digest.
         */
        ETag: string;
        /**
         * @description `true` on a response replayed from the `Idempotency-Key` store (`docs/api/CONVENTIONS.md`
         *     §8), whatever its status, and sent on nothing else: never on a first answer, never on an
         *     operation that does not take `Idempotency-Key`. A shared response such as `Conflict`
         *     declares it because keyed `POST` operations use that response too; on a `GET`, `PATCH`,
         *     `DELETE`, `discoverRealm` or `previewInvitation` it is never present. Its value is never
         *     `false`.
         */
        IdempotencyReplayed: "true";
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getMe: {
        parameters: {
            query?: never;
            header?: {
                /** @description Evaluated only after current authorization; matching returns an empty 304. */
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller. */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            /** @description Current authorized projection matches; no response body. */
            304: {
                headers: {
                    "Cache-Control"?: "no-store";
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    patchMe: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["MePatchRequest"];
            };
        };
        responses: {
            /** @description The caller, updated. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
        };
    };
    discoverRealm: {
        parameters: {
            query?: never;
            header: {
                /** @description Required compatibility header only for discoverRealm. Validate then discard. Every request is a fresh charged current lookup, including identical, different-body and concurrent reuse. This operation is explicitly exempt from generic 24-hour response replay, fingerprint, key-reuse and in-flight rules. No key or response is stored; no Idempotency-Replayed header or idempotency 409 is emitted. Other POST operations retain the generic IdempotencyKey parameter and rules. */
                "Idempotency-Key": components["parameters"]["DiscoveryCompatibilityKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RealmDiscoveryRequest"];
            };
        };
        responses: {
            /** @description Fresh current zero/one/multiple result. No replay header. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RealmDiscoveryResult"];
                };
            };
            /** @description Malformed JSON, duplicate JSON keys, missing or invalid compatibility header. */
            400: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description A browser request refused from its headers, before any quota charge or body read; forbidden. Its Origin is not an exact allowed Console origin, or its Sec-Fetch-Site is cross-site. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Body exceeds 4096 bytes; payload-too-large with limit_bytes 4096. */
            413: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Content type is not application/json. */
            415: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Schema/approved ASCII format validation error with safe pointers/codes. */
            422: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Any evaluated shared quota exhausted; rate-limited and actual remaining wait, minimum one second. */
            429: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Equals body retry_after_s. */
                    "Retry-After"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unexpected failure; correlated, no internal or input details. */
            500: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Discovery dependency, HMAC, counter capacity or database unavailable; route-local service-unavailable; five-second backoff is not a recovery promise. */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description No HTTP response caching.
                     * @example no-store
                     */
                    "Cache-Control"?: "no-store";
                    /** @description Equals body retry_after_s. */
                    "Retry-After"?: 5;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Limit"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Remaining"?: number;
                    /** @description Tightest evaluated quota; reset is seconds. Omit if route prerequisite failed before quota evaluation; never fabricate counters. */
                    "RateLimit-Reset"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listOrganisations: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                /** @description Case-insensitive match on name, slug or billing email. */
                query?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of organisations. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Organisation"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
        };
    };
    createOrganisation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrganisationCreateRequest"];
            };
        };
        responses: {
            /** @description The organisation in `prospect`, and the bootstrap the intake started. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Opaque correlation reference for this committed intake operation.
                     * @example 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
                     */
                    "X-Operation-Ref": components["schemas"]["OperationReference"];
                    /**
                     * @description Canonical URL of the created organisation.
                     * @example /api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrganisationIntakeResult"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            /**
             * @description `slug-taken`: an organisation already holds the slug, or a concurrent intake reserved
             *     it first. Also `idempotency-key-reuse` and `idempotency-key-in-flight`.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Present if and only if the Problem `type` is `idempotency-key-in-flight`; absent
                     *     for `slug-taken` and `idempotency-key-reuse`.
                     * @example 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
                     */
                    "X-Operation-Ref"?: components["schemas"]["OperationReference"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
            /**
             * @description `intake-closed`: this database does not admit the intake yet
             *     (`docs/specs/FIRST_OWNER_BOOTSTRAP.md` §3.8). Not stored against the key.
             */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getOrganisation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The organisation. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Organisation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    patchOrganisation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["OrganisationPatchRequest"];
            };
        };
        responses: {
            /** @description The updated organisation. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Organisation"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
        };
    };
    getOrganisationBootstrap: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The bootstrap state. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrganisationBootstrap"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    getWorkspace: {
        parameters: {
            query?: never;
            header?: {
                /** @description Evaluated only after current authorisation and filtering; matching the caller's current view returns an empty 304. */
                "If-None-Match"?: string;
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The workspace structure visible to the caller, and the setup state. */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    /** @description Strong tag of this caller's rendered view, never of the stored workspace. */
                    ETag: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Workspace"];
                };
            };
            /** @description The caller's current view matches `If-None-Match`; no response body. */
            304: {
                headers: {
                    "Cache-Control"?: "no-store";
                    /** @description Strong tag of this caller's rendered view. */
                    ETag: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    instantClaimWorkspace: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InstantClaimTenantRequest"];
            };
        };
        responses: {
            /** @description The prepared workspace was assigned once. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstantClaimResponse"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
            /** @description No matching worker-prepared database allocation; retry the same key. */
            503: {
                headers: {
                    /** @description Present on Core's warm_pool_unavailable problem response. */
                    "Retry-After"?: number;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"] & {
                        /** @constant */
                        code: "warm_pool_unavailable";
                    };
                    "application/json": {
                        /** @constant */
                        code: "local-preview-only";
                    };
                };
            };
        };
    };
    initialiseWorkspace: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The workspace already existed; nothing was written. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the workspace; read it with `getWorkspace`.
                     * @example /api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f/workspace
                     */
                    Location: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceInitialisation"];
                };
            };
            /** @description The starter workspace was created by this request. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the workspace; read it with `getWorkspace`.
                     * @example /api/v1/organisations/6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f/workspace
                     */
                    Location: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceInitialisation"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    createCategory: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CategoryCreateRequest"];
            };
        };
        responses: {
            /** @description The category, created by this request. */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceAdminCategory"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    deleteCategory: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional on a deletion; when present it must be the current `ETag`, or `412 precondition-failed`. */
                "If-Match"?: string;
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                category_id: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The category was deleted. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    patchCategory: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                category_id: components["parameters"]["CategoryId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["CategoryPatchRequest"];
            };
        };
        responses: {
            /** @description The category after the change. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceAdminCategory"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    createChannel: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChannelCreateRequest"];
            };
        };
        responses: {
            /** @description The channel, created by this request. */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceAdminChannel"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    patchChannel: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["ChannelPatchRequest"];
            };
        };
        responses: {
            /** @description The channel after the change. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceAdminChannel"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    archiveChannel: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The channel, archived. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceAdminChannel"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    unarchiveChannel: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The channel, active. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceAdminChannel"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    getChannelAccess: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The channel's access. */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    /**
                     * @description Strong tag of the access: `sha256` over the channel, its `policy_mode`, the resolved
                     *     policy's id and its revision. Going explicit, inherit and explicit again creates a
                     *     new policy, so the tag changes even when a revision repeats.
                     */
                    ETag: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelAccess"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            /**
             * @description A stored row this read relies on is missing or out of its vocabulary, which is never
             *     guessed; `service-unavailable`. `Retry-After` equals the body's `retry_after_s`.
             */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Retry-After": number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    patchChannelAccess: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["ChannelAccessPatchRequest"];
            };
        };
        responses: {
            /** @description The channel's access after the change. */
            200: {
                headers: {
                    /** @description Strong tag of the access after the change. */
                    ETag: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelAccess"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            503: components["responses"]["WorkspaceBusy"];
        };
    };
    getWorkspaceAdministration: {
        parameters: {
            query?: never;
            header?: {
                /** @description Evaluated only after current authorisation; matching the current answer returns an empty 304. */
                "If-None-Match"?: string;
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The whole structure. */
            200: {
                headers: {
                    "Cache-Control"?: "no-store";
                    /** @description Strong tag of this rendered answer. */
                    ETag: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceAdministration"];
                };
            };
            /** @description The current answer matches `If-None-Match`; no response body. */
            304: {
                headers: {
                    "Cache-Control"?: "no-store";
                    /** @description Strong tag of this rendered answer. */
                    ETag: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            /**
             * @description A stored row this read relies on is missing or out of its vocabulary, which is never
             *     guessed; `service-unavailable`. `Retry-After` equals the body's `retry_after_s`.
             */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Retry-After": number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getNoticeContacts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The notice contacts. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NoticeContacts"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    patchNoticeContacts: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["NoticeContactsPatchRequest"];
            };
        };
        responses: {
            /** @description The notice contacts after the change. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NoticeContacts"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            412: components["responses"]["PreconditionFailed"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
            /**
             * @description The organisation is busy with another change; `service-unavailable`. Retry-After
             *     equals body `retry_after_s`; retry the same request.
             */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listMemberships: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                role?: components["schemas"]["OrganisationRole"];
                state?: components["schemas"]["MembershipState"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of memberships. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Membership"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getMembership: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                membership_id: components["parameters"]["MembershipId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The membership. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MembershipDetail"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    removeMembership: {
        parameters: {
            query?: never;
            header?: {
                /** @description Optional on a removal; when present it must be the current `ETag`, or `412 precondition-failed`. */
                "If-Match"?: string;
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                membership_id: components["parameters"]["MembershipId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The removed membership, without the person's contact fields, the same on a repeat. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Membership"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            500: components["responses"]["InternalError"];
        };
    };
    changeMembershipRole: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                membership_id: components["parameters"]["MembershipId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["MembershipPatchRequest"];
            };
        };
        responses: {
            /** @description The updated membership. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Membership"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
        };
    };
    listInvitations: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                state?: components["schemas"]["InvitationState"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of invitations. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Invitation"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    inviteToOrganisation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitationBatchRequest"];
            };
        };
        responses: {
            /** @description Per-row outcome of the batch. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationBatchResult"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    previewInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitationPreviewRequest"];
            };
        };
        responses: {
            /** @description The invitation card. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationPreview"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            /** @description `invitation-expired` or `invitation-revoked`: the person needs a new invitation. */
            410: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    acceptInvitation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitationAcceptRequest"];
            };
        };
        responses: {
            /** @description The membership created or confirmed by the acceptance. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Membership"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            /**
             * @description `invitation-expired` or `invitation-revoked`: the person needs a new invitation.
             *     Typed since 0.31.0; before, both were `invalid-state-transition`.
             */
            410: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    consumeOwnerClaim: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OwnerClaimConsumeRequest"];
            };
        };
        responses: {
            /** @description The organisation, now `active`, and the first `org_owner` membership. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnerClaimResult"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            /**
             * @description The caller may not consume this claim: `identity-unknown` for a verified customer
             *     token whose `(iss, sub)` names no enabled customer identity of an enabled person,
             *     `forbidden` for a principal that is neither `bootstrap` nor `org_owner`,
             *     `owner-claim-identity-mismatch` when the claim is bound to another identity of this
             *     realm, `mfa-required` when the token shows no second factor,
             *     `owner-claim-contact-unverified` when the realm has not verified the caller's contact.
             */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            404: components["responses"]["NotFound"];
            /**
             * @description `owner-claim-consumed` when the claim was already consumed, `invalid-state-transition`
             *     when the organisation is no longer `prospect`, or an `Idempotency-Key` conflict.
             */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description The claim expired or was revoked; the person needs a reissued claim. */
            410: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            /**
             * @description Temporary admission contention; service-unavailable, not stored.
             *     Retry-After equals body retry_after_s=1; retry the same logical operation.
             */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Retry-After"?: 1;
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listEnrolmentTokens: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                state?: components["schemas"]["EnrolmentTokenState"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of enrolment tokens. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["EnrolmentToken"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createEnrolmentToken: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnrolmentTokenCreateRequest"];
            };
        };
        responses: {
            /** @description The token, with its one-time secret. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnrolmentTokenCreated"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    revokeEnrolmentToken: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                enrolment_token_id: components["parameters"]["EnrolmentTokenId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listPlans: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                /** @description Staff tokens may request `draft` and `retired`; anonymous callers only see `published`. */
                state?: "draft" | "published" | "retired";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of plans. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Plan"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listPacks: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of packs. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Pack"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listCapacityTiers: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                /** @description Only the tiers offered with this pack. */
                pack_code?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of capacity tiers. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["CapacityTier"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listPrices: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                pack_code?: string;
                capacity_tier_code?: string;
                billing_period?: components["schemas"]["BillingPeriod"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of prices. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Price"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listOrders: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of orders. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Order"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    placeOrder: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrderRequest"];
            };
        };
        responses: {
            /** @description The order and everything it created. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the created order.
                     * @example /api/v1/orders/a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrderResult"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getOrder: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                order_id: components["parameters"]["OrderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The order. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Order"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    cancelOrder: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                order_id: components["parameters"]["OrderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The order, cancelled by this request or before it. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "id": "a1b2c3d4-e5f6-4718-8293-0a1b2c3d4e5f",
                     *       "organisation_id": "6f1d2e3c-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
                     *       "state": "cancelled",
                     *       "pack_code": "visio-docs",
                     *       "capacity_tier_code": "M",
                     *       "apps": [
                     *         "visio",
                     *         "docs"
                     *       ],
                     *       "billing_period": "yearly",
                     *       "price_snapshot": {
                     *         "price_id": "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
                     *         "plan_code": "essentiel",
                     *         "plan_version": 3,
                     *         "pack_code": "visio-docs",
                     *         "capacity_tier_code": "M",
                     *         "billing_period": "yearly",
                     *         "unit_amount_excl_vat": {
                     *           "amount_minor": 448800,
                     *           "currency": "EUR"
                     *         },
                     *         "quantity": 1,
                     *         "vat_regime": "fr_standard",
                     *         "vat_rate_bp": 2000,
                     *         "total_excl_vat": {
                     *           "amount_minor": 448800,
                     *           "currency": "EUR"
                     *         },
                     *         "vat_amount": {
                     *           "amount_minor": 89760,
                     *           "currency": "EUR"
                     *         },
                     *         "total_incl_vat": {
                     *           "amount_minor": 538560,
                     *           "currency": "EUR"
                     *         },
                     *         "captured_at": "2026-12-01T09:41:07Z"
                     *       },
                     *       "dpa_id": "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
                     *       "subscription_id": "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d",
                     *       "invoice_id": "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
                     *       "tenant_id": "2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
                     *       "purchase_order_ref": "BC-2026-118",
                     *       "placed_by": "11111111-2222-4333-8444-555555555555",
                     *       "created_at": "2026-12-01T09:41:07Z",
                     *       "updated_at": "2026-12-03T10:12:44Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Order"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    listSubscriptions: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                state?: components["schemas"]["SubscriptionState"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of subscriptions. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Subscription"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                subscription_id: components["parameters"]["SubscriptionId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The subscription. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Subscription"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listInvoices: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                state?: components["schemas"]["InvoiceState"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of invoices, most recently issued first. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Invoice"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getInvoice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoice_id: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The invoice. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Invoice"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listCreditNotes: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of credit notes, most recently issued first. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["CreditNote"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getCreditNote: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                credit_note_id: components["parameters"]["CreditNoteId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The credit note. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreditNote"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getInvoiceDownloadLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoice_id: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A short-lived link. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DownloadLink"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    getPaymentLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invoice_id: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The active payment link. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentLink"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createPaymentLink: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                invoice_id: components["parameters"]["InvoiceId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["PaymentLinkCreateRequest"];
            };
        };
        responses: {
            /** @description The payment link. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentLink"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
            502: components["responses"]["UpstreamUnavailable"];
        };
    };
    generateDpa: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DpaGenerateRequest"];
            };
        };
        responses: {
            /** @description The generated DPA. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Dpa"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getDpa: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                dpa_id: components["parameters"]["DpaId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The DPA. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Dpa"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    acceptDpa: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                dpa_id: components["parameters"]["DpaId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DpaAcceptRequest"];
            };
        };
        responses: {
            /** @description The accepted DPA. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Dpa"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    getDpaPdfLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                dpa_id: components["parameters"]["DpaId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A short-lived link to the PDF, with its SHA-256 so the customer can verify it. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DownloadLink"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listTenants: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                status?: components["schemas"]["TenantStatus"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of tenants. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Tenant"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createTenant: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TenantCreation"];
            };
        };
        responses: {
            /** @description The tenant, its agreements and its workspace were created by this request. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the tenant; read it with `getTenant`.
                     * @example /api/v1/tenants/2c9f0e7a-1b3d-4e5f-8a9b-0c1d2e3f4a5b
                     */
                    Location: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TenantCreated"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
            /**
             * @description This deployment has no workspace offer configured (the pack, its tier, or the CGV or
             *     DPA in force for the locale sent), so nothing is written; `service-unavailable`. `Retry-After` equals the
             *     body's `retry_after_s`.
             */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Retry-After": number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getTenant: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The tenant. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Tenant"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getTenantStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The status view of a tenant. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TenantStatusView"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listDomains: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                state?: components["schemas"]["DomainState"];
            };
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of domains. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Domain"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    addDomain: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DomainCreateRequest"];
            };
        };
        responses: {
            /** @description The domain, with the records to publish. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the created domain.
                     * @example /api/v1/domains/b3c4d5e6-f708-491a-8b2c-3d4e5f6a7b8c
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Domain"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getDomain: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The domain. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Domain"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    deleteDomain: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removal accepted, with the job that performs it. */
            202: {
                headers: {
                    /**
                     * @description Canonical URL of the job.
                     * @example /api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f
                     */
                    Location?: string;
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    patchDomain: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["DomainPatchRequest"];
            };
        };
        responses: {
            /** @description The updated domain. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Domain"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
        };
    };
    verifyDomain: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Verification pass accepted, with the job that runs it. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the job.
                     * @example /api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    createCommunitySupportTicket: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SupportTicketCreateRequest"];
            };
        };
        responses: {
            /** @description A persisted ticket and its zero-PII triage classification. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CommunitySupportTicketReceipt"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listSupportTickets: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                organisation_id?: string;
                tenant_id?: string;
                state?: components["schemas"]["TicketState"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of tickets with their tenant context. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["SupportTicket"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
        };
    };
    createSupportTicket: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SupportTicketCreateRequest"];
            };
        };
        responses: {
            /** @description The ticket. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the created ticket.
                     * @example /api/v1/support/tickets/f6a7b8c9-d0e1-4f2a-8b3c-4d5e6f7a8b9c
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SupportTicket"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            /**
             * @description This deployment names no support mailbox, so a ticket could not reach anyone and none
             *     is stored; `service-unavailable`. `Retry-After` equals the body's `retry_after_s`.
             */
            503: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Retry-After": number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSupportTicket: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ticket_id: components["parameters"]["TicketId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The ticket. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SupportTicket"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listStatusComponents: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                /** @description Restrict to the components of one tenant. Requires a token that can read that tenant. */
                tenant_id?: string;
                scope?: "platform" | "tenant";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of status components. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["StatusComponent"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listJobs: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                tenant_id?: string;
                kind?: components["schemas"]["JobKind"];
                status?: components["schemas"]["JobStatus"];
                created_after?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of jobs, most recent first. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Job"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
        };
    };
    getJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                job_id: components["parameters"]["JobId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The job. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Job"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    triggerTenantJob: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["JobTriggerRequest"];
            };
        };
        responses: {
            /** @description The job was enqueued. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the job.
                     * @example /api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Job"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getInstanceLogs: {
        parameters: {
            query?: {
                /** @description Only lines emitted at or after this instant. Defaults to one hour ago. */
                since?: string;
                until?: string;
                /** @description Restrict to the output of one command, as reported in its result. */
                log_ref?: string;
                /** @description Systemd unit or compose service name. */
                unit?: string;
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                /** @description Identifier of one tenant VM, as reported by its agent. */
                instance_id: components["parameters"]["InstanceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of log lines. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["LogLine"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listAuditEvents: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                organisation_id?: string;
                tenant_id?: string;
                actor_id?: string;
                /** @description Exact action key from the closed registry of `docs/domain/AUDIT_TAXONOMY.md` §3, for example `tenant.provision_requested`. */
                action?: string;
                occurred_after?: string;
                occurred_before?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of audit events, most recent first. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["AuditEvent"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
        };
    };
    createAgentEnrolmentToken: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentEnrolmentTokenCreateRequest"];
            };
        };
        responses: {
            /** @description The enrolment token, with its one-time secret. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentEnrolmentTokenCreated"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    checkSlugAvailability: {
        parameters: {
            query: {
                slug: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Whether the slug is free, with alternatives when it is not. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SlugAvailability"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listLegalDocuments: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                pack_code?: string;
                locale?: "fr" | "en";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The documents in force. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["LegalDocument"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    getLegalDocumentText: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: "cgv" | "dpa" | "sla" | "aup";
                version: string;
                locale: "fr" | "en";
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The text. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /** @description The document's `sha256`, quoted. */
                    ETag?: string;
                    /** @description `public, max-age=31536000, immutable`. */
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example # Conditions générales de vente
                     *
                     *     ## Article 1 — Parties et objet
                     */
                    "text/plain": string;
                };
            };
            400: components["responses"]["MalformedRequest"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    listEntitlements: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every entitlement, enabled or not. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Entitlement"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getOrganisationStatusSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The summary. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrganisationStatusSummary"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    getDunning: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The dunning view. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DunningView"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    countMemberships: {
        parameters: {
            query?: {
                role?: components["schemas"]["OrganisationRole"];
                state?: components["schemas"]["MembershipState"];
                account_kind?: components["schemas"]["MembershipAccountKind"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The count. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceCount"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    revokeInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_id: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    resendInvitation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                invitation_id: components["parameters"]["InvitationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The invitation, with the send counters updated. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Invitation"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description The invitation was accepted already, or an `Idempotency-Key` conflict. */
            409: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /**
             * @description `invitation-expired` or `invitation-revoked`: nothing is sent; invite the address again.
             *     Since 0.31.0; before, both were `409 conflict`.
             */
            410: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listMemberImports: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                state?: components["schemas"]["MemberImportState"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of imports. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["MemberImport"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createMemberImport: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["MemberImportCreateRequest"];
            };
        };
        responses: {
            /** @description The import, with the detected columns. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the created import.
                     * @example /api/v1/member-imports/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberImport"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            413: components["responses"]["PayloadTooLarge"];
            415: components["responses"]["UnsupportedMediaType"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getMemberImport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                member_import_id: components["parameters"]["MemberImportId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The import. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberImport"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    deleteMemberImport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                member_import_id: components["parameters"]["MemberImportId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Discarded. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    patchMemberImport: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                member_import_id: components["parameters"]["MemberImportId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["MemberImportPatchRequest"];
            };
        };
        responses: {
            /** @description The import with a fresh preview. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberImport"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
        };
    };
    executeMemberImport: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                member_import_id: components["parameters"]["MemberImportId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["MemberImportExecuteRequest"];
            };
        };
        responses: {
            /** @description Per-row outcome of the run, in submission order. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationBatchResult"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    listTenantAvailability: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                /** @description How many days back, ending today. Default 7. */
                days?: number;
            };
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of days, newest last. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["AvailabilityDay"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    listIncidents: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                tenant_id?: string;
                state?: "open" | "monitoring" | "resolved";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of incidents. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Incident"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    reissueDomainNonce: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Re-issue accepted, with the job that runs it. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the job.
                     * @example /api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    activateDomain: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accepted, with the job that performs it. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the job.
                     * @example /api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    getDomainInstructions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The instruction sheet. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DomainInstructions"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    shareDomainInstructions: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                domain_id: components["parameters"]["DomainId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InstructionShareRequest"];
            };
        };
        responses: {
            /** @description The share, with the moment it was handed to the mail provider. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstructionShare"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            502: components["responses"]["UpstreamUnavailable"];
        };
    };
    getHelpContext: {
        parameters: {
            query: {
                area: components["schemas"]["ConsoleArea"];
                screen?: string;
                locale?: "fr" | "en";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The help context. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HelpContext"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
        };
    };
    getTicketContext: {
        parameters: {
            query: {
                area: components["schemas"]["ConsoleArea"];
                screen?: string;
                /** @description The correlation id of the request that failed, so staff can find it. */
                request_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The context items. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TicketContext"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            500: components["responses"]["InternalError"];
        };
    };
    reportSignInProblem: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignInProblemRequest"];
            };
        };
        responses: {
            /** @description Received. Always this, whatever was submitted. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
        };
    };
    listTicketMessages: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                ticket_id: components["parameters"]["TicketId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of messages. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["TicketMessage"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    replyToTicket: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                ticket_id: components["parameters"]["TicketId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TicketMessageCreateRequest"];
            };
        };
        responses: {
            /** @description The message. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TicketMessage"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
            502: components["responses"]["UpstreamUnavailable"];
        };
    };
    attachToTicket: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                ticket_id: components["parameters"]["TicketId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["TicketAttachmentCreateRequest"];
            };
        };
        responses: {
            /** @description The attachment. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TicketAttachment"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            413: components["responses"]["PayloadTooLarge"];
            415: components["responses"]["UnsupportedMediaType"];
            500: components["responses"]["InternalError"];
        };
    };
    listFederationProviders: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                state?: components["schemas"]["FederationProviderState"];
            };
            header?: never;
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of providers. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["FederationProvider"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    createFederationProvider: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                tenant_id: components["parameters"]["TenantId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FederationProviderCreateRequest"];
            };
        };
        responses: {
            /** @description The draft provider, with its generated values and its runbook. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the created provider.
                     * @example /api/v1/federation-providers/9b0c1d2e-3f40-4152-8a63-7b8c9d0e1f20
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationProvider"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getFederationProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The provider. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationProvider"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    disableFederationProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accepted, with the job that applies it to the realm. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    /**
                     * @description Canonical URL of the job.
                     * @example /api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            500: components["responses"]["InternalError"];
        };
    };
    patchFederationProvider: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["FederationProviderPatchRequest"];
            };
        };
        responses: {
            /** @description The updated provider. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationProvider"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
        };
    };
    setFederationCredentials: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/merge-patch+json": components["schemas"]["FederationCredentialsPatchRequest"];
            };
        };
        responses: {
            /** @description Whether a secret is now set, and its expiry. Never the secret. */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationCredentialStatus"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            500: components["responses"]["InternalError"];
        };
    };
    listFederationTests: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description A page of tests. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["FederationTest"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    startFederationTest: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FederationTestCreateRequest"];
            };
        };
        responses: {
            /** @description The test, with the URL to send the browser to. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the created test.
                     * @example /api/v1/federation-tests/a1b2c3d4-5e6f-4708-8a19-2b3c4d5e6f70
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationTest"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getFederationTest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                federation_test_id: components["parameters"]["FederationTestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The test. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationTest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    activateFederationProvider: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FederationActivateRequest"];
            };
        };
        responses: {
            /** @description Accepted, with the job that applies it to the realm. */
            202: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    /**
                     * @description Canonical URL of the job.
                     * @example /api/v1/jobs/8b1f6d2e-4c3a-4b5d-9e0f-1a2b3c4d5e6f
                     */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobAccepted"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            500: components["responses"]["InternalError"];
        };
    };
    getFederationRunbook: {
        parameters: {
            query?: {
                locale?: "fr" | "en";
            };
            header?: never;
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The runbook. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FederationRunbook"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            500: components["responses"]["InternalError"];
        };
    };
    shareFederationRunbook: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                federation_provider_id: components["parameters"]["FederationProviderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InstructionShareRequest"];
            };
        };
        responses: {
            /** @description The share. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InstructionShare"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["RateLimited"];
            500: components["responses"]["InternalError"];
            502: components["responses"]["UpstreamUnavailable"];
        };
    };
    moderateWorkspaceMember: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceModerationRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceModeration"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    listAbuseReports: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["AbuseReport"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    createAbuseReport: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AbuseReportRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AbuseReport"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    resolveAbuseReport: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                report_id: components["parameters"]["ReportId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveAbuseReportRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AbuseReport"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            429: components["responses"]["RateLimited"];
        };
    };
    listWorkspaceInviteLinks: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                status?: "active" | "revoked" | "all";
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["WorkspaceInviteLink"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    createWorkspaceInviteLink: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceInviteLinkRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatedWorkspaceInviteLink"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    revokeWorkspaceInviteLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                invite_link_id: components["parameters"]["InviteLinkId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    previewWorkspaceInvite: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceInviteCodeRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceInvitePreview"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    redeemWorkspaceInvite: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceInviteCodeRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceInviteRedemption"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    createAttachmentUpload: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AttachmentUploadRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AttachmentUploadTicket"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    completeAttachmentUpload: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                attachment_id: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Attachment"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    getAttachment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                attachment_id: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Attachment"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    unfurlUrl: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UnfurlRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UnfurlResult"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            /** @description Blocked or private target. */
            403: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["UnfurlBlockedProblem"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    listNotifications: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["Notification"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    markNotificationsRead: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MarkNotificationsReadRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    getPushPublicKey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PushPublicKey"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    putPushSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PushSubscriptionRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    deletePushSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    listWorkspaceDocuments: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                /** @description Direct children of this parent; omitted returns all authorized pages as a flat tree with parentId edges. */
                parentId?: string;
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["WorkspaceDocument"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    createWorkspaceDocument: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceDocumentRequest"];
            };
        };
        responses: {
            /** @description Successful operation. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDocument"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    getWorkspaceDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                document_id: components["parameters"]["DocumentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDocument"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    deleteWorkspaceDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                document_id: components["parameters"]["DocumentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            204: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    updateWorkspaceDocument: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description The `ETag` of the representation this change was computed against. Required on every
                 *     `PATCH` (`docs/api/CONVENTIONS.md` §10 and §14). Absent: `428 precondition-required`.
                 *     Stale: `412 precondition-failed`, carrying the current tag, and the client re-reads and
                 *     re-applies rather than overwriting a change it never saw.
                 *
                 *     The example is the same value the `ETag` header returns, and is deliberately non-random
                 *     for the reason given there.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                document_id: components["parameters"]["DocumentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceDocumentPatch"];
            };
        };
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDocument"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            412: components["responses"]["PreconditionFailed"];
            422: components["responses"]["ValidationError"];
            428: components["responses"]["PreconditionRequired"];
            429: components["responses"]["RateLimited"];
        };
    };
    listDocumentBacklinks: {
        parameters: {
            query?: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                document_id: components["parameters"]["DocumentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["DocumentBacklink"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    createDocumentCollabSession: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated key that makes this `POST` safe to retry. Use a UUID v4 per user
                 *     intention, not per HTTP attempt: the console generates it when the button is rendered and
                 *     keeps it across retries. Retry with the **same** key only after a `5xx` or a network
                 *     failure, when the outcome is unknown; after any `4xx` the answer is final for that key and
                 *     is replayed as it was, so a new attempt, after the cause is fixed, takes a **new** key.
                 *
                 *     The API stores the key with a fingerprint of the request body for 24 hours. A replay with
                 *     the same key and the same body returns the first response verbatim, including its status,
                 *     with `Idempotency-Replayed: true`. A replay with the same key and a different body is
                 *     refused with `idempotency-key-reuse`, carrying `first_seen_at`.
                 *
                 *     The key is 16 to 255 visible ASCII characters (`0x21`–`0x7E`: no space, no control
                 *     character, nothing outside ASCII). A missing or empty header is
                 *     `400 idempotency-key-missing`; any other value outside that rule is
                 *     `400 malformed-request`, without `errors[]`, whose pointers address the body.
                 *
                 *     `x-kodera-client-generated` marks it as a value the **client** produces, not one the
                 *     caller of a generated method has to pass in. A code generator that honours the extension
                 *     emits a key per request instead of adding a mandatory argument to every `POST` method
                 *     that takes it; one that ignores it still gets a required header, which is what the wire
                 *     needs. The extension changes no wire behaviour and is documented in
                 *     `docs/api/CONVENTIONS.md` §8.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
                document_id: components["parameters"]["DocumentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            201: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    "Idempotency-Replayed": components["headers"]["IdempotencyReplayed"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentCollabSession"];
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
    searchWorkspace: {
        parameters: {
            query: {
                /** @description Opaque cursor from `next_cursor` of a previous page. Never construct one. */
                cursor?: components["parameters"]["Cursor"];
                /** @description Page size. The server may return fewer items than asked; trust `has_more`. */
                limit?: components["parameters"]["Limit"];
                q: string;
            };
            header?: never;
            path: {
                organisation_id: components["parameters"]["OrganisationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful operation. */
            200: {
                headers: {
                    "X-Request-Id": components["headers"]["XRequestId"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CursorPage"] & {
                        data?: components["schemas"]["WorkspaceSearchResult"][];
                    };
                };
            };
            400: components["responses"]["MalformedRequest"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["ValidationError"];
            429: components["responses"]["RateLimited"];
        };
    };
}
