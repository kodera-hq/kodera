# Instant claim client integration

Status: Implemented in Core API contract 0.40.0

POST the authenticated Core API base plus `/workspaces/instant-claim`, never a tenant
or identity-provider origin. Request JSON uses the founder-specified camelCase keys:
organizationName, slug, hostingMode, templateId, themeId, soundPackId, enabledConnectors.
POST uses the shared Core middleware and a stable Idempotency-Key for the same intent.

The canonical `core-api.openapi.yaml` operation `instantClaimWorkspace` answers 201 with:

```json
{
  "workspaceId": "018f1234-5678-7000-8000-000000000030",
  "workspaceUrl": "https://studio.example.org",
  "invitationUrl": "https://studio.example.org/invite?signed=example",
  "channels": [{"id": "018f1234-5678-7000-8000-000000000031", "name": "production", "kind": "text"}],
  "enabledConnectors": ["frameio-review-bridge"]
}
```

There must be 1–128 uniquely identified channels (`text` or `audio`), up to 32
connector IDs, and bounded public HTTPS workspace/invitation links. Malformed success
is refused; it cannot be presented as a confirmed Cloud assignment. Response names
are rendered as React text, never executable markup. Client timeout is 2500ms and
also bounds body parsing. Timeout/offline outcome is uncertain, not proof that Core
performed no allocation. Retrying preserves the idempotency key. Closing or unmounting
retires the request and suppresses late hydration.

Authenticated Workspace exposes Cloud onboarding. Its existing query state is refreshed
only after a matching slug is confirmed; tenant/session authority still comes from Core.
Legacy `onConfigure` adapters own an in-memory workspace and default to explicit preview
mode, preserving its no-network behavior. A caller can pass `claimMode="cloud"` to use
Core. Confirmed responses hydrate the onboarding summary, signed invitation, channels
and connector state; `onClaimed` exposes the typed descriptor to its owning screen.
A local preview never invents an invitation or claims provider connectors are connected.
There is no background allocation after an authentication/session change; a user retry
is needed to check an uncertain request when connectivity returns.

Hosting offer metadata is read only when Core explicitly provides `hostingMode` or
`hosting_mode` as community, cloud-shared or cloud-dedicated. Missing/unknown metadata
is labelled unreported, never inferred from tenant readiness. Migration produces an
export or a mail draft for support; no subscription or payment action is made.

An optional `offerMode` in a successful claim may be community, cloud-shared or
cloud-dedicated. Only this explicit metadata selects the current offer label. A
generic `hostingMode: cloud` does not prove shared versus dedicated tenancy.

The authenticated customer must be a current owner of an active organisation. Idempotency keys
use the common 16–255 printable ASCII rule, scoped to the verified identity and route. Every
replay rechecks current authority. The matching warm-pool allocation, workspace, ready channels,
connector configuration and signed invitation must already have been prepared in the database
by a worker. The API claims the allocation and persists the 201 response atomically; it never
calls a provider. Missing or unready capacity returns a 503 RFC 9457 problem with
`code: warm_pool_unavailable` and Retry-After; nothing is stored, so the same key may retry.
An allocation already claimed under a different key returns 409. Invalid requests return 400;
anonymous and non-owner requests return 401 and 403 respectively.

Request slugs use the existing tenant domain (3–32 lowercase characters); platform labels,
including community, and reserved prefixes are refused. Sound pack identifiers include the
web client's six acoustic preferences and the existing provisioning presets. Connectors use
the closed official identifier list, with at most ten entries.

The web contract is a byte-identical mirror of packages/api-contract/core-api.openapi.yaml
and apps/server/contracts/core-api.openapi.yaml. The shared typed client consumes the generated
path without a type suppression. Demo-only JSON 503 local-preview-only remains a closed,
explicit refusal in this operation's schema; ordinary overlay contract conformance checks it.
