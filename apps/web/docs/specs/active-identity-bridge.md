# Active identity bridge for owned order recovery

Status: Implemented; independent review pending

Expose an optional immutable issuer/subject pair on AuthUser, only from the SDK's
processed profile with an exact match to the captured configured authority.
Subjects are opaque, case-sensitive, nonempty ASCII strings of at most 255
characters. Missing/mismatched claims yield no owner capability; existing mock
omissions cannot manufacture one. Never decode bearer tokens or persist profiles.

The pinned oidc-client-ts 3.5.0 response validator decodes ID tokens and checks
subject, nonce and refresh continuity, but its _validateIdTokenAttributes path
neither compares issuer with configured authority nor verifies a signature.
ClaimsService preserves iss/sub. This bridge explicitly checks issuer; Core
remains the server authorization authority. This is not a new JWT verifier.
Subject bound reference: [OpenID Connect Core, ID Token claims](https://openid.net/specs/openid-connect-core-1_0.html#IDToken).

Renewal of the same processed identity preserves generation and private cache.
A changed issuer/subject or loss of previously present claims refuses renewal
and advances to unauthenticated. AuthProvider clears cache, pending /me reads
abort, and the existing route boundary removes the old protected loader content.
Do not let duplicate SDK loaded events cause duplicate generation transitions.

An order-specific pure resolver accepts the ready session snapshot, a supplied
Core Me snapshot with its captured generation, and exact organisation/membership
UUIDs. Require one matching linked identity and one active matching membership
whose identity_id names it. Refuse stale generations, missing or ambiguous IDs,
email/slug fallbacks and inactive membership. Return only frozen owner metadata;
this is browser restoration context, never server authorization. The caller must
recheck the live session snapshot and establish the required Core data freshness.

Executable acceptance before production edits: valid SDK profiles expose identity;
changed-subject renewal clears a mounted provider's actual private QueryClient and
cancels an old actual /me request; same-identity renewal preserves both. Resolver
positive and negative fixtures cover precise IDs, issuer/subject distinctions,
ambiguous mappings, stale generation and missing claims. A real installed SDK
callback test verifies the actual profile path rather than relying only on fakes.

Scope: AuthAdapter/oidc and an order-specific pure resolver, tests and this spec.
No existing order branch integration, storage migration/deletion, generic stash,
API/schema change, deployment, workflow or dependencies. Retention and uncertain
purchase recovery remain separately scoped decisions.

## Evidence and integration contract

Initial behavioral acceptance had four failures: a valid processed profile exposed
no identity; changed subject, changed issuer and missing claims all kept the old
generation. The same-identity and missing/mismatched profile controls passed.
Resolver acceptance was written before its module existed; its initial failure
was an unresolved import, not a pre-existing implementation regression.

The real installed SDK tests perform its state creation, callback dispatch, token
exchange and claims processing against controlled responses. Wrong and missing
ID-token issuers pass that SDK path but yield no owner identity through this
adapter. Missing subject remains an SDK rejection. The adapter does not add a
signature verifier or claim that the synthetic token is cryptographically valid.

Mounted tests run AuthProvider, a real QueryClient, the actual current-user loader
and API request cancellation. SDK UserLoaded followed by the same returned User
causes one boundary for changed claims, without a renewed-success notification.
Same-identity refresh preserves private state and notifies renewal once. Changed
or lost claims clear private state and reject late identity responses. No bearer or profile is persisted.

The pure resolver validates a supplied generation-bound Core snapshot; it cannot
establish network freshness. The existing loadCurrentUser helper fetches once per
authentication generation and retains its successful promise. Calling it again
does not refetch membership after a same-session revocation or change. A future
order integration must obtain a genuinely fresh Core response, or add separately
reviewed invalidation/refetch behavior, before claiming current membership. Capture
the generation around that request, re-read the live session snapshot after it
resolves and pass the captured generation; mismatch is refused. This resolver
uses no global cache or route slug and performs no network operation.
It is deliberately unconnected to the existing unreviewed order wizard in this
slice. Missing identity_id fixtures remain ineligible rather than inferred by
email or person ID. Storage migration, retention, submitted intent and uncertain
order reconciliation are not implemented here.

## Retained route authority correction

An additional initial mounted-router test reproduced the old organisation role
and protected child still visible after publishing a changed identity as ready.
QueryClient cleanup alone does not discard TanStack Router loader data. The narrow
correction refuses identity-changing renewal and ends the local session instead
of publishing a new ready owner. The actual organisation layout then removes its
old shell/children and routes to login. A new login resolves fresh authority.
Same-identity renewal remains uninterrupted. SDK cleanup failure also settles the
observed unauthenticated boundary through signOut's finally block. No production
route changes, reload framework or automatic new-identity acceptance was added.

## Verification

The final full unit suite passes all 926 tests across 95 files, including the
actual retained-route regression. All 18 existing Chromium journeys pass against
an isolated local mock provider after the refusal correction. Type checking,
lint, formatting and the production simulation-exclusion bundle guard pass.
No deployed provider, server authorization, order endpoint or infrastructure was
exercised. The pure resolver remains unconnected until the existing order branch
receives its separately reviewed integration.
