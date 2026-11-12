# Architecture & security

> Understand what ships, what is bounded, and what remains an integration seam.

## Identity and room policy

An external Keycloak-style OIDC issuer can provide identity. WebAuthn/hwk assurance belongs to the configured identity policy, not to a badge or local UI assertion. Community brings no identity provider.

synapse-policy 0.1.5 enforces the configured room policy alongside the room-access service. Authenticated membership and grants come from the control plane; local previews grant none.

> Clients and SDK use Apache-2.0; server and Synapse policy use AGPL-3.0-or-later. Enterprise Edition has a separate commercial licence.

## Rust codecs, audio and proximity

kodera-rs supplies identifiers, bounded native metadata and ProximityFrame v1 codecs. The public packet audit checks Ed25519 signatures. A signed beacon is not proof of membership, distance or live radio availability; TTL is unsigned by design.

Web sound synthesis defines SYNTH_SAMPLE_RATE = 48000. This does not establish a shipping Rust DSP engine or a native audio hardware provider. MLS and native hardware/provider seams must not be presented as finished integrations.

> No active BLE radio, end-to-end media encryption or emergency-service guarantee is created by this reference.

## Portable theme metadata

kodera-theme:v1: is a bounded theme share format, capped at 2048 UTF-8 bytes in the native codec. Its canonical base64 encodes a strict five-RGB JSON schema, with four curated presets.

A theme code carries visual metadata. Base64 is not encryption; do not put secrets or permission claims in it. Native profile/IAM previews are not authenticated grants.

> Only example templates belong in version control. Never commit environment secrets, private keys or live tenant identifiers.

## Sources

- [ARCHITECTURE.md](https://github.com/kodera-hq/kodera/blob/main/ARCHITECTURE.md)

- [packages/kodera-rs/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/kodera-rs/README.md)

- [packages/synapse-policy/README.md](https://github.com/kodera-hq/kodera/blob/main/packages/synapse-policy/README.md)

- [apps/web/src/features/sounds/synth.ts](https://github.com/kodera-hq/kodera/blob/main/apps/web/src/features/sounds/synth.ts)
