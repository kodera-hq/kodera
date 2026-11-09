# Local session logout boundary

Status: Implemented locally; independent review required.

## Scope

Source: shell/login branch at `503428a`. Explicit sign-out must end the console's
local session immediately. The existing AuthAdapter contract defines local logout;
this change does not add identity-provider logout or revoke a server session.

## Required behaviour

- Stop the retired OIDC manager's renewal and remove event listeners. An in-flight
  callback or a late user-loaded event cannot restore that session after logout.
- Clear the bearer provider, authenticated React state, query/mutation cache and
  pending queries before waiting for SDK cleanup.
- Remove console-owned session state, including MFA simulation flags and form
  stashes, and saved order drafts. Preserve unrelated origin storage.
- Remove the authenticated route content and return to `/login`. The account menu
  and expiry dialog must use the same cleanup path.
- Storage or SDK cleanup failure must not keep authenticated content or cached data
  available. No customer data or exception details are logged.

## Runnable acceptance

`npm test -- src/auth/oidc.test.ts src/auth/local-logout.test.tsx`

`npm run test:e2e -- tests/e2e/local-logout.spec.ts`

Use only the existing synthetic Core `/me` and shell scenario plus mock OIDC
round-trip. The unit suite reproduces late callback resurrection and retained
query/storage state. The browser suite proves authenticated content disappears.
The initial unit run against unchanged production source reproduced five failures:
two late-callback session restorations and three retained cache/storage cases.
The correction also verifies cancellation of an in-flight query and token removal
when SDK cleanup fails. The real-browser logout check and the existing expired
session form-recovery check both pass against a production-shaped mock build.

## Limits

Identity-provider SSO remains active under the existing adapter contract. This
slice does not repair MFA enrolment, session-extension timing, cross-identity draft
partitioning during re-authentication, or sibling screen integration. Explicit
logout clears drafts; background expiry continues to use the existing recovery
flow and is not equivalent to the user's decision to sign out.
