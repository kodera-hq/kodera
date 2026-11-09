# Session renewal drives the expiry dialog

Status: Ready for independent review

## Scope

Continue local logout fix `3bd9d` with a narrow renewal correction. The dialog
must reflect the active adapter session, not a dismiss-only countdown. Keep the
identity SDK behind AuthAdapter and preserve logout's retired-manager guard.
Draft isolation and the iframe callback/reload path remain separate work.

The installed oidc-client-ts version is 3.5.0. Its public `signinSilent()` method
returns a user or null, using a refresh token when available and otherwise an
iframe. `UserLoaded` signals renewed credentials. The adapter owns automatic
expiry renewal as well as manual/focus requests: `automaticSilentRenew` is
disabled to prevent two owners racing refresh-token rotation. The same SDK
method still performs every exchange and validates responses. These APIs were
verified in the installed distribution and the
[official UserManager reference](https://authts.github.io/oidc-client-ts/classes/UserManager.html#signinSilent).

## Acceptance written before implementation

Run `npm test -- src/auth/sessionExpiry.test.tsx src/auth/oidc.test.ts`.

- An SDK renewal success closes an open expiry countdown.
- Extend asks the adapter to renew; pending or failed renewal does not claim
  success or hide the warning. A missing/expired token requires sign-in again.
- Focus and the visible-tab periodic check request real renewal through the
  adapter; concurrent explicit requests share one SDK operation.
- Remaining time comes from the credential's absolute expiry. Delayed timers
  and resumed tabs must not add time to a session or restart its countdown.
- Logout invalidates outstanding renewal results and callbacks. Neither a
  successful nor failed completion from a retired manager can reopen the UI or
  restore access.
- A local synthetic provider harness exercises the installed SDK's refresh-token
  exchange; this is not proof of deployed identity-provider configuration.

Before changing production modules, run the behavioral tests against the current
implementation and record their failures. Then run the full suite, type checking,
lint, formatting and the mock build. Preserve existing logout and form-recovery
acceptance. No Core API contract changes or new Core fixtures are required.

## Evidence and limitations

The initial provider acceptance produced six failures and one pass against the
unchanged implementation: renewal notifications were ignored, Extend did not
request renewal, failed extension hid the dialog, the countdown invented a new
two-minute duration, focus did not renew, and logout left stale expiry state.

The correction adds one adapter-owned in-flight promise. Expiry, manual and focus
requests share it. A retired manager cannot publish success or failure, replace
the active token, or clear a newer manager's pending request. Null and expired
SDK results are rejected; transient failures retain only the existing token's real life.
Successful SDK events close the warning, and background success does not emit
an explicit-extension analytics event. The countdown belongs to the current
React auth session and computes time from the credential's absolute deadline.

Validation:

- All 851 tests in 85 files passed with `npm test -- --maxWorkers=2`. An initial
  unrestricted run hit the existing API generator mutation test's five-second
  timeout; no test timeout or guard was changed. Limiting worker contention
  produced a passing full run, repeated after the final production edits.
- Type checking, ESLint, formatting and `git diff --check` passed.
- `src/auth/oidc.refresh.test.ts` exercises the installed SDK against synthetic
  metadata and token responses. Only the already-authenticated bootstrap is
  stubbed; the SDK sends the refresh-token request, processes the response,
  publishes the renewed token and updates its expiry.
- The mock production build and both existing Chromium journeys passed:
  explicit logout removes private content/state, and session re-authentication
  restores the typed form. No production identity provider was contacted.

This does not repair the separate iframe callback/reload restoration path,
partition draft stashes by identity/organisation, or address the existing mock
MFA assertion. Missing or failed iframe renewal remains a failed SDK attempt;
it cannot be converted into successful renewal by dismissing the dialog.

## Provider refusal ends the credential in place

Status: Implemented; independent review pending

A renewal the provider refuses cannot succeed later: the refresh token is expired
or revoked, a silent answer needs the person, or the request is one the provider
will never accept. The refusal codes are `invalid_grant`, `interaction_required`,
`consent_required`, `account_selection_required`, `access_denied`, `invalid_token`,
`invalid_client`, `unauthorized_client`, `invalid_scope` and `invalid_request`.
A silent `login_required` is not a refusal: a browser that blocks third-party
cookies produces it while the SSO session is alive, and the retry acceptance in
`tests/e2e/oidc-callback.spec.ts` renews after one. The SDK would also report a
different person's silent session as `login_required`; `validateSubOnSilentRenew`
is off so that user reaches the adapter, whose issuer and subject check signs out.
Any other error, including a provider fault answered with an error body such as
`unknown_error` on HTTP 500, and every network failure, is transient: the token
keeps its real life and the next focus or periodic check retries.

On a refusal the adapter ends the credential at once, even when the access token
still has up to two minutes left: `getAccessToken()` returns nothing, the SDK
drops its stored user (refresh and ID tokens), and that manager never asks the
provider again. Failure listeners then run, so the countdown opens directly in
its expired state. The published snapshot stays `ready`: publishing
`unauthenticated` would make the organisation route navigate to /login, removing
the expired dialog and §4.7's in-place re-authentication with its invitation
recovery. Sign-in with « Se reconnecter » replaces the session. The previous
`AuthUser` object stays in the snapshot until then; requests never read it.

Late results of a retired manager, renewal or callback, remove the user the SDK
stored there and notify nothing. Sign-out drops the SDK user even when retiring
the manager throws. A throwing listener cannot change the outcome or stop other
listeners; its error is rethrown on its own task.

Acceptance: `src/auth/oidc.test.ts` (refusal, transient codes, listener errors,
re-entry, retired owners) and `src/auth/oidc.refusal.test.tsx`, which runs the
installed SDK against a synthetic token endpoint answering `invalid_grant` and
renders the real adapter, providers and dialog: the expired dialog appears, the
route is kept, and « Se reconnecter » starts sign-in to the same realm.
