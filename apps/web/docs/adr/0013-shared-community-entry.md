# ADR-0013: Shared community entry and public member authentication

Status: Accepted

## Context

Every authenticated Kodera user needs access to the first-party Community workspace and support. The tenant realm routing rule in ADR-0002 would otherwise sign the user out of their tenant identity when they enter this shared workspace. New community members also need a verified-email registration path without acquiring administrative privileges.

## Decision

This decision supersedes ADR-0002 only for the reserved `community` organisation. Existing authenticated identities may request its workspace through Core. Core verifies persisted membership and the authenticated issuer; the browser route exception never grants membership or room permissions.

The community welcome screen offers sign-in and registration using the existing OIDC adapter, authorization-code flow, state, nonce and S256 PKCE. The configured provider's community realm owns email verification. Tokens remain in memory, and only the transaction state survives a redirect.

The MFA enrollment screen is not a prerequisite for an ordinary, non-staff `org_member` of this shared workspace. The exception requires exactly one active membership bound to the SDK-processed issuer and subject in the current `/me` response. It does not mark the identity as MFA enrolled. Staff identities and elevated community roles retain the MFA guard. Every tenant organisation retains its existing MFA and realm routing rules.

## Consequences

Community discovery and support require the corresponding server contract and canonical workspace bootstrap. A disabled or unseeded deployment offers the email fallback. Help resolves the support channel from the authorized workspace response instead of guessing a channel identifier, and submits private requests through the Core API with an idempotency key.

The import-free entry gate retires only the legacy simulation worker before loading application code. A persistent one-reload guard stops loops if old worker control remains. Production bundle checks admit only the retirement filename comparison and continue rejecting mock runtime code and fixture data.
