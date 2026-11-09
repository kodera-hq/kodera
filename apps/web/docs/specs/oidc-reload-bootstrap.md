# Restore the session before protected route loading

Status: Implemented; independent review pending

A full reload loses the in-memory SDK user. Protected route guards must await a
single silent SSO restoration attempt using the existing stored realm hint and
configured provider. The hint is only an admitted single slug path segment, never
an authority, credential or proof of access. Tokens remain in memory.

## State contract and boundaries

AuthAdapter owns a stable subscribed snapshot with pending, ready or
unauthenticated status, current user and an ephemeral session generation. Snapshot
identity changes only on notification. Restoration is lazy: only protected index
and organisation guards invoke it. Callback and mock authorization routes never
start restoration, preventing competing transactions and recursive iframe loads.

Concurrent callers and StrictMode share one restoration promise. A live session
returns immediately. Missing/invalid hint, provider refusal and timeout settle
unauthenticated once until an explicit session action. Logout or replacement
invalidates late work. Successful token renewal keeps the session generation and
current UI/cache. No token, refresh token or SDK user is written to browser storage.

AuthProvider subscribes to the adapter snapshot. Pending protected routes use the
existing loading presentation, without flashing protected content or redirecting
to login. Current-user loading awaits readiness and fetches fresh authority data
for each new generation. Concurrent guards share both restoration and identity
fetch. Old responses after logout/replacement are rejected and cancelled queries
cannot repopulate cache. Preserve the requested destination and explicit logout.

## Initial executable acceptance

The browser signs in through the local provider, reloads a protected destination,
and expects the main URL to remain there while a prompt=none iframe is pending.
There must be no protected navigation or /me request before authentication. The
controlled iframe completes through the real SDK callback; fresh /me is fetched
and the protected shell becomes visible at the original destination.

Run this journey before production edits and record its actual failure. Extend
unit/browser coverage for concurrent index/org guards, StrictMode, no hint, invalid
hint, no provider session, timeout, logout/replacement during restoration, stable
snapshots, unchanged generation on renewal, fresh /me, and rejected late identity
responses. Preserve previous callback, MFA exclusion and logout acceptance.

## Scope

AuthAdapter/oidc/AuthProvider, provider cache boundary, index/org guards and a
current-user helper plus tests. No startup hook in main or callback route; no
order integration, generic draft framework, namespace, new dependency, workflow,
provider production call or deployment. Existing slug-to-realm shortcut remains a
separate known integration limitation. Controlled provider tests cannot establish
deployed provider embedding, cookies, redirect allowlists or real MFA enrollment.

## Verification and integration notes

The initial browser acceptance failed before implementation because no silent
iframe was created after a protected reload. The complete corrected Chromium
suite passes all 18 journeys, including silent recovery, refused SSO, timeout,
interactive fallback, callback processing, real-clock expiry, MFA exclusion,
logout, member access and accessibility. Type checking, lint, formatting and the
production exclusion guard pass. The full unit suite passes all 884 tests across 91 files.

Unit coverage includes literal concurrent index/org guards sharing one SDK
restoration and one fresh identity read, stable subscribed snapshots, unchanged
cache/generation on renewal, admitted hints, blocked storage, settled failure,
deduplicated interactive fallback, late restoration after logout/replacement,
fresh authority reads, query cancellation and retry after an authority failure.

The existing OTP browser journey now installs its clock before SDK timers and
advances from the actual mock expires_in. Its old expireSession hook used logout
as an expiry alias, which is incompatible with an observed authentication store.
The now-unused hook remains a later cleanup; no alternate production test method
was added. The member-access journey now completes silent SSO after its hard
navigation and retains its original permission and accessibility assertions.

A new catalogue row labels the existing Skeleton presentation as restoration.
The ephemeral identity cache key is
['me', generation, credentialGeneration]; unreviewed screen branches that read
bare ['me'] (including the existing order branch) must adopt the shared loader
during their own reviewed integration. They were not changed here.

Missing or failed restoration settles once. A protected organisation deep link
then preserves its existing interactive handoff, deduplicated for concurrent
callers; public callback pages never initiate that fallback. Successful token
renewal does not change the session generation or clear customer data.

## Replacement setup failure acceptance

Status: Implemented; independent correction review pending

An explicit valid-realm replacement retires the old authenticated generation
before storage, manager construction or redirect setup can fail. Mounted
AuthProvider consumers immediately lose the prior user and private query cache.
Storage denial, synchronous SDK construction/redirect exceptions and rejected
redirect promises settle unauthenticated, keep the original failure observable,
and retire failed-manager listeners. A late failure must not close a newer session.
Concurrent replacement callers still share one redirect attempt.

Runnable acceptance: the adapter test mounts the actual AuthProvider with a real
QueryClient containing a private record, establishes an authenticated session,
injects each setup failure and asserts hidden authenticated UI, empty cache,
advanced generation, absent token/user and one settled restoration refusal.

The initial table failed all four cases: storage, constructor and synchronous
redirect setup preserved the old ready snapshot; rejected redirect left a manager
that could accept a late loaded event. The correction publishes the generation
boundary before deferred setup, installs the shared request before notification,
and retires a failed manager. Queued setup after logout and late rejection after
a successful replacement are also covered. All 890 unit tests pass; the final
focused adapter run passes 35 tests including immediate cache removal inside the
failing setup call. Type checking and lint pass.

All 18 existing Chromium journeys also pass on an isolated local mock provider,
and the production bundle exclusion guard passes. These exercise SDK/browser
behavior locally; no deployed identity provider or infrastructure was contacted.
