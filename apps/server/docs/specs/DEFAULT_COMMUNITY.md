# Default community workspace

Status: Implemented

## Operator preparation

Apply migrations with the migration role. Configure the exact public trusted
community issuer in `KODERA_AUTH_TRUST`, then set:

- `KODERA_DEFAULT_COMMUNITY_ORG_SLUG=community`
- `KODERA_DEFAULT_COMMUNITY_ISSUER=https://identity.example.test/realms/community`
- `KODERA_DEFAULT_COMMUNITY_OWNER_USER_ID` to the existing enabled owner's person UUID.

Run `python manage.py bootstrap_community_workspace`. Alternatively pass the
owner UUID using `--owner-user-id`. First creation requires a real existing owner;
there is no synthetic administrator. Repeated runs preserve IDs and explicit
partner grants. Drift in canonical category visibility or channel category, kind,
lifecycle or policy mode fails with an operator-reconciliation error; bootstrap
does not silently accept a public private-room policy or alter custom resources.
Bootstrap also creates the canonical `community` Tenant with `apps=[messaging]`
and status `provisioning`. It never claims a homeserver is live. After the
operator verifies Synapse SSO, membership reconciliation and channel acknowledgements,
list its real ID with `python manage.py tenant_status --settings
config.settings.deploy_operator list`, enroll the agent with that `--tenant` ID,
and promote it using `python manage.py tenant_status --settings
config.settings.deploy_operator set --staff-identity <operator-identity>
--tenant <tenant-id> --to active --reason "Community backend acceptance verified"`.
The existing audited command requires a current staff operator grant. Until then
the web workspace stays in provisioning. The canonical tenant list admits current
community members from their actual issuer; all other tenant lists retain isolation.

The command queues membership and channel sets; the enrolled
tenant agent must acknowledge real rooms before messaging is ready. It is repeatable, and is
also the operator's way to queue the sets at once rather than at the agent's next poll.

The Community category contains announcements, general, developers-community,
support, extensions, self-hosting, show-and-tell and the office-hours audio room.
Announcements allows member history and reactions while posts require an
administrator. Core Kodera includes the private `kodera-git-tracker` channel for
operator-configured verified provider activity. Core Kodera is explicitly granted to community owners/admins;
Design Partners starts with no member grants. Assign partner access explicitly.

## The layout

| Category | Template key | Visibility | Channels |
|---|---|---|---|
| Community | `community` | organisation | `announcements`, `general`, `developers-community`, `support`, `extensions`, `self-hosting`, `show-and-tell`, `office-hours` (audio) |
| Core Kodera | `core_kodera` | restricted, granted to owners and admins | `dev`, `strategy`, `ops-oncall`, `kodera-git-tracker` |
| Design Partners | `design_partners` | restricted, no grant | `partner-onboarding`, `partner-feedback` |

- **Rooms are named for what they are for.** The layout names no organisation outside Kodera, in a
  category, a channel, a template key or a topic. A partner's room is granted to the partner (an
  `allow_member` rule on the Design Partners category's policy); it is never named after them, and
  no partnership is implied by a room's existence. `tests/test_community_layout.py` holds every
  word of the layout to a reviewed vocabulary of purpose words, so a name nobody listed fails
  there, not only a name somebody thought to forbid.
- **A re-run renames in place.** An earlier layout gave the two Design Partners rooms other names.
  When the bootstrap is re-run on a community that has them, each earlier room is renamed onto the
  layout's present name: the same row, so the same channel id, the same Matrix room and its
  history, the same access policy, position and room state. Only `name` and `template_key` change,
  with `version` and `updated_at`, which is what `patchChannel` changes on a rename
  ([`ESPACE_STRUCTURE.md`](ESPACE_STRUCTURE.md) §3); the workspace's structure revision advances
  once, and the channel set the bootstrap records afterwards carries the new names for the same
  channel ids, so the agent renames the rooms it already has.
  - Nothing is created beside an earlier room and nothing is deleted. The next run finds nothing to
    rename and advances nothing.
  - An earlier room is recognised by what it is: a templated channel of the Design Partners
    category whose template key the layout no longer names. Only this provisioner sets a template
    key in the community, so no room an administrator created is ever one. Earlier rooms are paired
    by position with the layout's channels that have no row yet.
  - A room an administrator renamed has no template key: it is theirs and stays as it is. The
    layout's channel it used to be is then created at the end of the category.
  - An earlier room that is archived, of another kind or under a channel-level policy is drift, as
    for every canonical room: the bootstrap refuses with the operator-reconciliation error, and its
    transaction leaves every name as it was.
  - No other category is reconciled this way. A templated room the layout does not name, elsewhere,
    is left for the operator.
- **What a re-run does not touch.** The agent's alias of a room is derived from the channel id
  (`kodera-ch-<id>`), not from its name, so it does not change and still resolves to the same room.
  Messages and files that quote an earlier name are content, and Core does not edit content.

## Account and API verification

