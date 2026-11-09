# ADR-0007: The browser OIDC client is oidc-client-ts, behind an AuthAdapter

**Status:** Accepted
**Date:** 2026-09-02
**Deciders:** the crew

## Context

ADR-0002 puts tenant admins on **their own tenant realm**, chosen at runtime from the organisation slug or the email domain. So the console cannot know its authority at build time: the realm is discovered per login. `.env.example` says as much — `VITE_KEYCLOAK_URL` carries a base URL and no realm.

ADR-0003 allows exactly one backend, and `docs/dev/API_CLIENT.md` is explicit about the token: short-lived, in memory, never in `localStorage`, never in a log or an error report. Anything that persists a token to disk contradicts a document a reviewer is expected to enforce.

The end-to-end suite is Playwright against MSW, on a production build, never a live backend (`docs/dev/TESTING.md`). A login path that only works against a real identity provider is a login path no gate covers — and login is the first screen of every flow, so it would be untested code in front of tested code.

Finally, the identity provider is a moving part of the platform, not a permanent decision of the console. The console should be able to survive the library changing without touching a screen.

## Decision

**oidc-client-ts is the browser OIDC client, and nothing outside `src/auth/` imports it.**

The flow:

1. `POST /auth/discover` on the Core API returns the realm for the slug or email domain given on the login screen.
2. The console sets `authority` **at runtime** to `${VITE_KEYCLOAK_URL}/realms/{realm}`.
3. Authorization code with **PKCE**.
4. `userStore` is backed by `InMemoryWebStorage`: **the access token lives in memory only, never in `localStorage`** (`docs/dev/API_CLIENT.md`). Only the PKCE state has to survive the redirect, and it goes to `sessionStorage`.
5. `automaticSilentRenew` covers the 5-minute access token.
6. **Logout is Keycloak's concern**; the Core API is stateless and holds no session of its own (`docs/dev/API_CLIENT.md`), so the console ends its own session and hands off.

The boundary:

- The rest of the application sees **only `src/auth/AuthAdapter`** — `getAccessToken()`, `signIn(realm)`, `signOut()`, `onExpiring`. A reviewer can check this by grep: an import of the library outside `src/auth/` is wrong, and so is a screen that reaches for a token any other way.
- The mock identity provider the tests use implements **the same interface**, so the library is swappable without touching a screen.

Under `VITE_ENABLE_MSW=1`:

- MSW serves the discovery document and the token endpoint;
- the `authorization_endpoint` points at an app-local `/__mock-idp/authorize` route that bounces to `/auth/callback?code&state`.

So the **real library path runs end to end in Playwright** — state check, code exchange, session start. Only the authorize page is faked. That is the point: the part that can break silently is the part the suite exercises.

## Options considered

| Option | Why not |
|---|---|
| **Chosen: oidc-client-ts behind `AuthAdapter`** | Standards-generic, so the realm is a runtime value rather than a construction-time one; in-memory storage is a supported configuration, not a workaround; no framework coupling. Costs an adapter file and the mock authorize route. |
| keycloak-js | Rejected: the realm is fixed at construction, so per-realm discovery (ADR-0002) means re-instantiating the client on every login; it is named for the vendor it wraps, which is the opposite of a swappable seam; and its iframe session checks are hostile to both Playwright and a strict content security policy. |
| react-oidc-context | Rejected: a React wrapper over the same library. The adapter already gives us the boundary, and the wrapper would put a second opinion between the screens and it. |
| A hand-rolled PKCE client | Rejected: security-sensitive code with no reason to own it. State handling, nonce checking, clock skew and renewal are where hand-rolled clients go wrong, quietly. |

## Consequences

- `VITE_AUTH_MODE` (`oidc` \| `mock`) and `VITE_OIDC_CLIENT_ID` join the environment (`docs/dev/BASELINE.md`). Both are public, like everything `VITE_`-prefixed, and neither is a secret: PKCE is what makes a public client safe.
- A page reload loses the access token by design; the silent-renew path is what restores a session, and it is therefore a flow the end-to-end suite must cover rather than an optimisation.
- `POST /auth/discover` is on the Core API's critical path: the login screen cannot proceed without it. Its failure needs copy that names the cause and the next action (`docs/dev/I18N.md` rule 6), not a status code.
- `/__mock-idp/authorize` ships in the bundle, gated on `VITE_ENABLE_MSW`. Anything reachable in a production build that fabricates an authorization code would be a real vulnerability, so the gate is a test of its own, not a comment.
- Revisit if the platform moves off Keycloak, or if silent renew proves unreliable under browser storage partitioning; the fallback is a refresh-token-in-memory rotation, still behind the same adapter.
