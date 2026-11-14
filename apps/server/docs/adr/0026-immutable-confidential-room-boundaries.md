# ADR-0026: Explicit confidential rooms and federation boundaries

**Status:** Proposed

## Context

SRV-ADR-0018 deliberately excludes room encryption to retain server search and compliance
history. Confidential rooms require the opposite storage boundary. Enabling an encryption
state event without refusing plaintext timeline events would not establish that boundary.

## Decision

Upon acceptance, this decision partially supersedes SRV-ADR-0018 only for newly created,
explicit confidential rooms. Ordinary rooms retain the existing prohibition on encryption.
Only the trusted tenant agent may create a confidential room. Its immutable creation event
binds `io.kodera.room.confidential` to either `m.megolm.v1.aes-sha2` or
`io.kodera.mls.v1`; a matching initial encryption state is mandatory. The ordinary local
membership, moderation and federation boundaries remain in force.

Both local and federated event callbacks refuse every cleartext timeline event in a
confidential room, including reactions, custom events and administrative-account posts.
Only bounded ciphertext envelopes with exact algorithm-specific fields may pass. The
server cannot attest that arbitrary client-provided bytes are cryptographic ciphertext;
clients must authenticate the MLS or Megolm payload before displaying it. Membership,
room metadata and routing state remain visible to the homeserver. Plaintext metadata must
never contain confidential message bodies. Search, exports and bots cannot decrypt history.

The Rust OpenMLS engine exports 32 bytes per room and epoch using RFC 9420 `export_secret`
with label `kodera-livekit-media-v1` and organisation/room/epoch context. Export fails while
the trusted roster contains a revoked group leaf. A verified removal commit changes the
exporter secret; rejected commits do not change it. Callers own key erasure and frame
encryption with a reviewed provider, sender authentication and unique nonces.

`KODERA_FEDERATION_MODE=closed|partner|open` selects the homeserver transport boundary.
With no mode or allowlist configured, Community remains closed. Existing explicit partner
allowlists retain their behavior. Explicit `closed` or `open` combined with a global partner
allowlist is refused as ambiguous; explicit `partner` requires that list. `open` removes the
global transport allowlist, while retaining exact public server lists on each selected room,
immutable creation mode, invite-only joins, agent-authored governance and matching ACLs.
It is open homeserver interoperability with explicit room admission, not a wildcard room.
Internal rooms remain isolated in every mode. Remote peers gain no Core membership grants.

The renderer pins TLS verification, private-address egress filtering, empty IP exceptions,
federation request rate/concurrency limits and disabled public room/profile discovery.
Open mode refuses HTTP proxies because Synapse's address filtering does not apply through
them. The route overlay exposes only Matrix client/federation/key routes. Runtime enforcement
of those settings and interoperability still require real multi-homeserver qualification.

## Acceptance and release boundaries

Callback acceptance requires positive ciphertext cases for both algorithms and negative
plaintext, administrative bypass, malformed marker, algorithm downgrade, mute, read-only,
unbounded payload and frozen-state cases. Real multi-member cryptographic tests must prove
exporter agreement, authenticated commit rotation and member removal.

Status: Planned — full client integration, IndexedDB/WebCrypto persistence, server encrypted
envelope routes, real Synapse confidential-room integration, LiveKit encoded-frame transforms
and Web/iOS/Android interoperability, plus open-federation runtime abuse tests. The primitives and callback tests do not qualify those
features as shipped and do not justify enabling a user-facing confidential-room control.

References: [Synapse federation transport and abuse settings](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_federation)
and [private-address filtering and proxy limitations](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#ip_range_blacklist).
