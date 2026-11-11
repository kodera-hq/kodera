# Default community membership

Status: Accepted

Supersedes ADR-0006 and ADR-0015 only for the explicitly configured first-party
community organisation. Other organisation identities remain issuer-bound.

## Decision

`KODERA_DEFAULT_COMMUNITY_ORG_SLUG=community` enables the canonical workspace.
`KODERA_DEFAULT_COMMUNITY_ISSUER` names its exact trusted `/realms/community`
issuer. The database admits this reserved name only on an explicitly marked
first-party row; ordinary organisation intake continues to reject it.

Bootstrap requires an existing enabled owner person. It preserves the database
owner and slug reservation invariants, creates the public channels, restricts
announcements, and creates staff and partner categories with explicit grants.
A login creates no staff or administrator role. Existing higher roles survive,
and suspended, removed or erased memberships are never restored by login.

A verified token for an existing enabled person can bootstrap an ordinary
community membership. A newly registered canonical-realm account can materialize
its own person and identity only with a verified signed email claim. Email is
contact data, never an account-linking key. The GET profile bootstrap writes in
its own short transaction before the existing coherent read snapshot.

Only the exact canonical organisation admits a cross-issuer membership for its
workspace read and support bridge. Staff profile reads expose this community
membership alone. Other organisation operations retain their issuer and role
checks. The support bridge stores a real ticket, applies a serialized quota of
five tickets per person per hour across identities, and returns only its ID and
closed triage vocabulary. No issue publication occurs in this API.

## Matrix account binding

API membership does not authorize a foreign realm subject on the community
homeserver. Synapse and the tenant agent map the canonical realm's stable `sub`
to a Matrix localpart. Operators may use `bind_community_identity` only after
proof of control of both accounts, to bind that real realm subject to the same
persisted person. The command refuses conflicting or disabled bindings and emits
current engine membership. Automatic cross-realm chat requires a separately
reviewed identity-broker account-linking flow; equal email addresses or equal
subjects from different issuers must never substitute for that proof.

The deployment remains gated until native canonical-realm signup, membership
emission, room acknowledgement, and any required broker bindings are verified.
An authenticated person can open a support ticket without a Matrix session.
