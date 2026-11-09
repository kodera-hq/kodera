# Current-token authority fence

Status: Approved

## Goal

The protected console must derive its shell, role and MFA decision from the
current usable access token only. Replacing or losing token bytes retires every
older `/me` request, cache entry and router result before customer content can
render again.

## Authority model

The auth adapter publishes two opaque monotonic counters:

- `generation` changes when the authenticated session or identity is replaced;
- `credentialGeneration` changes exactly once when usable access-token bytes
  change or become unavailable.

Neither counter contains or derives a token value. Token bytes remain behind
the adapter and API client getter, and are absent from `AuthUser`, React auth
context observations, router data, query keys and errors.

`GET /me` captures the exact token and both counters before dispatch. Its
authority ends immediately if any captured value changes. The request is
aborted, its result is rejected, and the entire `['me']` query family is
cancelled and removed without clearing unrelated queries or form state. A fresh
read is keyed by `['me', generation, credentialGeneration]`.

Organisation loader data carries the `/me` payload and both captured counters.
The layout compares them with live auth context before rendering protected
content. A mismatch renders `SessionLoading` synchronously and requests one
router invalidation for that exact live/captured pair. A later authority change
may request another invalidation; repeated renders of the same mismatch may
not.

The index route applies the same captured-authority check before redirecting.
A redirect destination is never selected from a stale `/me` result.

## Current identity and MFA

The active identity is selected without email, realm or array-position
fallbacks. Exactly one `/me.identities[]` row must match the processed SDK
issuer and subject, its identity ID must be unique and well formed, and exactly
one well-formed membership relationship for the current organisation must name
that identity. Omission, duplicate rows, malformed IDs, a mismatched
relationship or `mfa_enrolled` other than literal `true` fails closed.

The existing session-storage enrolment flag remains acceptable only when both
the mock auth mode and MSW build gate are enabled. Forged storage in any other
configuration grants nothing.

## Mock journey

The `oidc.current-user-fence` MSW overlay exposes a deterministic sequence of
held `/me` answers for browser acceptance. The journey rotates credentials
while older reads are pending and proves that only the response issued for the
latest credential can reopen the shell. Focused unit and router acceptance
alongside it proves that unrelated cached state survives same-identity renewal
and that losing the token closes the guard before another `/me` answer is
accepted.

## Acceptance written before implementation

Focused unit and router acceptance proves:

- A to B to C token rotation cannot let a late A or B response regain
  authority.
- Token disappearance closes the guard synchronously; a later token requires a
  fresh `/me` response before protected content returns.
- Duplicate delivery of identical token bytes does not advance
  `credentialGeneration` or trigger another read.
- Same-identity renewal removes only `['me']` while preserving unrelated query
  and form state.
- Exact issuer and subject resolution accepts one current relationship and
  rejects missing, false, duplicate, mismatched or malformed data.
- Public auth snapshots, context, router data, query keys and errors contain no
  token bytes.
- Local MFA state is trusted only in the explicit mock-plus-MSW configuration.

Browser acceptance runs in both configured Chromium themes and preserves the
existing reload and shell/login journeys. Repository gates remain the ones in
`package.json`; no workflow, provider, contract, deployment or Core change is
part of this slice.

## Out of scope

The Core contract repin, provider deployment, realm configuration and live
identity-provider acceptance are separate delivery lanes. This fence does not
decode or validate bearer tokens and does not replace Core authorization.
