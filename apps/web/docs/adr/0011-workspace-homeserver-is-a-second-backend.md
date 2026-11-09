# ADR-0011: The workspace's homeserver is the Console's second backend

**Status:** Accepted; superseded in part by ADR-0012 (the form of `connect-src`, and one homeserver per deployment)
**Deciders:** zôÖma (messaging-pilot design §2.7, approved with M-D1 to M-D9); the lead (the form of the CSP)

## Context
ADR-0003 gives the Console exactly one backend, the Core API. Espace, the pilot's live text channels and audio rooms, is built in the Console on matrix-js-sdk (design §2.3). Its chat runs against the workspace's own Synapse, on the tenant's VM, with the member's own Matrix token (design §2.4). Proxying every `/sync` and message through Core would put Core on the hot path of a chat it has no business reading. It would also hold a long poll open per member, which Core's ruling for E3 forbids.

## Decision
The Console has two backends:
1. **The Core API**, as ADR-0003 says, for everything but Espace's chat.
2. **The workspace's Synapse client-server API**, called with the member's own Matrix token, by Espace's sign-in (`src/auth/matrix.ts`) and its store (`src/features/espace/matrix/`), and by nothing else.

The rules that hold the second one to that scope:
- **No administrative credential reaches the browser.** Rooms, memberships and policy are changed by Core and the tenant agent (design §2.1), never by the Console.
- **The token is the member's own, in memory only**, and refreshable, as ADR-0007 requires of the Console's other tokens. Only the Matrix `device_id` is persisted.
- **The CSP names the homeserver exactly.** `server/static.mjs` takes `--homeserver-origin`, an `https` origin validated like `--core-origin`. `connect-src` gains `{homeserver}/_matrix/` and nothing else: no wildcard and no tenant zone.
  - Keycloak is reached through `--provider-origin`'s `/realms/`, as before.
  - Synapse's SSO login is a full-page navigation, which `connect-src` does not govern.
- **ESLint names the same two files** as the only callers of `fetch` other than the generated Core client.

LiveKit's signalling and media, the second exception design §2.7 approves, join the CSP with the audio rooms: a `wss://` origin named the same way, in its own change.

## Options considered
- **Proxy Matrix through Core.** Rejected: Core would carry every member's long poll, and its database would sit on the chat's path (E3 ruling).
- **A wildcard for the tenant zone in `connect-src`** (`https://*.kodera.io`). This would serve every tenant from one central Console. Rejected for the pilot: it also opens every platform host under the zone, Core's other paths included, to anything running in the page.
- **A CSP per organisation, chosen per request.** That is what a central Console serving several tenants' Espace needs (design §6). Not yet: the static server serves the page before anyone signs in, so it has no organisation to choose by.

## Consequences
- **One homeserver per deployment.** A Console deployment serves Espace for one workspace's homeserver. A second tenant with Espace on the same Console needs a CSP per organisation first. That is the trigger to revisit this ADR.
- **Whoever deploys the Console** passes the homeserver's origin, as for Core's and the identity provider's.
- **ADR-0003 holds for every other capability:** a new backend is still a new ADR.
