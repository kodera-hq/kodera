# Partner channels, single-channel guests and trusted MLS epochs

Status: Implemented (operator configuration required)

## Decision

A bilateral partner agreement pins two organisations, their exact homeservers, a
Matrix room and one explicit channel in each workspace. The proposing administrator
approves the first revision; only the other organisation may activate it. Either
organisation may suspend or revoke it immediately. Suspension requires a fresh
proposal and bilateral approval before use resumes. Revision checks serialize edits.
Every transition is audited. Guest grant/revocation emits a revisioned channel set;
the tenant agent invites the exact guest Matrix identity into its already-bound room,
preserves an accepted guest join, and removes it after revocation without creating
a realm account or organisation membership. Mismatched room references are not invited. Suspension and revocation record durable session eviction
markers. Matrix history already replicated to a partner homeserver cannot be remotely
erased. The API and management panel disclose this before agreement creation.

A single-channel guest grant is distinct from organisation membership. It binds a
known enabled identity and canonical Matrix user to one organisation and channel, with a
bounded expiry and explicit revocation. It grants no directory, search, alias,
invitation, direct-message, template or unrelated document access. Guest identities
cannot simultaneously acquire ordinary workspace admission through a guest grant.
The localpart is the lowercased identity subject; its domain comes from the owned
tenant's operator URL template, the operator-bound default Community server, or the
identity organisation's homeserver in an active agreement for the exact room.
Administrators cannot substitute arbitrary MXIDs. Foreign grants are considered only
for the agreement-bound room; an unrelated tenant's ordinary rooms stay unmanaged.

Synapse and room-access consult the credential-bound Core authority endpoint without
positive caching. Errors deny governed access. Synapse checks creation, joins,
invitations and event admission, including direct clients and remote senders. LiveKit
token admission and reconciliation use the same authority. Existing Matrix native
authorization and immutable federation boundaries remain additional requirements.
The Core authority endpoint authenticates an existing organisation agent credential;
no client supplies an organisation authority assertion. Operators configure the HTTPS
Core origin and credential on the two enforcement services before enabling grants.
A revocation blocks subsequent authorization decisions; already in-flight operations
and remote copies cannot be recalled. Eviction of already minted media sessions is
performed by the room-access reconciliation loop, not by a database transaction.

The confidential epoch directory records each accepted signed MLS commit in the same
transaction as the relay's monotonic epoch. Discovery accepts the known Core channel UUID or the canonical relay room UUID,
returns the canonical room UUID, and requires a current participating device and
channel authority. Subsequent signed relay operations use that canonical room UUID. Key-package claims remain epoch-bound and reject stale
epochs. Device verification bundles carry public cross-signing material with a proof
by the registered device key. Publication is revisioned and discovery excludes revoked
devices. The server attests acceptance and ordering, not knowledge of group secrets
or independent verification of the client's MLS transcript.

## Acceptance criteria

- Only an administrator of an agreement side can edit it; activation requires the
  other side and the current revision. Revocation is terminal.
- Suspended/revoked agreements deny partner events and media tokens even when Matrix
  membership and a previously active room-policy snapshot remain unchanged.
- Expired/revoked guests cannot join, send, invite, create DMs, enumerate directories,
  or mint cross-room call tokens. Test both local and remote Matrix identities.
- Epochs are unique per room and strictly consecutive; stale claims/commits fail.
  Discovery and verification publication use current device and membership checks.
- Governance management is lazy-loaded from workspace settings, uses labelled native
  controls and localized English/French messages, and displays the history limitation.
- Contract changes are additive in 0.56.0; canonical and copied contracts match.

## Deployment and operational boundaries

Core defaults `KODERA_CHANNEL_GOVERNANCE_ENABLED` to false. An operator enables it
only after configuring the Synapse HTTPS authority origin/organisation agent
credential, room-access authority origin/credential, and the edge request-scope
subrequest documented in the policy package. Core additionally requires `KODERA_GOVERNANCE_AUTHORITY_CONFIGURED=true` as an
explicit operator attestation; it does not probe the edge. Synapse rejects governance
or partner federation without its authority origin and credential. room-access rejects
`ROOM_ACCESS_CHANNEL_GOVERNANCE_ENABLED=true` without its authority origin and credential.
Community wires the shared `KODERA_CORE_AUTHORITY_ORIGIN` and `KODERA_AGENT_TOKEN`
into both services. This must be an internal HTTPS Core origin exposing `/agent/v1/`;
the public Community ingress deliberately refuses that route. Both Caddy topologies
install the Synapse `request_scope` subrequest on client API traffic, and generated
partner overlays retain it while routing federation separately. Existing explicit immutable partner-room provisioning
still creates the room and pins its homeservers; the agreement does not convert
an internal room into a federated room. Both channel identifiers and the shared
Matrix room reference must be exchanged by the administrators.

Guests use explicit single-room Matrix requests. Guest `/sync`, directory, alias
and arbitrary state APIs are refused by the request gate. A guest grant is not a
Core membership and does not grant confidential relay device enrollment. Confidential
discovery is available to currently enrolled/admitted devices; partner organisation
rosters still enroll through their respective authority domains. Native and browser
codec qualification and universal encryption by default remain separate work.

Organisation erasure removes directory records before deleting relay parents, removes
agreements involving either side and guest grants originating in the erased domain,
and removes eviction/revision children before channel deletion. Account erasure
revokes guest grants and discards published device bundles. Public accepted-epoch
evidence follows its room's controller-owned encrypted-history retention policy.
