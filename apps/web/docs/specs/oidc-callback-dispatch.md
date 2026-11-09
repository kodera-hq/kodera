# Dispatch identity callbacks by their SDK transaction

Status: Implemented; independent review pending

The adapter always treats `/auth/callback` as interactive login. A silent iframe
callback must instead notify its parent using the installed identity SDK. Only
the parent exchanges the code and updates its session. The iframe must not consume
the top-level return destination or publish an authenticated React session.

Use the SDK's stored transaction dispatch, not query-only classification or manual
JWT parsing/postMessage. Return an explicit interactive/silent result through the
adapter/provider boundary. Deduplicate callback execution for StrictMode within
one callback URL and manager generation; logout/replacement invalidates late
completion. A different callback URL cannot reuse the previous result. Preserve
the existing single owner for renewal and actual-expiry validation.

## Acceptance before implementation

A real-SDK unit acceptance creates stored silent request state with OidcClient,
then invokes the application adapter callback. The SDK must notify the parent,
perform no child token request, and return the silent result. Invalid/missing
state must fail without notification or exchange.

A browser journey uses the existing loopback mock provider, which issues no
refresh token. Trigger focus renewal, return login_required from its iframe and
assert the truthful countdown. Extend retries with prompt=none; completing that
iframe must issue exactly one token exchange from the parent, leave the top-level
URL and return destination unchanged, and close the countdown. Test timeout,
missing state, duplicate callback under StrictMode, and logout during renewal.
Existing interactive login, OTP exclusion and refresh-token tests remain green.

## Boundaries

No reload bootstrap, order integration, generic draft framework, identity
namespace or real MFA enrollment changes. No new dependencies, workflow changes,
provider production calls or token persistence. Local synthetic-provider evidence
is not proof of deployed provider configuration or cryptographic provider trust.

## Verification record

Before production changes the real SDK acceptance failed because the adapter
attempted the code exchange in the child for stored silent request state. Missing
state was already refused. The corrected focused unit suite passes the focused tests,
including stored-state precedence over a query label, one notification across
repeated effects, StrictMode navigation, provider binding and prior logout guards.

Eight Chromium journeys pass against an isolated loopback mock build: silent
provider refusal followed by successful Extend, timeout, missing state, logout
while a real token response is held, forced MFA, keyboard enrollment, OTP
exclusion and explicit logout. The success case observes exactly one token fetch
in the parent, prompt=none, unchanged destination and a closed countdown.

Type checking, lint, formatting and the production bundle exclusion guard pass.
The final full unit suite passes all 864 tests across 89 files. A further regression
reproduced cached-result reuse for a different callback URL; reuse is now limited
to the exact URL, and that regression passes. No production
provider, reload restoration, cryptographic provider trust or real enrollment
claim follows from these synthetic-provider checks.