Verify a canonical-realm signup with `email_verified=true` and the email scope.
GET `/api/v1/me` materializes the new identity and its community membership
(see "Reads and first visits" below for what that read costs and what it leaves to the agent's poll).
Existing enabled customer and staff identities get the same membership at profile
bootstrap. Other tenant grants remain bound to their own issuer. Staff identities
receive no automatic community administrator grant.

POST `/api/v1/community/support/tickets` accepts the existing
`SupportTicketCreateRequest` and an `Idempotency-Key`. Omit `tenant_id` and normally
`organisation_id`. The response contains `id`, `state`, `priority`, `queue`, and
`confirmation=\"ticket-created\"`. Five tickets per person per rolling hour is the
limit. Replays are authorized against current membership before returning a
stored response. Existing support triage and mail commands process these tickets;
configure and operate that queue before inviting public users.

For an existing person's separate canonical-realm account, verify control of both
accounts and run `python manage.py bind_community_identity --user-id <person-uuid>
--subject <community-realm-subject>`. Never infer this binding from matching email.
The command queues the exact subject in engine membership. Without a proven
binding, cross-realm users have API support access but must authenticate their
canonical realm account for Matrix; automatic broker linking is a cutover gate.

## Reads and first visits

`GET /api/v1/me`, the community workspace read and the community support intake each prepare the
caller's community membership first (`ensure_community_membership`). Every signed-in person of the
deployment goes through it on every profile read, so it is built for the steady state.

- **Steady state: three reads.** The canonical organisation, the caller's identity and their
  membership. No transaction, no row lock, no write, and the same number of statements however many
  people the community holds. A deployment with no community configured asks the database nothing.
- **First visit: the visitor's own rows.** Only a person's first visit writes: their person and
  identity (canonical-realm signup) and their membership. This code takes no lock. As any
  membership write does, the insert advances the organisation's authority revision, which holds
  that one row for the length of the visitor's own short transaction: newcomers pass it one after
  another, and no one who has visited before waits on it. Two concurrent first visits of one
  person are decided by two unique constraints, `identity_issuer_subject_unique` (one identity per issuer and subject) and
  `membership_current_unique` (one current membership per person and organisation): the loser's
  transaction rolls back, with the person it created, and its retry reads the winner's rows; a
  loser that finds the winner's identity already committed inserts nothing and reads it. Three
  attempts, then the rows are read as they are. Any other integrity error is raised, not retried.
- **Never revived.** A suspended, removed or soft-deleted membership is found and returned as it is;
  a disabled identity yields no membership.
- **The engines' member set is not rebuilt on a read.** A first visit records no member set and no
  channel set. The membership insert advances the organisation's authority revision
  ([`member-authority-revision.md`](member-authority-revision.md)); each member set records the
  revision it was built at (`EngineMemberSet.authority_revision`, engine_intents migration 0011), so
  a set behind the organisation's revision is known to be owed a rebuild from two indexed reads.
- **The agent's poll rebuilds it.** `GET /agent/v1/commands` of the community's agent calls
  `refresh_community_member_set` before it takes its credential (`pull`): when the set is behind, the member set and the
  channel set are recorded once, for everyone who joined since the last one, in a transaction of
  their own and in the emission's lock order. With the agent's 3-second poll a newcomer reaches the
  engines within about one poll; a hundred newcomers between two polls cost one rebuild, not a
  hundred. A set recorded before migration 0011 has no revision and is rebuilt once.
- **A rebuild that fails never fails a person or the poll.** The membership stands. A refused set
  (over the bound of ADR-0016, a malformed leaver) is recorded on the head and audited as before,
  and is tried again five minutes later, not on every poll; any other failure is logged by class.
- **Other organisations are untouched.** Their membership changes record their sets in the
  transaction of the change, as [`MEMBERSHIP_LIFECYCLE.md`](MEMBERSHIP_LIFECYCLE.md) §6 says; the
  operator's bootstrap and identity-binding commands still record the community's sets at once.

The member set itself is still one bounded list per organisation (10 000 subjects, ADR-0016), rebuilt
whole. That bound is the community's ceiling; this section removes the lock and the per-visit
rebuild in front of it, not the bound.

Acceptance of the layout: `tests/test_community_layout.py` (a fresh bootstrap provisions only
purpose names; a re-run on the earlier layout renames in place, idempotently; a half-migrated
community is completed; an organisation's name back in the layout, and an unsafe reconciliation,
each fail a named check).

Acceptance: `tests/test_community_scale.py` (the statement bound, no lock, no growth with the
community, the deferred and coalesced rebuild through a real agent poll, concurrent first visits,
the deterministic lost races, and the two regressions caught by name) and
`tests/test_default_community.py`.

## Rollback

Unset the default-community slug to stop automatic membership and the cross-issuer
exception. Retain the rows and memberships for audit and recovery. Restore the
previous image only with a schema-compatible release; do not reverse the reserved
slug migration while the canonical community row exists. Suspend membership to
revoke community access; login never revives it.
